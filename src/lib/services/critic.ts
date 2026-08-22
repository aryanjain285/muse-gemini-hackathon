/**
 * Critic service. Scores a rendered scene and returns a decision plus one
 * concrete repair instruction, so failures are acted on rather than described.
 *
 * The Gemini path looks at real frames sampled from the clip. The local path is
 * not a rubber stamp: it measures duration accuracy, black frames, whether the
 * clip actually moves, edge sharpness and how much of the subject-safe region is
 * occupied. Those catch the failure modes that ruin a reel — a frozen clip, a
 * black hole in the timeline, a badly cropped subject — without any model call.
 */
import fs from "node:fs";
import path from "node:path";
import { LIMITS, OUTPUT, type Profile } from "@/lib/core/config";
import { tmpDir } from "@/lib/core/paths";
import { clamp, round, truncate } from "@/lib/core/util";
import { logger, type Logger } from "@/lib/core/logger";
import { expectsSubject, shotSize, type DirectorSpec, type Scene } from "@/lib/spec/directorSpec";
import { generateJson, inlinePart } from "@/lib/models/adapters";
import { jsonCodec, route } from "@/lib/models/router";
import { getBundle } from "@/lib/templates/bundles";
import { bundleVersionString } from "@/lib/templates/types";
import { criticPrompt } from "@/lib/templates/prompts";
import { sha256 } from "@/lib/core/util";
import { ffmpeg, probeMedia } from "@/lib/compose/ffmpeg";
import { Qc } from "@/lib/db/repo";
import type { AssetRow } from "@/lib/db/types";

export const CRITIC_VERSION = "critic-1.0";

export interface QcScores {
  identity: number;
  continuity: number;
  motion: number;
  adherence: number;
  composition: number;
}

export type QcDecision = "PASS" | "RETRY" | "FALLBACK";

export interface QcVerdict {
  scores: QcScores;
  decision: QcDecision;
  repairInstruction: string;
  source: "gemini" | "heuristic";
  route: string;
  usd: number;
  /** Objective measurements, recorded even when a model made the decision. */
  measurements: Measurements;
}

/** Score thresholds. Below `retry` a scene is regenerated; below `fallback` it is replaced. */
const THRESHOLD = {
  retry: 0.55,
  fallback: 0.3,
  /** A scene must clear this overall to pass without comment. */
  pass: 0.62,
} as const;

/**
 * What kind of movement a shot was asked for.
 *
 * Every shot used to be judged against one motion floor, which is wrong in both
 * directions: a generated shot where the world should move got the same pass mark as a
 * slow push on a still, and an insert on a static object was marked down for being an
 * insert on a static object. The rubric has to know what was asked of the shot.
 */
export type MotionExpectation = "semantic_motion" | "camera_motion" | "editorial_motion" | "held";

/**
 * Motion score below which a clip counts as frozen rather than slow, per expectation.
 *
 * A deterministic push registers far less measured movement than a generated shot where
 * hair and water move, so holding both to the generated floor produced retries on clips
 * that were doing exactly what was asked. A held shot has no floor at all.
 */
const FROZEN_MOTION: Record<MotionExpectation, number> = {
  semantic_motion: 0.34,
  camera_motion: 0.2,
  editorial_motion: 0.16,
  held: 0,
};

/**
 * What this shot was asked to do.
 *
 * `generated` wins over the declared mode, because routing can upgrade a still shot to a
 * real one after the plan was written, and the finished clip is what gets judged.
 */
export function motionExpectation(scene: Scene, generated: boolean): MotionExpectation {
  if (generated) return "semantic_motion";
  if (shotSize(scene) === "detail") return "held";
  switch (scene.render_mode) {
    case "image_to_video":
    case "text_reference_video":
      return "semantic_motion";
    case "collage":
      return "editorial_motion";
    default:
      return "camera_motion";
  }
}

// ── objective measurement ────────────────────────────────────────────────────

export interface Measurements {
  durationS: number;
  expectedDurationS: number;
  width: number;
  height: number;
  /** Mean absolute frame-to-frame difference, 0..1. Near zero means frozen. */
  motionScore: number;
  /** Mean luma of sampled frames, 0..1. */
  brightness: number;
  /** Fraction of sampled frames that decoded as effectively black. */
  blackFraction: number;
  /** High-frequency energy proxy; low values mean soft or smeared. */
  sharpness: number;
  /** Fraction of visual weight inside the vertical safe region. */
  safeRegionWeight: number;
  frameCount: number;
}

/** Sample frames as raw RGB and measure them. Cheap, deterministic, and real. */
export async function measureClip(
  filePath: string,
  expectedDurationS: number,
  samples = 6,
): Promise<Measurements> {
  const info = await probeMedia(filePath);
  const W = 48;
  const H = 84; // keeps the 9:16 aspect so the safe-region maths stays meaningful

  const res = await ffmpeg(
    [
      "-i", filePath,
      "-vf", `fps=${round(Math.max(1, samples / Math.max(0.2, info.durationS)), 4)},scale=${W}:${H}`,
      "-frames:v", String(samples),
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-",
    ],
    { timeoutMs: 90_000, captureStdout: true },
  );

  const frameBytes = W * H * 3;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + frameBytes <= res.stdout.length; off += frameBytes) {
    frames.push(res.stdout.subarray(off, off + frameBytes));
  }

  if (frames.length === 0) {
    return {
      durationS: info.durationS,
      expectedDurationS,
      width: info.width,
      height: info.height,
      motionScore: 0,
      brightness: 0,
      blackFraction: 1,
      sharpness: 0,
      safeRegionWeight: 0,
      frameCount: 0,
    };
  }

  const luma = (f: Uint8Array, i: number) =>
    (0.2126 * f[i * 3] + 0.7152 * f[i * 3 + 1] + 0.0722 * f[i * 3 + 2]) / 255;

  let brightnessSum = 0;
  let blackFrames = 0;
  let sharpSum = 0;
  let safeSum = 0;
  let totalWeight = 0;

  const safeTop = Math.floor(H * OUTPUT.safeTop);
  const safeBottom = Math.ceil(H * (1 - OUTPUT.safeBottom));

  for (const f of frames) {
    let sum = 0;
    let grad = 0;
    let safe = 0;
    let all = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const l = luma(f, i);
        sum += l;
        // Horizontal gradient as a sharpness proxy: smeared frames lose it.
        if (x > 0) grad += Math.abs(l - luma(f, i - 1));
        // Visual weight = deviation from the frame mean, approximated by luma.
        all += l;
        if (y >= safeTop && y <= safeBottom) safe += l;
      }
    }
    const mean = sum / (W * H);
    brightnessSum += mean;
    if (mean < 0.03) blackFrames++;
    sharpSum += grad / (W * H);
    if (all > 0) {
      safeSum += safe / all;
      totalWeight++;
    }
  }

  // Motion: mean absolute luma difference between consecutive sampled frames.
  let motion = 0;
  for (let k = 1; k < frames.length; k++) {
    let diff = 0;
    for (let i = 0; i < W * H; i++) diff += Math.abs(luma(frames[k], i) - luma(frames[k - 1], i));
    motion += diff / (W * H);
  }
  motion = frames.length > 1 ? motion / (frames.length - 1) : 0;

  return {
    durationS: info.durationS,
    expectedDurationS,
    width: info.width,
    height: info.height,
    // Raw inter-frame difference for a deliberate slow push measures around
    // 0.01, and for a frozen clip around 0.0005. A square-root curve separates
    // those two by a wide margin while still saturating for fast motion; a plain
    // linear scale compressed every real camera move into the bottom third and
    // made the critic reject shots that were moving exactly as intended.
    motionScore: clamp(Math.sqrt(Math.max(0, motion) * 45), 0, 1),
    brightness: round(brightnessSum / frames.length, 4),
    blackFraction: round(blackFrames / frames.length, 4),
    sharpness: clamp(round((sharpSum / frames.length) * 12, 4), 0, 1),
    safeRegionWeight: totalWeight > 0 ? round(safeSum / totalWeight, 4) : 0,
    frameCount: frames.length,
  };
}

/** Turn measurements into scores and a decision, with no model involved. */
export function heuristicVerdict(
  m: Measurements,
  scene: Scene,
  expectation: MotionExpectation,
): { scores: QcScores; decision: QcDecision; repairInstruction: string } {
  const floor = FROZEN_MOTION[expectation];
  const expectMotion = expectation !== "held";
  const notes: string[] = [];

  const durationOk = Math.abs(m.durationS - m.expectedDurationS) <= 0.12;
  if (!durationOk) {
    notes.push(
      `clip is ${m.durationS.toFixed(2)}s but the scene window is ${m.expectedDurationS.toFixed(2)}s`,
    );
  }

  const shapeOk = m.width === OUTPUT.width && m.height === OUTPUT.height;
  if (!shapeOk) notes.push(`clip is ${m.width}x${m.height}, not ${OUTPUT.width}x${OUTPUT.height}`);

  // Motion: a still animated by camera work should still register movement.
  const motion = expectMotion ? m.motionScore : Math.max(m.motionScore, 0.6);
  // Below this the picture is effectively frozen; a deliberate slow push sits
  // comfortably above it under the calibration in measureClip.
  if (expectMotion && m.motionScore < floor) {
    notes.push(
      expectation === "semantic_motion"
        ? "the clip barely moves; the subject and the air around it should be alive"
        : "the clip barely moves; give it a stronger camera move",
    );
  }

  if (m.blackFraction > 0.2) notes.push("frames are decoding black; the source may be broken");
  if (m.brightness < 0.06) notes.push("the shot is far too dark to read on a phone");
  if (m.brightness > 0.94) notes.push("the shot is blown out");
  if (m.sharpness < 0.06) notes.push("the frame is soft or smeared");

  // Vertical safe framing only means something when there is a subject to keep in
  // frame. An establishing landscape legitimately puts most of its weight in the
  // sky, and complaining about that is confidently wrong.
  const wantsSubject = expectsSubject(scene);
  if (wantsSubject && m.safeRegionWeight < 0.55) {
    notes.push("the subject sits outside the vertical safe region; reframe it centre-low");
  }

  const composition = wantsSubject
    ? clamp(
        (shapeOk ? 0.5 : 0.1) +
          0.3 * clamp((m.safeRegionWeight - 0.4) / 0.5, 0, 1) +
          0.2 * clamp(1 - Math.abs(m.brightness - 0.5) * 2, 0, 1),
        0,
        1,
      )
    : clamp(
        (shapeOk ? 0.62 : 0.1) + 0.38 * clamp(1 - Math.abs(m.brightness - 0.5) * 2, 0, 1),
        0,
        1,
      );

  const scores: QcScores = {
    // Identity cannot be judged without a model; report a neutral value rather
    // than inventing confidence, and let the thresholds treat it as non-blocking.
    identity: 0.7,
    continuity: 0.7,
    motion: clamp(motion, 0, 1),
    adherence: clamp(durationOk ? 0.75 : 0.35, 0, 1),
    composition,
  };

  const blocking =
    m.blackFraction > 0.5 || m.frameCount === 0 || m.brightness < 0.02 || !shapeOk;
  const weak =
    !durationOk ||
    (expectMotion && m.motionScore < floor) ||
    m.sharpness < 0.06 ||
    (wantsSubject && m.safeRegionWeight < 0.5);

  const decision: QcDecision = blocking ? "FALLBACK" : weak ? "RETRY" : "PASS";

  return {
    scores,
    decision,
    repairInstruction:
      notes.length > 0
        ? truncate(notes.join("; "), 400)
        : `keep the composition; ${scene.purpose} reads correctly`,
  };
}

// ── frame extraction ─────────────────────────────────────────────────────────

/** Pull representative frames for a multimodal critic: entry, middle, exit. */
async function sampleFrames(
  filePath: string,
  projectId: string,
  sceneId: string,
  durationS: number,
): Promise<{ bytes: Buffer; mime: string }[]> {
  const dir = tmpDir(projectId, "qc");
  const points = [0.08, 0.5, 0.92].map((f) => round(Math.max(0.02, durationS * f), 3));
  const out: { bytes: Buffer; mime: string }[] = [];

  for (const [i, at] of points.entries()) {
    const file = path.join(dir, `${sceneId}-f${i}.jpg`);
    try {
      await ffmpeg(
        [
          "-y",
          "-ss", String(at),
          "-i", filePath,
          "-frames:v", "1",
          "-vf", "scale=540:-2",
          "-q:v", "4",
          file,
        ],
        { timeoutMs: 45_000 },
      );
      if (fs.existsSync(file)) out.push({ bytes: fs.readFileSync(file), mime: "image/jpeg" });
    } catch {
      /* a missing sample frame is not fatal; the critic sees fewer frames */
    }
  }
  return out;
}

// ── routed critic ────────────────────────────────────────────────────────────

interface CriticResponse {
  scores: QcScores;
  decision: QcDecision;
  repair_instruction: string;
}

/**
 * Score one scene. Objective measurement always runs; the model is consulted on
 * top of it, and a model verdict that contradicts a hard measurement is
 * overridden, because the measurement is not an opinion.
 */
export async function critique(input: {
  projectId: string;
  spec: DirectorSpec;
  specVersion: number;
  scene: Scene;
  asset: AssetRow;
  expectedDurationS: number;
  /** What kind of movement this shot was asked for. */
  expectation: MotionExpectation;
  /**
   * True when this clip already came from the deterministic engine. A FALLBACK
   * verdict then has nowhere to go, so the decision is capped at RETRY and the
   * pipeline is spared a pointless re-render of the same thing.
   */
  isFallbackAsset?: boolean;
  /**
   * The photographs this shot was generated from, named, so the identity axis has something
   * to compare against.
   *
   * Without them the critic scored "same person as the reference" having never been shown a
   * reference — so a frame with the wrong faces in it could not be caught, and the retry
   * budget that exists to fix exactly that was never spent on it.
   */
  references?: { bytes: Buffer; mime: string; label: string }[];
  /** How many people belong in the frame. A different number is a defect, not a style. */
  cast?: number;
  profile: Profile;
  deadlineAt?: number;
  log?: Logger;
}): Promise<QcVerdict> {
  const bundle = getBundle(input.spec.style_bible.preset);
  const log = (input.log ?? logger({ project_id: input.projectId })).child({
    scene_id: input.scene.id,
  });

  const measurements = await measureClip(input.asset.uri, input.expectedDurationS).catch((e) => {
    log.warn("clip measurement failed", { error: String(e) });
    return null;
  });

  const local = measurements
    ? heuristicVerdict(measurements, input.scene, input.expectation)
    : {
        scores: { identity: 0.5, continuity: 0.5, motion: 0.5, adherence: 0.5, composition: 0.5 },
        decision: "RETRY" as QcDecision,
        repairInstruction: "the clip could not be measured; regenerate it",
      };

  const fallbackMeasurements: Measurements =
    measurements ?? {
      durationS: 0,
      expectedDurationS: input.expectedDurationS,
      width: 0,
      height: 0,
      motionScore: 0,
      brightness: 0,
      blackFraction: 1,
      sharpness: 0,
      safeRegionWeight: 0,
      frameCount: 0,
    };

  // A clip that fails a hard measurement is not worth a model call.
  if (local.decision === "FALLBACK") {
    return persist(input, {
      ...local,
      source: "heuristic",
      route: "local",
      usd: 0,
      measurements: fallbackMeasurements,
    });
  }

  // Deterministic output is judged by measurement alone, deliberately.
  //
  // The multimodal critic exists to catch generative failure modes: a face that
  // drifted, a duplicated limb, a transformation that never happened, a prompt
  // ignored. None of those apply to the local engine, which does not treat the
  // prompt as an instruction at all — it stylises a photograph or composes from a
  // palette. Asking a model whether it rendered the vintage convertible the plan
  // described therefore scores near zero on adherence every time, truthfully and
  // uselessly: the verdict is real but no retry can act on it, so the run burns
  // its retry budget and its money to learn nothing.
  //
  // What the local engine does control — length, framing, movement, exposure — is
  // measured exactly and for free above.
  if (input.isFallbackAsset) {
    const decision =
      local.decision === "RETRY" &&
      !hasActionableFault(fallbackMeasurements, input.expectation, expectsSubject(input.scene))
      ? "PASS"
      : local.decision;
    return persist(input, {
      ...local,
      decision,
      source: "heuristic",
      route: "local",
      usd: 0,
      measurements: fallbackMeasurements,
    });
  }

  const isVideo = input.asset.type === "scene_video";
  const frames = await sampleFrames(
    input.asset.uri,
    input.projectId,
    input.scene.id,
    Math.max(0.5, fallbackMeasurements.durationS || input.expectedDurationS),
  );

  if (frames.length === 0) {
    return persist(input, {
      ...local,
      source: "heuristic",
      route: "local",
      usd: 0,
      measurements: fallbackMeasurements,
    });
  }

  const references = input.references ?? [];
  const { system, user, schema } = criticPrompt({
    bundle,
    spec: input.spec,
    scene: input.scene,
    isVideo,
    cast: input.cast,
    hasReferences: references.length > 0,
  });

  const measured =
    `Objective measurements already taken: duration ${fallbackMeasurements.durationS.toFixed(2)}s ` +
    `(window ${input.expectedDurationS.toFixed(2)}s), motion ${fallbackMeasurements.motionScore.toFixed(2)}, ` +
    `brightness ${fallbackMeasurements.brightness.toFixed(2)}, sharpness ${fallbackMeasurements.sharpness.toFixed(2)}, ` +
    `subject weight inside the vertical safe region ${fallbackMeasurements.safeRegionWeight.toFixed(2)}. ` +
    `Judge identity, continuity and prompt adherence, which measurement cannot see.`;

  const result = await route<CriticResponse>({
    task: "critic",
    projectId: input.projectId,
    // The references belong in the identity: judging a frame beside the photograph and
    // judging it alone are different judgements, and replaying the second as the first is
    // how a fix gets skipped.
    identity: {
      scene: input.scene.id,
      asset: input.asset.sha256,
      system,
      user,
      refs: references.map((r) => sha256(r.bytes)),
    },
    cacheVersion: `${bundleVersionString(bundle)}:${CRITIC_VERSION}`,
    hint: { inputTokens: 300 + frames.length * 780, outputTokens: 420, thoughtTokens: 260 },
    codec: jsonCodec<CriticResponse>(),
    profile: input.profile,
    deadlineAt: input.deadlineAt,
    logger: log,
    real: async (model) => {
      const out = await generateJson<CriticResponse>({
        model,
        system,
        parts: [
          // The references first and named, then the frames under judgement, so the critic
          // knows which pictures are the truth and which is the thing being checked.
          ...references.flatMap((r) => [
            { text: `Reference photograph — ${r.label}:` },
            inlinePart(r.bytes, r.mime),
          ]),
          ...(references.length > 0
            ? [{ text: `The ${isVideo ? "clip" : "frame"} under judgement follows.` }]
            : []),
          ...frames.map((f) => inlinePart(f.bytes, f.mime)),
          { text: `${user}\n\n${measured}` },
        ],
        schema,
        thinking: "low",
        maxOutputTokens: 1400,
        temperature: 0.2,
        timeoutMs: LIMITS.timeoutMs.critic,
      });
      return { value: out.value, usage: out.usage, modelVersion: out.modelVersion };
    },
    local: async () => ({
      scores: local.scores,
      decision: local.decision,
      repair_instruction: local.repairInstruction,
    }),
  });

  const merged = mergeVerdicts(result.value, local, fallbackMeasurements, input.expectation);
  // A hard local FALLBACK already returned above, so reaching here with a
  // FALLBACK means the model or the score thresholds asked for a replacement the
  // deterministic engine cannot provide, because it produced this clip.
  if (input.isFallbackAsset && merged.decision === "FALLBACK") {
    merged.decision = "RETRY";
  }

  return persist(input, {
    ...merged,
    source: result.route === "local" ? "heuristic" : "gemini",
    route: result.route,
    usd: result.usd,
    measurements: fallbackMeasurements,
  });
}

/**
 * Combine a model verdict with objective measurement. Measurement wins on the
 * things it can actually see, so a model cannot pass a frozen or black clip.
 */
function mergeVerdicts(
  model: CriticResponse,
  local: { scores: QcScores; decision: QcDecision; repairInstruction: string },
  m: Measurements,
  expectation: MotionExpectation,
): { scores: QcScores; decision: QcDecision; repairInstruction: string } {
  const expectMotion = expectation !== "held";
  const safe = (v: unknown, fallback: number) =>
    clamp(typeof v === "number" && Number.isFinite(v) ? v : fallback, 0, 1);

  const scores: QcScores = {
    identity: safe(model.scores?.identity, local.scores.identity),
    continuity: safe(model.scores?.continuity, local.scores.continuity),
    // Motion and composition are measured, so keep the lower of the two views.
    motion: Math.min(safe(model.scores?.motion, local.scores.motion), local.scores.motion + 0.2),
    adherence: safe(model.scores?.adherence, local.scores.adherence),
    composition: Math.min(
      safe(model.scores?.composition, local.scores.composition),
      local.scores.composition + 0.2,
    ),
  };

  const mean =
    (scores.identity + scores.continuity + scores.motion + scores.adherence + scores.composition) / 5;

  let decision: QcDecision =
    model.decision === "PASS" || model.decision === "RETRY" || model.decision === "FALLBACK"
      ? model.decision
      : "RETRY";

  // Measurement overrides opinion on the things it can actually see. The
  // worst-dimension rule deliberately ignores motion: a slow push is a valid
  // shot, and letting a single low motion score force a FALLBACK rejected
  // correctly-composed scenes whose only fault was being calm.
  const worstExcludingMotion = Math.min(
    scores.identity,
    scores.continuity,
    scores.adherence,
    scores.composition,
  );
  if (local.decision === "FALLBACK") decision = "FALLBACK";
  else if (expectMotion && m.motionScore < 0.12) decision = "RETRY";
  else if (worstExcludingMotion < THRESHOLD.fallback) decision = "FALLBACK";
  else if (mean < THRESHOLD.retry) decision = "RETRY";
  else if (decision === "PASS" && mean < THRESHOLD.pass) decision = "RETRY";

  const instruction =
    typeof model.repair_instruction === "string" && model.repair_instruction.trim().length > 0
      ? truncate(model.repair_instruction.trim(), 400)
      : local.repairInstruction;

  return { scores, decision, repairInstruction: instruction };
}

function persist(
  input: { projectId: string; scene: Scene; asset: AssetRow },
  verdict: Omit<QcVerdict, "scores" | "decision" | "repairInstruction"> & {
    scores: QcScores;
    decision: QcDecision;
    repairInstruction: string;
  },
): QcVerdict {
  Qc.record({
    projectId: input.projectId,
    assetId: input.asset.id,
    sceneId: input.scene.id,
    criticVersion: CRITIC_VERSION,
    scores: verdict.scores as unknown as Record<string, number>,
    decision: verdict.decision,
    repairInstruction: verdict.repairInstruction,
    source: verdict.source,
  });
  return verdict;
}

/**
 * Whether a measured fault is one a re-render could plausibly fix. Used to avoid
 * retrying deterministic output whose only complaint is unactionable.
 */
function hasActionableFault(
  m: Measurements,
  expectation: MotionExpectation,
  wantsSubject: boolean,
): boolean {
  const durationWrong = Math.abs(m.durationS - m.expectedDurationS) > 0.12;
  // Half the expectation's own floor: this asks whether the clip is broken, not
  // whether it is as lively as hoped.
  const frozen = expectation !== "held" && m.motionScore < FROZEN_MOTION[expectation] * 0.5;
  const misframed = wantsSubject && m.safeRegionWeight < 0.45;
  const unreadable = m.brightness < 0.06 || m.brightness > 0.94 || m.sharpness < 0.04;
  return durationWrong || frozen || misframed || unreadable;
}

/** Overall confidence for the UI, 0..1. */
export function overallScore(scores: QcScores): number {
  return round(
    (scores.identity + scores.continuity + scores.motion + scores.adherence + scores.composition) / 5,
    3,
  );
}
