/**
 * View models. One place that shapes database rows into the objects the UI
 * renders, so a component never has to know a column name and a schema change
 * does not ripple into JSX.
 *
 * Everything here is serialisable and free of Buffers or absolute paths: the
 * client receives asset URLs, never filesystem locations.
 */
import { PROFILES, PROFILE_NAMES, readEnv, profileFor, type ProfileName, type Task, typicalVideoSeconds } from "@/lib/core/config";
import { round } from "@/lib/core/util";
import { Assets, AgentSteps, Ledger, Projects, Qc, Renders, SceneJobs, Specs, MusicJobs, Jobs } from "@/lib/db/repo";
import type { ProjectRow } from "@/lib/db/types";
import { budget } from "@/lib/models/governor";
import { describeRoute } from "@/lib/models/router";
import { hasApiKey } from "@/lib/models/gemini";
import { cache } from "@/lib/models/cache";
import { sceneDuration, shotSize, type DirectorSpec } from "@/lib/spec/directorSpec";
import { listBundles } from "@/lib/templates/bundles";
import { urlFor } from "@/lib/services/assets";
import { activeKind, isRunning } from "@/lib/jobs/runner";
import { clipDurationFor } from "@/lib/compose/plan";
import { EDIT_STYLES, EDIT_STYLE_IDS, OFFERED_STYLES, editRole } from "@/lib/compose/edit";
import { skillNames } from "@/lib/agent/skills";

// ── scenes ───────────────────────────────────────────────────────────────────

export type SceneStatus = "pending" | "running" | "done" | "fallback" | "failed";

export interface SceneView {
  id: string;
  startS: number;
  endS: number;
  durationS: number;
  clipDurationS: number;
  purpose: string;
  renderMode: string;
  camera: string;
  /** How far the camera sits, so the plan reads as a shot list. */
  shotSize: string;
  transitionIn: string;
  action: string;
  setting: string;
  title?: string;
  status: SceneStatus;
  keyframeUrl: string | null;
  clipUrl: string | null;
  route: string | null;
  generated: boolean;
  fallbackReason: string | null;
  qc: {
    decision: string;
    scores: Record<string, number>;
    overall: number;
    repairInstruction: string;
    source: string;
  } | null;
  attempts: number;
}

export function sceneStatus(input: {
  hasKeyframe: boolean;
  hasClip: boolean;
  running: boolean;
  decision: string | null;
  fallback: boolean;
  /**
   * The run that was producing this scene ended in failure and is not still going.
   *
   * Failure is only recorded per run, not per scene: nothing writes scene_jobs, and a QC
   * row is always created alongside its asset, so "a rejected verdict with no clip" is a
   * state that cannot occur. The run-level signal is the only durable one there is, which
   * means a scene is called failed because the attempt to make it died, not because the
   * scene itself reported anything.
   */
  runFailed: boolean;
}): SceneStatus {
  if (input.running && !input.hasClip) return "running";
  // A dead scene used to read as running or pending for ever, because no path here
  // returned "failed" — the previous attempt at this tested two signals that are never
  // written, so the branch was unreachable. Tested after `running`, since a run in flight
  // may still get to the scene, and before the empty-scene case which would swallow it.
  if (input.runFailed && !input.hasClip) return "failed";
  if (!input.hasKeyframe && !input.hasClip) return "pending";
  if (input.hasClip && input.decision === "FALLBACK") return "fallback";
  if (input.hasClip && input.fallback) return "fallback";
  if (input.hasClip) return "done";
  if (input.hasKeyframe) return "running";
  return "pending";
}

export function sceneViews(projectId: string, spec: DirectorSpec): SceneView[] {
  const running = isRunning(projectId);
  // Read once for the whole list rather than per scene: it is one query and it is the
  // same answer for every scene in the project.
  const runFailed = !running && Jobs.byProject(projectId).some((j) => j.status === "failed");
  return spec.scenes.map((scene) => {
    const keyframe = Assets.byRole(projectId, scene.id, "keyframe");
    const clip = Assets.byRole(projectId, scene.id, "scene_video");
    const qc = Qc.latestForScene(projectId, scene.id);
    const meta = clip
      ? Assets.meta<{ route?: string; generated?: boolean; fallbackReason?: string | null }>(clip)
      : {};
    const jobs = SceneJobs.byProject(projectId).filter((j) => j.scene_id === scene.id);
    const scores = qc ? (JSON.parse(qc.scores_json) as Record<string, number>) : null;

    return {
      id: scene.id,
      startS: scene.start_s,
      endS: scene.end_s,
      durationS: sceneDuration(scene),
      clipDurationS: clipDurationFor(spec, scene),
      purpose: scene.purpose,
      renderMode: scene.render_mode,
      camera: scene.camera,
      shotSize: shotSize(scene),
      transitionIn: scene.transition_in,
      action: scene.action,
      setting: scene.setting,
      ...(scene.title ? { title: scene.title } : {}),
      status: sceneStatus({
        hasKeyframe: Boolean(keyframe),
        hasClip: Boolean(clip),
        running,
        decision: qc?.decision ?? null,
        fallback: Boolean(meta.fallbackReason),
        runFailed,
      }),
      keyframeUrl: keyframe ? urlFor(keyframe) : null,
      clipUrl: clip ? urlFor(clip) : null,
      route: meta.route ?? null,
      generated: Boolean(meta.generated),
      fallbackReason: meta.fallbackReason ?? null,
      qc: qc && scores
        ? {
            decision: qc.decision,
            scores,
            overall: round(
              Object.values(scores).reduce((a, b) => a + b, 0) / Math.max(1, Object.values(scores).length),
              3,
            ),
            repairInstruction: qc.repair_instruction,
            source: qc.source,
          }
        : null,
      attempts: Math.max(0, ...jobs.map((j) => j.attempt), 0),
    };
  });
}

// ── project ──────────────────────────────────────────────────────────────────

export interface ProjectView {
  id: string;
  title: string;
  mode: string;
  status: string;
  preset: string;
  profile: string;
  brief: string;
  consent: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  runningKind: string | null;
  specVersion: number | null;
  spec: {
    title: string;
    logline: string;
    durationS: number;
    preset: string;
    palette: string[];
    lighting: string;
    medium: string;
    grain: number;
    music: { mode: string; bpm: number; key: string; mood: string; instrumentation: string[] };
    events: { t: number; kind: string; intensity: number; visual: string }[];
  } | null;
  scenes: SceneView[];
  uploads: { id: string; url: string; bytes: number; mime: string }[];
  uploadedAudio: { id: string; url: string; bytes: number } | null;
  subjectSheetUrl: string | null;
  music: {
    url: string | null;
    route: string | null;
    bpm: number | null;
    durationS: number | null;
    fromFallback: boolean;
    snapped: number | null;
    unmatched: string[];
    maxDeltaS: number | null;
    anchors: number[];
    energy: { t: number; v: number }[];
  } | null;
  reel: {
    url: string;
    posterUrl: string | null;
    durationS: number;
    bytes: number;
    checkOk: boolean;
    issues: string[];
    anchors: number[];
  } | null;
  history: { version: number; origin: string; note: string; createdAt: string }[];
  /**
   * Alternative readings of the same footage. Composition is deterministic and the
   * material is already paid for, so every one of these is free and instant.
   */
  edits: {
    id: string;
    label: string;
    blurb: string;
    offered: boolean;
    url: string | null;
    durationS: number | null;
    cuts: number[];
  }[];
}

export function projectView(projectId: string): ProjectView | null {
  const p = Projects.get(projectId);
  if (!p) return null;
  const active = Specs.active(projectId);
  const uploads = Assets.byProject(projectId, "upload_image");
  const audio = Assets.byProject(projectId, "upload_audio")[0] ?? null;
  const sheet = Assets.byProject(projectId, "subject_sheet").slice(-1)[0] ?? null;
  const music = Assets.byProject(projectId, "music").slice(-1)[0] ?? null;
  const reel = Assets.byRole(projectId, "final", "reel");
  const poster = Assets.byRole(projectId, "final", "poster");

  const musicMeta = music
    ? Assets.meta<{
        route?: string;
        bpm?: number;
        durationS?: number;
        fromFallback?: boolean;
        snapped?: number;
        unmatched?: string[];
        maxDeltaS?: number;
      }>(music)
    : null;
  const musicJob = MusicJobs.latest(projectId);
  const actualMap = musicJob
    ? (JSON.parse(musicJob.actual_map || "{}") as {
        anchors?: { t: number }[];
        energy?: { t: number; v: number }[];
      })
    : {};

  const reelMeta = reel
    ? Assets.meta<{
        durationS?: number;
        bytes?: number;
        check?: { ok?: boolean; issues?: string[] };
        anchors?: number[];
      }>(reel)
    : null;

  return {
    id: p.id,
    title: p.title,
    mode: p.mode,
    status: p.status,
    preset: p.preset,
    profile: p.profile,
    brief: p.brief,
    consent: p.consent === 1,
    error: p.error,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    running: isRunning(projectId),
    runningKind: activeKind(projectId),
    specVersion: active?.version ?? null,
    spec: active
      ? {
          title: active.spec.title,
          logline: active.spec.logline,
          durationS: active.spec.duration_s,
          preset: active.spec.style_bible.preset,
          palette: active.spec.style_bible.palette,
          lighting: active.spec.style_bible.lighting,
          medium: active.spec.style_bible.medium,
          grain: active.spec.style_bible.grain,
          music: {
            mode: active.spec.music.mode,
            bpm: active.spec.music.bpm_target,
            key: active.spec.music.key,
            mood: active.spec.music.mood,
            instrumentation: active.spec.music.instrumentation,
          },
          events: active.spec.events.map((e) => ({
            t: e.t,
            kind: e.kind,
            intensity: e.intensity,
            visual: e.visual,
          })),
        }
      : null,
    scenes: active ? sceneViews(projectId, active.spec) : [],
    uploads: uploads.map((u) => ({ id: u.id, url: urlFor(u), bytes: u.bytes, mime: u.mime })),
    uploadedAudio: audio ? { id: audio.id, url: urlFor(audio), bytes: audio.bytes } : null,
    subjectSheetUrl: sheet ? urlFor(sheet) : null,
    music: music
      ? {
          url: urlFor(music),
          route: musicMeta?.route ?? null,
          bpm: musicMeta?.bpm ?? null,
          durationS: musicMeta?.durationS ?? null,
          fromFallback: Boolean(musicMeta?.fromFallback),
          snapped: musicMeta?.snapped ?? null,
          unmatched: musicMeta?.unmatched ?? [],
          maxDeltaS: musicMeta?.maxDeltaS ?? null,
          anchors: (actualMap.anchors ?? []).map((a) => a.t),
          energy: actualMap.energy ?? [],
        }
      : null,
    reel: reel
      ? {
          url: urlFor(reel),
          posterUrl: poster ? urlFor(poster) : null,
          durationS: reelMeta?.durationS ?? 0,
          bytes: reelMeta?.bytes ?? reel.bytes,
          checkOk: reelMeta?.check?.ok !== false,
          issues: reelMeta?.check?.issues ?? [],
          anchors: reelMeta?.anchors ?? [],
        }
      : null,

    history: Specs.history(projectId).map((h) => ({
      version: h.version,
      origin: h.origin,
      note: h.note,
      createdAt: h.created_at,
    })),
    edits: EDIT_STYLE_IDS.map((editId) => {
      const row = Assets.byRole(projectId, editRole(editId), "reel");
      const m = row ? Assets.meta<{ durationS?: number; cuts?: number[] }>(row) : null;
      return {
        id: editId,
        label: EDIT_STYLES[editId].label,
        blurb: EDIT_STYLES[editId].blurb,
        offered: OFFERED_STYLES.includes(editId),
        url: row ? urlFor(row) : null,
        durationS: m?.durationS ?? null,
        cuts: m?.cuts ?? [],
      };
    }),
  };
}

/**
 * One finished film, for the front door.
 *
 * The product's whole claim is that a sentence becomes a directed film, and a
 * visitor who has not made one yet has no way to see that. So the most recent
 * finished reel is shown with the sentence that produced it and the shot list it
 * was cut from — the evidence, next to the claim.
 */
export interface FeaturedFilm {
  id: string;
  title: string;
  /** The sentence somebody typed. This is the input, so it leads. */
  brief: string;
  logline: string | null;
  reelUrl: string;
  posterUrl: string | null;
  durationS: number;
  shots: { id: string; shotSize: string; camera: string; durationS: number }[];
  /**
   * Distinct shot sizes over total shots. Null for a film directed before shot size
   * was a field: those resolve to a default per purpose, which is right for
   * re-rendering the film unchanged but would misdescribe what was actually shot.
   */
  coverage: { sizes: number; shots: number } | null;
  /** Worst distance from a cut to a measured accent, in milliseconds. */
  cutDriftMs: number | null;
  bpm: number | null;
}

export function featuredFilmView(): FeaturedFilm | null {
  for (const project of Projects.list()) {
    const reel = Assets.byRole(project.id, "final", "reel");
    if (!reel) continue;
    const active = Specs.active(project.id);
    if (!active) continue;

    const reelMeta = Assets.meta<{ durationS?: number }>(reel);
    const poster = Assets.byRole(project.id, "final", "poster");
    const scenes = active.spec.scenes;

    const score = Assets.byRole(project.id, "score", "music");
    const bpm = score ? (Assets.meta<{ bpm?: number }>(score).bpm ?? null) : null;

    // Cuts have to come from the manifest, not the spec. Snapping moves a boundary
    // onto a measured accent during composition and is deliberately not written back
    // to the plan, so a spec start time is where the cut was *asked* for. Measuring
    // the plan against the music reports the error the snapping exists to remove.
    const render = Renders.latestDone(project.id);
    const manifest = render ? safeManifest(render.manifest_json) : null;
    const cuts = (manifest?.clips ?? []).slice(1).map((c) => c.startS);
    const anchors = manifest?.anchorsS ?? [];
    const cutDriftMs =
      cuts.length > 0 && anchors.length > 0
        ? Math.round(
            Math.max(...cuts.map((t) => Math.min(...anchors.map((a) => Math.abs(a - t))))) * 1000,
          )
        : null;

    const declared = scenes.every((sc) => sc.shot_size !== undefined);
    const sizes = scenes.map((sc) => shotSize(sc));

    return {
      id: project.id,
      title: active.spec.title,
      brief: project.brief,
      logline: active.spec.logline,
      reelUrl: urlFor(reel),
      posterUrl: poster ? urlFor(poster) : null,
      durationS: reelMeta?.durationS ?? active.spec.duration_s,
      shots: scenes.map((sc) => ({
        id: sc.id,
        shotSize: shotSize(sc),
        camera: sc.camera,
        durationS: sceneDuration(sc),
      })),
      coverage: declared ? { sizes: new Set(sizes).size, shots: scenes.length } : null,
      cutDriftMs,
      bpm,
    };
  }
  return null;
}

/** A stored manifest is trusted but still parsed defensively; it outlives the code. */
function safeManifest(json: string): { clips?: { startS: number }[]; anchorsS?: number[] } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as { clips?: { startS: number }[]; anchorsS?: number[] };
  } catch {
    return null;
  }
}
export function projectListView(): {
  id: string;
  title: string;
  status: string;
  preset: string;
  createdAt: string;
  posterUrl: string | null;
  reelUrl: string | null;
}[] {
  return Projects.list().map((p: ProjectRow) => {
    const poster = Assets.byRole(p.id, "final", "poster");
    const reel = Assets.byRole(p.id, "final", "reel");
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      preset: p.preset,
      createdAt: p.created_at,
      posterUrl: poster ? urlFor(poster) : null,
      reelUrl: reel ? urlFor(reel) : null,
    };
  });
}

// ── capabilities ─────────────────────────────────────────────────────────────

export interface CapabilityView {
  hasApiKey: boolean;
  activeProfile: string;
  cacheEnabled: boolean;
  cache: { entries: number; bytes: number };
  budget: { ceilingUsd: number; spentUsd: number; remainingUsd: number };
  profiles: {
    name: string;
    label: string;
    blurb: string;
    estimateUsd: number;
    routes: { task: string; route: string; model: string | null; estimateUsd: number }[];
    videoSecondsBudget: number;
    imageSize: string;
  }[];
  presets: { id: string; label: string; blurb: string; swatches: string[] }[];
  skills: string[];
}

const TASKS: Task[] = ["director", "vision", "keyframe", "video", "music", "critic", "patch"];

/** Estimated cost of one full reel under a profile, for the UI's picker. */
export function estimateProfile(name: ProfileName): {
  totalUsd: number;
  routes: { task: string; route: string; model: string | null; estimateUsd: number }[];
} {
  const profile = PROFILES[name];
  // A representative reel: one director pass, one vision pass, six keyframes,
  // one score, one hero video, six critic passes.
  const counts: Record<Task, number> = {
    director: 1,
    vision: 1,
    keyframe: 6,
    // Bounded by the seconds allowance as well as the scene cap, because a profile
    // that permits seven animated shots but budgets four clips' worth makes four calls.
    video: Math.min(
      profile.maxGeneratedVideoScenes,
      Math.floor(profile.videoSecondsBudget / typicalVideoSeconds()),
    ),
    music: 1,
    critic: 6,
    patch: 0,
  };
  const routes = TASKS.map((task) => {
    const d = describeRoute(task, profile);
    return { task, route: d.route, model: d.model, estimateUsd: round(d.estimateUsd, 5) };
  });
  const totalUsd = round(
    routes.reduce((acc, r) => acc + r.estimateUsd * (counts[r.task as Task] ?? 0), 0),
    4,
  );
  return { totalUsd, routes };
}

/**
 * The profile a new project should use.
 *
 * An explicit MUSE_PROFILE is an operator decision and is honoured. Otherwise the
 * richest profile whose projected cost fits twice over in the remaining ceiling
 * wins — twice, so a demo can be run and then revised without the second attempt
 * being refused. `hero` and `max` are never chosen automatically: they double the
 * cost and add minutes for one generated shot, which is a deliberate choice rather
 * than a default.
 */
export function autoProfile(): ProfileName {
  const env = readEnv();
  if (env.profileExplicit) return env.profile;
  if (!hasApiKey()) return "local";

  const remaining = budget().remainingUsd;
  for (const name of ["standard", "wiring"] as ProfileName[]) {
    const projected = estimateProfile(name).totalUsd;
    if (projected > 0 && projected * 2 <= remaining) return name;
  }
  return "local";
}

export function capabilityView(): CapabilityView {
  const env = readEnv();
  const b = budget();
  return {
    hasApiKey: hasApiKey(),
    activeProfile: env.profile,
    cacheEnabled: env.cacheEnabled,
    cache: cache.stats(),
    budget: { ceilingUsd: b.ceilingUsd, spentUsd: b.spentUsd, remainingUsd: b.remainingUsd },
    profiles: PROFILE_NAMES.map((name) => {
      const p = PROFILES[name];
      const est = estimateProfile(name);
      return {
        name,
        label: p.label,
        blurb: p.blurb,
        estimateUsd: est.totalUsd,
        routes: est.routes,
        videoSecondsBudget: p.videoSecondsBudget,
        imageSize: p.imageSize,
      };
    }),
    presets: listBundles().map((b2) => ({
      id: b2.id,
      label: b2.label,
      blurb: b2.blurb,
      swatches: b2.swatches,
    })),
    skills: skillNames(),
  };
}

// ── agent transcript ─────────────────────────────────────────────────────────

export interface AgentStepView {
  seq: number;
  kind: string;
  name: string;
  summary: string;
  at: string;
  payload: unknown;
}

export function agentTranscript(projectId: string, runId?: string): {
  runId: string | null;
  steps: AgentStepView[];
} {
  const id = runId ?? AgentSteps.latestRun(projectId) ?? null;
  if (!id) return { runId: null, steps: [] };
  return {
    runId: id,
    steps: AgentSteps.byRun(projectId, id).map((s) => {
      const payload = JSON.parse(s.payload_json) as Record<string, unknown>;
      return {
        seq: s.seq,
        kind: s.kind,
        name: s.name,
        summary: summaryOf(s.kind, s.name, payload),
        at: s.created_at,
        payload,
      };
    }),
  };
}

function summaryOf(kind: string, name: string, payload: Record<string, unknown>): string {
  if (typeof payload.summary === "string") return payload.summary;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.text === "string") return payload.text;
  if (kind === "tool_call") return name;
  return name || kind;
}

// ── render diagnostics ───────────────────────────────────────────────────────


export { profileFor };
