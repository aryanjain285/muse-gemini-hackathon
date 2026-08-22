/**
 * In-process durable job runner.
 *
 * Long work (directing, rendering, composing) outlives the HTTP request that
 * started it, so routes hand work to the runner and return immediately; the
 * browser follows progress over the event stream. Job state is persisted before
 * and after each step, which is what allows a project interrupted by a restart to
 * be resumed rather than restarted.
 *
 * Handlers are registered by kind so the pipeline module owns the actual work and
 * this file owns only scheduling, cancellation, deadlines and bookkeeping.
 */
import { LIMITS } from "@/lib/core/config";
import { id as newId, MuseError, hashJson } from "@/lib/core/util";
import { logger, type Logger } from "@/lib/core/logger";
import { Audit, Jobs, Projects, type JobRow } from "@/lib/db/repo";
import { emit, type MuseEvent } from "./bus";

export interface RunContext {
  projectId: string;
  traceId: string;
  jobId: string;
  log: Logger;
  /** Absolute epoch ms. Past this, optional retries are abandoned. */
  deadlineAt: number;
  signal: AbortSignal;
  emit(event: MuseEvent): void;
  /** Throws a cancelled error if the caller has aborted. Call between steps. */
  checkpoint(): void;
}

export type Handler<P = Record<string, unknown>> = (
  ctx: RunContext,
  payload: P,
) => Promise<unknown>;

interface Active {
  projectId: string;
  jobId: string;
  kind: string;
  controller: AbortController;
  startedAt: number;
  promise: Promise<unknown>;
}

/**
 * Survive Next's dev-mode module reloading: a reload would otherwise create a
 * second registry and lose track of in-flight work.
 */
interface RunnerState {
  handlers: Map<string, Handler<never>>;
  active: Map<string, Active>;
  resumed: boolean;
}

const g = globalThis as unknown as { __museRunner?: RunnerState };
const state: RunnerState =
  g.__museRunner ?? (g.__museRunner = { handlers: new Map(), active: new Map(), resumed: false });

export function register<P>(kind: string, handler: Handler<P>): void {
  state.handlers.set(kind, handler as unknown as Handler<never>);
}

export function isRunning(projectId: string): boolean {
  return state.active.has(projectId);
}

export function activeKind(projectId: string): string | null {
  return state.active.get(projectId)?.kind ?? null;
}

export function cancel(projectId: string): boolean {
  const a = state.active.get(projectId);
  if (!a) return false;
  a.controller.abort();
  Jobs.update(a.jobId, { status: "cancelled" });
  // Release the project now rather than waiting for the detached promise to settle.
  // Work that is already dead never settles — a job the persisted state reconciled as
  // interrupted, or a request abandoned mid-flight — and the entry then pins the project
  // as busy for the life of the process, so cancelling it makes it permanently unstartable.
  state.active.delete(projectId);
  emit(projectId, { kind: "log", level: "warn", message: "cancelled by user" });
  return true;
}

export interface StartOptions {
  /** Extra components of the idempotency key, beyond project and kind. */
  idempotency?: unknown;
  /** Override the default project deadline, ms from now. */
  budgetMs?: number;
  /** Reject rather than queue if the project is already busy. */
  exclusive?: boolean;
}

export interface StartResult {
  started: boolean;
  jobId: string;
  reason?: string;
}

/**
 * Begin work for a project. Returns as soon as the job is claimed; the work runs
 * detached. At most one job per project is active at a time.
 */
export function start<P extends Record<string, unknown>>(
  projectId: string,
  kind: string,
  payload: P,
  opts: StartOptions = {},
): StartResult {
  const handler = state.handlers.get(kind);
  if (!handler) throw new MuseError("permanent", `no handler registered for job kind '${kind}'`);

  const existing = state.active.get(projectId);
  if (existing) {
    return {
      started: false,
      jobId: existing.jobId,
      reason: `project is already running '${existing.kind}'`,
    };
  }

  const idempotency = hashJson({ projectId, kind, extra: opts.idempotency ?? null });
  const { row } = Jobs.claim({ projectId, kind, payload, idempotency });

  // A job that already completed under this exact key is not re-run; the caller
  // gets the prior result. This is what makes retrying a request safe.
  if (row.status === "done") {
    return { started: false, jobId: row.id, reason: "already completed" };
  }

  const controller = new AbortController();
  const traceId = newId("trc", 10);
  const deadlineAt = Date.now() + (opts.budgetMs ?? LIMITS.demoDeadlineMs);
  const log = logger({ project_id: projectId, trace_id: traceId, job_id: row.id });

  const ctx: RunContext = {
    projectId,
    traceId,
    jobId: row.id,
    log,
    deadlineAt,
    signal: controller.signal,
    emit: (event) => emit(projectId, event),
    checkpoint: () => {
      if (controller.signal.aborted) throw new MuseError("cancelled", "job cancelled");
    },
  };

  Jobs.update(row.id, { status: "running", attempt: row.attempt + 1, error: null });
  Audit.record({
    projectId,
    traceId,
    actor: "system",
    action: "job_start",
    payload: { kind, jobId: row.id, attempt: row.attempt + 1 },
  });

  const promise = (async () => {
    try {
      const result = await handler(ctx, payload as never);
      Jobs.update(row.id, { status: "done", result_json: JSON.stringify(result ?? null) });
      Audit.record({
        projectId,
        traceId,
        actor: "system",
        action: "job_done",
        payload: { kind, jobId: row.id },
      });
      return result;
    } catch (e) {
      const cancelled = e instanceof MuseError && e.kind === "cancelled";
      const message = e instanceof Error ? e.message : String(e);
      Jobs.update(row.id, { status: cancelled ? "cancelled" : "failed", error: message });
      log.error(`job ${kind} ${cancelled ? "cancelled" : "failed"}`, { error: message });
      Audit.record({
        projectId,
        traceId,
        actor: "system",
        action: cancelled ? "job_cancelled" : "job_failed",
        payload: { kind, jobId: row.id, error: message },
      });
      if (!cancelled) {
        // Surface the failure on the project so the UI can offer a retry, but
        // only if a later stage has not already moved things on.
        try {
          const p = Projects.get(projectId);
          if (p && p.status !== "READY") {
            Projects.setStatus(projectId, "FAILED", message);
            // Tell the client too. It already handles a FAILED status — refreshing and
            // clearing the working state — but nothing ever emitted one, so a failed run
            // left the studio showing the last status it had seen and looking busy.
            emit(projectId, { kind: "status", status: "FAILED" });
          }
        } catch {
          /* the state machine may legitimately refuse; the job row is authoritative */
        }
        emit(projectId, { kind: "error", message });
      }
      throw e;
    } finally {
      // Only if this job still owns the slot. Cancelling hands it back immediately, so a
      // later run can already be in it, and an unconditional delete would evict that one.
      if (state.active.get(projectId)?.jobId === row.id) state.active.delete(projectId);
    }
  })();

  // The detached promise is stored so callers can await it in tests; an unhandled
  // rejection is prevented here because failures are already recorded above.
  promise.catch(() => undefined);

  state.active.set(projectId, {
    projectId,
    jobId: row.id,
    kind,
    controller,
    startedAt: Date.now(),
    promise,
  });

  return { started: true, jobId: row.id };
}

/** Await the active job for a project. Used by tests and by the verify script. */
export async function wait(projectId: string): Promise<void> {
  const a = state.active.get(projectId);
  if (!a) return;
  try {
    await a.promise;
  } catch {
    /* the caller inspects persisted state, not the throw */
  }
}

/** Await every active job. */
export async function drain(): Promise<void> {
  const all = [...state.active.values()].map((a) => a.promise.catch(() => undefined));
  await Promise.all(all);
}

/**
 * Reconcile persisted state after a restart. Anything left marked `running`
 * cannot still be running in this process, so it is flagged for resumption rather
 * than silently appearing active forever.
 */
export function resumeOrphans(): JobRow[] {
  if (state.resumed) return [];
  state.resumed = true;
  const orphans = Jobs.orphans();
  for (const o of orphans) {
    Jobs.update(o.id, {
      status: "failed",
      error: "interrupted by a restart; resume from the project page",
    });
  }
  if (orphans.length > 0) {
    logger().warn(`marked ${orphans.length} interrupted job(s) as resumable`);
  }
  return orphans;
}

export interface RunnerSnapshot {
  active: { projectId: string; kind: string; elapsedMs: number }[];
  handlers: string[];
}

export function snapshot(): RunnerSnapshot {
  return {
    active: [...state.active.values()].map((a) => ({
      projectId: a.projectId,
      kind: a.kind,
      elapsedMs: Date.now() - a.startedAt,
    })),
    handlers: [...state.handlers.keys()],
  };
}

/** Test seam: drop registry and in-flight map. */
export function __reset(): void {
  for (const a of state.active.values()) a.controller.abort();
  state.active.clear();
  state.handlers.clear();
  state.resumed = false;
}
