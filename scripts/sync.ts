/**
 * Bring a clone's data into line with what was committed.
 *
 * `workspace/muse.db` is both committed and written to by the running app, which means a pull
 * always has something to argue with: git will not overwrite a locally modified file, so it keeps
 * yours and the new films never arrive. Sixteen films where the repository says seventeen, and
 * nothing on screen to explain it.
 *
 * Worse, SQLite's write-ahead log is a separate, ignored file. A stale `muse.db-wal` left over from
 * before the pull is replayed on top of the database that just arrived — so even a pull that does
 * land can be quietly undone by a log belonging to the file it replaced.
 *
 * So this resets exactly the committed data files to what the current commit says, removes the log
 * that no longer belongs to them, and then puts the media back. Nothing else is touched: no branch
 * changes, no other file, no network.
 *
 *   npm run sync
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config as loadEnv } from "./load-env";

loadEnv();

import { PATHS } from "../src/lib/core/paths";

/** The committed data files. Code is left alone; a pull handles that on its own. */
const TRACKED = ["workspace/muse.db", "workspace/memories", "workspace/storybooks", "workspace/demo"];

function git(args: string[]): { ok: boolean; out: string } {
  const run = spawnSync("git", args, { encoding: "utf8" });
  return { ok: run.status === 0, out: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

const dry = process.argv.includes("--dry");

const inRepo = git(["rev-parse", "--is-inside-work-tree"]);
if (!inRepo.ok) {
  console.error("  not a git repository; nothing to sync against");
  process.exit(1);
}

// A running server holds the database open, and resetting it underneath one is how a demo breaks
// mid-sentence. Better to say so than to do it.
const lock = `${PATHS.db}-shm`;
if (fs.existsSync(lock)) {
  console.log("  note: the database looks open. Stop `npm run dev` first if it is running.");
}

console.log("  resetting committed data to this commit:");
for (const target of TRACKED) {
  if (!fs.existsSync(path.join(process.cwd(), target))) {
    console.log(`    ${target}  (not present, will be restored by the checkout)`);
  }
  if (dry) {
    console.log(`    ${target}  would reset`);
    continue;
  }
  const done = git(["checkout", "--", target]);
  console.log(`    ${target}  ${done.ok ? "reset" : `left alone (${done.out.split("\n")[0]})`}`);
}

// The log belonged to the file that was just replaced. Keeping it is worse than losing it: it is
// replayed on open, and what it replays is the state the pull was meant to remove.
for (const sidecar of ["-wal", "-shm"]) {
  const at = `${PATHS.db}${sidecar}`;
  if (!fs.existsSync(at)) continue;
  const size = fs.statSync(at).size;
  if (dry) {
    console.log(`  would remove ${path.basename(at)} (${(size / 1048576).toFixed(2)} MB)`);
    continue;
  }
  fs.rmSync(at, { force: true });
  console.log(`  removed ${path.basename(at)} (${(size / 1048576).toFixed(2)} MB of stale log)`);
}

if (dry) {
  console.log("  dry run; run without --dry, then `npm run setup`");
  process.exit(0);
}

console.log("\n  now putting the media back:");
const restore = spawnSync("npx", ["tsx", "scripts/restore-demo.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
console.log((restore.stdout ?? "").trimEnd());
if (restore.status !== 0) console.error((restore.stderr ?? "").trim());

const seed = spawnSync("npx", ["tsx", "scripts/seed-memories.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
console.log((seed.stdout ?? "").trimEnd());
