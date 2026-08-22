/**
 * Who is in the frame, and whether the model was told.
 *
 * A film made from photographs of more than one person kept coming back with one real face
 * and the rest invented. Four separate faults produced that, none of them visible from the
 * code that read the result:
 *
 *   - the reference images were sent to the model unnamed, so a prompt about "the group" and
 *     a prompt about "the protagonist" pointed at nothing in particular
 *   - the identity instruction said "the person", singular, in a frame holding several
 *   - only the primary subject's immutable traits were collected, so everyone else was
 *     described by a sentence and drawn from imagination
 *   - the group reference was "the uploads", and taking the first of those took the single
 *     clean portrait already being used as the identity anchor
 *
 * Nothing here is specific to one photograph or one family. The cast size comes from what
 * the vision read counted, the group photograph is whichever upload the other people were
 * seen in, and a project with one person in it must behave exactly as it did before.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildContinuity, isQuotaRefusal } from "@/lib/services/visual";
import { MuseError } from "@/lib/core/util";
import { groupUploadsFor, refusesDemotion } from "@/lib/services/pipeline";
import { alignToRequest } from "@/lib/services/director";
import { criticPrompt, keyframePrompt } from "@/lib/templates/prompts";
import { DEFAULT_BUNDLE_ID, getBundle } from "@/lib/templates/bundles";
import { parseSpec } from "@/lib/spec/directorSpec";
import type { AssetRow } from "@/lib/db/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-cast-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A real file on disk, because the reference reader reads bytes rather than rows. */
function upload(name: string, contents: string): AssetRow {
  const uri = path.join(dir, name);
  fs.writeFileSync(uri, contents);
  return {
    id: name,
    project_id: "prj_test",
    type: "upload_image",
    role: null,
    uri,
    mime: "image/jpeg",
    bytes: contents.length,
    sha256: name,
    metadata_json: "{}",
    created_at: new Date(0).toISOString(),
  };
}

const PORTRAIT = upload("portrait.jpg", "one-person");
const GROUP = upload("group.jpg", "several-people");
const OTHER = upload("other.jpg", "a-place");

const bundle = getBundle(DEFAULT_BUNDLE_ID);
const parsed = parseSpec({
  spec_version: "1.0",
  title: bundle.label,
  logline: "One afternoon, remembered warmer than it happened.",
  duration_s: 30,
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
    { t: 15, kind: "drop", visual: "the widest, warmest frame lands", intensity: 0.95 },
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
    action: "they look out across the valley as the light turns",
    setting: "a flat gravel rooftop above a valley of terracotta rooftops",
    transition_in: b.transitionIn,
    retry_budget: 1,
  })),
});
if (!parsed.spec) throw new Error("fixture spec did not parse");
const spec = parsed.spec;
const groupScene = { ...spec.scenes[0], reference_asset_ids: ["subject_secondary"] };
const soloScene = { ...spec.scenes[0], reference_asset_ids: ["subject_primary"] };

const PRIMARY = {
  description: "a person with short dark curls",
  immutableTraits: ["short dark curls", "round wire glasses"],
  wardrobe: "a grey parka",
  sourceIndex: 0,
  peopleVisible: 1,
};
const SECONDARY = {
  description: "two older adults standing either side of them",
  immutableTraits: ["greying hair, centre parting", "close-cropped grey beard"],
  wardrobe: "a red shawl and a navy jacket",
  sourceIndex: 1,
  peopleVisible: 3,
};

function continuityFor(scene: typeof groupScene, facts: Parameters<typeof buildContinuity>[0]["facts"]) {
  return buildContinuity({
    spec,
    scene,
    facts,
    identityReference: PORTRAIT,
    previousKeyframe: null,
    previousScene: null,
    wantsSecondary: scene.reference_asset_ids.includes("subject_secondary"),
    groupReferences: groupUploadsFor(facts, [PORTRAIT, GROUP, OTHER]),
  });
}

describe("choosing the group photograph", () => {
  it("takes the upload the other people were actually seen in", () => {
    // The whole point: not upload 0. Upload 0 is the identity anchor, and offering it as the
    // group reference tells the model nothing it was not already told.
    const chosen = groupUploadsFor({ primary: PRIMARY, secondary: SECONDARY }, [
      PORTRAIT,
      GROUP,
      OTHER,
    ]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe("group.jpg");
  });

  it("offers nothing when the photographs show one person", () => {
    expect(groupUploadsFor({ primary: PRIMARY }, [PORTRAIT])).toEqual([]);
  });

  it("survives a source index past the end of the uploads", () => {
    const chosen = groupUploadsFor(
      { primary: PRIMARY, secondary: { ...SECONDARY, sourceIndex: 99 } },
      [PORTRAIT, GROUP],
    );
    expect(chosen).toHaveLength(1);
  });
});

describe("a scene with more than one person in it", () => {
  const packet = continuityFor(groupScene, { primary: PRIMARY, secondary: SECONDARY });

  it("counts the cast from the photograph rather than from the sentence", () => {
    expect(packet.cast).toBe(3);
  });

  it("leads with the group photograph, because a model weights what it sees first", () => {
    expect(packet.references[0].bytes.toString()).toBe("several-people");
    expect(packet.references[1].bytes.toString()).toBe("one-person");
  });

  it("names every reference it sends", () => {
    for (const ref of packet.references) expect(ref.label.trim().length).toBeGreaterThan(0);
  });

  it("pins the other people's traits, not only the protagonist's", () => {
    for (const trait of [...PRIMARY.immutableTraits, ...SECONDARY.immutableTraits]) {
      expect(packet.subject).toContain(trait);
    }
  });

  it("withholds the protagonist's wardrobe, so a group is not dressed as one person", () => {
    expect(packet.wardrobe).toBe("");
  });

  it("tells the image model the exact number of people and forbids inventing one", () => {
    const prompt = keyframePrompt({
      bundle,
      spec,
      scene: groupScene,
      continuity: packet,
      hasSubjectReference: true,
    });
    expect(prompt).toContain("Exactly 3 people are in frame");
    expect(prompt.toLowerCase()).toContain("do not add a figure");
    // The singular instruction is what produced the invented faces.
    expect(prompt).not.toContain("Match the person in the attached reference image");
  });
});

describe("a scene with one person in it", () => {
  const packet = continuityFor(soloScene, { primary: PRIMARY });

  it("is unchanged: one cast member, the portrait first, wardrobe named", () => {
    expect(packet.cast).toBe(1);
    expect(packet.references[0].bytes.toString()).toBe("one-person");
    expect(packet.wardrobe).toBe(PRIMARY.wardrobe);
  });

  it("keeps the singular instruction, which is correct for one face", () => {
    const prompt = keyframePrompt({
      bundle,
      spec,
      scene: soloScene,
      continuity: packet,
      hasSubjectReference: true,
    });
    expect(prompt).toContain("Match the person in the attached reference image");
    expect(prompt).not.toContain("people are in frame");
  });
});

describe("a secondary the vision read never counted", () => {
  it("still puts at least two people in frame rather than one", () => {
    // `people_visible` is a required field, but a cached read from before it existed will not
    // carry one. Falling back to a single person would silently restore the original bug.
    const packet = continuityFor(groupScene, {
      primary: PRIMARY,
      secondary: { ...SECONDARY, peopleVisible: undefined },
    });
    expect(packet.cast).toBe(2);
  });
});

describe("the quality gate", () => {
  it("caps identity when the headcount is wrong, so the retry budget is spent on it", () => {
    // QC is the only thing that can catch an invented person: the prompt asks, the model
    // sometimes ignores it, and without a gate the frame ships. Capping identity at 0.4 puts
    // it below the 0.7 a PASS needs, which forces the retry that already exists.
    const { system } = criticPrompt({
      bundle,
      spec,
      scene: groupScene,
      isVideo: false,
      cast: 3,
      hasReferences: true,
    });
    expect(system).toContain("all 3 people match the reference photograph");
    expect(system).toContain("clothing");
    expect(system).toContain("0.4");
  });

  it("leaves the one-person rubric alone", () => {
    const { system } = criticPrompt({ bundle, spec, scene: soloScene, isVideo: false, cast: 1 });
    expect(system).toContain("same person as the reference");
    expect(system).not.toContain("people match the reference");
  });
});

describe("planning a film about more than one person", () => {
  const subjects = [
    { role: "subject_primary", description: "a person with short dark curls" },
    { role: "subject_secondary", description: "two older adults" },
  ];

  it("puts the group in at least two scenes, not one", () => {
    // One group scene left the other people to leak into the wide shots, where the model had
    // no faces for them and used strangers'. Declaring the group where the film is about the
    // group is what gives those scenes the photograph instead.
    const aligned = alignToRequest(spec, bundle, spec.duration_s, subjects);
    const withGroup = aligned.scenes.filter((sc) =>
      sc.reference_asset_ids.includes("subject_secondary"),
    );
    expect(withGroup.length).toBeGreaterThanOrEqual(2);
  });

  it("does not put a second person in a film that only has one", () => {
    const aligned = alignToRequest(spec, bundle, spec.duration_s, [subjects[0]]);
    for (const sc of aligned.scenes) {
      expect(sc.reference_asset_ids).not.toContain("subject_secondary");
    }
  });
});

describe("a scene nobody else belongs in", () => {
  it("says so, rather than leaving the frame open to invented company", () => {
    const prompt = keyframePrompt({
      bundle,
      spec,
      scene: soloScene,
      continuity: continuityFor(soloScene, { primary: PRIMARY }),
      hasSubjectReference: true,
    });
    expect(prompt).toContain("Exactly one person is in frame and nobody else appears");
  });
});

describe("a shot size that has to hold its cast", () => {
  const subjects = [
    { role: "subject_primary", description: "a person with short dark curls" },
    { role: "subject_secondary", description: "two older adults", peopleVisible: 3 },
  ];

  it("widens a tight shot that was given three people", () => {
    // s06 was planned `extreme_close` and given the whole family, so both parents were
    // cropped at the frame edges: the faces were right and half of each was outside the
    // picture. Shot size and cast size were chosen independently and nothing reconciled them.
    const aligned = alignToRequest(spec, bundle, spec.duration_s, subjects);
    const group = aligned.scenes.filter((sc) =>
      sc.reference_asset_ids.includes("subject_secondary"),
    );
    expect(group.length).toBeGreaterThanOrEqual(2);
    for (const sc of group) {
      expect(["wide", "full"]).toContain(sc.shot_size);
    }
  });

  it("leaves a solo scene's framing exactly as planned", () => {
    const planned = spec.scenes.map((sc) => sc.shot_size);
    const aligned = alignToRequest(spec, bundle, spec.duration_s, [subjects[0]]);
    expect(aligned.scenes.map((sc) => sc.shot_size)).toEqual(planned);
  });
});

describe("choosing between a rejected take and a lesser one", () => {
  const pass = { decision: "PASS" } as never;
  const retry = { decision: "RETRY" } as never;

  it("keeps a generated take the critic passed, rather than a still", () => {
    // The original reason for the rule: a retry that can no longer afford generation returns
    // a camera move on a still, which then passes on measurement alone and reads as a fix.
    expect(refusesDemotion({ held: { generated: true, verdict: pass }, nextGenerated: false })).toBe(true);
  });

  it("gives up a generated take the critic rejected", () => {
    // Motion is worth less than the film being about the right people.
    expect(refusesDemotion({ held: { generated: true, verdict: retry }, nextGenerated: false })).toBe(false);
  });

  it("never blocks a replacement that is itself generated", () => {
    expect(refusesDemotion({ held: { generated: true, verdict: pass }, nextGenerated: true })).toBe(false);
  });

  it("has nothing to protect on the first take, or when the take is already a still", () => {
    expect(refusesDemotion({ held: null, nextGenerated: false })).toBe(false);
    expect(refusesDemotion({ held: { generated: false, verdict: pass }, nextGenerated: false })).toBe(false);
  });
});

describe("telling a quota refusal from an ordinary failure", () => {
  it("recognises the provider refusing on quota", () => {
    // A 429 on video is project-wide and lasts minutes to hours, so every shot in a run was
    // rediscovering it: two models each, spaced by the pacing interval, about twenty-four
    // seconds of waiting per shot to be told what the first shot was told.
    expect(isQuotaRefusal(new MuseError("transient", "gemini 429: quota", { status: 429 }))).toBe(true);
  });

  it("does not mistake a server blip or a bad request for it", () => {
    expect(isQuotaRefusal(new MuseError("transient", "gemini 503", { status: 503 }))).toBe(false);
    expect(isQuotaRefusal(new MuseError("permanent", "gemini 400", { status: 400 }))).toBe(false);
    expect(isQuotaRefusal(new Error("socket hang up"))).toBe(false);
    expect(isQuotaRefusal(undefined)).toBe(false);
  });
});

describe("clip filenames across runs of the same plan", () => {
  it("distinguishes takes made from different keyframes", () => {
    // Scene, spec version and attempt together are not unique: re-rendering one scene of an
    // unchanged plan starts again at attempt 0, so a second run wrote over the first run's
    // takes at the same paths. A still holding the family's real faces was replaced by
    // generated motion that had drifted off it, and the only surviving copies were the ones
    // earlier plan versions happened to have written under different names.
    const name = (keyframeSha: string, attempt: number) =>
      `clip-s05-v5-a${attempt}-${keyframeSha.slice(0, 8)}.mp4`;
    const first = name("9fafc3423542b495aaaaaaaa", 1);
    const second = name("541886f39335bbbbcccccccc", 1);
    expect(first).not.toBe(second);
    // Same keyframe and attempt is the same clip, so sharing a name there is intended.
    expect(name("9fafc3423542b495aaaaaaaa", 1)).toBe(first);
  });
});
