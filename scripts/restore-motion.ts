/**
 * Give the deterministic shots their generated motion back, once the provider will allow it.
 *
 * Three shots of the committed film animate locally rather than through Veo, not because the
 * plan wanted stills but because the video quota was spent when they were made. Nothing about
 * that is permanent, and nothing tells us when it lifts: there is no usage endpoint to ask,
 * and a daily cap and a tier ceiling both answer 429.
 *
 * So this asks. A refusal costs nothing, which is what makes it safe to run on a schedule —
 * the expensive path only opens once the answer changes. When it does, the three scenes are
 * re-rendered from keyframes that are already cached, so the bill is the video and nothing
 * else.
 *
 *   npx tsx scripts/restore-motion.ts [--scenes s02,s05,s06] [--dry]
 */
import { config as loadEnv } from "./load-env";

loadEnv();

import { generateVideo } from "../src/lib/models/adapters";
import { MuseError } from "../src/lib/core/util";
import { Assets, Specs } from "../src/lib/db/repo";
import { GENERATIVE_MODES, shotSize } from "../src/lib/spec/directorSpec";

const PROJECT = process.env.MUSE_RESTORE_PROJECT ?? "prj_v0b74ybbt2ki";
const BASE = process.env.MUSE_BASE_URL ?? "http://localhost:3939";
const dry = process.argv.includes("--dry");

const scenesArg = process.argv.find((a) => a.startsWith("--scenes="));

/** A single 1x1 PNG, so the probe carries a legal image without reading the project. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The scenes that would gain something from a generated take.
 *
 * This used to be a hardcoded list, which went stale the first time one of those scenes was
 * given motion by other means: re-rendering it would have handed back a fresh clip carrying the
 * paper margin that had just been cropped out of it. A list of scene ids is a claim about the
 * current state of the film, so it is read from the film rather than remembered.
 *
 * A scene qualifies when its current take has no generated motion and its render mode asks for
 * some. Detail shots are excluded because the animation budget never allots them any — asking
 * would spend a QC call to be told what the plan already says.
 */
function scenesWantingMotion(projectId: string): string[] {
  const active = Specs.active(projectId);
  if (!active) return [];
  return active.spec.scenes
    .filter((scene) => {
      if (!GENERATIVE_MODES.includes(scene.render_mode)) return false;
      if (shotSize(scene) === "detail") return false;
      const take = Assets.byRole(projectId, scene.id, "scene_video");
      if (!take) return true;
      return !Assets.meta<{ generated?: boolean }>(take).generated;
    })
    .map((scene) => scene.id);
}

function isQuotaRefusal(e: unknown): boolean {
  return e instanceof MuseError && (e.detail as { status?: number } | undefined)?.status === 429;
}

/**
 * Ask for the shortest clip the API accepts.
 *
 * A refusal is free, so the cost of being wrong about the timing is nothing. A success is not
 * free — it is a real four second generation whose output is thrown away — but it happens once,
 * on the run that goes on to do the work.
 */
async function videoIsAvailable(): Promise<{ ok: boolean; why: string }> {
  try {
    await generateVideo({
      model: "veo-3.1-lite-generate-preview",
      prompt: "A still grey field, barely moving. No text.",
      seconds: 4,
      aspectRatio: "9:16",
      resolution: "720p",
      image: { bytes: PIXEL, mime: "image/png" },
      timeoutMs: 300_000,
    });
    return { ok: true, why: "the provider accepted a generation" };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (isQuotaRefusal(e)) return { ok: false, why: "quota still spent" };
    // Anything else is a real fault and worth surfacing rather than reporting as "not yet".
    return { ok: false, why: `unexpected: ${why.slice(0, 160)}` };
  }
}

async function main(): Promise<void> {
  const scenes = scenesArg ? scenesArg.split("=")[1].split(",").filter(Boolean) : scenesWantingMotion(PROJECT);
  if (scenes.length === 0) {
    console.log("  every shot that can carry generated motion already has it; nothing to do");
    return;
  }

  console.log(`  shots that would gain generated motion: ${scenes.join(", ")}`);

  const probe = await videoIsAvailable();
  if (!probe.ok) {
    console.log(`  video unavailable — ${probe.why}; nothing done`);
    return;
  }

  console.log(`  video is available — ${probe.why}`);
  if (dry) {
    console.log(`  dry run; would re-render ${scenes.join(", ")} of ${PROJECT}`);
    return;
  }

  const res = await fetch(`${BASE}/api/projects/${PROJECT}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenes }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    started?: boolean;
    jobId?: string;
    error?: string;
  };

  if (!res.ok || !body.started) {
    // The dev server not being up is the likeliest reason, and it is worth saying plainly
    // rather than leaving a schedule that reports success while doing nothing.
    console.error(`  could not start the re-render: ${body.error ?? `${res.status} from ${BASE}`}`);
    process.exitCode = 1;
    return;
  }

  console.log(`  re-rendering ${scenes.join(", ")} as ${body.jobId}`);
}

// Not a top-level await: these scripts transpile to CommonJS, which does not allow one.
void main();
