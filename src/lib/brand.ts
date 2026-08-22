/**
 * The MUSE lexicon.
 *
 * Everything a person reads in this product uses film-lab language, not the names
 * the code uses internally. A `DirectorSpec` is a treatment. A `scene` is a shot. A
 * `keyframe` is a frame. `scene_video` is a take. There is no such thing as an
 * "asset", a "route", a "profile" or a "model" in the interface, because none of
 * those are words someone making a film about their summer would use.
 *
 * Keeping the mapping in one file is what stops the product drifting back into
 * describing its own plumbing. If a string is shown to a person, its noun comes
 * from here.
 */

/** What each stored artefact is called on screen. */
export const NOUN: Record<string, { one: string; many: string }> = {
  reel: { one: "film", many: "films" },
  scene_video: { one: "shot", many: "shots" },
  keyframe: { one: "frame", many: "frames" },
  music: { one: "score", many: "scores" },
  poster: { one: "poster", many: "posters" },
  subject_sheet: { one: "reference", many: "references" },
  upload_image: { one: "photograph", many: "photographs" },
  upload_audio: { one: "track", many: "tracks" },
};

export function noun(kind: string, count = 1): string {
  const n = NOUN[kind];
  if (!n) return kind.replace(/_/g, " ");
  return count === 1 ? n.one : n.many;
}

/** A shot's narrative role, in words rather than enum case. */
export const PURPOSE: Record<string, string> = {
  recognition: "the opening",
  world_opens: "the world opens",
  motion_begins: "movement begins",
  build: "the build",
  hero_drop: "the drop",
  variation: "the answer",
  resolution: "the ending",
};

export function purposeLabel(purpose: string): string {
  return PURPOSE[purpose] ?? purpose.replace(/_/g, " ");
}

/** Camera moves as a director would say them. */
export const CAMERA: Record<string, string> = {
  static: "held still",
  push_in: "pushing in",
  pull_out: "pulling out",
  pan_left: "panning left",
  pan_right: "panning right",
  tilt_up: "tilting up",
  tilt_down: "tilting down",
  dolly_out: "dollying out",
  parallax_drift: "drifting through depth",
  handheld_drift: "handheld",
  whip: "whipping across",
};

export function cameraLabel(move: string): string {
  return CAMERA[move] ?? move.replace(/_/g, " ");
}

/** How far the camera sits, as a crew would call it on the day. */
export const SHOT_SIZE: Record<string, string> = {
  wide: "wide",
  full: "full shot",
  medium: "medium",
  close: "close-up",
  extreme_close: "extreme close-up",
  detail: "insert",
};

export function shotSizeLabel(size: string): string {
  return SHOT_SIZE[size] ?? size.replace(/_/g, " ");
}

/** How a cut enters, in plain language. */
export const TRANSITION: Record<string, string> = {
  cut: "a straight cut",
  crossfade: "a dissolve",
  dip_to_black: "a dip to black",
  dip_to_white: "a dip to white",
  flash: "a flash",
  whip_pan: "a whip",
  luma_wipe: "a wipe",
  film_burn: "a film burn",
  match_cut: "a match cut",
};

export function transitionLabel(kind: string): string {
  return TRANSITION[kind] ?? kind.replace(/_/g, " ");
}

/**
 * What the review decided, said to the person whose film it is. The internal
 * vocabulary is PASS / RETRY / FALLBACK, which reads like a build log.
 */
export const REVIEW: Record<string, string> = {
  PASS: "looks right",
  RETRY: "took another pass",
  FALLBACK: "used the safe take",
};

export function reviewLabel(decision: string): string {
  return REVIEW[decision] ?? decision.toLowerCase();
}

/** Progress copy, so a running film narrates itself rather than logging. */
export const STAGE: Record<string, string> = {
  preflight: "Reading your photographs",
  director: "Writing the treatment",
  storyboard: "Painting the frames",
  qc: "Watching it back",
  compose: "Cutting the film",
};

export function stageLabel(stage: string): string {
  return STAGE[stage] ?? stage;
}

/** Where a picture came from, said once and without a model number. */
export function originLabel(generated: boolean): string {
  return generated ? "Painted by Gemini" : "Made on this machine";
}

/** The preset names are already user-facing; this is their short form. */
export function presetLabel(preset: string): string {
  return preset
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Relative time, the only clock a person needs while making something. */
export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m <= 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Duration for a person: "30s", "1:04". */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** File size, rounded the way a download dialog would show it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Frame shape, said as a format rather than as two integers. */
export function frameLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  const vertical = height > width;
  return `${width}×${height}${vertical ? " vertical" : ""}`;
}

/** The one-line status of a film, for a gallery card. */
export function filmStatus(status: string): { label: string; tone: "ok" | "live" | "warn" | "neutral" } {
  switch (status) {
    case "READY":
      return { label: "Ready", tone: "ok" };
    case "FAILED":
      return { label: "Stopped", tone: "warn" };
    case "DRAFT":
      return { label: "Not started", tone: "neutral" };
    case "COMPOSING":
      return { label: "Cutting", tone: "live" };
    case "RENDERING":
      return { label: "Painting", tone: "live" };
    case "DIRECTING":
      return { label: "Writing", tone: "live" };
    case "STORYBOARDING":
      return { label: "Storyboarding", tone: "live" };
    case "QC":
      return { label: "Reviewing", tone: "live" };
    case "REVISING":
      return { label: "Revising", tone: "live" };
    case "PREFLIGHT":
      return { label: "Reading photographs", tone: "live" };
    default:
      return { label: "Working", tone: "live" };
  }
}
