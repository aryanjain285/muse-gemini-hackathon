/**
 * Put the committed media back where the database expects it.
 *
 * A fresh clone has `workspace/demo/` and `workspace/muse.db` but no `workspace/assets/` or
 * `workspace/renders/` — those are ignored, because they hold every attempt ever made. This copies
 * the bundle into the places the asset rows point at, so the gallery, the studio and a re-cut all
 * work on a machine that has never generated anything.
 *
 * The bundle mirrors the workspace layout, so restoring is a plain recursive copy. It used to be
 * flat — one directory of files addressed by basename — which works only while basenames are
 * unique, and they are not: every project writes `poster-v1.jpg`. Fifteen films contributed fifteen
 * files with one name, fourteen were dropped on the way in, and whichever survived would have been
 * restored into every project's directory, putting one film's poster on another film's card.
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

if (!Projects.get(projectId)) {
  console.error(`  the database has no project ${projectId}; is workspace/muse.db committed?`);
  process.exit(1);
}

let placed = 0;
let already = 0;

/** Copy the mirrored tree into the workspace, keeping every path exactly as it was. */
function place(fromDir: string, relative = ""): void {
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      place(from, rel);
      continue;
    }
    const to = path.join(PATHS.workspace, rel);
    if (fs.existsSync(to)) {
      already++;
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    placed++;
  }
}

const files = path.join(demo, "files");
if (!fs.existsSync(files)) {
  console.error("  workspace/demo/files/ is missing; re-run scripts/bundle-demo.ts");
  process.exit(1);
}
place(files);

console.log(`  placed ${placed}, already there ${already}`);

// What the gallery will and will not be able to show, stated plainly here rather than discovered
// later as a page of broken thumbnails on somebody else's laptop.
const films = Projects.list(200);
const broken = films.filter((p) => {
  const reel = Assets.byRole(p.id, "final", "reel");
  return !reel || !fs.existsSync(reel.uri);
});
console.log(`  ${films.length - broken.length}/${films.length} film(s) can play`);
for (const p of broken) console.log(`    cannot play: ${p.id}  ${p.title}`);
console.log(`  open http://localhost:3939/studio/${projectId} after npm run dev`);
