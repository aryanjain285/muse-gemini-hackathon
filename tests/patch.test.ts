/**
 * Live-direction tests.
 *
 * The safety property is that a patch is *bounded*: it cannot rewrite the plan, and
 * it must report its true blast radius before anything is committed. These tests
 * assert both, plus the two regressions that made targeted instructions behave like
 * reckless ones — a global style change riding along with a named scene, and
 * continuity invalidation cascading to the end of the reel.
 */
import { describe, expect, it } from "vitest";
import {
  PatchOpSchema,
  PatchRequestSchema,
  applyPatch,
  describeImpact,
  isTooBroad,
  type PatchRequest,
} from "@/lib/spec/patch";
import { normalize, type DirectorSpec, type Scene } from "@/lib/spec/directorSpec";
import { decodePatchResponse } from "@/lib/templates/prompts";

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
    music: {
      mode: "generated",
      bpm_target: 118,
      mood: "nostalgic",
      instrumentation: [],
      key: "A minor",
    },
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
      scene({ id: "s04", start_s: 13, end_s: 15, purpose: "build" }),
      scene({ id: "s05", start_s: 15, end_s: 21, purpose: "hero_drop" }),
      scene({ id: "s06", start_s: 21, end_s: 25, purpose: "variation" }),
      scene({ id: "s07", start_s: 25, end_s: 30, purpose: "resolution" }),
    ],
  });
}

const req = (ops: PatchRequest["ops"], summary = "a change"): PatchRequest => ({ summary, ops });

// ── the vocabulary is closed ─────────────────────────────────────────────────

describe("patch vocabulary", () => {
  it("cannot express a whole-spec replacement", () => {
    // The guarantee that makes live direction safe: no operation accepts a spec.
    const forbidden = [
      { op: "replace_spec", spec: spec() },
      { op: "set_scenes", scenes: [] },
      { op: "eval", code: "1" },
      { spec: spec() },
    ];
    for (const bad of forbidden) {
      expect(PatchOpSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects an op with an out-of-range value rather than clamping silently", () => {
    expect(PatchOpSchema.safeParse({ op: "style_grain", grain: 4 }).success).toBe(false);
    expect(
      PatchOpSchema.safeParse({ op: "event_intensity", kind: "drop", intensity: 9 }).success,
    ).toBe(false);
    expect(PatchOpSchema.safeParse({ op: "music_energy", delta: 5 }).success).toBe(false);
  });

  it("rejects an unknown camera move or transition", () => {
    expect(
      PatchOpSchema.safeParse({ op: "scene_camera", scene_id: "s01", camera: "barrel_roll" }).success,
    ).toBe(false);
    expect(
      PatchOpSchema.safeParse({ op: "scene_transition", scene_id: "s02", transition: "star_wipe" })
        .success,
    ).toBe(false);
  });

  it("requires a summary and caps the number of operations", () => {
    expect(PatchRequestSchema.safeParse({ ops: [] }).success).toBe(false);
    const many = Array.from({ length: 11 }, () => ({ op: "style_grain" as const, grain: 0.5 }));
    expect(PatchRequestSchema.safeParse({ summary: "x", ops: many }).success).toBe(false);
  });
});

// ── invalidation is proportionate ────────────────────────────────────────────

describe("blast radius", () => {
  it("invalidates only the named scene for an action change", () => {
    const r = applyPatch(spec(), req([{ op: "scene_action", scene_id: "s03", action: "new action" }]));
    expect(r.impact.invalidatedScenes).toEqual(["s03"]);
    expect(r.impact.invalidatesMusic).toBe(false);
  });

  it("invalidates a scene and its direct successor for a setting change", () => {
    // Continuity is one step deep: each scene's prompt carries the previous
    // scene's keyframe. Cascading further would refuse every targeted request.
    const r = applyPatch(
      spec(),
      req([{ op: "scene_setting", scene_id: "s03", setting: "at night" }]),
    );
    expect(r.impact.invalidatedScenes).toEqual(["s03", "s04"]);
  });

  it("does not cascade a setting change to the end of the reel", () => {
    const s = spec();
    const r = applyPatch(s, req([{ op: "scene_setting", scene_id: "s01", setting: "at night" }]));
    expect(r.impact.invalidatedScenes.length).toBeLessThan(s.scenes.length);
    expect(isTooBroad(s, r.impact)).toBe(false);
  });

  it("invalidates every scene for a global style change, and says so", () => {
    const s = spec();
    const r = applyPatch(s, req([{ op: "style_lighting", lighting: "night" }]));
    expect(r.impact.invalidatedScenes).toHaveLength(s.scenes.length);
    expect(isTooBroad(s, r.impact)).toBe(true);
  });

  it("treats grain as a compose-only change, because the composer applies it", () => {
    const r = applyPatch(spec(), req([{ op: "style_grain", grain: 0.8 }]));
    expect(r.impact.invalidatedScenes).toHaveLength(0);
    expect(r.impact.composeOnly).toBe(true);
    expect(describeImpact(r.impact)).toMatch(/recompose only/);
  });

  it("marks the soundtrack stale when the drop's intensity moves", () => {
    const r = applyPatch(spec(), req([{ op: "event_intensity", kind: "drop", intensity: 1 }]));
    expect(r.impact.invalidatesMusic).toBe(true);
  });

  it("describes a mixed impact in plain language", () => {
    const r = applyPatch(
      spec(),
      req([
        { op: "add_motif", scene_ids: ["s05"], motif: "with drifting petals" },
        { op: "music_energy", delta: 0.5 },
      ]),
    );
    const text = describeImpact(r.impact);
    expect(text).toContain("s05");
    expect(text).toContain("soundtrack");
  });
});

// ── individual rejection ─────────────────────────────────────────────────────

describe("partial acceptance", () => {
  it("rejects one bad clause and keeps the rest of the instruction", () => {
    const r = applyPatch(
      spec(),
      req([
        { op: "scene_action", scene_id: "s99", action: "impossible" },
        { op: "scene_action", scene_id: "s02", action: "possible" },
      ]),
    );
    expect(r.applied).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/no scene s99/);
    expect(r.spec.scenes[1].action).toBe("possible");
  });

  it("refuses a transition into the opening scene, which has nothing to enter from", () => {
    const r = applyPatch(
      spec(),
      req([{ op: "scene_transition", scene_id: "s01", transition: "film_burn" }]),
    );
    expect(r.applied).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/nothing to transition from/);
    expect(r.spec.scenes[0].transition_in).toBe("cut");
  });

  it("refuses a motif aimed at scenes that do not exist", () => {
    const r = applyPatch(spec(), req([{ op: "add_motif", scene_ids: ["s88"], motif: "petals" }]));
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
  });

  it("refuses an intensity change for an event kind not on the timeline", () => {
    const r = applyPatch(spec(), req([{ op: "event_intensity", kind: "variation", intensity: 1 }]));
    expect(r.rejected[0].reason).toMatch(/no variation event/);
  });
});

// ── the spec stays valid ─────────────────────────────────────────────────────

describe("the result is always renderable", () => {
  it("keeps the timeline contiguous after any patch", () => {
    const patches: PatchRequest[] = [
      req([{ op: "scene_action", scene_id: "s02", action: "x" }]),
      req([{ op: "scene_setting", scene_id: "s05", setting: "y" }]),
      req([{ op: "style_palette", palette: ["deep blue", "ember"] }]),
      req([{ op: "attach_secondary", scene_ids: ["s06"] }]),
      req([{ op: "scene_render_mode", scene_id: "s05", render_mode: "source_motion" }]),
      req([{ op: "music_energy", delta: -1 }]),
    ];
    for (const p of patches) {
      const out = applyPatch(spec(), p).spec;
      expect(out.scenes[0].start_s).toBe(0);
      for (let i = 1; i < out.scenes.length; i++) {
        expect(out.scenes[i].start_s).toBeCloseTo(out.scenes[i - 1].end_s, 3);
      }
      expect(out.scenes.filter((s) => s.purpose === "hero_drop")).toHaveLength(1);
      expect(out.duration_s).toBeCloseTo(30, 2);
    }
  });

  it("keeps bpm inside a musical range however hard energy is pushed", () => {
    for (const delta of [-1, -0.5, 0.5, 1]) {
      const out = applyPatch(spec(), req([{ op: "music_energy", delta }])).spec;
      expect(out.music.bpm_target).toBeGreaterThanOrEqual(60);
      expect(out.music.bpm_target).toBeLessThanOrEqual(190);
    }
  });

  it("does not mutate the spec it was given", () => {
    const original = spec();
    const snapshot = JSON.stringify(original);
    applyPatch(original, req([{ op: "scene_action", scene_id: "s01", action: "changed" }]));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("attaches the secondary subject once, however often it is asked", () => {
    let s = spec();
    for (let i = 0; i < 3; i++) {
      s = applyPatch(s, req([{ op: "attach_secondary", scene_ids: ["s06"] }])).spec;
    }
    const target = s.scenes.find((x) => x.id === "s06");
    expect(target?.reference_asset_ids.filter((r) => r === "subject_secondary")).toHaveLength(1);
  });
});

// ── over-broad detection ─────────────────────────────────────────────────────

describe("isTooBroad", () => {
  it("does not fire on a short reel, where touching most scenes is normal", () => {
    const s = spec();
    s.scenes = s.scenes.slice(0, 3);
    expect(isTooBroad(s, { invalidatedScenes: ["s01", "s02", "s03"], invalidatesMusic: false, composeOnly: false, changed: true })).toBe(false);
  });

  it("fires when nearly every scene of a full reel is affected", () => {
    const s = spec();
    expect(
      isTooBroad(s, {
        invalidatedScenes: s.scenes.map((x) => x.id),
        invalidatesMusic: false,
        composeOnly: false,
        changed: true,
      }),
    ).toBe(true);
  });

  it("does not fire on a two-scene change", () => {
    expect(
      isTooBroad(spec(), {
        invalidatedScenes: ["s03", "s04"],
        invalidatesMusic: false,
        composeOnly: false,
        changed: true,
      }),
    ).toBe(false);
  });
});

// ── the wire dialect ─────────────────────────────────────────────────────────

/**
 * A Director is asked for one flat operation shape with named slots, because that
 * is what a model fills in reliably; the spec module takes a discriminated union,
 * because that is what makes an illegal patch unrepresentable. The two shapes are
 * incompatible on purpose, so the seam between them is what these cover — without
 * it every model-produced note is silently refused and only the local keyword
 * interpreter ever works.
 */
describe("decodePatchResponse", () => {
  it("turns a reply into operations the spec module applies", () => {
    const base = spec();
    const target = base.scenes[1].id;
    const { request } = decodePatchResponse(
      {
        intent: "put scene two at night",
        affected_scene_ids: [target],
        operations: [{ op: "set_scene_setting", scene_id: target, value: "a harbour at night" }],
      },
      base,
    );
    expect(request).not.toBeNull();
    expect(PatchRequestSchema.safeParse(request).success).toBe(true);
    expect(request?.ops).toEqual([
      { op: "scene_setting", scene_id: target, setting: "a harbour at night" },
    ]);
    expect(applyPatch(base, request as PatchRequest).applied).toHaveLength(1);
  });

  it("resolves an intensity nudge against the level the spec is holding", () => {
    const base = spec();
    const drop = base.events.find((e) => e.kind === "drop");
    if (!drop) throw new Error("fixture has no drop");
    const { request } = decodePatchResponse(
      {
        intent: "make the drop harder",
        affected_scene_ids: [base.scenes[0].id],
        operations: [{ op: "shift_event_intensity", event_kind: "drop", intensity_delta: 0.2 }],
      },
      base,
    );
    // A delta only means something next to the current level, which is why this
    // is a decode against the spec rather than a rename of fields.
    expect(request?.ops[0]).toEqual({
      op: "event_intensity",
      kind: "drop",
      intensity: Math.min(1, drop.intensity + 0.2),
    });
  });

  it("reframes one shot without touching the rest", () => {
    const base = spec();
    const target = base.scenes[2].id;
    const { request } = decodePatchResponse(
      {
        intent: "get closer on scene three",
        affected_scene_ids: [target],
        operations: [{ op: "set_scene_shot_size", scene_id: target, shot_size: "close" }],
      },
      base,
    );
    const result = applyPatch(base, request as PatchRequest);
    expect(result.rejected).toEqual([]);
    expect(result.spec.scenes[2].shot_size).toBe("close");
    expect(result.impact.invalidatedScenes).toEqual([target]);
  });

  it("drops what it does not recognise instead of guessing", () => {
    const base = spec();
    const { request } = decodePatchResponse(
      {
        intent: "do something impossible",
        affected_scene_ids: ["s01"],
        operations: [
          { op: "set_scene_duration", scene_id: "s01", value: "10" },
          { op: "set_scene_setting", scene_id: "s99", value: "nowhere" },
          { op: "set_scene_camera", scene_id: "s01", camera: "barrel_roll" },
        ],
      },
      base,
    );
    expect(request).toBeNull();
  });

  it("passes on the reason when a note cannot be expressed at all", () => {
    const out = decodePatchResponse(
      { intent: "", affected_scene_ids: [], operations: [], unsupported: "that would need a new scene" },
      spec(),
    );
    expect(out.request).toBeNull();
    expect(out.unsupported).toBe("that would need a new scene");
  });

  it("survives a reply that is not the shape it asked for", () => {
    for (const raw of [null, "text", 42, {}, { operations: "no" }]) {
      expect(decodePatchResponse(raw, spec()).request).toBeNull();
    }
  });
});

// ── a change that changes nothing ────────────────────────────────────────────

describe("a patch that leaves the plan as it was", () => {
  it("reports that nothing changed, rather than success", () => {
    // Asked to widen one scene, the revise path answered `applied: true`, wrote a new spec
    // version, and left the plan byte-for-byte identical — twice. An operation had been
    // accepted, so `applied` was non-empty and every downstream check read as healthy.
    // Nothing compared the result with the input.
    const s = spec();
    const size = s.scenes[2].shot_size;
    const out = applyPatch(s, {
      summary: "set s03 to the size it already is",
      ops: [{ op: "scene_shot_size", scene_id: s.scenes[2].id, shot_size: size }],
    } as never);
    expect(out.impact.changed).toBe(false);
    expect(describeImpact(out.impact)).toBe("nothing changed");
  });

  it("reports a real change as changed", () => {
    const s = spec();
    const out = applyPatch(s, {
      summary: "widen s03",
      ops: [{ op: "scene_shot_size", scene_id: s.scenes[2].id, shot_size: "wide" }],
    } as never);
    expect(out.impact.changed).toBe(true);
  });
});
