/**
 * The deterministic visual engine.
 *
 * This is what draws the pictures when there is no API key, no budget left or no
 * quota: it stylises the user's own photographs, builds the subject reference
 * sheet, composes procedural painterly frames from a style bible, and animates
 * any still into real motion. Nothing here is a stand-in for generated imagery —
 * the output is meant to cut against model keyframes without announcing which is
 * which.
 *
 * Measurement is first-class. Sharpness, exposure and palette are read off real
 * decoded pixels rather than guessed from metadata, because preflight decisions
 * (which upload anchors identity, how hard to push a grade) are only as good as
 * the numbers behind them.
 */
import fs from "node:fs";
import path from "node:path";
import { LIMITS, OUTPUT } from "@/lib/core/config";
import { clamp, lerp, MuseError, pool, round } from "@/lib/core/util";
import type { CameraMove, StyleBible } from "@/lib/spec/directorSpec";
import { exec, probeStreams, rawSample, stillEncoderArgs } from "./ffmpegExec";
import {
  biasFromAction,
  hash32,
  lum,
  mixRgb,
  mulberry32,
  paintComposition,
  parallaxMask,
  resolveColor,
  stylePalette,
  toHex,
  type RGB,
} from "./paint";

// ── measurement ──────────────────────────────────────────────────────────────

/** What a preflight read of one image tells us. */
export interface ImageProbe {
  width: number;
  height: number;
  bytes: number;
  /** Laplacian-style sharpness proxy, higher is sharper. */
  sharpness: number;
  /** Mean Rec.709 luma, 0..1. */
  brightness: number;
  /** Fraction of the frame sitting in crushed shadow, 0..1. */
  clipping: number;
  /** Dominant colours as hex, most prominent first. */
  palette: string[];
}

const PALETTE_SAMPLE = 64;
const DETAIL_SAMPLE = 256;

/** Bucketed colour census, kept with its key so ordering is never accidental. */
interface Bucket {
  key: number;
  n: number;
  r: number;
  g: number;
  b: number;
}

function dominantColours(rgb: Buffer, mergeDistance: number): { hex: string; n: number }[] {
  const buckets = new Map<number, Bucket>();
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    // 3 bits per channel: coarse enough that a photograph's real masses group,
    // fine enough that a sky and a jacket never land in the same bin.
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const at = buckets.get(key);
    if (at) {
      at.n++;
      at.r += r;
      at.g += g;
      at.b += b;
    } else {
      buckets.set(key, { key, n: 1, r, g, b });
    }
  }
  const ordered = [...buckets.values()].sort((a, b) => (b.n - a.n) || (a.key - b.key));
  const kept: { c: RGB; n: number }[] = [];
  for (const bucket of ordered) {
    const mean: RGB = [bucket.r / bucket.n, bucket.g / bucket.n, bucket.b / bucket.n];
    let folded = false;
    for (const k of kept) {
      const dr = k.c[0] - mean[0];
      const dg = k.c[1] - mean[1];
      const db = k.c[2] - mean[2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) < mergeDistance) {
        const w = bucket.n / (k.n + bucket.n);
        k.c = mixRgb(k.c, mean, w);
        k.n += bucket.n;
        folded = true;
        break;
      }
    }
    if (!folded) kept.push({ c: mean, n: bucket.n });
  }
  return kept
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map((k) => ({ hex: toHex(k.c), n: k.n }));
}

/**
 * Probe an image: real pixel dimensions plus a cheap quality read used at
 * preflight. Sharpness and shadow coverage come from a 256x256 luma sample;
 * brightness and the palette come from a 64x64 area-averaged RGB sample.
 */
export async function probeImage(filePath: string): Promise<ImageProbe> {
  const [meta, stat] = await Promise.all([probeStreams(filePath), fs.promises.stat(filePath)]);
  const video = meta.streams.find((s) => s.codec_type === "video" && !!s.width && !!s.height);
  if (!video || !video.width || !video.height) {
    throw new MuseError("permanent", `no decodable image stream in ${filePath}`, { filePath });
  }

  const [rgb, gray] = await Promise.all([
    rawSample(filePath, PALETTE_SAMPLE, PALETTE_SAMPLE, "rgb24", "area"),
    rawSample(filePath, DETAIL_SAMPLE, DETAIL_SAMPLE, "gray", "bicubic"),
  ]);

  let lumaSum = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    lumaSum += 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
  }
  const brightness = lumaSum / (PALETTE_SAMPLE * PALETTE_SAMPLE) / 255;

  let graySum = 0;
  let crushed = 0;
  for (let i = 0; i < gray.length; i++) {
    graySum += gray[i];
    if (gray[i] <= 14) crushed++;
  }
  const grayMean = graySum / gray.length;

  // 4-neighbour Laplacian energy, normalised by exposure so a dark frame is not
  // mistaken for a soft one.
  let energy = 0;
  let counted = 0;
  for (let y = 1; y < DETAIL_SAMPLE - 1; y++) {
    for (let x = 1; x < DETAIL_SAMPLE - 1; x++) {
      const i = y * DETAIL_SAMPLE + x;
      const l =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - DETAIL_SAMPLE] - gray[i + DETAIL_SAMPLE];
      energy += l * l;
      counted++;
    }
  }
  const sharpness = round((Math.sqrt(energy / counted) / (grayMean + 8)) * 100, 3);

  let dominant = dominantColours(rgb, 56);
  if (dominant.length < 3) dominant = dominantColours(rgb, 24);
  if (dominant.length < 3) dominant = dominantColours(rgb, 0);

  return {
    width: video.width,
    height: video.height,
    bytes: stat.size,
    sharpness,
    brightness: round(brightness, 4),
    clipping: round(crushed / gray.length, 4),
    palette: dominant.map((d) => d.hex),
  };
}

/** How usable one upload is as the identity anchor for a whole reel. */
function subjectScore(probe: ImageProbe): number {
  const shortSide = Math.min(probe.width, probe.height);
  const detail = clamp(probe.sharpness / 26, 0, 1);
  const exposure = 1 - clamp(Math.abs(probe.brightness - 0.52) / 0.42, 0, 1);
  const resolution = clamp(shortSide / OUTPUT.width, 0, 1);
  const richness = clamp(probe.palette.length / 5, 0, 1);
  // A vertical reel crops landscape uploads hard, so orientation is a real cost.
  const orientation = probe.height >= probe.width ? 1 : 0.72;
  const shadowPenalty = 1 - 0.18 * clamp(probe.clipping * 1.6, 0, 1);
  const raw = 0.36 * detail + 0.26 * exposure + 0.24 * resolution + 0.14 * richness;
  return round(raw * orientation * shadowPenalty, 4);
}

/** Choose the best of several uploads to be the primary subject reference. */
export async function pickPrimarySubject(paths: string[]): Promise<{ path: string; score: number }[]> {
  if (paths.length === 0) throw new MuseError("permanent", "pickPrimarySubject needs at least one path");
  const probes = await pool(paths, 3, (p) => probeImage(p));
  return paths
    .map((p, i) => ({ path: p, score: subjectScore(probes[i]) }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
}

// ── stylisation ──────────────────────────────────────────────────────────────

const f3 = (v: number): string => v.toFixed(3);

/**
 * A gradient-map curve set built from the palette: the darkest palette colour
 * lands in the shadows, the lightest in the highlights. Each stop is pulled part
 * way back toward neutral so the result reads as a grade rather than a duotone,
 * and every channel is forced monotonic so the curve cannot invert tones.
 */
function paletteCurves(colours: RGB[], tint: number): { r: string; g: string; b: string } {
  const asc = [...colours].sort((a, b) => lum(a) - lum(b));
  const stops: { t: number; c: RGB }[] = [];
  const n = asc.length;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : lerp(0.08, 0.92, i / (n - 1));
    const neutral = t * 255;
    stops.push({
      t,
      c: [lerp(neutral, asc[i][0], tint), lerp(neutral, asc[i][1], tint), lerp(neutral, asc[i][2], tint)],
    });
  }
  const first = stops[0];
  const last = stops[stops.length - 1];
  const points: { t: number; c: RGB }[] = [
    { t: 0, c: [Math.max(0, first.c[0] - 14), Math.max(0, first.c[1] - 14), Math.max(0, first.c[2] - 14)] },
    ...stops,
    { t: 1, c: [Math.min(255, last.c[0] + 14), Math.min(255, last.c[1] + 14), Math.min(255, last.c[2] + 14)] },
  ];
  const channel = (idx: 0 | 1 | 2): string => {
    let prev = -1;
    const parts: string[] = [];
    for (const p of points) {
      const v = clamp(Math.max(p.c[idx] / 255, prev + 0.004), 0, 1);
      prev = v;
      parts.push(`${f3(p.t)}/${f3(v)}`);
    }
    return parts.join(" ");
  };
  return { r: channel(0), g: channel(1), b: channel(2) };
}

/**
 * Turn a source photograph into a stylised still matching a StyleBible: edge
 * preserving smoothing, a mild quantise, palette-directed grade, halation, grain
 * and a vignette. The grade and the quantise are both blended back over the
 * original so the subject stays recognisable — this is a treatment, not a repaint.
 */
export async function stylizeStill(opts: {
  sourcePath: string;
  outPath: string;
  style: StyleBible;
  /** 0..1, how far to push the stylisation. */
  strength?: number;
  seed?: number;
}): Promise<{ path: string; width: number; height: number }> {
  const strength = clamp(opts.strength ?? 0.7, 0, 1);
  const grain = clamp(opts.style.grain, 0, 1);
  const seed = (opts.seed ?? hash32(opts.style.preset)) >>> 0;
  const W = OUTPUT.width;
  const H = OUTPUT.height;

  const curves = paletteCurves(stylePalette(opts.style), 0.78);
  const step = Math.round(lerp(48, 26, strength));
  const posterMix = 0.06 + 0.32 * strength;
  const gradeMix = 0.14 + 0.46 * strength;
  const sigmaS = 3 + 7 * strength;
  const sigmaR = 0.07 + 0.10 * strength;
  const sharpen = 0.45 + 0.55 * strength;
  const halation = (0.03 + 0.09 * grain) * (0.4 + 0.6 * strength);
  const grainAmount = Math.round((3 + 17 * grain) * (0.35 + 0.65 * strength));

  const graph = [
    // Cover the vertical frame, biased high: faces live above centre.
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=w=${W}:h=${H}:x=(iw-ow)/2:y=(ih-oh)*0.35,format=rgb24,` +
      `bilateral=sigmaS=${f3(sigmaS)}:sigmaR=${f3(sigmaR)}:planes=7,split=2[sm0][sm1]`,
    `[sm1]lutrgb=r='trunc(val/${step})*${step}+${Math.round(step / 2)}':` +
      `g='trunc(val/${step})*${step}+${Math.round(step / 2)}':` +
      `b='trunc(val/${step})*${step}+${Math.round(step / 2)}'[poster]`,
    // In normal mode blend weights its first input by all_opacity, so the treated
    // layer goes on top and the untouched frame sits under it. Screen mode below
    // instead mixes the blend result into the first input, which is what halation
    // wants: a little glow added to a sharp frame.
    `[poster][sm0]blend=all_mode=normal:all_opacity=${f3(posterMix)}[quantised]`,
    `[quantised]split=2[q0][q1]`,
    `[q1]curves=r='${curves.r}':g='${curves.g}':b='${curves.b}'[graded]`,
    `[graded][q0]blend=all_mode=normal:all_opacity=${f3(gradeMix)}[tinted]`,
    `[tinted]eq=contrast=${f3(1 + 0.12 * strength)}:saturation=${f3(1 + 0.18 * strength)}:` +
      `brightness=${f3(0.02 * strength)},` +
      `unsharp=5:5:${f3(sharpen)}:5:5:0,split=2[u0][u1]`,
    `[u1]gblur=sigma=20[bloom]`,
    `[u0][bloom]blend=all_mode=screen:all_opacity=${f3(halation)}[haloed]`,
    `[haloed]vignette=a=PI/${f3(6.4 - 1.2 * strength)}:dither=0,format=yuv444p,` +
      `noise=c0s=${grainAmount}:c0f=u:c0_seed=${seed % 2147483647}:c1s=0:c2s=0,format=rgb24[out]`,
  ].join(";");

  await fs.promises.mkdir(path.dirname(opts.outPath), { recursive: true });
  await exec("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    opts.sourcePath,
    "-filter_complex",
    graph,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    ...stillEncoderArgs(opts.outPath),
    opts.outPath,
  ]);
  return { path: opts.outPath, width: W, height: H };
}

// ── subject reference sheet ──────────────────────────────────────────────────

const TILE_W = 448;
const TILE_H = 560;
const SHEET_GUTTER = 16;
/** Past this the sheet reads as a collage rather than as one subject's reference. */
const SHEET_MAX_TILES = 6;

const SHEET_MARGIN = 24;
const SHEET_HEADER = 72;

function sheetColumns(n: number): number {
  if (n <= 3) return n;
  return n === 4 ? 2 : 3;
}

/**
 * Build a contact-sheet subject reference from 1..5 uploads: best crops first,
 * orientation normalised by the decoder's EXIF handling, laid out on one canvas
 * over a palette-derived ground. Used as the identity anchor sent to image models
 * and as a visible artefact in the UI.
 */
export async function buildSubjectSheet(opts: {
  sourcePaths: string[];
  outPath: string;
  seed?: number;
}): Promise<{ path: string; width: number; height: number; tiles: number }> {
  const sources = opts.sourcePaths;
  if (sources.length === 0) throw new MuseError("permanent", "buildSubjectSheet needs at least one upload");
  // No upper bound here. The sheet ranks by how usable each photograph is as an identity
  // reference and lays out the best of them; refusing to build one because somebody brought
  // eleven pictures was the cap leaking into a component that already knew how to choose.

  const probes = await pool(sources, 3, (p) => probeImage(p));
  // Ranked, then bounded. The sheet exists to establish one identity, and past half a dozen tiles
  // it stops being a reference and becomes a collage — so the best few are laid out and the rest
  // are left off. This replaces a hard refusal above five uploads: choosing is what this function
  // is for, and refusing was it declining to do its job.
  const ranked = sources
    .map((p, i) => ({ path: p, probe: probes[i], score: subjectScore(probes[i]) }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .slice(0, SHEET_MAX_TILES);

  const cols = sheetColumns(ranked.length);
  const rows = Math.ceil(ranked.length / cols);
  const width = SHEET_MARGIN * 2 + cols * TILE_W + (cols - 1) * SHEET_GUTTER;
  const height = SHEET_MARGIN * 2 + SHEET_HEADER + rows * TILE_H + (rows - 1) * SHEET_GUTTER;

  // Ground and header swatches come from the uploads themselves, so the sheet
  // always looks like it belongs to this project.
  const swatches: RGB[] = [];
  for (const r of ranked) {
    for (const hex of r.probe.palette.slice(0, 2)) {
      const c = resolveColor(hex);
      if (!swatches.some((s) => Math.abs(s[0] - c[0]) + Math.abs(s[1] - c[1]) + Math.abs(s[2] - c[2]) < 40)) {
        swatches.push(c);
      }
    }
  }
  const strip = swatches.slice(0, 6);
  const darkest = [...(strip.length > 0 ? strip : [[40, 40, 48] as RGB])].sort((a, b) => lum(a) - lum(b))[0];
  const top = toHex(mixRgb(darkest, [0, 0, 0], 0.62));
  const bottom = toHex(mixRgb(darkest, [0, 0, 0], 0.82));
  const seed = (opts.seed ?? 1) >>> 0;

  const parts: string[] = [];
  const swatchW = 46;
  const canvasOps = [
    // A hairline under the header reads as a contact sheet rather than a collage.
    `drawbox=x=${SHEET_MARGIN}:y=${SHEET_MARGIN + SHEET_HEADER - 14}:w=${width - SHEET_MARGIN * 2}:h=1:color=white@0.22:t=fill`,
    ...strip.map(
      (c, i) =>
        `drawbox=x=${SHEET_MARGIN + i * (swatchW + 8)}:y=${SHEET_MARGIN + 12}:w=${swatchW}:h=${swatchW / 2}:color=${toHex(c).replace("#", "0x")}:t=fill`,
    ),
  ];
  parts.push(`[0:v]${canvasOps.join(",")}[canvas0]`);

  ranked.forEach((r, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = SHEET_MARGIN + col * (TILE_W + SHEET_GUTTER);
    const y = SHEET_MARGIN + SHEET_HEADER + row * (TILE_H + SHEET_GUTTER);
    parts.push(
      `[${i + 1}:v]scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=w=${TILE_W}:h=${TILE_H}:x=(iw-ow)/2:y=(ih-oh)*0.28,` +
        `eq=contrast=1.04:saturation=1.03,` +
        `drawbox=x=0:y=0:w=iw:h=ih:color=white@0.16:t=2[tile${i}]`,
    );
    parts.push(`[canvas${i}][tile${i}]overlay=x=${x}:y=${y}:format=auto[canvas${i + 1}]`);
  });
  parts.push(`[canvas${ranked.length}]format=rgb24[out]`);

  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=${width}x${height}:c0=${top.replace("#", "0x")}:c1=${bottom.replace("#", "0x")}:nb_colors=2:type=linear:x0=0:y0=0:x1=0:y1=${height}:seed=${seed}:d=1`,
  ];
  for (const r of ranked) args.push("-i", r.path);
  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    ...stillEncoderArgs(opts.outPath),
    opts.outPath,
  );

  await fs.promises.mkdir(path.dirname(opts.outPath), { recursive: true });
  await exec("ffmpeg", args);
  return { path: opts.outPath, width, height, tiles: ranked.length };
}

/**
 * Deterministic still generation with no source photo at all: layered gradients,
 * a ridged horizon, seeded soft masses and cloud bands, then grain and a vignette
 * from ffmpeg. Painted at half resolution and resampled up, which is what gives it
 * the soft washes of a painting rather than the hard edges of vector art.
 */
export async function proceduralStill(opts: {
  outPath: string;
  style: StyleBible;
  sceneAction: string;
  seed: number;
  width?: number;
  height?: number;
}): Promise<{ path: string; width: number; height: number }> {
  const width = Math.max(2, Math.round((opts.width ?? OUTPUT.width) / 2) * 2);
  const height = Math.max(2, Math.round((opts.height ?? OUTPUT.height) / 2) * 2);
  const baseW = Math.max(2, Math.round(width / 4) * 2);
  const baseH = Math.max(2, Math.round(height / 4) * 2);
  const seed = (((opts.seed >>> 0) ^ hash32(opts.sceneAction)) * 2654435761) >>> 0;
  const grain = clamp(opts.style.grain, 0, 1);

  const raw = paintComposition(baseW, baseH, stylePalette(opts.style), seed, biasFromAction(opts.sceneAction));
  const chain =
    `scale=${width}:${height}:flags=lanczos,gblur=sigma=1.2,unsharp=7:7:${f3(0.55 + 0.35 * grain)}:7:7:0,` +
    `eq=contrast=1.04:saturation=1.06,vignette=a=PI/5.0:dither=0,format=yuv444p,` +
    `noise=c0s=${Math.round(4 + 14 * grain)}:c0f=u:c0_seed=${seed % 2147483647}:c1s=0:c2s=0,format=rgb24`;

  await fs.promises.mkdir(path.dirname(opts.outPath), { recursive: true });
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${baseW}x${baseH}`,
      "-i",
      "pipe:0",
      "-vf",
      chain,
      "-frames:v",
      "1",
      ...stillEncoderArgs(opts.outPath),
      opts.outPath,
    ],
    raw,
  );
  return { path: opts.outPath, width, height };
}

// ── camera motion ────────────────────────────────────────────────────────────

/** zoompan expressions for one layer of one move. */
interface Motion {
  z: string;
  x: string;
  y: string;
}

/**
 * Build the motion for a move. `gain` scales both travel and zoom depth, which is
 * how the parallax layers are driven apart: the background gets 1.7x, the subject
 * layer 0.55x, from the same description of the move.
 */
function motionFor(move: CameraMove, amount: number, frames: number, seed: number, gain: number): Motion {
  const P = `min(on/${Math.max(1, frames - 1)},1)`;
  const E = `(3*pow(${P},2)-2*pow(${P},3))`;
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  const travel = (a: number): number => clamp(0.5 + (a - 0.5) * gain, 0.02, 0.98);
  const panX = (a: number, b: number, e = E): string =>
    `(iw-iw/zoom)*(${f3(travel(a))}+${f3(travel(b) - travel(a))}*${e})`;
  const panY = (a: number, b: number, e = E): string =>
    `(ih-ih/zoom)*(${f3(travel(a))}+${f3(travel(b) - travel(a))}*${e})`;
  const ramp = (from: number, to: number): string => `${f3(from)}+${f3(to - from)}*${E}`;

  // Pans need headroom before they have anywhere to travel; pushes do not.
  const held = 1.1 + 0.1 * amount * gain;
  const depth = (0.1 + 0.18 * amount) * gain;

  switch (move) {
    case "push_in":
      return { z: ramp(1, 1 + depth), x: cx, y: cy };
    case "pull_out":
      return { z: ramp(1 + depth, 1), x: cx, y: cy };
    case "dolly_out":
      return { z: ramp(1 + depth * 0.85, 1), x: cx, y: panY(0.62, 0.44) };
    case "pan_left":
      return { z: f3(held), x: panX(0.72, 0.28), y: cy };
    case "pan_right":
      return { z: f3(held), x: panX(0.28, 0.72), y: cy };
    case "tilt_up":
      return { z: f3(held), x: cx, y: panY(0.7, 0.3) };
    case "tilt_down":
      return { z: f3(held), x: cx, y: panY(0.3, 0.7) };
    case "parallax_drift":
      return { z: ramp(1.05, 1.05 + 0.06 * gain), x: panX(0.42, 0.58), y: panY(0.55, 0.45) };
    case "handheld_drift": {
      const rnd = mulberry32(seed);
      const p1 = 15 + Math.round(rnd() * 12);
      const p2 = 27 + Math.round(rnd() * 18);
      const ph1 = f3(rnd() * 6.28);
      const ph2 = f3(rnd() * 6.28);
      const ax = f3(0.05 * gain);
      const ay = f3(0.032 * gain);
      return {
        z: f3(1.08 + 0.05 * amount * gain),
        x: `(iw-iw/zoom)*(0.5+${ax}*sin(on/${p1}+${ph1})+${f3(Number(ax) * 0.5)}*sin(on/${p2}+${ph2}))`,
        y: `(ih-ih/zoom)*(0.5+${ay}*sin(on/${p2}+${ph1})+${f3(Number(ay) * 0.6)}*sin(on/${p1}+${ph2}))`,
      };
    }
    case "whip": {
      // Fast sweep that lands early and settles, the way a real whip pan reads.
      const e = `(1-pow(1-${P},4))`;
      return { z: `${f3(1.2)}+${f3(-0.12)}*${e}`, x: panX(0.06, 0.94, e), y: cy };
    }
    case "static":
    default:
      // A frozen frame in a music video reads as a broken render, so even a
      // static shot breathes by a couple of percent.
      return { z: ramp(1.004, 1.004 + 0.02 * gain), x: cx, y: cy };
  }
}

function zoompanFilter(m: Motion, w: number, h: number, fps: number): string {
  return `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=1:s=${w}x${h}:fps=${fps}`;
}

/**
 * Animate a still into a real video clip using deterministic camera motion, so a
 * scene whose generative video failed still has genuine movement. The still is
 * resampled to twice the output size before the move, which keeps zoompan's
 * integer pans at sub-pixel amplitude once the frame is scaled back down.
 */
export async function animateStill(opts: {
  stillPath: string;
  outPath: string;
  durationS: number;
  move: CameraMove;
  amount?: number;
  parallax?: boolean;
  fps?: number;
  seed?: number;
}): Promise<{ path: string; durationS: number }> {
  if (!fs.existsSync(opts.stillPath)) {
    throw new MuseError("permanent", `animateStill source missing: ${opts.stillPath}`, { path: opts.stillPath });
  }
  if (!(opts.durationS > 0)) {
    throw new MuseError("permanent", `animateStill needs a positive duration, got ${opts.durationS}`);
  }
  const fps = Math.max(1, Math.round(opts.fps ?? OUTPUT.fps));
  const frames = Math.max(2, Math.round(opts.durationS * fps));
  const amount = clamp(opts.amount ?? 0.6, 0, 1);
  const seed = (opts.seed ?? 1) >>> 0;
  const W = OUTPUT.width;
  const H = OUTPUT.height;
  const bigW = W * 2;
  const bigH = H * 2;
  const cover = `scale=${bigW}:${bigH}:force_original_aspect_ratio=increase:flags=lanczos,crop=w=${bigW}:h=${bigH}:x=(iw-ow)/2:y=(ih-oh)*0.35`;

  const args = ["-hide_banner", "-v", "error", "-y", "-loop", "1", "-framerate", String(fps), "-i", opts.stillPath];
  let stdin: Buffer | undefined;
  let graph: string;

  if (opts.parallax) {
    const bg = zoompanFilter(motionFor(opts.move, amount, frames, seed, 1.7), W, H, fps);
    const fg = zoompanFilter(motionFor(opts.move, amount, frames, seed, 0.55), W, H, fps);
    stdin = parallaxMask(W, H, seed);
    args.push(
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      `${W}x${H}`,
      "-framerate",
      String(fps),
      "-i",
      "pipe:0",
    );
    graph = [
      `[0:v]${cover},split=2[near][far]`,
      `[far]${bg},gblur=sigma=6,eq=saturation=0.88:brightness=-0.015[bg]`,
      `[near]${fg},format=rgba[fg]`,
      `[1:v]loop=loop=-1:size=1:start=0,format=gray[mask]`,
      `[fg][mask]alphamerge[fga]`,
      `[bg][fga]overlay=x=0:y=0:format=auto,format=yuv420p[v]`,
    ].join(";");
  } else {
    graph = `[0:v]${cover},${zoompanFilter(motionFor(opts.move, amount, frames, seed, 1), W, H, fps)},format=yuv420p[v]`;
  }

  await fs.promises.mkdir(path.dirname(opts.outPath), { recursive: true });
  args.push(
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-c:v",
    OUTPUT.videoCodec,
    "-crf",
    String(OUTPUT.crf),
    "-preset",
    OUTPUT.preset,
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-fps_mode",
    "cfr",
    "-r",
    String(fps),
    "-frames:v",
    String(frames),
    "-movflags",
    "+faststart",
    opts.outPath,
  );
  await exec("ffmpeg", args, stdin);
  return { path: opts.outPath, durationS: round(frames / fps, 3) };
}
