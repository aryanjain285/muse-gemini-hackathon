/**
 * Rewrite stored asset paths so a database can be moved.
 *
 * Every row was written absolute, pinned to the directory that produced it, so a clone at
 * any other path found none of its own files. Storing them relative to the workspace is
 * what lets a finished film be committed and still play for somebody else.
 *
 * Manifests are left alone deliberately: they embed the paths a past render used, the
 * composer re-derives them from the assets on every render, and rewriting a historical
 * record to say something it did not say is worse than leaving it accurate about a machine
 * that no longer matters.
 *
 * Safe to run more than once — a row that is already relative is skipped.
 *
 *   npx tsx scripts/make-portable.ts [--dry]
 */
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { db } from "../src/lib/db/client";
import { WORKSPACE } from "../src/lib/core/paths";

const dry = process.argv.includes("--dry");
const MARKER = "/workspace/";

/** An absolute path under some workspace becomes a path relative to this one. */
function relativise(uri: string): string | null {
  if (!path.isAbsolute(uri)) return null;
  const slashed = uri.split(path.sep).join("/");
  const at = slashed.lastIndexOf(MARKER);
  if (at < 0) return null;
  return slashed.slice(at + MARKER.length);
}

const rows = db().prepare(`SELECT id, uri FROM assets`).all() as { id: string; uri: string }[];
const update = db().prepare(`UPDATE assets SET uri = ? WHERE id = ?`);

let changed = 0;
let already = 0;
let outside = 0;

for (const row of rows) {
  if (!path.isAbsolute(row.uri)) {
    already++;
    continue;
  }
  const next = relativise(row.uri);
  if (next === null) {
    // Absolute but not under any workspace. Nothing should write there, so it is reported
    // rather than guessed at.
    outside++;
    console.log(`  left alone (outside a workspace): ${row.uri}`);
    continue;
  }
  changed++;
  if (!dry) update.run(next, row.id);
}

console.log(`  made relative:    ${changed}`);
console.log(`  already relative: ${already}`);
console.log(`  outside:          ${outside}`);
console.log(`  workspace:        ${WORKSPACE}`);
console.log(dry ? "  dry run, nothing written" : "  written");
