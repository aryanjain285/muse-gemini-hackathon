/**
 * ModelRouter. Every model call in MUSE goes through `route`, which layers five
 * concerns around an adapter in a fixed order:
 *
 *   1. profile      — is this task configured to use a real model at all?
 *   2. cache        — has this exact request been answered before? (free replay)
 *   3. governor     — does the estimated cost fit under the remaining budget?
 *   4. fallback     — primary model, then the configured chain
 *   5. local engine — a deterministic result that always succeeds
 *
 * Step 5 is what makes the pipeline unable to fail: a route returns a usable
 * value even with no API key, no network, no quota and no budget. Callers never
 * write a try/catch around generation, because there is nothing to catch.
 */
import {
  FALLBACKS,
  profileFor,
  type Profile,
  type Task, typicalVideoSeconds } from "@/lib/core/config";
import { MuseError } from "@/lib/core/util";
import { logger, type Logger } from "@/lib/core/logger";
import { Audit } from "@/lib/db/repo";
import { cache } from "./cache";
import { estimate, recordCacheHit, reserve, type Usage } from "./governor";
import { hasApiKey } from "./gemini";
import type { AdapterOut } from "./adapters";

export type RouteName = string; // "gemini:gemini-3.6-flash" | "local"

export interface RouteResult<T> {
  value: T;
  route: RouteName;
  usd: number;
  cached: boolean;
  latencyMs: number;
  /** Present when the deterministic engine answered instead of a model. */
  fallbackReason?: string;
  /** Model version the provider echoed, when a real call ran. */
  modelVersion?: string;
}

/**
 * How a value is persisted in the cache. Text results round-trip as JSON;
 * media results keep their bytes beside a small JSON envelope.
 */
export interface Codec<T> {
  encode(value: T): { json: unknown; bin?: Buffer | null };
  decode(json: unknown, bin: Buffer | null): T;
}

/** Default codec: the value is already JSON-serialisable. */
export function jsonCodec<T>(): Codec<T> {
  return {
    encode: (value) => ({ json: value as unknown }),
    decode: (json) => json as T,
  };
}

/** Codec for `{ bytes, mime, ... }` media results. */
export function mediaCodec<T extends { bytes: Buffer; mime: string }>(): Codec<T> {
  return {
    encode: (value) => {
      const { bytes, ...rest } = value as unknown as Record<string, unknown> & { bytes: Buffer };
      return { json: rest, bin: bytes };
    },
    decode: (json, bin) => {
      if (!bin) throw new MuseError("permanent", "cached media entry lost its bytes");
      return { ...(json as object), bytes: bin } as T;
    },
  };
}

export interface RouteInput<T> {
  task: Task;
  projectId?: string | null;
  /**
   * Everything that changes the output. Used both as the cache key and as the
   * idempotency key recorded in the ledger.
   */
  identity: unknown;
  /** Bump when a prompt template changes, to retire stale cache entries. */
  cacheVersion?: string;
  /** Pre-call usage guess, for the budget reservation. */
  hint: Usage;
  /** The real call. Omit for tasks that have no model implementation. */
  real?: (model: string) => Promise<AdapterOut<T>>;
  /** The deterministic answer. Must not throw. */
  local: (reason: string) => Promise<T>;
  codec?: Codec<T>;
  logger?: Logger;
  /** Optional per-call ceiling, e.g. the agent harness's own cap. */
  callCapUsd?: number;
  /** Absolute epoch ms after which real calls are skipped in favour of local. */
  deadlineAt?: number;
  profile?: Profile;
}

function modelChain(task: Task, primary: string): string[] {
  const chain = [primary, ...(FALLBACKS[task] ?? [])];
  return chain.filter((m, i) => chain.indexOf(m) === i);
}

export async function route<T>(input: RouteInput<T>): Promise<RouteResult<T>> {
  const started = Date.now();
  const log = input.logger ?? logger({ project_id: input.projectId ?? undefined });
  const profile = input.profile ?? profileFor(undefined);
  const target = profile.routes[input.task];
  const codec = input.codec ?? jsonCodec<T>();

  const finishLocal = async (reason: string): Promise<RouteResult<T>> => {
    const value = await input.local(reason);
    // A profile that routes this task locally has not fallen back — that is the
    // configured route, and reporting it as a failure would make the deterministic
    // engine look like damage every time it is used deliberately. Only an
    // unplanned diversion carries a fallbackReason.
    const deliberate = reason === "profile";
    if (!deliberate) {
      log.info(`local engine answered ${input.task}`, { reason });
      Audit.record({
        projectId: input.projectId,
        actor: "router",
        action: "fallback",
        payload: { task: input.task, reason },
      });
    }
    return {
      value,
      route: "local",
      usd: 0,
      cached: false,
      latencyMs: Date.now() - started,
      ...(deliberate ? {} : { fallbackReason: reason }),
    };
  };

  // 1. profile
  if (target.kind === "local") return finishLocal("profile");
  if (!input.real) return finishLocal("no model adapter for this task");
  if (!hasApiKey()) return finishLocal("no api key configured");
  if (input.deadlineAt !== undefined && Date.now() > input.deadlineAt) {
    return finishLocal("project deadline reached");
  }

  const primary = target.model;
  const chain = modelChain(input.task, primary);

  // 2. cache. Keyed on the primary model so a fallback answer is not replayed
  //    as though the preferred model had produced it.
  const key = cache.key({
    model: primary,
    task: input.task,
    payload: input.identity,
    version: input.cacheVersion,
  });
  const hit = cache.get<unknown>(key);
  if (hit) {
    try {
      const bin = hit.binPath ? cache.bytes(key) : null;
      const value = codec.decode(hit.json, bin);
      const wouldHave = estimate(primary, input.task, input.hint).usd;
      recordCacheHit({
        projectId: input.projectId,
        task: input.task,
        model: primary,
        requestHash: key,
        wouldHaveCostUsd: wouldHave,
      });
      log.info(`cache hit for ${input.task}`, { model: primary, saved: wouldHave });
      return {
        value,
        route: `gemini:${primary}`,
        usd: 0,
        cached: true,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      log.warn("cache entry unusable, regenerating", { key, error: String(e) });
    }
  }

  // 3. governor
  let reservation;
  try {
    reservation = reserve({
      model: primary,
      task: input.task,
      hint: input.hint,
      projectId: input.projectId,
      callCapUsd: input.callCapUsd,
    });
  } catch (e) {
    const reason = e instanceof MuseError ? e.message : String(e);
    return finishLocal(`budget: ${reason}`);
  }

  // 4. fallback chain
  const errors: string[] = [];
  for (const model of chain) {
    try {
      log.debug(`calling ${model} for ${input.task}`);
      const out = await input.real(model);
      const usd = reservation.settle(out.usage, {
        projectId: input.projectId,
        requestHash: key,
      });
      const enc = codec.encode(out.value);
      cache.put(key, enc.json, enc.bin ?? null);
      Audit.record({
        projectId: input.projectId,
        actor: "router",
        action: "model_call",
        payload: {
          task: input.task,
          model,
          modelVersion: out.modelVersion,
          usd,
          usage: out.usage,
          requestHash: key,
        },
      });
      return {
        value: out.value,
        route: `gemini:${model}`,
        usd,
        cached: false,
        latencyMs: Date.now() - started,
        modelVersion: out.modelVersion,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${model}: ${msg}`);
      log.warn(`route attempt failed`, { task: input.task, model, error: msg });
      // A permanent rejection of the request itself will fail identically on
      // every sibling model, so stop walking the chain.
      if (e instanceof MuseError && e.kind === "permanent") break;
      if (e instanceof MuseError && e.kind === "budget") break;
    }
  }

  // 5. local engine
  reservation.release();
  return finishLocal(errors.join(" | ") || "all model routes failed");
}

/** What the UI shows for a task without running anything. */
export function describeRoute(task: Task, profile?: Profile): {
  route: RouteName;
  model: string | null;
  estimateUsd: number;
} {
  const p = profile ?? profileFor(undefined);
  const target = p.routes[task];
  if (target.kind === "local" || !hasApiKey()) {
    return { route: "local", model: null, estimateUsd: 0 };
  }
  const hint: Usage =
    task === "keyframe"
      ? { images: 1, inputTokens: 1400 }
      : task === "video"
        ? { seconds: typicalVideoSeconds() }
        : task === "music"
          ? { clips: 1 }
          : { inputTokens: 2500, outputTokens: 2500, thoughtTokens: 300 };
  return {
    route: `gemini:${target.model}`,
    model: target.model,
    estimateUsd: estimate(target.model, task, hint).usd,
  };
}
