/**
 * Cost governor. Every billable call passes through here twice: once to reserve
 * an estimated cost against the remaining budget, and once to record what was
 * actually billed once usage metadata comes back.
 *
 * The ceiling is a hard stop, not a warning. When a call would cross it the
 * governor throws a `budget` error, which the router treats as a signal to fall
 * back to the deterministic engine rather than to retry. That is what makes it
 * safe to point this at a real API key with a small balance.
 */
import { PRICES, readEnv, type Price, type Task } from "@/lib/core/config";
import { budgetError, usd } from "@/lib/core/util";
import { Ledger } from "@/lib/db/repo";
import { log } from "@/lib/core/logger";

export interface Usage {
  inputTokens?: number;
  /** Total candidate tokens, including any image tokens. */
  outputTokens?: number;
  thoughtTokens?: number;
  /**
   * Output tokens billed at the image rate. Image models report this separately
   * under `candidatesTokensDetails`, and it is ~75% of a 1K image's total, so
   * folding it into `outputTokens` would overstate cost by roughly a third.
   */
  outputImageTokens?: number;
  /** Images returned, for image billing. */
  images?: number;
  /** Seconds of video returned, for per-second billing. */
  seconds?: number;
  /** Clips returned, for per-clip billing. */
  clips?: number;
}

/** Text output rate applied to the non-image tokens an image model emits. */
const IMAGE_MODEL_TEXT_OUTPUT_PER_M = 3.75;

export interface CostEstimate {
  usd: number;
  unit: Price["unit"] | "unknown";
  quantity: number;
  model: string;
}

/** What a call is expected to cost before it runs. Used for the reservation. */
export function estimate(model: string, task: Task, hint: Usage): CostEstimate {
  const price = PRICES[model];
  if (!price) return { usd: 0, unit: "unknown", quantity: 0, model };

  switch (price.unit) {
    case "tokens": {
      const inTok = hint.inputTokens ?? 1500;
      // Thinking tokens bill at the output rate, so they belong in the estimate.
      const outTok = (hint.outputTokens ?? 1200) + (hint.thoughtTokens ?? 400);
      return {
        usd: usd((inTok / 1e6) * price.inputPerM + (outTok / 1e6) * price.outputPerM),
        unit: "tokens",
        quantity: inTok + outTok,
        model,
      };
    }
    case "image": {
      const inTok = hint.inputTokens ?? 1200;
      // Post-call the provider reports image tokens explicitly; pre-call we
      // assume one image at the configured resolution plus a short text preamble.
      const imgTok = hint.outputImageTokens ?? (hint.images ?? 1) * price.tokensPerImage;
      const textOutTok = Math.max(0, (hint.outputTokens ?? imgTok + 400) - imgTok);
      const n = hint.images ?? Math.max(1, Math.round(imgTok / price.tokensPerImage));
      return {
        usd: usd(
          (inTok / 1e6) * price.inputPerM +
            (imgTok / 1e6) * price.outputPerM +
            (textOutTok / 1e6) * IMAGE_MODEL_TEXT_OUTPUT_PER_M,
        ),
        unit: "image",
        quantity: n,
        model,
      };
    }
    case "second": {
      const sec = hint.seconds ?? 6;
      return { usd: usd(sec * price.perSecond), unit: "second", quantity: sec, model };
    }
    case "clip": {
      const n = hint.clips ?? 1;
      return { usd: usd(n * price.perClip), unit: "clip", quantity: n, model };
    }
  }
}

/**
 * Actual cost from reported usage. Shares one code path with `estimate` so the
 * projection the UI shows and the figure the ledger records cannot drift.
 */
export function actual(model: string, task: Task, usage: Usage): CostEstimate {
  return estimate(model, task, usage);
}

export interface BudgetState {
  ceilingUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** Reserved-but-not-yet-recorded spend for calls currently in flight. */
  inFlightUsd: number;
}

/** In-flight reservations, so two concurrent calls cannot both fit the last cent. */
const reservations = new Map<string, number>();

function inFlight(): number {
  let t = 0;
  for (const v of reservations.values()) t += v;
  return t;
}

export function budget(): BudgetState {
  const ceiling = readEnv().budgetUsd;
  const spent = Ledger.totalUsd();
  const flight = inFlight();
  return {
    ceilingUsd: usd(ceiling),
    spentUsd: usd(spent),
    inFlightUsd: usd(flight),
    remainingUsd: usd(Math.max(0, ceiling - spent - flight)),
  };
}

export interface Reservation {
  id: string;
  model: string;
  task: Task;
  estimate: CostEstimate;
  /** Record the real cost and release the reservation. */
  settle(usage: Usage, opts?: { projectId?: string | null; requestHash: string }): number;
  /** Release without billing, e.g. the call failed before generating anything. */
  release(): void;
}

let seq = 0;

/**
 * Reserve headroom for a call. Throws a `budget` error if the estimate does not
 * fit under the ceiling, which callers translate into a deterministic fallback.
 */
export function reserve(input: {
  model: string;
  task: Task;
  hint: Usage;
  projectId?: string | null;
  /** Extra ceiling for a single call, e.g. the agent harness's per-run cap. */
  callCapUsd?: number;
}): Reservation {
  const est = estimate(input.model, input.task, input.hint);
  const state = budget();

  if (input.callCapUsd !== undefined && est.usd > input.callCapUsd) {
    throw budgetError(
      `call would cost $${est.usd.toFixed(4)}, over the $${input.callCapUsd.toFixed(2)} per-call cap`,
      { model: input.model, task: input.task, estimate: est.usd },
    );
  }
  if (est.usd > state.remainingUsd) {
    throw budgetError(
      `call would cost $${est.usd.toFixed(4)}, only $${state.remainingUsd.toFixed(4)} of the $${state.ceilingUsd.toFixed(2)} budget remains`,
      { model: input.model, task: input.task, estimate: est.usd, remaining: state.remainingUsd },
    );
  }

  const rid = `res_${++seq}`;
  reservations.set(rid, est.usd);

  let settled = false;
  return {
    id: rid,
    model: input.model,
    task: input.task,
    estimate: est,
    settle(usage, opts) {
      if (settled) return 0;
      settled = true;
      reservations.delete(rid);
      const real = actual(input.model, input.task, usage);
      const reported =
        (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.seconds ?? 0) +
        (usage.clips ?? 0) +
        (usage.images ?? 0);
      // If the provider reported no usage at all, bill the estimate rather than
      // silently recording a free call.
      const billed = reported > 0 ? real.usd : est.usd;
      Ledger.record({
        projectId: opts?.projectId ?? input.projectId ?? null,
        task: input.task,
        model: input.model,
        unit: real.unit === "unknown" ? est.unit : real.unit,
        quantity: reported > 0 ? real.quantity : est.quantity,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        thoughtTokens: usage.thoughtTokens ?? 0,
        usd: billed,
        estimated: reported === 0,
        requestHash: opts?.requestHash ?? "",
      });
      log.debug("billed", {
        model: input.model,
        task: input.task,
        usd: billed,
        estimated: real.quantity === 0,
      });
      return billed;
    },
    release() {
      if (settled) return;
      settled = true;
      reservations.delete(rid);
    },
  };
}

/** Record a cache hit: zero cost, but visible in the ledger as a saving. */
export function recordCacheHit(input: {
  projectId?: string | null;
  task: Task;
  model: string;
  requestHash: string;
  wouldHaveCostUsd: number;
}): void {
  Ledger.record({
    projectId: input.projectId ?? null,
    task: input.task,
    model: input.model,
    unit: "tokens",
    quantity: 0,
    usd: 0,
    estimated: true,
    cacheHit: true,
    requestHash: input.requestHash,
  });
}

/** Human-readable projection for the UI before a run starts. */
export function projectCost(plan: { model: string; task: Task; hint: Usage }[]): {
  totalUsd: number;
  lines: { label: string; model: string; usd: number }[];
} {
  const lines = plan.map((p) => {
    const e = estimate(p.model, p.task, p.hint);
    return { label: p.task, model: p.model, usd: e.usd };
  });
  return { totalUsd: usd(lines.reduce((a, b) => a + b.usd, 0)), lines };
}

/** Test seam: drop every in-flight reservation. */
export function __resetReservations(): void {
  reservations.clear();
}
