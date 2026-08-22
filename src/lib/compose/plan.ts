/**
 * Manifest planning: turns a DirectorSpec plus rendered assets into the exact
 * instructions the composer executes.
 *
 * The load-bearing detail here is transition arithmetic. A cross-dissolve
 * overlaps two clips, so naively joining N clips of their scene lengths yields a
 * reel shorter than the plan by the sum of every transition — which would slide
 * every cut out of sync with the music. Instead each clip is rendered with its
 * incoming transition's duration as extra head padding, so after overlapping, its
 * net contribution is exactly its scene length and the assembled reel lands on
 * the planned duration to the frame.
 */
import { OUTPUT } from "@/lib/core/config";
import { round } from "@/lib/core/util";
import {
  eventsInScene,
  sceneDuration,
  type DirectorSpec,
  type Scene,
  type Transition,
} from "@/lib/spec/directorSpec";
import { getBundle } from "@/lib/templates/bundles";
import { bundleVersionString } from "@/lib/templates/types";
import type {
  ClipEffect,
  ManifestAudio,
  ManifestClip,
  Overlay,
  RenderManifest,
} from "./types";
import type { MusicAnchor, Reconciliation, EnergyPoint } from "@/lib/music/types";
import { measureDynamics } from "@/lib/music/reconcile";
import { editStyle, type EditStyle } from "./edit";

/**
 * How long each transition primitive runs. Short enough to feel like an edit
 * rather than a dissolve; a flash is nearly a cut, a film burn is the longest.
 */
export const TRANSITION_DURATION_S: Record<Transition, number> = {
  cut: 0,
  crossfade: 0.5,
  dip_to_black: 0.45,
  dip_to_white: 0.3,
  flash: 0.18,
  whip_pan: 0.28,
  luma_wipe: 0.4,
  film_burn: 0.5,
  match_cut: 0.22,
};

/**
 * Snap a duration to a whole frame so ffmpeg never has to round for us.
 *
 * Rounded to nine places rather than six: a frame boundary at a repeating fraction
 * (10/30) is not representable at six, which left the result a hair off the grid it
 * was supposed to land on.
 */
export function quantize(seconds: number, fps = OUTPUT.fps): number {
  return round(Math.round(seconds * fps) / fps, 9);
}

export function transitionDuration(kind: Transition, sceneLengthS: number): number {
  // Never let a transition eat more than a third of the shot it enters.
  const nominal = TRANSITION_DURATION_S[kind] ?? 0;
  return quantize(Math.min(nominal, sceneLengthS / 3));
}

/**
 * Total length a scene's clip must be rendered at: its own window plus the
 * incoming transition it has to overlap into.
 */
export function clipDurationFor(spec: DirectorSpec, scene: Scene): number {
  const own = sceneDuration(scene);
  const isFirst = spec.scenes[0]?.id === scene.id;
  const tIn = isFirst ? 0 : transitionDuration(scene.transition_in, own);
  // Headroom on top of the window and its incoming transition, so a boundary that
  // later moves onto a measured musical accent still has picture to cover it. The
  // composer trims to the exact window, so unused headroom costs nothing but a
  // little render time.
  return quantize(own + tIn + SNAP_HEADROOM_S);
}

/**
 * How far a boundary may travel to reach a beat.
 *
 * Wide enough that a boundary in a sparse intro can still find one — a 118 BPM bar
 * is about two seconds, so a narrower window leaves gaps where no anchor is
 * reachable — but comfortably inside the rendered headroom, so a moved cut always
 * has picture behind it.
 */
export const SNAP_TOLERANCE_S = 0.75;

/**
 * Slack rendered beyond each clip's nominal window. Sized to comfortably exceed
 * the snapping tolerance so no cut can run past the end of its own footage.
 */
export const SNAP_HEADROOM_S = 0.9;

/**
 * Move scene boundaries onto measured musical accents.
 *
 * This is what makes "every cut lands on the music" true rather than coincidental.
 * Reconciliation aligns the Director's *events* to real accents, but the cuts the
 * audience sees happen at scene boundaries, and those come straight from the plan.
 * When the Director is a language model choosing its own scene times, they do not
 * fall on the beat grid, and the reel is subtly but audibly loose.
 *
 * Boundaries are only nudged: order is preserved, no scene is allowed to collapse,
 * the reel still starts at zero and ends on its planned duration, and a boundary
 * with no accent nearby stays exactly where the Director put it.
 */
export function snapSceneBoundaries(
  spec: DirectorSpec,
  anchors: number[],
  toleranceS = SNAP_TOLERANCE_S,
): { boundaries: number[]; moved: number; maxShiftS: number } {
  const n = spec.scenes.length;
  // Boundaries are the n+1 cut points: 0, then each scene end.
  const original = [0, ...spec.scenes.map((s) => s.end_s)];
  const boundaries = [...original];
  if (n === 0 || anchors.length === 0) return { boundaries, moved: 0, maxShiftS: 0 };

  const sorted = [...anchors].sort((a, b) => a - b);
  const MIN_SCENE_S = 1.2;
  let moved = 0;
  let maxShift = 0;

  // The first and last boundaries are fixed: the reel must start at zero and run
  // for exactly the planned duration, or the audio no longer lines up.
  for (let i = 1; i < boundaries.length - 1; i++) {
    const want = original[i];
    let best: number | null = null;
    let bestDist = Infinity;
    for (const a of sorted) {
      const d = Math.abs(a - want);
      if (d > toleranceS) continue;
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    if (best === null) continue;

    const candidate = quantize(best);
    // Never reorder, and never squeeze a scene below the length at which a shot
    // reads as a glitch rather than a cut.
    const prev = boundaries[i - 1];
    const next = original[i + 1];
    if (candidate - prev < MIN_SCENE_S) continue;
    if (next - candidate < MIN_SCENE_S) continue;

    if (candidate !== boundaries[i]) {
      moved++;
      maxShift = Math.max(maxShift, Math.abs(candidate - want));
    }
    boundaries[i] = candidate;
  }

  return { boundaries, moved, maxShiftS: round(maxShift, 4) };
}

/** Where a clip's cross-dissolve begins, on the assembled timeline. */
export function xfadeOffsets(spec: DirectorSpec): { sceneId: string; offsetS: number; durationS: number }[] {
  const out: { sceneId: string; offsetS: number; durationS: number }[] = [];
  let assembled = 0;
  for (const [i, scene] of spec.scenes.entries()) {
    const clipLen = clipDurationFor(spec, scene);
    if (i === 0) {
      assembled = clipLen;
      continue;
    }
    const tIn = transitionDuration(scene.transition_in, sceneDuration(scene));
    out.push({ sceneId: scene.id, offsetS: quantize(assembled - tIn), durationS: tIn });
    assembled = quantize(assembled + clipLen - tIn);
  }
  return out;
}

// ── effect selection ─────────────────────────────────────────────────────────

/**
 * The stretch of the film that has lifted, from the build to the resolve.
 *
 * Choreography is confined to it on purpose. Stillness earns the climax: a reel that
 * pulses from the first frame has nowhere to go by the drop, and the effect reads as a
 * rendering fault rather than as editing. Returns null when the plan has no build, in
 * which case the picture is left alone.
 */
export function energyRegion(spec: DirectorSpec): [number, number] | null {
  const build = spec.events.find((e) => e.kind === "build");
  if (!build) return null;
  const resolve = spec.events.find((e) => e.kind === "resolve");
  const to = resolve ? resolve.t : spec.duration_s;
  return to > build.t ? [build.t, to] : null;
}

/**
 * Choose the effect chain for a scene. Effects are picked from the scene's own
 * purpose and the events that land inside it, so the picture reacts to the music
 * without any per-scene hand tuning.
 */
export function effectsFor(input: {
  spec: DirectorSpec;
  scene: Scene;
  /**
   * The window this clip actually occupies after boundary snapping. Effects are
   * timed against it rather than the planned window, so a beat pulse fires on the
   * frame the cut really lands on.
   */
  windowS: [number, number];
  /** True when the clip came from a still rather than generated video. */
  isStill: boolean;
  /** True when a real photograph is showing and needs stylising to match. */
  needsPainterly: boolean;
  /** Scale on camera moves and beat effects, set by the edit style. */
  motion?: number;
  /**
   * Every instant measured in the score, for beat-level choreography.
   *
   * The narrative events are the macro structure — build, drop, resolve — and there
   * are only a handful of them. Between them the picture sat inert while the music
   * did the work. These are the editorial timing: the actual accents the score plays.
   */
  beatsS?: number[];
}): ClipEffect[] {
  const { spec, scene } = input;
  const [windowStart, windowEnd] = input.windowS;
  const own = round(windowEnd - windowStart, 4);
  const effects: ClipEffect[] = [];
  const events = spec.events.filter((e) => e.t >= windowStart - 0.001 && e.t < windowEnd - 0.001);
  const peak = events.reduce((a, e) => Math.max(a, e.intensity), 0);

  if (input.needsPainterly) {
    effects.push({ kind: "painterly", strength: scene.purpose === "recognition" ? 0.6 : 0.85 });
  }

  // Generated video already moves; adding a big camera push on top reads as
  // seasickness. Stills need the move to feel like cinema.
  const motionScale = input.motion ?? 1;
  const amount =
    (input.isStill
      ? scene.purpose === "hero_drop"
        ? 0.24
        : scene.purpose === "recognition"
          ? 0.12
          : 0.17
      : 0.05) * motionScale;
  effects.push({ kind: "camera", move: scene.camera, amount });

  if (input.isStill && (scene.render_mode === "source_motion" || scene.render_mode === "collage")) {
    effects.push({ kind: "parallax", amount: 0.16, layers: 2 });
  }

  for (const e of events) {
    const at = round(e.t - windowStart, 3);
    if (at < 0 || at > own) continue;
    if (e.kind === "drop" || e.kind === "final_hit") {
      effects.push({ kind: "beatPulse", atS: at, amount: 0.1 + 0.14 * e.intensity });
      effects.push({ kind: "bloom", amount: 0.35 + 0.4 * e.intensity, atS: at });
    } else if (e.kind === "accent" || e.kind === "variation") {
      effects.push({ kind: "beatPulse", atS: at, amount: 0.05 + 0.07 * e.intensity });
    } else if (e.kind === "build") {
      effects.push({ kind: "blurBurst", atS: at, amount: 0.25 * e.intensity });
    }
  }

  // Beat-level choreography, but only where the music has actually lifted. A pulse on
  // every measured accent is exhausting and reads as a fault; the contrast between a
  // quiet opening and a choreographed climax is what makes the climax land.
  const energy = energyRegion(spec);
  if (energy && input.beatsS && input.beatsS.length > 0) {
    const [energyFrom, energyTo] = energy;
    const overlaps = windowEnd > energyFrom && windowStart < energyTo;
    if (overlaps) {
      const inWindow = input.beatsS
        .filter((t) => t >= Math.max(windowStart, energyFrom) && t < Math.min(windowEnd, energyTo))
        // The cut is itself the accent at a boundary, so a pulse there doubles it.
        .filter((t) => t - windowStart > 0.18 && windowEnd - t > 0.18)
        // Every other accent. On a 118 BPM score that is roughly one per second.
        .filter((_, i) => i % 2 === 0)
        .slice(0, 4);
      for (const t of inWindow) {
        effects.push({
          kind: "beatPulse",
          atS: round(t - windowStart, 3),
          amount: (0.035 + 0.045 * peak) * (input.motion ?? 1),
        });
      }
    }
  }

  if (own < 2.2) effects.push({ kind: "breathe", amount: 0.05 });
  effects.push({ kind: "vignette", amount: 0.22 + 0.12 * peak });

  return effects;
}

/**
 * Title and caption placement. Text is always drawn by the composer so it is
 * crisp, correctly kerned and never mangled by an image model.
 */
export function overlaysFor(input: {
  spec: DirectorSpec;
  scene: Scene;
  /** The clip's real window after boundary snapping. */
  windowS: [number, number];
  isLast: boolean;
  swatches: string[];
}): Overlay[] {
  const { spec, scene } = input;
  const [windowStart, windowEnd] = input.windowS;
  const own = round(windowEnd - windowStart, 4);
  const out: Overlay[] = [];
  const ink = "#F4EFE7";

  if (scene.title && input.isLast) {
    const finalHit = spec.events.find((e) => e.kind === "final_hit");
    // Land the title on the final hit rather than at a fixed offset, so it
    // punches with the music.
    const at = finalHit
      ? Math.max(0, Math.min(own - 0.8, finalHit.t - windowStart - 0.15))
      : Math.max(0, own - 2.2);
    out.push({
      kind: "title",
      text: scene.title,
      atS: round(at, 3),
      // Clamped to what remains of the window: the 1.2s floor is a minimum to aim
      // for, not a licence to draw past the end of the clip.
      durationS: round(Math.min(own - at, Math.max(1.2, own - at)), 3),
      x: 0.5,
      y: 0.44,
      sizePx: 96,
      font: "display",
      color: ink,
      fadeS: 0.35,
      align: "center",
      trackingPx: 1,
    });
    const logoAt = round(Math.max(0, Math.min(own - 0.6, at + 0.5)), 3);
    out.push({
      kind: "logo",
      text: "MUSE",
      atS: logoAt,
      durationS: round(Math.max(0, own - logoAt), 3),
      x: 0.5,
      y: 0.54,
      sizePx: 26,
      font: "mono",
      color: input.swatches[0] ?? "#E8A44C",
      fadeS: 0.3,
      align: "center",
      trackingPx: 8,
    });
  }

  return out;
}

// ── manifest ─────────────────────────────────────────────────────────────────

export interface ClipInput {
  scene: Scene;
  /** Rendered clip for this scene, already conformed to its clip duration. */
  path: string;
  sha256: string;
  sourceDurationS: number;
  /** True when the deterministic engine produced it. */
  fromFallback: boolean;
  /** True when the clip came from a still image rather than generated motion. */
  isStill: boolean;
  needsPainterly: boolean;
  /**
   * The photograph this scene's imagery was derived from, when there is one.
   *
   * Present only for the opening shot, which is where it earns its keep: the film can
   * start on the picture somebody actually uploaded and become the stylised world in
   * one continuous shot, so the transformation is visible rather than implied.
   */
  originPath?: string;
  originSha256?: string;
}

export interface AudioInput {
  path: string;
  sha256: string;
  durationS: number;
  fromFallback: boolean;
  /** Highest absolute sample in the score, 0..1. Used to give the bed headroom. */
  peak?: number;
  /**
   * The measured loudness curve of the score, when there is one.
   *
   * Present so the plan can tell whether the music actually rises into the payoff. A model
   * takes a tempo and an instrument list reliably and takes structure badly, so this is the
   * only way to know whether the arc that was asked for arrived.
   */
  energy?: EnergyPoint[];
}

/**
 * Anchors a cut may land on, taken from the measured waveform.
 *
 * Only structurally strong instants qualify. Cutting onto a weak incidental onset
 * is worse than not moving at all: it lands the edit on something the listener
 * does not perceive as a beat, which reads as arbitrary rather than musical.
 */
export function cuttableAnchors(
  actual: { anchors: MusicAnchor[] } | null,
  density: "all" | "strong" = "all",
): number[] {
  if (!actual) return [];
  // "strong" keeps only structural instants, which produces a wider, slower edit
  // because there are simply fewer places a cut is allowed to land.
  const KINDS =
    density === "strong"
      ? new Set(["downbeat", "drop", "peak", "section"])
      : new Set(["downbeat", "accent", "drop", "peak", "section"]);
  const floor = density === "strong" ? 0.75 : 0.6;
  return actual.anchors
    .filter((a) => KINDS.has(a.kind) || a.strength >= floor)
    .map((a) => round(a.t, 4))
    .sort((x, y) => x - y);
}

/**
 * Assemble the manifest. Everything the composer needs is resolved here, so the
 * render step makes no decisions and can be re-run from the manifest alone.
 */
/**
 * When the photograph turns, and how long it takes.
 *
 * The photograph has to be on screen long enough to be recognised as a photograph —
 * roughly a beat — or the transformation has nothing to transform from. It also has to
 * finish before the shot ends, so the shot lands already inside the film rather than
 * mid-change. Both are expressed as fractions of the shot so a short opening still
 * reads correctly.
 */
export function revealWindow(shotDurationS: number): { startS: number; durationS: number } {
  const hold = Math.min(1.4, Math.max(0.5, shotDurationS * 0.22));
  const durationS = Math.max(0.9, Math.min(shotDurationS - hold - 0.4, shotDurationS * 0.55));
  return { startS: round(hold, 3), durationS: round(durationS, 3) };
}

/**
 * Decide whether the mix has to impose a dynamic arc, and over what window.
 *
 * The lift runs from the build event to the drop, so the music arrives at full exactly
 * where the picture pays off. Returns null when the score already has dynamics of its own,
 * which is the case worth leaving alone.
 */
/**
 * How far to pull the score down before anything is mixed into it.
 *
 * A generated score can arrive already clipped: one came back with 5,621 samples at full
 * scale, and the master limiter cleaned up 99.4% of it — which means the mix was rescuing
 * the source rather than shaping it, and the only reason it sounded acceptable is that the
 * limiter is good. Trimming a hot bed first leaves the limiter to do what it is for, which
 * is catching what the accents and the codec add.
 *
 * Anything already below the target is left alone: quiet material must not be pushed up,
 * because that is the failure the limiter cannot undo.
 */
export function bedTrimDb(peak: number | undefined, targetDbFs = -1.5): number {
  if (peak === undefined || !Number.isFinite(peak) || peak <= 0) return 0;
  const peakDb = 20 * Math.log10(Math.min(1, peak));
  return peakDb > targetDbFs ? round(targetDbFs - peakDb, 2) : 0;
}

export function audioArc(
  spec: DirectorSpec,
  energy: EnergyPoint[] | undefined,
): { quietGain: number; liftFromS: number; liftToS: number } | null {
  if (!energy || energy.length < 4) return null;

  const build = spec.events.find((e) => e.kind === "build");
  const drop = spec.events.find((e) => e.kind === "drop");
  const resolve = spec.events.find((e) => e.kind === "resolve");
  if (!drop) return null;

  const buildFromS = build ? build.t : Math.max(0, drop.t * 0.7);
  const dynamics = measureDynamics({
    energy,
    buildFromS,
    dropAtS: drop.t,
    resolveAtS: resolve ? resolve.t : spec.duration_s,
  });
  if (!dynamics.flat) return null;

  // Deep enough to be unmistakably quieter, shallow enough that the opening is still
  // clearly playing: an inaudible intro is a different fault, not a fix for this one.
  return {
    quietGain: 0.55,
    liftFromS: round(buildFromS, 3),
    liftToS: round(drop.t, 3),
  };
}

export function buildManifest(input: {
  projectId: string;
  spec: DirectorSpec;
  specVersion: number;
  clips: ClipInput[];
  audio: AudioInput;
  reconciliation: Reconciliation | null;
  /**
   * Every instant measured in the score. Cuts are placed on these, so the set has
   * to be the dense measured one — the handful of reconciled plan events is far
   * too sparse for a boundary to reliably find a beat near it.
   */
  cutAnchorsS?: number[];
  /**
   * Which reading of the material this is. Omitted means the edit the Director
   * planned. An edit changes only composition, so it costs nothing and touches no
   * plan.
   */
  edit?: EditStyle;
}): RenderManifest {
  const { spec } = input;
  const bundle = getBundle(spec.style_bible.preset);
  const byScene = new Map(input.clips.map((c) => [c.scene.id, c]));

  // Place the cuts on real accents before anything else is computed, so every
  // window, transition and overlay below is derived from where the cut actually
  // lands rather than from where the plan hoped it would.
  const style = input.edit ?? editStyle("as_cut");
  const anchorSource =
    input.cutAnchorsS && input.cutAnchorsS.length > 0
      ? input.cutAnchorsS
      : input.reconciliation
        ? input.reconciliation.snappedEvents.map((e) => e.t)
        : spec.events.map((e) => e.t);
  // Passing no anchors leaves every boundary exactly where the plan put it, which
  // is what the comparison edit is for.
  const snap = snapSceneBoundaries(spec, style.snapCuts ? anchorSource : []);

  const clips: ManifestClip[] = spec.scenes.map((scene, i) => {
    const src = byScene.get(scene.id);
    const startS = snap.boundaries[i];
    const endS = snap.boundaries[i + 1];
    const own = round(endS - startS, 4);
    const kind = i === 0 ? "cut" : (style.forceTransition ?? scene.transition_in);
    const tIn =
      i === 0 ? 0 : quantize(transitionDuration(kind, own) * style.transitionScale);

    if (!src) {
      // A scene with no asset still occupies its slot; a flat colour is better
      // than a hole in the timeline, and the check step will flag it.
      return {
        sceneId: scene.id,
        startS,
        endS,
        source: { kind: "color", hex: "#0A0A0C" },
        transitionIn: kind,
        transitionDurationS: tIn,
        effects: [{ kind: "vignette", amount: 0.3 }],
        overlays: overlaysFor({
          spec,
          scene,
          windowS: [startS, endS],
          isLast: i === spec.scenes.length - 1,
          swatches: bundle.swatches,
        }),
        renderMode: scene.render_mode,
        fromFallback: true,
      };
    }

    // The opening shot is the one place the audience can be shown what MUSE did,
    // rather than told: their own photograph, changing into the film.
    const opensOnPhoto = i === 0 && Boolean(src.originPath) && Boolean(src.originSha256);
    const reveal = opensOnPhoto
      ? revealWindow(own)
      : { startS: 0, durationS: 0 };

    return {
      sceneId: scene.id,
      startS,
      endS,
      source: opensOnPhoto
        ? {
            kind: "transform",
            fromPath: src.originPath as string,
            fromSha256: src.originSha256 as string,
            toPath: src.path,
            toSha256: src.sha256,
            toDurationS: src.sourceDurationS,
            method: "paint_reveal",
            revealStartS: reveal.startS,
            revealDurationS: reveal.durationS,
          }
        : {
            kind: "video",
            path: src.path,
            sha256: src.sha256,
            trimStartS: 0,
            sourceDurationS: src.sourceDurationS,
          },
      transitionIn: kind,
      transitionDurationS: tIn,
      effects: effectsFor({
        spec,
        scene,
        windowS: [startS, endS],
        isStill: src.isStill,
        needsPainterly: src.needsPainterly,
        motion: style.motion,
        beatsS: anchorSource,
      }),
      overlays: overlaysFor({
        spec,
        scene,
        windowS: [startS, endS],
        isLast: i === spec.scenes.length - 1,
        swatches: bundle.swatches,
      }),
      renderMode: src.isStill ? `${scene.render_mode} (still)` : scene.render_mode,
      fromFallback: src.fromFallback,
    };
  });

  // Deterministic accents fill in wherever the score lacked a beat the plan
  // called for, so a weak generated track still lands its drop.
  const accents: ManifestAudio["accents"] = [];
  if (input.reconciliation) {
    for (const kind of input.reconciliation.unmatched) {
      const ev = spec.events.find((e) => e.kind === kind);
      if (!ev) continue;
      if (kind === "drop" || kind === "final_hit") {
        accents.push({ atS: ev.t, kind: "impact", gainDb: -6 });
        if (kind === "drop") accents.push({ atS: round(ev.t - 1.6, 3), kind: "riser", gainDb: -11 });
      } else if (kind === "build") {
        accents.push({ atS: ev.t, kind: "riser", gainDb: -13 });
      } else if (kind === "accent") {
        accents.push({ atS: ev.t, kind: "sweep", gainDb: -15 });
      }
    }
  }

  // What the cuts were actually placed against, so the timeline and the
  // verification measure the same thing the composer used.
  const anchorsS = anchorSource;

  // A score that never rises leaves the film with nothing to build into, however exactly
  // the cuts sit on its beats. Where the music was measured flat the mix supplies the arc
  // instead of a music model being paid again to be asked the same thing.
  const arc = audioArc(spec, input.audio.energy);

  const audio: ManifestAudio = {
    path: input.audio.path,
    sha256: input.audio.sha256,
    trimStartS: 0,
    gainDb: bedTrimDb(input.audio.peak),
    fadeInS: 0.12,
    fadeOutS: Math.min(0.9, spec.duration_s * 0.06),
    accents: accents.filter((a) => a.atS >= 0 && a.atS <= spec.duration_s),
    fromFallback: input.audio.fromFallback,
    ...(arc ? { arc } : {}),
  };

  const inputHashes: Record<string, string> = { audio: input.audio.sha256 };
  for (const c of input.clips) inputHashes[c.scene.id] = c.sha256;

  return {
    manifestVersion: "1.0",
    projectId: input.projectId,
    specVersion: input.specVersion,
    title: spec.title,
    createdAt: new Date().toISOString(),
    width: OUTPUT.width,
    height: OUTPUT.height,
    fps: OUTPUT.fps,
    durationS: quantize(spec.duration_s),
    audio,
    clips,
    anchorsS,
    style: {
      grain: Math.max(0, Math.min(1, spec.style_bible.grain * style.grain)),
      palette: [...spec.style_bible.palette],
      preset: spec.style_bible.preset,
      edit: style.id,
      grade: {
        warmth: bundle.grade.warmth * style.grade.warmth,
        contrast: bundle.grade.contrast * style.grade.contrast,
        saturation: bundle.grade.saturation * style.grade.saturation,
        lift: bundle.grade.lift,
      },
    },
    inputHashes,
    templateVersions: {
      bundle: bundleVersionString(bundle),
      manifest: "1.0",
      spec: spec.spec_version,
      specVersion: input.specVersion,
      cutsSnapped: snap.moved,
      maxCutShiftMs: Math.round(snap.maxShiftS * 1000),
    },
  };
}

/** Sanity-check a manifest before spending a render on it. */
export function validateManifest(m: RenderManifest): string[] {
  const issues: string[] = [];
  if (m.clips.length === 0) issues.push("manifest has no clips");

  let expected = 0;
  for (const [i, c] of m.clips.entries()) {
    if (c.endS <= c.startS) issues.push(`${c.sceneId}: end is not after start`);
    if (i === 0 && c.transitionDurationS > 0) issues.push("the first clip must be a hard cut");
    if (i > 0 && Math.abs(c.startS - m.clips[i - 1].endS) > 0.002) {
      issues.push(`${c.sceneId}: does not butt against the previous clip`);
    }
    if (c.source.kind === "video") {
      const need = c.endS - c.startS + c.transitionDurationS;
      if (c.source.sourceDurationS + 0.08 < need) {
        issues.push(
          `${c.sceneId}: clip is ${c.source.sourceDurationS.toFixed(2)}s but needs ${need.toFixed(2)}s`,
        );
      }
    }
    expected += c.endS - c.startS;
  }
  if (Math.abs(expected - m.durationS) > 0.05) {
    issues.push(`clips sum to ${expected.toFixed(2)}s but duration is ${m.durationS.toFixed(2)}s`);
  }
  if (!m.audio.path) issues.push("manifest has no audio");
  return issues;
}
