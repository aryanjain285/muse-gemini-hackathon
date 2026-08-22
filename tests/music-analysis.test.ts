/**
 * Audio analysis and reconciliation tests.
 *
 * The signal-processing assertions run against a real Lyria clip on disk and
 * against a synthetic click track whose onset times are known exactly, so a
 * regression in peak picking or tempo estimation fails here rather than in a
 * render.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  ANALYSIS,
  Fft,
  analyzeFile,
  analyzeSamples,
  decodeToMono,
  magnitudeSpectrum,
} from "@/lib/music/analyze";
import { planMusic, MAX_BRIEF_CHARS } from "@/lib/music/planner";
import { reconcile, reconciliationSummary } from "@/lib/music/reconcile";
import { DROP_TOLERANCE_S } from "@/lib/music/types";
import type { ActualMusicMap, MusicAnchor, PlannedMusicMap } from "@/lib/music/types";
import { parseSpec } from "@/lib/spec/directorSpec";
import type { DirectorSpec, TimelineEvent } from "@/lib/spec/directorSpec";

const REFERENCE_MP3 = path.resolve(process.cwd(), "workspace/reference/soundtrack-probe-0.mp3");
const SR = 44100;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Click track: a short decaying burst at each of the given times. */
function clickTrack(times: number[], durationS: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(durationS * sampleRate));
  for (const t of times) {
    const at = Math.round(t * sampleRate);
    for (let i = 0; i < 200 && at + i < out.length; i++) {
      out[at + i] = Math.exp(-i / 40) * (i % 2 === 0 ? 0.9 : -0.9);
    }
  }
  return out;
}

function anchor(t: number, kind: MusicAnchor["kind"], strength: number): MusicAnchor {
  return { t, kind, strength };
}

function plannedMap(
  events: PlannedMusicMap["events"],
  overrides: Partial<PlannedMusicMap> = {},
): PlannedMusicMap {
  return {
    bpm: 118,
    durationS: 30,
    key: "A minor",
    mood: "nostalgic then euphoric",
    brief: "test brief",
    events,
    ...overrides,
  };
}

function actualMap(anchors: MusicAnchor[], overrides: Partial<ActualMusicMap> = {}): ActualMusicMap {
  return {
    durationS: 30,
    bpm: 120,
    sampleRate: SR,
    peak: 0.9,
    anchors,
    energy: [],
    peakRegionS: null,
    measured: true,
    ...overrides,
  };
}

function makeSpec(): DirectorSpec {
  const raw = {
    spec_version: "1.0",
    title: "Long Way Home",
    logline: "A cyclist chases the last light across a coastal road.",
    duration_s: 30,
    aspect_ratio: "9:16",
    style_bible: {
      preset: "painterly-dusk",
      palette: ["dusty rose", "deep indigo", "amber rim light"],
      character_rules: ["same navy jacket in every scene"],
      negative_rules: ["no text", "no extra limbs"],
      lighting: "warm low-angle light with soft falloff",
      medium: "loose gouache painting with visible brush texture",
      grain: 0.35,
    },
    music: {
      mode: "generated",
      bpm_target: 118,
      mood: "nostalgic then euphoric then warm",
      instrumentation: ["felt piano", "analogue pad", "brushed drums", "sub bass"],
      key: "A minor",
    },
    events: [
      { t: 0, kind: "intro", visual: "empty road at dusk", intensity: 0.2 },
      { t: 3.5, kind: "accent", visual: "wheels catch the light", intensity: 0.45 },
      { t: 11, kind: "build", visual: "cadence rises", intensity: 0.65 },
      { t: 15, kind: "drop", visual: "crest of the hill opens to the sea", intensity: 1 },
      { t: 21, kind: "variation", visual: "gulls scatter", intensity: 0.7 },
      { t: 25, kind: "resolve", visual: "coasting downhill", intensity: 0.4 },
      { t: 29, kind: "final_hit", visual: "silhouette against the water", intensity: 0.55 },
    ],
    scenes: [
      {
        id: "s01",
        start_s: 0,
        end_s: 4,
        purpose: "recognition",
        render_mode: "source_motion",
        camera: "push_in",
        camera_note: "slow",
        action: "the road empties toward the horizon",
        setting: "coastal road at dusk",
        transition_in: "cut",
        retry_budget: 1,
      },
      {
        id: "s02",
        start_s: 4,
        end_s: 11,
        purpose: "world_opens",
        render_mode: "stylized_keyframe",
        camera: "pan_right",
        camera_note: "",
        action: "the sea appears past the guardrail",
        setting: "cliff edge",
        transition_in: "crossfade",
        retry_budget: 1,
      },
      {
        id: "s03",
        start_s: 11,
        end_s: 15,
        purpose: "build",
        render_mode: "source_motion",
        camera: "handheld_drift",
        camera_note: "",
        action: "legs drive the pedals",
        setting: "low on the road surface",
        transition_in: "cut",
        retry_budget: 1,
      },
      {
        id: "s04",
        start_s: 15,
        end_s: 21,
        purpose: "hero_drop",
        render_mode: "image_to_video",
        camera: "pull_out",
        camera_note: "reveal the bay",
        action: "the whole bay opens up",
        setting: "hilltop",
        transition_in: "flash",
        retry_budget: 2,
      },
      {
        id: "s05",
        start_s: 21,
        end_s: 30,
        purpose: "resolution",
        render_mode: "source_motion",
        camera: "static",
        camera_note: "",
        action: "the rider coasts into silhouette",
        setting: "seafront",
        transition_in: "dip_to_black",
        retry_budget: 1,
      },
    ],
  };
  const result = parseSpec(raw);
  if (!result.spec) throw new Error(`fixture spec did not validate: ${JSON.stringify(result.issues)}`);
  return result.spec;
}

// ── FFT ──────────────────────────────────────────────────────────────────────

describe("Fft", () => {
  it("puts a 440 Hz sine in the expected bin", () => {
    const n = 4096;
    const fft = new Fft(n);
    const sig = new Float64Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    const mags = magnitudeSpectrum(fft, sig);
    let peak = 0;
    for (let b = 1; b < mags.length; b++) if (mags[b] > mags[peak]) peak = b;
    expect(peak).toBe(Math.round((440 * n) / SR));
    // A single tone must dominate: the peak stands well clear of its neighbours.
    expect(mags[peak]).toBeGreaterThan(mags[peak + 3] * 10);
  });

  it("resolves two tones into two bins and rejects non-power-of-two sizes", () => {
    const n = 2048;
    const fft = new Fft(n);
    // Exactly on bin centres, so there is no scalloping loss to argue about and
    // the amplitude ratio must come back exactly.
    const lowBin = 64;
    const highBin = 320;
    const sig = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sig[i] =
        Math.sin((2 * Math.PI * lowBin * i) / n) + 0.5 * Math.sin((2 * Math.PI * highBin * i) / n);
    }
    const mags = magnitudeSpectrum(fft, sig);
    expect(mags[lowBin]).toBeGreaterThan(mags[200] * 1000);
    expect(mags[highBin]).toBeGreaterThan(mags[200] * 1000);
    // The low tone is twice the amplitude of the high one.
    expect(mags[lowBin] / mags[highBin]).toBeCloseTo(2, 4);
    // Each single-sided line carries half the tone's amplitude times N/2.
    expect(mags[lowBin]).toBeCloseTo(n / 2, 4);
    expect(() => new Fft(1000)).toThrow();
  });

  it("satisfies Parseval, so the transform conserves energy", () => {
    const n = 512;
    const fft = new Fft(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    // Deterministic pseudo-random input via a small xorshift, never Math.random.
    let state = 0x1234567;
    let timeEnergy = 0;
    for (let i = 0; i < n; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const v = ((state >>> 0) / 0xffffffff) * 2 - 1;
      re[i] = v;
      timeEnergy += v * v;
    }
    fft.transform(re, im);
    let specEnergy = 0;
    for (let i = 0; i < n; i++) specEnergy += re[i] * re[i] + im[i] * im[i];
    expect(specEnergy / n).toBeCloseTo(timeEnergy, 6);
  });
});

// ── decoding ─────────────────────────────────────────────────────────────────

describe("decodeToMono", () => {
  it("decodes the reference Lyria mp3 to mono float PCM", async () => {
    expect(fs.existsSync(REFERENCE_MP3)).toBe(true);
    const { samples, sampleRate, durationS } = await decodeToMono(REFERENCE_MP3);
    expect(sampleRate).toBe(SR);
    expect(durationS).toBeGreaterThan(30.7);
    expect(durationS).toBeLessThan(30.8);
    expect(samples.length).toBe(Math.round(durationS * SR));

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
      sumSq += samples[i] * samples[i];
    }
    expect(peak).toBeGreaterThan(0.2);
    expect(Math.sqrt(sumSq / samples.length)).toBeGreaterThan(0.02);
  });

  it("honours the requested sample rate", async () => {
    const { samples, sampleRate, durationS } = await decodeToMono(REFERENCE_MP3, 22050);
    expect(sampleRate).toBe(22050);
    expect(samples.length).toBe(Math.round(durationS * 22050));
    expect(durationS).toBeGreaterThan(30.7);
    expect(durationS).toBeLessThan(30.8);
  });

  it("reports a missing file rather than hanging", async () => {
    await expect(decodeToMono(path.join(path.dirname(REFERENCE_MP3), "nope.mp3"))).rejects.toThrow(
      /not found/,
    );
  });
});

// ── analysis ─────────────────────────────────────────────────────────────────

describe("analyzeFile on the reference clip", () => {
  it("measures tempo, anchors, energy and a peak region", async () => {
    const map = await analyzeFile(REFERENCE_MP3);
    expect(map.measured).toBe(true);
    expect(map.sampleRate).toBe(SR);
    expect(map.durationS).toBeGreaterThan(30.7);
    expect(map.durationS).toBeLessThan(30.8);

    expect(map.bpm).toBeGreaterThanOrEqual(ANALYSIS.minBpm);
    expect(map.bpm).toBeLessThanOrEqual(ANALYSIS.maxBpm);
    // The clip was requested at 118 BPM; the estimate must be in that ballpark.
    expect(Math.abs(map.bpm - 118)).toBeLessThan(8);

    expect(map.anchors.length).toBeGreaterThan(20);
    for (const a of map.anchors) {
      expect(a.strength).toBeGreaterThanOrEqual(0);
      expect(a.strength).toBeLessThanOrEqual(1);
      expect(a.t).toBeGreaterThanOrEqual(0);
      expect(a.t).toBeLessThanOrEqual(map.durationS);
    }
    // Sorted, and no two anchors describing the same instant.
    for (let i = 1; i < map.anchors.length; i++) {
      expect(map.anchors[i].t).toBeGreaterThan(map.anchors[i - 1].t);
    }
    const kinds = new Set(map.anchors.map((a) => a.kind));
    expect(kinds.has("accent")).toBe(true);
    expect(kinds.has("peak")).toBe(true);
    expect(kinds.has("section")).toBe(true);

    // Energy envelope: roughly 20 points per second, covering the whole file.
    expect(map.energy.length).toBeGreaterThan(map.durationS * 19);
    expect(map.energy.length).toBeLessThan(map.durationS * 21);
    expect(map.energy[0].t).toBeCloseTo(0, 3);
    expect(map.energy[map.energy.length - 1].t).toBeGreaterThan(map.durationS - 0.2);
    expect(Math.max(...map.energy.map((p) => p.v))).toBeGreaterThan(0.9);
    // A quiet intro rising into a loud middle is the shape of this clip.
    const mean = (from: number, to: number) => {
      const pts = map.energy.filter((p) => p.t >= from && p.t < to);
      return pts.reduce((a, b) => a + b.v, 0) / Math.max(1, pts.length);
    };
    expect(mean(0, 4)).toBeLessThan(mean(12, 24));

    const region = map.peakRegionS;
    expect(region).not.toBeNull();
    if (region) {
      expect(region[0]).toBeGreaterThanOrEqual(0);
      expect(region[1]).toBeLessThanOrEqual(map.durationS);
      expect(region[1] - region[0]).toBeGreaterThanOrEqual(ANALYSIS.minPeakRegionS - 0.05);
      // The loudest instant has to sit inside the loudest sustained region.
      const peak = map.anchors.find((a) => a.kind === "peak");
      expect(peak).toBeDefined();
      if (peak) {
        expect(peak.t).toBeGreaterThanOrEqual(region[0]);
        expect(peak.t).toBeLessThanOrEqual(region[1]);
      }
    }
  });

  it("is deterministic across runs", async () => {
    const { samples, sampleRate } = await decodeToMono(REFERENCE_MP3);
    const a = analyzeSamples(samples, sampleRate);
    const b = analyzeSamples(samples, sampleRate);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("analyzeSamples against synthetic ground truth", () => {
  it("finds impulses within 30ms and reads 120 BPM off a half-second click track", () => {
    const truth: number[] = [];
    for (let k = 1; k <= 15; k++) truth.push(k * 0.5);
    const map = analyzeSamples(clickTrack(truth, 8.5), SR);

    expect(map.measured).toBe(true);
    expect(Math.abs(map.bpm - 120)).toBeLessThan(3);

    // Every click must be represented by an anchor within 30ms. The loudest one
    // carries the "peak" label instead of "accent", which is the same instant
    // under a more specific name.
    const detected = map.anchors.map((a) => a.t);
    for (const t of truth) {
      const nearest = detected.reduce((best, d) =>
        Math.abs(d - t) < Math.abs(best - t) ? d : best,
      );
      expect(Math.abs(nearest - t), `no anchor near ${t}s`).toBeLessThan(0.03);
    }
    const onsetKinds = map.anchors.filter(
      (a) => a.kind === "onset" || a.kind === "downbeat" || a.kind === "accent",
    );
    expect(onsetKinds.length).toBeGreaterThanOrEqual(truth.length - 1);
    // No onset may be invented in the silence between the clicks.
    for (const a of onsetKinds) {
      const nearestTruth = truth.reduce((best, t) =>
        Math.abs(t - a.t) < Math.abs(best - a.t) ? t : best,
      );
      expect(Math.abs(nearestTruth - a.t), `spurious onset at ${a.t}s`).toBeLessThan(0.05);
    }
    // Every click is the same size, so nothing may be reported at zero strength.
    for (const a of map.anchors) expect(a.strength).toBeGreaterThan(0.1);
  });

  it("hears a loud passage as the peak region", () => {
    // A continuous tone that is ten times louder between 4s and 7s: the peak
    // region must land on that block and stay inside it.
    const samples = new Float32Array(Math.round(11 * SR));
    for (let i = 0; i < samples.length; i++) {
      const t = i / SR;
      const loud = t >= 4 && t <= 7;
      samples[i] = Math.sin((2 * Math.PI * 400 * i) / SR) * (loud ? 0.9 : 0.09);
    }
    const map = analyzeSamples(samples, SR);
    const region = map.peakRegionS;
    expect(region).not.toBeNull();
    if (region) {
      expect(region[0]).toBeGreaterThan(3.5);
      expect(region[1]).toBeLessThan(7.5);
      expect(region[1] - region[0]).toBeGreaterThan(1.4);
    }
    // The two amplitude steps are the only structural changes in the file.
    const sections = map.anchors.filter((a) => a.kind === "section").map((a) => a.t);
    expect(sections.length).toBeGreaterThanOrEqual(1);
    for (const t of sections) {
      expect(Math.min(Math.abs(t - 4), Math.abs(t - 7))).toBeLessThan(0.35);
    }
  });

  it("returns an empty but valid map for degenerate input", () => {
    const map = analyzeSamples(new Float32Array(100), SR);
    expect(map.anchors).toEqual([]);
    expect(map.peakRegionS).toBeNull();
    expect(map.measured).toBe(true);
    const silence = analyzeSamples(new Float32Array(SR * 2), SR);
    expect(silence.anchors.length).toBe(0);
    expect(silence.energy.length).toBeGreaterThan(0);
    expect(silence.bpm).toBeGreaterThanOrEqual(ANALYSIS.minBpm);
  });
});

// ── planner ──────────────────────────────────────────────────────────────────

describe("planMusic", () => {
  it("writes a brief a music model can follow", () => {
    const { planned, brief } = planMusic(makeSpec());
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(brief.toLowerCase()).toContain("instrumental");
    expect(brief.toLowerCase()).toContain("no vocals");
    expect(brief).toContain("118 BPM");
    expect(brief).toContain("A minor");
    expect(brief).toContain("30 seconds");
    expect(brief).toContain("felt piano");
    expect(brief).toContain("nostalgic then euphoric then warm");
    // The drop time is the single most important number in the brief.
    expect(brief).toContain("15 seconds");
    expect(brief).toMatch(/strongest moment at 15 seconds/);
    // Prose, not markup.
    expect(brief).not.toMatch(/[*#`_]|^-|\n-/);
    expect(brief).not.toContain("\n");

    expect(planned.bpm).toBe(118);
    expect(planned.durationS).toBe(30);
    expect(planned.key).toBe("A minor");
    expect(planned.brief).toBe(brief);
    expect(planned.events.map((e) => e.kind)).toEqual([
      "intro",
      "accent",
      "build",
      "drop",
      "variation",
      "resolve",
      "final_hit",
    ]);
    for (let i = 1; i < planned.events.length; i++) {
      expect(planned.events[i].t).toBeGreaterThanOrEqual(planned.events[i - 1].t);
    }
  });

  it("mentions the ordered structure in playback order", () => {
    const { brief } = planMusic(makeSpec());
    const order = ["open sparse", "percussion", "strongest moment", "resolve", "decisive hit"];
    let cursor = -1;
    for (const phrase of order) {
      const at = brief.indexOf(phrase);
      expect(at, `missing phrase: ${phrase}`).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("stays inside the prompt budget and is deterministic", () => {
    const spec = makeSpec();
    const verbose: DirectorSpec = {
      ...spec,
      music: {
        ...spec.music,
        mood: "wistful and unhurried, then gathering, then unmistakably euphoric, then warm again, ".repeat(
          4,
        ),
        instrumentation: [
          "hand-played felt piano recorded very close with the pedal noise left in",
          "wide analogue pad with slow chorus",
          "brushed drums",
          "sub bass",
          "tape-saturated mellotron",
          "bowed double bass",
          "hammered dulcimer",
          "granular vocal-free texture",
        ],
      },
      events: ([
        ...spec.events,
        { t: 6, kind: "accent", visual: "a gull crosses frame", intensity: 0.3 },
        { t: 8, kind: "accent", visual: "gear change", intensity: 0.35 },
        { t: 13, kind: "accent", visual: "hands tighten", intensity: 0.5 },
        { t: 18, kind: "variation", visual: "spray off the sea wall", intensity: 0.6 },
        { t: 23, kind: "accent", visual: "shadow lengthens", intensity: 0.4 },
      ] satisfies TimelineEvent[]).sort((a, b) => a.t - b.t),
    };
    const first = planMusic(verbose);
    const second = planMusic(verbose);
    expect(first.brief).toBe(second.brief);
    expect(first.brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    // Structure survives the trim even when mood and instrumentation are huge.
    expect(first.brief).toContain("strongest moment at 15 seconds");
    expect(first.brief).toContain("decisive hit at 29 seconds");
    expect(first.planned.events.length).toBe(verbose.events.length);
  });
});

// ── reconciliation ───────────────────────────────────────────────────────────

describe("reconcile", () => {
  it("snaps a drop to a nearby anchor", () => {
    const planned = plannedMap([{ t: 15, kind: "drop", intensity: 1 }]);
    const actual = actualMap([anchor(15.3, "accent", 0.9)]);
    const r = reconcile(planned, actual);

    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].actualT).toBe(15.3);
    expect(r.matches[0].deltaS).toBeCloseTo(0.3, 3);
    expect(r.matches[0].confidence).toBeGreaterThan(0.5);
    expect(r.unmatched).toEqual([]);
    expect(r.snappedEvents[0]).toEqual({ t: 15.3, kind: "drop", intensity: 1, snapped: true });
    expect(r.maxDeltaS).toBeCloseTo(0.3, 3);
    expect(reconciliationSummary(r)).toContain("1/1 events snapped");
  });

  it("refuses to snap a drop to an anchor six seconds away", () => {
    const planned = plannedMap([{ t: 15, kind: "drop", intensity: 1 }]);
    const r = reconcile(planned, actualMap([anchor(9, "accent", 1)]));

    expect(r.matches[0].actualT).toBeNull();
    expect(r.matches[0].deltaS).toBe(0);
    expect(r.matches[0].confidence).toBe(0);
    expect(r.unmatched).toEqual(["drop"]);
    expect(r.snappedEvents[0]).toEqual({ t: 15, kind: "drop", intensity: 1, snapped: false });
    expect(r.maxDeltaS).toBe(0);
  });

  it("uses the wider drop tolerance but still respects it", () => {
    const near = reconcile(
      plannedMap([{ t: 15, kind: "drop", intensity: 1 }]),
      actualMap([anchor(15 + DROP_TOLERANCE_S - 0.05, "accent", 1)]),
    );
    expect(near.matches[0].actualT).not.toBeNull();
    const far = reconcile(
      plannedMap([{ t: 15, kind: "drop", intensity: 1 }]),
      actualMap([anchor(15 + DROP_TOLERANCE_S + 0.05, "accent", 1)]),
    );
    expect(far.matches[0].actualT).toBeNull();
    // A non-drop event gets the narrow window, so the same anchor is too far.
    const accent = reconcile(
      plannedMap([{ t: 15, kind: "accent", intensity: 0.6 }]),
      actualMap([anchor(15.7, "accent", 1)]),
    );
    expect(accent.matches[0].actualT).toBeNull();
  });

  it("prefers an anchor inside the measured peak region for the drop", () => {
    const planned = plannedMap([{ t: 15, kind: "drop", intensity: 1 }]);
    const actual = actualMap([anchor(15.1, "accent", 0.6), anchor(15.6, "accent", 0.6)], {
      peakRegionS: [15.4, 17],
    });
    const r = reconcile(planned, actual);
    expect(r.matches[0].actualT).toBe(15.6);
  });

  it("prefers accents and downbeats over plain onsets", () => {
    const planned = plannedMap([{ t: 10, kind: "accent", intensity: 0.8 }]);
    const r = reconcile(
      planned,
      actualMap([anchor(10.02, "onset", 0.3), anchor(10.12, "accent", 0.95)]),
    );
    expect(r.matches[0].actualT).toBe(10.12);
  });

  it("gives one anchor to only one event", () => {
    const planned = plannedMap([
      { t: 10, kind: "accent", intensity: 0.5 },
      { t: 10.1, kind: "variation", intensity: 0.5 },
    ]);
    const r = reconcile(planned, actualMap([anchor(10.05, "accent", 0.9)]));
    const snapped = r.snappedEvents.filter((e) => e.snapped);
    expect(snapped).toHaveLength(1);
    expect(r.unmatched).toHaveLength(1);
    // The event nearer the anchor is the one that keeps it.
    expect(snapped[0].kind).toBe("variation");
  });

  it("lets the loser of a contested anchor take its next-best candidate", () => {
    const planned = plannedMap([
      { t: 10, kind: "accent", intensity: 0.5 },
      { t: 10.3, kind: "variation", intensity: 0.5 },
    ]);
    const r = reconcile(
      planned,
      actualMap([anchor(9.85, "accent", 0.8), anchor(10.28, "accent", 0.95)]),
    );
    expect(r.snappedEvents.map((e) => e.t)).toEqual([9.85, 10.28]);
    expect(r.unmatched).toEqual([]);
  });

  it("never reorders the timeline", () => {
    // The only anchor a drop could reach lies past its neighbour, so snapping is
    // rejected rather than swapping the two events.
    const planned = plannedMap([
      { t: 10, kind: "drop", intensity: 1 },
      { t: 10.3, kind: "final_hit", intensity: 0.8 },
    ]);
    const r = reconcile(planned, actualMap([anchor(11, "accent", 1)]));
    expect(r.unmatched).toContain("drop");
    expect(r.snappedEvents.map((e) => e.t)).toEqual([10, 10.3]);
    for (let i = 1; i < r.snappedEvents.length; i++) {
      expect(r.snappedEvents[i].t).toBeGreaterThan(r.snappedEvents[i - 1].t);
    }
  });

  it("keeps a dense timeline monotonic against a dense anchor list", () => {
    const planned = plannedMap([
      { t: 2, kind: "intro", intensity: 0.2 },
      { t: 6, kind: "accent", intensity: 0.5 },
      { t: 6.35, kind: "accent", intensity: 0.5 },
      { t: 6.6, kind: "build", intensity: 0.7 },
      { t: 15, kind: "drop", intensity: 1 },
      { t: 15.4, kind: "variation", intensity: 0.6 },
    ]);
    const anchors: MusicAnchor[] = [];
    for (let t = 1.5; t < 16.5; t += 0.17) {
      anchors.push(anchor(Number(t.toFixed(3)), "onset", 0.4));
    }
    anchors.push(anchor(15.9, "accent", 1));
    const r = reconcile(planned, actualMap(anchors));
    for (let i = 1; i < r.snappedEvents.length; i++) {
      expect(r.snappedEvents[i].t).toBeGreaterThan(r.snappedEvents[i - 1].t);
    }
    // Each claimed anchor is claimed once.
    const used = r.matches.filter((m) => m.actualT !== null).map((m) => m.actualT);
    expect(new Set(used).size).toBe(used.length);
    expect(r.maxDeltaS).toBeLessThanOrEqual(DROP_TOLERANCE_S);
  });

  it("is total: empty anchors, empty events and a zero-length map do not throw", () => {
    const events: PlannedMusicMap["events"] = [
      { t: 0, kind: "intro", intensity: 0.2 },
      { t: 15, kind: "drop", intensity: 1 },
    ];
    const empty = reconcile(plannedMap(events), actualMap([]));
    expect(empty.matches).toHaveLength(2);
    expect(empty.unmatched).toEqual(["intro", "drop"]);
    expect(empty.snappedEvents.every((e) => !e.snapped)).toBe(true);
    expect(empty.maxDeltaS).toBe(0);

    const noEvents = reconcile(plannedMap([]), actualMap([anchor(1, "accent", 1)]));
    expect(noEvents.matches).toEqual([]);
    expect(noEvents.snappedEvents).toEqual([]);
    expect(noEvents.maxDeltaS).toBe(0);

    const zeroLength = reconcile(
      plannedMap(events, { durationS: 0 }),
      actualMap([], { durationS: 0, energy: [], peakRegionS: null }),
    );
    expect(zeroLength.snappedEvents).toHaveLength(2);

    // Junk that a stored map could contain must be filtered, not crash.
    const junk = reconcile(
      plannedMap([{ t: Number.NaN, kind: "accent", intensity: 0.5 }]),
      actualMap([anchor(Number.POSITIVE_INFINITY, "accent", 1)]),
    );
    expect(junk.matches).toEqual([]);
  });
});

// ── end to end ───────────────────────────────────────────────────────────────

describe("plan, measure, reconcile", () => {
  it("snaps the Director's timeline onto the real Lyria clip", async () => {
    const { planned } = planMusic(makeSpec());
    const actual = await analyzeFile(REFERENCE_MP3);
    const r = reconcile(planned, actual);

    expect(r.snappedEvents).toHaveLength(planned.events.length);
    for (let i = 1; i < r.snappedEvents.length; i++) {
      expect(r.snappedEvents[i].t).toBeGreaterThan(r.snappedEvents[i - 1].t);
    }
    // Real audio is dense enough that most intended beats find a real accent.
    const snapped = r.snappedEvents.filter((e) => e.snapped).length;
    expect(snapped).toBeGreaterThanOrEqual(planned.events.length - 2);
    expect(r.maxDeltaS).toBeLessThanOrEqual(DROP_TOLERANCE_S);
    for (const m of r.matches) {
      if (m.actualT !== null) {
        expect(Math.abs(m.deltaS)).toBeLessThanOrEqual(
          m.kind === "drop" ? DROP_TOLERANCE_S : 0.45,
        );
        expect(m.confidence).toBeGreaterThan(0);
      }
    }
    // Every snapped time is a real measured anchor, not an interpolation.
    const anchorTimes = new Set(actual.anchors.map((a) => a.t));
    for (const e of r.snappedEvents) {
      if (e.snapped) expect(anchorTimes.has(e.t)).toBe(true);
    }
  });
});
