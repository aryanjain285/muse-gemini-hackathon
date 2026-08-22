/**
 * Local visual engine tests.
 *
 * Everything asserted here is measured off real decoded pixels: raw RGB pulled
 * back out of ffmpeg, frame signatures lifted out of an encoded MP4, ffprobe's
 * view of the container. The point is that nothing passes because a function
 * returned — it passes because the picture it produced has the right numbers.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PATHS } from "@/lib/core/paths";
import { sha256 } from "@/lib/core/util";
import type { StyleBible } from "@/lib/spec/directorSpec";
import {
  animateStill,
  buildSubjectSheet,
  pickPrimarySubject,
  probeImage,
  proceduralStill,
  stylizeStill,
} from "@/lib/visual/localRender";

const REFERENCE = path.resolve("workspace/reference/keyframe-probe-0.jpg");
const OUT = path.join(PATHS.tmp, "local-visual-test");

const STYLE: StyleBible = {
  preset: "sunlit gouache",
  palette: ["deep indigo", "burnt amber", "dusty rose", "pale gold"],
  character_rules: ["same face throughout"],
  negative_rules: ["no text"],
  lighting: "low warm sun with long shadows",
  medium: "loose gouache with visible brush texture",
  grain: 0.38,
};

// ── measurement helpers ──────────────────────────────────────────────────────

function ffmpeg(args: string[]): Buffer {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...args], { maxBuffer: 1 << 28 });
  if (res.status !== 0) {
    throw new Error(`ffmpeg failed (${res.status}): ${res.stderr?.toString().slice(-500)}`);
  }
  return res.stdout;
}

interface ProbeJson {
  streams: {
    codec_type?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    nb_frames?: string;
  }[];
  format: { duration?: string };
}

function ffprobeJson(file: string): ProbeJson {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
    { maxBuffer: 1 << 24 },
  );
  if (res.status !== 0) throw new Error(`ffprobe failed: ${res.stderr?.toString()}`);
  return JSON.parse(res.stdout.toString("utf8")) as ProbeJson;
}

/** Downscaled RGB signature of a still, used to compare two images numerically. */
function signature(file: string, size = 48): Buffer {
  return ffmpeg([
    "-i",
    file,
    "-vf",
    `scale=${size}:${size}:flags=area,format=rgb24`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
}

/** Two frames of a clip as 32x32 luma, so real motion shows up as a number. */
function frameSignatures(mp4: string, first: number, last: number): { a: Buffer; b: Buffer } {
  const raw = ffmpeg([
    "-i",
    mp4,
    "-vf",
    `select='eq(n,${first})+eq(n,${last})',scale=32:32:flags=area,format=gray`,
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "-",
  ]);
  expect(raw.length).toBe(2 * 32 * 32);
  return { a: raw.subarray(0, 1024), b: raw.subarray(1024) };
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  expect(a.length).toBe(b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function lumaSeries(rgb: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    out.push(0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]);
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

/** Pearson correlation: proves a stylised frame is the same picture, not a new one. */
function correlation(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) * (a[i] - ma);
    db += (b[i] - mb) * (b[i] - mb);
  }
  return num / Math.sqrt(da * db);
}

/** Independent colour census: 3 bits per channel, only buckets worth 1% count. */
function colourBuckets(rgb: Buffer, minShare = 0.01): number {
  const counts = new Map<number, number>();
  const pixels = rgb.length / 3;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const key = ((rgb[i] >> 5) << 6) | ((rgb[i + 1] >> 5) << 3) | (rgb[i + 2] >> 5);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].filter((n) => n / pixels >= minShare).length;
}

beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  expect(fs.existsSync(REFERENCE)).toBe(true);
});

// ── probeImage ───────────────────────────────────────────────────────────────

describe("probeImage", () => {
  it("reads real dimensions, exposure and a usable palette", async () => {
    const probe = await probeImage(REFERENCE);
    expect(probe.width).toBe(768);
    expect(probe.height).toBe(1376);
    expect(probe.bytes).toBe(fs.statSync(REFERENCE).size);
    expect(probe.brightness).toBeGreaterThan(0);
    expect(probe.brightness).toBeLessThan(1);
    expect(probe.clipping).toBeGreaterThanOrEqual(0);
    expect(probe.clipping).toBeLessThan(0.5);
    expect(probe.palette.length).toBeGreaterThanOrEqual(3);
    for (const hex of probe.palette) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    // Distinct entries only: a palette of six near-identical browns is useless.
    expect(new Set(probe.palette).size).toBe(probe.palette.length);
  });

  it("scores a blurred copy of the same image as less sharp", async () => {
    const blurred = path.join(OUT, "reference-blurred.png");
    ffmpeg(["-y", "-i", REFERENCE, "-vf", "gblur=sigma=6", "-frames:v", "1", blurred]);
    const sharp = await probeImage(REFERENCE);
    const soft = await probeImage(blurred);
    expect(soft.width).toBe(sharp.width);
    expect(soft.sharpness).toBeLessThan(sharp.sharpness * 0.5);
    // Blurring must not be read as a change of exposure.
    expect(Math.abs(soft.brightness - sharp.brightness)).toBeLessThan(0.05);
  });

  it("rejects a path that is not an image", async () => {
    await expect(probeImage(path.join(OUT, "does-not-exist.png"))).rejects.toThrow(/does not exist/i);
  });
});

// ── stylizeStill ─────────────────────────────────────────────────────────────

describe("stylizeStill", () => {
  it("treats the source rather than replacing it", async () => {
    const out = path.join(OUT, "stylised.png");
    const result = await stylizeStill({
      sourcePath: REFERENCE,
      outPath: out,
      style: STYLE,
      strength: 0.75,
      seed: 11,
    });

    expect(result.width).toBeGreaterThanOrEqual(1080);
    const probed = ffprobeJson(out).streams[0];
    expect(probed.width).toBe(result.width);
    expect(probed.height).toBe(result.height);
    expect(fs.statSync(out).size).toBeGreaterThan(50_000);

    const before = signature(REFERENCE);
    const after = signature(out);
    const changed = meanAbsDiff(before, after);
    const beforeLuma = lumaSeries(before);
    const afterLuma = lumaSeries(after);
    const corr = correlation(beforeLuma, afterLuma);
    const exposureShift = Math.abs(mean(afterLuma) - mean(beforeLuma)) / 255;

    // Measurably different...
    expect(changed).toBeGreaterThan(6);
    // ...but still the same photograph: structure survives, exposure barely moves.
    expect(corr).toBeGreaterThan(0.85);
    expect(exposureShift).toBeLessThan(0.18);
  });

  it("pushes further at higher strength", async () => {
    const light = path.join(OUT, "stylised-light.png");
    const heavy = path.join(OUT, "stylised-heavy.png");
    await stylizeStill({ sourcePath: REFERENCE, outPath: light, style: STYLE, strength: 0.15, seed: 4 });
    await stylizeStill({ sourcePath: REFERENCE, outPath: heavy, style: STYLE, strength: 1, seed: 4 });
    const source = signature(REFERENCE);
    const lightDelta = meanAbsDiff(source, signature(light));
    const heavyDelta = meanAbsDiff(source, signature(heavy));
    expect(heavyDelta).toBeGreaterThan(lightDelta);
  });
});

// ── proceduralStill ──────────────────────────────────────────────────────────

describe("proceduralStill", () => {
  const action = "the subject stands on a rooftop as the city lights come up";

  it("is byte-identical for one seed and different for another", async () => {
    const a = path.join(OUT, "proc-a.png");
    const b = path.join(OUT, "proc-b.png");
    const c = path.join(OUT, "proc-c.png");
    const first = await proceduralStill({ outPath: a, style: STYLE, sceneAction: action, seed: 42 });
    await proceduralStill({ outPath: b, style: STYLE, sceneAction: action, seed: 42 });
    await proceduralStill({ outPath: c, style: STYLE, sceneAction: action, seed: 43 });

    expect(first.width).toBe(1080);
    expect(first.height).toBe(1920);
    expect(sha256(fs.readFileSync(a))).toBe(sha256(fs.readFileSync(b)));
    expect(sha256(fs.readFileSync(a))).not.toBe(sha256(fs.readFileSync(c)));
    // Different seeds must be a different composition, not a different dither.
    expect(meanAbsDiff(signature(a), signature(c))).toBeGreaterThan(4);
  });

  it("composes a real image rather than a flat colour", async () => {
    const out = path.join(OUT, "proc-flatness.png");
    await proceduralStill({ outPath: out, style: STYLE, sceneAction: action, seed: 7 });
    const rgb = signature(out, 64);
    const spread = stdev(lumaSeries(rgb));
    const buckets = colourBuckets(rgb);
    expect(spread).toBeGreaterThan(12);
    expect(buckets).toBeGreaterThanOrEqual(3);
    // And it has to be readable as a composition: top and bottom differ.
    const luma = lumaSeries(rgb);
    const top = mean(luma.slice(0, 64 * 16));
    const bottom = mean(luma.slice(64 * 48));
    expect(Math.abs(top - bottom)).toBeGreaterThan(10);
  });

  it("honours the scene action as a composition bias", async () => {
    const day = path.join(OUT, "proc-day.png");
    const night = path.join(OUT, "proc-night.png");
    await proceduralStill({ outPath: day, style: STYLE, sceneAction: "a golden afternoon field", seed: 21 });
    await proceduralStill({
      outPath: night,
      style: STYLE,
      sceneAction: "a night silhouette in deep shadow",
      seed: 21,
    });
    const dayLuma = mean(lumaSeries(signature(day)));
    const nightLuma = mean(lumaSeries(signature(night)));
    expect(nightLuma).toBeLessThan(dayLuma);
  });

  it("accepts a custom size", async () => {
    const out = path.join(OUT, "proc-square.png");
    const res = await proceduralStill({
      outPath: out,
      style: STYLE,
      sceneAction: action,
      seed: 3,
      width: 640,
      height: 640,
    });
    expect(res.width).toBe(640);
    expect(res.height).toBe(640);
    const probed = ffprobeJson(out).streams[0];
    expect(probed.width).toBe(640);
    expect(probed.height).toBe(640);
  });
});

// ── buildSubjectSheet ────────────────────────────────────────────────────────

describe("buildSubjectSheet", () => {
  it("lays three uploads onto one canvas", async () => {
    const out = path.join(OUT, "sheet.png");
    const sheet = await buildSubjectSheet({
      sourcePaths: [REFERENCE, REFERENCE, REFERENCE],
      outPath: out,
      seed: 3,
    });
    expect(sheet.tiles).toBe(3);
    const probed = ffprobeJson(out).streams[0];
    expect(probed.width).toBe(sheet.width);
    expect(probed.height).toBe(sheet.height);
    expect(sheet.width).toBeGreaterThan(sheet.height);
    expect(fs.statSync(out).size).toBeGreaterThan(20_000);
    // The tiles are real picture, not an empty canvas.
    expect(stdev(lumaSeries(signature(out, 64)))).toBeGreaterThan(15);
  });

  it("lays out a larger set by choosing, rather than refusing it", async () => {
    // This used to throw above five uploads, which was the product's old cap leaking into a
    // component whose whole job is ranking photographs and picking the best of them. Somebody
    // bringing nine pictures is not an error; the sheet takes the ones worth anchoring identity to.
    const sheet = await buildSubjectSheet({
      sourcePaths: new Array(9).fill(REFERENCE),
      outPath: path.join(OUT, "many.png"),
      seed: 4,
    });
    expect(fs.existsSync(sheet.path)).toBe(true);
    expect(sheet.tiles).toBeGreaterThan(0);
    // Bounded on its own terms: a sheet of nine tiles is a collage, not a reference.
    expect(sheet.tiles).toBeLessThanOrEqual(6);
  });
});

// ── animateStill ─────────────────────────────────────────────────────────────

describe("animateStill", () => {
  it("produces a silent 1080x1920 30fps clip of the requested length with real motion", async () => {
    const still = path.join(OUT, "anim-source.png");
    await proceduralStill({ outPath: still, style: STYLE, sceneAction: "a slow push over rooftops", seed: 8 });

    const out = path.join(OUT, "clip-push.mp4");
    const clip = await animateStill({
      stillPath: still,
      outPath: out,
      durationS: 2.4,
      move: "push_in",
      amount: 0.7,
      seed: 5,
    });

    const probed = ffprobeJson(out);
    const video = probed.streams.find((s) => s.codec_type === "video");
    expect(video).toBeDefined();
    expect(video?.width).toBe(1080);
    expect(video?.height).toBe(1920);
    expect(video?.r_frame_rate).toBe("30/1");
    expect(probed.streams.some((s) => s.codec_type === "audio")).toBe(false);

    const duration = Number(probed.format.duration);
    expect(Math.abs(duration - 2.4)).toBeLessThan(0.05);
    expect(Math.abs(clip.durationS - duration)).toBeLessThan(0.001);

    const frames = Number(video?.nb_frames);
    expect(frames).toBe(72);
    const { a, b } = frameSignatures(out, 0, frames - 1);
    expect(meanAbsDiff(a, b)).toBeGreaterThan(1.5);
  });

  it("keeps duration exact for an awkward length and honours parallax", async () => {
    const still = path.join(OUT, "anim-source.png");
    const out = path.join(OUT, "clip-parallax.mp4");
    const clip = await animateStill({
      stillPath: still,
      outPath: out,
      durationS: 2.567,
      move: "parallax_drift",
      amount: 0.8,
      parallax: true,
      seed: 5,
    });
    const probed = ffprobeJson(out);
    const duration = Number(probed.format.duration);
    expect(Math.abs(duration - 2.567)).toBeLessThan(0.05);
    expect(clip.durationS).toBe(2.567);
    expect(probed.streams.some((s) => s.codec_type === "audio")).toBe(false);
    const frames = Number(probed.streams[0].nb_frames);
    const { a, b } = frameSignatures(out, 0, frames - 1);
    expect(meanAbsDiff(a, b)).toBeGreaterThan(1.5);
  });

  it("moves the frame for every camera move in the library", async () => {
    const still = path.join(OUT, "anim-source.png");
    const moves = ["static", "pan_left", "tilt_down", "handheld_drift", "whip", "pull_out"] as const;
    for (const move of moves) {
      const out = path.join(OUT, `clip-${move}.mp4`);
      await animateStill({ stillPath: still, outPath: out, durationS: 1.2, move, amount: 0.8, seed: 7 });
      const frames = Number(ffprobeJson(out).streams[0].nb_frames);
      expect(frames).toBe(36);
      const { a, b } = frameSignatures(out, 0, frames - 1);
      // Even a "static" shot breathes, so no move in the library is a frozen frame.
      expect(meanAbsDiff(a, b)).toBeGreaterThan(0.2);
    }
  });

  it("rejects a missing still and a non-positive duration", async () => {
    await expect(
      animateStill({
        stillPath: path.join(OUT, "missing.png"),
        outPath: path.join(OUT, "never.mp4"),
        durationS: 2,
        move: "push_in",
      }),
    ).rejects.toThrow(/missing/i);
    await expect(
      animateStill({
        stillPath: path.join(OUT, "anim-source.png"),
        outPath: path.join(OUT, "never.mp4"),
        durationS: 0,
        move: "push_in",
      }),
    ).rejects.toThrow(/duration/i);
  });
});

// ── pickPrimarySubject ───────────────────────────────────────────────────────

describe("pickPrimarySubject", () => {
  it("ranks the sharp original above a blurred copy", async () => {
    const blurred = path.join(OUT, "rank-blurred.png");
    ffmpeg(["-y", "-i", REFERENCE, "-vf", "gblur=sigma=8", "-frames:v", "1", blurred]);
    const ranked = await pickPrimarySubject([blurred, REFERENCE]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].path).toBe(REFERENCE);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    for (const r of ranked) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("penalises a landscape crop against a vertical one", async () => {
    const landscape = path.join(OUT, "rank-landscape.png");
    ffmpeg(["-y", "-i", REFERENCE, "-vf", "crop=768:432:0:400", "-frames:v", "1", landscape]);
    const ranked = await pickPrimarySubject([landscape, REFERENCE]);
    expect(ranked[0].path).toBe(REFERENCE);
  });
});
