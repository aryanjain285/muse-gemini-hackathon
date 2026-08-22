/**
 * End-to-end verification.
 *
 * Drives a whole project through the real pipeline — preflight, plan, score,
 * scenes, quality control, composition — and then measures the finished MP4
 * rather than trusting that the run reported success. Nothing is mocked; the same
 * services the app calls are called here.
 *
 * Defaults to the local profile, so it costs nothing and needs no network. Pass a
 * profile to exercise the paid routes:
 *
 *   npx tsx scripts/verify-e2e.ts                  # $0.00, no network
 *   npx tsx scripts/verify-e2e.ts --profile wiring # real director and critic
 *   npx tsx scripts/verify-e2e.ts --keep           # leave the project in place
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { LIMITS, OUTPUT, PROFILE_NAMES, type ProfileName } from "../src/lib/core/config";
import { PATHS, ensureDirs } from "../src/lib/core/paths";
import { round } from "../src/lib/core/util";
import { Assets, Ledger, Projects, Qc, Renders, Specs } from "../src/lib/db/repo";
import { budget } from "../src/lib/models/governor";
import { checkReel, ffmpeg, probeMedia } from "../src/lib/compose/ffmpeg";
import { SNAP_TOLERANCE_S, validateManifest } from "../src/lib/compose/plan";
import { registerPipelineHandlers } from "../src/lib/services/pipeline";
import { putBytes, purgeProjectAssets } from "../src/lib/services/assets";
import { drain, start, wait } from "../src/lib/jobs/runner";
import { replay } from "../src/lib/jobs/bus";
import type { RenderManifest } from "../src/lib/compose/types";

// ── argument parsing ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(name: string, dflt: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const PROFILE = value("profile", "local") as ProfileName;
const PRESET = value("preset", "dreamy_animated_memories");
const KEEP = flag("keep");
const USE_AGENT = flag("agent");
/**
 * Verify the uploaded-track path instead of the generated score.
 *
 * That path had never carried a byte of anyone's audio: one project was marked as using an
 * uploaded track and no upload_audio asset existed anywhere in the database. A mode nothing
 * exercises is a mode nobody knows is broken, which is exactly how the agent driver came to
 * have one recorded run, and that run a fabrication.
 */
const USE_TRACK = flag("track");

if (!PROFILE_NAMES.includes(PROFILE)) {
  console.error(`unknown profile '${PROFILE}'. One of: ${PROFILE_NAMES.join(", ")}`);
  process.exit(1);
}

// ── reporting ────────────────────────────────────────────────────────────────

interface Check {
  ok: boolean;
  label: string;
  detail: string;
  /** A soft check records information without failing the run. */
  soft?: boolean;
}

const checks: Check[] = [];

function expect(ok: boolean, label: string, detail: string, soft = false): void {
  checks.push({ ok, label, detail, soft });
  const tag = ok ? "  ok  " : soft ? " note " : " FAIL ";
  console.log(`[${tag}] ${label.padEnd(38)} ${detail}`);
}

function section(name: string): void {
  console.log(`\n${name}\n${"─".repeat(name.length)}`);
}

// ── test material ────────────────────────────────────────────────────────────

/**
 * Reference photographs. The real generated keyframe is used when present because
 * it is genuine input; the rest are synthesised with ffmpeg so the script needs no
 * fixtures committed to the repository.
 */
async function buildUploads(): Promise<{ bytes: Buffer; mime: string; name: string }[]> {
  ensureDirs();
  const dir = path.join(PATHS.tmp, "verify-inputs");
  fs.mkdirSync(dir, { recursive: true });

  const out: { bytes: Buffer; mime: string; name: string }[] = [];

  const real = path.join(PATHS.workspace, "reference", "keyframe-probe-0.jpg");
  if (fs.existsSync(real)) {
    out.push({ bytes: fs.readFileSync(real), mime: "image/jpeg", name: "reference.jpg" });
  }

  // Two synthetic frames with real structure: a gradient plus a subject-shaped
  // block, so sharpness and palette measurement have something to measure.
  const recipes: { name: string; filter: string }[] = [
    {
      name: "synthetic-warm.jpg",
      filter:
        "gradients=s=900x1600:c0=0xE8A44C:c1=0x2A1A3A:x0=0:y0=0:x1=900:y1=1600:d=1," +
        "drawbox=x=320:y=880:w=260:h=560:color=0x1A1218@0.85:t=fill," +
        "gblur=sigma=2",
    },
    {
      name: "synthetic-cool.jpg",
      filter:
        "gradients=s=900x1600:c0=0x2E5A6E:c1=0x0B0E14:x0=0:y0=1600:x1=900:y1=0:d=1," +
        "drawbox=x=280:y=760:w=340:h=700:color=0xD8CFC0@0.8:t=fill," +
        "noise=alls=8:allf=t+u",
    },
  ];

  for (const r of recipes) {
    const file = path.join(dir, r.name);
    await ffmpeg(
      ["-y", "-f", "lavfi", "-i", `${r.filter}`, "-frames:v", "1", "-q:v", "3", file],
      { timeoutMs: 60_000 },
    );
    out.push({ bytes: fs.readFileSync(file), mime: "image/jpeg", name: r.name });
  }

  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`MUSE end-to-end verification\n============================`);
  console.log(
    `profile=${PROFILE} preset=${PRESET} driver=${USE_AGENT ? "agent" : "pipeline"}` +
      ` music=${USE_TRACK ? "uploaded track" : "generated score"}`,
  );

  const startBudget = budget();
  console.log(
    `budget before: $${startBudget.spentUsd.toFixed(4)} spent, $${startBudget.remainingUsd.toFixed(4)} left`,
  );

  registerPipelineHandlers();
  // The agent handler registers itself asynchronously; import it directly so it
  // is definitely present before the job is scheduled.
  const { registerAgentHandler } = await import("../src/lib/agent/loop");
  registerAgentHandler();
  await new Promise((r) => setTimeout(r, 50));

  // ── setup ──────────────────────────────────────────────────────────────────
  section("setup");
  const uploads = await buildUploads();
  expect(uploads.length >= 2, "test photographs", `${uploads.length} prepared`);

  const project = Projects.create({
    mode: USE_TRACK ? "uploaded" : "generated",
    preset: PRESET,
    profile: PROFILE,
    brief: "the summer we drove to the coast and everything felt endless",
    title: "Verification run",
  });
  Projects.patch(project.id, { consent: 1 });
  console.log(`         project ${project.id}`);

  for (const u of uploads) {
    putBytes({
      projectId: project.id,
      type: "upload_image",
      bytes: u.bytes,
      mime: u.mime,
      name: u.name,
    });
  }
  expect(
    Assets.byProject(project.id, "upload_image").length === uploads.length,
    "uploads registered",
    `${Assets.byProject(project.id, "upload_image").length} images`,
  );

  // A track the run did not compose itself, so "used the uploaded audio" can be told apart
  // from "used the score it generated".
  let trackPath: string | null = null;
  if (USE_TRACK) {
    trackPath = path.join(PATHS.assets, project.id, "verification-track.mp3");
    fs.mkdirSync(path.dirname(trackPath), { recursive: true });
    await ffmpeg([
      "-f", "lavfi", "-i", `sine=frequency=55:duration=${OUTPUT.durationS}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${OUTPUT.durationS}`,
      "-filter_complex",
      "[0:a]tremolo=f=2:d=0.9[k];[1:a]volume=0.15[m];[k][m]amix=inputs=2:duration=first,alimiter=limit=0.9",
      "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", trackPath,
    ]);
    putBytes({
      projectId: project.id,
      type: "upload_audio",
      role: "source_track",
      bytes: fs.readFileSync(trackPath),
      mime: "audio/mpeg",
      name: "verification-track.mp3",
    });
    expect(
      Assets.byProject(project.id, "upload_audio").length === 1,
      "uploaded track registered",
      path.basename(trackPath),
    );
  }

  // ── run ────────────────────────────────────────────────────────────────────
  section("run");
  const began = Date.now();
  const kind = USE_AGENT ? "agent" : "pipeline";
  const started = start(
    project.id,
    kind,
    USE_AGENT ? { goal: "Direct this project end to end and export a finished reel." } : {},
  );
  expect(started.started, "job scheduled", `${kind} job ${started.jobId}`);

  await wait(project.id);
  await drain();
  const elapsedMs = Date.now() - began;
  console.log(`         wall clock ${(elapsedMs / 1000).toFixed(1)}s`);

  const after = Projects.require(project.id);
  expect(
    after.status === "READY",
    "project reached READY",
    `status=${after.status}${after.error ? ` error=${after.error}` : ""}`,
  );

  // ── plan ───────────────────────────────────────────────────────────────────
  section("plan");
  const active = Specs.active(project.id);
  if (!active) {
    expect(false, "director produced a plan", "no active spec");
    report();
    return;
  }
  const spec = active.spec;
  expect(true, "plan version", `v${active.version} "${spec.title}"`);
  expect(
    spec.scenes.length >= LIMITS.minScenes && spec.scenes.length <= LIMITS.maxScenes,
    "scene count in band",
    `${spec.scenes.length} scenes (${LIMITS.minScenes}-${LIMITS.maxScenes})`,
  );
  expect(
    spec.scenes.filter((s) => s.purpose === "hero_drop").length === 1,
    "exactly one hero scene",
    spec.scenes.find((s) => s.purpose === "hero_drop")?.id ?? "none",
  );

  // Contiguity: the whole reason cuts can be trusted to land where planned.
  let contiguous = Math.abs(spec.scenes[0].start_s) < 0.002;
  for (let i = 1; i < spec.scenes.length; i++) {
    if (Math.abs(spec.scenes[i].start_s - spec.scenes[i - 1].end_s) > 0.002) contiguous = false;
  }
  expect(contiguous, "scenes contiguous, no gaps", `0 to ${spec.duration_s}s`);
  expect(
    spec.events.some((e) => e.kind === "drop") && spec.events.some((e) => e.kind === "final_hit"),
    "timeline has drop and final hit",
    spec.events.map((e) => `${e.kind}@${e.t}`).join(" "),
  );

  // ── assets ─────────────────────────────────────────────────────────────────
  section("assets");
  const missingKeyframes = spec.scenes.filter((s) => !Assets.byRole(project.id, s.id, "keyframe"));
  expect(
    missingKeyframes.length === 0,
    "every scene has a keyframe",
    missingKeyframes.length === 0 ? `${spec.scenes.length}/${spec.scenes.length}` : `missing ${missingKeyframes.map((s) => s.id).join(", ")}`,
  );

  const clips = spec.scenes.map((s) => ({ scene: s, clip: Assets.byRole(project.id, s.id, "scene_video") }));
  const missingClips = clips.filter((c) => !c.clip);
  expect(
    missingClips.length === 0,
    "every scene has a clip",
    missingClips.length === 0 ? `${clips.length}/${clips.length}` : `missing ${missingClips.map((c) => c.scene.id).join(", ")}`,
  );

  for (const { scene, clip } of clips) {
    if (!clip) continue;
    const info = await probeMedia(clip.uri);
    const meta = Assets.meta<{ route?: string; generated?: boolean }>(clip);
    const wantS = round(scene.end_s - scene.start_s + (spec.scenes[0].id === scene.id ? 0 : 0), 3);
    expect(
      info.width === OUTPUT.width && info.height === OUTPUT.height,
      `  ${scene.id} dimensions`,
      `${info.width}x${info.height} · ${info.durationS.toFixed(2)}s · ${meta.route ?? "?"}${meta.generated ? " · generated" : ""}`,
    );
    expect(
      !info.hasAudio,
      `  ${scene.id} has no audio track`,
      info.hasAudio ? "carries audio, which the composer would double-mix" : "clean",
    );
    expect(info.durationS >= wantS - 0.06, `  ${scene.id} covers its window`, `needs ${wantS.toFixed(2)}s, has ${info.durationS.toFixed(2)}s`, true);
  }

  const score = Assets.byProject(project.id, "music").slice(-1)[0];
  if (score) {
    const info = await probeMedia(score.uri);
    const meta = Assets.meta<{ route?: string; bpm?: number; snapped?: number; unmatched?: string[] }>(score);
    expect(
      info.durationS >= spec.duration_s - 0.5,
      "score covers the reel",
      `${info.durationS.toFixed(2)}s via ${meta.route ?? "?"} at ${meta.bpm ?? "?"} BPM`,
    );
    expect(
      true,
      "beats reconciled",
      `${meta.snapped ?? 0} snapped${(meta.unmatched ?? []).length > 0 ? `, unmatched: ${(meta.unmatched ?? []).join("/")}` : ", none missing"}`,
      true,
    );
  } else if (USE_TRACK) {
    // Nothing generated a score because the run was given one. That is the mode working, not a
    // missing asset, and the uploaded track is checked against the manifest further down.
    expect(
      Assets.byProject(project.id, "upload_audio").length === 1,
      "no generated score, as expected for an uploaded track",
      "the supplied file is the score",
    );
  } else {
    expect(false, "score produced", "no music asset");
  }

  // ── quality control ────────────────────────────────────────────────────────
  section("quality control");
  const qc = Qc.byProject(project.id);
  expect(qc.length > 0, "critic ran", `${qc.length} verdict(s)`);
  const byDecision = qc.reduce<Record<string, number>>((acc, r) => {
    acc[r.decision] = (acc[r.decision] ?? 0) + 1;
    return acc;
  }, {});
  expect(
    true,
    "verdicts",
    Object.entries(byDecision).map(([k, v]) => `${k}=${v}`).join(" ") || "none",
    true,
  );

  // ── the reel ───────────────────────────────────────────────────────────────
  section("the reel");
  const reel = Assets.byRole(project.id, "final", "reel");
  if (!reel) {
    expect(false, "reel exported", "no reel asset");
    report();
    return;
  }
  expect(fs.existsSync(reel.uri), "reel file on disk", path.basename(reel.uri));

  const check = await checkReel(reel.uri, {
    durationS: spec.duration_s,
    width: OUTPUT.width,
    height: OUTPUT.height,
  });
  expect(check.width === OUTPUT.width && check.height === OUTPUT.height, "vertical 1080x1920", `${check.width}x${check.height}`);
  expect(
    Math.abs(check.durationS - spec.duration_s) <= 0.4,
    "duration matches the plan",
    `${check.durationS.toFixed(2)}s vs planned ${spec.duration_s.toFixed(2)}s`,
  );
  expect(check.hasAudio, "reel has audio", `${check.audioDurationS.toFixed(2)}s`);

  expect(
    check.audioDurationS >= check.durationS - 0.6,
    "audio covers the picture",
    `${check.audioDurationS.toFixed(2)}s audio vs ${check.durationS.toFixed(2)}s video`,
  );
  expect(check.blackFrames === 0, "no black holes in the timeline", check.blackFrames === 0 ? "clean" : `${check.blackFrames} frames`);
  expect(check.ok, "all reel checks passed", check.issues.length === 0 ? "clean" : check.issues.join("; "));

  const poster = Assets.byRole(project.id, "final", "poster");
  expect(Boolean(poster), "poster frame extracted", poster ? path.basename(poster.uri) : "absent", true);

  // ── cut placement ──────────────────────────────────────────────────────────
  section("cut placement");
  const render = Renders.latestDone(project.id);
  if (render) {
    const manifest = JSON.parse(render.manifest_json) as RenderManifest;
    const issues = validateManifest(manifest);
    expect(issues.length === 0, "manifest self-consistent", issues.length === 0 ? "clean" : issues.join("; "));

    // The whole point of the uploaded path: the reel is cut against the file that was handed
    // in, not against a score the run wrote for itself.
    if (USE_TRACK) {
      const uploaded = Assets.byProject(project.id, "upload_audio")[0];
      const used = String(manifest.audio?.path ?? "");
      expect(
        Boolean(uploaded) && path.basename(used) === path.basename(uploaded.uri),
        "reel used the uploaded track",
        path.basename(used) || "none",
      );
      expect(
        manifest.audio?.fromFallback !== true,
        "uploaded track survived without a fallback",
        `fromFallback=${manifest.audio?.fromFallback}`,
      );
    }
    expect(
      manifest.clips.length === spec.scenes.length,
      "manifest covers every scene",
      `${manifest.clips.length}/${spec.scenes.length}`,
    );

    // How close is each real cut to a measured musical anchor? This is the claim
    // the whole product rests on, so it is measured on the manifest's own cut
    // points rather than on the plan's, because the composer snaps them.
    const anchors = manifest.anchorsS;
    if (anchors.length > 0) {
      const cuts = manifest.clips.slice(1).map((c) => c.startS);
      const deltas = cuts.map((c) => Math.min(...anchors.map((a) => Math.abs(a - c))));

      // A cut can only land on a beat if there is a beat to land on. In a sparse
      // intro the music may genuinely offer none within reach, and leaving that cut
      // where the Director put it is correct. So the claim under test is "every cut
      // that had a beat available is on it", not "every cut is near a beat".
      const reachable = deltas.filter((d) => d <= SNAP_TOLERANCE_S);
      const unreachable = deltas.length - reachable.length;
      const worst = reachable.length > 0 ? Math.max(...reachable) : 0;
      const mean =
        reachable.length > 0 ? reachable.reduce((a, b) => a + b, 0) / reachable.length : 0;

      expect(
        worst <= 0.05,
        "cuts land on the beats that exist",
        `${reachable.length}/${cuts.length} cuts had a beat in reach; mean ${(mean * 1000).toFixed(0)}ms, worst ${(worst * 1000).toFixed(0)}ms off`,
      );
      if (unreachable > 0) {
        expect(
          true,
          "cuts with no beat in reach",
          `${unreachable} left where the Director placed them`,
          true,
        );
      }
      const snapped = manifest.templateVersions.cutsSnapped;
      expect(
        true,
        "cuts moved onto accents",
        `${String(snapped ?? 0)} of ${cuts.length}, largest shift ${String(manifest.templateVersions.maxCutShiftMs ?? 0)}ms`,
        true,
      );
    } else {
      expect(false, "anchors recorded", "manifest carries no anchors", true);
    }

    expect(
      typeof manifest.templateVersions.bundle === "string",
      "template versions recorded",
      String(manifest.templateVersions.bundle),
      true,
    );
    const fallbackClips = manifest.clips.filter((c) => c.fromFallback).length;
    expect(true, "clips from the local engine", `${fallbackClips}/${manifest.clips.length}`, true);
  } else {
    expect(false, "render recorded", "no completed render row");
  }

  // ── spend ──────────────────────────────────────────────────────────────────
  section("spend");
  const spent = round(Ledger.projectUsd(project.id), 6);
  if (PROFILE === "local") {
    expect(spent === 0, "local profile spent nothing", `$${spent.toFixed(6)}`);
  } else {
    expect(spent >= 0, "spend recorded", `$${spent.toFixed(4)} on this project`);
  }
  const endBudget = budget();
  expect(
    endBudget.remainingUsd >= 0,
    "budget ceiling respected",
    `$${endBudget.spentUsd.toFixed(4)} of $${endBudget.ceilingUsd.toFixed(2)}`,
  );

  const events = replay(project.id);
  expect(events.length > 0, "progress events emitted", `${events.length} events`, true);

  console.log(`\n         reel: ${reel.uri}`);
  console.log(`         open: http://localhost:3939/studio/${project.id}`);

  if (!KEEP) {
    purgeProjectAssets(project.id);
    Projects.delete(project.id);
    console.log(`         cleaned up (pass --keep to inspect it in the studio)`);
  }

  report();
}

function report(): void {
  const hard = checks.filter((c) => !c.soft);
  const failed = hard.filter((c) => !c.ok);
  console.log(
    `\n${failed.length === 0 ? "PASS" : "FAIL"} — ${hard.length - failed.length}/${hard.length} checks passed` +
      (failed.length > 0 ? `\n\nfailures:\n${failed.map((f) => `  - ${f.label}: ${f.detail}`).join("\n")}` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("\nverification crashed:", e);
  process.exit(1);
});
