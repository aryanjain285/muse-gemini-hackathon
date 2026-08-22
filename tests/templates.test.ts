/**
 * Template subsystem tests.
 *
 * Two things are being defended here. First, that every preset's beat skeleton is
 * already a legal DirectorSpec timeline, because a preset that cannot pass
 * validation cannot be a fallback. Second, that the prompts carry the elements
 * that made the reference keyframe work, in the order that made it work, and stay
 * short enough not to dilute the image model.
 */
import { describe, expect, it } from "vitest";
import { BUNDLES, DEFAULT_BUNDLE_ID, getBundle, listBundles } from "@/lib/templates/bundles";
import { GRADE_BOUNDS, bundleVersionString, type TemplateBundle } from "@/lib/templates/types";
import {
  CRITIC_SCORE_KEYS,
  KEYFRAME_PROMPT_BUDGET,
  NEGATIVE_PREFIX,
  PATCH_OPERATIONS,
  criticPrompt,
  directorPrompt,
  keyframePrompt,
  motionPrompt,
  negativeClause,
  patchPrompt,
  visionPrompt,
} from "@/lib/templates/prompts";
import {
  CAMERA_MOVES,
  SHOT_SIZES,
  TRANSITIONS,
  parseSpec,
  type CameraMove,
  type DirectorSpec,
  type ShotSize,
  type Transition,
} from "@/lib/spec/directorSpec";
import { LIMITS, OUTPUT } from "@/lib/core/config";

// ── fixtures ─────────────────────────────────────────────────────────────────

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Actions written the way the Director is told to write them: one moment each. */
const ACTIONS = [
  "she stands still at the window and lets the light find her face",
  "she steps out onto the rooftop and the whole valley opens under her",
  "the wind lifts her hair as she turns her head toward the sun",
  "she closes her eyes one beat before the light breaks",
  "she throws both arms wide as the sun flares behind her",
  "she laughs and the loose pages around her lift off the gravel",
  "she sits down on the parapet and the city goes quiet",
];

const CONTINUITY = {
  subject: "a young woman with shoulder-length dark brown hair and a straight nose",
  wardrobe: "an olive field jacket over a black sweater and dark trousers",
  previousSetting: "the stairwell landing one floor below",
  entryState: "she is already mid-turn toward the light",
};

function rawSpecFor(bundle: TemplateBundle): unknown {
  return {
    spec_version: "1.0",
    title: bundle.label,
    logline: "One afternoon, remembered warmer than it happened.",
    duration_s: OUTPUT.durationS,
    aspect_ratio: "9:16",
    style_bible: bundle.styleBible,
    music: {
      mode: "generated",
      bpm_target: bundle.music.bpm,
      mood: bundle.music.mood,
      instrumentation: bundle.music.instrumentation,
      key: bundle.music.key,
    },
    events: [
      { t: 0, kind: "intro", visual: "the first frame settles", intensity: 0.2 },
      { t: 12, kind: "build", visual: "brightness climbs", intensity: 0.6 },
      { t: 15, kind: "drop", visual: "the widest, warmest frame lands", intensity: 0.95 },
      { t: 25, kind: "resolve", visual: "the light cools", intensity: 0.5 },
      { t: 29, kind: "final_hit", visual: "one last accent", intensity: 0.8 },
    ],
    scenes: bundle.beats.map((b, i) => ({
      id: `s${String(i + 1).padStart(2, "0")}`,
      start_s: b.atS,
      end_s: b.endS,
      purpose: b.purpose,
      render_mode: b.renderMode,
      reference_asset_ids: [],
      camera: b.camera,
      camera_note: "keep the horizon level",
      action: ACTIONS[i % ACTIONS.length],
      setting: "a flat gravel rooftop above a valley of terracotta rooftops",
      transition_in: b.transitionIn,
      retry_budget: b.purpose === "hero_drop" ? 2 : 1,
    })),
  };
}

function specFor(bundle: TemplateBundle): DirectorSpec {
  const parsed = parseSpec(rawSpecFor(bundle));
  if (!parsed.spec) throw new Error(`fixture spec for ${bundle.id} did not parse`);
  return parsed.spec;
}

/** Minimal view of the Gemini structured-output dialect, for schema assertions. */
interface SchemaNode {
  type?: string;
  enum?: readonly string[];
  required?: readonly string[];
  propertyOrdering?: readonly string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

function walk(node: SchemaNode, visit: (n: SchemaNode, path: string) => void, path = "$"): void {
  visit(node, path);
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) walk(v, visit, `${path}.${k}`);
  }
  if (node.items) walk(node.items, visit, `${path}[]`);
}

const bundles = listBundles();

// ── bundles ──────────────────────────────────────────────────────────────────

describe("bundles", () => {
  it("ships four presets with the default first", () => {
    expect(Object.keys(BUNDLES)).toHaveLength(4);
    expect(bundles).toHaveLength(4);
    expect(bundles[0].id).toBe(DEFAULT_BUNDLE_ID);
    expect(new Set(bundles.map((b) => b.id)).size).toBe(4);
  });

  for (const bundle of bundles) {
    describe(bundle.id, () => {
      it("has 5 to 7 beats covering 0 to 30s contiguously", () => {
        expect(bundle.beats.length).toBeGreaterThanOrEqual(LIMITS.minScenes);
        expect(bundle.beats.length).toBeLessThanOrEqual(LIMITS.maxScenes);
        expect(bundle.beats[0].atS).toBe(0);
        for (let i = 1; i < bundle.beats.length; i++) {
          expect(bundle.beats[i].atS).toBeCloseTo(bundle.beats[i - 1].endS, 6);
        }
        expect(bundle.beats[bundle.beats.length - 1].endS).toBe(OUTPUT.durationS);
        // No gaps, no overlaps: the beat lengths must sum to the whole reel.
        const total = bundle.beats.reduce((a, b) => a + (b.endS - b.atS), 0);
        expect(total).toBeCloseTo(OUTPUT.durationS, 6);
      });

      it("keeps every beat long enough to read and short enough to hold", () => {
        for (const b of bundle.beats) {
          const d = b.endS - b.atS;
          expect(d).toBeGreaterThanOrEqual(1.2);
          expect(d).toBeLessThanOrEqual(9);
        }
      });

      it("has exactly one hero_drop, near 15s", () => {
        const heroes = bundle.beats.filter((b) => b.purpose === "hero_drop");
        expect(heroes).toHaveLength(1);
        expect(Math.abs(heroes[0].atS - 15)).toBeLessThanOrEqual(1);
        // The payoff is never the shortest thing on the timeline.
        const longest = Math.max(...bundle.beats.map((b) => b.endS - b.atS));
        expect(heroes[0].endS - heroes[0].atS).toBeGreaterThanOrEqual(longest * 0.75);
      });

      it("only uses approved cameras and its own transition vocabulary", () => {
        for (const b of bundle.beats) {
          expect(CAMERA_MOVES).toContain(b.camera);
          expect(TRANSITIONS).toContain(b.transitionIn);
          expect(bundle.transitions).toContain(b.transitionIn);
        }
        expect(bundle.transitions.length).toBeGreaterThanOrEqual(4);
        expect(new Set(bundle.transitions).size).toBe(bundle.transitions.length);
      });

      it("has valid hex swatches and an in-range grade", () => {
        expect(bundle.swatches.length).toBeGreaterThanOrEqual(4);
        for (const s of bundle.swatches) expect(s).toMatch(HEX);
        expect(new Set(bundle.swatches).size).toBe(bundle.swatches.length);
        for (const v of Object.values(bundle.grade)) {
          expect(v).toBeGreaterThanOrEqual(GRADE_BOUNDS.min);
          expect(v).toBeLessThanOrEqual(GRADE_BOUNDS.max);
        }
      });

      it("declares a complete style bible and music brief", () => {
        const sb = bundle.styleBible;
        expect(sb.preset).toBe(bundle.id);
        expect(sb.palette.length).toBeGreaterThanOrEqual(2);
        expect(sb.palette.length).toBeLessThanOrEqual(6);
        expect(sb.character_rules.length).toBeGreaterThanOrEqual(2);
        expect(sb.negative_rules.length).toBeGreaterThanOrEqual(3);
        expect(sb.medium.length).toBeGreaterThan(30);
        expect(sb.grain).toBeGreaterThanOrEqual(0);
        expect(sb.grain).toBeLessThanOrEqual(1);
        expect(bundle.music.bpm).toBeGreaterThanOrEqual(60);
        expect(bundle.music.bpm).toBeLessThanOrEqual(190);
        expect(bundle.music.instrumentation.length).toBeGreaterThanOrEqual(4);
        expect(bundle.music.notes.length).toBeGreaterThan(80);
      });

      it("produces a spec that validates with no issues at all", () => {
        const parsed = parseSpec(rawSpecFor(bundle));
        expect(parsed.issues).toEqual([]);
        expect(parsed.ok).toBe(true);
        expect(parsed.spec?.scenes.map((s) => s.id)).toEqual(
          bundle.beats.map((_, i) => `s${String(i + 1).padStart(2, "0")}`),
        );
      });
    });
  }

  it("makes four different films, not one recoloured four ways", () => {
    const mediums = new Set(bundles.map((b) => b.styleBible.medium));
    expect(mediums.size).toBe(4);

    // Transition and camera vocabularies differ, not just the palette.
    const transitionSigs = new Set(bundles.map((b) => b.transitions.join("|")));
    expect(transitionSigs.size).toBe(4);
    const leadTransitions = new Set(bundles.map((b) => b.transitions[0]));
    expect(leadTransitions.size).toBe(4);
    const cameraSigs = new Set(
      bundles.map((b) => [...new Set(b.beats.map((x) => x.camera))].sort().join("|")),
    );
    expect(cameraSigs.size).toBe(4);

    // Beat structure differs too.
    expect(new Set(bundles.map((b) => b.beats.length)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(bundles.map((b) => b.music.bpm)).size).toBe(4);

    // No swatch is shared between two presets.
    const swatches = bundles.flatMap((b) => b.swatches.map((s) => s.toLowerCase()));
    expect(new Set(swatches).size).toBe(swatches.length);
  });

  it("falls back to the default for an unknown id instead of throwing", () => {
    expect(() => getBundle("nonsense")).not.toThrow();
    expect(getBundle("nonsense")).toBe(BUNDLES[DEFAULT_BUNDLE_ID]);
    expect(getBundle("")).toBe(BUNDLES[DEFAULT_BUNDLE_ID]);
    expect(getBundle("neon_anime").id).toBe("neon_anime");
  });

  it("has a stable, unique, filesystem-safe version string", () => {
    const strings = bundles.map(bundleVersionString);
    expect(new Set(strings).size).toBe(4);
    for (const s of strings) expect(s).toMatch(/^[a-z0-9_.]+$/);
    expect(bundleVersionString(getBundle(DEFAULT_BUNDLE_ID))).toBe(
      "dreamy_animated_memories.d1.s1.k1.c1.t1.m1",
    );
    // Same input, same output: this string is a cache key.
    expect(bundleVersionString(bundles[1])).toBe(bundleVersionString(bundles[1]));
  });
});

// ── negative clause ──────────────────────────────────────────────────────────

describe("negativeClause", () => {
  const bundle = getBundle(DEFAULT_BUNDLE_ID);

  it("carries the universal and preset constraints, terse and deduped", () => {
    const clause = negativeClause(bundle);
    expect(clause.startsWith(NEGATIVE_PREFIX)).toBe(true);
    expect(clause.endsWith(".")).toBe(true);
    expect(clause).toContain("no text, lettering, captions or watermark");
    for (const rule of bundle.styleBible.negative_rules) expect(clause).toContain(rule);
  });

  it("normalises and deduplicates extra rules", () => {
    const clause = negativeClause(bundle, [
      "no photographic realism", // already present via the preset
      "Blurry hands.",
      "HDR glow",
    ]);
    expect(clause.match(/no photographic realism/g)).toHaveLength(1);
    expect(clause).toContain("no blurry hands");
    expect(clause).toContain("no HDR glow");
  });
});

// ── keyframe prompt ──────────────────────────────────────────────────────────

describe("keyframePrompt", () => {
  const bundle = getBundle(DEFAULT_BUNDLE_ID);
  const spec = specFor(bundle);
  const hero = spec.scenes.find((s) => s.purpose === "hero_drop");
  if (!hero) throw new Error("fixture has no hero scene");

  const prompt = keyframePrompt({
    bundle,
    spec,
    scene: hero,
    continuity: CONTINUITY,
    hasSubjectReference: false,
  });

  it("names the medium, the palette and the lighting", () => {
    expect(prompt).toContain(bundle.styleBible.medium.split(",")[0]);
    for (const phrase of bundle.styleBible.palette.slice(0, 4)) {
      expect(prompt).toContain(phrase);
    }
    expect(prompt.toLowerCase()).toContain(bundle.styleBible.lighting.toLowerCase().slice(0, 30));
  });

  it("states vertical framing and subject placement explicitly", () => {
    expect(prompt).toContain("9:16");
    expect(prompt).toContain("clearance above the head and below the feet");
    expect(prompt).toContain("filling the whole of a vertical 9:16 frame edge to edge");
  });

  it("places the subject differently at each shot size", () => {
    const placementOf = (shot_size: ShotSize) =>
      keyframePrompt({
        bundle,
        spec,
        scene: { ...hero, shot_size },
        continuity: CONTINUITY,
        hasSubjectReference: false,
      })
        .split(/\r?\n/)
        .find((l) => l.includes("9:16 frame") && !l.includes("edge to edge")) ?? "";

    const placements = SHOT_SIZES.map(placementOf);
    // One shared placement sentence overrides the size in front of it, and every
    // shot comes back framed the same way however the sizes were varied.
    expect(new Set(placements).size).toBe(SHOT_SIZES.length);
    expect(placementOf("wide")).toContain("small and low");
    expect(placementOf("extreme_close")).toContain("full width");
  });

  it("puts nobody in a detail shot", () => {
    const p = keyframePrompt({
      bundle,
      spec,
      scene: { ...hero, shot_size: "detail" },
      continuity: CONTINUITY,
      hasSubjectReference: true,
    });
    expect(p).toContain("no person in frame");
    expect(p).not.toContain("The subject is");
    expect(p).not.toContain("Match the person in the attached reference image");
  });

  it("appends the negative clause and keeps those words out of the rest", () => {
    const at = prompt.indexOf(NEGATIVE_PREFIX);
    expect(at).toBeGreaterThan(0);
    const head = prompt.slice(0, at);
    const clause = prompt.slice(at);
    expect(head).not.toMatch(/\btext\b/i);
    expect(head).not.toMatch(/\bwatermark\b/i);
    expect(clause).toMatch(/\btext\b/);
    expect(clause).toMatch(/\bwatermark\b/);
    expect(clause).toBe(negativeClause(bundle, spec.style_bible.negative_rules));
  });

  it("orders the elements the way the reference frame was written", () => {
    const order = [
      bundle.styleBible.medium.split(",")[0], // medium
      "The subject is", // subject and identity
      "one single moment", // action
      "The setting is", // setting
      "clearance above the head", // shot size and placement
      "halation", // lighting
      "Palette:", // named palette
      NEGATIVE_PREFIX, // negatives, last
    ].map((needle) => prompt.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  it("asks for one thing and never for words in the image", () => {
    const head = prompt.slice(0, prompt.indexOf(NEGATIVE_PREFIX));
    expect(prompt).toContain("one single moment, not a sequence");
    expect(head).not.toMatch(/\btitle\b/i);
    expect(head).not.toMatch(/\bcaption/i);
    expect(head).not.toMatch(/\bletter/i);
  });

  it("switches identity language when a reference image is attached", () => {
    const withRef = keyframePrompt({
      bundle,
      spec,
      scene: hero,
      continuity: CONTINUITY,
      hasSubjectReference: true,
    });
    expect(withRef).toContain("Match the person in the attached reference image exactly");
    expect(prompt).toContain("Identity is fixed for the whole film");
    expect(withRef).not.toBe(prompt);
  });

  it("is deterministic", () => {
    const again = keyframePrompt({
      bundle,
      spec,
      scene: hero,
      continuity: CONTINUITY,
      hasSubjectReference: false,
    });
    expect(again).toBe(prompt);
  });

  it("caps every field a model or a photograph supplied", () => {
    const long = "a young woman in a green coat ".repeat(40);
    const p = keyframePrompt({
      bundle,
      spec,
      scene: { ...hero, action: long, setting: long },
      continuity: { subject: long, wardrobe: long, previousSetting: long, entryState: long },
      hasSubjectReference: false,
    });
    expect(p.length).toBeLessThanOrEqual(KEYFRAME_PROMPT_BUDGET);
    expect(p).toContain("clearance above the head");
    expect(p).toContain("Palette:");
    expect(p).toContain(NEGATIVE_PREFIX);
    // Every field is capped, so no single line can run away with the prompt.
    for (const line of p.split("\n")) expect(line.length).toBeLessThan(500);
    expect(p).toContain("a young woman in a green coat");
  });

  it("sheds detail rather than overflowing when the style bible is verbose too", () => {
    // A Director is free to write a long style bible; the budget still holds.
    const verbose: DirectorSpec = {
      ...spec,
      style_bible: {
        ...spec.style_bible,
        medium: `${spec.style_bible.medium}, painted on cold-pressed paper with a loaded brush, edges left unresolved and the ground showing through in places`,
        lighting: `${spec.style_bible.lighting}, the key wrapping around the shoulder and dying out before the far wall`,
        palette: [
          "warm amber and rose sunset over a bleached horizon",
          "deep blue-violet shadows with a cold edge to them",
          "soft sage green in the distant foliage and hedges",
          "sun-bleached terracotta on every roof and chimney",
          "milky cream highlights where the light blows out",
          "a single cobalt accent somewhere in every frame",
        ],
        negative_rules: [
          "no photographic realism of any kind whatsoever",
          "no plastic three-dimensional rendered surface sheen",
          "no clipped white highlights in the sky or on skin",
          "no hard black outlines around figures or objects",
          "no chromatic aberration along high-contrast edges",
          "no lens flare ghosting across the frame diagonal",
        ],
      },
    };
    const long = "a young woman in a green coat ".repeat(40);
    const p = keyframePrompt({
      bundle,
      spec: verbose,
      scene: { ...hero, action: long, setting: long },
      continuity: { subject: long, wardrobe: long, previousSetting: long, entryState: long },
      hasSubjectReference: false,
    });
    expect(p.length).toBeLessThanOrEqual(KEYFRAME_PROMPT_BUDGET);
    // The load-bearing elements survive; the continuity line is what is dropped.
    expect(p).toContain("clearance above the head");
    expect(p).toContain("Palette:");
    expect(p).toContain(NEGATIVE_PREFIX);
    expect(p).not.toContain("Continuing from");
    // The full-fidelity assembly really would have overflowed.
    expect(
      keyframePrompt({
        bundle,
        spec,
        scene: hero,
        continuity: CONTINUITY,
        hasSubjectReference: false,
      }),
    ).toContain("Continuing from");
  });

  it("trims an over-long field on a word boundary, never mid-word", () => {
    // The cap lands inside the last word, so the whole word must be dropped.
    const p = keyframePrompt({
      bundle,
      spec,
      scene: hero,
      continuity: { ...CONTINUITY, subject: `${"word ".repeat(33)}GUILLOTINE` },
      hasSubjectReference: false,
    });
    expect(p).not.toContain("GUILLO");
    expect(p).toContain("word word");
  });

  it("stays under 1800 characters for every beat of every preset", () => {
    for (const b of bundles) {
      const s = specFor(b);
      for (const scene of s.scenes) {
        const p = keyframePrompt({
          bundle: b,
          spec: s,
          scene,
          continuity: CONTINUITY,
          hasSubjectReference: scene.purpose === "recognition",
        });
        expect(p.length, `${b.id}/${scene.id} is ${p.length} chars`).toBeLessThan(1800);
        expect(p.length).toBeLessThanOrEqual(KEYFRAME_PROMPT_BUDGET);
        expect(p.length).toBeGreaterThan(400);
        expect(p).toContain(NEGATIVE_PREFIX);
      }
    }
  });
});

// ── motion prompt ────────────────────────────────────────────────────────────

describe("motionPrompt", () => {
  it("describes the approved camera move and preserves the still", () => {
    for (const bundle of bundles) {
      const spec = specFor(bundle);
      for (const scene of spec.scenes) {
        const p = motionPrompt({ bundle, spec, scene });
        expect(p).toContain("Animate the attached still");
        expect(p).toContain(bundle.styleBible.medium.split(",")[0]);
        expect(p).toContain("no cuts or scene changes");
        expect(p).toContain(NEGATIVE_PREFIX);
        expect(p.length).toBeLessThan(1400);
      }
    }
  });

  it("translates each camera enum into distinct instruction text", () => {
    const bundle = getBundle("neon_anime");
    const spec = specFor(bundle);
    const seen = new Set<string>();
    for (const move of CAMERA_MOVES) {
      const scene = { ...spec.scenes[0], camera: move as CameraMove };
      const line = motionPrompt({ bundle, spec, scene }).split("\n")[1];
      expect(line.length).toBeGreaterThan(10);
      seen.add(line);
    }
    expect(seen.size).toBe(CAMERA_MOVES.length);
  });
});

// ── director prompt ──────────────────────────────────────────────────────────

describe("directorPrompt", () => {
  const bundle = getBundle(DEFAULT_BUNDLE_ID);
  const built = directorPrompt({
    bundle,
    brief: "my sister teaching me to ride a bike the summer we moved house",
    mode: "generated",
    durationS: 27,
    subjects: [{ role: "primary", description: "a girl of about ten with a blunt fringe" }],
  });

  it("states the one-hero rule", () => {
    expect(built.system).toMatch(/exactly one scene has purpose/i);
    expect(built.system).toContain("hero_drop");
  });

  it("states the contiguity rule", () => {
    expect(built.system).toMatch(/no gaps and no overlaps/i);
    expect(built.system).toMatch(/every start_s equals the previous scene's end_s/i);
  });

  it("states the remaining hard constraints", () => {
    expect(built.system).toContain(`Between ${LIMITS.minScenes} and ${LIMITS.maxScenes} scenes`);
    expect(built.system).toMatch(/s01, s02/);
    // This asserted "at most one primary human subject", which is the rule that produced a
    // film about a family trip containing exactly one member of the family. Identity still
    // has to hold for most of the reel, but the photographs decide who is in it.
    expect(built.system).toMatch(/The photographs decide who is in the film/i);
    expect(built.system).toMatch(/at least one scene shows them together/i);
    expect(built.system).toMatch(/one of kind .final_hit./i);
    expect(built.system).toMatch(/last two seconds/i);
    for (const move of CAMERA_MOVES) expect(built.system).toContain(move);
    for (const t of TRANSITIONS) expect(built.system).toContain(t);
  });

  it("mentions the duration and the preset skeleton", () => {
    expect(built.user).toContain("27 seconds");
    expect(built.user).toContain("0 to 27 seconds");
    expect(built.user).toContain(bundle.styleBible.medium);
    expect(built.user).toContain("a girl of about ten with a blunt fringe");
    for (const beat of bundle.beats) expect(built.user).toContain(beat.intent);
    expect(built.user).toContain(`${bundle.music.bpm} BPM`);
  });

  it("uses the measured track when the music was uploaded", () => {
    const uploaded = directorPrompt({
      bundle,
      brief: "a road trip that went wrong in a funny way",
      mode: "uploaded",
      durationS: 30,
      subjects: [],
      music: {
        bpm: 124,
        durationS: 31.5,
        sections: [
          { t: 0, kind: "intro" },
          { t: 14.2, kind: "drop" },
          { t: 27, kind: "outro" },
        ],
      },
    });
    expect(uploaded.user).toContain("124 BPM");
    expect(uploaded.user).toContain('music.mode to "uploaded"');
    expect(uploaded.user).toContain("14.2s");
    expect(uploaded.user).toMatch(/invent one consistent protagonist/);
  });

  it("is deterministic", () => {
    const again = directorPrompt({
      bundle,
      brief: "my sister teaching me to ride a bike the summer we moved house",
      mode: "generated",
      durationS: 27,
      subjects: [{ role: "primary", description: "a girl of about ten with a blunt fringe" }],
    });
    expect(again).toEqual(built);
  });
});

// ── vision prompt ────────────────────────────────────────────────────────────

describe("visionPrompt", () => {
  it("asks for prompt-ready facts and bounded roles", () => {
    const { system, user, schema } = visionPrompt(3);
    expect(user).toContain("3 photographs");
    expect(visionPrompt(1).user).toContain("1 photograph");
    expect(system).toMatch(/Name exactly one primary subject/i);

    const root = schema as SchemaNode;
    expect(root.required).toContain("subjects");
    expect(root.required).toContain("usable");
    const item = root.properties?.subjects.items;
    expect(item?.required).toContain("role");
    expect(item?.required).toContain("description");
    expect(item?.properties?.role.enum).toContain("primary");
    expect(item?.properties?.role.enum).toContain("secondary");
    expect(item?.properties?.confidence.type).toBe("NUMBER");
  });
});

// ── critic prompt ────────────────────────────────────────────────────────────

describe("criticPrompt", () => {
  const bundle = getBundle("retro_90s");
  const spec = specFor(bundle);
  const scene = spec.scenes[1];

  it("declares exactly the five score keys the system stores", () => {
    const root = criticPrompt({ bundle, spec, scene, isVideo: false }).schema as SchemaNode;
    const scores = root.properties?.scores;
    expect(scores?.type).toBe("OBJECT");
    expect(Object.keys(scores?.properties ?? {})).toEqual([...CRITIC_SCORE_KEYS]);
    expect(scores?.required).toEqual([...CRITIC_SCORE_KEYS]);
    for (const key of CRITIC_SCORE_KEYS) {
      expect(scores?.properties?.[key].type).toBe("NUMBER");
    }
  });

  it("declares the PASS / RETRY / FALLBACK decision and a repair instruction", () => {
    const root = criticPrompt({ bundle, spec, scene, isVideo: false }).schema as SchemaNode;
    expect(root.properties?.decision.enum).toEqual(["PASS", "RETRY", "FALLBACK"]);
    expect(root.required).toEqual(["scores", "decision", "repair_instruction", "reason"]);
    expect(root.properties?.repair_instruction.type).toBe("STRING");
  });

  it("explains all three decisions and both media cases", () => {
    const still = criticPrompt({ bundle, spec, scene, isVideo: false });
    const clip = criticPrompt({ bundle, spec, scene, isVideo: true });
    for (const decision of ["PASS", "RETRY", "FALLBACK"]) {
      expect(still.system).toContain(decision);
    }
    expect(still.system).toContain("still frame");
    expect(clip.system).toContain("video clip");
    expect(clip.system).toMatch(/no warping faces/);
    expect(still.system).toMatch(/not a stiff mannequin/);
    expect(still.user).toContain(scene.action);
    expect(still.user).toContain(bundle.styleBible.medium);
  });
});

// ── patch prompt ─────────────────────────────────────────────────────────────

describe("patchPrompt", () => {
  const bundle = getBundle("paper_collage");
  const spec = specFor(bundle);
  const built = patchPrompt({ spec, utterance: "make scene three colder and cut to it harder" });
  const root = built.schema as SchemaNode;

  it("requires the affected-scene list so the UI can show what re-renders", () => {
    expect(root.required).toContain("affected_scene_ids");
    const affected = root.properties?.affected_scene_ids;
    expect(affected?.type).toBe("ARRAY");
    expect(affected?.items?.type).toBe("STRING");
    expect(affected?.minItems).toBe(1);
    expect(affected?.maxItems).toBeLessThanOrEqual(LIMITS.maxScenes);
  });

  it("cannot express a whole-spec replacement", () => {
    const names: string[] = [];
    const objectPaths: string[] = [];
    walk(root, (n, path) => {
      if (n.properties) {
        names.push(...Object.keys(n.properties));
        objectPaths.push(path);
      }
      // Nothing anywhere in the schema may accept a free-form object.
      if (n.type === "OBJECT") expect(Object.keys(n.properties ?? {}).length).toBeGreaterThan(0);
      if (n.type === "ARRAY") expect(n.items).toBeDefined();
    });

    for (const forbidden of [
      "spec",
      "director_spec",
      "scenes",
      "style_bible",
      "events",
      "music",
      "duration_s",
      "json",
      "replacement",
    ]) {
      expect(names).not.toContain(forbidden);
    }

    // Exactly two object shapes exist: the patch envelope and one operation.
    expect(objectPaths).toEqual(["$", "$.operations[]"]);

    // Every leaf is a scalar, an enum or a bounded string array.
    walk(root, (n) => {
      if (n.type === "ARRAY") {
        expect(["STRING", "OBJECT"]).toContain(n.items?.type);
        expect(n.maxItems).toBeDefined();
      }
    });
  });

  it("permits only the bounded operation vocabulary", () => {
    const op = root.properties?.operations;
    expect(op?.type).toBe("ARRAY");
    expect(op?.maxItems).toBe(6);
    expect(op?.items?.properties?.op.enum).toEqual([...PATCH_OPERATIONS]);
    expect(op?.items?.required).toEqual(["op"]);
    expect(op?.items?.properties?.camera.enum).toEqual([...CAMERA_MOVES]);
    expect(op?.items?.properties?.transition.enum).toEqual([...TRANSITIONS]);
    expect(op?.items?.properties?.palette.maxItems).toBe(6);
    // No operation can rewrite the timeline.
    expect(PATCH_OPERATIONS.some((o) => /start|end|duration|scene_count/.test(o))).toBe(false);
  });

  it("shows the model the real scene ids and forbids inventing others", () => {
    for (const s of spec.scenes) expect(built.user).toContain(s.id);
    expect(built.user).toContain("make scene three colder and cut to it harder");
    expect(built.system).toMatch(/never invent a scene id/i);
    expect(built.system).toMatch(/not yours to change/i);
  });
});

// ── cross-checks that keep the enums honest ──────────────────────────────────

describe("prompt vocabularies match the spec enums", () => {
  it("uses only camera moves and transitions the composer implements", () => {
    for (const bundle of bundles) {
      for (const t of bundle.transitions) expect(TRANSITIONS).toContain(t as Transition);
    }
    const patchSchema = patchPrompt({
      spec: specFor(getBundle(DEFAULT_BUNDLE_ID)),
      utterance: "warmer",
    }).schema as SchemaNode;
    expect(patchSchema.properties?.operations.items?.properties?.camera.enum).toEqual([
      ...CAMERA_MOVES,
    ]);
  });
});

// -- depiction ---------------------------------------------------------------

/**
 * These are photographs of real people. A brief about a cold morning produced
 * "exhales a visible breath", the image model rendered a dense plume at the mouth, and
 * the finished reel showed the person who uploaded the photo apparently smoking. That is
 * a false depiction of them, not a style slip, so the constraint is universal and comes
 * first in the clause rather than living in one preset.
 */
describe("no smoke near a face", () => {
  it("forbids it in every keyframe prompt, whatever the preset", () => {
    for (const b of listBundles()) {
      const bundle = getBundle(b.id);
      const spec = specFor(bundle);
      for (const scene of spec.scenes) {
        const p = keyframePrompt({
          bundle,
          spec,
          scene,
          continuity: CONTINUITY,
          hasSubjectReference: true,
        });
        expect(p, `${b.id}/${scene.id}`).toMatch(/no smoking, vaping, or smoke or vapour near a face/);
      }
    }
  });

  it("survives the budget squeeze that drops other negatives", () => {
    const bundle = getBundle("dreamy_animated_memories");
    const spec = specFor(bundle);
    const hero = spec.scenes.find((s) => s.purpose === "hero_drop");
    if (!hero) throw new Error("fixture has no hero");
    const long = "a young woman in a green coat ".repeat(24);
    const p = keyframePrompt({
      bundle,
      spec,
      scene: { ...hero, action: long, setting: long },
      continuity: { subject: long, wardrobe: long, previousSetting: long, entryState: long },
      hasSubjectReference: false,
    });
    // The clause is truncated under pressure, so a rule that matters has to be ordered
    // where truncation cannot reach it.
    expect(p).toMatch(/no smoking, vaping, or smoke or vapour near a face/);
  });

  it("tells the Director never to describe clothing", () => {
    // Naming a garment once was not enough. The reference photograph shows a cream hoodie
    // while the opening scene said "a coat and scarf", and the video model resolved the
    // conflict by morphing the clothing part-way through the shot: hoodie at 2.2s, coat at
    // 3.0s. A reference image already establishes wardrobe, so prose can only contradict it.
    const { system } = directorPrompt({
      bundle: getBundle("dreamy_animated_memories"),
      brief: "a freezing morning in the mountains",
      mode: "generated",
      durationS: 30,
      subjects: [],
    });
    expect(system).toMatch(/Never describe what the subject is wearing/);
  });
  it("tells the Director not to write it in the first place", () => {
    const bundle = getBundle("dreamy_animated_memories");
    const { system } = directorPrompt({
      bundle,
      brief: "a freezing morning in the mountains",
      mode: "generated",
      durationS: 30,
      subjects: [],
    });
    expect(system).toMatch(/Nobody smokes/);
    expect(system).toMatch(/visible breath/);
  });
});
