/**
 * Showcase run: one film at the highest quality the budget allows, then measured
 * and laid out for inspection.
 *
 * Unlike verify-e2e, which proves correctness cheaply, this exists to produce the
 * reel you would actually show someone. It uses the real photograph as the identity
 * anchor, generates every frame at 1K, asks Lyria for the score, spends one Veo shot
 * on the drop, and then builds a contact sheet of the frames plus a strip of the
 * finished cuts so the result can be judged by eye rather than by log.
 *
 *   npx tsx scripts/showcase.ts                 # hero profile, one Veo shot
 *   npx tsx scripts/showcase.ts --profile standard
 *   npx tsx scripts/showcase.ts --preset neon_anime
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { OUTPUT, PROFILE_NAMES, type ProfileName } from "../src/lib/core/config";
import { PATHS, ensureDirs } from "../src/lib/core/paths";
import { round } from "../src/lib/core/util";
import { Assets, Ledger, Projects, Qc, Renders, Specs } from "../src/lib/db/repo";
import { budget } from "../src/lib/models/governor";
import { checkReel, ffmpeg, probeMedia } from "../src/lib/compose/ffmpeg";
import { SNAP_TOLERANCE_S } from "../src/lib/compose/plan";
import { shotSize } from "../src/lib/spec/directorSpec";
import { cameraLabel } from "../src/lib/brand";
import { registerPipelineHandlers } from "../src/lib/services/pipeline";
import { putBytes } from "../src/lib/services/assets";
import { drain, start, wait } from "../src/lib/jobs/runner";
import type { RenderManifest } from "../src/lib/compose/types";

const argv = process.argv.slice(2);
const value = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const PROFILE = value("profile", "hero") as ProfileName;
const PRESET = value("preset", "dreamy_animated_memories");
const BRIEF = value(
  "brief",
  "the summer we drove to the coast and everything felt endless",
);

if (!PROFILE_NAMES.includes(PROFILE)) {
  console.error(`unknown profile '${PROFILE}'`);
  process.exit(1);
}

const OUT = path.join(PATHS.workspace, "showcase");

/**
 * Identity anchor. The painterly reference is a real photograph of one person, so
 * the frames that follow are all recognisably her — which is the whole point of the
 * subject reference.
 */
function anchorPhotos(): { bytes: Buffer; mime: string; name: string }[] {
  const ref = path.join(PATHS.workspace, "reference", "keyframe-probe-0.jpg");
  if (!fs.existsSync(ref)) {
    console.error("no reference photograph at workspace/reference/keyframe-probe-0.jpg");
    process.exit(1);
  }
  // One photograph only. Three different-looking inputs make the engine rotate
  // between them, which is right for variety but wrong when the point is to show
  // that one person stays herself across seven shots.
  return [{ bytes: fs.readFileSync(ref), mime: "image/jpeg", name: "subject.jpg" }];
}

async function contactSheet(projectId: string, shots: { id: string; uri: string }[]): Promise<string | null> {
  if (shots.length === 0) return null;
  const out = path.join(OUT, `${projectId}-frames.png`);
  const cols = Math.min(4, shots.length);
  const rows = Math.ceil(shots.length / cols);
  const args: string[] = ["-y"];
  for (const s of shots) args.push("-i", s.uri);
  const scaled = shots.map((_, i) => `[${i}:v]scale=320:-1,setsar=1[s${i}]`).join(";");
  const joined = shots.map((_, i) => `[s${i}]`).join("");
  args.push(
    "-filter_complex",
    `${scaled};${joined}xstack=inputs=${shots.length}:layout=${layout(shots.length, cols)}:fill=0x0A0A0C[v]`,
    "-map",
    "[v]",
    "-frames:v",
    "1",
    out,
  );
  try {
    await ffmpeg(args, { timeoutMs: 120_000 });
    return out;
  } catch {
    // xstack needs a full rectangle; fall back to a single row when it will not tile.
    const alt = path.join(OUT, `${projectId}-frames-row.png`);
    await ffmpeg(
      [
        "-y",
        ...shots.flatMap((s) => ["-i", s.uri]),
        "-filter_complex",
        `${scaled};${joined}hstack=inputs=${shots.length}[v]`,
        "-map",
        "[v]",
        "-frames:v",
        "1",
        alt,
      ],
      { timeoutMs: 120_000 },
    );
    void rows;
    return alt;
  }
}

/** xstack layout string for a grid of `n` items in `cols` columns. */
function layout(n: number, cols: number): string {
  const cells: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = c === 0 ? "0" : Array.from({ length: c }, (_, k) => `w${k}`).join("+");
    const y = r === 0 ? "0" : Array.from({ length: r }, (_, k) => `h${k * cols}`).join("+");
    cells.push(`${x}_${y}`);
  }
  return cells.join("|");
}

/** A strip of the finished reel sampled inside each shot, to judge the cutting. */
async function cutStrip(reel: string, manifest: RenderManifest, projectId: string): Promise<string> {
  const out = path.join(OUT, `${projectId}-cuts.png`);
  const frames = manifest.clips.map((c) => round(c.startS + (c.endS - c.startS) * 0.45, 2));
  const expr = frames.map((t) => `eq(n\\,${Math.round(t * manifest.fps)})`).join("+");
  await ffmpeg(
    [
      "-y",
      "-i",
      reel,
      "-vf",
      `select='${expr}',scale=200:-1,tile=${frames.length}x1:padding=6:color=0x0A0A0C`,
      "-frames:v",
      "1",
      "-fps_mode",
      "passthrough",
      out,
    ],
    { timeoutMs: 120_000 },
  );
  return out;
}

async function main(): Promise<void> {
  ensureDirs();
  fs.mkdirSync(OUT, { recursive: true });

  console.log("MUSE showcase\n=============");
  console.log(`profile=${PROFILE} preset=${PRESET}`);
  const before = budget();
  console.log(`budget: $${before.spentUsd.toFixed(4)} spent, $${before.remainingUsd.toFixed(4)} left\n`);

  registerPipelineHandlers();

  const project = Projects.create({
    mode: "generated",
    preset: PRESET,
    profile: PROFILE,
    brief: BRIEF,
    title: "Showcase",
  });
  Projects.patch(project.id, { consent: 1 });
  for (const p of anchorPhotos()) {
    putBytes({ projectId: project.id, type: "upload_image", bytes: p.bytes, mime: p.mime, name: p.name });
  }
  console.log(`project ${project.id}`);
  console.log(`brief   "${BRIEF}"\n`);

  const began = Date.now();
  const started = start(project.id, "pipeline", {});
  if (!started.started) {
    console.error(`could not start: ${started.reason}`);
    process.exit(1);
  }
  await wait(project.id);
  await drain();
  const elapsed = (Date.now() - began) / 1000;

  const after = Projects.require(project.id);
  console.log(`finished in ${elapsed.toFixed(0)}s with status ${after.status}`);
  if (after.error) console.log(`error: ${after.error}`);

  const active = Specs.active(project.id);
  if (!active) {
    console.error("no plan was produced");
    process.exit(1);
  }
  const spec = active.spec;
  console.log(`\n"${spec.title}" — ${spec.logline}`);
  console.log(`${spec.scenes.length} shots over ${spec.duration_s}s at ${spec.music.bpm_target} BPM\n`);

  // ── the frames ─────────────────────────────────────────────────────────────
  console.log("frames");
  const frames: { id: string; uri: string }[] = [];
  for (const s of spec.scenes) {
    const kf = Assets.byRole(project.id, s.id, "keyframe");
    if (!kf) {
      console.log(`  ${s.id}  missing`);
      continue;
    }
    const meta = Assets.meta<{ route?: string }>(kf);
    const info = await probeMedia(kf.uri).catch(() => null);
    console.log(
      `  ${s.id}  ${(info ? `${info.width}x${info.height}` : "?").padEnd(11)} ${(meta.route ?? "local").padEnd(30)} ${shotSize(s).padEnd(14)} ${s.purpose}`,
    );
    frames.push({ id: s.id, uri: kf.uri });
  }

  // Motion, reported separately from stills. A reel can have every frame painted by a
  // model and still be seven stills with camera moves over them, and printing only the
  // keyframe routes made that indistinguishable from an animated reel.
  console.log(`\nmotion`);
  let generatedShots = 0;
  let generatedSeconds = 0;
  for (const s of spec.scenes) {
    const clip = Assets.byRole(project.id, s.id, "scene_video");
    if (!clip) {
      console.log(`  ${s.id}  missing`);
      continue;
    }
    const meta = Assets.meta<{ route?: string; generated?: boolean; fallbackReason?: string }>(clip);
    const info = await probeMedia(clip.uri).catch(() => null);
    const real = meta.generated === true;
    if (real && info) {
      generatedShots += 1;
      generatedSeconds += info.durationS;
    }
    const how = real ? "generated motion" : "camera move on a still";
    console.log(
      `  ${s.id}  ${(info ? `${info.durationS.toFixed(2)}s` : "?").padEnd(7)} ${how.padEnd(24)} ${(meta.route ?? "local").padEnd(30)} ${cameraLabel(s.camera)}`,
    );
    if (meta.fallbackReason) console.log(`         fell back: ${String(meta.fallbackReason).slice(0, 110)}`);
  }
  console.log(
    `\n  ${generatedShots} of ${spec.scenes.length} shots actually move, ${generatedSeconds.toFixed(1)}s of generated video`,
  );

  const sheet = await contactSheet(project.id, frames);
  // Coverage is the point of the shot-size field, so the run reports what it got.
  const sizes = spec.scenes.map((s) => shotSize(s));
  const repeats = sizes.filter((z, i) => i > 0 && z === sizes[i - 1]).length;
  console.log(
    `\n  coverage  ${new Set(sizes).size} sizes across ${sizes.length} shots, ${repeats} adjacent repeat${repeats === 1 ? "" : "s"}`,
  );

  if (sheet) console.log(`\n  contact sheet -> ${path.relative(process.cwd(), sheet)}`);

  // ── the score ──────────────────────────────────────────────────────────────
  const score = Assets.byProject(project.id, "music").slice(-1)[0];
  if (score) {
    const m = Assets.meta<{ route?: string; bpm?: number; snapped?: number; unmatched?: string[] }>(score);
    console.log(
      `\nscore   ${m.route} at ${m.bpm} BPM, ${m.snapped} beats matched${
        (m.unmatched ?? []).length > 0 ? `, missing ${(m.unmatched ?? []).join("/")}` : ""
      }`,
    );
  }

  // ── the reel ───────────────────────────────────────────────────────────────
  const reel = Assets.byRole(project.id, "final", "reel");
  if (!reel) {
    console.error("\nno reel was exported");
    process.exit(1);
  }
  const render = Renders.latestDone(project.id);
  const manifest = render ? (JSON.parse(render.manifest_json) as RenderManifest) : null;
  const check = await checkReel(reel.uri, {
    durationS: spec.duration_s,
    width: OUTPUT.width,
    height: OUTPUT.height,
  });

  console.log(
    `\nreel    ${check.width}x${check.height} · ${check.durationS.toFixed(2)}s · audio ${
      check.hasAudio ? "yes" : "NO"
    } · ${check.ok ? "clean" : check.issues.join("; ")}`,
  );

  if (manifest) {
    console.log("\ncuts");
    const anchors = manifest.anchorsS;
    for (const [i, c] of manifest.clips.entries()) {
      if (i === 0) {
        console.log(`  ${c.sceneId}  ${c.startS.toFixed(2)}s  opens`);
        continue;
      }
      const d = anchors.length > 0 ? Math.min(...anchors.map((a) => Math.abs(a - c.startS))) : -1;
      const onBeat = d >= 0 && d <= 0.05;
      console.log(
        `  ${c.sceneId}  ${c.startS.toFixed(2)}s  ${c.transitionIn.padEnd(13)} ${
          d < 0 ? "" : onBeat ? `on the beat (${(d * 1000).toFixed(0)}ms)` : `${(d * 1000).toFixed(0)}ms off`
        }`,
      );
    }
    const reachable = manifest.clips
      .slice(1)
      .map((c) => Math.min(...anchors.map((a) => Math.abs(a - c.startS))))
      .filter((d) => d <= SNAP_TOLERANCE_S);
    if (reachable.length > 0) {
      console.log(
        `  ${reachable.length}/${manifest.clips.length - 1} cuts had a beat in reach, worst ${(
          Math.max(...reachable) * 1000
        ).toFixed(0)}ms off`,
      );
    }
    const strip = await cutStrip(reel.uri, manifest, project.id);
    console.log(`\n  cut strip -> ${path.relative(process.cwd(), strip)}`);
  }

  const verdicts = Qc.byProject(project.id).reduce<Record<string, number>>((acc, r) => {
    acc[r.decision] = (acc[r.decision] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `\nreview  ${Object.entries(verdicts).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`,
  );

  const spent = round(Ledger.projectUsd(project.id), 4);
  const end = budget();
  console.log(`spend   $${spent} on this film · $${end.remainingUsd.toFixed(4)} left of $${end.ceilingUsd.toFixed(2)}`);
  console.log(`\nreel    ${reel.uri}`);
  console.log(`open    http://localhost:3939/studio/${project.id}`);
}

void main().catch((e) => {
  console.error("\nshowcase failed:", e);
  process.exit(1);
});
