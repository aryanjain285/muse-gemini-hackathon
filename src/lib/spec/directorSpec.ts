/**
 * DirectorSpec — the versioned contract every downstream component consumes.
 * If it validates, the rest of MUSE can render it; if it does not, the Director
 * is asked to repair it rather than the pipeline guessing.
 *
 * Two details exist so the deterministic composer can act without having to
 * interpret prose:
 *   - `camera` is an enum of moves the composer can actually execute, with a
 *     free-text `camera_note` carried through to generative video prompts.
 *   - `transition_in` names a primitive from the approved library instead of
 *     leaving the cut to generated video.
 */
import { z } from "zod";
import { OUTPUT, LIMITS } from "@/lib/core/config";
import { round } from "@/lib/core/util";

// ── enums ────────────────────────────────────────────────────────────────────

export const RENDER_MODES = [
  "source_motion", // original/stylised photo + pan/zoom/parallax — cheapest, most reliable
  "stylized_keyframe", // generated still + deterministic camera move
  "image_to_video", // animate an approved keyframe — primary generated-motion path
  "text_reference_video", // hero scene with references
  "collage", // multiple images + masks/overlays — beat montage
] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

/** Which render modes actually call a video model. */
export const GENERATIVE_MODES: RenderMode[] = ["image_to_video", "text_reference_video"];

export const EVENT_KINDS = [
  "intro",
  "accent",
  "build",
  "drop",
  "variation",
  "resolve",
  "final_hit",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const SCENE_PURPOSES = [
  "recognition",
  "world_opens",
  "motion_begins",
  "build",
  "hero_drop",
  "variation",
  "resolution",
] as const;
export type ScenePurpose = (typeof SCENE_PURPOSES)[number];

/**
 * How far the camera sits from what it is looking at.
 *
 * Coverage — deliberately varying this from shot to shot — is most of what
 * separates a directed sequence from several pictures of the same thing. It is a
 * first-class field rather than prose inside `setting` because it has to be
 * enforceable: the Director chooses it, `normalize` guarantees the film varies,
 * the image prompt places the subject differently at each distance, and the
 * critic judges framing against the size that was actually asked for.
 */
export const SHOT_SIZES = ["wide", "full", "medium", "close", "extreme_close", "detail"] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];

/** Sizes close enough to read an expression. */
const TIGHT_SIZES: ShotSize[] = ["close", "extreme_close", "detail"];

/**
 * The size each purpose implies when the Director does not say. Also what a spec
 * stored before `shot_size` existed resolves to, which keeps old projects
 * renderable and their re-cuts identical.
 */
const DEFAULT_SHOT_SIZE: Record<ScenePurpose, ShotSize> = {
  recognition: "close",
  world_opens: "wide",
  motion_begins: "medium",
  build: "extreme_close",
  hero_drop: "full",
  variation: "detail",
  resolution: "wide",
};

/**
 * Camera moves the composer implements exactly. Anything a model wants that is
 * not on this list arrives as `camera_note` and only influences prompts.
 */
export const CAMERA_MOVES = [
  "static",
  "push_in",
  "pull_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "dolly_out",
  "parallax_drift",
  "handheld_drift",
  "whip",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

/** Approved transition library: a small set, always applied by code. */
export const TRANSITIONS = [
  "cut",
  "crossfade",
  "dip_to_black",
  "dip_to_white",
  "flash",
  "whip_pan",
  "luma_wipe",
  "film_burn",
  "match_cut",
] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const MUSIC_MODES = ["generated", "uploaded"] as const;
export type MusicMode = (typeof MUSIC_MODES)[number];

// ── schema ───────────────────────────────────────────────────────────────────

export const StyleBibleSchema = z.object({
  preset: z.string().min(1),
  /** Short palette phrases reused verbatim in every scene prompt. */
  palette: z.array(z.string().min(1)).min(2).max(6),
  /** Immutable identity traits, carried into every scene prompt. */
  character_rules: z.array(z.string().min(1)).max(10).default([]),
  /** Negative constraints appended to every prompt. */
  negative_rules: z.array(z.string().min(1)).max(14).default([]),
  /** One lighting sentence applied across all scenes for continuity. */
  lighting: z.string().min(1).default("warm low-angle light with soft falloff"),
  /** Rendering medium, e.g. "loose gouache painting with visible brush texture". */
  medium: z.string().min(1).default("painterly illustration with visible brush texture"),
  /** Grain / bloom / halation intensity, 0..1, applied by the composer. */
  grain: z.number().min(0).max(1).default(0.35),
});
export type StyleBible = z.infer<typeof StyleBibleSchema>;

export const MusicPlanSchema = z.object({
  mode: z.enum(MUSIC_MODES),
  bpm_target: z.number().min(60).max(190),
  mood: z.string().min(1),
  /** Instrument families the brief asks for. */
  instrumentation: z.array(z.string().min(1)).max(8).default([]),
  /** Energy 0..1 sampled at each event, used to build the density curve. */
  key: z.string().default("A minor"),
  /** Region, in seconds, where density should rise. */
  build_region_s: z.tuple([z.number(), z.number()]).optional(),
  drop_at_s: z.number().optional(),
  resolve_at_s: z.number().optional(),
});
export type MusicPlan = z.infer<typeof MusicPlanSchema>;

export const TimelineEventSchema = z.object({
  t: z.number().min(0).max(120),
  kind: z.enum(EVENT_KINDS),
  /** What the visuals must do at this instant. Free text, used in prompts. */
  visual: z.string().min(1),
  /** 0..1 target intensity, drives both music density and composer effects. */
  intensity: z.number().min(0).max(1).default(0.5),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const SceneSchema = z.object({
  id: z.string().regex(/^s\d{2}$/, "scene id must look like s01"),
  start_s: z.number().min(0),
  end_s: z.number().min(0),
  purpose: z.enum(SCENE_PURPOSES),
  render_mode: z.enum(RENDER_MODES),
  /** Asset ids this scene may reference: subject sheet, prior keyframe, uploads. */
  reference_asset_ids: z.array(z.string()).default([]),
  camera: z.enum(CAMERA_MOVES),
  camera_note: z.string().default(""),
  /** How far the camera sits. Optional so specs stored before it existed still validate. */
  shot_size: z.enum(SHOT_SIZES).optional(),
  /** What happens on screen. Each scene does exactly one visual thing. */
  action: z.string().min(1),
  /** Prompt fragment describing the setting, appended to the StyleBible. */
  setting: z.string().default(""),
  transition_in: z.enum(TRANSITIONS).default("cut"),
  /** Semantic retry allowance. The hero scene gets more. */
  retry_budget: z.number().int().min(0).max(3).default(1),
  /** Optional on-screen title, drawn deterministically by the composer. */
  title: z.string().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const DirectorSpecSchema = z.object({
  spec_version: z.literal("1.0"),
  /** Short human title for the reel; shown in the UI and the export filename. */
  title: z.string().min(1).max(80),
  /** One sentence describing the film the Director believes it is making. */
  logline: z.string().min(1).max(300),
  duration_s: z.number().min(12).max(45),
  aspect_ratio: z.literal("9:16"),
  style_bible: StyleBibleSchema,
  music: MusicPlanSchema,
  events: z.array(TimelineEventSchema).min(3).max(12),
  scenes: z.array(SceneSchema).min(3).max(9),
});
export type DirectorSpec = z.infer<typeof DirectorSpecSchema>;

// ── validation ───────────────────────────────────────────────────────────────

export interface SpecIssue {
  path: string;
  message: string;
  /** `hard` blocks rendering; `soft` is normalised automatically. */
  severity: "hard" | "soft";
}

export interface ValidationResult {
  ok: boolean;
  spec: DirectorSpec | null;
  issues: SpecIssue[];
}

/**
 * Structural checks the zod schema cannot express: scene coverage, ordering,
 * event placement, exactly one hero. This is where timeline overlaps and gaps
 * are caught.
 */
export function checkStructure(spec: DirectorSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const scenes = [...spec.scenes].sort((a, b) => a.start_s - b.start_s);

  if (scenes.length < LIMITS.minScenes || scenes.length > LIMITS.maxScenes) {
    issues.push({
      path: "scenes",
      message: `expected ${LIMITS.minScenes}-${LIMITS.maxScenes} scenes, got ${scenes.length}`,
      severity: "soft",
    });
  }

  const ids = new Set<string>();
  for (const s of scenes) {
    if (ids.has(s.id)) {
      issues.push({ path: `scenes.${s.id}`, message: "duplicate scene id", severity: "hard" });
    }
    ids.add(s.id);
    if (s.end_s <= s.start_s) {
      issues.push({
        path: `scenes.${s.id}`,
        message: `end_s (${s.end_s}) must exceed start_s (${s.start_s})`,
        severity: "hard",
      });
    }
    const dur = s.end_s - s.start_s;
    if (dur < 1.2) {
      issues.push({
        path: `scenes.${s.id}`,
        message: `scene is ${round(dur, 2)}s; under 1.2s reads as a glitch`,
        severity: "soft",
      });
    }
    if (dur > 9) {
      issues.push({
        path: `scenes.${s.id}`,
        message: `scene is ${round(dur, 2)}s; over 9s stalls a 30s reel`,
        severity: "soft",
      });
    }
  }

  // Coverage: no gaps, no overlaps, starts at 0, ends at duration.
  if (scenes.length > 0) {
    if (Math.abs(scenes[0].start_s) > 0.001) {
      issues.push({
        path: "scenes[0].start_s",
        message: `first scene starts at ${scenes[0].start_s}, must be 0`,
        severity: "soft",
      });
    }
    for (let i = 1; i < scenes.length; i++) {
      const gap = round(scenes[i].start_s - scenes[i - 1].end_s, 3);
      if (Math.abs(gap) > 0.001) {
        issues.push({
          path: `scenes.${scenes[i].id}`,
          message: gap > 0 ? `${gap}s gap before this scene` : `${-gap}s overlap with previous scene`,
          severity: "soft",
        });
      }
    }
    const last = scenes[scenes.length - 1];
    if (Math.abs(last.end_s - spec.duration_s) > 0.001) {
      issues.push({
        path: `scenes.${last.id}.end_s`,
        message: `last scene ends at ${last.end_s}, duration is ${spec.duration_s}`,
        severity: "soft",
      });
    }
  }

  // Exactly one hero drop, and it must be a generative-capable slot.
  const heroes = scenes.filter((s) => s.purpose === "hero_drop");
  if (heroes.length === 0) {
    issues.push({ path: "scenes", message: "no hero_drop scene", severity: "soft" });
  } else if (heroes.length > 1) {
    issues.push({
      path: "scenes",
      message: `${heroes.length} hero_drop scenes; the drop must be singular`,
      severity: "soft",
    });
  }

  // Events must be sorted, in range, and contain the load-bearing beats.
  for (let i = 1; i < spec.events.length; i++) {
    if (spec.events[i].t < spec.events[i - 1].t) {
      issues.push({ path: "events", message: "events are not in time order", severity: "soft" });
      break;
    }
  }
  for (const e of spec.events) {
    if (e.t > spec.duration_s + 0.001) {
      issues.push({
        path: `events.${e.kind}`,
        message: `event at ${e.t}s is past the ${spec.duration_s}s duration`,
        severity: "soft",
      });
    }
  }
  for (const required of ["drop", "final_hit"] as EventKind[]) {
    if (!spec.events.some((e) => e.kind === required)) {
      issues.push({ path: "events", message: `missing ${required} event`, severity: "soft" });
    }
  }

  if (Math.abs(spec.duration_s - OUTPUT.durationS) > 12) {
    issues.push({
      path: "duration_s",
      message: `duration ${spec.duration_s}s is far from the ${OUTPUT.durationS}s target`,
      severity: "soft",
    });
  }

  return issues;
}

/**
 * Normalise a spec that is structurally repairable: sort, renumber, close gaps,
 * clamp events into range. Returns a spec that passes `checkStructure` for every
 * soft issue we know how to fix, which keeps one malformed model response from
 * costing a render.
 */
/** The size furthest from the one given, used to break up a monotonous run. */
function contrastTo(size: ShotSize): ShotSize {
  return TIGHT_SIZES.includes(size) ? "wide" : "close";
}

/**
 * Guarantee the film is covered rather than shot from one distance.
 *
 * Three consecutive shots at the same size read as one long shot no matter how
 * the content changes, and a film with no close shot never lets the audience near
 * anyone while one with no wide never says where it is. Both are fixed by moving
 * a size, never by reordering or reframing what a scene is about.
 */
function enforceCoverage(scenes: Scene[]): void {
  for (const s of scenes) if (!s.shot_size) s.shot_size = DEFAULT_SHOT_SIZE[s.purpose];

  for (let i = 2; i < scenes.length; i++) {
    if (scenes[i].shot_size === scenes[i - 1].shot_size && scenes[i - 1].shot_size === scenes[i - 2].shot_size) {
      scenes[i].shot_size = contrastTo(scenes[i].shot_size as ShotSize);
    }
  }

  if (scenes.length < 2) return;
  const nonHero = scenes.filter((s) => s.purpose !== "hero_drop");
  const pool = nonHero.length > 0 ? nonHero : scenes;

  // The shortest shot carries the least, so it is the cheapest one to move in.
  if (!scenes.some((s) => TIGHT_SIZES.includes(s.shot_size as ShotSize))) {
    pool.reduce((a, b) => (sceneDuration(b) < sceneDuration(a) ? b : a)).shot_size = "close";
  }
  // The longest has the most room to hold a landscape, so it is the one to open out.
  if (!scenes.some((s) => s.shot_size === "wide" || s.shot_size === "full")) {
    pool.reduce((a, b) => (sceneDuration(b) > sceneDuration(a) ? b : a)).shot_size = "wide";
  }
}

export function normalize(input: DirectorSpec): DirectorSpec {
  const spec: DirectorSpec = structuredClone(input);

  spec.duration_s = round(spec.duration_s, 3);
  spec.scenes.sort((a, b) => a.start_s - b.start_s);

  // Drop zero/negative-length scenes before stretching the rest.
  spec.scenes = spec.scenes.filter((s) => s.end_s > s.start_s);

  // Close gaps and overlaps by trusting each scene's start and snapping the
  // previous scene's end to it. Then anchor the head to 0 and the tail to duration.
  if (spec.scenes.length > 0) {
    spec.scenes[0].start_s = 0;
    for (let i = 1; i < spec.scenes.length; i++) {
      const prev = spec.scenes[i - 1];
      const cur = spec.scenes[i];
      if (cur.start_s <= prev.start_s + 0.5) cur.start_s = prev.start_s + 1.5;
      prev.end_s = cur.start_s;
    }
    const last = spec.scenes[spec.scenes.length - 1];
    last.end_s = Math.max(last.start_s + 1.5, spec.duration_s);
    spec.duration_s = last.end_s;
  }

  // Renumber ids in playback order so s01..sNN always reads top to bottom.
  spec.scenes = spec.scenes.map((s, i) => ({
    ...s,
    id: `s${String(i + 1).padStart(2, "0")}`,
    start_s: round(s.start_s, 3),
    end_s: round(s.end_s, 3),
  }));

  // First scene is always a hard cut in; there is nothing to transition from.
  if (spec.scenes.length > 0) spec.scenes[0].transition_in = "cut";

  // Keep exactly one hero: the longest candidate wins, others become variation.
  const heroes = spec.scenes.filter((s) => s.purpose === "hero_drop");
  if (heroes.length > 1) {
    const keep = heroes.reduce((a, b) => (b.end_s - b.start_s > a.end_s - a.start_s ? b : a));
    for (const h of heroes) if (h.id !== keep.id) h.purpose = "variation";
  }

  enforceCoverage(spec.scenes);

  // Events: clamp, sort, dedupe identical (t, kind) pairs.
  spec.events = spec.events
    .map((e) => ({ ...e, t: round(Math.min(Math.max(e.t, 0), spec.duration_s), 3) }))
    .sort((a, b) => a.t - b.t)
    .filter((e, i, arr) => i === 0 || !(arr[i - 1].t === e.t && arr[i - 1].kind === e.kind));

  // The final hit belongs at the end of the reel, not floating mid-timeline.
  const finalHit = spec.events.find((e) => e.kind === "final_hit");
  if (finalHit && finalHit.t < spec.duration_s - 3) {
    finalHit.t = round(spec.duration_s - 1, 3);
    spec.events.sort((a, b) => a.t - b.t);
  }

  // Music plan anchors follow the events they describe.
  const drop = spec.events.find((e) => e.kind === "drop");
  if (drop) spec.music.drop_at_s = drop.t;
  const resolve = spec.events.find((e) => e.kind === "resolve");
  if (resolve) spec.music.resolve_at_s = resolve.t;
  const build = spec.events.find((e) => e.kind === "build");
  if (build && drop) spec.music.build_region_s = [build.t, drop.t];

  return spec;
}

/** Parse unknown JSON into a validated, normalised spec. */
export function parseSpec(raw: unknown): ValidationResult {
  const parsed = DirectorSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      spec: null,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        severity: "hard" as const,
      })),
    };
  }
  const normalized = normalize(parsed.data);
  const issues = checkStructure(normalized);
  const hard = issues.filter((i) => i.severity === "hard");
  return { ok: hard.length === 0, spec: normalized, issues };
}

// ── derived views ────────────────────────────────────────────────────────────

export function sceneById(spec: DirectorSpec, id: string): Scene | undefined {
  return spec.scenes.find((s) => s.id === id);
}

export function heroScene(spec: DirectorSpec): Scene | undefined {
  return spec.scenes.find((s) => s.purpose === "hero_drop");
}

export function sceneDuration(s: Scene): number {
  return round(s.end_s - s.start_s, 3);
}

/** Events that land inside a scene's window, used to place effects. */
export function eventsInScene(spec: DirectorSpec, s: Scene): TimelineEvent[] {
  return spec.events.filter((e) => e.t >= s.start_s - 0.001 && e.t < s.end_s - 0.001);
}

/**
 * Purposes that are about the person rather than the place.
 *
 * Several checks only make sense for a shot that contains a subject — keeping the
 * face inside the vertical safe region, or scoring identity at all. Applying them
 * to an establishing landscape produces confident, wrong complaints.
 */
export const SUBJECT_PURPOSES: ScenePurpose[] = [
  "recognition",
  "motion_begins",
  "hero_drop",
  "variation",
  "resolution",
];

/** How far the camera sits for this scene, resolved for specs that predate the field. */
export function shotSize(scene: Scene): ShotSize {
  return scene.shot_size ?? DEFAULT_SHOT_SIZE[scene.purpose];
}

/**
 * Whether this scene is meant to show the subject.
 *
 * Size overrides purpose here: a detail shot is a texture or an object, so the
 * checks that look for a face have nothing to find however the scene was labelled.
 */
export function expectsSubject(scene: Scene): boolean {
  if (shotSize(scene) === "detail") return false;
  return SUBJECT_PURPOSES.includes(scene.purpose);
}

/** Scenes whose render mode will actually call a video model. */
export function generativeScenes(spec: DirectorSpec): Scene[] {
  return spec.scenes.filter((s) => GENERATIVE_MODES.includes(s.render_mode));
}

// ── migration ────────────────────────────────────────────────────────────────

/**
 * Bring an older persisted spec up to the current version. There is only 1.0
 * today; the seam exists so a stored project never becomes unreadable.
 */
export function migrate(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (!obj.spec_version) obj.spec_version = "1.0";
  return obj;
}

/**
 * The JSON Schema handed to Gemini as `responseSchema`. Kept in lockstep with
 * the zod schema by `tests/spec.test.ts`, which round-trips a generated sample.
 *
 * Gemini's structured-output dialect: uppercase type names, `enum` on STRING,
 * `propertyOrdering` to stabilise field order, no `$ref`, no `default`.
 */
export const DIRECTOR_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: [
    "spec_version",
    "title",
    "logline",
    "duration_s",
    "aspect_ratio",
    "style_bible",
    "music",
    "events",
    "scenes",
  ],
  propertyOrdering: [
    "spec_version",
    "title",
    "logline",
    "duration_s",
    "aspect_ratio",
    "style_bible",
    "music",
    "events",
    "scenes",
  ],
  properties: {
    spec_version: { type: "STRING", enum: ["1.0"] },
    title: { type: "STRING", description: "Short evocative reel title, 2-5 words." },
    logline: { type: "STRING", description: "One sentence describing the film." },
    duration_s: { type: "NUMBER", description: "Total length in seconds, 24 to 30." },
    aspect_ratio: { type: "STRING", enum: ["9:16"] },
    style_bible: {
      type: "OBJECT",
      required: ["preset", "palette", "character_rules", "negative_rules", "lighting", "medium", "grain"],
      propertyOrdering: ["preset", "palette", "character_rules", "negative_rules", "lighting", "medium", "grain"],
      properties: {
        preset: { type: "STRING" },
        palette: { type: "ARRAY", items: { type: "STRING" }, minItems: 2, maxItems: 6 },
        character_rules: { type: "ARRAY", items: { type: "STRING" }, maxItems: 10 },
        negative_rules: { type: "ARRAY", items: { type: "STRING" }, maxItems: 14 },
        lighting: { type: "STRING" },
        medium: { type: "STRING" },
        grain: { type: "NUMBER" },
      },
    },
    music: {
      type: "OBJECT",
      required: ["mode", "bpm_target", "mood", "instrumentation", "key"],
      propertyOrdering: ["mode", "bpm_target", "mood", "instrumentation", "key"],
      properties: {
        mode: { type: "STRING", enum: [...MUSIC_MODES] },
        bpm_target: { type: "NUMBER" },
        mood: { type: "STRING", description: "Arc, e.g. 'nostalgic then euphoric then warm'." },
        instrumentation: { type: "ARRAY", items: { type: "STRING" }, maxItems: 8 },
        key: { type: "STRING" },
      },
    },
    events: {
      type: "ARRAY",
      minItems: 4,
      maxItems: 10,
      items: {
        type: "OBJECT",
        required: ["t", "kind", "visual", "intensity"],
        propertyOrdering: ["t", "kind", "visual", "intensity"],
        properties: {
          t: { type: "NUMBER", description: "Seconds from start." },
          kind: { type: "STRING", enum: [...EVENT_KINDS] },
          visual: { type: "STRING", description: "What the picture does at this instant." },
          intensity: { type: "NUMBER", description: "0 to 1." },
        },
      },
    },
    scenes: {
      type: "ARRAY",
      minItems: 5,
      maxItems: 7,
      items: {
        type: "OBJECT",
        required: [
          "id",
          "start_s",
          "end_s",
          "purpose",
          "render_mode",
          "camera",
          "camera_note",
          "shot_size",
          "action",
          "setting",
          "transition_in",
          "retry_budget",
        ],
        propertyOrdering: [
          "id",
          "start_s",
          "end_s",
          "purpose",
          "render_mode",
          "camera",
          "camera_note",
          "shot_size",
          "action",
          "setting",
          "transition_in",
          "retry_budget",
        ],
        properties: {
          id: { type: "STRING", description: "s01, s02, ... in playback order." },
          start_s: { type: "NUMBER" },
          end_s: { type: "NUMBER" },
          purpose: { type: "STRING", enum: [...SCENE_PURPOSES] },
          render_mode: { type: "STRING", enum: [...RENDER_MODES] },
          camera: { type: "STRING", enum: [...CAMERA_MOVES] },
          camera_note: { type: "STRING", description: "Extra camera detail for video prompts." },
          shot_size: {
            type: "STRING",
            enum: [...SHOT_SIZES],
            description:
              "How far the camera sits. Vary it shot to shot; a detail shot has no person in it.",
          },
          action: { type: "STRING", description: "The one visual thing this scene does." },
          setting: { type: "STRING", description: "Where we are. Feeds the image prompt." },
          transition_in: { type: "STRING", enum: [...TRANSITIONS] },
          retry_budget: { type: "INTEGER" },
        },
      },
    },
  },
} as const;
