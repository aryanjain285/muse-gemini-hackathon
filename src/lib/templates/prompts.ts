/**
 * Every prompt MUSE sends, in one place.
 *
 * Prompt text is product surface, not implementation detail: it is versioned
 * with the bundle that owns it (see `TemplateBundle.versions`) and it never
 * leaks into business logic. Callers pass structured facts and get strings.
 *
 * The keyframe prompt is the highest-leverage string here, so its shape is not
 * invented. It reproduces the order that produced the reference keyframe in
 * `workspace/reference/`: medium, subject with immutable identity traits,
 * action, setting, shot size with the placement that size implies, lighting,
 * named palette, then a terse negative clause. Placement is stated literally
 * because a tall frame does not compose itself, and it varies with the shot size
 * so that asking for a wide does not return the same standing figure as a medium.
 */
import {
  CAMERA_MOVES,
  EVENT_KINDS,
  TRANSITIONS,
  SHOT_SIZES,
  shotSize,
  type CameraMove,
  type DirectorSpec,
  type Scene,
  type ShotSize,
} from "@/lib/spec/directorSpec";
import type { PatchOp, PatchRequest } from "@/lib/spec/patch";
import { LIMITS, OUTPUT } from "@/lib/core/config";
import type { TemplateBundle } from "./types";

// ── small text helpers ───────────────────────────────────────────────────────

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

function article(phrase: string): string {
  const first = phrase.trim().charAt(0).toLowerCase();
  return VOWELS.has(first) ? "An" : "A";
}

function cap(s: string): string {
  const t = s.trim();
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

/** Drop trailing sentence punctuation so fragments can be joined cleanly. */
function trimEndPunct(s: string): string {
  return s.trim().replace(/[.,;:!\s]+$/u, "");
}

function firstOf(...candidates: string[]): string {
  for (const c of candidates) if (c && c.trim().length > 0) return c.trim();
  return "";
}

/**
 * Trim to `max` characters on a word boundary. Prompt fields arrive from a model
 * and from user photographs, so their length is not ours to trust; clipping on a
 * word keeps the sentence readable instead of ending mid-syllable.
 */
function limit(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return trimEndPunct(space > max * 0.6 ? cut.slice(0, space) : cut);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function secs(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

// ── negative constraints ─────────────────────────────────────────────────────

/**
 * Constraints that apply to every generated frame regardless of preset. Kept to
 * four: a long negative list eats the prompt's attention budget, and these are
 * the failures the critic actually rejects assets for.
 */
const UNIVERSAL_NEGATIVES = [
  "no text, lettering, captions or watermark",
  "no extra fingers, duplicated limbs or distorted hands",
  "no warped or asymmetric faces",
  "no borders, panels, paper edge, signature or logo",
  // A cold-morning brief asked for a visible breath and the model returned a dense
  // plume at the mouth, which reads as smoking. These are photographs of real people,
  // so a shot that appears to show somebody smoking is a false depiction of them and
  // not merely an aesthetic slip. Steam belongs on the tea, not on the face.
  "no smoking, vaping, or smoke or vapour near a face",
];

/** Marker the negative clause always begins with, so callers can find it. */
export const NEGATIVE_PREFIX = "Avoid:";

/** Longest single negative rule. Anything longer is prose, not a constraint. */
const NEGATIVE_RULE_CHARS = 60;

/** Normalise one rule into the terse "no X" form the clause is built from. */
function asNegative(rule: string): string {
  const body = trimEndPunct(rule);
  if (body.length === 0) return "";
  if (/^no\b/i.test(body)) return `no${body.slice(2)}`;
  const firstWord = body.split(/\s+/)[0];
  const isAcronym = /[A-Z]/.test(firstWord) && firstWord === firstWord.toUpperCase();
  const lowered = isAcronym ? body : body.charAt(0).toLowerCase() + body.slice(1);
  return `no ${lowered}`;
}

function buildNegatives(bundle: TemplateBundle, extra: string[], maxRules: number): string {
  const rules = dedupe(
    [...UNIVERSAL_NEGATIVES, ...bundle.styleBible.negative_rules, ...extra]
      .map((r) => asNegative(limit(r, NEGATIVE_RULE_CHARS)))
      .filter((r) => r.length > 0),
  ).slice(0, maxRules);
  return `${NEGATIVE_PREFIX} ${rules.join("; ")}.`;
}

/** Negative constraints appended to every image/video prompt. */
export function negativeClause(bundle: TemplateBundle, extra: string[] = []): string {
  return buildNegatives(bundle, extra, 12);
}

// ── shot grammar ─────────────────────────────────────────────────────────────

/**
 * Shot size per scene purpose. The progression matters more than any single
 * choice: recognition is close, the world opens wide, the build tightens, the
 * hero has air around it, the resolution lets go.
 */
/**
 * How each shot size is described to an image model, paired with where the
 * subject sits in a tall frame at that distance.
 *
 * The placement half matters as much as the size. One global placement sentence
 * quietly overrides the size in front of it: told to put the subject in the lower
 * two-thirds, a model returns a standing figure in a landscape for a wide, a full
 * and a medium alike, and the coverage the Director asked for disappears.
 */
const SHOT_GRAMMAR: Record<ShotSize, { shot: string; placement: string }> = {
  wide: {
    shot: "Wide establishing shot that gives the whole setting",
    placement:
      "the subject small and low in the tall 9:16 frame, landscape and sky taking most of the height",
  },
  full: {
    shot: "Full shot, the subject head to foot with air on every side",
    placement:
      "the subject centred in the tall 9:16 frame, clearance above the head and below the feet",
  },
  medium: {
    shot: "Medium shot from the waist up, room to move into",
    placement:
      "the subject filling the middle third of the tall 9:16 frame, eyeline about a third down",
  },
  close: {
    shot: "Close shot, head and shoulders filling the width",
    placement: "the face in the upper half of the tall 9:16 frame, shoulders cut by the lower edge",
  },
  extreme_close: {
    shot: "Extreme close-up, the frame pressing in past the hairline and jaw",
    placement:
      "the features crossing the full width of the tall 9:16 frame, the edges of the face cropped",
  },
  detail: {
    shot: "Detail shot of one object or texture in this world, with no person in frame",
    placement: "the object filling the tall 9:16 frame, close and shallow, nothing else competing",
  },
};

/** The shot-size and placement sentence for one scene. */
function shotLine(scene: Scene): string {
  const g = SHOT_GRAMMAR[shotSize(scene)];
  return `${g.shot}, ${g.placement}`;
}

const FULL_BLEED = "filling the whole of a vertical 9:16 frame edge to edge";

/** How each approved camera move is described to a video model. */
const CAMERA_PHRASE: Record<CameraMove, string> = {
  static: "The camera does not move at all.",
  push_in: "One very slow push in toward the subject.",
  pull_out: "One very slow pull back away from the subject.",
  pan_left: "One slow steady pan to the left.",
  pan_right: "One slow steady pan to the right.",
  tilt_up: "One slow tilt upward.",
  tilt_down: "One slow tilt downward.",
  dolly_out: "One slow cinematic dolly out.",
  parallax_drift: "A slow lateral drift, the background sliding more slowly than the foreground.",
  handheld_drift: "A loose handheld float, small and unhurried.",
  whip: "One fast whip of the camera that settles immediately.",
};

/**
 * What is allowed to move inside each preset, beyond the subject. Presets that
 * are not listed fall back to the conservative default, which is the safest
 * instruction to give a video model.
 */
const MOTION_AMBIENCE: Record<string, string> = {
  dreamy_animated_memories:
    "wind moves hair and cloth, distant clouds drift, dust crosses the light",
  neon_anime: "neon signage flickers, rain streaks past, the rim light pulses",
  retro_90s: "grain crawls, the frame weaves by a hair, curtain light shifts",
  paper_collage: "paper layers shift in small discrete steps and their shadows follow",
};

const DEFAULT_AMBIENCE = "only the subject and the air around them move";

/** Hard character bound, so a decoded operation can never fail its own schema. */
function trunc(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd();
}

/** First clause of a medium description, for prompts that must stay short. */
function shortMedium(medium: string): string {
  return trimEndPunct(medium.split(",")[0]);
}

// ── director ─────────────────────────────────────────────────────────────────

const DIRECTOR_SYSTEM = [
  "You are the Director of MUSE. You turn one short brief into a DirectorSpec: a single JSON object that deterministic software then executes literally. There is no second pass, so every field has to be usable exactly as written.",
  "",
  "How to think about the film. Thirty vertical seconds, watched on a phone with the sound on. It must be legible in the first second, it must build, and it must pay off once. One idea per scene. Concrete nouns beat adjectives: “rain running down a bus window” is directable, “a feeling of longing” is not.",
  "",
  "Hard rules. A spec that breaks any of these is rejected and sent straight back to you:",
  `1. Between ${LIMITS.minScenes} and ${LIMITS.maxScenes} scenes, no more and no fewer.`,
  "2. Scene ids are s01, s02, s03 and so on in playback order, with no gaps in the numbering.",
  "3. Scenes are contiguous: the first starts at 0, every start_s equals the previous scene's end_s exactly, and the last end_s equals duration_s. No gaps and no overlaps.",
  "4. Exactly one scene has purpose “hero_drop”. It is the payoff, it is the longest scene, and it starts within one second of the drop event.",
  "5. No scene is shorter than 1.5 seconds or longer than 9 seconds.",
  "6. The photographs decide who is in the film. Keep to the one person the reference sheet establishes for most of it, because identity is what breaks first — but if the photographs show that person with other people, at least one scene shows them together, and that scene sets `reference_asset_ids` to [\"subject_secondary\"]. A family trip whose film contains only one member of the family is the wrong film. Nobody beyond that group appears except as a silhouette or as background.",
  "7. `action` describes one moment, never a sequence. Do not join two actions with “then”, “and then”, “before” or “while”.",
  "8. `events` contains one event of kind “drop” and one of kind “final_hit”. The final_hit lands inside the last two seconds of the film.",
  "9. Events ascend in time and none is later than duration_s.",
  "10. Nothing on screen is spelled out. Titles and captions are drawn afterwards by the compositor; `title` is optional prose for the compositor, never an instruction to an image model.",
  `11. \`camera\` and \`transition_in\` accept only the enumerated values: ${CAMERA_MOVES.join(", ")} / ${TRANSITIONS.join(", ")}. Anything else you want from the camera belongs in \`camera_note\`.`,
  "12. Keep the preset's medium, lighting and palette phrases verbatim inside style_bible. You may add at most one palette phrase of your own.",
  "13. Nobody smokes and nothing smokes near a face. Do not write a visible breath, a plume, mist, vapour or steam at or near a person's mouth, however cold the setting is: an image model renders it as smoke, and these are photographs of real people. Steam rising from a cup on a surface is fine.",
  "14. Cover the film. `shot_size` changes from one scene to the next, never three running at the same size; at least one shot is close enough to read an expression and at least one is wide enough to say where we are. A `detail` shot has no person in it at all, so `action` describes the object.",
  "15. Never describe what the subject is wearing, in any scene. The photographs establish that and a reference image is passed into every image prompt; naming a garment in `action` competes with the reference, and a video model resolves the conflict by changing the clothing part-way through a shot. Refer to the person, not to their clothes.",
  "16. Do not invent a named object or a vehicle that is not in the photographs. Landscape, weather and light may be imagined; a specific prop the person would not recognise may not.",
  "",
  "Return only the JSON object. No commentary and no code fences.",
].join("\n");

/**
 * System instruction and user prompt for the Director. Shaped to produce a
 * DirectorSpec that validates against DIRECTOR_RESPONSE_SCHEMA first time.
 *
 * `mode` is the music mode: "uploaded" means the user supplied a track, in which
 * case `music` carries what analysis measured in it and the timeline must be
 * built around those numbers rather than the preset's.
 */
export function directorPrompt(input: {
  bundle: TemplateBundle;
  brief: string;
  mode: "generated" | "uploaded";
  durationS: number;
  /** Facts the vision pass extracted about the uploaded photos. */
  subjects: { role: string; description: string }[];
  /** Present for uploaded-music mode: what was measured in the user's track. */
  music?: { bpm: number; durationS: number; sections: { t: number; kind: string }[] };
}): { system: string; user: string } {
  const { bundle, brief, mode, durationS, subjects, music } = input;
  const sb = bundle.styleBible;

  const skeleton = bundle.beats
    .map((b, i) => {
      const id = `s${String(i + 1).padStart(2, "0")}`;
      const span = `${secs(b.atS)}-${secs(b.endS)}s`;
      return [
        `  ${id}`,
        span.padEnd(11),
        b.purpose.padEnd(15),
        b.renderMode.padEnd(21),
        b.camera.padEnd(15),
        b.transitionIn.padEnd(11),
        `- ${b.intent}`,
      ].join(" ");
    })
    .join("\n");

  const subjectBlock =
    subjects.length > 0
      ? subjects.map((s) => `  ${s.role}: ${s.description}`).join("\n")
      : "  none. No photographs were supplied, so invent one consistent protagonist, describe them once in style_bible.character_rules, and refer to that description in every scene action.";

  const musicLines: string[] = [];
  if (mode === "uploaded" && music) {
    const nearest = [...music.sections].sort(
      (a, b) => Math.abs(a.t - durationS / 2) - Math.abs(b.t - durationS / 2),
    )[0];
    musicLines.push(
      `The user supplied the track. Measured: ${music.bpm} BPM over ${secs(music.durationS)}s.`,
      `Sections found: ${music.sections.map((s) => `${secs(s.t)}s ${s.kind}`).join(", ") || "none detected"}.`,
      `Set music.mode to "uploaded" and music.bpm_target to ${Math.round(music.bpm)}.`,
      nearest
        ? `Put the drop event on the measured section nearest the middle of the film, at ${secs(nearest.t)}s, and start the hero_drop scene there.`
        : "No sections were detected, so place the drop at the middle of the film.",
      "Cut with this track, not against it: scene boundaries belong on measured section changes.",
    );
  } else {
    musicLines.push(
      `Score to be generated. Preset asks for ${bundle.music.bpm} BPM, ${bundle.music.key}, mood “${bundle.music.mood}”.`,
      `Instrumentation: ${bundle.music.instrumentation.join(", ")}.`,
      bundle.music.notes,
      `Set music.mode to "generated" and keep bpm_target within 6 of ${bundle.music.bpm} unless the brief demands otherwise.`,
    );
  }

  const user = [
    `Preset: ${bundle.label} (${bundle.id}) — ${bundle.blurb}`,
    `Target duration: ${durationS} seconds. Aspect ratio: 9:16 vertical at ${OUTPUT.width}x${OUTPUT.height}.`,
    `Scenes must cover 0 to ${durationS} seconds with no gaps and no overlaps.`,
    "",
    "Brief from the user:",
    `"""`,
    brief.trim(),
    `"""`,
    "",
    "Style bible to start from. Copy medium, lighting and the palette phrases through verbatim:",
    `  medium: ${sb.medium}`,
    `  lighting: ${sb.lighting}`,
    `  palette: ${sb.palette.join(" | ")}`,
    `  character rules: ${sb.character_rules.join(" | ")}`,
    `  negative rules: ${sb.negative_rules.join(" | ")}`,
    `  grain: ${sb.grain}`,
    "",
    `Beat skeleton this preset is tuned for. Follow its shape and its render modes. You may move any boundary by up to 1.5 seconds and you should replace every intent with something specific to this brief:`,
    skeleton,
    "",
    `Approved transitions, in preference order: ${bundle.transitions.join(", ")}.`,
    "",
    "Subjects the vision pass found in the uploads:",
    subjectBlock,
    "",
    "Music:",
    ...musicLines.map((l) => `  ${l}`),
    "",
    `Write the spec now. ${LIMITS.minScenes} to ${LIMITS.maxScenes} scenes, exactly one hero_drop, one drop event, one final_hit inside the last two seconds.`,
  ].join("\n");

  return { system: DIRECTOR_SYSTEM, user };
}

// ── keyframe ─────────────────────────────────────────────────────────────────

/**
 * Character budget for one image prompt. Past roughly this length an image model
 * starts averaging the instructions instead of following them, and the palette
 * and framing — the parts that carry the look — are what get dropped first.
 */
export const KEYFRAME_PROMPT_BUDGET = 1700;

/** How much of each variable field survives, per fidelity tier. */
interface KeyframeTier {
  subject: number;
  wardrobe: number;
  action: number;
  setting: number;
  entry: number;
  previous: number;
  palette: number;
  rules: number;
  negatives: number;
  continuity: boolean;
}

const KEYFRAME_TIERS: KeyframeTier[] = [
  {
    subject: 170,
    wardrobe: 110,
    action: 200,
    setting: 180,
    entry: 130,
    previous: 110,
    palette: 4,
    rules: 2,
    negatives: 9,
    continuity: true,
  },
  {
    subject: 110,
    wardrobe: 60,
    action: 140,
    setting: 120,
    entry: 0,
    previous: 0,
    palette: 3,
    rules: 1,
    negatives: 7,
    continuity: false,
  },
];

/** The prompt for one keyframe. This is the highest-leverage string in MUSE. */
export function keyframePrompt(input: {
  bundle: TemplateBundle;
  spec: DirectorSpec;
  scene: Scene;
  /** Continuity facts carried from earlier scenes. */
  continuity: {
    subject: string;
    wardrobe: string;
    previousSetting: string;
    entryState: string;
    /** How many people belong in this frame. Anything above one needs every face matched. */
    cast?: number;
  };
  hasSubjectReference: boolean;
}): string {
  const { bundle, spec, scene, continuity, hasSubjectReference } = input;
  const sb = spec.style_bible;
  const bb = bundle.styleBible;

  const medium = limit(firstOf(sb.medium, bb.medium), 200);
  const lighting = limit(firstOf(sb.lighting, bb.lighting), 120);
  const palettePhrases = (sb.palette.length >= 2 ? sb.palette : bb.palette).map((p) =>
    limit(p, 45),
  );
  const rules = (sb.character_rules.length > 0 ? sb.character_rules : bb.character_rules).map((r) =>
    limit(r, 90),
  );
  const subjectRaw = firstOf(continuity.subject, "the one protagonist of this film");
  const settingRaw = firstOf(
    scene.setting,
    continuity.previousSetting,
    "the same place as the previous scene",
  );

  const assemble = (t: KeyframeTier): string => {
    const lines: string[] = [];

    // 1. medium
    lines.push(`${article(medium)} ${medium}, ${FULL_BLEED}.`);

    // 2. subject with its immutable identity traits. A detail shot has nobody in
    // it, and naming a subject there is what puts one back in frame.
    if (shotSize(scene) !== "detail") {
      const wardrobe = limit(continuity.wardrobe, t.wardrobe);
      // "The person", singular, was the instruction a scene with three people in it got. The
      // model matched one face from the leading reference and filled the rest of the frame
      // with strangers — which is exactly what it was asked to do.
      const cast = Math.max(1, Math.round(continuity.cast ?? 1));
      const identity = !hasSubjectReference
        ? `Identity is fixed for the whole film: ${rules.slice(0, t.rules).join("; ")}.`
        : cast > 1
          ? `Exactly ${cast} people are in frame — no more and no fewer. Every one of them is a real person in the attached photograph of the group: match each face, hair, build, age and clothing to the person it belongs to. Do not add a figure who is not in that photograph, and do not replace anyone's face with an invented one.`
          // The count is authoritative in both directions. A scene that never asked for
          // anybody else still put figures in frame — an action about a shared afternoon
          // reads as company — and a figure the model was given no face for is a stranger
          // with a family's role in the film.
          : "Match the person in the attached reference image exactly: same face, same hair, same build. Exactly one person is in frame and nobody else appears, not beside them and not behind them.";
      lines.push(
        `The subject is ${limit(subjectRaw, t.subject)}${wardrobe ? `, wearing ${wardrobe}` : ""}. ${identity}`,
      );
    }

    // 3. action — one image, one thing
    lines.push(`${cap(limit(scene.action, t.action))} — one single moment, not a sequence.`);

    // Continuity, so consecutive scenes read as the same afternoon rather than
    // as unrelated pictures. First to go when the prompt is over budget.
    if (t.continuity) {
      const entry = limit(continuity.entryState, t.entry);
      const previous = limit(continuity.previousSetting, t.previous);
      if (previous && entry) lines.push(`Continuing from ${previous}: ${entry}.`);
      else if (entry) lines.push(`${cap(entry)}.`);
    }

    // 4. setting
    lines.push(`The setting is ${limit(settingRaw, t.setting)}.`);

    // 5. shot size and subject placement in a tall frame
    lines.push(`${shotLine(scene)}.`);

    // 6. lighting
    lines.push(`${cap(lighting)}.`);

    // 7. named palette
    lines.push(`Palette: ${palettePhrases.slice(0, t.palette).join(", ")}.`);

    // 8. negative constraints, always last
    lines.push(buildNegatives(bundle, sb.negative_rules, t.negatives));

    return lines.join("\n");
  };

  let out = assemble(KEYFRAME_TIERS[0]);
  for (let i = 1; i < KEYFRAME_TIERS.length && out.length > KEYFRAME_PROMPT_BUDGET; i++) {
    out = assemble(KEYFRAME_TIERS[i]);
  }
  return out;
}

// ── motion ───────────────────────────────────────────────────────────────────

/** The prompt for animating an approved keyframe. */
export function motionPrompt(input: {
  bundle: TemplateBundle;
  spec: DirectorSpec;
  scene: Scene;
}): string {
  const { bundle, spec, scene } = input;
  const medium = shortMedium(firstOf(spec.style_bible.medium, bundle.styleBible.medium));
  const palette = (
    spec.style_bible.palette.length >= 2 ? spec.style_bible.palette : bundle.styleBible.palette
  ).slice(0, 2);
  const ambience = MOTION_AMBIENCE[bundle.id] ?? DEFAULT_AMBIENCE;
  const seconds = Math.max(1, Math.round(scene.end_s - scene.start_s));
  const note = trimEndPunct(scene.camera_note);

  const lines = [
    "Animate the attached still. It is the first frame and the look is already correct; keep it.",
    `${CAMERA_PHRASE[scene.camera]}${note ? ` ${cap(note)}.` : ""}`,
    `${cap(trimEndPunct(scene.action))}; ${ambience}. Nothing else in the frame moves.`,
    // Stated as a positive as well: a model follows "shoulders follow the head" more
    // reliably than it obeys a list of things not to do.
    "Any movement of the body stays within what a person can actually do: if the head turns, the shoulders follow it, and it turns no further than a glance.",
    `Hold the ${medium} and the ${palette.join(" and ")} of the still exactly — the same picture in motion, not a new picture.`,
    `About ${seconds} seconds of continuous motion at a steady pace.`,
    negativeClause(bundle, [
      "no cuts or scene changes",
      "no camera shake",
      "no morphing faces or hands",
      "no new characters entering frame",
      "no speech or lip movement",
      // A shot whose action was "turns his head toward the window" came back with the head
      // swivelling most of the way round while the body stayed frozen — the clothes never
      // moved. It reads as a ghost rather than a person, and it is the worst thing the reel
      // has done, because it is a real person being shown doing something impossible.
      "no head turning further than a natural glance",
      "no head or limb moving independently of the body",
      "no rotating, spinning or orbiting the subject",
    ]),
  ];
  return lines.join("\n");
}

// ── vision ───────────────────────────────────────────────────────────────────

const VISION_SCHEMA = {
  type: "OBJECT",
  required: ["usable", "subjects", "setting", "palette_observed", "warnings"],
  propertyOrdering: ["usable", "subjects", "setting", "palette_observed", "warnings"],
  properties: {
    usable: {
      type: "BOOLEAN",
      description: "False when no supplied photograph can carry a scene.",
    },
    subjects: {
      type: "ARRAY",
      maxItems: 6,
      items: {
        type: "OBJECT",
        required: ["asset_index", "role", "description", "identity_traits", "wardrobe", "confidence"],
        propertyOrdering: [
          "asset_index",
          "role",
          "description",
          "identity_traits",
          "wardrobe",
          "confidence",
        ],
        properties: {
          asset_index: { type: "INTEGER", description: "Zero-based index of the photograph." },
          role: {
            type: "STRING",
            enum: ["primary", "secondary", "group", "pet", "object", "place"],
          },
          description: {
            type: "STRING",
            description: "One sentence, usable verbatim inside an image prompt.",
          },
          identity_traits: {
            type: "ARRAY",
            items: { type: "STRING" },
            maxItems: 6,
            description: "Traits that must not drift: hair, face shape, glasses, build.",
          },
          wardrobe: { type: "STRING", description: "Clothing, in prompt-ready words." },
          confidence: { type: "NUMBER", description: "0 to 1." },
        },
      },
    },
    setting: { type: "STRING", description: "Where the photographs appear to have been taken." },
    palette_observed: { type: "ARRAY", items: { type: "STRING" }, maxItems: 5 },
    warnings: {
      type: "ARRAY",
      items: { type: "STRING" },
      maxItems: 6,
      description: "Blur, occlusion, low resolution, readable signage, more than two people.",
    },
  },
} as const;

/** Vision pass over the user's uploads: what is in them, and are they usable. */
export function visionPrompt(count: number): { system: string; user: string; schema: unknown } {
  const system = [
    "You are the eye of a music-video pipeline. You look at the photographs a user uploaded and report facts that a later image model can act on. You are not a critic and not a flatterer.",
    "",
    "Rules:",
    "1. Name exactly one primary subject across all the photographs: the person who appears most often, or the person in the first photograph when that is unclear. If any photograph shows another person with them, you MUST also report that person as the secondary subject — describe them as they appear, and where several people appear together describe them as a group. Reporting only the primary when a photograph plainly contains other people is the commonest way to get this wrong.",
    "2. Describe only what is visible: hair length and colour, face shape, glasses, facial hair, build, skin tone, clothing. No names, no relationships, no guesses about mood, occupation or ethnicity.",
    "3. `identity_traits` are the things that must not drift between scenes. Keep each to a few words. Where an entry describes several people together, give the traits that distinguish each of them, in the order they stand.",
    "3a. `people_visible` is a count, not an estimate. Count the faces in that photograph and report the number. A group described as “with his parents” and reported as 2 becomes a film with an extra stranger in it.",
    "4. Mark a photograph in `warnings` when it is heavily blurred, badly occluded, very low resolution, a photograph of a screen, or carries readable signage that an image model might copy.",
    "5. Set `usable` to false only when no photograph can carry a scene at all.",
    "6. Every description must read as a prompt fragment, not as a caption about a picture. Write “a young man with short dark curls and a grey hoodie”, not “this image shows a man”.",
  ].join("\n");

  const plural = count === 1 ? "photograph" : "photographs";
  const user = [
    `${count} ${plural} follow, in upload order.`,
    "For each one, report the subject or subjects, the traits that must stay fixed, and any problem that would make it a poor reference.",
    "If more than one person appears anywhere in this set, report a secondary subject as well as a primary. Photographs of a trip usually contain the people it was taken with, and a film made from them that shows only one of them is the wrong film.",
    "Then report the shared setting and up to five colours you actually see, as short palette phrases.",
  ].join("\n");

  return { system, user, schema: VISION_SCHEMA };
}

// ── critic ───────────────────────────────────────────────────────────────────

/** The five axes every rendered asset is scored on. Stored verbatim by QC. */
export const CRITIC_SCORE_KEYS = [
  "identity",
  "continuity",
  "motion",
  "adherence",
  "composition",
] as const;

const CRITIC_SCHEMA = {
  type: "OBJECT",
  required: ["scores", "decision", "repair_instruction", "reason"],
  propertyOrdering: ["scores", "decision", "repair_instruction", "reason"],
  properties: {
    scores: {
      type: "OBJECT",
      required: [...CRITIC_SCORE_KEYS],
      propertyOrdering: [...CRITIC_SCORE_KEYS],
      properties: {
        identity: { type: "NUMBER", description: "0 to 1. Same person as the reference." },
        continuity: { type: "NUMBER", description: "0 to 1. Same medium, palette and wardrobe." },
        motion: { type: "NUMBER", description: "0 to 1. Movement is plausible and undistorted." },
        adherence: { type: "NUMBER", description: "0 to 1. Shows the requested action and setting." },
        composition: { type: "NUMBER", description: "0 to 1. Vertical framing holds up." },
      },
    },
    decision: { type: "STRING", enum: ["PASS", "RETRY", "FALLBACK"] },
    repair_instruction: {
      type: "STRING",
      description: "One concrete imperative change, under 160 characters. Never empty.",
    },
    reason: { type: "STRING", description: "One sentence naming the weakest axis." },
  },
} as const;

/** Critic rubric. Returns a Gemini responseSchema plus the prompt. */
export function criticPrompt(input: {
  bundle: TemplateBundle;
  spec: DirectorSpec;
  scene: Scene;
  isVideo: boolean;
  /** How many people belong in this frame. */
  cast?: number;
  /** Whether the reference photographs are attached for comparison. */
  hasReferences?: boolean;
}): { system: string; user: string; schema: unknown } {
  const { bundle, spec, scene, isVideo } = input;
  const cast = Math.max(1, Math.round(input.cast ?? 1));
  const sb = spec.style_bible;
  const subject = isVideo ? "video clip" : "still frame";

  const system = [
    `You are the quality gate for one ${subject} in a 9:16 music video. You score it, you decide, and you write the single most valuable repair instruction. You are strict: a demo audience sees this frame.`,
    "",
    "Score each axis from 0 to 1, where 0.5 means “usable but wrong” and 0.8 means “no one would question it”:",
    cast > 1
      ? `  identity    - all ${cast} people match the reference photograph: each face, hair, build, age and clothing, and there are exactly ${cast} of them. A figure who is not in the photograph, a face swapped for a stranger's, or a headcount that is not ${cast}, scores at or below 0.4 — never higher, however good the frame looks otherwise.`
      : "  identity    - same person as the reference and the earlier scenes: face, hair, build.",
    "  continuity  - same medium, palette, lighting direction and wardrobe as the style bible.",
    isVideo
      ? "  motion      - movement is plausible and continuous: no warping faces, no sliding feet, no morphing hands, no cuts."
      : "  motion      - the pose reads as a moment caught mid-movement, not a stiff mannequin.",
    "  adherence   - shows the requested action, setting and shot size, and only that.",
    "  composition - subject in the lower two-thirds with headroom, nothing important cropped, no lettering anywhere.",
    "",
    "Then decide:",
    "  PASS     - every axis at or above 0.6, identity at or above 0.7, and nothing embarrassing.",
    "  RETRY    - one clear, nameable defect that a better prompt would plausibly fix.",
    "  FALLBACK - wrong subject, mangled anatomy, unreadable frame, or the wrong medium entirely. Do not spend another generation on it.",
    "",
    "`repair_instruction` is always filled in, even on PASS, and is one imperative sentence naming what to change. “Improve the composition” is useless; “move the subject down so the head sits at the top third line” is useful.",
  ].join("\n");

  const user = [
    `Preset: ${bundle.label} (${bundle.id}).`,
    `Medium: ${sb.medium}`,
    `Lighting: ${sb.lighting}`,
    `Palette: ${sb.palette.join(", ")}`,
    `Identity rules: ${sb.character_rules.join("; ") || "none recorded"}`,
    "",
    `Scene ${scene.id} of ${spec.scenes.length}, ${secs(scene.start_s)}-${secs(scene.end_s)}s, purpose ${scene.purpose}.`,
    `Requested action: ${scene.action}`,
    `Requested setting: ${scene.setting || "carried over from the previous scene"}`,
    `Requested camera: ${scene.camera}${scene.camera_note ? ` (${scene.camera_note})` : ""}`,
    `Expected shot size: ${SHOT_GRAMMAR[shotSize(scene)].shot}.`,
    "",
    isVideo
      ? `Judge the attached clip. It should read as ${secs(scene.end_s - scene.start_s)} seconds of one continuous shot.`
      : "Judge the attached frame.",
  ].join("\n");

  return { system, user, schema: CRITIC_SCHEMA };
}

// ── live-direction patch ─────────────────────────────────────────────────────

/**
 * The only edits a live-direction utterance may produce. Bounded on purpose: a
 * free-form rewrite would invalidate every cached asset and could quietly break
 * the timeline the composer already reconciled against the music.
 */
export const PATCH_OPERATIONS = [
  "set_scene_action",
  "set_scene_setting",
  "set_scene_shot_size",
  "set_scene_camera",
  "set_scene_transition",
  "set_palette",
  "set_lighting",
  "shift_event_intensity",
  "add_motif",
  "revert",
] as const;

const PATCH_SCHEMA = {
  type: "OBJECT",
  required: ["intent", "affected_scene_ids", "operations"],
  propertyOrdering: ["intent", "affected_scene_ids", "operations", "unsupported"],
  properties: {
    intent: {
      type: "STRING",
      description: "One sentence restating what the user asked for, in your own words.",
    },
    affected_scene_ids: {
      type: "ARRAY",
      items: { type: "STRING", description: "An existing scene id such as s03." },
      minItems: 1,
      maxItems: 7,
      description: "Every scene this patch changes. These scenes will be re-rendered.",
    },
    operations: {
      type: "ARRAY",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "OBJECT",
        required: ["op"],
        propertyOrdering: [
          "op",
          "scene_id",
          "value",
          "shot_size",
          "camera",
          "transition",
          "palette",
          "event_kind",
          "intensity_delta",
        ],
        properties: {
          op: { type: "STRING", enum: [...PATCH_OPERATIONS] },
          scene_id: {
            type: "STRING",
            description: "Existing scene id the operation applies to. Required except for set_palette, set_lighting and revert.",
          },
          value: {
            type: "STRING",
            description:
              "New action, new setting, new lighting sentence, or the motif to add. One short sentence.",
          },
          shot_size: { type: "STRING", enum: [...SHOT_SIZES] },
          camera: { type: "STRING", enum: [...CAMERA_MOVES] },
          transition: { type: "STRING", enum: [...TRANSITIONS] },
          palette: {
            type: "ARRAY",
            items: { type: "STRING" },
            minItems: 2,
            maxItems: 6,
            description: "Replacement palette phrases for set_palette.",
          },
          event_kind: { type: "STRING", enum: [...EVENT_KINDS] },
          intensity_delta: {
            type: "NUMBER",
            description: "Signed change to an event's intensity, between -0.5 and 0.5.",
          },
        },
      },
    },
    unsupported: {
      type: "STRING",
      description: "Set when the request cannot be expressed as these operations. Explain in one sentence and return no operations.",
    },
  },
} as const;

/** Turn a live-direction utterance into a constrained DirectorSpec patch. */
export function patchPrompt(input: { spec: DirectorSpec; utterance: string }): {
  system: string;
  user: string;
  schema: unknown;
} {
  const { spec, utterance } = input;

  const system = [
    "You translate one spoken note from a director into a small, bounded patch of an existing music-video spec. You do not rewrite the film.",
    "",
    "You may only emit these operations:",
    "  set_scene_action      - replace one scene's action with one moment.",
    "  set_scene_setting     - replace one scene's setting.",
    "  set_scene_shot_size   - move the camera nearer or further for one scene.",
    "  set_scene_camera      - change one scene's camera move to an approved value.",
    "  set_scene_transition  - change how one scene is entered.",
    "  set_palette           - replace the style bible palette phrases.",
    "  set_lighting          - replace the style bible lighting sentence.",
    "  shift_event_intensity - nudge one event's intensity up or down.",
    "  add_motif             - add one recurring visual element to named scenes.",
    "  revert                - undo the previous patch.",
    "",
    "Rules:",
    "1. List every scene you touch in `affected_scene_ids`. Those scenes are re-rendered and the user is shown the cost, so the list must be complete and must contain only ids that already exist.",
    "2. Timings, scene count, purposes and render modes are not yours to change. If the note demands that, leave `operations` empty and explain in `unsupported`.",
    "3. Prefer the smallest patch that satisfies the note. One operation is a good answer; six is a warning sign.",
    "4. add_motif still needs `scene_id` on one operation per scene it applies to.",
    "5. Never invent a scene id and never address a scene by its position.",
  ].join("\n");

  const sceneList = spec.scenes
    .map(
      (s) =>
        `  ${s.id}  ${secs(s.start_s)}-${secs(s.end_s)}s  ${s.purpose.padEnd(14)} ${s.camera.padEnd(15)} ${s.transition_in.padEnd(11)} ${s.action}`,
    )
    .join("\n");

  const eventList = spec.events
    .map((e) => `  ${secs(e.t)}s ${e.kind} intensity ${e.intensity}`)
    .join("\n");

  const user = [
    `Film: “${spec.title}”, ${secs(spec.duration_s)}s, preset ${spec.style_bible.preset}.`,
    `Palette: ${spec.style_bible.palette.join(", ")}`,
    `Lighting: ${spec.style_bible.lighting}`,
    "",
    "Scenes:",
    sceneList,
    "",
    "Events:",
    eventList,
    "",
    "The director just said:",
    `"""`,
    utterance.trim(),
    `"""`,
    "",
    "Emit the smallest patch that does what they asked.",
  ].join("\n");

  return { system, user, schema: PATCH_SCHEMA };
}

/**
 * Turn a Director's reply into the patch operations the spec module applies.
 *
 * The wire dialect and the internal one are deliberately different. A model is
 * asked for `set_scene_setting` with a free `value`, because one flat operation
 * shape with named slots is what it fills in reliably; the spec module takes a
 * discriminated union where each operation carries only its own fields, because
 * that is what makes an illegal patch unrepresentable. This function is the seam,
 * and it is the reason the two can be shaped for their own jobs.
 *
 * Anything unrecognised is dropped rather than guessed at. A patch that ends up
 * empty returns null, which the caller reports as a request it could not make.
 */
export function decodePatchResponse(
  raw: unknown,
  spec: DirectorSpec,
): { request: PatchRequest | null; unsupported?: string } {
  if (typeof raw !== "object" || raw === null) return { request: null };
  const obj = raw as Record<string, unknown>;

  const unsupported = typeof obj.unsupported === "string" ? obj.unsupported.trim() : "";
  const intent = typeof obj.intent === "string" ? obj.intent.trim() : "";
  const wire = Array.isArray(obj.operations) ? obj.operations : [];

  const ops: PatchOp[] = [];
  for (const entry of wire) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const sceneId = typeof e.scene_id === "string" ? e.scene_id : "";
    const value = typeof e.value === "string" ? e.value.trim() : "";
    const known = spec.scenes.some((sc) => sc.id === sceneId);

    switch (e.op) {
      case "set_scene_action":
        if (known && value) ops.push({ op: "scene_action", scene_id: sceneId, action: trunc(value, 400) });
        break;
      case "set_scene_setting":
        if (known && value) ops.push({ op: "scene_setting", scene_id: sceneId, setting: trunc(value, 300) });
        break;
      case "set_scene_shot_size": {
        const size = SHOT_SIZES.find((v) => v === e.shot_size);
        if (known && size) ops.push({ op: "scene_shot_size", scene_id: sceneId, shot_size: size });
        break;
      }
      case "set_scene_camera": {
        const camera = CAMERA_MOVES.find((v) => v === e.camera);
        if (known && camera) {
          ops.push({
            op: "scene_camera",
            scene_id: sceneId,
            camera,
            ...(value ? { camera_note: trunc(value, 200) } : {}),
          });
        }
        break;
      }
      case "set_scene_transition": {
        const transition = TRANSITIONS.find((v) => v === e.transition);
        if (known && transition) ops.push({ op: "scene_transition", scene_id: sceneId, transition });
        break;
      }
      case "set_palette": {
        const palette = Array.isArray(e.palette)
          ? e.palette.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 6)
          : [];
        if (palette.length >= 2) ops.push({ op: "style_palette", palette });
        break;
      }
      case "set_lighting":
        if (value) ops.push({ op: "style_lighting", lighting: trunc(value, 200) });
        break;
      case "shift_event_intensity": {
        const kind = EVENT_KINDS.find((v) => v === e.event_kind);
        const delta = typeof e.intensity_delta === "number" ? e.intensity_delta : NaN;
        const current = spec.events.find((ev) => ev.kind === kind);
        // The wire carries a nudge; the spec stores a level. Resolving one against
        // the other needs the spec, which is why this decode is not a pure rename.
        if (kind && current && Number.isFinite(delta)) {
          const level = Math.min(1, Math.max(0, current.intensity + delta));
          ops.push({ op: "event_intensity", kind, intensity: Number(level.toFixed(3)) });
        }
        break;
      }
      case "add_motif": {
        const ids = known ? [sceneId] : [];
        if (ids.length > 0 && value) ops.push({ op: "add_motif", scene_ids: ids, motif: trunc(value, 120) });
        break;
      }
      default:
        break;
    }
  }

  if (ops.length === 0) {
    return { request: null, ...(unsupported ? { unsupported } : {}) };
  }
  return {
    request: { summary: trunc(intent || "your note", 160), ops },
    ...(unsupported ? { unsupported } : {}),
  };
}

// -- screening ----------------------------------------------------------------

/**
 * Notes on a finished edit.
 *
 * Every other review here judges one shot. This one judges the film, which needs the
 * whole reel in front of it and the two things a picture cannot show: where the cuts
 * fell and where the music actually put its accents.
 *
 * The vocabulary is closed on purpose. A note whose fix is outside what MUSE can do is
 * a wish, and a button that cannot work is worse than no button, so the schema only
 * lets a fix be a re-cut of footage already paid for or a reframe of one shot.
 */
export const SCREENING_SCHEMA = {
  type: "OBJECT",
  required: ["working", "notes"],
  propertyOrdering: ["working", "notes"],
  properties: {
    working: {
      type: "STRING",
      description: "One sentence on what this edit gets right. Specific, not flattery.",
    },
    notes: {
      type: "ARRAY",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "OBJECT",
        required: ["topic", "note", "sceneIds", "fix"],
        propertyOrdering: ["topic", "note", "sceneIds", "fix"],
        properties: {
          topic: {
            type: "STRING",
            enum: ["pacing", "coverage", "continuity", "payoff", "sound"],
          },
          note: {
            type: "STRING",
            description:
              "One sentence naming what you see and why it weakens the film. No advice here.",
          },
          sceneIds: {
            type: "ARRAY",
            items: { type: "STRING" },
            maxItems: 3,
            description: "Existing scene ids this concerns, such as s03.",
          },
          fix: {
            type: "OBJECT",
            required: ["kind"],
            propertyOrdering: ["kind", "edit", "sceneId", "shotSize"],
            properties: {
              kind: { type: "STRING", enum: ["recut", "reframe", "none"] },
              edit: { type: "STRING", description: "For kind recut: which reading to use." },
              sceneId: { type: "STRING", description: "For kind reframe: the scene to move." },
              shotSize: { type: "STRING", enum: [...SHOT_SIZES] },
            },
          },
        },
      },
    },
  },
} as const;

/** System instruction and user prompt for a screening. */
export function screeningPrompt(input: {
  spec: DirectorSpec;
  cutsS: number[];
  anchorsS: number[];
  offered: string[];
}): { system: string; user: string } {
  const { spec, cutsS, anchorsS, offered } = input;

  const system = [
    "You are watching a finished thirty second vertical music reel as the supervising editor. You are not reviewing the pictures; other passes did that. You are reviewing the edit.",
    "",
    "The frames are in order, sampled evenly across the reel. Read them as a sequence: does it build, does it repeat itself, does it land where the music lands, does the same person read as the same person.",
    "",
    "What makes a note worth writing:",
    "  - it names something visible in these frames, not something you assume",
    "  - it says why the film is weaker for it, in the same sentence",
    "  - it can be fixed by one of the changes below, or it carries no fix at all",
    "",
    "The only changes available:",
    `  recut   - read the same footage differently: ${offered.join(", ")}`,
    "  reframe - move one shot nearer or further: wide, full, medium, close, extreme_close, detail",
    "  none    - the note stands on its own and needs a new plan to act on",
    "",
    "Do not suggest new shots, new music, longer running time, or anything outside that list. Do not pad to four notes; one real note beats three invented ones. Return only the JSON object.",
  ].join("\n");

  const shots = spec.scenes
    .map((sc) => {
      const size = shotSize(sc);
      return `  ${sc.id}  ${secs(sc.start_s)}-${secs(sc.end_s)}s  ${size.padEnd(13)} ${sc.purpose.padEnd(14)} ${trimEndPunct(sc.action)}`;
    })
    .join("\n");

  const user = [
    `The film is "${spec.title}" - ${spec.logline}`,
    "",
    "The shot list, as planned:",
    shots,
    "",
    `Cuts landed at: ${cutsS.map((t) => `${secs(t)}s`).join(", ")}`,
    `The score put accents at: ${anchorsS.slice(0, 24).map((t) => `${secs(t)}s`).join(", ")}`,
    `Requested drop ${secs(spec.music.drop_at_s ?? spec.duration_s / 2)}s at ${spec.music.bpm_target} BPM, mood "${spec.music.mood}".`,
    "",
    "Give your notes.",
  ].join("\n");

  return { system, user };
}

// ── caricature ───────────────────────────────────────────────────────────────

/** The drawing styles the sketch stand offers. */
export const SKETCH_STYLES = ["pencil", "caricature", "ink", "watercolour"] as const;
export type SketchStyle = (typeof SKETCH_STYLES)[number];

const SKETCH_DIRECTION: Record<SketchStyle, string> = {
  pencil:
    "a graphite pencil portrait on cold-press paper: open hatching, a soft 2B line that varies " +
    "in pressure, cast shadow built from strokes rather than smudge, the paper left bare where " +
    "the light falls",
  caricature:
    "a warm ink-and-wash caricature in the manner of a newspaper cartoonist: the features that " +
    "make this face recognisable pushed a little further and everything else simplified, a " +
    "confident brush line, generous flat wash, a friendly exaggeration that the sitter would " +
    "laugh at rather than resent",
  ink:
    "a brush-and-ink drawing: black line only, no grey, weight carried by how thick each stroke " +
    "is, whites left open, the kind of economy that suggests a whole figure in a dozen marks",
  watercolour:
    "a loose watercolour sketch: wet edges that bleed into each other, pigment pooling at the " +
    "bottom of each shape, pencil under-drawing still visible through the paint, plenty of " +
    "untouched paper",
};

/**
 * A drawing of the people in a photograph, in one of a few hands.
 *
 * The likeness is the whole point, so the instruction leads with it and repeats it: a
 * caricature that is not recognisably the sitter is just a cartoon. The count is stated for the
 * same reason it is stated when planning a shot — a model given "the family" adds a figure.
 */
export function caricaturePrompt(input: {
  style: SketchStyle;
  subject: string;
  people: number;
}): string {
  const people = Math.max(0, Math.round(input.people));
  const cast =
    people === 0
      ? "There are no people in this photograph; draw the place itself."
      : people === 1
        ? "Exactly one person is in the drawing, and it is the person in the photograph — same face, same hair, same build, same clothing."
        : `Exactly ${people} people are in the drawing and no others. Each one is a real person in the photograph: match every face, hair, build, age and garment to the person it belongs to. Do not add a figure who is not there.`;

  return [
    `Draw ${SKETCH_DIRECTION[input.style]}.`,
    `Subject: ${limit(input.subject, 240)}.`,
    cast,
    "Keep the likeness above all else: somebody who knows them should recognise them immediately.",
    "Fill the frame with the drawing. No border, no mount, no frame, no signature, no caption, no lettering of any kind.",
    "It is a drawing on paper, not a photograph and not a photograph of a drawing.",
  ].join(" ");
}

// ── storybook ────────────────────────────────────────────────────────────────

export const STORYBOOK_SCHEMA = {
  type: "OBJECT",
  required: ["title", "dedication", "pages"],
  propertyOrdering: ["title", "dedication", "pages"],
  properties: {
    title: { type: "STRING", description: "Four words at most. No subtitle, no colon." },
    dedication: {
      type: "STRING",
      description: "One line for the inside cover, as a person would write it by hand.",
    },
    pages: {
      type: "ARRAY",
      minItems: 3,
      maxItems: 8,
      items: {
        type: "OBJECT",
        required: ["memory_id", "heading", "text"],
        propertyOrdering: ["memory_id", "heading", "text"],
        properties: {
          memory_id: { type: "STRING", description: "The id of the memory this page is about." },
          heading: { type: "STRING", description: "Three or four words. Not a sentence." },
          text: {
            type: "STRING",
            description: "Two or three sentences of prose for this page. No more.",
          },
        },
      },
    },
  },
} as const;

/**
 * Turn a set of memories into the pages of a storybook.
 *
 * Prose, not captions. A caption describes a photograph and a page tells you what it was like to
 * be there, so the instruction is about voice before it is about structure — and the owner's own
 * note is the truest sentence available, which is why it is handed over verbatim and why the model
 * is told to build on it rather than replace it.
 *
 * Ordering is the other half. Photographs arrive in whatever order they were taken; a book needs
 * an arrival, a middle and a last page, so the model is asked to sequence them and told what the
 * last page is for.
 */
export function storybookPrompt(input: {
  request: string;
  memories: {
    id: string;
    title: string;
    description: string;
    note: string;
    event: string | null;
    location: string | null;
    people: number;
    mood: string[];
  }[];
}): { system: string; user: string; schema: unknown } {
  const system = [
    "You write short storybooks from somebody's own photographs. You are writing for the person in them, and for whoever they hand the book to.",
    "",
    "Voice:",
    "- Prose, never captions. A caption says what is in the picture; a page says what it was like to be there.",
    "- Plain words. No 'embark', no 'tapestry', no 'testament to'. Nothing a person would not say out loud.",
    "- Present tense, and close in. Two or three sentences a page, and stop.",
    "- Their note about a photograph is the truest thing you have. Build on it; never contradict it.",
    "",
    "Structure:",
    "- Order the pages so the book arrives somewhere, rather than following the order the photographs came in.",
    "- One memory per page. Never invent a memory, a person, or a detail that is not in what you were given.",
    "- The last page is a closing, not a summary: leave the reader in the moment, not above it.",
    "- The title is four words at most and is not a description of a trip.",
  ].join("\n");

  const lines = input.memories.map((m) => {
    const where = [m.event, m.location].filter(Boolean).join(", ");
    return [
      `id: ${m.id}`,
      `  what it shows: ${limit(m.description, 200)}`,
      where ? `  where: ${where}` : "",
      m.people > 0 ? `  people in it: ${m.people}` : "  no people in it",
      m.mood.length ? `  feels: ${m.mood.slice(0, 3).join(", ")}` : "",
      m.note ? `  THEIR OWN NOTE: "${limit(m.note, 200)}"` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const user = [
    input.request ? `They asked for: ${limit(input.request, 200)}` : "They asked for a book of these memories.",
    "",
    `${input.memories.length} memories, each with an id you must use verbatim:`,
    lines.join("\n\n"),
    "",
    "Write the book.",
  ].join("\n");

  return { system, user, schema: STORYBOOK_SCHEMA };
}
