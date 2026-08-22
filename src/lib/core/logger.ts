/**
 * Structured logging. Every line carries correlation ids and is appended as
 * JSONL so a run can be reconstructed after the fact.
 *
 * Hard rule: never log raw private images or signed URLs. `redact` strips data
 * URIs, base64 blobs and anything key-shaped before write.
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./paths";

export type Level = "debug" | "info" | "warn" | "error";

export interface LogContext {
  trace_id?: string;
  project_id?: string;
  scene_id?: string;
  job_id?: string;
  spec_version?: number;
  template?: string;
  model?: string;
}

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN: Level = (process.env.MUSE_LOG_LEVEL as Level) || "info";

let stream: fs.WriteStream | null = null;
function out(): fs.WriteStream {
  if (!stream) {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    stream = fs.createWriteStream(path.join(PATHS.logs, `muse-${day}.jsonl`), { flags: "a" });
  }
  return stream;
}

const KEYISH = /(key|token|secret|authorization|signature)/i;

/** Recursively drop anything sensitive or enormous. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    if (value.startsWith("data:")) return `[data-uri ${value.length}b]`;
    if (value.length > 600) return `[str ${value.length}b]`;
    // Long unbroken base64-ish runs are almost certainly asset bytes.
    if (value.length > 180 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return `[b64 ${value.length}b]`;
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.length > 40
      ? [...value.slice(0, 40).map((v) => redact(v, depth + 1)), `[+${value.length - 40} more]`]
      : value.map((v) => redact(v, depth + 1));
  }
  const src = value as Record<string, unknown>;
  const dst: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (KEYISH.test(k)) {
      dst[k] = "[redacted]";
      continue;
    }
    if (k === "inlineData" || k === "bytesBase64Encoded" || k === "data") {
      dst[k] = "[bytes]";
      continue;
    }
    dst[k] = redact(src[k], depth + 1);
  }
  return dst;
}

function write(level: Level, ctx: LogContext, msg: string, extra?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN]) return;
  const rec = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...ctx,
    ...(extra ? { data: redact(extra) } : {}),
  };
  try {
    out().write(JSON.stringify(rec) + "\n");
  } catch {
    /* logging must never throw into the request path */
  }
  const tag = ctx.scene_id ? `${ctx.project_id ?? "-"}/${ctx.scene_id}` : ctx.project_id ?? "-";
  const line = `[muse ${level}] ${tag} ${msg}`;
  if (level === "error") console.error(line, extra ? redact(extra) : "");
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(ctx: LogContext): Logger;
}

export function logger(ctx: LogContext = {}): Logger {
  return {
    debug: (m, e) => write("debug", ctx, m, e),
    info: (m, e) => write("info", ctx, m, e),
    warn: (m, e) => write("warn", ctx, m, e),
    error: (m, e) => write("error", ctx, m, e),
    child: (more) => logger({ ...ctx, ...more }),
  };
}

export const log = logger();
