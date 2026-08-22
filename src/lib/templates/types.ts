/**
 * Template bundle contracts.
 *
 * A bundle is the entire creative configuration of one preset: the style bible
 * the Director starts from, the beat skeleton it is tuned around, the music
 * brief, the approved transition vocabulary, the palette and the composer's
 * grade. Nothing else in MUSE is allowed to invent style; it reads a bundle.
 *
 * Every prompt-bearing part carries its own version counter. Improving the
 * scene prompt should not invalidate cached keyframes that only depended on the
 * style bible, so cache keys are built from `bundleVersionString`, which changes
 * exactly when something that can alter output has changed.
 */
import type {
  CameraMove,
  RenderMode,
  ScenePurpose,
  StyleBible,
  Transition,
} from "@/lib/spec/directorSpec";

/** Independent version counters for each prompt-bearing part of a bundle. */
export interface TemplateVersions {
  director: number;
  styleBible: number;
  scenePrompt: number;
  criticRubric: number;
  transitionPolicy: number;
  musicPolicy: number;
}

/** One beat of a preset's skeleton: a scene slot with its purpose and camera. */
export interface TemplateBeat {
  atS: number;
  endS: number;
  purpose: ScenePurpose;
  renderMode: RenderMode;
  camera: CameraMove;
  transitionIn: Transition;
  /** Short description of what this beat is for, used in the Director prompt. */
  intent: string;
}

/** The music brief a preset asks for before the Director adapts it. */
export interface TemplateMusic {
  bpm: number;
  key: string;
  mood: string;
  instrumentation: string[];
  /** Extra sentences appended to the music brief for this preset. */
  notes: string;
}

/**
 * Colour grade the composer applies for this preset. Each value is a signed
 * offset in `GRADE_BOUNDS`, not an absolute level: 0 means "leave it alone".
 */
export interface TemplateGrade {
  warmth: number;
  contrast: number;
  saturation: number;
  lift: number;
}

/** Legal range for every field of a `TemplateGrade`. */
export const GRADE_BOUNDS = { min: -1, max: 1 } as const;

/** A complete, self-contained preset. */
export interface TemplateBundle {
  id: string;
  label: string;
  /** One line, shown under the name on the preset card. */
  blurb: string;
  versions: TemplateVersions;
  /** Seeds the StyleBible the Director starts from. */
  styleBible: StyleBible;
  /** The scene-by-scene skeleton this preset is tuned around. */
  beats: TemplateBeat[];
  music: TemplateMusic;
  /** Approved transitions for this preset, in preference order. */
  transitions: Transition[];
  /** Palette as hex, used by the UI, the local engine and the grade. */
  swatches: string[];
  /** Colour grade the composer applies for this preset. */
  grade: TemplateGrade;
}

/**
 * Stable cache-busting identity for a bundle: preset id plus every version
 * counter. Safe to use in a filename or a cache key.
 */
export function bundleVersionString(b: TemplateBundle): string {
  const v = b.versions;
  return [
    b.id,
    `d${v.director}`,
    `s${v.styleBible}`,
    `k${v.scenePrompt}`,
    `c${v.criticRubric}`,
    `t${v.transitionPolicy}`,
    `m${v.musicPolicy}`,
  ].join(".");
}
