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

import fs from "node:fs";

import { db } from "../src/lib/db/client";
import { PATHS, WORKSPACE } from "../src/lib/core/paths";

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

// ── fold the write-ahead log into the file that gets committed ───────────────
//
// SQLite runs in WAL mode here and `workspace/muse.db-wal` is ignored, so `git add
// workspace/muse.db` committed the main file without any pending pages. The repository ended up
// describing sixteen films, then five, while this machine held one — and the mismatch was only
// visible after cloning. Checkpointing here means the committed file is the database, every time,
// because this script already runs before every commit that touches it.
const walPath = `${PATHS.db}-wal`;
const walBefore = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
if (!dry) db().pragma("wal_checkpoint(TRUNCATE)");
const walAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
console.log(
  `  write-ahead log:  ${(walBefore / 1048576).toFixed(2)} MB -> ${(walAfter / 1048576).toFixed(2)} MB`,
);

console.log(`  made relative:    ${changed}`);
console.log(`  already relative: ${already}`);
console.log(`  outside:          ${outside}`);
console.log(`  workspace:        ${WORKSPACE}`);
console.log(dry ? "  dry run, nothing written" : "  written");
