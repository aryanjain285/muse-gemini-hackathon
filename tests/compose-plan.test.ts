/**
 * Manifest planning tests.
 *
 * Two properties carry the product. First, the transition arithmetic: a
 * cross-dissolve overlaps two clips, so the reel must still land on its planned
 * duration to the frame. Second, cut snapping: boundaries must move onto measured
 * accents without ever reordering the timeline or collapsing a shot.
 *
 * These are the regressions worth guarding. Cuts were once a mean 596ms off because
 * boundaries were taken straight from the plan, and snapping to the sparse set of
 * reconciled events instead of the dense measured one moved only one cut in six.
 */
import { describe, expect, it } from "vitest";
import {
  SNAP_HEADROOM_S,
  TRANSITION_DURATION_S,
  audioArc,
  buildManifest,
  clipDurationFor,
  cuttableAnchors,
  effectsFor,
  overlaysFor,
  quantize,
  snapSceneBoundaries,
  transitionDuration,
  validateManifest,
  type ClipInput,
} from "@/lib/compose/plan";
import { OUTPUT } from "@/lib/core/config";
import { round } from "@/lib/core/util";
import { normalize, type DirectorSpec, type Scene } from "@/lib/spec/directorSpec";
import type { MusicAnchor, Reconciliation } from "@/lib/music/types";

function scene(over: Partial<Scene> & { id: string; start_s: number; end_s: number }): Scene {
  return {
    purpose: "world_opens",
    render_mode: "stylized_keyframe",
    reference_asset_ids: [],
    camera: "push_in",
    camera_note: "",
    action: "something happens",
    setting: "a place",
    transition_in: "crossfade",
    retry_budget: 1,
    ...over,
  };
}

function spec(): DirectorSpec {
  return normalize({
    spec_version: "1.0",
    title: "Test Reel",
    logline: "A reel for testing.",
    duration_s: 30,
    aspect_ratio: "9:16",
    style_bible: {
      preset: "dreamy_animated_memories",
      palette: ["warm sunset", "soft greens"],
      character_rules: [],
      negative_rules: [],
      lighting: "warm low light",
      medium: "painterly illustration",
      grain: 0.35,
    },
    music: { mode: "generated", bpm_target: 118, mood: "nostalgic", instrumentation: [], key: "A minor" },
    events: [
      { t: 0, kind: "intro", visual: "open", intensity: 0.2 },
      { t: 11, kind: "build", visual: "rise", intensity: 0.7 },
      { t: 15, kind: "drop", visual: "hero", intensity: 1 },
      { t: 29, kind: "final_hit", visual: "title", intensity: 0.95 },
    ],
    scenes: [
      scene({ id: "s01", start_s: 0, end_s: 4, purpose: "recognition", transition_in: "cut" }),
      scene({ id: "s02", start_s: 4, end_s: 9 }),
      scene({ id: "s03", start_s: 9, end_s: 13, purpose: "motion_begins" }),
      scene({ id: "s04", start_s: 13, end_s: 15, purpose: "build", transition_in: "flash" }),
      scene({ id: "s05", start_s: 15, end_s: 21, purpose: "hero_drop" }),
      scene({ id: "s06", start_s: 21, end_s: 25, purpose: "variation", transition_in: "whip_pan" }),
      scene({ id: "s07", start_s: 25, end_s: 30, purpose: "resolution", title: "Test Reel" }),
    ],
  });
}

function clipsFor(s: DirectorSpec, opts: { isStill?: boolean } = {}): ClipInput[] {
  return s.scenes.map((sc) => ({
    scene: sc,
    path: `C:/tmp/${sc.id}.mp4`,
    sha256: `hash-${sc.id}`,
    // Assets are rendered at clipDurationFor, which includes the snap headroom.
    sourceDurationS: clipDurationFor(s, sc),
    fromFallback: false,
    isStill: opts.isStill ?? true,
    needsPainterly: false,
  }));
}

const audio = { path: "C:/tmp/score.wav", sha256: "audio-hash", durationS: 30, fromFallback: false };

// ── transition arithmetic ────────────────────────────────────────────────────

describe("transition arithmetic", () => {
  it("never lets a transition eat more than a third of the shot it enters", () => {
    // A 0.9s shot cannot absorb a 0.5s crossfade without becoming a dissolve.
    expect(transitionDuration("crossfade", 0.9)).toBeLessThanOrEqual(0.3 + 1 / OUTPUT.fps);
    expect(transitionDuration("crossfade", 6)).toBeCloseTo(TRANSITION_DURATION_S.crossfade, 2);
  });

  it("treats a hard cut as zero length", () => {
    expect(transitionDuration("cut", 5)).toBe(0);
  });

  it("quantizes every duration to a whole frame", () => {
    for (const v of [1.0001, 2.51239, 0.333333]) {
      const q = quantize(v);
      expect(Math.abs(q * OUTPUT.fps - Math.round(q * OUTPUT.fps))).toBeLessThan(1e-6);
    }
  });

  it("renders each clip long enough for its window, its transition and the snap headroom", () => {
    const s = spec();
    for (const [i, sc] of s.scenes.entries()) {
      const own = sc.end_s - sc.start_s;
      const tIn = i === 0 ? 0 : transitionDuration(sc.transition_in, own);
      expect(clipDurationFor(s, sc)).toBeCloseTo(quantize(own + tIn + SNAP_HEADROOM_S), 4);
    }
  });

  it("assembles to the planned duration once overlaps are consumed", () => {
    // The whole point of the head padding: sum of windows, not sum of clips.
    const s = spec();
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips: clipsFor(s),
      audio,
      reconciliation: null,
    });
    const total = m.clips.reduce((acc, c) => acc + (c.endS - c.startS), 0);
    expect(total).toBeCloseTo(s.duration_s, 2);
    expect(m.durationS).toBeCloseTo(s.duration_s, 2);
  });
});

// ── cut snapping ─────────────────────────────────────────────────────────────

describe("snapSceneBoundaries", () => {
  it("moves an internal boundary onto a nearby accent", () => {
    const s = spec();
    // An accent 120ms after the s02/s03 boundary at 9.0s. The result is quantized
    // to a frame, so it lands on 9.1333 rather than exactly on the anchor.
    const { boundaries, moved, maxShiftS } = snapSceneBoundaries(s, [9.12]);
    expect(boundaries[2]).toBeCloseTo(9.12, 1);
    expect(boundaries[2] * OUTPUT.fps).toBeCloseTo(Math.round(boundaries[2] * OUTPUT.fps), 4);
    expect(moved).toBe(1);
    expect(maxShiftS).toBeCloseTo(0.12, 1);
  });

  it("leaves a boundary alone when no accent is close enough", () => {
    const s = spec();
    const before = [0, ...s.scenes.map((x) => x.end_s)];
    const { boundaries, moved } = snapSceneBoundaries(s, [2.0, 19.5], 0.6);
    // 2.0 is 2s from any boundary; 19.5 is 1.5s from 21. Neither is in tolerance.
    expect(moved).toBe(0);
    expect(boundaries).toEqual(before);
  });

  it("pins the first and last boundaries so the audio still lines up", () => {
    const s = spec();
    const { boundaries } = snapSceneBoundaries(s, [0.4, 29.5]);
    expect(boundaries[0]).toBe(0);
    expect(boundaries[boundaries.length - 1]).toBeCloseTo(s.duration_s, 3);
  });

  it("never reorders the timeline", () => {
    const s = spec();
    // Deliberately hostile: accents that would pull boundaries past each other.
    const { boundaries } = snapSceneBoundaries(s, [4.5, 4.4, 8.6, 13.4, 12.7, 21.4, 20.9, 25.5]);
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1]);
    }
  });

  it("refuses a snap that would collapse a shot below a readable length", () => {
    const s = spec();
    // s04 runs 13 to 15. Pulling its start to 14.9 would leave 0.1s.
    const { boundaries } = snapSceneBoundaries(s, [14.9]);
    const s04Length = boundaries[4] - boundaries[3];
    expect(s04Length).toBeGreaterThanOrEqual(1.2);
  });

  it("is a no-op with no anchors, rather than throwing", () => {
    const s = spec();
    const { boundaries, moved } = snapSceneBoundaries(s, []);
    expect(moved).toBe(0);
    expect(boundaries).toEqual([0, ...s.scenes.map((x) => x.end_s)]);
  });

  it("quantizes the moved boundary to a frame", () => {
    const s = spec();
    const { boundaries } = snapSceneBoundaries(s, [9.123456]);
    const q = boundaries[2] * OUTPUT.fps;
    expect(Math.abs(q - Math.round(q))).toBeLessThan(1e-4);
  });

  it("brings a real-Director timeline onto the grid", () => {
    // The regression: a language-model Director picks its own scene times, which
    // do not fall on the bar grid. Before snapping these sat ~0.6s off.
    const s = spec();
    s.scenes = [
      scene({ id: "s01", start_s: 0, end_s: 4.37, purpose: "recognition", transition_in: "cut" }),
      scene({ id: "s02", start_s: 4.37, end_s: 9.81 }),
      scene({ id: "s03", start_s: 9.81, end_s: 14.62, purpose: "motion_begins" }),
      scene({ id: "s04", start_s: 14.62, end_s: 21.09, purpose: "hero_drop" }),
      scene({ id: "s05", start_s: 21.09, end_s: 25.44, purpose: "variation" }),
      scene({ id: "s06", start_s: 25.44, end_s: 30, purpose: "resolution" }),
    ];
    // A dense bar grid at 118 BPM: a beat every ~0.508s.
    const grid = Array.from({ length: 60 }, (_, i) => Number((i * 0.5085).toFixed(4)));
    const { boundaries, moved } = snapSceneBoundaries(s, grid);

    const errors = boundaries
      .slice(1, -1)
      .map((b) => Math.min(...grid.map((g) => Math.abs(g - b))));
    expect(moved).toBeGreaterThan(0);
    for (const e of errors) expect(e).toBeLessThan(0.02);
  });
});

// ── anchor selection ─────────────────────────────────────────────────────────

describe("cuttableAnchors", () => {
  const anchors: MusicAnchor[] = [
    { t: 1.0, kind: "onset", strength: 0.2 },
    { t: 2.0, kind: "downbeat", strength: 0.4 },
    { t: 3.0, kind: "onset", strength: 0.9 },
    { t: 4.0, kind: "accent", strength: 0.8 },
    { t: 5.0, kind: "drop", strength: 1 },
    { t: 6.0, kind: "peak", strength: 1 },
    { t: 7.0, kind: "section", strength: 0.5 },
  ];

  it("keeps structurally strong instants and drops weak incidental onsets", () => {
    // Cutting onto something the listener does not hear as a beat reads as
    // arbitrary, which is worse than not moving the cut at all.
    const out = cuttableAnchors({ anchors });
    expect(out).toContain(2.0); // downbeat regardless of strength
    expect(out).toContain(4.0);
    expect(out).toContain(5.0);
    expect(out).toContain(6.0);
    expect(out).toContain(7.0);
    expect(out).toContain(3.0); // a strong onset still qualifies
    expect(out).not.toContain(1.0); // weak onset dropped
  });

  it("returns a sorted list, and nothing at all for a missing map", () => {
    const out = cuttableAnchors({ anchors });
    expect([...out].sort((a, b) => a - b)).toEqual(out);
    expect(cuttableAnchors(null)).toEqual([]);
  });
});

// ── manifest ─────────────────────────────────────────────────────────────────

describe("buildManifest", () => {
  const recon: Reconciliation = {
    matches: [],
    unmatched: ["drop"],
    snappedEvents: [
      { t: 0, kind: "intro", intensity: 0.2, snapped: false },
      { t: 15.2, kind: "drop", intensity: 1, snapped: true },
    ],
    maxDeltaS: 0.2,
  };

  it("covers every scene and butts each clip against the previous one", () => {
    const s = spec();
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 3,
      clips: clipsFor(s),
      audio,
      reconciliation: null,
    });
    expect(m.clips).toHaveLength(s.scenes.length);
    expect(validateManifest(m)).toEqual([]);
    for (let i = 1; i < m.clips.length; i++) {
      expect(m.clips[i].startS).toBeCloseTo(m.clips[i - 1].endS, 3);
    }
  });

  it("opens on a hard cut, because there is nothing to dissolve from", () => {
    const s = spec();
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips: clipsFor(s),
      audio,
      reconciliation: null,
    });
    expect(m.clips[0].transitionIn).toBe("cut");
    expect(m.clips[0].transitionDurationS).toBe(0);
  });

  it("prefers the dense measured anchors over the sparse reconciled events", () => {
    // The bug this guards: snapping to ~8 events moved 1 cut in 6, because most
    // boundaries had no event within tolerance.
    const s = spec();
    const dense = Array.from({ length: 60 }, (_, i) => Number((i * 0.5085).toFixed(4)));
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips: clipsFor(s),
      audio,
      reconciliation: recon,
      cutAnchorsS: dense,
    });
    expect(m.anchorsS).toEqual(dense);
    const cuts = m.clips.slice(1).map((c) => c.startS);
    for (const c of cuts) {
      expect(Math.min(...dense.map((a) => Math.abs(a - c)))).toBeLessThan(0.05);
    }
  });

  it("adds a deterministic impact where the score lacked a requested beat", () => {
    const s = spec();
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips: clipsFor(s),
      audio,
      reconciliation: recon,
    });
    // The drop was unmatched, so the mix supplies one rather than regenerating.
    expect(m.audio.accents.some((a) => a.kind === "impact")).toBe(true);
    expect(m.audio.accents.some((a) => a.kind === "riser")).toBe(true);
    for (const a of m.audio.accents) {
      expect(a.atS).toBeGreaterThanOrEqual(0);
      expect(a.atS).toBeLessThanOrEqual(s.duration_s);
      expect(a.gainDb).toBeLessThan(0);
    }
  });

  it("fills a missing scene with a colour rather than leaving a hole", () => {
    const s = spec();
    const partial = clipsFor(s).filter((c) => c.scene.id !== "s03");
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips: partial,
      audio,
      reconciliation: null,
    });
    const gap = m.clips.find((c) => c.sceneId === "s03");
    expect(gap?.source.kind).toBe("color");
    expect(gap?.fromFallback).toBe(true);
    // The timeline is still complete, so the reel still exports.
    expect(m.clips).toHaveLength(s.scenes.length);
  });

  it("records the content hash of every input, so a render is auditable", () => {
    const s = spec();
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips: clipsFor(s),
      audio,
      reconciliation: null,
    });
    expect(m.inputHashes.audio).toBe("audio-hash");
    for (const sc of s.scenes) expect(m.inputHashes[sc.id]).toBe(`hash-${sc.id}`);
    expect(m.templateVersions.bundle).toBeTypeOf("string");
    expect(m.templateVersions.cutsSnapped).toBeTypeOf("number");
  });

  it("targets the configured output format", () => {
    const s = spec();
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips: clipsFor(s),
      audio,
      reconciliation: null,
    });
    expect(m.width).toBe(OUTPUT.width);
    expect(m.height).toBe(OUTPUT.height);
    expect(m.fps).toBe(OUTPUT.fps);
  });
});

describe("validateManifest", () => {
  it("flags a clip whose source is too short for its window", () => {
    const s = spec();
    const clips = clipsFor(s);
    clips[2].sourceDurationS = 0.5;
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips,
      audio,
      reconciliation: null,
    });
    expect(validateManifest(m).some((i) => /needs/.test(i))).toBe(true);
  });

  it("flags a missing soundtrack", () => {
    const s = spec();
    const m = buildManifest({
      projectId: "prj_test",
      spec: s,
      specVersion: 1,
      clips: clipsFor(s),
      audio: { ...audio, path: "" },
      reconciliation: null,
    });
    expect(validateManifest(m)).toContain("manifest has no audio");
  });
});

// ── effects and overlays follow the snapped window ───────────────────────────

describe("effectsFor", () => {
  it("times a beat pulse from the window start, not from the planned start", () => {
    const s = spec();
    const hero = s.scenes[4]; // planned 15 to 21, drop event at 15.0
    // Snapping moved this shot 400ms earlier, so the drop now sits 400ms into it.
    const effects = effectsFor({
      spec: s,
      scene: hero,
      windowS: [14.6, 20.6],
      isStill: true,
      needsPainterly: false,
    });
    const pulse = effects.find((e) => e.kind === "beatPulse");
    expect(pulse).toBeDefined();
    if (pulse && pulse.kind === "beatPulse") {
      expect(pulse.atS).toBeCloseTo(0.4, 2);
    }
  });

  it("drops an event that snapping moved outside the window", () => {
    // A pulse at a negative offset would fire on the wrong frame, so the event is
    // simply not this clip's any more.
    const s = spec();
    const effects = effectsFor({
      spec: s,
      scene: s.scenes[4],
      windowS: [15.5, 21.5],
      isStill: true,
      needsPainterly: false,
    });
    for (const e of effects) {
      if (e.kind === "beatPulse" || e.kind === "blurBurst") {
        expect(e.atS).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("moves a still more than generated video, which already moves", () => {
    const s = spec();
    const still = effectsFor({ spec: s, scene: s.scenes[4], windowS: [15, 21], isStill: true, needsPainterly: false });
    const video = effectsFor({ spec: s, scene: s.scenes[4], windowS: [15, 21], isStill: false, needsPainterly: false });
    const amount = (list: ReturnType<typeof effectsFor>) => {
      const cam = list.find((e) => e.kind === "camera");
      return cam && cam.kind === "camera" ? cam.amount : 0;
    };
    expect(amount(still)).toBeGreaterThan(amount(video));
  });

  it("always vignettes, and breathes only on a short shot", () => {
    const s = spec();
    const short = effectsFor({ spec: s, scene: s.scenes[3], windowS: [13, 15], isStill: true, needsPainterly: false });
    const long = effectsFor({ spec: s, scene: s.scenes[4], windowS: [15, 21], isStill: true, needsPainterly: false });
    expect(short.some((e) => e.kind === "vignette")).toBe(true);
    expect(short.some((e) => e.kind === "breathe")).toBe(true);
    expect(long.some((e) => e.kind === "breathe")).toBe(false);
  });
});

describe("overlaysFor", () => {
  it("lands the title on the final hit, inside the closing window", () => {
    const s = spec();
    const last = s.scenes[6]; // 25 to 30, final hit at 29
    const overlays = overlaysFor({
      spec: s,
      scene: last,
      windowS: [25, 30],
      isLast: true,
      swatches: ["#E8A44C"],
    });
    const title = overlays.find((o) => o.kind === "title");
    expect(title).toBeDefined();
    for (const o of overlays) {
      expect(o.atS + o.durationS).toBeLessThanOrEqual(5.001);
    }
    if (title) {
      const absolute = 25 + title.atS;
      expect(absolute).toBeGreaterThan(28);
      expect(absolute).toBeLessThan(30);
      // A title must never outlast the clip it is drawn on.
      expect(title.atS + title.durationS).toBeLessThanOrEqual(5.001);
    }
  });

  it("draws nothing on a scene that is not the last", () => {
    const s = spec();
    expect(
      overlaysFor({ spec: s, scene: s.scenes[2], windowS: [9, 13], isLast: false, swatches: [] }),
    ).toHaveLength(0);
  });
});

describe("beat choreography", () => {
  // A dense measured beat map, roughly 118 BPM.
  const beats = Array.from({ length: 60 }, (_, i) => round(i * 0.508, 3));

  const pulsesIn = (windowS: [number, number]) =>
    effectsFor({
      spec: spec(),
      scene: scene({ id: "sx", start_s: windowS[0], end_s: windowS[1] }),
      windowS,
      isStill: false,
      needsPainterly: false,
      beatsS: beats,
    }).filter((e) => e.kind === "beatPulse");

  it("leaves the quiet opening alone", () => {
    // The build is at 11s in the fixture. Stillness before it is what earns the climax;
    // a reel that pulses from the first frame has nowhere left to go at the drop.
    expect(pulsesIn([0, 4])).toHaveLength(0);
  });

  it("choreographs the stretch that has lifted", () => {
    expect(pulsesIn([15, 21]).length).toBeGreaterThan(0);
  });

  it("does not fire on every accent", () => {
    // Six seconds at 118 BPM holds about twelve accents. Pulsing all of them reads as a
    // rendering fault rather than as editing. Measured as the difference the beat map
    // makes, so the narrative drop pulse — which comes from the plan — is not counted.
    const withBeats = pulsesIn([15, 21]).length;
    const withoutBeats = effectsFor({
      spec: spec(),
      scene: scene({ id: "sx", start_s: 15, end_s: 21 }),
      windowS: [15, 21],
      isStill: false,
      needsPainterly: false,
    }).filter((e) => e.kind === "beatPulse").length;
    expect(withBeats - withoutBeats).toBeGreaterThan(0);
    expect(withBeats - withoutBeats).toBeLessThanOrEqual(4);
  });

  it("adds nothing on top of the cut, where the plan already lands a pulse", () => {
    // The drop is the cut here, and the plan pulses on it. Choreography must not double
    // that, so every accent it adds sits inside the shot.
    const atStart = pulsesIn([15, 21]).filter((e) => e.kind === "beatPulse" && e.atS < 0.15);
    expect(atStart).toHaveLength(1);
  });
  it("does nothing without a measured beat map", () => {
    const none = effectsFor({
      spec: spec(),
      scene: scene({ id: "sx", start_s: 15, end_s: 21 }),
      windowS: [15, 21],
      isStill: false,
      needsPainterly: false,
    }).filter((e) => e.kind === "beatPulse");
    // Only the narrative drop pulse, which comes from the plan rather than the score.
    expect(none.length).toBeLessThanOrEqual(1);
  });
});

describe("audioArc", () => {
  const curve = (fn: (t: number) => number) =>
    Array.from({ length: 60 }, (_, i) => ({ t: i * 0.5, v: fn(i * 0.5) }));

  it("imposes an arc on a score whose level never moves", () => {
    // The score that prompted this measured within 0.6 dB of itself from the first bar to
    // the last: cuts sat exactly on its beats and the film still dragged.
    const arc = audioArc(spec(), curve(() => 0.5));
    expect(arc).not.toBeNull();
    expect(arc?.quietGain).toBeLessThan(1);
    // The lift has to arrive at full where the picture pays off, not after it.
    expect(arc?.liftToS).toBe(15);
    expect(arc?.liftFromS).toBe(11);
  });

  it("leaves a score that already builds alone", () => {
    const arc = audioArc(spec(), curve((t) => (t < 11 ? 0.25 : 0.85)));
    expect(arc).toBeNull();
  });

  it("does nothing without a measured curve", () => {
    expect(audioArc(spec(), undefined)).toBeNull();
    expect(audioArc(spec(), [])).toBeNull();
  });

  it("reaches the manifest only when the score is flat", () => {
    const flat = buildManifest({
      projectId: "prj_arc",
      spec: spec(),
      specVersion: 1,
      clips: clipsFor(spec()),
      audio: { path: "a.mp3", sha256: "s", durationS: 30, fromFallback: false, energy: curve(() => 0.5) },
      reconciliation: null,
    });
    expect(flat.audio.arc).toBeDefined();

    const rising = buildManifest({
      projectId: "prj_arc",
      spec: spec(),
      specVersion: 1,
      clips: clipsFor(spec()),
      audio: {
        path: "a.mp3",
        sha256: "s",
        durationS: 30,
        fromFallback: false,
        energy: curve((t) => (t < 11 ? 0.25 : 0.85)),
      },
      reconciliation: null,
    });
    expect(rising.audio.arc).toBeUndefined();
  });
});
