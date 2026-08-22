/**
 * SQLite handle. One connection per process, WAL mode, schema applied on first
 * touch so there is no separate migrate step to forget before a demo.
 */
import Database from "better-sqlite3";
import { PATHS, ensureDirs } from "@/lib/core/paths";
import { SCHEMA_SQL } from "./schema";

type DB = Database.Database;

let handle: DB | null = null;

export function db(): DB {
  if (handle) return handle;
  ensureDirs();
  const d = new Database(PATHS.db);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.pragma("busy_timeout = 5000");
  d.exec(SCHEMA_SQL);
  handle = d;
  return d;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/** Wrap a unit of work in a transaction. Rolls back on throw. */
export function tx<T>(fn: () => T): T {
  const d = db();
  const run = d.transaction(fn);
  return run();
}

export const nowIso = () => new Date().toISOString();

/** JSON column helpers so callers never litter parse/stringify at call sites. */
export function j<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
export const s = (v: unknown) => JSON.stringify(v ?? null);
