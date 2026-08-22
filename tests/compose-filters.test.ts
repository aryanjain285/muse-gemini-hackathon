/**
 * Filter-library tests.
 *
 * String assertions catch the escaping mistakes; everything else is proved by
 * running ffmpeg. Every graph in the library is rendered to a real MP4 in the
 * system temp directory and measured with ffprobe or by decoding raw luma, so a
 * filter that no longer exists, an expression that no longer parses or a move
 * that stops arriving at its target value fails the suite rather than shipping.
 *
 * Sources come from ffmpeg's own generators, so the suite needs no fixtures.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beatPulse,
  bloom,
  blurBurst,
  breathe,
  cameraMove,
  clipChain,
  escapeDrawtext,
  fitVertical,
  grade,
  grain,
  overlayText,
  painterly,
  parallax,
  resolveFont,
  transition,
  vignette,
} from "@/lib/compose/filters";
import { CAMERA_MOVES, TRANSITIONS } from "@/lib/spec/directorSpec";
import { OUTPUT } from "@/lib/core/config";
import type { ClipEffect, Overlay } from "@/lib/compose/types";

const FPS = OUTPUT.fps;
const W = OUTPUT.width;
const H = OUTPUT.height;

/** A still: a smooth gradient, which shows banding and colour casts clearly. */
const STILL_SRC =
  `gradients=size=${W}x${H}:c0=0x14202e:c1=0xf2d9a4:x0=180:y0=280:x1=940:y1=1700` +
  `:nb_colors=3:seed=11:rate=${FPS}:duration=2`;
/** Moving footage with hard edges everywhere, for detecting blur and motion. */
const VIDEO_SRC = `testsrc2=size=${W}x${H}:rate=${FPS}:duration=2`;
/** A flat field plus one white rectangle, for measuring magnification. */
const BOX_SRC =
  `color=c=0x303030:s=${W}x${H}:rate=${FPS}:duration=2,` +
  `drawbox=x=440:y=860:w=200:h=200:color=white:t=fill`;

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-filters-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface FfResult {
  code: number;
  stderr: string;
}

function ffmpeg(args: string[]): FfResult {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

/** Render a graph that reads one lavfi source and writes one video stream. */
function render(
  name: string,
  source: string,
  graph: string,
  opts: { frames?: number | null } = {},
): string {
  const out = path.join(dir, `${name}.mp4`);
  const frames = opts.frames === undefined ? 15 : opts.frames;
  const args = [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", source,
    "-filter_complex", `[0:v]null[in];${graph}`,
    "-map", "[out]",
    ...(frames === null ? [] : ["-frames:v", String(frames)]),
    "-fps_mode", "cfr", "-r", String(FPS),
    "-c:v", "libx264", "-crf", "22", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-an", out,
  ];
  const r = ffmpeg(args);
  expect(r.code, `ffmpeg failed for ${name}:\n${r.stderr}`).toBe(0);
  return out;
}

/** Wrap a linear fragment as a labelled one so `render` can consume it. */
function asGraph(fragment: string): string {
  return `[in]${fragment}[out]`;
}

interface Probed {
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationS: number;
}

function probe(file: string): Probed {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error", "-select_streams", "v:0", "-count_frames",
      "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames,duration",
      "-of", "default=noprint_wrappers=1:nokey=0", file,
    ],
    { encoding: "utf8" },
  );
  expect(r.status, `ffprobe failed for ${file}:\n${r.stderr}`).toBe(0);
  const fields = new Map<string, string>();
  for (const line of (r.stdout ?? "").trim().split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const rate = (fields.get("r_frame_rate") ?? "0/1").split("/");
  return {
    width: Number(fields.get("width")),
    height: Number(fields.get("height")),
    fps: Number(rate[0]) / Number(rate[1] ?? 1),
    frames: Number(fields.get("nb_read_frames")),
    durationS: Number(fields.get("duration")),
  };
}

/** Assert a render is exactly the target format, with the frames we asked for. */
function expectFormat(file: string, frames: number): void {
  const p = probe(file);
  expect(p.width).toBe(W);
  expect(p.height).toBe(H);
  expect(p.fps).toBeCloseTo(FPS, 3);
  expect(p.frames).toBe(frames);
  expect(p.durationS).toBeGreaterThan(frames / FPS - 0.05);
  expect(p.durationS).toBeLessThan(frames / FPS + 0.05);
}

/**
 * Decode one frame as 8-bit luma. `format=gray` runs before any crop because
 * cropping a subsampled frame to an odd height is invalid.
 */
function grayFrame(file: string, frameIndex: number, crop?: string): Buffer {
  const filters = [
    `trim=start_frame=${frameIndex}:end_frame=${frameIndex + 1}`,
    "setpts=PTS-STARTPTS",
    "format=gray",
  ];
  if (crop !== undefined) filters.push(`crop=${crop}`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-i", file,
      "-vf", filters.join(","), "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ],
    { maxBuffer: 1 << 27 },
  );
  const buf = r.stdout;
  expect(r.status, `frame decode failed: ${String(r.stderr)}`).toBe(0);
  expect(buf.length).toBeGreaterThan(0);
  return buf;
}

function mean(buf: Buffer): number {
  let total = 0;
  for (const v of buf) total += v;
  return total / buf.length;
}

/** Mean absolute difference between horizontal neighbours: a sharpness proxy. */
function horizontalDetail(buf: Buffer, width: number): number {
  const rows = Math.floor(buf.length / width);
  let total = 0;
  let count = 0;
  for (let y = 0; y < rows; y++) {
    const base = y * width;
    for (let x = 1; x < width; x++) {
      total += Math.abs(buf[base + x] - buf[base + x - 1]);
      count++;
    }
  }
  return total / count;
}

/** Width in pixels of the bright run on one scanline. */
function brightRun(file: string, frameIndex: number, y: number): number {
  const row = grayFrame(file, frameIndex, `${W}:1:0:${y}`);
  let count = 0;
  for (const v of row) if (v > 200) count++;
  return count;
}

// ── framing ──────────────────────────────────────────────────────────────────

describe("fitVertical", () => {
  it("covers a 16:9 source with no letterbox bars", () => {
    const file = render("fit-16x9", `testsrc2=size=1920x1080:rate=${FPS}:duration=1`, asGraph(fitVertical()));
    expectFormat(file, 15);

    // A pad would leave a flat black strip on two opposite edges.
    const strips = {
      top: mean(grayFrame(file, 5, `${W}:8:0:0`)),
      bottom: mean(grayFrame(file, 5, `${W}:8:0:${H - 8}`)),
      left: mean(grayFrame(file, 5, `8:${H}:0:0`)),
      right: mean(grayFrame(file, 5, `8:${H}:${W - 8}:0`)),
    };
    for (const [edge, value] of Object.entries(strips)) {
      expect(value, `${edge} edge should carry picture, not a bar`).toBeGreaterThan(10);
    }
  });

  it("covers a tall source with no letterbox bars", () => {
    const file = render("fit-9x21", `testsrc2=size=720x1680:rate=${FPS}:duration=1`, asGraph(fitVertical()));
    expectFormat(file, 15);
    expect(mean(grayFrame(file, 5, `8:${H}:0:0`))).toBeGreaterThan(10);
    expect(mean(grayFrame(file, 5, `8:${H}:${W - 8}:0`))).toBeGreaterThan(10);
  });

  it("scales up to cover rather than padding, and clamps the bias", () => {
    expect(fitVertical()).toContain("force_original_aspect_ratio=increase");
    expect(fitVertical()).not.toContain("pad=");
    expect(fitVertical({ biasY: 5 })).toContain(`crop=${W}:${H}:(iw-ow)/2:(ih-oh)*1`);
    expect(fitVertical({ biasY: -5 })).toContain(`crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0`);
  });
});

// ── camera ───────────────────────────────────────────────────────────────────

describe("cameraMove", () => {
  it.each(CAMERA_MOVES)("renders %s over a still", (move) => {
    const graph = asGraph(
      [fitVertical(), cameraMove(move, { durationS: 0.5, fps: FPS, amount: 0.85, forVideo: false })]
        .filter((f) => f !== "null")
        .join(","),
    );
    expectFormat(render(`cam-still-${move}`, STILL_SRC, graph), 15);
  });

  it.each(CAMERA_MOVES)("renders %s over video", (move) => {
    const graph = asGraph(
      [fitVertical(), cameraMove(move, { durationS: 0.5, fps: FPS, amount: 0.85, forVideo: true })]
        .filter((f) => f !== "null")
        .join(","),
    );
    expectFormat(render(`cam-video-${move}`, VIDEO_SRC, graph), 15);
  });

  it("ends a push-in at exactly the requested magnification", () => {
    // amount 1 asks for a 1.24x push; the 200px reference box must finish 248px
    // wide, and the growth must be monotonic rather than snapping at the end.
    const graph = asGraph(
      `${fitVertical()},${cameraMove("push_in", { durationS: 1, fps: FPS, amount: 1, forVideo: false })}`,
    );
    const file = render("cam-pushin-measure", BOX_SRC, graph, { frames: 30 });
    expectFormat(file, 30);

    const first = brightRun(file, 0, Math.round(H / 2));
    const middle = brightRun(file, 15, Math.round(H / 2));
    const last = brightRun(file, 29, Math.round(H / 2));

    expect(first).toBeGreaterThan(190);
    expect(first).toBeLessThan(210);
    expect(middle).toBeGreaterThan(first);
    expect(last).toBeGreaterThan(middle);
    expect(last / first).toBeCloseTo(1.24, 1);
  });

  it("ends a pull-out back at native scale", () => {
    const graph = asGraph(
      `${fitVertical()},${cameraMove("pull_out", { durationS: 1, fps: FPS, amount: 1, forVideo: false })}`,
    );
    const file = render("cam-pullout-measure", BOX_SRC, graph, { frames: 30 });
    const first = brightRun(file, 0, Math.round(H / 2));
    const last = brightRun(file, 29, Math.round(H / 2));
    expect(first / last).toBeCloseTo(1.24, 1);
    expect(last).toBeGreaterThan(190);
    expect(last).toBeLessThan(210);
  });

  it("translates video with scale and crop, and zooms with zoompan", () => {
    const pan = cameraMove("pan_left", { durationS: 2, fps: FPS, amount: 0.8, forVideo: true });
    expect(pan).toContain("crop=");
    expect(pan).not.toContain("zoompan");
    // crop fixes its width and height at configuration time, so a ramping zoom
    // has to go through zoompan even on video.
    const push = cameraMove("push_in", { durationS: 2, fps: FPS, amount: 0.8, forVideo: true });
    expect(push).toContain("zoompan");
  });

  it("is a no-op when there is nothing to move", () => {
    expect(cameraMove("static", { durationS: 2, fps: FPS, amount: 1, forVideo: false })).toBe("null");
    expect(cameraMove("push_in", { durationS: 2, fps: FPS, amount: 0, forVideo: false })).toBe("null");
  });

  it("never asks zoompan for a magnification below native", () => {
    for (const move of CAMERA_MOVES) {
      const chain = cameraMove(move, { durationS: 2, fps: FPS, amount: 1, forVideo: false });
      const z = /zoompan=z='([^']+)'/.exec(chain);
      if (z === null) continue;
      for (let i = 0; i <= 60; i++) {
        const on = i;
        const value = evalZoom(z[1], on);
        expect(value, `${move} zoom at frame ${on}`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

/** Evaluate the closed-form zoom expressions the library emits, for frame `on`. */
function evalZoom(expr: string, on: number): number {
  const js = expr
    .replace(/\bon\b/g, String(on))
    .replace(/\bPI\b/g, String(Math.PI))
    .replace(/\bmin\(/g, "Math.min(")
    .replace(/\bmax\(/g, "Math.max(")
    .replace(/\bpow\(/g, "Math.pow(")
    .replace(/\bexp\(/g, "Math.exp(")
    .replace(/\bsin\(/g, "Math.sin(")
    .replace(/\bcos\(/g, "Math.cos(");
  const value = Function(`"use strict";return (${js});`)() as number;
  expect(Number.isFinite(value)).toBe(true);
  return value;
}

// ── parallax ─────────────────────────────────────────────────────────────────

describe("parallax", () => {
  it.each([2, 3, 4])("composites %i layers", (layers) => {
    const fragment = parallax({
      inLabel: "in",
      outLabel: "out",
      durationS: 0.5,
      fps: FPS,
      amount: 0.8,
      layers,
    });
    const file = render(`parallax-${layers}`, STILL_SRC, `[in]${fitVertical()}[fit];${fragment.replace("[in]", "[fit]")}`);
    expectFormat(file, 15);
  });

  it("keeps every internal label unique and namespaced by the output", () => {
    const fragment = parallax({
      inLabel: "src",
      outLabel: "clip3",
      durationS: 2,
      fps: FPS,
      amount: 0.6,
      layers: 3,
    });
    // Every label the fragment writes must be written exactly once, or one
    // chain silently steals another's stream.
    const written: string[] = [];
    for (const chain of fragment.split(";")) {
      const trailing = /((?:\[[A-Za-z0-9_]+\])+)$/.exec(chain);
      if (trailing === null) continue;
      for (const m of trailing[1].matchAll(/\[([A-Za-z0-9_]+)\]/g)) written.push(m[1]);
    }
    // 3 layer branches + 2 mask branches, the far layer, then four labels for
    // each of the two near layers.
    expect(written.length).toBe(14);
    expect(new Set(written).size).toBe(written.length);
    expect(fragment).toContain("clip3_px");
    expect(fragment.startsWith("[src]split=5")).toBe(true);
    expect(fragment.endsWith("[clip3]")).toBe(true);
  });

  it("moves the near layer further than the far layer", () => {
    const fragment = parallax({
      inLabel: "in",
      outLabel: "out",
      durationS: 2,
      fps: FPS,
      amount: 1,
      layers: 2,
    });
    const zooms = [...fragment.matchAll(/zoompan=z='([^']+)'/g)].map((m) => evalZoom(m[1], 59));
    expect(zooms).toHaveLength(2);
    expect(zooms[1]).toBeGreaterThan(zooms[0]);
  });
});

// ── per-effect renders ───────────────────────────────────────────────────────

const SAMPLE_EFFECTS: ClipEffect[] = [
  { kind: "camera", move: "push_in", amount: 0.8 },
  { kind: "parallax", amount: 0.7, layers: 3 },
  { kind: "painterly", strength: 0.6 },
  { kind: "grade", warmth: 0.5, contrast: 0.3, saturation: 0.25, lift: 0.4 },
  { kind: "grain", amount: 0.5 },
  { kind: "bloom", amount: 0.7, atS: 0.2 },
  { kind: "beatPulse", atS: 0.25, amount: 0.8 },
  { kind: "blurBurst", atS: 0.25, amount: 0.7 },
  { kind: "vignette", amount: 0.6 },
  { kind: "breathe", amount: 0.5 },
];

describe("clip effects", () => {
  it("covers every effect kind in the manifest contract", () => {
    const kinds = new Set(SAMPLE_EFFECTS.map((e) => e.kind));
    expect(kinds.size).toBe(SAMPLE_EFFECTS.length);
    // A new ClipEffect variant must arrive here with a render of its own.
    expect(kinds.size).toBe(10);
  });

  it.each(SAMPLE_EFFECTS.map((e) => [e.kind, e] as const))("renders %s", (kind, effect) => {
    const graph = clipChain({
      inLabel: "in",
      outLabel: "out",
      effects: [effect],
      durationS: 0.5,
      fps: FPS,
      isStill: true,
      seed: 7,
    });
    expectFormat(render(`effect-${kind}`, STILL_SRC, graph), 15);
  });

  it("lifts exposure on the beat and leaves the rest of the clip alone", () => {
    const flat = `color=c=0x606060:s=${W}x${H}:rate=${FPS}:duration=2`;
    const file = render(
      "beatpulse-measure",
      flat,
      asGraph(`${fitVertical()},${beatPulse({ atS: 0.5, amount: 1, fps: FPS })},format=yuv420p`),
      { frames: 30 },
    );
    const before = mean(grayFrame(file, 2, "160:160:460:880"));
    const onBeat = mean(grayFrame(file, 15, "160:160:460:880"));
    const after = mean(grayFrame(file, 28, "160:160:460:880"));
    expect(onBeat - before).toBeGreaterThan(15);
    expect(Math.abs(after - before)).toBeLessThan(3);
  });

  it("softens the picture on the beat and restores it after", () => {
    const file = render(
      "blurburst-measure",
      VIDEO_SRC,
      asGraph(`${fitVertical()},${blurBurst({ atS: 0.5, amount: 1 })},format=yuv420p`),
      { frames: 30 },
    );
    const sharpBefore = horizontalDetail(grayFrame(file, 1), W);
    const onBeat = horizontalDetail(grayFrame(file, 15), W);
    const sharpAfter = horizontalDetail(grayFrame(file, 29), W);
    expect(onBeat).toBeLessThan(sharpBefore * 0.6);
    expect(sharpAfter).toBeGreaterThan(onBeat * 1.5);
  });

  it("darkens the corners without touching the centre", () => {
    const flat = `color=c=0x808080:s=${W}x${H}:rate=${FPS}:duration=1`;
    const plain = render("vignette-off", flat, asGraph(`${fitVertical()},format=yuv420p`), { frames: 5 });
    const vig = render(
      "vignette-on",
      flat,
      asGraph(`${fitVertical()},${vignette(1)},format=yuv420p`),
      { frames: 5 },
    );
    const centreCrop = "200:200:440:860";
    const cornerCrop = "200:200:0:0";
    const centreBefore = mean(grayFrame(plain, 2, centreCrop));
    const centreAfter = mean(grayFrame(vig, 2, centreCrop));
    expect(centreAfter / centreBefore).toBeGreaterThan(0.97);
    const cornerBefore = mean(grayFrame(plain, 2, cornerCrop));
    const cornerAfter = mean(grayFrame(vig, 2, cornerCrop));
    expect(cornerAfter).toBeLessThan(cornerBefore * 0.9);
    // A vignette that clamps corners to solid black is a bug, not a look.
    expect(cornerAfter).toBeGreaterThan(cornerBefore * 0.3);
  });

  it("adds grain that is reproducible for a seed and different across seeds", () => {
    const flat = `color=c=0x707070:s=${W}x${H}:rate=${FPS}:duration=1`;
    const base = asGraph(`${fitVertical()},format=yuv420p`);
    const withGrain = (seed: number): string =>
      asGraph(`${fitVertical()},${grain(0.8, seed)},format=yuv420p`);

    const plain = grayFrame(render("grain-off", flat, base, { frames: 6 }), 3);
    const a1 = grayFrame(render("grain-a1", flat, withGrain(4242), { frames: 6 }), 3);
    const a2 = grayFrame(render("grain-a2", flat, withGrain(4242), { frames: 6 }), 3);
    const b1 = grayFrame(render("grain-b1", flat, withGrain(99), { frames: 6 }), 3);

    expect(a1.equals(plain)).toBe(false);
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b1)).toBe(false);
    expect(horizontalDetail(a1, W)).toBeGreaterThan(horizontalDetail(plain, W) + 1);
  });

  it("smooths interiors while a real photo keeps its edges", () => {
    const file = render(
      "painterly-measure",
      VIDEO_SRC,
      asGraph(`${fitVertical()},${painterly(1)},format=yuv420p`),
      { frames: 6 },
    );
    const plain = render("painterly-off", VIDEO_SRC, asGraph(`${fitVertical()},format=yuv420p`), {
      frames: 6,
    });
    // The bar edges survive, so the frame is not simply blurred.
    const detail = horizontalDetail(grayFrame(file, 3), W);
    expect(detail).toBeGreaterThan(horizontalDetail(grayFrame(plain, 3), W) * 0.5);
  });

  it("collapses to a pass-through when a look is switched off", () => {
    expect(painterly(0)).toBe("null");
    expect(grain(0, 1)).toBe("null");
    expect(bloom(0)).toBe("null");
    expect(vignette(0)).toBe("null");
    expect(beatPulse({ atS: 1, amount: 0, fps: FPS })).toBe("null");
    expect(blurBurst({ atS: 1, amount: 0 })).toBe("null");
    expect(breathe({ amount: 0, durationS: 2, fps: FPS })).toBe("null");
    expect(grade({ warmth: 0, contrast: 0, saturation: 0, lift: 0 })).toBe("null");
  });

  it("pins the pixel format before addressing planes by index", () => {
    // A grade forces an RGB round trip; blend's c0 would then be green.
    expect(bloom(0.6)).toContain("format=yuv420p,split=2");
    expect(grade({ warmth: 0, contrast: 0, saturation: 0, lift: 0.5 })).toContain("format=yuv420p");
  });
});

// ── clip chain ───────────────────────────────────────────────────────────────

describe("clipChain", () => {
  it("renders every effect at once", () => {
    const graph = clipChain({
      inLabel: "in",
      outLabel: "out",
      effects: SAMPLE_EFFECTS,
      durationS: 0.5,
      fps: FPS,
      isStill: true,
      seed: 31,
    });
    expectFormat(render("chain-all", STILL_SRC, graph), 15);
  });

  it("applies effects in the fixed order, not the order given", () => {
    const graph = clipChain({
      inLabel: "in",
      outLabel: "out",
      effects: [
        { kind: "grain", amount: 0.5 },
        { kind: "vignette", amount: 0.5 },
        { kind: "grade", warmth: 0.4, contrast: 0.2, saturation: 0.2, lift: 0.3 },
        { kind: "painterly", strength: 0.5 },
      ],
      durationS: 2,
      fps: FPS,
      isStill: true,
      seed: 3,
    });
    const at = (needle: string): number => graph.indexOf(needle);
    expect(at("bilateral")).toBeGreaterThan(-1);
    expect(at("bilateral")).toBeLessThan(at("colorbalance"));
    expect(at("colorbalance")).toBeLessThan(at("vignette="));
    expect(at("vignette=")).toBeLessThan(at("noise=alls=7"));
  });

  it("always frames, paces and normalises the format", () => {
    const graph = clipChain({
      inLabel: "src",
      outLabel: "clip0",
      effects: [],
      durationS: 2,
      fps: FPS,
      isStill: true,
      seed: 1,
    });
    expect(graph.startsWith("[src]scale=1080:1920:force_original_aspect_ratio=increase")).toBe(true);
    expect(graph).toContain(`fps=${FPS}`);
    expect(graph.endsWith("format=yuv420p[clip0]")).toBe(true);
    expectFormat(render("chain-empty", STILL_SRC, graph.replace("[src]", "[in]").replace("[clip0]", "[out]")), 15);
  });

  it("renders two clips in one graph without a label collision", () => {
    const a = clipChain({
      inLabel: "in",
      outLabel: "ca",
      effects: [
        { kind: "bloom", amount: 0.6 },
        { kind: "parallax", amount: 0.5, layers: 2 },
      ],
      durationS: 0.5,
      fps: FPS,
      isStill: true,
      seed: 1,
    });
    const b = clipChain({
      inLabel: "in2",
      outLabel: "cb",
      effects: [
        { kind: "bloom", amount: 0.6 },
        { kind: "parallax", amount: 0.5, layers: 2 },
      ],
      durationS: 0.5,
      fps: FPS,
      isStill: true,
      seed: 1,
    });
    const out = path.join(dir, "chain-two.mp4");
    const r = ffmpeg([
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", STILL_SRC,
      "-f", "lavfi", "-i", VIDEO_SRC,
      "-filter_complex", `[0:v]null[in];[1:v]null[in2];${a};${b};[ca][cb]hstack=inputs=2[v]`,
      "-map", "[v]", "-frames:v", "10", "-fps_mode", "cfr", "-r", String(FPS),
      "-c:v", "libx264", "-crf", "26", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", out,
    ]);
    expect(r.code, r.stderr).toBe(0);
    const p = probe(out);
    expect(p.width).toBe(W * 2);
    expect(p.height).toBe(H);
  });

  it("uses the video path for footage and the still path for images", () => {
    const opts = {
      inLabel: "in",
      outLabel: "out",
      effects: [{ kind: "camera", move: "pan_right", amount: 0.8 } as ClipEffect],
      durationS: 2,
      fps: FPS,
      seed: 1,
    };
    expect(clipChain({ ...opts, isStill: true })).toContain("zoompan");
    expect(clipChain({ ...opts, isStill: false })).not.toContain("zoompan");
  });
});

// ── transitions ──────────────────────────────────────────────────────────────

/** Both sides of a transition test are exactly this long. */
const SIDE_S = 0.6;
const SIDE_FRAMES = Math.round(SIDE_S * FPS);

function renderTransition(kind: (typeof TRANSITIONS)[number], durationS: number): string {
  const fragment = transition({
    fromLabel: "a",
    toLabel: "b",
    outLabel: "out",
    kind,
    durationS,
    fps: FPS,
    fromDurationS: SIDE_S,
  });
  const out = path.join(dir, `tr-${kind}.mp4`);
  const r = ffmpeg([
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", VIDEO_SRC,
    "-f", "lavfi", "-i", STILL_SRC,
    "-filter_complex",
    `[0:v]trim=duration=${SIDE_S},setpts=PTS-STARTPTS[a];` +
      `[1:v]trim=duration=${SIDE_S},setpts=PTS-STARTPTS[b];${fragment}`,
    "-map", "[out]", "-fps_mode", "cfr", "-r", String(FPS),
    "-c:v", "libx264", "-crf", "22", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", out,
  ]);
  expect(r.code, `transition ${kind} failed:\n${r.stderr}`).toBe(0);
  return out;
}

describe("transition", () => {
  it("covers the whole approved library", () => {
    expect(TRANSITIONS).toHaveLength(9);
  });

  it.each(TRANSITIONS)("renders %s at the target format", (kind) => {
    const durationS = 0.3;
    const file = renderTransition(kind, durationS);
    const overlap = kind === "cut" ? 0 : Math.round(durationS * FPS);
    expectFormat(file, SIDE_FRAMES * 2 - overlap);
  });

  it("makes a cut a concat rather than a zero-length blend", () => {
    const fragment = transition({
      fromLabel: "a",
      toLabel: "b",
      outLabel: "out",
      kind: "cut",
      durationS: 0.5,
      fps: FPS,
    });
    expect(fragment).toContain("concat=n=2:v=1:a=0");
    expect(fragment).not.toContain("xfade");
  });

  it("dips a dip_to_black through real black at the midpoint", () => {
    const file = renderTransition("dip_to_black", 0.4);
    const blendStart = Math.round((SIDE_S - 0.4) * FPS);
    const midpoint = blendStart + Math.round(0.2 * FPS);
    const outsideBefore = mean(grayFrame(file, 2));
    const atMid = mean(grayFrame(file, midpoint));
    const outsideAfter = mean(grayFrame(file, SIDE_FRAMES * 2 - Math.round(0.4 * FPS) - 2));
    expect(outsideBefore).toBeGreaterThan(40);
    expect(outsideAfter).toBeGreaterThan(40);
    expect(atMid).toBeLessThan(8);
  });

  it("dips a dip_to_white through real white at the midpoint", () => {
    const file = renderTransition("dip_to_white", 0.4);
    const midpoint = Math.round((SIDE_S - 0.4) * FPS) + Math.round(0.2 * FPS);
    expect(mean(grayFrame(file, midpoint))).toBeGreaterThan(235);
  });

  it("spikes a flash and recovers faster than a dip", () => {
    const flash = renderTransition("flash", 0.4);
    const dip = renderTransition("dip_to_white", 0.4);
    const blendStart = Math.round((SIDE_S - 0.4) * FPS);
    const quarter = blendStart + Math.round(0.1 * FPS);
    const midpoint = blendStart + Math.round(0.2 * FPS);
    expect(mean(grayFrame(flash, midpoint))).toBeGreaterThan(200);
    // A quarter of the way in the dip is already washing out; the flash is not.
    expect(mean(grayFrame(flash, quarter))).toBeLessThan(mean(grayFrame(dip, quarter)));
  });

  it("blurs a whip pan along the direction it slides", () => {
    const file = renderTransition("whip_pan", 0.4);
    const blendStart = Math.round((SIDE_S - 0.4) * FPS);
    const during = grayFrame(file, blendStart + 6);
    const outside = grayFrame(file, 1);
    expect(horizontalDetail(during, W)).toBeLessThan(horizontalDetail(outside, W));
    const fragment = transition({
      fromLabel: "a",
      toLabel: "b",
      outLabel: "out",
      kind: "whip_pan",
      durationS: 0.4,
      fps: FPS,
      fromDurationS: SIDE_S,
    });
    expect(fragment).toContain("dblur=angle=0");
    expect(fragment).toContain("transition=slideleft");
  });

  it("places the blend at the tail of the outgoing stream", () => {
    const tail = transition({
      fromLabel: "a",
      toLabel: "b",
      outLabel: "o",
      kind: "crossfade",
      durationS: 0.5,
      fps: FPS,
      fromDurationS: 4,
    });
    expect(tail).toContain("offset=3.5");
    const explicit = transition({
      fromLabel: "a",
      toLabel: "b",
      outLabel: "o",
      kind: "crossfade",
      durationS: 0.5,
      fps: FPS,
      offsetS: 1.25,
    });
    expect(explicit).toContain("offset=1.25");
  });

  it("never emits a blend shorter than one frame", () => {
    const fragment = transition({
      fromLabel: "a",
      toLabel: "b",
      outLabel: "o",
      kind: "crossfade",
      durationS: 0,
      fps: FPS,
    });
    expect(fragment).toContain(`duration=${(1 / FPS).toFixed(5).replace(/0+$/, "")}`);
  });
});

// ── text ─────────────────────────────────────────────────────────────────────

const NASTY = "a,b:c'd\\e%f;g[h]i";

describe("escapeDrawtext", () => {
  it("escapes every character that terminates an option or a chain", () => {
    const escaped = escapeDrawtext(NASTY);
    expect(escaped).toContain("\\,");
    expect(escaped).toContain("\\\\\\:");
    expect(escaped).toContain("\\\\\\'");
    expect(escaped).toContain("\\\\\\\\");
    expect(escaped).toContain("\\;");
    expect(escaped).toContain("\\[");
    expect(escaped).toContain("\\]");
    // A percent sign is left alone; overlayText disables expansion instead.
    expect(escaped).toContain("%");
  });

  it("flattens newlines rather than breaking the graph argument", () => {
    expect(escapeDrawtext("a\r\nb\nc")).toBe("a b c");
  });

  it("is what makes the graph parse at all", () => {
    const font = resolveFont("mono");
    const source = `color=c=black:s=${W}x${H}:rate=${FPS}:duration=1`;
    const draw = (value: string): string =>
      `[in]drawtext=fontfile=${font.graphValue}:text=${value}:expansion=none` +
      `:fontcolor=white:fontsize=64:x=60:y=900,format=yuv420p[out]`;

    const good = ffmpeg([
      "-loglevel", "error", "-y", "-f", "lavfi", "-i", source,
      "-filter_complex", `[0:v]null[in];${draw(escapeDrawtext(NASTY))}`,
      "-map", "[out]", "-frames:v", "2", "-f", "null", "-",
    ]);
    expect(good.code, good.stderr).toBe(0);

    const bad = ffmpeg([
      "-loglevel", "error", "-y", "-f", "lavfi", "-i", source,
      "-filter_complex", `[0:v]null[in];${draw(NASTY)}`,
      "-map", "[out]", "-frames:v", "2", "-f", "null", "-",
    ]);
    expect(bad.code).not.toBe(0);
  });
});

describe("overlayText", () => {
  it("resolves a font file that exists on this machine", () => {
    for (const family of ["display", "sans", "mono"] as const) {
      const font = resolveFont(family);
      expect(fs.existsSync(font.path)).toBe(true);
      // The drive colon has to survive both unescaping passes.
      expect(font.graphValue).toContain("\\\\\\:");
      expect(font.graphValue).not.toContain("\\\\\\\\");
    }
  });

  it("draws text containing every troublesome character", () => {
    const overlay: Overlay = {
      kind: "caption",
      text: NASTY,
      atS: 0,
      durationS: 0.5,
      x: 0.5,
      y: 0.5,
      sizePx: 72,
      font: "mono",
      color: "#ffffff",
      fadeS: 0,
      align: "center",
    };
    const black = `color=c=black:s=${W}x${H}:rate=${FPS}:duration=1`;
    const withText = render("overlay-nasty", black, asGraph(`${overlayText(overlay, { fps: FPS })},format=yuv420p`));
    const without = render("overlay-none", black, asGraph("format=yuv420p"));
    expectFormat(withText, 15);
    // Ink appeared on the band the text was placed in.
    const band = `${W}:120:0:${Math.round(H * 0.5) - 60}`;
    expect(mean(grayFrame(withText, 7, band))).toBeGreaterThan(mean(grayFrame(without, 7, band)) + 1);
  });

  it("renders a title, a caption and a logo together", () => {
    const overlays: Overlay[] = [
      {
        kind: "title", text: "Nowhere, Slowly", atS: 0, durationS: 0.4,
        x: 0.5, y: 0.28, sizePx: 96, font: "display", color: "#fff6e8",
        fadeS: 0.12, align: "center", trackingPx: 22,
      },
      {
        kind: "caption", text: "shot on a phone: 4:07am", atS: 0.1, durationS: 0.4,
        x: 0.5, y: 0.82, sizePx: 44, font: "sans", color: "#ffe9c4",
        fadeS: 0.1, align: "center",
      },
      {
        kind: "logo", text: "MUSE", atS: 0, durationS: 0.5,
        x: 0.1, y: 0.95, sizePx: 34, font: "mono", color: "white",
        fadeS: 0, align: "left",
      },
    ];
    const graph = asGraph(
      `${fitVertical()},${overlays.map((o) => overlayText(o, { fps: FPS })).join(",")},format=yuv420p`,
    );
    expectFormat(render("overlay-trio", STILL_SRC, graph), 15);
  });

  it("keeps text inside the safe band and quantises its window to frames", () => {
    const overlay: Overlay = {
      kind: "caption", text: "edge", atS: 0.333333, durationS: 1.011,
      x: 1.5, y: 0.99, sizePx: 40, font: "sans", color: "white",
      fadeS: 0.2, align: "right",
    };
    const chain = overlayText(overlay, { fps: FPS });
    expect(chain).toContain(`y=(h*${(1 - OUTPUT.safeBottom).toFixed(2)})`);
    expect(chain).toContain("x=(w*0.96)-text_w*1");
    // 0.333333s snaps to frame 10, 1.011s to 30 frames, so the window is 0.3..1.3.
    expect(chain).toContain("enable='between(t,0.33333,1.33333)'");
  });

  it("rejects a colour it cannot vouch for", () => {
    const base: Overlay = {
      kind: "caption", text: "x", atS: 0, durationS: 1, x: 0.5, y: 0.5,
      sizePx: 40, font: "sans", color: "#12ab34", fadeS: 0, align: "center",
    };
    expect(overlayText(base, { fps: FPS })).toContain("fontcolor=0x12ab34");
    expect(overlayText({ ...base, color: "red@0.5" }, { fps: FPS })).toContain("fontcolor=red@0.5");
    expect(
      overlayText({ ...base, color: "white:x=0:y=0" }, { fps: FPS }),
    ).toContain("fontcolor=white");
    expect(overlayText({ ...base, color: "white:x=0:y=0" }, { fps: FPS })).not.toContain("y=0:");
  });

  it("puts a plate behind a logo and nothing behind a caption", () => {
    const base: Overlay = {
      kind: "logo", text: "MUSE", atS: 0, durationS: 1, x: 0.1, y: 0.5,
      sizePx: 40, font: "mono", color: "white", fadeS: 0, align: "left",
    };
    expect(overlayText(base, { fps: FPS })).toContain("box=1");
    expect(overlayText({ ...base, kind: "caption" }, { fps: FPS })).not.toContain("box=1");
  });
});

// ── determinism ──────────────────────────────────────────────────────────────

describe("determinism", () => {
  it("builds byte-identical graphs for identical inputs", () => {
    const build = (): string =>
      clipChain({
        inLabel: "in",
        outLabel: "out",
        effects: SAMPLE_EFFECTS,
        durationS: 3.2,
        fps: FPS,
        isStill: true,
        seed: 12345,
      });
    expect(build()).toBe(build());
  });

  it("renders byte-identical pixels across two runs", () => {
    const graph = clipChain({
      inLabel: "in",
      outLabel: "out",
      effects: [
        { kind: "camera", move: "handheld_drift", amount: 0.7 },
        { kind: "grade", warmth: 0.4, contrast: 0.3, saturation: 0.2, lift: 0.3 },
        { kind: "grain", amount: 0.7 },
        { kind: "vignette", amount: 0.5 },
      ],
      durationS: 0.4,
      fps: FPS,
      isStill: true,
      seed: 8080,
    });
    const one = grayFrame(render("determinism-1", VIDEO_SRC, graph, { frames: 12 }), 9);
    const two = grayFrame(render("determinism-2", VIDEO_SRC, graph, { frames: 12 }), 9);
    expect(one.equals(two)).toBe(true);
  });
});
