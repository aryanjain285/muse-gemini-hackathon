/** Ids, hashing, errors, sleep, retry classification. No external deps. */
import crypto from "node:crypto";

// ── ids ──────────────────────────────────────────────────────────────────────

const ALPHABET = "0123456789abcdefghijkmnpqrstuvwxyz"; // no l/o, easier to read aloud

export function id(prefix: string, len = 12): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}

// ── hashing ──────────────────────────────────────────────────────────────────

export function sha256(data: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Stable hash of an arbitrary JSON value: keys sorted at every level so that
 * two logically identical requests produce the same idempotency key.
 */
export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ── errors ───────────────────────────────────────────────────────────────────

export type ErrorKind =
  /** Transport or provider-side blip. Safe to retry with backoff. */
  | "transient"
  /** Provider rejected the request as malformed or unsupported. Do not retry. */
  | "permanent"
  /** Output was produced but failed our quality bar. Retry semantically. */
  | "semantic"
  /** Cost governor refused. Never retry; fall back. */
  | "budget"
  /** Wall clock exceeded. */
  | "timeout"
  /** Caller cancelled. */
  | "cancelled";

export class MuseError extends Error {
  readonly kind: ErrorKind;
  readonly detail: Record<string, unknown>;
  constructor(kind: ErrorKind, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "MuseError";
    this.kind = kind;
    this.detail = detail;
  }
}

export const transient = (m: string, d?: Record<string, unknown>) =>
  new MuseError("transient", m, d);
export const permanent = (m: string, d?: Record<string, unknown>) =>
  new MuseError("permanent", m, d);
export const semantic = (m: string, d?: Record<string, unknown>) =>
  new MuseError("semantic", m, d);
export const budgetError = (m: string, d?: Record<string, unknown>) =>
  new MuseError("budget", m, d);
export const timeoutError = (m: string, d?: Record<string, unknown>) =>
  new MuseError("timeout", m, d);

/** Map an HTTP status onto a retry class. 429 and 5xx are worth another go. */
export function kindForStatus(status: number): ErrorKind {
  if (status === 429) return "transient";
  if (status >= 500) return "transient";
  if (status === 408) return "timeout";
  return "permanent";
}

export function isRetryable(e: unknown): boolean {
  return e instanceof MuseError && (e.kind === "transient" || e.kind === "timeout");
}

// ── async helpers ────────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let handle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => reject(timeoutError(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

/** Exponential backoff, transport failures only. */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts: number; baseMs?: number; label?: string } = { attempts: 2 },
): Promise<T> {
  const base = opts.baseMs ?? 700;
  let last: unknown;
  for (let attempt = 0; attempt <= opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      last = e;
      if (!isRetryable(e) || attempt === opts.attempts) throw e;
      await sleep(base * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
    }
  }
  throw last;
}

/** Bounded-concurrency map that preserves input order. */
/**
 * A gate that lets at most `limit` callers through at once.
 *
 * `pool` bounds a batch it owns. This bounds a resource several independent callers
 * share — scenes render in parallel and each may reach the same rate-limited model, so
 * the limit has to live with the resource rather than with any one batch.
 */
export function gate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * A gate that also keeps a minimum interval between starts.
 *
 * A concurrency cap and a rate limit are different constraints and only one of them is
 * a count of simultaneous callers. A provider that allows N requests per minute is not
 * satisfied by "two at a time": two at a time still issues far more than N per minute if
 * each call is short. Capping concurrency at two and watching every request come back 429
 * is what that difference looks like in practice.
 *
 * Spacing starts is what actually respects a per-minute allowance, so this holds both.
 */
export function pacedGate(limit: number, minIntervalMs: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const inner = gate(limit);
  let nextAt = 0;
  return <T>(fn: () => Promise<T>): Promise<T> =>
    inner(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, nextAt - now);
      // Claim the slot before waiting, so concurrent callers queue behind each other
      // rather than all reading the same free moment and starting together.
      nextAt = Math.max(now, nextAt) + minIntervalMs;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      return fn();
    });
}

export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── numbers ──────────────────────────────────────────────────────────────────

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, dp = 3) => Number(v.toFixed(dp));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Money is always displayed to 4dp internally, 2dp in the UI. */
export const usd = (v: number) => Number(v.toFixed(6));

// ── strings ──────────────────────────────────────────────────────────────────

export function slug(s: string, max = 48): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "untitled";
}

/** Strip anything that could confuse a shell or a filesystem. */
export function safeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_");
  return base.slice(0, 120) || "file";
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
