/**
 * Live direction as bounded patches against a DirectorSpec.
 *
 * A patch never mutates work already in flight and never rewrites the whole plan.
 * It is a small, named, validated operation, and each operation declares exactly
 * which scenes it invalidates. That is what makes "make scene four nighttime"
 * re-render one or two scenes instead of the entire reel, and what lets the UI
 * show the cost of a request before it is accepted.
 */
import { z } from "zod";
import {
  CAMERA_MOVES,
  EVENT_KINDS,
  RENDER_MODES,
  SHOT_SIZES,
  TRANSITIONS,
  normalize,
  type DirectorSpec,
} from "./directorSpec";
import { clamp, round, truncate } from "@/lib/core/util";

// ── operations ───────────────────────────────────────────────────────────────

export const PatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("scene_action"), scene_id: z.string(), action: z.string().min(1).max(400) }),
  z.object({ op: z.literal("scene_setting"), scene_id: z.string(), setting: z.string().min(1).max(300) }),
  z.object({ op: z.literal("scene_shot_size"), scene_id: z.string(), shot_size: z.enum(SHOT_SIZES) }),
  z.object({
    op: z.literal("scene_camera"),
    scene_id: z.string(),
    camera: z.enum(CAMERA_MOVES),
    camera_note: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal("scene_transition"), scene_id: z.string(), transition: z.enum(TRANSITIONS) }),
  z.object({ op: z.literal("scene_render_mode"), scene_id: z.string(), render_mode: z.enum(RENDER_MODES) }),
  z.object({ op: z.literal("scene_title"), scene_id: z.string(), title: z.string().max(60) }),
  z.object({ op: z.literal("style_palette"), palette: z.array(z.string().min(1)).min(2).max(6) }),
  z.object({ op: z.literal("style_lighting"), lighting: z.string().min(1).max(200) }),
  z.object({ op: z.literal("style_medium"), medium: z.string().min(1).max(200) }),
  z.object({ op: z.literal("style_grain"), grain: z.number().min(0).max(1) }),
  z.object({
    op: z.literal("add_motif"),
    scene_ids: z.array(z.string()).min(1).max(9),
    motif: z.string().min(1).max(120),
  }),
  z.object({ op: z.literal("event_intensity"), kind: z.enum(EVENT_KINDS), intensity: z.number().min(0).max(1) }),
  z.object({ op: z.literal("music_energy"), delta: z.number().min(-1).max(1) }),
  z.object({ op: z.literal("attach_secondary"), scene_ids: z.array(z.string()).min(1).max(9) }),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const PatchRequestSchema = z.object({
  /** One short sentence the UI shows as the name of this change. */
  summary: z.string().min(1).max(160),
  ops: z.array(PatchOpSchema).min(1).max(10),
});
export type PatchRequest = z.infer<typeof PatchRequestSchema>;

/** What a patch will cost in re-rendered work, computed before it is applied. */
export interface PatchImpact {
  /** Scenes whose imagery must be regenerated. */
  invalidatedScenes: string[];
  /**
   * Whether the plan actually changed.
   *
   * `applied` records the operations the interpreter accepted, which is not the same thing:
   * an operation can be accepted and still leave the spec identical — setting a shot size to
   * the size it already was, renaming a palette entry to itself. Comparing the result with
   * the input is the only check that catches it.
   */
  changed: boolean;
  /** True when the soundtrack has to be regenerated. */
  invalidatesMusic: boolean;
  /** True when only the composer needs to run again. */
  composeOnly: boolean;
}

export interface PatchResult {
  spec: DirectorSpec;
  applied: PatchOp[];
  rejected: { op: PatchOp; reason: string }[];
  impact: PatchImpact;
  summary: string;
}

// ── application ──────────────────────────────────────────────────────────────

/**
 * Apply a patch. Unknown scene ids and out-of-range values are rejected
 * individually rather than failing the whole request, so one bad clause in a
 * spoken instruction does not discard the rest of it.
 */
export function applyPatch(spec: DirectorSpec, request: PatchRequest): PatchResult {
  const next: DirectorSpec = structuredClone(spec);
  const applied: PatchOp[] = [];
  const rejected: { op: PatchOp; reason: string }[] = [];
  const invalidated = new Set<string>();
  let invalidatesMusic = false;
  let visualChange = false;

  const sceneIndex = new Map(next.scenes.map((s, i) => [s.id, i]));
  const findScene = (id: string) => {
    const i = sceneIndex.get(id);
    return i === undefined ? null : next.scenes[i];
  };

  /**
   * A setting change bleeds into the next shot through continuity, because each
   * scene's prompt carries the previous scene's approved keyframe as a reference.
   * That dependency is one step deep, so invalidation stops there rather than
   * cascading to the end of the reel: re-rendering every later shot because the
   * third one became nighttime costs the whole budget to fix one scene, and would
   * make any targeted instruction get refused as too broad.
   */
  const invalidateWithSuccessor = (fromId: string) => {
    const start = sceneIndex.get(fromId);
    if (start === undefined) return;
    invalidated.add(next.scenes[start].id);
    const successor = next.scenes[start + 1];
    if (successor) invalidated.add(successor.id);
  };

  for (const op of request.ops) {
    switch (op.op) {
      case "scene_action": {
        const s = findScene(op.scene_id);
        if (!s) {
          rejected.push({ op, reason: `no scene ${op.scene_id}` });
          break;
        }
        s.action = op.action;
        invalidated.add(s.id);
        visualChange = true;
        applied.push(op);
        break;
      }
      case "scene_setting": {
        const s = findScene(op.scene_id);
        if (!s) {
          rejected.push({ op, reason: `no scene ${op.scene_id}` });
          break;
        }
        s.setting = op.setting;
        invalidateWithSuccessor(s.id);
        visualChange = true;
        applied.push(op);
        break;
      }
      case "scene_shot_size": {
        const s = findScene(op.scene_id);
        if (!s) {
          rejected.push({ op, reason: `no scene ${op.scene_id}` });
          break;
        }
        // Reframing changes only this shot. The next one keeps its own size, and
        // normalize will step this size aside if it has just made a run of three.
        s.shot_size = op.shot_size;
        invalidated.add(s.id);
        visualChange = true;
        applied.push(op);
        break;
      }
      case "scene_camera": {
        const s = findScene(op.scene_id);
        if (!s) {
          rejected.push({ op, reason: `no scene ${op.scene_id}` });
          break;
        }
        s.camera = op.camera;
        if (op.camera_note !== undefined) s.camera_note = op.camera_note;
        invalidated.add(s.id);
        visualChange = true;
        applied.push(op);
        break;
      }
      case "scene_transition": {
        const s = findScene(op.scene_id);
        if (!s) {
          rejected.push({ op, reason: `no scene ${op.scene_id}` });
          break;
        }
        if (next.scenes[0]?.id === s.id && op.transition !== "cut") {
          rejected.push({ op, reason: "the opening scene has nothing to transition from" });
          break;
        }
        s.transition_in = op.transition;
        applied.push(op);
        break;
      }
      case "scene_render_mode": {
        const s = findScene(op.scene_id);
        if (!s) {
          rejected.push({ op, reason: `no scene ${op.scene_id}` });
          break;
        }
        s.render_mode = op.render_mode;
        invalidated.add(s.id);
        visualChange = true;
        applied.push(op);
        break;
      }
      case "scene_title": {
        const s = findScene(op.scene_id);
        if (!s) {
          rejected.push({ op, reason: `no scene ${op.scene_id}` });
          break;
        }
        s.title = op.title;
        applied.push(op);
        break;
      }
      case "style_palette": {
        next.style_bible.palette = op.palette.slice(0, 6);
        for (const s of next.scenes) invalidated.add(s.id);
        visualChange = true;
        applied.push(op);
        break;
      }
      case "style_lighting": {
        next.style_bible.lighting = op.lighting;
        for (const s of next.scenes) invalidated.add(s.id);
        visualChange = true;
        applied.push(op);
        break;
      }
      case "style_medium": {
        next.style_bible.medium = op.medium;
        for (const s of next.scenes) invalidated.add(s.id);
        visualChange = true;
        applied.push(op);
        break;
      }
      case "style_grain": {
        // Grain is applied by the composer, so nothing needs regenerating.
        next.style_bible.grain = round(op.grain, 3);
        applied.push(op);
        break;
      }
      case "add_motif": {
        const hits = op.scene_ids.map(findScene).filter((s): s is NonNullable<typeof s> => Boolean(s));
        if (hits.length === 0) {
          rejected.push({ op, reason: "none of those scenes exist" });
          break;
        }
        for (const s of hits) {
          s.action = truncate(`${s.action} ${op.motif}`.replace(/\s+/g, " "), 400);
          invalidated.add(s.id);
        }
        visualChange = true;
        applied.push(op);
        break;
      }
      case "event_intensity": {
        const hits = next.events.filter((e) => e.kind === op.kind);
        if (hits.length === 0) {
          rejected.push({ op, reason: `no ${op.kind} event on the timeline` });
          break;
        }
        for (const e of hits) e.intensity = clamp(op.intensity, 0, 1);
        // Intensity drives composer effects and the score's density curve.
        invalidatesMusic = true;
        applied.push(op);
        break;
      }
      case "music_energy": {
        const bpm = clamp(next.music.bpm_target + Math.round(op.delta * 14), 60, 190);
        next.music.bpm_target = bpm;
        next.music.mood =
          op.delta > 0
            ? truncate(`${next.music.mood}, pushed harder and brighter`, 200)
            : truncate(`${next.music.mood}, pulled back and softer`, 200);
        invalidatesMusic = true;
        applied.push(op);
        break;
      }
      case "attach_secondary": {
        const hits = op.scene_ids.map(findScene).filter((s): s is NonNullable<typeof s> => Boolean(s));
        if (hits.length === 0) {
          rejected.push({ op, reason: "none of those scenes exist" });
          break;
        }
        for (const s of hits) {
          if (!s.reference_asset_ids.includes("subject_secondary")) {
            s.reference_asset_ids.push("subject_secondary");
          }
          invalidated.add(s.id);
        }
        visualChange = true;
        applied.push(op);
        break;
      }
    }
  }

  const spec2 = normalize(next);
  // normalize can renumber ids; keep invalidation pointing at real scenes.
  const valid = new Set(spec2.scenes.map((s) => s.id));
  const invalidatedScenes = [...invalidated].filter((id) => valid.has(id)).sort();

  return {
    spec: spec2,
    applied,
    rejected,
    impact: {
      invalidatedScenes,
      invalidatesMusic,
      composeOnly: !visualChange && !invalidatesMusic && applied.length > 0,
      changed: JSON.stringify(spec) !== JSON.stringify(spec2),
    },
    summary: request.summary,
  };
}

/**
 * Guard against a patch that would effectively restart the project. A request
 * touching every scene is usually a misread instruction, so the UI asks the user
 * to target it instead of silently spending the whole budget again.
 */
export function isTooBroad(spec: DirectorSpec, impact: PatchImpact): boolean {
  if (spec.scenes.length === 0) return false;
  const ratio = impact.invalidatedScenes.length / spec.scenes.length;
  return ratio > 0.8 && spec.scenes.length >= 5;
}

/** Human summary of what a patch will re-render, for the confirmation line. */
export function describeImpact(impact: PatchImpact): string {
  if (!impact.changed) return "nothing changed";
  if (impact.composeOnly) return "recompose only, nothing regenerated";
  const parts: string[] = [];
  if (impact.invalidatedScenes.length > 0) {
    parts.push(
      `${impact.invalidatedScenes.length} scene${impact.invalidatedScenes.length === 1 ? "" : "s"} (${impact.invalidatedScenes.join(", ")})`,
    );
  }
  if (impact.invalidatesMusic) parts.push("the soundtrack");
  return parts.length > 0 ? `regenerates ${parts.join(" and ")}` : "no regeneration needed";
}
