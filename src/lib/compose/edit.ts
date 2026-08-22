/**
 * Edit styles: different films from the same footage, for nothing.
 *
 * Generation is the expensive, slow, uncertain part. Composition is deterministic
 * code over assets that already exist. Because MUSE keeps those two apart, a film
 * can be re-cut as many times as you like at zero cost and in seconds — a different
 * transition vocabulary, a different grade, cuts placed on a different density of
 * beat.
 *
 * That is the useful consequence of the architecture, so it is exposed as a feature
 * rather than left as an implementation detail. An edit never touches the plan and
 * never spends: it is a new reading of the same material.
 */
import type { Transition } from "@/lib/spec/directorSpec";

export type EditStyleId = "as_cut" | "hard_cuts" | "dissolves" | "unsnapped";

export interface EditStyle {
  id: EditStyleId;
  label: string;
  /** One line, in the language of editing rather than of code. */
  blurb: string;
  /**
   * Replace every transition with this one. Undefined keeps what the Director
   * chose. The opening shot is always a straight cut regardless.
   */
  forceTransition?: Transition;
  /** Scale every transition's length. 1 keeps it as planned. */
  transitionScale: number;
  /**
   * Which measured accents cuts may land on. "all" uses every cuttable accent,
   * "strong" only the structural ones, which produces a slower, wider edit.
   */
  anchorDensity: "all" | "strong";
  /**
   * False places cuts exactly where the plan asked, ignoring what the music
   * actually did. This exists to be compared against: it is the difference
   * between a reel that sits on the beat and one that is merely near it.
   */
  snapCuts: boolean;
  /** Multipliers over the preset's grade, so an edit can feel warmer or cooler. */
  grade: { warmth: number; contrast: number; saturation: number };
  /** Multiplier over the style bible's grain. */
  grain: number;
  /** Scale on camera moves and beat effects. */
  motion: number;
}

/**
 * The four readings offered. Deliberately few: a person choosing between four
 * edits is making a taste decision, and a person choosing between twelve is
 * operating a control panel.
 */
export const EDIT_STYLES: Record<EditStyleId, EditStyle> = {
  as_cut: {
    id: "as_cut",
    label: "As cut",
    blurb: "The edit the director planned.",
    transitionScale: 1,
    anchorDensity: "all",
    snapCuts: true,
    grade: { warmth: 1, contrast: 1, saturation: 1 },
    grain: 1,
    motion: 1,
  },
  hard_cuts: {
    id: "hard_cuts",
    label: "Hard cuts",
    blurb: "Every join a straight cut, landing only on the strong beats. Punchier.",
    forceTransition: "cut",
    transitionScale: 0,
    anchorDensity: "strong",
    snapCuts: true,
    grade: { warmth: 0.92, contrast: 1.12, saturation: 1.04 },
    grain: 0.7,
    motion: 1.15,
  },
  dissolves: {
    id: "dissolves",
    label: "Dissolves",
    blurb: "Long cross-dissolves and heavier grain. Softer, more like a memory.",
    forceTransition: "crossfade",
    transitionScale: 1.6,
    anchorDensity: "strong",
    snapCuts: true,
    grade: { warmth: 1.1, contrast: 0.92, saturation: 0.94 },
    grain: 1.5,
    motion: 0.8,
  },
  unsnapped: {
    id: "unsnapped",
    label: "Off the beat",
    blurb: "The same film with cuts left where the plan guessed, not where the music landed.",
    transitionScale: 1,
    anchorDensity: "all",
    snapCuts: false,
    grade: { warmth: 1, contrast: 1, saturation: 1 },
    grain: 1,
    motion: 1,
  },
};

export const EDIT_STYLE_IDS: EditStyleId[] = ["as_cut", "hard_cuts", "dissolves", "unsnapped"];

export function editStyle(id: string): EditStyle {
  return EDIT_STYLES[(id as EditStyleId) in EDIT_STYLES ? (id as EditStyleId) : "as_cut"];
}

/**
 * The styles offered to a person as alternative readings. "Off the beat" is
 * excluded: it exists as a comparison, not as a choice anyone would want.
 */
export const OFFERED_STYLES: EditStyleId[] = ["as_cut", "hard_cuts", "dissolves"];

/** Asset role under which an edit's reel is stored. */
export function editRole(id: EditStyleId): string {
  return id === "as_cut" ? "final" : `edit_${id}`;
}
