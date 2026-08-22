/**
 * ffmpeg filter-expression library.
 *
 * Every function here is pure: it takes numbers and enums and returns a
 * filtergraph string. Nothing spawns a process, touches the filesystem (beyond
 * probing for an installed font file) or makes a decision about inputs and
 * outputs — that belongs to the composer. Keeping the graph builders pure is
 * what makes the visual language testable: a graph can be asserted on as a
 * string and then rendered to prove it compiles.
 *
 * Two conventions hold throughout.
 *
 * 1. A "linear fragment" is a comma-joined run of filters with no labels. It
 *    may branch internally (see `bloom`), but it always begins with a filter
 *    that consumes the enclosing chain's input and ends with one that produces
 *    the enclosing chain's output, so fragments concatenate with commas.
 * 2. A "labelled fragment" is one or more semicolon-separated chains that read
 *    a named input and write a named output (see `parallax`, `transition`).
 *
 * Time-varying expressions are written as closed-form functions of the frame
 * index rather than accumulators, so a move lands exactly on its target value
 * on the last frame and two renders of the same graph are identical.
 */
import fs from "node:fs";
import path from "node:path";
import { OUTPUT } from "@/lib/core/config";
import { clamp, round, MuseError } from "@/lib/core/util";
import type { CameraMove, Transition } from "@/lib/spec/directorSpec";
import type { ClipEffect, Overlay } from "@/lib/compose/types";

const W = OUTPUT.width;
const H = OUTPUT.height;

/**
 * Photographs put faces and horizons above the geometric centre, so the
 * vertical crop window sits above the middle by default. 0.5 is dead centre.
 */
const DEFAULT_CROP_BIAS_Y = 0.42;

/** Canvas-tooth noise seed. Fixed so a painterly pass is byte-reproducible. */
const CANVAS_SEED = 90124;

// ── expression plumbing ──────────────────────────────────────────────────────

/**
 * Format a number for an ffmpeg expression. Fixed precision with the trailing
 * zeros trimmed, never exponent notation — ffmpeg's parser rejects `1e-7`.
 */
function nf(v: number, dp = 5): string {
  if (!Number.isFinite(v)) return "0";
  const r = round(v, dp);
  if (Math.abs(r) < 1e-6) return "0";
  return r.toFixed(dp).replace(/0+$/, "").replace(/\.$/, "");
}

/** Frame count for a duration, never zero: expressions divide by frames - 1. */
function frameCount(durationS: number, fps: number): number {
  return Math.max(1, Math.round(Math.max(0, durationS) * fps));
}

/** Filtergraph labels are referenced by name, so keep them to a safe charset. */
function sanitizeLabel(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_]/g, "_");
  return t.length > 0 ? t : "lbl";
}

function evenUp(n: number): number {
  const i = Math.ceil(n);
  return i % 2 === 0 ? i : i + 1;
}

function usableFps(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : OUTPUT.fps;
}

/** 0..1 progress across the clip, driven by the frame counter of the filter. */
function progressExpr(frames: number, frameVar: "on" | "n"): string {
  return frames > 1 ? `(${frameVar}/${frames - 1})` : "(0)";
}

/** Smoothstep. Camera moves that start and stop abruptly read as mechanical. */
function easeExpr(p: string): string {
  return `(${p}*${p}*(3-2*${p}))`;
}

/**
 * zoompan magnifies by cropping an `iw/zoom` x `ih/zoom` region and scaling it
 * to the output size, so `zoom` is clipped to >= 1 by the filter itself and no
 * expression here can expose a black edge. `fx`/`fy` place that region on a
 * 0..1 scale, 0 being the left/top edge and 1 the right/bottom edge.
 */
function zoompanChain(z: string, fx: string, fy: string, fps: number): string {
  return [
    `zoompan=z='${z}'`,
    `x='(iw-iw/zoom)*(${fx})'`,
    `y='(ih-ih/zoom)*(${fy})'`,
    "d=1",
    `s=${W}x${H}`,
    `fps=${nf(fps, 4)}`,
  ].join(":");
}

// ── framing ──────────────────────────────────────────────────────────────────

/**
 * Scale-and-crop any input to exactly 1080x1920 without distortion, biased to
 * keep the subject-safe region. Always the first link in a clip's chain.
 */
export function fitVertical(opts?: { biasY?: number }): string {
  const bias = clamp(opts?.biasY ?? DEFAULT_CROP_BIAS_Y, 0, 1);
  return [
    `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic`,
    "setsar=1",
    `crop=${W}:${H}:(iw-ow)/2:(ih-oh)*${nf(bias)}`,
  ].join(",");
}

// ── camera ───────────────────────────────────────────────────────────────────

/** Moves with no zoom ramp, which a plain scale+crop can express on video. */
const FLAT_MOVES: readonly CameraMove[] = [
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "whip",
  "handheld_drift",
];

interface MoveShape {
  /** zoompan `z` expression. */
  z: string;
  /** Constant magnification, or null when the move ramps its zoom. */
  flatZoom: number | null;
  fx: string;
  fy: string;
}

function moveShape(
  move: CameraMove,
  a: number,
  frames: number,
  fps: number,
  frameVar: "on" | "n",
): MoveShape {
  const p = progressExpr(frames, frameVar);
  const s = easeExpr(p);
  const mid = "0.5";

  /** Zoom that ramps between two magnifications over the clip. */
  const ramp = (from: number, to: number): string => `${nf(from)}+${nf(to - from)}*${s}`;
  const flat = (z: number): MoveShape => ({ z: nf(z), flatZoom: z, fx: mid, fy: mid });

  switch (move) {
    case "static":
      return flat(1);

    case "push_in": {
      const z = 1 + 0.24 * a;
      // Push toward the upper safe band, where a subject usually sits.
      return { z: ramp(1, z), flatZoom: null, fx: mid, fy: "0.47" };
    }

    case "pull_out": {
      const z = 1 + 0.24 * a;
      return { z: ramp(z, 1), flatZoom: null, fx: mid, fy: "0.47" };
    }

    case "dolly_out": {
      const z = 1 + 0.32 * a;
      // Retreating camera also settles downward, which separates a dolly from
      // a straight zoom out.
      return { z: ramp(z, 1), flatZoom: null, fx: mid, fy: `(0.5+0.35*${s})` };
    }

    case "pan_left": {
      const shape = flat(1 + 0.22 * a);
      return { ...shape, fx: `(1-${s})` };
    }

    case "pan_right": {
      const shape = flat(1 + 0.22 * a);
      return { ...shape, fx: `${s}` };
    }

    case "tilt_up": {
      const shape = flat(1 + 0.22 * a);
      return { ...shape, fy: `(1-${s})` };
    }

    case "tilt_down": {
      const shape = flat(1 + 0.22 * a);
      return { ...shape, fy: `${s}` };
    }

    case "parallax_drift": {
      // A drifting diagonal under a slow push reads as depth even on one layer.
      return {
        z: ramp(1 + 0.06 * a, 1 + 0.22 * a),
        flatZoom: null,
        fx: `(0.35+0.3*${s})`,
        fy: `(0.6-0.2*${s})`,
      };
    }

    case "handheld_drift": {
      const shape = flat(1 + 0.12 * a);
      // Two incommensurate sinusoids per axis: no repeat inside a reel, and
      // fully deterministic, unlike sampling a noise source.
      const t = `(${frameVar}/${nf(fps, 4)})`;
      return {
        ...shape,
        fx: `(0.5+0.3*sin(2*PI*0.23*${t})+0.1*sin(2*PI*0.79*${t}+1.7))`,
        fy: `(0.5+0.3*cos(2*PI*0.31*${t})+0.09*cos(2*PI*0.97*${t}+0.6))`,
      };
    }

    case "whip": {
      const shape = flat(1 + 0.3 * a);
      // Covers most of its travel in the first third, then settles centre.
      const denom = Math.max(1, Math.round((frames - 1) * 0.32));
      const q = frames > 1 ? `min(${frameVar}/${denom},1)` : "1";
      return { ...shape, fx: `(0.5+0.5*pow(1-${q},3))` };
    }
  }
}

/**
 * Ken Burns and friends: a continuous camera move over a still or a clip,
 * expressed with zoompan for stills and scale+crop with time-varying offsets
 * for video.
 *
 * `crop` evaluates x and y once per frame but fixes its width and height at
 * configuration time, so it can translate but not zoom; moves that ramp their
 * magnification therefore go through zoompan even on video.
 */
export function cameraMove(
  move: CameraMove,
  opts: { durationS: number; fps: number; amount: number; forVideo: boolean },
): string {
  const a = clamp(opts.amount, 0, 1);
  const fps = usableFps(opts.fps);
  const frames = frameCount(opts.durationS, fps);
  if (move === "static" || a <= 0 || frames < 2) return "null";

  const asCrop = opts.forVideo && FLAT_MOVES.includes(move);
  const shape = moveShape(move, a, frames, fps, asCrop ? "n" : "on");

  if (asCrop && shape.flatZoom !== null) {
    const sw = evenUp(W * shape.flatZoom);
    const sh = evenUp(H * shape.flatZoom);
    return [
      `scale=${sw}:${sh}:flags=bicubic`,
      "setsar=1",
      `crop=${W}:${H}:'(iw-ow)*(${shape.fx})':'(ih-oh)*(${shape.fy})'`,
    ].join(",");
  }
  return zoompanChain(shape.z, shape.fx, shape.fy, fps);
}

// ── parallax ─────────────────────────────────────────────────────────────────

/**
 * Soft elliptical aperture used to lift a foreground card out of a flat still.
 * Built at a low resolution and scaled up, which is both far cheaper than a
 * full-size per-pixel expression and inherently smooth.
 */
function apertureMask(radius: number): string {
  const rx = nf(0.42 * radius);
  const ry = nf(0.32 * radius);
  const d = `hypot((X-W/2)/(${rx}*W),(Y-H*0.46)/(${ry}*H))`;
  return [
    "format=gray",
    "scale=108:192:flags=bilinear",
    `geq=lum='255*(1-clip((${d}-0.55)/0.45,0,1))'`,
    `scale=${W}:${H}:flags=bicubic`,
    "format=gray",
  ].join(",");
}

/**
 * Multi-layer 2.5D parallax from one still: background pushed and offset at a
 * different rate than the foreground, composited back together. Returns a full
 * filtergraph fragment that takes one labelled input and yields one labelled
 * output.
 *
 * Without a depth map the split is geometric — the centre of frame is treated
 * as near and the surround as far. That is the assumption a photographer
 * already made when they framed the shot, so it holds far more often than not.
 */
export function parallax(opts: {
  inLabel: string;
  outLabel: string;
  durationS: number;
  fps: number;
  amount: number;
  layers: number;
}): string {
  const a = clamp(opts.amount, 0, 1);
  const layers = Math.round(clamp(opts.layers, 2, 4));
  const fps = usableFps(opts.fps);
  const frames = frameCount(opts.durationS, fps);
  const s = easeExpr(progressExpr(frames, "on"));
  const tag = `${sanitizeLabel(opts.outLabel)}_px`;

  const branches: string[] = [];
  for (let i = 0; i < layers; i++) branches.push(`${tag}s${i}`);
  for (let k = 1; k < layers; k++) branches.push(`${tag}m${k}`);

  const parts: string[] = [
    `[${opts.inLabel}]split=${branches.length}${branches.map((b) => `[${b}]`).join("")}`,
  ];

  // Backmost layer: least movement, and a touch of blur for depth of field.
  const bgZoom = 1 + 0.05 * a;
  const bgBlur = a > 0.05 ? `,gblur=sigma=${nf(1.2 + 2.4 * a)}:steps=1` : "";
  parts.push(
    `[${tag}s0]${zoompanChain(
      `1+${nf(bgZoom - 1)}*${s}`,
      `(0.5-${nf(0.1 * a)}*${s})`,
      "0.5",
      fps,
    )}${bgBlur}[${tag}c0]`,
  );

  for (let k = 1; k < layers; k++) {
    // Nearer cards magnify and travel more; that rate difference is the effect.
    const z = 1 + a * (0.05 + 0.11 * k);
    const layerChain = zoompanChain(
      `1+${nf(z - 1)}*${s}`,
      `(0.5+${nf(0.1 * a * k)}*${s})`,
      `(0.5-${nf(0.05 * a * k)}*${s})`,
      fps,
    );
    parts.push(`[${tag}s${k}]${layerChain},format=yuva420p[${tag}f${k}]`);
    parts.push(`[${tag}m${k}]${apertureMask(1 - 0.22 * (k - 1))}[${tag}k${k}]`);
    parts.push(`[${tag}f${k}][${tag}k${k}]alphamerge[${tag}a${k}]`);
    const under = `${tag}c${k - 1}`;
    const over = k === layers - 1 ? opts.outLabel : `${tag}c${k}`;
    // An explicit working format keeps the composite out of RGB, which would
    // change what plane indices mean for anything downstream.
    parts.push(
      `[${under}][${tag}a${k}]overlay=x=0:y=0:format=yuv420:eof_action=pass:shortest=0[${over}]`,
    );
  }

  return parts.join(";");
}

// ── look ─────────────────────────────────────────────────────────────────────

/**
 * Painterly treatment for an un-stylised source photograph: edge-preserving
 * smoothing plus a light unsharp pass and a subtle canvas feel, so a real photo
 * sits beside generated painterly frames without looking out of place.
 */
export function painterly(strength: number): string {
  const st = clamp(strength, 0, 1);
  if (st <= 0) return "null";
  // Bilateral flattens the interiors while keeping contours, which is what
  // separates a painted look from a blurred one.
  const sigmaS = nf(5 + 13 * st, 3);
  const sigmaR = nf(0.05 + 0.13 * st, 4);
  const sharpen = nf(0.4 + 0.9 * st, 3);
  const tooth = Math.round(1 + 3 * st);
  return [
    `bilateral=sigmaS=${sigmaS}:sigmaR=${sigmaR}:planes=1`,
    `unsharp=5:5:${sharpen}:5:5:0`,
    `noise=alls=${tooth}:allf=p+a:all_seed=${CANVAS_SEED}`,
  ].join(",");
}

/** Colour grade toward the style bible: warmth, contrast, saturation and shadow lift. */
export function grade(opts: {
  warmth: number;
  contrast: number;
  saturation: number;
  lift: number;
}): string {
  const warmth = clamp(opts.warmth, -1, 1);
  const contrast = clamp(opts.contrast, -1, 1);
  const saturation = clamp(opts.saturation, -1, 1);
  const lift = clamp(opts.lift, 0, 1);
  const filters: string[] = [];

  if (Math.abs(warmth) > 0.001) {
    // Warmth is a red/blue seesaw weighted toward the shadows, which is how a
    // tungsten-balanced stock behaves; a flat hue rotation looks like a filter.
    filters.push(
      [
        `colorbalance=rs=${nf(warmth * 0.1)}`,
        `bs=${nf(-warmth * 0.08)}`,
        `rm=${nf(warmth * 0.06)}`,
        `bm=${nf(-warmth * 0.06)}`,
        `rh=${nf(warmth * 0.04)}`,
        `bh=${nf(-warmth * 0.05)}`,
      ].join(":"),
    );
  }

  if (Math.abs(contrast) > 0.001 || Math.abs(saturation) > 0.001) {
    filters.push(
      `eq=contrast=${nf(1 + contrast * 0.35)}:saturation=${nf(clamp(1 + saturation * 0.5, 0, 3))}`,
    );
  }

  if (lift > 0.001) {
    // Raising the output black point, blue furthest, is the film-print look.
    // colorlevels only works in RGB, so the format is restored afterwards to
    // keep plane indices meaningful for whatever follows in the chain.
    filters.push(
      [
        `colorlevels=romin=${nf(lift * 0.05)}`,
        `gomin=${nf(lift * 0.055)}`,
        `bomin=${nf(lift * 0.07)}`,
      ].join(":"),
      "format=yuv420p",
    );
  }

  return filters.length > 0 ? filters.join(",") : "null";
}

/**
 * Film grain: temporal uniform noise at a fixed seed. Applied last in a clip
 * chain so it sits on top of the picture the way real grain does.
 */
export function grain(amount: number, seed: number): string {
  const a = clamp(amount, 0, 1);
  const strength = Math.round(a * 14);
  if (strength <= 0) return "null";
  const s = Math.abs(Math.trunc(seed)) % 2147483647;
  return `noise=alls=${strength}:allf=t+u:all_seed=${s}`;
}

/**
 * Halation/bloom: highlights above a threshold are isolated, blurred wide and
 * screened back over the luma. Chroma is left alone, because screening the
 * chroma planes of a YUV frame shifts hues rather than adding glow.
 *
 * `scope` namespaces the internal labels so several blooms can live in one
 * graph; `atS` restricts the glow to a window around an accent.
 */
export function bloom(amount: number, opts?: { scope?: string; atS?: number }): string {
  const a = clamp(amount, 0, 1);
  if (a <= 0) return "null";
  const tag = `${sanitizeLabel(opts?.scope ?? "bloom")}_bl`;
  const threshold = Math.round(200 - 45 * a);
  const gain = nf(1.2 + 0.8 * a, 3);
  const sigma = nf(14 + 26 * a, 3);
  const opacity = nf(clamp(0.22 + 0.45 * a, 0, 1), 3);
  const gate =
    opts?.atS === undefined
      ? ""
      : `:enable='between(t,${nf(Math.max(0, opts.atS - 0.2))},${nf(Math.max(0, opts.atS) + 0.6)})'`;

  return [
    // The pixel format is pinned because blend addresses planes by index: on a
    // GBRP frame c0 is green, not luma, and the glow would tint the picture.
    `format=yuv420p,split=2[${tag}base][${tag}hi]`,
    `[${tag}hi]lutyuv=y='if(gt(val,${threshold}),(val-${threshold})*${gain},0)',` +
      `gblur=sigma=${sigma}:steps=2[${tag}glow]`,
    `[${tag}base][${tag}glow]blend=c0_mode=screen:c0_opacity=${opacity}` +
      `:c1_mode=normal:c1_opacity=0:c2_mode=normal:c2_opacity=0${gate}`,
  ].join(";");
}

/**
 * Vignette to hold the eye centre-frame.
 *
 * The centre stays at the middle of the frame: the filter normalises distance
 * against the corner nearest the origin, so moving the centre off it drives the
 * far corners past the falloff limit and clamps them to solid black. The angle
 * range was calibrated by measuring corner brightness on a flat grey frame —
 * 0.18 rad holds about 93% of the corner, 0.55 rad about half.
 *
 * Dithering is disabled because it is seeded outside our control and would make
 * two renders differ byte for byte; the grain pass covers the banding it would
 * otherwise have hidden.
 */
export function vignette(amount: number): string {
  const a = clamp(amount, 0, 1);
  if (a <= 0) return "null";
  const angle = nf(0.18 + 0.37 * a, 4);
  return `vignette=angle=${angle}:x0=w/2:y0=h/2:mode=forward:eval=init:dither=0`;
}

// ── beat-locked accents ──────────────────────────────────────────────────────

/** Gaussian bump centred on a beat, in the units of the given time expression. */
function bumpExpr(timeExpr: string, atS: number, tauS: number): string {
  return `exp(-pow((${timeExpr}-${nf(Math.max(0, atS))})/${nf(tauS, 4)},2))`;
}

/**
 * A brief exposure/scale pulse at a beat, for cutting on the music. `atS` is
 * measured from the start of the clip, not the reel.
 */
export function beatPulse(opts: { atS: number; amount: number; fps: number }): string {
  const a = clamp(opts.amount, 0, 1);
  if (a <= 0) return "null";
  const fps = usableFps(opts.fps);
  const tau = 0.09;
  const zBump = bumpExpr(`on/${nf(fps, 4)}`, opts.atS, tau);
  const eBump = bumpExpr("t", opts.atS, tau);
  return [
    zoompanChain(`1+${nf(0.045 * a)}*${zBump}`, "0.5", "0.5", fps),
    [
      "eq=eval=frame",
      `brightness='${nf(0.12 * a)}*${eBump}'`,
      `contrast='1+${nf(0.1 * a)}*${eBump}'`,
      `saturation='1+${nf(0.1 * a)}*${eBump}'`,
    ].join(":"),
  ].join(",");
}

/**
 * Radial blur burst on a beat. gblur cannot ramp its sigma, so three nested
 * enable windows are stacked instead; gaussians compose as the root of the sum
 * of squares, which gives a smooth swell up and back down.
 */
export function blurBurst(opts: { atS: number; amount: number }): string {
  const a = clamp(opts.amount, 0, 1);
  if (a <= 0) return "null";
  const at = Math.max(0, opts.atS);
  const base = 6 * a;
  const win = 0.14;
  const layer = (half: number, sigma: number): string =>
    `gblur=sigma=${nf(sigma, 3)}:steps=1:enable='between(t,${nf(Math.max(0, at - half))},${nf(at + half)})'`;
  return [
    layer(win, base * 0.5),
    layer(win * 0.6, base * 0.7),
    layer(win * 0.25, base),
    // A lateral smear at the peak reads as camera movement, not softness;
    // dblur's angle 0 is the horizontal direction.
    `dblur=angle=0:radius=${nf(8 * a, 3)}:enable='between(t,${nf(Math.max(0, at - win * 0.25))},${nf(at + win * 0.25)})'`,
  ].join(",");
}

/**
 * Slow continuous zoom that hides seams on short or looped clips. The zoom
 * returns to 1.0 on the last frame, so a looped clip has no visible seam.
 */
export function breathe(opts: { amount: number; durationS: number; fps: number }): string {
  const a = clamp(opts.amount, 0, 1);
  if (a <= 0) return "null";
  const fps = usableFps(opts.fps);
  const frames = frameCount(opts.durationS, fps);
  if (frames < 2) return "null";
  const cycle = `(0.5-0.5*cos(2*PI*on/${frames}))`;
  return zoompanChain(`1+${nf(0.06 * a)}*${cycle}`, "0.5", "0.5", fps);
}

// ── clip chain ───────────────────────────────────────────────────────────────

/**
 * Order effects are applied in, regardless of the order they arrive in.
 * Geometry first, then colour, then texture: grain and vignette belong on top
 * of a finished picture, and a grade applied after grain amplifies the noise.
 */
const EFFECT_ORDER: readonly ClipEffect["kind"][] = [
  "painterly",
  "parallax",
  "camera",
  "breathe",
  "grade",
  "bloom",
  "beatPulse",
  "blurBurst",
  "vignette",
  "grain",
];

/** Compose the full per-clip chain from a list of effects, in a fixed sensible order. */
export function clipChain(opts: {
  inLabel: string;
  outLabel: string;
  effects: ClipEffect[];
  durationS: number;
  fps: number;
  isStill: boolean;
  seed: number;
}): string {
  const fps = usableFps(opts.fps);
  const scope = sanitizeLabel(opts.outLabel);
  const ordered = EFFECT_ORDER.flatMap((kind) => opts.effects.filter((e) => e.kind === kind));

  const chains: string[] = [];
  // Framing and a constant frame rate come first: every time-varying
  // expression below counts frames, so the cadence has to be known.
  let linear: string[] = [fitVertical(), `fps=${nf(fps, 4)}`, "setsar=1"];
  let cursor = opts.inLabel;
  let serial = 0;

  const flush = (): void => {
    const label = `${scope}_s${serial++}`;
    chains.push(`[${cursor}]${linear.length > 0 ? linear.join(",") : "null"}[${label}]`);
    linear = [];
    cursor = label;
  };

  ordered.forEach((effect, index) => {
    if (effect.kind === "parallax") {
      flush();
      const out = `${scope}_s${serial++}`;
      chains.push(
        parallax({
          inLabel: cursor,
          outLabel: out,
          durationS: opts.durationS,
          fps,
          amount: effect.amount,
          layers: effect.layers,
        }),
      );
      cursor = out;
      return;
    }

    let fragment = "null";
    switch (effect.kind) {
      case "painterly":
        fragment = painterly(effect.strength);
        break;
      case "camera":
        fragment = cameraMove(effect.move, {
          durationS: opts.durationS,
          fps,
          amount: effect.amount,
          forVideo: !opts.isStill,
        });
        break;
      case "breathe":
        fragment = breathe({ amount: effect.amount, durationS: opts.durationS, fps });
        break;
      case "grade":
        fragment = grade(effect);
        break;
      case "bloom":
        fragment = bloom(effect.amount, { scope: `${scope}_${index}`, atS: effect.atS });
        break;
      case "beatPulse":
        fragment = beatPulse({ atS: effect.atS, amount: effect.amount, fps });
        break;
      case "blurBurst":
        fragment = blurBurst({ atS: effect.atS, amount: effect.amount });
        break;
      case "vignette":
        fragment = vignette(effect.amount);
        break;
      case "grain":
        fragment = grain(effect.amount, opts.seed + index);
        break;
    }
    if (fragment !== "null") linear.push(fragment);
  });

  linear.push("format=yuv420p");
  chains.push(`[${cursor}]${linear.join(",")}[${opts.outLabel}]`);
  return chains.join(";");
}

// ── transitions ──────────────────────────────────────────────────────────────

/** xfade primitive backing each approved transition that blends two streams. */
const XFADE_NAME: Record<Exclude<Transition, "cut">, string> = {
  crossfade: "fade",
  // The dips are a plain cross dissolve between one stream already fading to
  // the flat colour and another that has not started coming back from it yet,
  // so the midpoint is genuinely that colour. xfade's own fadeblack collapses
  // the outgoing picture inside the first fifth of the window, which reads as
  // a stutter rather than a dip.
  dip_to_black: "fade",
  dip_to_white: "fade",
  flash: "fade",
  whip_pan: "slideleft",
  luma_wipe: "smoothright",
  film_burn: "dissolve",
  // Front-loaded curve: the picture is mostly replaced in the first few
  // frames, so a matched composition reads as a cut rather than a mix.
  match_cut: "fadefast",
};

/** Heat, bleach and bloom ramp used by the film-burn transition. */
function burnChain(ramp: string, gateFrom: number, gateTo: number): string {
  return [
    `eq=eval=frame:brightness='0.3*${ramp}':saturation='1+0.8*${ramp}':gamma='1-0.2*${ramp}'`,
    `hue=h='24*${ramp}'`,
    `gblur=sigma=7:steps=1:enable='between(t,${nf(gateFrom)},${nf(gateTo)})'`,
  ].join(",");
}

/**
 * A transition between two labelled streams, returning the filtergraph
 * fragment that produces `outLabel`.
 *
 * `cut` is a concat, so the result is as long as both inputs together. Every
 * other kind overlaps by `durationS`, so the result is
 * `len(from) + len(to) - durationS`. The blend starts at `offsetS` on the
 * outgoing stream's clock; pass `fromDurationS` instead to place it at that
 * stream's tail, which is what an edit normally wants.
 */
export function transition(opts: {
  fromLabel: string;
  toLabel: string;
  outLabel: string;
  kind: Transition;
  durationS: number;
  fps: number;
  /** Where the blend starts on the outgoing stream. */
  offsetS?: number;
  /** Length of the outgoing stream, used to place the blend at its tail. */
  fromDurationS?: number;
}): string {
  const fps = usableFps(opts.fps);
  const tag = `${sanitizeLabel(opts.outLabel)}_tr`;
  const a = `${tag}a`;
  const b = `${tag}b`;
  // xfade and concat both require the two sides to agree on rate, pixel
  // format, aspect and timebase; disagreement fails at graph-config time.
  const norm = `fps=${nf(fps, 4)},format=yuv420p,setsar=1,settb=AVTB`;

  if (opts.kind === "cut") {
    return [
      `[${opts.fromLabel}]${norm}[${a}]`,
      `[${opts.toLabel}]${norm}[${b}]`,
      `[${a}][${b}]concat=n=2:v=1:a=0[${opts.outLabel}]`,
    ].join(";");
  }

  const d = Math.max(1 / fps, round(Math.max(0, opts.durationS), 4));
  const off =
    opts.offsetS !== undefined
      ? Math.max(0, opts.offsetS)
      : opts.fromDurationS !== undefined
        ? Math.max(0, opts.fromDurationS - d)
        : 0;
  const end = off + d;

  let preA = "";
  let preB = "";
  let post = "";

  switch (opts.kind) {
    // The outgoing stream reaches the flat colour exactly at the midpoint of
    // the blend; the incoming one only starts leaving it there.
    case "dip_to_black":
      preA = `,fade=t=out:st=${nf(off)}:d=${nf(d * 0.5)}:color=black`;
      preB = `,fade=t=in:st=${nf(d * 0.5)}:d=${nf(d * 0.5)}:color=black`;
      break;
    case "dip_to_white":
      preA = `,fade=t=out:st=${nf(off)}:d=${nf(d * 0.5)}:color=white`;
      preB = `,fade=t=in:st=${nf(d * 0.5)}:d=${nf(d * 0.5)}:color=white`;
      break;
    case "flash":
      // Same shape as a dip to white, with the ramps squeezed into the middle
      // of the window so the white is a spike and the rest reads as a cut.
      preA = `,fade=t=out:st=${nf(off + d * 0.3)}:d=${nf(d * 0.2)}:color=white`;
      preB = `,fade=t=in:st=${nf(d * 0.5)}:d=${nf(d * 0.2)}:color=white`;
      break;
    case "whip_pan":
      // The slide supplies the movement, the directional blur the violence.
      post = `,dblur=angle=0:radius=${nf(18)}:enable='between(t,${nf(off)},${nf(end)})'`;
      break;
    case "film_burn":
      preA = `,${burnChain(`clip((t-${nf(off)})/${nf(d)},0,1)`, off + d * 0.45, end)}`;
      preB = `,${burnChain(`clip(1-t/${nf(d)},0,1)`, 0, d * 0.55)}`;
      break;
    case "crossfade":
    case "luma_wipe":
    case "match_cut":
      break;
  }

  const xfade = `xfade=transition=${XFADE_NAME[opts.kind]}:duration=${nf(d)}:offset=${nf(off)}`;
  return [
    `[${opts.fromLabel}]${norm}${preA}[${a}]`,
    `[${opts.toLabel}]${norm}${preB}[${b}]`,
    `[${a}][${b}]${xfade}${post}[${opts.outLabel}]`,
  ].join(";");
}

// ── text ─────────────────────────────────────────────────────────────────────

/** Directories searched for a usable font file, in preference order. */
const FONT_DIRS: readonly string[] = [
  path.join(process.env.WINDIR ?? "C:/Windows", "Fonts"),
  "C:/Windows/Fonts",
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft/Windows/Fonts"),
  "/usr/share/fonts/truetype/dejavu",
  "/usr/share/fonts/TTF",
  "/Library/Fonts",
  "/System/Library/Fonts",
];

/** File names tried for each logical family, in preference order. */
const FONT_CANDIDATES: Record<Overlay["font"], readonly string[]> = {
  display: ["segoeuib.ttf", "arialbd.ttf", "georgiab.ttf", "DejaVuSans-Bold.ttf"],
  sans: ["segoeui.ttf", "arial.ttf", "tahoma.ttf", "verdana.ttf", "DejaVuSans.ttf"],
  mono: ["consola.ttf", "cour.ttf", "lucon.ttf", "DejaVuSansMono.ttf"],
};

/** A font file that exists on this machine, plus its filtergraph-safe form. */
export interface ResolvedFont {
  family: Overlay["font"];
  /** Absolute path as the operating system spells it. */
  path: string;
  /** The same path, escaped for use as a drawtext `fontfile` value. */
  graphValue: string;
}

const fontCache = new Map<Overlay["font"], ResolvedFont>();

/**
 * Resolve a logical font family to a real file. drawtext will not render
 * without one, and fontconfig is not dependable on Windows, so the file is
 * located here and passed explicitly.
 */
export function resolveFont(family: Overlay["font"]): ResolvedFont {
  const cached = fontCache.get(family);
  if (cached) return cached;
  for (const name of FONT_CANDIDATES[family]) {
    for (const dir of FONT_DIRS) {
      if (dir.length === 0) continue;
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) continue;
      const resolved: ResolvedFont = {
        family,
        path: full,
        graphValue: escapeDrawtext(full.replace(/\\/g, "/")),
      };
      fontCache.set(family, resolved);
      return resolved;
    }
  }
  throw new MuseError("permanent", `no font file found for the ${family} family`, {
    tried: FONT_CANDIDATES[family],
    dirs: FONT_DIRS,
  });
}

/**
 * Escape a string for safe use inside a drawtext value.
 *
 * Two unescaping passes run before drawtext sees the text: the filtergraph
 * parser strips one layer, then the filter's own option parser strips another.
 * So a backslash has to arrive as four, and the characters that terminate a
 * filter option (`:`) or a chain (`,` `;` `[` `]`) have to survive both.
 */
export function escapeDrawtext(s: string): string {
  let out = "";
  // A raw newline cannot be carried through a filtergraph argument; drawtext
  // would also treat it as a line break, which callers do not ask for here.
  for (const ch of s.replace(/\r\n?|\n/g, " ")) {
    switch (ch) {
      case "\\":
        out += "\\\\\\\\";
        break;
      case "'":
        out += "\\\\\\'";
        break;
      case ":":
        out += "\\\\\\:";
        break;
      case ",":
        out += "\\,";
        break;
      case ";":
        out += "\\;";
        break;
      case "[":
        out += "\\[";
        break;
      case "]":
        out += "\\]";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** Colours reach us from a generated spec, so only known-safe forms are used. */
function safeColor(value: string, fallback: string): string {
  const t = value.trim();
  const hex = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(t);
  if (hex) return `0x${hex[1]}`;
  if (/^[A-Za-z]{3,24}(@(0|1|0?\.\d{1,3}))?$/.test(t)) return t;
  return fallback;
}

/**
 * drawtext has no letter-spacing option, so tracking is approximated with thin
 * spaces between characters. Below one thin space of travel the request is
 * dropped rather than rendered wrong.
 */
function applyTracking(text: string, sizePx: number, trackingPx: number | undefined): string {
  if (trackingPx === undefined || trackingPx <= 0 || sizePx <= 0) return text;
  const thinSpaceWidth = 0.2 * sizePx;
  const count = Math.round(trackingPx / thinSpaceWidth);
  if (count < 1) return text;
  return [...text].join("\u2009".repeat(count));
}

/** drawtext for a title/caption/logo overlay, with font fallback that works on Windows. */
export function overlayText(o: Overlay, opts: { fps: number }): string {
  const fps = usableFps(opts.fps);
  const font = resolveFont(o.font);
  const size = Math.max(8, Math.round(o.sizePx));
  const text = escapeDrawtext(applyTracking(o.text, size, o.trackingPx));

  // Snap the window to frame boundaries so an overlay never appears for a
  // fraction of a frame or drifts by one against the cut it was placed on.
  const start = Math.max(0, Math.round(o.atS * fps) / fps);
  const stop = start + Math.max(1 / fps, Math.round(Math.max(0, o.durationS) * fps) / fps);

  // Keep text inside the safe band the output format reserves for it.
  const x = clamp(o.x, 0.04, 0.96);
  const y = clamp(o.y, OUTPUT.safeTop, 1 - OUTPUT.safeBottom);
  const anchor = o.align === "left" ? 0 : o.align === "right" ? 1 : 0.5;

  const args: string[] = [
    `fontfile=${font.graphValue}`,
    `text=${text}`,
    // Without this a percent sign or a brace in a title would be read as an
    // expansion directive instead of being drawn.
    "expansion=none",
    `fontcolor=${safeColor(o.color, "white")}`,
    `fontsize=${size}`,
    `x=(w*${nf(x)})-text_w*${nf(anchor)}`,
    `y=(h*${nf(y)})-text_h*0.5`,
    `borderw=${Math.max(1, Math.round(size * 0.02))}`,
    "bordercolor=black@0.35",
    "shadowcolor=black@0.5",
    "shadowx=0",
    `shadowy=${Math.max(1, Math.round(size * 0.05))}`,
    `text_align=${o.align === "left" ? "left" : o.align === "right" ? "right" : "center"}`,
    "fix_bounds=1",
    `enable='between(t,${nf(start)},${nf(stop)})'`,
  ];

  const fade = Math.max(0, o.fadeS);
  if (fade > 0) {
    args.push(
      `alpha='max(0,min(1,min((t-${nf(start)})/${nf(fade)},(${nf(stop)}-t)/${nf(fade)})))'`,
    );
  }

  if (o.kind === "logo") {
    // A plate behind a mark keeps it legible over any frame it lands on.
    args.push("box=1", "boxcolor=black@0.3", `boxborderw=${Math.round(size * 0.35)}`);
  }

  return `drawtext=${args.join(":")}`;
}
