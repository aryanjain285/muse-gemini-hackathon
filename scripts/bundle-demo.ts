/**
 * Assemble the committed demo: one finished film, everything it needs, nothing else.
 *
 * `workspace/` accumulates every render and every asset of every attempt — over a gigabyte
 * of it — so committing the directory is not an option. Committing nothing was the previous
 * answer, and it left a clone with code, an empty gallery and no way to see the product
 * without paying to generate a film again.
 *
 * This copies one project's reel, stills, clips and score into `workspace/demo/`, which is
 * the one part of the directory git keeps. The model response cache is committed separately
 * and is what makes re-generating that same film cost nothing.
 *
 *   npx tsx scripts/bundle-demo.ts <projectId>
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { Assets, Projects, Renders, Specs } from "../src/lib/db/repo";
import { PATHS } from "../src/lib/core/paths";

const projectId = process.argv[2];
if (!projectId) {
  console.error("  usage: npx tsx scripts/bundle-demo.ts <projectId>");
  process.exit(1);
}

const project = Projects.get(projectId);
if (!project) {
  console.error(`  no project ${projectId}`);
  process.exit(1);
}

const demo = path.join(PATHS.workspace, "demo");
fs.rmSync(demo, { recursive: true, force: true });
fs.mkdirSync(path.join(demo, "assets"), { recursive: true });

let copied = 0;
let bytes = 0;

function take(from: string, into: string): void {
  if (!fs.existsSync(from)) {
    console.log(`  missing, skipped: ${path.basename(from)}`);
    return;
  }
  fs.copyFileSync(from, into);
  copied++;
  bytes += fs.statSync(into).size;
}

// What the committed film needs, and not one file more.
//
// This used to copy every asset row the project had. A project accumulates a take per
// attempt and a set per spec version, so the bundle grew by a couple of hundred megabytes
// every time the film was re-cut — 116 files and 440 MB for a thirty second reel whose
// finished edit references sixteen of them. Committed once that weight never leaves the
// history, so the set is derived from the render that was actually kept.
//
// Uploads are included on purpose even though the edit does not name them all: without the
// originals the opening transformation has nothing to transform from, and the whole point of
// the demo is that it starts on a real photograph.
const reel = Assets.byRole(projectId, "final", "reel");
const render = Renders.latestDone(projectId);
const active = Specs.active(projectId);

interface KeptManifest {
  clips?: { source?: Record<string, unknown> }[];
  audio?: Record<string, unknown>;
}
const kept: KeptManifest = render ? (JSON.parse(render.manifest_json) as KeptManifest) : {};

const wanted = new Set<string>();

/**
 * Every file a manifest entry names, whatever shape that entry has.
 *
 * A clip's source is not one shape: a plain take carries `path`, the opening shot carries
 * `fromPath` and `toPath` because it transforms a photograph into a painting. Reading only
 * the keys I remembered dropped the opening clip out of the bundle without a word — so any
 * key that names a path counts, and a shape added later is covered without this being
 * revisited.
 */
function pathsIn(entry: Record<string, unknown> | undefined): string[] {
  if (!entry) return [];
  return Object.entries(entry)
    .filter(([key, value]) => typeof value === "string" && /path$/i.test(key))
    .map(([, value]) => value as string);
}

for (const clip of kept.clips ?? []) {
  for (const file of pathsIn(clip.source)) wanted.add(path.basename(file));
}
for (const file of pathsIn(kept.audio)) wanted.add(path.basename(file));

// The uploads, and the one still per scene the studio shows on the storyboard.
for (const upload of Assets.byProject(projectId, "upload_image")) wanted.add(path.basename(upload.uri));
for (const scene of active?.spec.scenes ?? []) {
  const keyframe = Assets.byRole(projectId, scene.id, "keyframe");
  if (keyframe) wanted.add(path.basename(keyframe.uri));
}
for (const type of ["subject_sheet", "poster", "music"] as const) {
  const rows = Assets.byProject(projectId, type);
  const latest = rows[rows.length - 1];
  if (latest) wanted.add(path.basename(latest.uri));
}

// The reel is registered as an asset too, so it is excluded here or it lands twice — once in
// assets/ and once at the top level, and it is the largest file in the bundle.
let skipped = 0;
for (const asset of Assets.byProject(projectId)) {
  if (reel && asset.id === reel.id) continue;
  if (!wanted.has(path.basename(asset.uri))) {
    skipped++;
    continue;
  }
  take(asset.uri, path.join(demo, "assets", path.basename(asset.uri)));
}

// The reel itself sits at the top level, where a person looking in the directory finds it.
if (reel) take(reel.uri, path.join(demo, path.basename(reel.uri)));

// What it was cut from, in a form a person can read without the app running.
fs.writeFileSync(
  path.join(demo, "README.md"),
  [
    `# ${active?.spec.title ?? project.title}`,
    "",
    `> ${project.brief}`,
    "",
    active ? `${active.spec.logline}` : "",
    "",
    "This is the film MUSE made, committed so the repository is worth cloning: the gallery",
    "has something in it and `npm run dev` shows a finished reel without a key, a network or",
    "a budget. `scripts/restore-demo.ts` puts these files back where the database expects",
    "them; the model response cache in `workspace/cache/` makes regenerating the same film",
    "cost nothing.",
    "",
    "| | |",
    "|---|---|",
    `| project | \`${projectId}\` |`,
    `| preset | ${project.preset} |`,
    `| shots | ${active ? active.spec.scenes.length : "?"} |`,
    `| duration | ${active ? active.spec.duration_s : "?"}s |`,
    `| reel | \`${reel ? path.basename(reel.uri) : "none"}\` |`,
    `| render | \`${render ? render.id : "none"}\` |`,
    "",
  ].join("\n"),
);

fs.writeFileSync(
  path.join(demo, "project.json"),
  JSON.stringify({ projectId, reel: reel ? path.basename(reel.uri) : null }, null, 2),
);

/**
 * Anything the committed database promises that this bundle cannot deliver.
 *
 * The database was committed describing sixteen films while the bundle carried one, so a clone
 * opened its gallery on fifteen entries whose reel and poster existed only on the machine that
 * made them. Nothing said so: the bundler reported success, the database was valid, and the gap
 * was only visible as a page full of broken thumbnails on somebody else's laptop.
 */
const playable = new Set<string>();
for (const dir of [demo, path.join(demo, "assets")]) {
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) playable.add(f);
}
const unplayable = Projects.list(200).filter((p) => {
  const theirs = Assets.byRole(p.id, "final", "reel");
  return theirs ? !playable.has(path.basename(theirs.uri)) : false;
});

console.log(`  bundled ${copied} files, ${(bytes / 1048576).toFixed(1)} MB -> workspace/demo/`);
if (unplayable.length > 0) {
  console.log(
    `
  WARNING: ${unplayable.length} film(s) in the database have no media in this bundle, so a` +
      ` clone will show them broken:`,
  );
  for (const p of unplayable) console.log(`    ${p.id}  ${p.title}`);
  console.log(`  run: npx tsx scripts/tidy-demo.ts --only-bundled`);
}
console.log(`  left behind ${skipped} superseded take(s) from earlier attempts`);
