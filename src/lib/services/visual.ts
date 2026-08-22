/**
 * Visual service: reference preparation, keyframes, and per-scene motion.
 *
 * Every scene is resolved to a self-contained MP4 clip of exact duration, 1080x1920,
 * 30 fps, with no audio. Doing it this way means each scene can be inspected,
 * scored and retried on its own, and the composer's job reduces to joining clips,
 * placing transitions and mixing audio — no per-scene special cases at assembly
 * time.
 *
 * Colour grade, grain and vignette are deliberately NOT applied here. They run
 * once over the joined timeline so the reel reads as one graded film rather than
 * seven separately treated shots.
 */
import fs from "node:fs";
import path from "node:path";
import {
  LIMITS,
  OUTPUT,
  videoDurationFor,
  type Profile,
} from "@/lib/core/config";
import { projectDir, tmpDir } from "@/lib/core/paths";
import {
  clamp,
  MuseError,
  pool,
  round,
  sha256,
  truncate,
  gate,
  pacedGate,
} from "@/lib/core/util";
import { logger, type Logger } from "@/lib/core/logger";
import {
  GENERATIVE_MODES,
  expectsSubject,
  sceneDuration,
  type DirectorSpec,
  type Scene,
} from "@/lib/spec/directorSpec";
import {
  generateImage,
  generateVideo,
  generateVideoInline,
} from "@/lib/models/adapters";
import { mediaCodec, route } from "@/lib/models/router";
import { getBundle } from "@/lib/templates/bundles";
import { bundleVersionString } from "@/lib/templates/types";
import { keyframePrompt, motionPrompt } from "@/lib/templates/prompts";
import {
  animateStill,
  buildSubjectSheet,
  proceduralStill,
  stylizeStill,
} from "@/lib/visual/localRender";
import { conformClip, probeMedia } from "@/lib/compose/ffmpeg";
import { clipDurationFor } from "@/lib/compose/plan";
import { Assets, SceneJobs } from "@/lib/db/repo";
import { assetBytes, extFor, registerFile, urlFor } from "./assets";
import type { AssetRow } from "@/lib/db/types";
import { hashJson } from "@/lib/core/util";

// ── continuity ───────────────────────────────────────────────────────────────

/**
 * The facts carried from earlier scenes into a prompt. Continuity is enforced by
 * repetition: the same immutable traits, wardrobe and palette phrasing appear in
 * every scene prompt, and the previous scene's final frame is passed as a visual
 * reference.
 */
export interface ContinuityPacket {
  subject: string;
  wardrobe: string;
  previousSetting: string;
  entryState: string;
  /** How many people belong in this frame. */
  cast: number;
  /** Reference images, most authoritative first. */
  references: { bytes: Buffer; mime: string; label: string }[];
}

interface SubjectFact {
  description: string;
  immutableTraits: string[];
  wardrobe: string;
  /** Which upload this subject was found in. */
  sourceIndex?: number;
  /** How many people that photograph actually contains. */
  peopleVisible?: number;
}

export interface SubjectFacts {
  primary?: SubjectFact;
  secondary?: SubjectFact;
}

export function buildContinuity(input: {
  spec: DirectorSpec;
  scene: Scene;
  facts: SubjectFacts;
  /**
   * The single image passed to the model as the identity anchor.
   *
   * This must be one clean photograph, not the contact sheet. An image model reads
   * a reference for composition as well as for identity, so handing it a wide
   * landscape grid of tiles produced a keyframe that was itself a grid of tiles.
   * The sheet remains useful for the interface and for the local styliser; it is
   * the wrong thing to show a generative model.
   */
  identityReference?: AssetRow | null;
  /** The previous scene's approved keyframe. */
  previousKeyframe?: AssetRow | null;
  previousScene?: Scene | null;
  wantsSecondary: boolean;
  /**
   * The photographs themselves, for a scene that shows the group.
   *
   * A description of "the subject together with his parents" is not enough for a model to
   * put the right people in frame — the subject sheet pins one face and says nothing about
   * anyone else. The photograph that actually contains the group is the only reference that
   * does, so it is attached for that scene and only that scene.
   */
  groupReferences?: AssetRow[];
}): ContinuityPacket {
  const { spec, scene, facts } = input;
  // A group scene has to pin every face in it, not only the protagonist's. Collecting just
  // the primary's traits is why the parents came back as strangers: the prompt described one
  // person exactly and left everyone standing beside them to the model's invention.
  const withSecondary = input.wantsSecondary && Boolean(facts.secondary);
  const secondary = withSecondary ? facts.secondary : undefined;
  const traits = [
    ...(facts.primary?.immutableTraits ?? []),
    ...(secondary?.immutableTraits ?? []),
    ...spec.style_bible.character_rules,
  ];
  const uniqueTraits = [
    ...new Set(traits.map((t) => t.trim()).filter(Boolean)),
  ].slice(0, secondary ? 12 : 8);

  const subject = secondary
    ? `${facts.primary?.description ?? "the subject"}, together with ${secondary.description}`
    : (facts.primary?.description ??
      "the subject from the reference photograph");

  // The count comes from the photograph rather than from the sentence describing it: "with
  // his parents" is three people, and a model left to infer that produced four.
  const cast = secondary ? clampCast(secondary.peopleVisible ?? 2) : 1;

  type Reference = ContinuityPacket["references"][number];

  /** A reference we cannot read is not fatal: the prompt still carries the traits. */
  const read = (row: AssetRow, label: string): Reference | null => {
    try {
      return { bytes: assetBytes(row), mime: row.mime, label };
    } catch {
      return null;
    }
  };

  const identity = input.identityReference
    ? read(
        input.identityReference,
        "the protagonist of the film; this face carries every scene",
      )
    : null;

  // One group photograph, not two. Shown two pictures of the same people the model averages
  // the faces together instead of matching either, which is worse than showing it one.
  const group = withSecondary
    ? (input.groupReferences ?? [])
        .slice(0, 1)
        .map((u) =>
          read(
            u,
            `the ${cast} people in this scene; match every face to this photograph`,
          ),
        )
    : [];

  const previous = input.previousKeyframe
    ? read(
        input.previousKeyframe,
        "the previous scene, for continuity of light and grade",
      )
    : null;

  // For a group scene the group photograph leads. It is the only reference that says
  // anything at all about the other faces, and a model weights what it is shown first — with
  // the single portrait in front, the portrait won and the family did not survive.
  const references = (
    withSecondary ? [...group, identity] : [identity, previous]
  )
    .filter((r): r is Reference => r !== null)
    .slice(0, 2);

  return {
    subject: uniqueTraits.length
      ? `${subject}. Preserve exactly: ${uniqueTraits.join(", ")}.`
      : subject,
    // Named for the protagonist alone, so it is withheld once there is more than one person
    // in frame: "wearing a grey parka" applied to a group dresses the whole group in it. The
    // photograph they are matched against already says what each of them is wearing.
    wardrobe:
      cast > 1
        ? ""
        : facts.primary?.wardrobe || "consistent with the reference photograph",
    previousSetting: input.previousScene?.setting ?? "",
    entryState: input.previousScene
      ? truncate(`continues directly from: ${input.previousScene.action}`, 200)
      : "opening frame of the film",
    cast,
    references,
  };
}

/** A frame holds a few people, not a crowd, and never nobody. */
function clampCast(n: number): number {
  return Math.min(6, Math.max(2, Math.round(Number.isFinite(n) ? n : 2)));
}

// ── reference preparation ────────────────────────────────────────────────────

export interface ReferenceSet {
  subjectSheet: AssetRow | null;
  /** The single best upload, used as the stylisation source. */
  primaryUpload: AssetRow | null;
  uploads: AssetRow[];
}

/**
 * Normalise uploads into a subject reference sheet. Doing this once, up front,
 * means every scene prompt anchors to the same identity image rather than to a
 * different photo each time, which is the main cause of face drift.
 */
export async function prepareReferences(input: {
  projectId: string;
  log?: Logger;
}): Promise<ReferenceSet> {
  const log = input.log ?? logger({ project_id: input.projectId });
  const uploads = Assets.byProject(input.projectId, "upload_image");

  if (uploads.length === 0) {
    return { subjectSheet: null, primaryUpload: null, uploads: [] };
  }

  const existing = Assets.byProject(input.projectId, "subject_sheet");
  if (existing.length > 0) {
    return {
      subjectSheet: existing[existing.length - 1],
      primaryUpload: uploads[0],
      uploads,
    };
  }

  const out = path.join(projectDir(input.projectId), "subject-sheet.png");
  try {
    const sheet = await buildSubjectSheet({
      sourcePaths: uploads.map((u) => u.uri),
      outPath: out,
      seed: seedFor(input.projectId),
    });
    const row = registerFile({
      projectId: input.projectId,
      type: "subject_sheet",
      role: "subject_primary",
      filePath: sheet.path,
      mime: "image/png",
      metadata: {
        width: sheet.width,
        height: sheet.height,
        tiles: sheet.tiles,
      },
    });
    log.info("built subject reference sheet", { tiles: sheet.tiles });
    return { subjectSheet: row, primaryUpload: uploads[0], uploads };
  } catch (e) {
    log.warn("subject sheet build failed; falling back to the raw upload", {
      error: String(e),
    });
    return { subjectSheet: uploads[0], primaryUpload: uploads[0], uploads };
  }
}

/**
 * Choose the source photograph for a scene, or null to compose the frame
 * procedurally. Uploads are rotated by their position among the subject scenes so
 * a project with several photographs shows several of them.
 */
export function sourceForScene(
  spec: DirectorSpec,
  scene: Scene,
  references: ReferenceSet,
): AssetRow | null {
  if (references.uploads.length === 0) return null;
  if (!expectsSubject(scene)) return null;

  const subjectScenes = spec.scenes.filter((s) => expectsSubject(s));
  const position = Math.max(
    0,
    subjectScenes.findIndex((s) => s.id === scene.id),
  );
  // The hero shot always gets the strongest reference, because identity matters
  // most where the audience is looking hardest.
  if (scene.purpose === "hero_drop" && references.primaryUpload)
    return references.primaryUpload;
  return references.uploads[position % references.uploads.length];
}

/** Stable per-project seed so repeated runs of the local engine match. */
export function seedFor(...parts: (string | number)[]): number {
  const hex = sha256(parts.join("|")).slice(0, 8);
  return parseInt(hex, 16) >>> 0;
}

// ── keyframes ────────────────────────────────────────────────────────────────

export interface KeyframeResult {
  asset: AssetRow;
  route: string;
  usd: number;
  cached: boolean;
  fallbackReason?: string;
  promptUsed: string;
}

/**
 * Produce the still that defines a scene's look. The local path stylises the
 * user's own photograph when one exists and composes a procedural frame when it
 * does not, so a keyframe always exists for every scene.
 */
export async function generateKeyframe(input: {
  projectId: string;
  spec: DirectorSpec;
  specVersion: number;
  scene: Scene;
  continuity: ContinuityPacket;
  references: ReferenceSet;
  profile: Profile;
  deadlineAt?: number;
  attempt?: number;
  /** Extra instruction from the critic when this is a repair attempt. */
  repairInstruction?: string;
  log?: Logger;
}): Promise<KeyframeResult> {
  const bundle = getBundle(input.spec.style_bible.preset);
  const log = (input.log ?? logger({ project_id: input.projectId })).child({
    scene_id: input.scene.id,
  });

  let prompt = keyframePrompt({
    bundle,
    spec: input.spec,
    scene: input.scene,
    continuity: {
      subject: input.continuity.subject,
      wardrobe: input.continuity.wardrobe,
      previousSetting: input.continuity.previousSetting,
      entryState: input.continuity.entryState,
      cast: input.continuity.cast,
    },
    hasSubjectReference: input.continuity.references.length > 0,
  });
  if (input.repairInstruction) {
    prompt = `${prompt}\n\nCorrection required: ${input.repairInstruction}`;
  }

  // The name carries no extension yet: the asset route reads Content-Type from the
  // file suffix, so a JPEG from the image model written to a `.png` path was served
  // as image/png. The suffix is chosen once the returned mime is known, below.
  const outBase = path.join(
    projectDir(input.projectId),
    `keyframe-${input.scene.id}-v${input.specVersion}-a${input.attempt ?? 0}`,
  );
  // The local renderers only ever emit PNG, so their target can be fixed up front.
  const localOutPath = `${outBase}.png`;

  const result = await route<{ bytes: Buffer; mime: string }>({
    task: "keyframe",
    projectId: input.projectId,
    identity: {
      prompt,
      refs: input.continuity.references.map((r) => sha256(r.bytes)),
      size: input.profile.imageSize,
      attempt: input.attempt ?? 0,
      // In the identity so a corrected cast count re-generates rather than replaying a
      // keyframe made under the old one — a cache that steps around a fix has already cost
      // this project one wasted run. Omitted when there is one person in frame, because then
      // the request is byte-for-byte what it was and paying to reproduce it buys nothing.
      ...(input.continuity.cast > 1 ? { cast: input.continuity.cast } : {}),
    },
    cacheVersion: bundleVersionString(bundle),
    hint: {
      images: 1,
      inputTokens: 300 + input.continuity.references.length * 1100,
    },
    codec: mediaCodec<{ bytes: Buffer; mime: string }>(),
    profile: input.profile,
    deadlineAt: input.deadlineAt,
    logger: log,
    real: async (model) =>
      generateImage({
        model,
        prompt,
        references: input.continuity.references.map((r) => ({
          bytes: r.bytes,
          mime: r.mime,
        })),
        aspectRatio: "9:16",
        imageSize: input.profile.imageSize,
        timeoutMs: LIMITS.timeoutMs.keyframe,
      }),
    local: async () => {
      const seed = seedFor(input.projectId, input.scene.id, input.attempt ?? 0);
      const source = sourceForScene(input.spec, input.scene, input.references);

      if (source) {
        try {
          const still = await stylizeStill({
            sourcePath: source.uri,
            outPath: localOutPath,
            style: input.spec.style_bible,
            // The opening shot must stay recognisable as the user's own
            // photograph, so it is stylised lightly; later shots push harder as
            // the film moves away from reality.
            strength: input.scene.purpose === "recognition" ? 0.5 : 0.88,
            seed,
          });
          return { bytes: fs.readFileSync(still.path), mime: "image/png" };
        } catch (e) {
          log.warn("stylise failed, composing procedurally", {
            error: String(e),
          });
        }
      }

      const still = await proceduralStill({
        outPath: localOutPath,
        style: input.spec.style_bible,
        sceneAction: `${input.scene.action} ${input.scene.setting}`,
        seed,
      });
      return { bytes: fs.readFileSync(still.path), mime: "image/png" };
    },
  });

  const mime = result.value.mime.startsWith("image/")
    ? result.value.mime
    : "image/png";
  const outPath = `${outBase}.${extFor(mime)}`;
  fs.writeFileSync(outPath, result.value.bytes);
  const asset = registerFile({
    projectId: input.projectId,
    type: "keyframe",
    role: input.scene.id,
    filePath: outPath,
    mime,
    metadata: {
      sceneId: input.scene.id,
      specVersion: input.specVersion,
      route: result.route,
      fallbackReason: result.fallbackReason ?? null,
      prompt: truncate(prompt, 1200),
      attempt: input.attempt ?? 0,
    },
  });

  return {
    asset,
    route: result.route,
    usd: result.usd,
    cached: result.cached,
    fallbackReason: result.fallbackReason,
    promptUsed: prompt,
  };
}

// ── motion ───────────────────────────────────────────────────────────────────

export interface MotionResult {
  asset: AssetRow;
  route: string;
  usd: number;
  cached: boolean;
  fallbackReason?: string;
  /** True when real generated motion was used rather than deterministic camera work. */
  generated: boolean;
}

/**
 * Turn a scene's keyframe into a clip of exactly the scene's duration.
 *
 * Generated video is only attempted for scenes whose render mode asks for it and
 * only while the profile's video budget allows. Everything else — and anything
 * that fails — is animated deterministically, which still yields real movement
 * rather than a frozen frame.
 */
/**
 * Video calls in flight, across every scene.
 *
 * Module scope on purpose: scenes are produced in parallel and each one may reach the
 * same rate-limited model, so the limit belongs to the provider rather than to any one
 * batch. Without it, raising scene concurrency put five Veo requests in the air at once
 * and every one came back 429, which turned a faster run into a reel with no generated
 * motion in it.
 */
/**
 * How long to stop asking for generated video after the provider says the quota is spent.
 *
 * A 429 on video is a project-wide refusal that lasts minutes to hours, not milliseconds, and
 * every scene in a run discovers it separately: two models apiece, each start spaced by the
 * pacing interval, roughly twenty-four seconds of waiting per shot to be told the same thing
 * the first shot was told. Recording the refusal once and honouring it for the rest of the
 * window sends the remaining shots straight to deterministic motion, which is where they were
 * going anyway.
 *
 * A cooldown rather than a flag, so a run started after the window has passed tries again on
 * its own without anybody clearing state.
 */
const VIDEO_COOLDOWN_MS = 10 * 60_000;
let videoQuotaSpentUntil = 0;

/** The provider refused on quota, as opposed to failing for a reason a retry could fix. */
export function isQuotaRefusal(e: unknown): boolean {
  return (
    e instanceof MuseError &&
    (e.detail as { status?: number } | undefined)?.status === 429
  );
}

const videoGate = pacedGate(
  LIMITS.concurrency.video,
  LIMITS.videoStartIntervalMs,
);

export async function generateMotion(input: {
  projectId: string;
  spec: DirectorSpec;
  specVersion: number;
  scene: Scene;
  keyframe: AssetRow;
  profile: Profile;
  /**
   * Seconds of generated video reserved for this scene, decided before any worker
   * started. Zero means this shot is not animated on this run.
   */
  reservedSeconds: number;
  deadlineAt?: number;
  attempt?: number;
  log?: Logger;
}): Promise<MotionResult> {
  const bundle = getBundle(input.spec.style_bible.preset);
  const log = (input.log ?? logger({ project_id: input.projectId })).child({
    scene_id: input.scene.id,
  });
  // The clip is rendered a little longer than its scene window: the extra head
  // padding is what the incoming cross-dissolve overlaps into, so the assembled
  // reel still lands on the planned duration.
  const durationS = clipDurationFor(input.spec, input.scene);
  const outPath = path.join(
    projectDir(input.projectId),
    // The keyframe's digest is in the name because the scene, version and attempt together
    // are not unique across runs. Re-rendering one scene of an unchanged plan reuses attempt
    // numbers, so a second run wrote over the first run's takes: a still holding the family's
    // real faces was replaced, at the same path, by generated motion that had drifted off it,
    // and the only copies left were the ones earlier plan versions happened to have written
    // under different names. Two takes from the same keyframe and attempt are the same clip,
    // so sharing a name there is harmless.
    `clip-${input.scene.id}-v${input.specVersion}-a${input.attempt ?? 0}-${input.keyframe.sha256.slice(0, 8)}.mp4`,
  );

  // Only certain durations are accepted, so round up to one of them and trim the surplus
  // in the composer. Rounding down would leave the clip short of its window.
  const requestSeconds = videoDurationFor(durationS);
  // The allowance was allotted to this scene up front. Checking a running total of
  // seconds already spent is not an allowance when scenes render concurrently: every
  // worker reads the same stale figure, and a retry reads it after its own first attempt
  // was paid for, finds nothing left, and silently returns a still.
  const coolingDown = Date.now() < videoQuotaSpentUntil;
  const allowed = input.reservedSeconds >= requestSeconds && !coolingDown;

  if (coolingDown && input.reservedSeconds >= requestSeconds) {
    log.info(
      "skipping generated video; the provider refused on quota recently",
      {
        scene_id: input.scene.id,
        retry_in_s: Math.round((videoQuotaSpentUntil - Date.now()) / 1000),
      },
    );
  }

  // A shot the Director planned as generated, arriving with no allowance, means a caller
  // forgot to allot one. Twice now that produced a reel with no motion in it and nothing
  // in the log to say why: the reservation check has no idea it was supposed to be given
  // something. Saying so out loud turns a silent downgrade into a visible one.
  // Not during a cooldown: the allowance was there, the provider refused it, and saying
  // "no video allowance" about that sends the next reader after the wrong bug.
  if (!allowed && !coolingDown && GENERATIVE_MODES.includes(input.scene.render_mode)) {
    log.warn("shot was planned as generated but has no video allowance", {
      render_mode: input.scene.render_mode,
      reserved_seconds: input.reservedSeconds,
      needed_seconds: requestSeconds,
    });
  }

  const prompt = motionPrompt({ bundle, spec: input.spec, scene: input.scene });
  const stillBytes = assetBytes(input.keyframe);

  const localAnimate = async (): Promise<{ bytes: Buffer; mime: string }> => {
    const clip = await animateStill({
      stillPath: input.keyframe.uri,
      outPath,
      durationS,
      move: input.scene.camera,
      amount: input.scene.purpose === "hero_drop" ? 0.22 : 0.13,
      parallax:
        input.scene.render_mode === "source_motion" ||
        input.scene.render_mode === "collage",
      fps: OUTPUT.fps,
      seed: seedFor(
        input.projectId,
        input.scene.id,
        "motion",
        input.attempt ?? 0,
      ),
    });
    return { bytes: fs.readFileSync(clip.path), mime: "video/mp4" };
  };

  const result = await route<{ bytes: Buffer; mime: string }>({
    task: "video",
    projectId: input.projectId,
    identity: {
      prompt,
      keyframe: input.keyframe.sha256,
      seconds: requestSeconds,
      attempt: input.attempt ?? 0,
    },
    cacheVersion: bundleVersionString(bundle),
    hint: { seconds: requestSeconds },
    codec: mediaCodec<{ bytes: Buffer; mime: string }>(),
    profile: allowed
      ? input.profile
      : {
          ...input.profile,
          routes: { ...input.profile.routes, video: { kind: "local" } },
        },
    deadlineAt: input.deadlineAt,
    logger: log,
    real: async (model) => {
      try {
        return await videoGate(async () => {
          // The long-running Veo surface and the conversational surface have
          // different shapes; pick by model id rather than by configuration so a
          // fallback chain entry cannot be called the wrong way.
          if (model.startsWith("veo-")) {
            return generateVideo({
              model,
              prompt,
              image: { bytes: stillBytes, mime: input.keyframe.mime },
              seconds: requestSeconds,
              resolution: input.profile.name === "max" ? "1080p" : "720p",
              aspectRatio: "9:16",
              personGeneration: "allow_adult",
              timeoutMs: LIMITS.timeoutMs.video,
              onTick: (ms) =>
                log.debug(`video generating ${Math.round(ms / 1000)}s`),
            });
          }
          return generateVideoInline({
            model,
            prompt,
            image: { bytes: stillBytes, mime: input.keyframe.mime },
            seconds: requestSeconds,
            timeoutMs: LIMITS.timeoutMs.video,
          });
        });
      } catch (e) {
        // Recorded once, honoured by every shot still to come in this run.
        if (isQuotaRefusal(e))
          videoQuotaSpentUntil = Date.now() + VIDEO_COOLDOWN_MS;
        throw e;
      }
    },
    local: localAnimate,
  });

  const generated = result.route.startsWith("gemini:");

  // A generated clip arrives at the model's own duration, frame rate and
  // resolution, and often carries a silent audio track. Conform it to the exact
  // scene window before anything downstream sees it.
  const finalPath = outPath;
  if (generated) {
    const raw = path.join(
      tmpDir(input.projectId, "motion"),
      `raw-${input.scene.id}.mp4`,
    );
    fs.writeFileSync(raw, result.value.bytes);
    await conformClip({
      inputPath: raw,
      outPath,
      durationS,
      fps: OUTPUT.fps,
      width: OUTPUT.width,
      height: OUTPUT.height,
    });
  } else if (!fs.existsSync(outPath)) {
    fs.writeFileSync(outPath, result.value.bytes);
  }

  const probe = await probeMedia(finalPath);
  if (Math.abs(probe.durationS - durationS) > 0.12) {
    log.warn("clip duration drifted from the scene window", {
      expected: durationS,
      actual: probe.durationS,
    });
  }

  const asset = registerFile({
    projectId: input.projectId,
    type: "scene_video",
    role: input.scene.id,
    filePath: finalPath,
    mime: "video/mp4",
    metadata: {
      sceneId: input.scene.id,
      specVersion: input.specVersion,
      route: result.route,
      generated,
      fallbackReason: result.fallbackReason ?? null,
      durationS: probe.durationS,
      width: probe.width,
      height: probe.height,
      requestedSeconds: generated ? requestSeconds : durationS,
      prompt: generated ? truncate(prompt, 1000) : null,
    },
  });

  return {
    asset,
    route: result.route,
    usd: result.usd,
    cached: result.cached,
    fallbackReason: result.fallbackReason,
    generated,
  };
}

// ── batch helpers ────────────────────────────────────────────────────────────

/** Deterministic idempotency key for a scene stage. */
export function sceneRequestHash(input: {
  projectId: string;
  sceneId: string;
  specVersion: number;
  stage: "keyframe" | "motion";
  attempt: number;
  extra?: unknown;
}): string {
  return hashJson(input);
}

/**
 * Claim a scene job row, honouring idempotency. Returns null when an identical
 * request already completed, so a repeated call cannot re-spend.
 */
export function claimSceneJob(input: {
  projectId: string;
  sceneId: string;
  specVersion: number;
  stage: "keyframe" | "motion";
  modelRoute: string;
  attempt: number;
}): { jobId: string; alreadyDone: boolean; outputAssetId: string | null } {
  const requestHash = sceneRequestHash(input);
  const { job } = SceneJobs.claim({ ...input, requestHash });
  return {
    jobId: job.id,
    alreadyDone: job.status === "done" && Boolean(job.output_asset_id),
    outputAssetId: job.output_asset_id,
  };
}

/** Run scene work with the profile's concurrency cap. */
export async function forEachScene<T>(
  scenes: Scene[],
  limit: number,
  fn: (scene: Scene, index: number) => Promise<T>,
): Promise<T[]> {
  return pool(scenes, Math.max(1, limit), fn);
}

/** Convenience for the UI: the newest clip or keyframe URL for a scene. */
export function sceneAssetUrl(
  projectId: string,
  sceneId: string,
  prefer: "scene_video" | "keyframe",
): string | null {
  const row = Assets.byRole(projectId, sceneId, prefer);
  if (row) return urlFor(row);
  const other = Assets.byRole(
    projectId,
    sceneId,
    prefer === "scene_video" ? "keyframe" : "scene_video",
  );
  return other ? urlFor(other) : null;
}

/** Guard used by the pipeline before it trusts an asset. */
export function assertReadable(row: AssetRow): void {
  if (!fs.existsSync(row.uri)) {
    throw new MuseError("permanent", `asset ${row.id} vanished from storage`, {
      uri: row.uri,
    });
  }
  const size = fs.statSync(row.uri).size;
  if (size < 512) {
    throw new MuseError(
      "semantic",
      `asset ${row.id} is implausibly small (${size} bytes)`,
    );
  }
}

/** Total seconds of generated video recorded against a project. */
/**
 * Seconds of generated video already produced for a project.
 *
 * Telemetry, not enforcement. It was the enforcement mechanism and could not be: under
 * concurrency every worker reads the same stale total. Allocation happens up front in
 * `planAnimation`, and a worker is bound by its own reservation.
 */
export function videoSecondsUsed(projectId: string): number {
  return Assets.byProject(projectId, "scene_video")
    .map((a) =>
      Assets.meta<{ generated?: boolean; requestedSeconds?: number }>(a),
    )
    .filter((m) => m.generated)
    .reduce((acc, m) => acc + (m.requestedSeconds ?? 0), 0);
}

export { round };
