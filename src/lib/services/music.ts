/**
 * Music service. Produces the soundtrack and, more importantly, produces the
 * reconciled timeline the composer cuts on.
 *
 * The distinction matters: a generative music model treats requested timestamps
 * as intent, not instruction. So the returned audio is always decoded and
 * measured, its real accents are matched against the Director's planned events,
 * and the composer snaps cuts to what the waveform actually does. Where a
 * requested beat is genuinely absent, a deterministic accent is added at mix time
 * rather than burning another generation on it.
 */
import fs from "node:fs";
import path from "node:path";
import { LIMITS, type Profile } from "@/lib/core/config";
import { projectDir } from "@/lib/core/paths";
import { round, sha256 } from "@/lib/core/util";
import { logger, type Logger } from "@/lib/core/logger";
import type { DirectorSpec } from "@/lib/spec/directorSpec";
import { generateMusic } from "@/lib/models/adapters";
import { mediaCodec, route } from "@/lib/models/router";
import { getBundle } from "@/lib/templates/bundles";
import { bundleVersionString } from "@/lib/templates/types";
import { planMusic } from "@/lib/music/planner";
import { analyzeFile } from "@/lib/music/analyze";
import { reconcile } from "@/lib/music/reconcile";
import { synthesizeScore } from "@/lib/music/synth";
import type { ActualMusicMap, PlannedMusicMap, Reconciliation } from "@/lib/music/types";
import { Assets, MusicJobs } from "@/lib/db/repo";
import { registerFile, urlFor } from "./assets";
import type { AssetRow } from "@/lib/db/types";
import { hashJson } from "@/lib/core/util";

export interface MusicOutcome {
  asset: AssetRow;
  planned: PlannedMusicMap;
  actual: ActualMusicMap;
  reconciliation: Reconciliation;
  route: string;
  usd: number;
  cached: boolean;
  fallbackReason?: string;
  /** True when the score came from the local synthesiser. */
  fromFallback: boolean;
  brief: string;
}

/**
 * Produce and reconcile the soundtrack for a project.
 *
 * In uploaded mode the user's track is analysed as-is and no generation happens.
 * In generated mode Lyria is asked for the brief, and the local synthesiser
 * answers whenever it cannot be.
 */
export async function produceMusic(input: {
  projectId: string;
  spec: DirectorSpec;
  specVersion: number;
  profile: Profile;
  /** The user's uploaded track, for bring-your-own-song mode. */
  uploadedAudio?: AssetRow | null;
  deadlineAt?: number;
  log?: Logger;
}): Promise<MusicOutcome> {
  const log = (input.log ?? logger({ project_id: input.projectId })).child({ model: "music" });
  const bundle = getBundle(input.spec.style_bible.preset);
  const { planned, brief } = planMusic(input.spec);

  // Bring your own song: nothing to generate, everything to measure.
  if (input.spec.music.mode === "uploaded" && input.uploadedAudio) {
    const actual = await analyzeFile(input.uploadedAudio.uri);
    const rec = reconcile(planned, actual);
    log.info("analysed uploaded track", {
      bpm: actual.bpm,
      anchors: actual.anchors.length,
      snapped: rec.snappedEvents.filter((e) => e.snapped).length,
    });
    recordMusicJob({
      projectId: input.projectId,
      specVersion: input.specVersion,
      modelRoute: "upload",
      planned,
      actual,
      assetId: input.uploadedAudio.id,
      status: "done",
    });
    return {
      asset: input.uploadedAudio,
      planned,
      actual,
      reconciliation: rec,
      route: "upload",
      usd: 0,
      cached: true,
      fromFallback: false,
      brief,
    };
  }

  const outDir = projectDir(input.projectId);
  const localPath = path.join(outDir, `score-v${input.specVersion}.wav`);

  // The synthesiser reports the anchors it deliberately placed, which are exact
  // by construction. Keeping them lets the local path skip re-detecting what it
  // already knows, while still going through the same reconciliation step.
  // Held in an object because it is written inside the router callback, which
  // control-flow analysis cannot see through.
  const synthesised: { map: ActualMusicMap | null } = { map: null };

  const result = await route<{ bytes: Buffer; mime: string }>({
    task: "music",
    projectId: input.projectId,
    identity: { brief, duration: input.spec.duration_s, bpm: planned.bpm, key: planned.key },
    cacheVersion: bundleVersionString(bundle),
    hint: { clips: 1, inputTokens: 200 },
    codec: mediaCodec<{ bytes: Buffer; mime: string }>(),
    profile: input.profile,
    deadlineAt: input.deadlineAt,
    logger: log,
    real: async (model) =>
      generateMusic({ model, prompt: brief, timeoutMs: LIMITS.timeoutMs.music }),
    local: async (reason) => {
      log.info("synthesising the score locally", { reason: reason.slice(0, 120) });
      const synth = synthesizeScore(input.spec, seedForProject(input.projectId));
      synthesised.map = {
        durationS: synth.durationS,
        bpm: synth.bpm,
        sampleRate: synth.sampleRate,
        anchors: synth.anchors,
        energy: synth.energy,
        peakRegionS: peakRegionFrom(synth.energy),
        // The local synthesiser writes with headroom by construction, so nothing to trim.
        peak: 0.89,
        measured: true,
      };
      return { bytes: synth.wav, mime: "audio/wav" };
    },
  });

  const fromFallback = result.route === "local";
  const ext = result.value.mime.includes("wav") ? "wav" : result.value.mime.includes("mpeg") ? "mp3" : "m4a";
  const finalPath = fromFallback ? localPath : path.join(outDir, `score-v${input.specVersion}.${ext}`);
  fs.writeFileSync(finalPath, result.value.bytes);

  // Always measure the file that will actually be mixed, even on the local path,
  // so the reconciliation reflects the real waveform rather than a plan.
  let actual: ActualMusicMap;
  try {
    actual = await analyzeFile(finalPath);
    const known = synthesised.map;
    if (known) {
      // The synthesiser's own anchors are exact; merge them in ahead of detected
      // ones so snapping prefers a known beat over an estimated onset.
      actual = {
        ...actual,
        anchors: mergeAnchors(known.anchors, actual.anchors),
        bpm: known.bpm,
      };
    }
  } catch (e) {
    log.warn("audio analysis failed; falling back to the planned structure", { error: String(e) });
    actual =
      synthesised.map ??
      ({
        durationS: input.spec.duration_s,
        bpm: planned.bpm,
        sampleRate: 44100,
        anchors: planned.events.map((e) => ({
          t: e.t,
          kind: e.kind === "drop" ? ("drop" as const) : ("accent" as const),
          strength: e.intensity,
        })),
        energy: [],
        peakRegionS: null,
        // Unmeasured, so assume the worst and let the bed be trimmed rather than clipped.
        peak: 1,
        measured: false,
      } satisfies ActualMusicMap);
  }

  const rec = reconcile(planned, actual);

  const asset = registerFile({
    projectId: input.projectId,
    type: "music",
    role: "score",
    filePath: finalPath,
    mime: result.value.mime,
    metadata: {
      specVersion: input.specVersion,
      route: result.route,
      fromFallback,
      bpm: actual.bpm,
      durationS: actual.durationS,
      anchors: actual.anchors.length,
      brief,
      snapped: rec.snappedEvents.filter((e) => e.snapped).length,
      unmatched: rec.unmatched,
      maxDeltaS: rec.maxDeltaS,
    },
  });

  recordMusicJob({
    projectId: input.projectId,
    specVersion: input.specVersion,
    modelRoute: result.route,
    planned,
    actual,
    assetId: asset.id,
    status: fromFallback ? "fallback" : "done",
    fallbackReason: result.fallbackReason,
  });

  log.info("score ready", {
    route: result.route,
    bpm: actual.bpm,
    durationS: actual.durationS,
    snapped: rec.snappedEvents.filter((e) => e.snapped).length,
    unmatched: rec.unmatched,
    maxDeltaS: rec.maxDeltaS,
  });

  return {
    asset,
    planned,
    actual,
    reconciliation: rec,
    route: result.route,
    usd: result.usd,
    cached: result.cached,
    fallbackReason: result.fallbackReason,
    fromFallback,
    brief,
  };
}

/**
 * Decide whether a returned score is worth one regeneration. Only a missing drop
 * justifies it: everything else the composer can fix at mix time for free.
 */
export function shouldRegenerate(rec: Reconciliation, attempt: number): boolean {
  if (attempt >= 1) return false;
  return rec.unmatched.includes("drop");
}

function mergeAnchors(
  authoritative: ActualMusicMap["anchors"],
  detected: ActualMusicMap["anchors"],
): ActualMusicMap["anchors"] {
  const out = [...authoritative];
  for (const d of detected) {
    // Drop a detected onset that duplicates a known beat.
    if (!out.some((a) => Math.abs(a.t - d.t) < 0.04)) out.push(d);
  }
  return out.sort((a, b) => a.t - b.t);
}

function peakRegionFrom(energy: { t: number; v: number }[]): [number, number] | null {
  if (energy.length < 4) return null;
  const window = Math.max(2, Math.round(energy.length * 0.06));
  let bestStart = 0;
  let best = -1;
  for (let i = 0; i + window <= energy.length; i++) {
    let sum = 0;
    for (let k = i; k < i + window; k++) sum += energy[k].v;
    const mean = sum / window;
    if (mean > best) {
      best = mean;
      bestStart = i;
    }
  }
  return [round(energy[bestStart].t, 3), round(energy[bestStart + window - 1].t, 3)];
}

function seedForProject(projectId: string): number {
  return parseInt(sha256(projectId).slice(0, 8), 16) >>> 0;
}

function recordMusicJob(input: {
  projectId: string;
  specVersion: number;
  modelRoute: string;
  planned: PlannedMusicMap;
  actual: ActualMusicMap;
  assetId: string;
  status: "done" | "fallback";
  fallbackReason?: string;
}): void {
  const requestHash = hashJson({
    projectId: input.projectId,
    specVersion: input.specVersion,
    brief: input.planned.brief,
  });
  const { job } = MusicJobs.claim({
    projectId: input.projectId,
    specVersion: input.specVersion,
    modelRoute: input.modelRoute,
    requestHash,
    plannedMap: input.planned,
  });
  MusicJobs.update(job.id, {
    status: input.status,
    // Energy envelopes are long; store a decimated copy so the row stays small
    // while the diagnostics panel still has a usable waveform.
    actual_map: JSON.stringify({
      ...input.actual,
      energy: input.actual.energy.filter((_, i) => i % 2 === 0),
    }),
    output_asset_id: input.assetId,
    fallback_reason: input.fallbackReason ?? null,
    finished_at: new Date().toISOString(),
    model_route: input.modelRoute,
  });
}

/** The current score for a project, if one exists. */
export function currentScore(projectId: string): AssetRow | null {
  const rows = Assets.byProject(projectId, "music");
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

export function scoreUrl(projectId: string): string | null {
  const row = currentScore(projectId);
  return row ? urlFor(row) : null;
}
