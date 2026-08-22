/**
 * Pipeline orchestration. Owns the order of work, the parallelism, the retry
 * budgets and the deadline; owns none of the work itself.
 *
 * Two shapes matter here. Music and visuals run concurrently from the moment the
 * plan exists, because they only share the timeline and not each other's output.
 * And quality control runs per scene as each clip lands rather than as a phase
 * after everything finishes, so a bad scene is being repaired while its
 * neighbours are still rendering.
 */
import fs from "node:fs";
import path from "node:path";
import { LIMITS, OUTPUT, profileFor, type Profile } from "@/lib/core/config";
import { PATHS, projectDir } from "@/lib/core/paths";
import { MuseError, pool, round, sha256, slug, truncate } from "@/lib/core/util";
import type { Logger } from "@/lib/core/logger";
import {
  GENERATIVE_MODES,
  sceneDuration,
  type DirectorSpec,
  type Scene,
} from "@/lib/spec/directorSpec";
import { applyPatch, describeImpact, isTooBroad, PatchRequestSchema, type PatchRequest } from "@/lib/spec/patch";
import { Assets, Audit, Ledger, Projects, Renders, SceneJobs, Specs } from "@/lib/db/repo";
import type { AssetRow } from "@/lib/db/types";
import { budget } from "@/lib/models/governor";
import { generateJson } from "@/lib/models/adapters";
import { jsonCodec, route } from "@/lib/models/router";
import { getBundle } from "@/lib/templates/bundles";
import { decodePatchResponse, patchPrompt } from "@/lib/templates/prompts";
import { assetBytes, registerFile, urlFor, verifyChecksum } from "./assets";
import { direct, planAnimation, type SubjectFact } from "./director";
import { preflightVerdict, readUploads, type VisionOutcome } from "./vision";
import {
  buildContinuity,
  generateKeyframe,
  generateMotion,
  prepareReferences,
  type ReferenceSet,
  type SubjectFacts,
} from "./visual";
import { produceMusic, shouldRegenerate, type MusicOutcome } from "./music";
import { critique, motionExpectation, overallScore, type QcVerdict } from "./critic";
import {
  buildManifest,
  clipDurationFor,
  cuttableAnchors,
  validateManifest,
  type ClipInput,
} from "@/lib/compose/plan";
import { editRole, editStyle, type EditStyle, type EditStyleId } from "@/lib/compose/edit";
import { checkReel, extractPoster, renderReel } from "@/lib/compose/ffmpeg";
import { register, type RunContext } from "@/lib/jobs/runner";
import type { RenderManifest } from "@/lib/compose/types";

// ── shared helpers ───────────────────────────────────────────────────────────

function profileOf(projectId: string): Profile {
  const p = Projects.require(projectId);
  return profileFor(p.profile as never);
}

function emitCost(ctx: RunContext): void {
  const b = budget();
  ctx.emit({
    kind: "cost",
    spentUsd: b.spentUsd,
    remainingUsd: b.remainingUsd,
    ceilingUsd: b.ceilingUsd,
  });
}

/**
 * The photographs to show a model for a scene that includes somebody besides the protagonist.
 *
 * Not "the uploads" — every upload, in upload order, meant the first one was chosen, and the
 * first one is deliberately the single clean portrait used as the identity anchor. Showing
 * that as the group reference tells the model nothing it did not already have, so the other
 * people in the scene were invented from a sentence.
 *
 * The photograph to show is the one they were actually seen in, which the vision read already
 * records per subject.
 */
export function groupUploadsFor(facts: SubjectFacts, uploads: AssetRow[]): AssetRow[] {
  const at = facts.secondary?.sourceIndex;
  if (at === undefined || uploads.length === 0) return [];
  const chosen = uploads[Math.min(Math.max(at, 0), uploads.length - 1)];
  return chosen ? [chosen] : [];
}

function factsFrom(vision: VisionOutcome): SubjectFacts {
  const primary = vision.subjects.find((s) => s.role === "subject_primary");
  const secondary = vision.subjects.find((s) => s.role === "subject_secondary");
  return {
    ...(primary
      ? {
          primary: {
            description: primary.description,
            immutableTraits: primary.immutable_traits,
            wardrobe: primary.wardrobe,
            sourceIndex: primary.source_index,
            peopleVisible: primary.people_visible,
          },
        }
      : {}),
    ...(secondary
      ? {
          secondary: {
            description: secondary.description,
            immutableTraits: secondary.immutable_traits,
            wardrobe: secondary.wardrobe,
            sourceIndex: secondary.source_index,
            peopleVisible: secondary.people_visible,
          },
        }
      : {}),
  };
}

/** Cached vision read for a project, so re-running a stage does not re-read photos. */
async function visionFor(projectId: string, profile: Profile, deadlineAt: number): Promise<VisionOutcome> {
  const uploads = Assets.byProject(projectId, "upload_image");
  return readUploads({
    projectId,
    profile,
    deadlineAt,
    uploads: uploads.map((u) => ({ path: u.uri, mime: u.mime, bytes: assetBytes(u) })),
  });
}

// ── stage: preflight and direct ──────────────────────────────────────────────

export interface DirectStageResult {
  specVersion: number;
  spec: DirectorSpec;
  vision: VisionOutcome;
  warnings: string[];
}

async function stageDirect(ctx: RunContext): Promise<DirectStageResult> {
  const project = Projects.require(ctx.projectId);
  const profile = profileOf(ctx.projectId);

  Projects.advanceTo(ctx.projectId, "PREFLIGHT");
  ctx.emit({ kind: "status", status: "PREFLIGHT" });
  ctx.emit({ kind: "stage", stage: "preflight", state: "start" });

  const vision = await visionFor(ctx.projectId, profile, ctx.deadlineAt);
  const verdict = preflightVerdict(vision, Assets.byProject(ctx.projectId, "upload_image").length);
  emitCost(ctx);

  if (!verdict.ok) {
    ctx.emit({
      kind: "stage",
      stage: "preflight",
      state: "fail",
      detail: verdict.blocking.join("; "),
    });
    throw new MuseError("permanent", `preflight failed: ${verdict.blocking.join("; ")}`);
  }
  for (const w of verdict.warnings) ctx.emit({ kind: "log", level: "warn", message: w });
  ctx.emit({
    kind: "stage",
    stage: "preflight",
    state: "done",
    detail: `${vision.subjects.length} subject(s) read via ${vision.route}`,
  });

  ctx.checkpoint();
  Projects.advanceTo(ctx.projectId, "DIRECTING");
  ctx.emit({ kind: "status", status: "DIRECTING" });
  ctx.emit({ kind: "stage", stage: "director", state: "start" });

  const subjects: SubjectFact[] = vision.subjects.map((s) => ({
    role: s.role,
    description: s.description,
    peopleVisible: s.people_visible,
  }));

  const uploadedAudio = Assets.byProject(ctx.projectId, "upload_audio")[0] ?? null;
  let musicHint: { bpm: number; durationS: number; sections: { t: number; kind: string }[] } | undefined;
  if (project.mode === "uploaded" && uploadedAudio) {
    // Analyse the user's track first so the plan is written around its real
    // structure rather than a guessed tempo.
    const { analyzeFile } = await import("@/lib/music/analyze");
    try {
      const actual = await analyzeFile(uploadedAudio.uri);
      musicHint = {
        bpm: actual.bpm,
        durationS: actual.durationS,
        sections: actual.anchors
          .filter((a) => a.kind === "section" || a.kind === "peak")
          .slice(0, 8)
          .map((a) => ({ t: a.t, kind: a.kind })),
      };
      ctx.emit({
        kind: "log",
        level: "info",
        message: `uploaded track: ${actual.bpm} BPM, ${actual.durationS.toFixed(1)}s, ${actual.anchors.length} accents`,
      });
    } catch (e) {
      ctx.log.warn("uploaded audio analysis failed", { error: String(e) });
    }
  }

  const durationS =
    project.mode === "uploaded" && musicHint
      ? Math.min(OUTPUT.durationS, Math.max(18, round(musicHint.durationS, 2)))
      : OUTPUT.durationS;

  const outcome = await direct({
    projectId: ctx.projectId,
    bundleId: project.preset,
    brief: project.brief,
    mode: project.mode,
    durationS,
    subjects,
    music: musicHint,
    profile,
    deadlineAt: ctx.deadlineAt,
  });

  const version = Specs.push({
    projectId: ctx.projectId,
    spec: outcome.spec,
    origin: outcome.route === "local" ? "local" : "director",
    note: outcome.fallbackReason ?? `via ${outcome.route}`,
  });
  Projects.patch(ctx.projectId, { title: outcome.spec.title });

  ctx.emit({
    kind: "spec",
    version: version.version,
    title: outcome.spec.title,
    scenes: outcome.spec.scenes.length,
    durationS: outcome.spec.duration_s,
  });
  ctx.emit({
    kind: "stage",
    stage: "director",
    state: outcome.fallbackReason ? "fallback" : "done",
    detail: `${outcome.spec.scenes.length} scenes via ${outcome.route}`,
  });
  emitCost(ctx);

  return {
    specVersion: version.version,
    spec: outcome.spec,
    vision,
    warnings: [...verdict.warnings, ...outcome.repairedIssues],
  };
}

// ── stage: storyboard ────────────────────────────────────────────────────────

async function stageStoryboard(
  ctx: RunContext,
  input: {
    spec: DirectorSpec;
    specVersion: number;
    vision: VisionOutcome;
    profile: Profile;
    onlyScenes?: string[];
  },
): Promise<Map<string, AssetRow>> {
  Projects.advanceTo(ctx.projectId, "STORYBOARDING");
  ctx.emit({ kind: "status", status: "STORYBOARDING" });
  ctx.emit({ kind: "stage", stage: "storyboard", state: "start" });

  const references = await prepareReferences({ projectId: ctx.projectId, log: ctx.log });
  const facts = factsFrom(input.vision);
  const keyframes = new Map<string, AssetRow>();

  // Reuse anything already generated for this spec version, so a resumed or
  // partially patched project does not pay twice.
  for (const scene of input.spec.scenes) {
    if (input.onlyScenes && !input.onlyScenes.includes(scene.id)) {
      const existing = Assets.byRole(ctx.projectId, scene.id, "keyframe");
      if (existing && verifyChecksum(existing)) {
        keyframes.set(scene.id, existing);
        ctx.emit({
          kind: "scene",
          sceneId: scene.id,
          stage: "keyframe",
          state: "done",
          assetUrl: urlFor(existing),
          route: "reused",
        });
      }
    }
  }

  const todo = input.spec.scenes.filter((s) => !keyframes.has(s.id));

  // Keyframes are generated in scene order despite the concurrency cap, because
  // each scene's continuity references the previous scene's approved frame.
  // Order is preserved by chaining rather than by the pool.
  for (const scene of todo) {
    ctx.checkpoint();
    const index = input.spec.scenes.findIndex((s) => s.id === scene.id);
    const previousScene = index > 0 ? input.spec.scenes[index - 1] : null;
    const previousKeyframe = previousScene ? keyframes.get(previousScene.id) ?? null : null;

    ctx.emit({ kind: "scene", sceneId: scene.id, stage: "keyframe", state: "start" });

    const continuity = buildContinuity({
      spec: input.spec,
      scene,
      facts,
      // One clean photograph, not the contact sheet: see buildContinuity.
      identityReference: references.primaryUpload ?? references.subjectSheet,
      previousKeyframe,
      previousScene,
      wantsSecondary: scene.reference_asset_ids.includes("subject_secondary"),
      groupReferences: groupUploadsFor(facts, references.uploads),
    });

    try {
      const result = await generateKeyframe({
        projectId: ctx.projectId,
        spec: input.spec,
        specVersion: input.specVersion,
        scene,
        continuity,
        references,
        profile: input.profile,
        deadlineAt: ctx.deadlineAt,
        log: ctx.log,
      });
      keyframes.set(scene.id, result.asset);
      ctx.emit({
        kind: "scene",
        sceneId: scene.id,
        stage: "keyframe",
        state: result.fallbackReason ? "fallback" : "done",
        assetUrl: urlFor(result.asset),
        route: result.route,
        fallbackReason: result.fallbackReason,
      });
      emitCost(ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.log.error("keyframe generation failed outright", { scene_id: scene.id, error: message });
      ctx.emit({ kind: "scene", sceneId: scene.id, stage: "keyframe", state: "fail", fallbackReason: message });
    }
  }

  ctx.emit({
    kind: "stage",
    stage: "storyboard",
    state: "done",
    detail: `${keyframes.size}/${input.spec.scenes.length} keyframes`,
  });
  return keyframes;
}

// ── stage: render, with per-scene quality control ────────────────────────────

interface SceneOutcome {
  scene: Scene;
  clip: AssetRow | null;
  verdict: QcVerdict | null;
  attempts: number;
  generated: boolean;
  isStill: boolean;
  fromFallback: boolean;
}

/**
 * Whether to keep the take already in hand rather than accept a replacement with no
 * generated motion.
 *
 * A retry may correct a shot; it may not quietly demote one. The critic asks for a retry on
 * semantics, and a retry that can no longer afford generation comes back as a camera move on
 * a still — a different, lesser shot rather than a fix. It then passes easily, because
 * deterministic output is judged by measurement alone, so the demotion reads as an
 * improvement. Two real generated shots were replaced by stills this way, including a hero.
 *
 * But the refusal holds only while the take it protects is actually sound. A generated take
 * the critic rejected is not worth protecting: a hero shot was pulled out into a wide
 * landscape where the family stood as three anonymous specks, scored 0.3 on identity with a
 * note asking for them to be visible, and this rule shipped it in preference to the still
 * that showed their faces. Motion is worth less than the film being about the right people.
 */
export function refusesDemotion(input: {
  held: { generated: boolean; verdict: QcVerdict | null } | null;
  nextGenerated: boolean;
}): boolean {
  const { held, nextGenerated } = input;
  if (!held || nextGenerated || !held.generated) return false;
  return held.verdict === null || held.verdict.decision === "PASS";
}

async function renderSceneWithQc(
  ctx: RunContext,
  input: {
    spec: DirectorSpec;
    specVersion: number;
    scene: Scene;
    keyframe: AssetRow | null;
    vision: VisionOutcome;
    references: ReferenceSet;
    profile: Profile;
    /** Seconds of generated video reserved for each scene routing chose to animate. */
    animated?: Map<string, number>;
  },
): Promise<SceneOutcome> {
  const { scene } = input;
  const expectedDurationS = clipDurationFor(input.spec, scene);
  const maxAttempts = 1 + Math.max(0, scene.retry_budget);
  const facts = factsFrom(input.vision);

  // Built once for the scene rather than per attempt: it does not vary with the attempt, and
  // QC needs the same references the keyframe was generated from in order to judge identity
  // against them.
  const continuity = buildContinuity({
    spec: input.spec,
    scene,
    facts,
    identityReference: input.references.primaryUpload ?? input.references.subjectSheet,
    previousKeyframe: null,
    previousScene: null,
    wantsSecondary: scene.reference_asset_ids.includes("subject_secondary"),
    groupReferences: groupUploadsFor(facts, input.references.uploads),
  });

  let keyframe = input.keyframe;
  let clip: AssetRow | null = null;
  let verdict: QcVerdict | null = null;
  let generated = false;
  let fromFallback = false;
  let attempt = 0;

  while (attempt < maxAttempts) {
    ctx.checkpoint();

    // Past the deadline, take whatever exists rather than starting new work.
    if (Date.now() > ctx.deadlineAt && clip) {
      ctx.emit({
        kind: "log",
        level: "warn",
        message: `${scene.id}: deadline reached, keeping the current take`,
      });
      break;
    }

    if (!keyframe) {
      ctx.emit({ kind: "scene", sceneId: scene.id, stage: "keyframe", state: "start", attempt });
      const kf = await generateKeyframe({
        projectId: ctx.projectId,
        spec: input.spec,
        specVersion: input.specVersion,
        scene,
        continuity,
        references: input.references,
        profile: input.profile,
        deadlineAt: ctx.deadlineAt,
        attempt,
        repairInstruction: verdict?.repairInstruction,
        log: ctx.log,
      });
      keyframe = kf.asset;
      ctx.emit({
        kind: "scene",
        sceneId: scene.id,
        stage: "keyframe",
        state: kf.fallbackReason ? "fallback" : "done",
        assetUrl: urlFor(kf.asset),
        route: kf.route,
        attempt,
      });
    }

    ctx.emit({ kind: "scene", sceneId: scene.id, stage: "motion", state: "start", attempt });

    const motion = await generateMotion({
      projectId: ctx.projectId,
      spec: input.spec,
      specVersion: input.specVersion,
      scene,
      keyframe,
      profile: input.profile,
      // The reservation belongs to the scene, so a retry may spend it again rather
      // than discovering the run is out of seconds and returning a still.
      reservedSeconds: input.animated?.get(scene.id) ?? 0,
      deadlineAt: ctx.deadlineAt,
      attempt,
      log: ctx.log,
    });

    // A retry may correct a shot; it may not quietly demote one. The critic asks for
    // a retry on semantics, and a retry that cannot afford generation any more comes
    // back as a camera move on a still — a different, lesser shot rather than a fix.
    // It then passes easily, because deterministic output is judged by measurement
    // alone, so the demotion looks like an improvement. Two real generated shots were
    // replaced by stills this way, including the hero.
    const demotes = refusesDemotion({
      held: clip ? { generated, verdict } : null,
      nextGenerated: motion.generated,
    });
    if (demotes) {
      ctx.emit({
        kind: "log",
        level: "warn",
        message: `${scene.id}: keeping the generated take; the retry could only offer a still`,
      });
    }
    clip = demotes && clip ? clip : motion.asset;
    if (!demotes) {
      generated = motion.generated;
      fromFallback = Boolean(motion.fallbackReason);
    }
    emitCost(ctx);

    verdict = await critique({
      projectId: ctx.projectId,
      spec: input.spec,
      specVersion: input.specVersion,
      scene,
      asset: clip,
      expectedDurationS,
      // What this shot was asked to do, which is what it should be judged against.
      // The finished clip decides: routing can upgrade a still shot to a real one
      // after the plan was written.
      expectation: motionExpectation(scene, motion.generated),
      isFallbackAsset: !motion.generated,
      // The same photographs the shot was generated from. The identity axis is the reason QC
      // exists for a film about real people, and it was being scored blind.
      references: continuity.references,
      cast: continuity.cast,
      profile: input.profile,
      deadlineAt: ctx.deadlineAt,
      log: ctx.log,
    });

    ctx.emit({
      kind: "qc",
      sceneId: scene.id,
      scores: verdict.scores as unknown as Record<string, number>,
      decision: verdict.decision,
      note: verdict.repairInstruction,
      source: verdict.source,
    });
    ctx.emit({
      kind: "scene",
      sceneId: scene.id,
      stage: "motion",
      state: verdict.decision === "PASS" ? (motion.fallbackReason ? "fallback" : "done") : "fail",
      assetUrl: urlFor(clip),
      route: motion.route,
      fallbackReason: motion.fallbackReason,
      attempt,
    });
    emitCost(ctx);

    if (verdict.decision === "PASS") break;

    attempt++;
    if (attempt >= maxAttempts) {
      // Out of semantic retries. A deterministic animation of the approved
      // keyframe is guaranteed to be well-formed, so use it rather than shipping
      // a clip the critic rejected.
      // Reaching here at all means the verdict was not a pass — the loop breaks on one — so
      // no further test of the decision is needed, and the FALLBACK test that used to be here
      // only excluded RETRY. A shot whose last attempt came back RETRY therefore shipped the
      // rejection. It cost four generations to learn that: the hero drop was retried to
      // exhaustion, ended on RETRY at 0.4 identity, and the reel took a photoreal vista with
      // two strangers in it over a painted frame carrying the family's own faces. A
      // deterministic animation of the approved keyframe cannot be wrong about who is in it.
      if (generated && keyframe) {
        ctx.emit({
          kind: "log",
          level: "warn",
          message: `${scene.id}: falling back to deterministic motion after ${attempt} attempt(s)`,
        });
        const safe = await generateMotion({
          projectId: ctx.projectId,
          spec: input.spec,
          specVersion: input.specVersion,
          scene,
          keyframe,
          // Forcing the local route guarantees a well-formed clip.
          profile: { ...input.profile, routes: { ...input.profile.routes, video: { kind: "local" } } },
          reservedSeconds: 0,
          deadlineAt: ctx.deadlineAt,
          attempt: attempt + 1,
          log: ctx.log,
        });
        clip = safe.asset;
        generated = false;
        fromFallback = true;
        ctx.emit({
          kind: "scene",
          sceneId: scene.id,
          stage: "motion",
          state: "fallback",
          assetUrl: urlFor(clip),
          route: safe.route,
          fallbackReason: "critic rejected the generated take",
        });
      }
      break;
    }

    // Regenerate the keyframe too when identity or composition is the problem;
    // re-animating the same bad frame would only reproduce the fault.
    if (verdict.scores.identity < 0.6 || verdict.scores.composition < 0.6) keyframe = null;
  }

  return {
    scene,
    clip,
    verdict,
    attempts: attempt + 1,
    generated,
    isStill: !generated,
    fromFallback,
  };
}

// ── stage: compose ───────────────────────────────────────────────────────────

async function stageCompose(
  ctx: RunContext,
  input: {
    spec: DirectorSpec;
    specVersion: number;
    outcomes: SceneOutcome[];
    music: MusicOutcome;
    vision: VisionOutcome;
    /** Which reading of the material to cut. Defaults to the planned edit. */
    edit?: EditStyle;
  },
): Promise<{ manifest: RenderManifest; reel: AssetRow; check: Awaited<ReturnType<typeof checkReel>> }> {
  const edit = input.edit ?? editStyle("as_cut");
  Projects.advanceTo(ctx.projectId, "COMPOSING");
  ctx.emit({ kind: "status", status: "COMPOSING" });
  ctx.emit({ kind: "render", state: "start", progress: 0 });

  // The photograph the film opens on. Only the first shot uses it, so only the first
  // upload is needed: the opening scene is the one built from the subject reference.
  const firstUpload = Assets.byProject(ctx.projectId, "upload_image")[0] ?? null;

  const clips: ClipInput[] = input.outcomes
    .filter((o): o is SceneOutcome & { clip: AssetRow } => Boolean(o.clip))
    .map((o, i) => ({
      scene: o.scene,
      path: o.clip.uri,
      sha256: o.clip.sha256,
      sourceDurationS:
        Assets.meta<{ durationS?: number }>(o.clip).durationS ?? clipDurationFor(input.spec, o.scene),
      fromFallback: o.fromFallback,
      isStill: o.isStill,
      // Keyframes already carry their painterly treatment, whether they came from
      // an image model or from the local styliser, so the composer must not apply
      // it a second time and double the smoothing.
      needsPainterly: false,
      ...(i === 0 && firstUpload
        ? { originPath: firstUpload.uri, originSha256: firstUpload.sha256 }
        : {}),
    }));

  const manifest = buildManifest({
    projectId: ctx.projectId,
    spec: input.spec,
    specVersion: input.specVersion,
    clips,
    audio: {
      path: input.music.asset.uri,
      sha256: input.music.asset.sha256,
      durationS: input.music.actual.durationS,
      fromFallback: input.music.fromFallback,
      // The measured loudness curve, so the plan can tell whether the score actually
      // rises into the payoff or only claims the right tempo.
      energy: input.music.actual.energy,
      peak: input.music.actual.peak,
    },
    reconciliation: input.music.reconciliation,
    cutAnchorsS: cuttableAnchors(input.music.actual, edit.anchorDensity),
    edit,
  });

  const issues = validateManifest(manifest);
  for (const i of issues) ctx.emit({ kind: "log", level: "warn", message: `manifest: ${i}` });

  const render = Renders.start({
    projectId: ctx.projectId,
    specVersion: input.specVersion,
    manifest,
  });

  const outPath = path.join(
    PATHS.renders,
    `${slug(input.spec.title)}-${ctx.projectId}-v${input.specVersion}${
      edit.id === "as_cut" ? "" : `-${edit.id}`
    }.mp4`,
  );

  try {
    const outcome = await renderReel(manifest, {
      outPath,
      log: ctx.log,
      onProgress: (fraction, label) =>
        ctx.emit({ kind: "render", state: "start", progress: fraction, detail: label }),
    });

    const check = await checkReel(outPath, {
      durationS: manifest.durationS,
      width: manifest.width,
      height: manifest.height,
    });

    for (const w of outcome.warnings) ctx.emit({ kind: "log", level: "warn", message: w });
    for (const i of check.issues) ctx.emit({ kind: "log", level: "warn", message: `check: ${i}` });

    const reel = registerFile({
      projectId: ctx.projectId,
      type: "reel",
      role: editRole(edit.id),
      filePath: outPath,
      mime: "video/mp4",
      metadata: {
        specVersion: input.specVersion,
        durationS: outcome.durationS,
        width: outcome.width,
        height: outcome.height,
        bytes: outcome.bytes,
        check,
        warnings: outcome.warnings,
        aiGenerated: true,
        anchors: manifest.anchorsS,
        edit: edit.id,
        editLabel: edit.label,
        cuts: manifest.clips.slice(1).map((c) => c.startS),
      },
    });

    // A poster frame on the hero scene gives the UI and any share card an image
    // that represents the film rather than its first frame.
    try {
      if (edit.id !== "as_cut") throw new Error("skip poster for an alternative edit");
      const hero = input.spec.scenes.find((s) => s.purpose === "hero_drop");
      const at = hero ? hero.start_s + sceneDuration(hero) * 0.4 : manifest.durationS * 0.3;
      const posterPath = path.join(projectDir(ctx.projectId), `poster-v${input.specVersion}.jpg`);
      await extractPoster(outPath, posterPath, at);
      registerFile({
        projectId: ctx.projectId,
        type: "poster",
        role: "final",
        filePath: posterPath,
        mime: "image/jpeg",
        metadata: { atS: at },
      });
    } catch (e) {
      ctx.log.warn("poster extraction failed", { error: String(e) });
    }

    Renders.finish(render.id, {
      status: "done",
      outputAssetId: reel.id,
      durationS: outcome.durationS,
      outputSha256: outcome.sha256,
      manifest,
    });

    ctx.emit({ kind: "render", state: "done", progress: 1, outputUrl: urlFor(reel) });
    return { manifest, reel, check };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    Renders.finish(render.id, { status: "failed", error: message });
    ctx.emit({ kind: "render", state: "fail", detail: message });
    throw e;
  }
}

// ── the full run ─────────────────────────────────────────────────────────────

export interface PipelineResult {
  specVersion: number;
  outputUrl: string;
  durationS: number;
  scenes: number;
  spentUsd: number;
  warnings: string[];
  checkOk: boolean;
}

/** Direct, storyboard, render music and visuals together, score, compose. */
export async function runPipeline(ctx: RunContext): Promise<PipelineResult> {
  const profile = profileOf(ctx.projectId);
  const startedUsd = Ledger.projectUsd(ctx.projectId);
  const warnings: string[] = [];

  const staged = await stageDirect(ctx);
  warnings.push(...staged.warnings);

  const keyframes = await stageStoryboard(ctx, {
    spec: staged.spec,
    specVersion: staged.specVersion,
    vision: staged.vision,
    profile,
  });

  ctx.checkpoint();
  Projects.advanceTo(ctx.projectId, "RENDERING");
  ctx.emit({ kind: "status", status: "RENDERING" });

  const references = await prepareReferences({ projectId: ctx.projectId, log: ctx.log });
  const uploadedAudio = Assets.byProject(ctx.projectId, "upload_audio")[0] ?? null;

  // Music and visuals share only the timeline, so they run concurrently. This is
  // also the honest version of the architecture claim: the two branches are
  // genuinely independent, not interleaved for show.
  const musicBranch = (async (): Promise<MusicOutcome> => {
    ctx.emit({ kind: "music", state: "start" });
    let outcome = await produceMusic({
      projectId: ctx.projectId,
      spec: staged.spec,
      specVersion: staged.specVersion,
      profile,
      uploadedAudio,
      deadlineAt: ctx.deadlineAt,
      log: ctx.log,
    });

    // One regeneration is allowed, and only for a missing drop.
    if (shouldRegenerate(outcome.reconciliation, 0) && Date.now() < ctx.deadlineAt) {
      ctx.emit({
        kind: "log",
        level: "warn",
        message: "the score had no clear drop; regenerating once",
      });
      const retry = await produceMusic({
        projectId: ctx.projectId,
        spec: { ...staged.spec, music: { ...staged.spec.music, mood: `${staged.spec.music.mood}, with an unmistakable drop` } },
        specVersion: staged.specVersion,
        profile,
        uploadedAudio,
        deadlineAt: ctx.deadlineAt,
        log: ctx.log,
      });
      // Only take the retry if it is at least as real as what we already have.
      // A local synth always has a clean drop, so without this check a fallback
      // would always win and quietly replace a paid Lyria score with a synthesised
      // one. A real score missing its drop is the better material: the composer
      // adds a deterministic impact for it at mix time, for nothing.
      const notWorseRoute = !retry.fromFallback || outcome.fromFallback;
      if (notWorseRoute && !retry.reconciliation.unmatched.includes("drop")) {
        outcome = retry;
      } else if (retry.fromFallback && !outcome.fromFallback) {
        ctx.emit({
          kind: "log",
          level: "info",
          message: "kept the generated score; the retry fell back and the mix will supply the drop",
        });
      }
    }

    ctx.emit({
      kind: "music",
      state: outcome.fromFallback ? "fallback" : "done",
      assetUrl: urlFor(outcome.asset),
      route: outcome.route,
      bpm: outcome.actual.bpm,
      anchors: outcome.reconciliation.snappedEvents.map((e) => e.t),
      fallbackReason: outcome.fallbackReason,
    });
    emitCost(ctx);
    return outcome;
  })();

  const visualBranch = (async (): Promise<SceneOutcome[]> => {
    // Which shots get real motion is decided here, once, against what this profile
    // can afford — not left to the render mode the Director guessed at.
    const animated = planAnimation(staged.spec, profile.name);
    if (animated.size > 0) {
      ctx.log.info("animating shots", {
        scenes: [...animated.keys()].sort(),
        of: staged.spec.scenes.length,
        seconds: [...animated.values()].reduce((a, b) => a + b, 0),
      });
    }

    // Hero first: it carries the highest retry budget and matters most, so it
    // should not be waiting behind cheaper scenes if the deadline bites.
    const ordered = [...staged.spec.scenes].sort((a, b) => {
      const rank = (s: Scene) =>
        s.purpose === "hero_drop" ? 0 : animated.has(s.id) || GENERATIVE_MODES.includes(s.render_mode) ? 1 : 2;
      return rank(a) - rank(b);
    });

    const results = await pool(ordered, LIMITS.concurrency.scenes, (scene) =>
      renderSceneWithQc(ctx, {
        spec: staged.spec,
        specVersion: staged.specVersion,
        scene,
        keyframe: keyframes.get(scene.id) ?? null,
        vision: staged.vision,
        references,
        profile,
        animated,
      }),
    );
    // Restore playback order for the composer.
    const byId = new Map(results.map((r) => [r.scene.id, r]));
    return staged.spec.scenes.map((s) => byId.get(s.id)).filter((r): r is SceneOutcome => Boolean(r));
  })();

  const [music, outcomes] = await Promise.all([musicBranch, visualBranch]);

  ctx.checkpoint();
  Projects.advanceTo(ctx.projectId, "QC");
  ctx.emit({ kind: "status", status: "QC" });
  const failed = outcomes.filter((o) => !o.clip);
  for (const f of failed) warnings.push(`${f.scene.id} produced no clip`);
  ctx.emit({
    kind: "stage",
    stage: "qc",
    state: failed.length > 0 ? "fallback" : "done",
    detail: `${outcomes.length - failed.length}/${outcomes.length} scenes usable`,
  });

  const { reel, check } = await stageCompose(ctx, {
    spec: staged.spec,
    specVersion: staged.specVersion,
    outcomes,
    music,
    vision: staged.vision,
  });

  Projects.advanceTo(ctx.projectId, "READY");
  ctx.emit({ kind: "status", status: "READY" });
  const meta = Assets.meta<{ durationS?: number }>(reel);
  ctx.emit({ kind: "done", outputUrl: urlFor(reel), durationS: meta.durationS ?? 0 });
  emitCost(ctx);

  return {
    specVersion: staged.specVersion,
    outputUrl: urlFor(reel),
    durationS: meta.durationS ?? 0,
    scenes: outcomes.length,
    spentUsd: round(Ledger.projectUsd(ctx.projectId) - startedUsd, 6),
    warnings,
    checkOk: check.ok,
  };
}

// ── targeted revision ────────────────────────────────────────────────────────

/** Regenerate one scene and recompose, leaving every other scene untouched. */
export async function runSceneRevision(
  ctx: RunContext,
  payload: { sceneId: string },
): Promise<PipelineResult> {
  const { version, spec } = Specs.requireActive(ctx.projectId);
  const profile = profileOf(ctx.projectId);
  const scene = spec.scenes.find((s) => s.id === payload.sceneId);
  if (!scene) throw new MuseError("permanent", `no scene ${payload.sceneId}`);

  // A project that has never been READY is not being revised; this is the first
  // render of that scene, which is the state the agent path arrives in.
  const revising = Projects.require(ctx.projectId).status === "READY";
  const entry = revising ? "REVISING" : "RENDERING";
  Projects.advanceTo(ctx.projectId, entry);
  ctx.emit({ kind: "status", status: entry });

  const vision = await visionFor(ctx.projectId, profile, ctx.deadlineAt);
  const references = await prepareReferences({ projectId: ctx.projectId, log: ctx.log });

  const revised = await renderSceneWithQc(ctx, {
    animated: planAnimation(spec, profile.name),
    spec,
    specVersion: version,
    scene,
    keyframe: null,
    vision,
    references,
    profile,
  });

  const outcomes = collectExistingOutcomes(ctx.projectId, spec, revised);
  const music = await produceMusic({
    projectId: ctx.projectId,
    spec,
    specVersion: version,
    profile,
    uploadedAudio: Assets.byProject(ctx.projectId, "upload_audio")[0] ?? null,
    deadlineAt: ctx.deadlineAt,
    log: ctx.log,
  });

  const { reel, check } = await stageCompose(ctx, {
    spec,
    specVersion: version,
    outcomes,
    music,
    vision,
  });

  Projects.advanceTo(ctx.projectId, "READY");
  ctx.emit({ kind: "status", status: "READY" });
  const meta = Assets.meta<{ durationS?: number }>(reel);
  ctx.emit({ kind: "done", outputUrl: urlFor(reel), durationS: meta.durationS ?? 0 });

  return {
    specVersion: version,
    outputUrl: urlFor(reel),
    durationS: meta.durationS ?? 0,
    scenes: outcomes.length,
    spentUsd: 0,
    warnings: [],
    checkOk: check.ok,
  };
}

/**
 * Rebuild the outcome list from stored assets, substituting any scene that was
 * just re-rendered. This is what lets a revision recompose without regenerating
 * the scenes nobody asked about.
 */
function collectExistingOutcomes(
  projectId: string,
  spec: DirectorSpec,
  ...replacements: SceneOutcome[]
): SceneOutcome[] {
  const replaced = new Map(replacements.map((r) => [r.scene.id, r]));
  return spec.scenes.map((scene) => {
    const swap = replaced.get(scene.id);
    if (swap) return swap;
    const clip = Assets.byRole(projectId, scene.id, "scene_video") ?? null;
    const meta = clip ? Assets.meta<{ generated?: boolean; fallbackReason?: string | null }>(clip) : {};
    return {
      scene,
      clip,
      verdict: null,
      attempts: 0,
      generated: Boolean(meta.generated),
      isStill: !meta.generated,
      fromFallback: Boolean(meta.fallbackReason),
    };
  });
}

// ── live direction ───────────────────────────────────────────────────────────

export interface LiveDirectionResult {
  specVersion: number;
  summary: string;
  impact: string;
  invalidatedScenes: string[];
  rejected: string[];
  accepted: boolean;
}

/**
 * Turn an utterance into a bounded patch. The patch is validated, its blast
 * radius is measured, and an over-broad request is refused with an explanation
 * rather than silently re-rendering the whole reel.
 */
export async function interpretDirection(input: {
  projectId: string;
  utterance: string;
  profile?: Profile;
  deadlineAt?: number;
}): Promise<{ request: PatchRequest | null; route: string; usd: number; reason?: string }> {
  const { spec } = Specs.requireActive(input.projectId);
  const { system, user, schema } = patchPrompt({ spec, utterance: input.utterance });

  const result = await route<unknown>({
    task: "patch",
    projectId: input.projectId,
    identity: { utterance: input.utterance, specHash: sha256(JSON.stringify(spec)) },
    hint: { inputTokens: 1800, outputTokens: 500, thoughtTokens: 250 },
    codec: jsonCodec<unknown>(),
    profile: input.profile,
    deadlineAt: input.deadlineAt,
    real: async (model) => {
      const out = await generateJson<unknown>({
        model,
        system,
        parts: [{ text: user }],
        schema,
        thinking: "low",
        maxOutputTokens: 1600,
        temperature: 0.2,
        timeoutMs: LIMITS.timeoutMs.patch,
      });
      return out;
    },
    local: async () => localInterpret(spec, input.utterance),
  });

  // The local interpreter already speaks the internal dialect; a model answers in
  // the wire dialect it was asked for. Try the internal shape first, then decode.
  const direct = PatchRequestSchema.safeParse(result.value);
  if (direct.success) return { request: direct.data, route: result.route, usd: result.usd };

  const decoded = decodePatchResponse(result.value, spec);
  if (decoded.request) {
    const checked = PatchRequestSchema.safeParse(decoded.request);
    if (checked.success) return { request: checked.data, route: result.route, usd: result.usd };
  }

  return {
    request: null,
    route: result.route,
    usd: result.usd,
    reason: decoded.unsupported
      ? decoded.unsupported
      : "I could not turn that into a change I am allowed to make",
  };
}

/**
 * Keyword interpretation for the local path. Deliberately small: it covers the
 * handful of instructions a live demo actually uses and refuses everything else,
 * rather than guessing at arbitrary language.
 */
function localInterpret(spec: DirectorSpec, utterance: string): PatchRequest {
  const text = utterance.toLowerCase();
  const ops: PatchRequest["ops"] = [];
  const hero = spec.scenes.find((s) => s.purpose === "hero_drop");

  const sceneMatch = /scene\s*(\d+)|\bs(\d{1,2})\b/.exec(text);
  const targeted = sceneMatch
    ? spec.scenes[Number(sceneMatch[1] ?? sceneMatch[2]) - 1] ?? null
    : null;

  if (/(crazier|bigger|harder|more intense|wilder|more magical|epic)/.test(text)) {
    ops.push({ op: "event_intensity", kind: "drop", intensity: 1 });
    ops.push({ op: "music_energy", delta: 0.5 });
    if (hero) {
      ops.push({
        op: "add_motif",
        scene_ids: [hero.id],
        motif: "with a dramatic burst of light and swirling particles at the peak",
      });
    }
  }
  if (/(calmer|softer|gentler|quieter|slower)/.test(text)) {
    ops.push({ op: "event_intensity", kind: "drop", intensity: 0.55 });
    ops.push({ op: "music_energy", delta: -0.5 });
  }
  if (/(night|nighttime|dark|evening)/.test(text)) {
    // Naming a scene means that scene, not the whole film. Applying the global
    // lighting change as well would invalidate every shot and the request would
    // then be refused for being too broad — which is how a precise instruction
    // ends up looking like a reckless one.
    if (targeted) {
      ops.push({
        op: "scene_setting",
        scene_id: targeted.id,
        setting: `${targeted.setting}, at night under deep blue light with warm lamps`,
      });
    } else {
      ops.push({ op: "style_lighting", lighting: "night; cool moonlight with warm practical lamps" });
    }
  }
  if (/(closer|close.?up|tighter|on (her|his|their) face)/.test(text)) {
    const target = targeted ?? hero ?? spec.scenes[0];
    if (target) ops.push({ op: "scene_shot_size", scene_id: target.id, shot_size: "close" });
  } else if (/(wider|pull back|further back|show more of|establish)/.test(text)) {
    const target = targeted ?? hero ?? spec.scenes[0];
    if (target) ops.push({ op: "scene_shot_size", scene_id: target.id, shot_size: "wide" });
  }
  if (/(flower|blossom|petal)/.test(text)) {
    ops.push({
      op: "add_motif",
      scene_ids: targeted ? [targeted.id] : spec.scenes.slice(1, 4).map((s) => s.id),
      motif: "with drifting flower petals catching the light",
    });
  }
  if (/(friend|both of us|together|duet)/.test(text)) {
    ops.push({
      op: "attach_secondary",
      scene_ids: spec.scenes.filter((s) => s.purpose === "variation").map((s) => s.id),
    });
  }
  if (/(grain|film|texture)/.test(text)) {
    ops.push({ op: "style_grain", grain: /less|no /.test(text) ? 0.12 : 0.7 });
  }

  if (ops.length === 0) {
    // Nothing recognised: adjust nothing rather than inventing an edit.
    ops.push({ op: "style_grain", grain: spec.style_bible.grain });
  }

  return { summary: truncate(utterance.trim(), 150), ops: ops.slice(0, 10) };
}

/** Apply an already-interpreted patch, guarding against an over-broad change. */
export function commitDirection(input: {
  projectId: string;
  request: PatchRequest;
  force?: boolean;
}): LiveDirectionResult {
  const { version, spec } = Specs.requireActive(input.projectId);
  const result = applyPatch(spec, input.request);

  if (!input.force && isTooBroad(spec, result.impact)) {
    return {
      specVersion: version,
      summary: result.summary,
      impact: describeImpact(result.impact),
      invalidatedScenes: result.impact.invalidatedScenes,
      rejected: ["that change touches almost every scene; name a scene to target it"],
      accepted: false,
    };
  }

  // A version that is identical to the one before it is not a revision. Pushing it makes
  // the history claim a change that never happened, and hands the caller a success it can
  // report to the user.
  if (!result.impact.changed) {
    return {
      specVersion: version,
      summary: result.summary,
      impact: "nothing changed",
      invalidatedScenes: [],
      rejected: [
        result.applied.length > 0
          ? "that leaves the plan exactly as it was; say which scene to change and how"
          : "none of that could be turned into a change to this plan",
      ],
      accepted: false,
    };
  }

  const pushed = Specs.push({
    projectId: input.projectId,
    spec: result.spec,
    origin: "patch",
    note: result.summary,
  });

  Audit.record({
    projectId: input.projectId,
    actor: "user",
    action: "live_patch",
    payload: {
      summary: result.summary,
      applied: result.applied,
      rejected: result.rejected,
      impact: result.impact,
    },
  });

  // Drop the invalidated scenes' clips so the next render regenerates them and
  // reuses everything else.
  for (const sceneId of result.impact.invalidatedScenes) {
    const clip = Assets.byRole(input.projectId, sceneId, "scene_video");
    if (clip) Assets.setMeta(clip.id, { ...Assets.meta(clip), invalidated: true });
  }

  return {
    specVersion: pushed.version,
    summary: result.summary,
    impact: describeImpact(result.impact),
    invalidatedScenes: result.impact.invalidatedScenes,
    rejected: result.rejected.map((r) => `${r.op.op}: ${r.reason}`),
    accepted: true,
  };
}

/** Re-render the scenes a patch invalidated, then recompose. */
export async function runPatchRender(
  ctx: RunContext,
  payload: { sceneIds: string[]; regenerateMusic: boolean },
): Promise<PipelineResult> {
  const { version, spec } = Specs.requireActive(ctx.projectId);
  const profile = profileOf(ctx.projectId);

  Projects.advanceTo(ctx.projectId, "RENDERING");
  ctx.emit({ kind: "status", status: "RENDERING" });

  const vision = await visionFor(ctx.projectId, profile, ctx.deadlineAt);
  const references = await prepareReferences({ projectId: ctx.projectId, log: ctx.log });
  const targets = spec.scenes.filter((s) => payload.sceneIds.includes(s.id));

  // Say which shots are being left alone. The console has always had a "skip" state, and
  // nothing ever emitted one, so a re-render of two shots out of seven looked identical to
  // a run that had simply not got to the other five yet — the one thing somebody watching a
  // re-render actually wants to know.
  for (const scene of spec.scenes) {
    if (targets.some((t) => t.id === scene.id)) continue;
    ctx.emit({ kind: "scene", sceneId: scene.id, stage: "motion", state: "skip", attempt: 0 });
  }

  // The score is produced either way, because the composer needs its reconciled
  // anchors to place cuts. When the patch did not touch the music, the router's
  // cache returns the identical clip for free.
  const musicBranch = produceMusic({
    projectId: ctx.projectId,
    spec,
    specVersion: version,
    profile,
    uploadedAudio: Assets.byProject(ctx.projectId, "upload_audio")[0] ?? null,
    deadlineAt: ctx.deadlineAt,
    log: ctx.log,
  });

  // Re-rendering a shot has to allot generated video the same way a first render does.
  // Without this every revised shot arrives with no reservation, silently renders as a
  // still, and a re-render quietly strips the motion out of the film.
  const revisedPlan = planAnimation(spec, profile.name);
  const visualBranch = pool(targets, LIMITS.concurrency.scenes, (scene) =>
    renderSceneWithQc(ctx, {
      spec,
      specVersion: version,
      scene,
      keyframe: null,
      vision,
      references,
      profile,
      animated: revisedPlan,
    }),
  );

  const [music, revised] = await Promise.all([musicBranch, visualBranch]);
  const outcomes = collectExistingOutcomes(ctx.projectId, spec, ...revised);

  const { reel, check } = await stageCompose(ctx, {
    spec,
    specVersion: version,
    outcomes,
    music,
    vision,
  });

  Projects.advanceTo(ctx.projectId, "READY");
  ctx.emit({ kind: "status", status: "READY" });
  const meta = Assets.meta<{ durationS?: number }>(reel);
  ctx.emit({ kind: "done", outputUrl: urlFor(reel), durationS: meta.durationS ?? 0 });

  return {
    specVersion: version,
    outputUrl: urlFor(reel),
    durationS: meta.durationS ?? 0,
    scenes: outcomes.length,
    spentUsd: 0,
    warnings: [],
    checkOk: check.ok,
  };
}

export interface RecutResult {
  editId: EditStyleId;
  label: string;
  outputUrl: string;
  durationS: number;
  cuts: number[];
  checkOk: boolean;
}

/**
 * Re-cut an existing film in a different edit style.
 *
 * Nothing is generated: the shots, the score and the frames already exist, so this
 * is deterministic code over material that is already paid for. It is the useful
 * consequence of keeping generation and composition apart, and it costs nothing.
 */
export async function runRecut(
  ctx: RunContext,
  payload: { editId: EditStyleId },
): Promise<RecutResult> {
  const { version, spec } = Specs.requireActive(ctx.projectId);
  const profile = profileOf(ctx.projectId);
  const edit = editStyle(payload.editId);

  ctx.emit({ kind: "stage", stage: `recut: ${edit.label}`, state: "start", detail: edit.blurb });

  const vision = await visionFor(ctx.projectId, profile, ctx.deadlineAt);
  // The score is already cached, so this returns the same audio for nothing and
  // gives the reconciliation the composer needs.
  const music = await produceMusic({
    projectId: ctx.projectId,
    spec,
    specVersion: version,
    profile,
    uploadedAudio: Assets.byProject(ctx.projectId, "upload_audio")[0] ?? null,
    deadlineAt: ctx.deadlineAt,
    log: ctx.log,
  });

  const outcomes = collectExistingOutcomes(ctx.projectId, spec);
  if (outcomes.every((o) => !o.clip)) {
    throw new MuseError("permanent", "there are no shots to re-cut yet");
  }

  const { reel, manifest, check } = await stageCompose(ctx, {
    spec,
    specVersion: version,
    outcomes,
    music,
    vision,
    edit,
  });

  Projects.advanceTo(ctx.projectId, "READY");
  ctx.emit({ kind: "status", status: "READY" });
  ctx.emit({ kind: "stage", stage: `recut: ${edit.label}`, state: "done" });

  const meta = Assets.meta<{ durationS?: number }>(reel);
  return {
    editId: edit.id,
    label: edit.label,
    outputUrl: urlFor(reel),
    durationS: meta.durationS ?? 0,
    cuts: manifest.clips.slice(1).map((c) => c.startS),
    checkOk: check.ok,
  };
}

/** Recompose from existing assets. Cheapest possible revision. */
export async function runRecompose(ctx: RunContext): Promise<PipelineResult> {
  const { version, spec } = Specs.requireActive(ctx.projectId);
  const profile = profileOf(ctx.projectId);
  const vision = await visionFor(ctx.projectId, profile, ctx.deadlineAt);
  const music = await produceMusic({
    projectId: ctx.projectId,
    spec,
    specVersion: version,
    profile,
    uploadedAudio: Assets.byProject(ctx.projectId, "upload_audio")[0] ?? null,
    deadlineAt: ctx.deadlineAt,
    log: ctx.log,
  });
  const outcomes = collectExistingOutcomes(ctx.projectId, spec);
  const { reel, check } = await stageCompose(ctx, {
    spec,
    specVersion: version,
    outcomes,
    music,
    vision,
  });
  Projects.advanceTo(ctx.projectId, "READY");
  ctx.emit({ kind: "status", status: "READY" });
  const meta = Assets.meta<{ durationS?: number }>(reel);
  ctx.emit({ kind: "done", outputUrl: urlFor(reel), durationS: meta.durationS ?? 0 });
  return {
    specVersion: version,
    outputUrl: urlFor(reel),
    durationS: meta.durationS ?? 0,
    scenes: outcomes.length,
    spentUsd: 0,
    warnings: [],
    checkOk: check.ok,
  };
}

// ── registration ─────────────────────────────────────────────────────────────

/**
 * Wire the pipeline into the job runner. Called once from the module that owns
 * server startup, so route handlers only ever schedule work by name.
 */
export function registerPipelineHandlers(): void {
  register("pipeline", (ctx) => runPipeline(ctx));
  register<{ sceneId: string }>("scene_revision", (ctx, payload) => runSceneRevision(ctx, payload));
  register<{ sceneIds: string[]; regenerateMusic: boolean }>("patch_render", (ctx, payload) =>
    runPatchRender(ctx, payload),
  );
  register("recompose", (ctx) => runRecompose(ctx));
  register<{ editId: EditStyleId }>("recut", (ctx, payload) => runRecut(ctx, payload));
}

export { stageCompose, stageDirect, stageStoryboard };
export type { SceneOutcome };
