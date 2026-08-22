/**
 * Signal-level tests for the local synthesiser. Every assertion measures the
 * decoded waveform, because the only thing that matters about a fallback score
 * is what comes out of the speakers.
 */
import { describe, it, expect } from "vitest";
import { synthesizeScore, renderAccent, encodeWav, type SynthResult } from "@/lib/music/synth";
import type { DirectorSpec } from "@/lib/spec/directorSpec";

// ── fixtures ─────────────────────────────────────────────────────────────────

function demoSpec(overrides: Partial<DirectorSpec> = {}): DirectorSpec {
  const spec: DirectorSpec = {
    spec_version: "1.0",
    title: "Salt Light",
    logline: "A kid on a seawall watches the town wake up and then run.",
    duration_s: 30,
    aspect_ratio: "9:16",
    style_bible: {
      preset: "sun-bleached gouache",
      palette: ["bleached coral", "deep teal", "warm sand"],
      character_rules: ["same yellow raincoat in every shot"],
      negative_rules: ["no text", "no extra fingers"],
      lighting: "warm low-angle light with soft falloff",
      medium: "loose gouache painting with visible brush texture",
      grain: 0.32,
    },
    music: {
      mode: "generated",
      bpm_target: 124,
      mood: "nostalgic then euphoric then warm",
      instrumentation: ["sub bass", "pad", "arpeggio"],
      key: "A minor",
      build_region_s: [10, 16],
      drop_at_s: 16,
      resolve_at_s: 24,
    },
    events: [
      { t: 0, kind: "intro", visual: "a still horizon", intensity: 0.1 },
      { t: 4.5, kind: "accent", visual: "gull cuts the frame", intensity: 0.45 },
      { t: 10, kind: "build", visual: "camera starts to move", intensity: 0.6 },
      { t: 16, kind: "drop", visual: "the town blooms into colour", intensity: 1 },
      { t: 20, kind: "variation", visual: "wide of the harbour", intensity: 0.7 },
      { t: 24, kind: "resolve", visual: "back to the seawall", intensity: 0.35 },
      { t: 29, kind: "final_hit", visual: "cut to the coat on the rail", intensity: 0.9 },
    ],
    scenes: [
      {
        id: "s01",
        start_s: 0,
        end_s: 6,
        purpose: "recognition",
        render_mode: "source_motion",
        reference_asset_ids: [],
        camera: "push_in",
        camera_note: "",
        action: "the horizon holds still",
        setting: "seawall at dawn",
        transition_in: "cut",
        retry_budget: 1,
      },
      {
        id: "s02",
        start_s: 6,
        end_s: 16,
        purpose: "build",
        render_mode: "stylized_keyframe",
        reference_asset_ids: [],
        camera: "parallax_drift",
        camera_note: "",
        action: "the town starts to stir",
        setting: "harbour street",
        transition_in: "crossfade",
        retry_budget: 1,
      },
      {
        id: "s03",
        start_s: 16,
        end_s: 24,
        purpose: "hero_drop",
        render_mode: "image_to_video",
        reference_asset_ids: [],
        camera: "whip",
        camera_note: "fast lateral",
        action: "everything blooms into colour",
        setting: "harbour wide",
        transition_in: "flash",
        retry_budget: 2,
      },
      {
        id: "s04",
        start_s: 24,
        end_s: 30,
        purpose: "resolution",
        render_mode: "source_motion",
        reference_asset_ids: [],
        camera: "pull_out",
        camera_note: "",
        action: "the coat is left on the rail",
        setting: "seawall at noon",
        transition_in: "dip_to_white",
        retry_budget: 1,
      },
    ],
  };
  return { ...spec, ...overrides };
}

// ── wav decoding ─────────────────────────────────────────────────────────────

interface DecodedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  audioFormat: number;
  frames: number;
  dataBytes: number;
  riffSize: number;
  left: Float32Array;
  right: Float32Array;
}

/** Minimal RIFF reader so the tests inspect the real bytes, not the generator. */
function decodeWav(buf: Buffer): DecodedWav {
  expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
  const riffSize = buf.readUInt32LE(4);

  let pos = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataStart = -1;
  let dataBytes = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataStart = body;
      dataBytes = size;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error("wav is missing fmt or data chunk");

  const frames = dataBytes / (fmt.channels * (fmt.bits / 8));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = buf.readInt16LE(dataStart + i * 4) / 32768;
    right[i] = buf.readInt16LE(dataStart + i * 4 + 2) / 32768;
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    audioFormat: fmt.audioFormat,
    frames,
    dataBytes,
    riffSize,
    left,
    right,
  };
}

function rmsRegion(d: DecodedWav, t0: number, t1: number): number {
  const a = Math.max(0, Math.round(t0 * d.sampleRate));
  const b = Math.min(d.frames, Math.round(t1 * d.sampleRate));
  let acc = 0;
  let n = 0;
  for (let i = a; i < b; i++) {
    acc += d.left[i] * d.left[i] + d.right[i] * d.right[i];
    n += 2;
  }
  return n > 0 ? Math.sqrt(acc / n) : 0;
}

function peakOf(d: DecodedWav): number {
  let p = 0;
  for (let i = 0; i < d.frames; i++) {
    p = Math.max(p, Math.abs(d.left[i]), Math.abs(d.right[i]));
  }
  return p;
}

function meanOf(d: DecodedWav): number {
  let s = 0;
  for (let i = 0; i < d.frames; i++) s += d.left[i] + d.right[i];
  return s / (d.frames * 2);
}

const dbfs = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));

// Synthesis is the expensive part; render once and share across assertions.
const SPEC = demoSpec();
let cached: SynthResult | null = null;
function score(): SynthResult {
  if (!cached) cached = synthesizeScore(SPEC, 1234);
  return cached;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("synthesizeScore: container", () => {
  it("writes a valid 16-bit stereo 44.1 kHz RIFF/WAVE file", () => {
    const r = score();
    const d = decodeWav(r.wav);
    expect(d.audioFormat).toBe(1);
    expect(d.bitsPerSample).toBe(16);
    expect(d.channels).toBe(2);
    expect(d.sampleRate).toBe(44100);
    expect(r.sampleRate).toBe(44100);
    expect(d.riffSize).toBe(r.wav.length - 8);
    expect(d.dataBytes).toBe(d.frames * 4);
  });

  it("reports a duration matching the data chunk to within one frame", () => {
    const r = score();
    const d = decodeWav(r.wav);
    expect(Math.abs(d.frames / d.sampleRate - r.durationS)).toBeLessThanOrEqual(1 / d.sampleRate);
    expect(Math.abs(r.durationS - SPEC.duration_s)).toBeLessThan(0.001);
  });

  it("reports the requested tempo", () => {
    expect(score().bpm).toBe(124);
  });
});

describe("synthesizeScore: levels", () => {
  it("is loud but never clips, and carries no DC offset", () => {
    const d = decodeWav(score().wav);
    const peak = peakOf(d);
    expect(peak).toBeLessThan(1);
    expect(peak).toBeGreaterThan(0.5);
    // -1 dBFS ceiling, allowing for 16-bit quantisation.
    expect(dbfs(peak)).toBeGreaterThan(-1.5);
    expect(dbfs(peak)).toBeLessThan(-0.5);
    expect(Math.abs(meanOf(d))).toBeLessThan(0.001);
  });

  it("sits in a musical loudness range", () => {
    const d = decodeWav(score().wav);
    const rms = dbfs(rmsRegion(d, 0, score().durationS));
    expect(rms).toBeGreaterThan(-16);
    expect(rms).toBeLessThan(-11);
  });

  it("starts and ends at silence", () => {
    const d = decodeWav(score().wav);
    expect(Math.abs(d.left[0])).toBeLessThan(0.002);
    expect(Math.abs(d.left[d.frames - 1])).toBeLessThan(0.002);
    expect(rmsRegion(d, score().durationS - 0.02, score().durationS)).toBeLessThan(0.02);
  });
});

describe("synthesizeScore: arrangement", () => {
  it("makes the drop section louder than the intro", () => {
    const d = decodeWav(score().wav);
    const intro = rmsRegion(d, 0.5, 3.5);
    const drop = rmsRegion(d, 16.2, 19.2);
    expect(drop).toBeGreaterThan(intro * 1.5);
    expect(dbfs(drop) - dbfs(intro)).toBeGreaterThan(3);
  });

  it("drops out for ~150 ms before the drop so the impact lands", () => {
    const d = decodeWav(score().wav);
    const dropAt = 16;
    const before = rmsRegion(d, dropAt - 0.15, dropAt - 0.01);
    const after = rmsRegion(d, dropAt, dropAt + 0.15);
    expect(before).toBeLessThan(after * 0.5);
  });

  it("builds energy across the build region", () => {
    const d = decodeWav(score().wav);
    expect(rmsRegion(d, 13.5, 15.5)).toBeGreaterThan(rmsRegion(d, 10, 12));
  });

  it("strips back after the resolve", () => {
    const d = decodeWav(score().wav);
    expect(rmsRegion(d, 25, 27)).toBeLessThan(rmsRegion(d, 17, 19));
  });

  it("uses both channels without collapsing to mono", () => {
    const d = decodeWav(score().wav);
    let diff = 0;
    for (let i = 0; i < d.frames; i++) diff += Math.abs(d.left[i] - d.right[i]);
    expect(diff / d.frames).toBeGreaterThan(0.01);
  });
});

describe("synthesizeScore: metadata", () => {
  it("returns sorted, in-range anchors including the drop", () => {
    const r = score();
    expect(r.anchors.length).toBeGreaterThan(20);
    for (let i = 1; i < r.anchors.length; i++) {
      expect(r.anchors[i].t).toBeGreaterThanOrEqual(r.anchors[i - 1].t);
    }
    for (const a of r.anchors) {
      expect(a.t).toBeGreaterThanOrEqual(0);
      expect(a.t).toBeLessThanOrEqual(r.durationS);
      expect(a.strength).toBeGreaterThan(0);
      expect(a.strength).toBeLessThanOrEqual(1);
    }
    const drop = r.anchors.find((a) => a.kind === "drop");
    expect(drop).toBeDefined();
    expect(drop?.t).toBeCloseTo(16, 3);
    expect(r.anchors.some((a) => a.kind === "downbeat")).toBe(true);
    expect(r.anchors.some((a) => a.kind === "peak")).toBe(true);
  });

  it("places an anchor at every spec event time", () => {
    const r = score();
    for (const e of SPEC.events) {
      const hit = r.anchors.some((a) => Math.abs(a.t - e.t) < 1e-6);
      expect(hit, `no anchor at ${e.kind} t=${e.t}`).toBe(true);
    }
  });

  it("every kick downbeat is on the bar grid", () => {
    const r = score();
    const barS = (60 / r.bpm) * 4;
    for (const a of r.anchors.filter((x) => x.kind === "downbeat")) {
      const phase = ((a.t - 16) % barS + barS) % barS;
      expect(Math.min(phase, barS - phase)).toBeLessThan(0.003);
    }
  });

  it("returns a 20 fps energy envelope measured from the rendered audio", () => {
    const r = score();
    expect(r.energy.length).toBe(Math.floor(r.durationS * 20));
    expect(r.energy[1].t - r.energy[0].t).toBeCloseTo(0.05, 6);
    let max = 0;
    for (const p of r.energy) {
      expect(p.v).toBeGreaterThanOrEqual(0);
      expect(p.v).toBeLessThanOrEqual(1);
      max = Math.max(max, p.v);
    }
    expect(max).toBeCloseTo(1, 3);
    // Average whole regions: a single 50 ms frame lands wherever the beat grid
    // puts it, so frame-level comparisons would test the phase, not the arc.
    const mean = (from: number, to: number) => {
      const slice = r.energy.slice(Math.round(from * 20), Math.round(to * 20));
      return slice.reduce((a, p) => a + p.v, 0) / slice.length;
    };
    expect(mean(16.5, 19.5)).toBeGreaterThan(mean(1, 4) * 2);
    expect(mean(25, 27)).toBeLessThan(mean(16.5, 19.5));
  });
});

describe("synthesizeScore: determinism", () => {
  it("is byte-identical for the same spec and seed, and differs for another seed", () => {
    const a = synthesizeScore(SPEC, 77);
    const b = synthesizeScore(SPEC, 77);
    const c = synthesizeScore(SPEC, 78);
    expect(a.wav.equals(b.wav)).toBe(true);
    expect(a.wav.equals(c.wav)).toBe(false);
    expect(a.wav.length).toBe(c.wav.length);
    expect(a.anchors).toEqual(b.anchors);
  });
});

describe("synthesizeScore: robustness", () => {
  it("handles a major key, an odd tempo and a nonsense key string", () => {
    const major = synthesizeScore(
      demoSpec({
        duration_s: 18,
        music: { ...SPEC.music, key: "F# major", bpm_target: 92, drop_at_s: 9, resolve_at_s: 14, build_region_s: [5, 9] },
        events: [
          { t: 0, kind: "intro", visual: "a", intensity: 0.1 },
          { t: 3, kind: "accent", visual: "b", intensity: 0.4 },
          { t: 5, kind: "build", visual: "c", intensity: 0.6 },
          { t: 9, kind: "drop", visual: "d", intensity: 1 },
          { t: 14, kind: "resolve", visual: "e", intensity: 0.3 },
          { t: 17, kind: "final_hit", visual: "f", intensity: 0.8 },
        ],
      }),
      5,
    );
    const dMajor = decodeWav(major.wav);
    expect(major.durationS).toBeCloseTo(18, 3);
    expect(peakOf(dMajor)).toBeGreaterThan(0.5);
    expect(peakOf(dMajor)).toBeLessThan(1);

    const gibberish = synthesizeScore(demoSpec({ music: { ...SPEC.music, key: "cosmic vibes" } }), 5);
    const dGib = decodeWav(gibberish.wav);
    expect(peakOf(dGib)).toBeGreaterThan(0.5);
    expect(peakOf(dGib)).toBeLessThan(1);
    expect(Math.abs(meanOf(dGib))).toBeLessThan(0.001);
  });
});

describe("renderAccent", () => {
  it("renders an impact that decays, a riser that swells and a sweep that speaks", () => {
    const half = (a: Float32Array, from: number, to: number) => {
      let acc = 0;
      for (let i = from; i < to; i++) acc += a[i] * a[i];
      return Math.sqrt(acc / Math.max(1, to - from));
    };

    const impact = renderAccent("impact", 1.2);
    expect(impact.length).toBe(Math.round(1.2 * 44100));
    expect(half(impact, 0, impact.length >> 1)).toBeGreaterThan(half(impact, impact.length >> 1, impact.length));

    const riser = renderAccent("riser", 1.5);
    expect(half(riser, riser.length >> 1, riser.length)).toBeGreaterThan(half(riser, 0, riser.length >> 1) * 2);

    const sweep = renderAccent("sweep", 0.8, 48000);
    expect(sweep.length).toBe(Math.round(0.8 * 48000));

    for (const a of [impact, riser, sweep]) {
      let peak = 0;
      for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
      expect(peak).toBeGreaterThan(0.5);
      expect(peak).toBeLessThanOrEqual(1);
      expect(Math.abs(a[0])).toBeLessThan(0.01);
      expect(Math.abs(a[a.length - 1])).toBeLessThan(0.01);
    }
  });

  it("is deterministic", () => {
    const a = renderAccent("impact", 0.5);
    const b = renderAccent("impact", 0.5);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("encodeWav", () => {
  it("quantises to 16-bit little-endian and clamps out-of-range input", () => {
    const l = new Float32Array([0, 0.5, -0.5, 2, -2]);
    const r = new Float32Array([1, -1, 0, 0.25, -0.25]);
    const wav = encodeWav(l, r, 22050);
    const d = decodeWav(wav);
    expect(d.sampleRate).toBe(22050);
    expect(d.frames).toBe(5);
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(46)).toBe(32767);
    expect(wav.readInt16LE(48)).toBe(Math.round(0.5 * 32767));
    expect(wav.readInt16LE(50)).toBe(-32767);
    expect(wav.readInt16LE(56)).toBe(32767); // 2.0 clamped
    expect(wav.readInt16LE(60)).toBe(-32767); // -2.0 clamped
    expect(d.riffSize).toBe(wav.length - 8);
  });

  it("uses the shorter of the two channel lengths", () => {
    const wav = encodeWav(new Float32Array(10), new Float32Array(4), 44100);
    expect(decodeWav(wav).frames).toBe(4);
  });
});
