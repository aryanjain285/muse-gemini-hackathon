/**
 * Choose which take of a scene the film should use.
 *
 * A project accumulates several takes per scene: one per attempt, and a fresh set every time
 * the plan changes. The composer takes the newest, which is right while a run is in progress
 * and wrong afterwards — the newest take is simply the last one made, not the best one. When a
 * shot fell back to deterministic motion because the video quota was spent, an earlier attempt
 * may hold real motion that nothing will ever reach again.
 *
 * This makes a chosen take current by registering it again, so the composer's "newest" rule
 * picks it. Nothing is deleted and no history is rewritten: the take that was current stays in
 * the table, and choosing it again puts it back.
 *
 * Recomposing afterwards costs nothing, so a choice can be looked at and reversed.
 *
 *   npx tsx scripts/best-take.ts --list
 *   npx tsx scripts/best-take.ts --scene s02 --take clip-s02-v5-a0.mp4
 *
 * A caution learned the hard way: a QC verdict recorded before the critic was sent the
 * reference photographs is not evidence. Those runs scored identity without ever being shown
 * a face, and a take that put five strangers around the subject passed at 0.7. Look at a frame
 * before trusting an old PASS.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config as loadEnv } from "./load-env";

loadEnv();

import { Assets, Projects, Specs } from "../src/lib/db/repo";
import { registerFile } from "../src/lib/services/assets";

const PROJECT = process.env.MUSE_RESTORE_PROJECT ?? "prj_v0b74ybbt2ki";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** Run a command and resolve with its stdout as bytes. */
function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

/**
 * How much of each edge is border rather than picture.
 *
 * The image model paints its picture as a sheet of paper — margins, and often a ruled line
 * around them — and a video model asked to animate that sheet keeps all of it. On a full-bleed
 * vertical reel the result reads as a photograph of a painting hung on a wall, beside six shots
 * that bleed to the edge.
 *
 * Brightness is the wrong signal: the first attempt tested for near-white edges and measured
 * almost nothing, because the outermost columns of a framed painting are the dark rule, not the
 * pale margin behind it. What a border actually has in common — pale paper, dark rule alike —
 * is that it is *flat*. Painted content is not.
 *
 * Both side edges have to be flat before anything is cropped. A single flat edge is ordinary:
 * an empty sky, a wall, a field of snow. Flat on the left and the right at the same depth is a
 * frame. The result is capped at a twelfth of the frame, so being wrong costs a sliver rather
 * than the composition.
 */
async function paperInset(file: string, width: number, height: number): Promise<number> {
  const raw = await run("ffmpeg", [
    "-v", "error", "-ss", "1", "-i", file,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ]);
  if (raw.length < width * height) return 0;

  const FLAT = 14;
  const columnIsFlat = (x: number): boolean => {
    let sum = 0;
    let sumSq = 0;
    for (let y = 0; y < height; y++) {
      const v = raw[y * width + x];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / height;
    return Math.sqrt(Math.max(0, sumSq / height - mean * mean)) < FLAT;
  };

  const cap = Math.floor(width / 12);
  let left = 0;
  while (left < cap && columnIsFlat(left)) left++;
  let right = 0;
  while (right < cap && columnIsFlat(width - 1 - right)) right++;

  const border = Math.min(left, right);
  if (border === 0) return 0;
  // A little past the measured edge, because a margin fades into the picture rather than
  // stopping at a line.
  return Math.min(border / width + 0.006, 1 / 12);
}

/**
 * Crop the paper away and scale back to the original size.
 *
 * The inset is applied to both dimensions equally so the aspect ratio survives untouched — a
 * 9:16 reel that stops being 9:16 for one shot is a worse fault than the border.
 */
async function trimPaper(from: string, to: string): Promise<{ trimmed: boolean; inset: number }> {
  const probe = (await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", from,
  ]))
    .toString()
    .trim();
  const [width, height] = probe.split(",").map((n) => Number(n.trim()));
  if (!width || !height) throw new Error(`could not read the size of ${path.basename(from)}`);

  const inset = await paperInset(from, width, height);
  if (inset === 0) return { trimmed: false, inset: 0 };

  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const cw = even(width * (1 - 2 * inset));
  const ch = even(height * (1 - 2 * inset));
  const cx = even((width - cw) / 2);
  const cy = even((height - ch) / 2);

  await run("ffmpeg", [
    "-v", "error", "-y", "-i", from,
    "-vf", `crop=${cw}:${ch}:${cx}:${cy},scale=${width}:${height}:flags=lanczos`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
    "-an", "-movflags", "+faststart", to,
  ]);
  return { trimmed: true, inset };
}

const project = Projects.get(PROJECT);
if (!project) {
  console.error(`  no project ${PROJECT}`);
  process.exit(1);
}

interface Take {
  id: string;
  file: string;
  generated: boolean;
  route: string;
  createdAt: string;
  current: boolean;
}

function takesFor(sceneId: string): Take[] {
  const current = Assets.byRole(PROJECT, sceneId, "scene_video");
  return Assets.byProject(PROJECT, "scene_video")
    .filter((a) => a.role === sceneId)
    .map((a) => {
      const meta = Assets.meta<{ generated?: boolean; route?: string }>(a);
      return {
        id: a.id,
        file: path.basename(a.uri),
        generated: Boolean(meta.generated),
        route: meta.route ?? "",
        createdAt: a.created_at,
        current: current?.id === a.id,
      };
    });
}

if (process.argv.includes("--list")) {
  const spec = Specs.active(PROJECT);
  for (const scene of spec?.spec.scenes ?? []) {
    console.log(`\n  ${scene.id}  ${scene.purpose}`);
    for (const t of takesFor(scene.id)) {
      const marks = [t.generated ? "motion" : "still", t.current ? "in the film" : ""].filter(Boolean);
      console.log(`    ${t.file.padEnd(26)} ${marks.join(", ")}`);
    }
  }
  process.exit(0);
}

const sceneId = arg("scene");
const wanted = arg("take");
if (!sceneId || !wanted) {
  console.error("  usage: --list  |  --scene <id> --take <filename>");
  process.exit(1);
}

const trim = process.argv.includes("--trim");

async function choose(): Promise<void> {
  const takes = takesFor(sceneId!);
  const pick = takes.find((t) => t.file === wanted);
  if (!pick) {
    console.error(`  ${sceneId} has no take named ${wanted}. Known takes:`);
    for (const t of takes) console.error(`    ${t.file}`);
    process.exitCode = 1;
    return;
  }
  if (pick.current && !trim) {
    console.log(`  ${wanted} is already the take ${sceneId} uses; nothing to do`);
    return;
  }

  const row = Assets.byProject(PROJECT, "scene_video").find((a) => a.id === pick.id);
  if (!row || !fs.existsSync(row.uri)) {
    console.error(`  the file for ${wanted} is not on disk; restore it before choosing it`);
    process.exitCode = 1;
    return;
  }

  let file = row.uri;
  let note = "";
  if (trim) {
    const out = row.uri.replace(/\.mp4$/, "-trimmed.mp4");
    const result = await trimPaper(row.uri, out);
    if (result.trimmed) {
      file = out;
      note = `, paper margin trimmed (${(result.inset * 100).toFixed(1)}% inset)`;
    } else {
      note = " , no paper margin found to trim";
    }
  }

  // Registered again rather than moved: the same path gains a newer row, so the composer's
  // newest-take rule resolves to it while every earlier take stays exactly where it was.
  const fresh = registerFile({
    projectId: PROJECT,
    type: "scene_video",
    role: sceneId!,
    filePath: file,
    mime: row.mime,
    // The point here is a newer row for a file that is already registered, so the duplicate
    // is asked for rather than worked around.
    duplicate: true,
    metadata: {
      ...Assets.meta<Record<string, unknown>>(row),
      chosen: true,
      chosenFrom: pick.file,
      ...(file !== row.uri ? { trimmedFrom: path.basename(row.uri) } : {}),
    },
  });

  console.log(`  ${sceneId} now uses ${path.basename(file)} (${pick.generated ? "generated motion" : "still"}${note})`);
  console.log(`  registered as ${fresh.id}; recompose to see it:`);
  console.log(`    curl -s -X POST http://localhost:3939/api/projects/${PROJECT}/render -H 'content-type: application/json' -d '{}'`);
}

// Not a top-level await: these scripts transpile to CommonJS, which does not allow one.
void choose();
