/**
 * Render manifest: the complete, self-contained description of one reel.
 *
 * The composer is deliberately boring software. It reads a manifest and emits an
 * MP4; it makes no decisions and calls no models. Two consequences that matter:
 * a manifest re-rendered later produces a byte-comparable result, and a failed
 * render can be diagnosed from the manifest alone without replaying generation.
 */
import type { CameraMove, Transition } from "@/lib/spec/directorSpec";

/**
 * How the photograph becomes the film.
 *
 * A crossfade from a photo to a painting says two pictures were shown in sequence.
 * These say the picture changed: the paint arrives in the highlights first and spreads
 * into the shadows, so the light in the original photograph is what turns it.
 */
export type RevealMethod = "paint_reveal" | "luma_reveal" | "edge_dissolve" | "bloom_transform";

/** Where a clip's picture comes from. */
export type ClipSource =
  | { kind: "image"; path: string; sha256: string }
  | { kind: "video"; path: string; sha256: string; trimStartS: number; sourceDurationS: number }
  | { kind: "color"; hex: string }
  /**
   * Two pictures and the change between them. Used for the opening shot, where the
   * film starts on the photograph somebody actually uploaded and becomes the stylised
   * world it was directed into — in one continuous shot rather than across a cut.
   */
  | {
      kind: "transform";
      /** The user's own photograph. The film starts here. */
      fromPath: string;
      fromSha256: string;
      /** The stylised clip it becomes. */
      toPath: string;
      toSha256: string;
      toDurationS: number;
      method: RevealMethod;
      /** Seconds into the clip where the change begins, and how long it takes. */
      revealStartS: number;
      revealDurationS: number;
    };

/** Deterministic effects the composer applies. Order is significant. */
export type ClipEffect =
  /** Ken Burns style move over a still, or a slow push on video. */
  | { kind: "camera"; move: CameraMove; amount: number }
  /** Layered depth from a single still: background scaled and offset separately. */
  | { kind: "parallax"; amount: number; layers: number }
  /** Painterly treatment for un-stylised source photos. */
  | { kind: "painterly"; strength: number }
  /** Colour grade toward the style bible palette. */
  | { kind: "grade"; warmth: number; contrast: number; saturation: number; lift: number }
  /** Film grain and halation. */
  | { kind: "grain"; amount: number }
  /** Light leak / bloom sweep, timed to an accent. */
  | { kind: "bloom"; amount: number; atS?: number }
  /** Brief exposure lift on a beat. */
  | { kind: "beatPulse"; atS: number; amount: number }
  /** Radial or directional blur burst. */
  | { kind: "blurBurst"; atS: number; amount: number }
  /** Vignette to hold the eye centre-frame. */
  | { kind: "vignette"; amount: number }
  /** Subtle continuous zoom used to hide seams on short clips. */
  | { kind: "breathe"; amount: number };

/** Text drawn by the composer, never generated into an image. */
export interface Overlay {
  kind: "title" | "caption" | "logo";
  text: string;
  /** Seconds from the start of the clip. */
  atS: number;
  durationS: number;
  /** 0..1 of frame width/height. */
  x: number;
  y: number;
  sizePx: number;
  font: "display" | "sans" | "mono";
  color: string;
  /** Fade in/out, seconds. */
  fadeS: number;
  align: "left" | "center" | "right";
  /** Optional letter tracking in pixels. */
  trackingPx?: number;
}

export interface ManifestClip {
  sceneId: string;
  /** Position on the master timeline. */
  startS: number;
  endS: number;
  source: ClipSource;
  /** How this clip enters. The first clip is always a hard cut. */
  transitionIn: Transition;
  transitionDurationS: number;
  effects: ClipEffect[];
  overlays: Overlay[];
  /** Recorded so the diagnostics panel can explain why a scene looks the way it does. */
  renderMode: string;
  /** True when this clip came from the deterministic engine rather than a model. */
  fromFallback: boolean;
}

export interface ManifestAudio {
  path: string;
  sha256: string;
  /** Where in the source audio the reel starts. */
  trimStartS: number;
  gainDb: number;
  fadeInS: number;
  fadeOutS: number;
  /** Deterministic impacts added where the music lacked a requested accent. */
  accents: { atS: number; kind: "impact" | "riser" | "sweep"; gainDb: number }[];
  /** True when the score came from the local synthesiser. */
  fromFallback: boolean;
  /**
   * A dynamic arc imposed on a score that has none of its own.
   *
   * Only present when the music was measured flat. Cuts can sit exactly on the beats of a
   * score whose level never moves and the film still drags, because the arc is what makes
   * a payoff feel like one. Ducking the opening and releasing to full across the build
   * gives the picture something to rise with, deterministically, instead of paying a music
   * model again to be asked the same thing.
   */
  arc?: { quietGain: number; liftFromS: number; liftToS: number };
}

export interface RenderManifest {
  manifestVersion: "1.0";
  projectId: string;
  specVersion: number;
  title: string;
  createdAt: string;
  width: number;
  height: number;
  fps: number;
  durationS: number;
  audio: ManifestAudio;
  clips: ManifestClip[];
  /** Reconciled musical anchors the cuts were placed on. */
  anchorsS: number[];
  /** Style values applied globally, including which reading of the material this is. */
  style: {
    grain: number;
    palette: string[];
    preset: string;
    edit: string;
    grade: { warmth: number; contrast: number; saturation: number; lift: number };
  };
  /** Content hashes of every input, so a render is reproducible and auditable. */
  inputHashes: Record<string, string>;
  /** Template bundle versions in force for this render. */
  templateVersions: Record<string, string | number>;
}

export interface RenderOutcome {
  outputPath: string;
  sha256: string;
  durationS: number;
  width: number;
  height: number;
  bytes: number;
  /** Every ffmpeg invocation, in order, for debugging a bad render. */
  commands: string[];
  warnings: string[];
}

/** Result of validating a finished reel before it is shown to anyone. */
export interface ReelCheck {
  ok: boolean
  durationS: number;
  width: number;
  height: number;
  hasAudio: boolean;
  audioDurationS: number;
  /** Frames sampled across the reel that decoded as effectively black. */
  blackFrames: number;
  issues: string[];
}
