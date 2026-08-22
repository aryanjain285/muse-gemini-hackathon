/**
 * Animated previews of a film, for the README.
 *
 * GitHub will not play a `<video>` pointing at a path inside the repository — the tag survives the
 * HTML sanitiser but the source does not resolve, so the reader gets an empty box. An animated GIF
 * plays inline with no player and no click, which is the only thing that reliably moves on a
 * repository page.
 *
 * So: a short excerpt, two-pass palette so the gradients in a dawn sky do not band into mud, and
 * small enough that a README does not cost ten megabytes to open. Sound is lost, which is why the
 * poster underneath links to the film itself.
 *
 *   npx tsx scripts/make-preview.ts <projectId> --at 15 --seconds 7
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { Assets, Projects } from "../src/lib/db/repo";
import { exec as runFfmpeg } from "../src/lib/visual/ffmpegExec";

const argv = process.argv.slice(2);
const projectId = argv.find((a) => !a.startsWith("--"));
const value = (name: string, dflt: number): number => {
  const at = argv.indexOf(`--${name}`);
  const raw = at >= 0 ? Number(argv[at + 1]) : NaN;
  return Number.isFinite(raw) ? raw : dflt;
};

if (!projectId) {
  console.error("  usage: npx tsx scripts/make-preview.ts <projectId> [--at 15] [--seconds 7] [--width 400]");
  process.exit(1);
}

const project = Projects.get(projectId);
if (!project) {
  console.error(`  no project ${projectId}`);
  process.exit(1);
}

const reel = Assets.byRole(projectId, "final", "reel");
if (!reel || !fs.existsSync(reel.uri)) {
  console.error(`  ${projectId} has no reel on disk`);
  process.exit(1);
}

const at = value("at", 15);
const seconds = value("seconds", 7);
const width = value("width", 400);
const fps = value("fps", 12);

const outDir = path.join(process.cwd(), "docs", "preview");
fs.mkdirSync(outDir, { recursive: true });
const slug = path.basename(reel.uri).replace(/\.mp4$/, "");
const gif = path.join(outDir, `${slug}.gif`);
const poster = path.join(outDir, `${slug}.jpg`);
const palette = path.join(outDir, `.palette-${slug}.png`);

async function main(): Promise<void> {
  // One palette for the whole excerpt rather than per frame: a dawn sky is mostly one gradient, and
  // a per-frame palette makes it crawl.
  await runFfmpeg("ffmpeg", [
    "-y", "-ss", String(at), "-t", String(seconds), "-i", reel!.uri,
    "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=max_colors=192:stats_mode=diff`,
    palette,
  ]);
  await runFfmpeg("ffmpeg", [
    "-y", "-ss", String(at), "-t", String(seconds), "-i", reel!.uri, "-i", palette,
    "-lavfi", `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    "-loop", "0",
    gif,
  ]);
  await runFfmpeg("ffmpeg", [
    "-y", "-ss", String(at + seconds / 2), "-i", reel!.uri,
    "-frames:v", "1", "-vf", `scale=${width * 2}:-1:flags=lanczos`, "-q:v", "3",
    poster,
  ]);
  fs.rmSync(palette, { force: true });

  const mb = (p: string) => (fs.statSync(p).size / 1048576).toFixed(2);
  console.log(`  ${project!.title}`);
  console.log(`    ${path.relative(process.cwd(), gif)}  ${mb(gif)} MB  (${seconds}s from ${at}s, ${width}px, ${fps}fps)`);
  console.log(`    ${path.relative(process.cwd(), poster)}  ${mb(poster)} MB`);
}

void main();
