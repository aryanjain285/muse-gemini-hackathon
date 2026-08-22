/**
 * HTTP helpers shared by every route handler: consistent JSON envelopes, one
 * place that turns a thrown error into a status code, and body parsing that
 * rejects malformed input instead of letting `undefined` reach a service.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { MuseError, truncate } from "@/lib/core/util";
import { log } from "@/lib/core/logger";

export interface ApiError {
  error: string;
  kind?: string;
  detail?: Record<string, unknown>;
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400, extra?: Partial<ApiError>): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** Map a domain error onto a status code. */
export function statusFor(e: unknown): number {
  if (!(e instanceof MuseError)) return 500;
  switch (e.kind) {
    case "permanent":
      return 400;
    case "budget":
      return 402;
    case "timeout":
      return 504;
    case "cancelled":
      return 499;
    case "transient":
      return 503;
    default:
      return 500;
  }
}

/**
 * Wrap a handler so an unexpected throw becomes a clean JSON error rather than a
 * framework stack trace, and so every failure is logged once with its route.
 */
export function handler<A extends unknown[]>(
  name: string,
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      const status = statusFor(e);
      const message = e instanceof Error ? e.message : String(e);
      // A 4xx is the caller's problem and not worth an error-level line.
      if (status >= 500) log.error(`route ${name} failed`, { error: message });
      else log.warn(`route ${name} rejected`, { error: truncate(message, 200) });
      return fail(truncate(message, 400), status, {
        kind: e instanceof MuseError ? e.kind : "unknown",
        ...(e instanceof MuseError && Object.keys(e.detail).length > 0 ? { detail: e.detail } : {}),
      });
    }
  };
}

/** Parse and validate a JSON body. Throws a permanent error the wrapper maps to 400. */
/**
 * Parse and validate a JSON request body.
 *
 * Typed on the schema's output rather than on a bare type parameter. `z.ZodType<T>` makes TS
 * infer T from the input side, so every field declared with `.default()` came back as possibly
 * undefined even though parsing guarantees it is present — a route that actually used one of
 * those fields would not compile, and the first one to try it did not.
 */
export async function body<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new MuseError("permanent", "request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new MuseError("permanent", `invalid request: ${detail}`);
  }
  return parsed.data;
}

/** Read a route's dynamic params, which are async in the App Router. */
export async function params<T extends Record<string, string>>(
  ctx: { params: Promise<T> },
): Promise<T> {
  return ctx.params;
}

/** Numeric query parameter with a default. */
export function num(req: Request, key: string, dflt: number): number {
  const v = new URL(req.url).searchParams.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function str(req: Request, key: string): string | null {
  return new URL(req.url).searchParams.get(key);
}
