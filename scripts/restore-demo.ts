/**
 * Put the committed demo film back where the database expects it.
 *
 * A fresh clone has `workspace/demo/` and `workspace/muse.db` but no `workspace/assets/` or
 * `workspace/renders/` — those are ignored, because they hold every attempt ever made. This
 * copies the bundle into the two locations the asset rows point at, so the gallery, the
 * studio and the re-cut all work on a machine that has never generated anything.
 *
 * Idempotent: a file already in place is left alone.
 *
 *   npx tsx scripts/restore-demo.ts
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { Assets, Projects } from "../src/lib/db/repo";
import { PATHS, ensureDirs } from "../src/lib/core/paths";

const demo = path.join(PATHS.workspace, "demo");
if (!fs.existsSync(demo)) {
  console.log("  nothing to restore: workspace/demo/ is not present");
  process.exit(0);
}

const manifest = path.join(demo, "project.json");
if (!fs.existsSync(manifest)) {
  console.error("  workspace/demo/project.json is missing; the bundle is incomplete");
  process.exit(1);
}

const { projectId } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { projectId: string };
ensureDirs();

const project = Projects.get(projectId);
if (!project) {
  console.error(`  the database has no project ${projectId}; is workspace/muse.db committed?`);
  process.exit(1);
}

let placed = 0;
let already = 0;
let missing = 0;
let superseded = 0;

/** Copy one bundled file to wherever its asset row says it belongs. */
function place(from: string, to: string): void {
  if (!fs.existsSync(from)) {
    missing++;
    console.log(`  not in the bundle: ${path.basename(from)}`);
    return;
  }
  if (fs.existsSync(to)) {
    already++;
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  placed++;
}

// Asset rows resolve to absolute paths under this workspace, so the destination is whatever
// this machine's layout says rather than whatever the machine that made the film said.
//
// The bundle holds one film, not every take the project ever produced, so a row with no
// bundled file is the normal case rather than a fault — only the reel and the files the kept
// edit references have to be there. The reel is skipped in this loop because the bundle keeps
// it at the top level, and counting it here reported a phantom missing file on every restore.
const reel = Assets.byRole(projectId, "final", "reel");
for (const asset of Assets.byProject(projectId)) {
  if (reel && asset.id === reel.id) continue;
  const from = path.join(demo, "assets", path.basename(asset.uri));
  if (!fs.existsSync(from)) {
    superseded++;
    continue;
  }
  place(from, asset.uri);
}

if (reel) place(path.join(demo, path.basename(reel.uri)), reel.uri);

console.log(`  placed ${placed}, already there ${already}, missing ${missing}`);
if (superseded > 0) {
  console.log(`  ${superseded} superseded take(s) are not in the bundle, which is expected`);
}
if (placed > 0 || already > 0) {
  console.log(`  open http://localhost:3939/studio/${projectId} after npm run dev`);
}
