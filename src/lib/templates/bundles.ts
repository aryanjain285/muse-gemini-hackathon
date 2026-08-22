/**
 * The four shipped presets.
 *
 * Each bundle is a different film, not a recolour: the medium, the camera
 * language, the transition vocabulary, the beat lengths and the music all change
 * together. That separation is what makes the preset picker feel like a choice of
 * director rather than a choice of filter.
 *
 * Beat skeletons cover 0 to 30s contiguously and place exactly one hero_drop at
 * 15s, which is where every music brief puts the drop. The Director may move a
 * boundary slightly, but starting from a timeline that already works means one
 * malformed model response can never cost a render.
 */
import type { TemplateBundle } from "./types";

/** Re-exported so callers can take a bundle without importing two modules. */
export type { TemplateBundle } from "./types";

/** The preset used when none was chosen, and the primary demo preset. */
export const DEFAULT_BUNDLE_ID = "dreamy_animated_memories";

const dreamyAnimatedMemories: TemplateBundle = {
  id: "dreamy_animated_memories",
  label: "Dreamy Animated Memories",
  blurb: "Painterly gouache, golden-hour light, a memory remembered warmer than it was.",
  versions: {
    director: 1,
    styleBible: 1,
    scenePrompt: 1,
    criticRubric: 1,
    transitionPolicy: 1,
    musicPolicy: 1,
  },
  styleBible: {
    preset: "dreamy_animated_memories",
    medium:
      "loose gouache painting with visible brush strokes and softly blended colour",
    palette: [
      "warm amber and rose sunset",
      "deep blue-violet shadows",
      "soft sage green in distant foliage",
      "sun-bleached terracotta",
      "milky cream highlights",
    ],
    lighting: "cinematic low-angle golden-hour light with gentle halation and soft falloff",
    character_rules: [
      "one protagonist appears in every scene with the same face, hair length and build",
      "wardrobe is identical from the first scene to the last",
      "the face stays readable in at least three-quarter profile",
    ],
    negative_rules: [
      "no photographic realism",
      "no plastic 3D render sheen",
      "no clipped white highlights",
      "no hard black outlines",
    ],
    grain: 0.32,
  },
  beats: [
    {
      atS: 0,
      endS: 4.5,
      purpose: "recognition",
      renderMode: "source_motion",
      camera: "push_in",
      transitionIn: "cut",
      intent: "Open on the subject as they really are, barely moving, so the face lands first.",
    },
    {
      atS: 4.5,
      endS: 9.5,
      purpose: "world_opens",
      renderMode: "stylized_keyframe",
      camera: "parallax_drift",
      transitionIn: "crossfade",
      intent: "The world becomes a painting and widens out around the subject.",
    },
    {
      atS: 9.5,
      endS: 13,
      purpose: "motion_begins",
      renderMode: "image_to_video",
      camera: "tilt_up",
      transitionIn: "luma_wipe",
      intent: "First real movement: hair, cloth and light begin to travel.",
    },
    {
      atS: 13,
      endS: 15,
      purpose: "build",
      renderMode: "stylized_keyframe",
      camera: "push_in",
      transitionIn: "match_cut",
      intent: "Two seconds of held breath, closer and brighter, one beat from the drop.",
    },
    {
      atS: 15,
      endS: 21,
      purpose: "hero_drop",
      renderMode: "text_reference_video",
      camera: "pull_out",
      transitionIn: "flash",
      intent: "The image the whole film exists for: the widest, warmest, most alive moment.",
    },
    {
      atS: 21,
      endS: 25.5,
      purpose: "variation",
      renderMode: "collage",
      camera: "parallax_drift",
      transitionIn: "dip_to_white",
      intent: "Fragments of the same memory layered together while the energy holds.",
    },
    {
      atS: 25.5,
      endS: 30,
      purpose: "resolution",
      renderMode: "stylized_keyframe",
      camera: "dolly_out",
      transitionIn: "crossfade",
      intent: "Letting go: the subject settles, the light cools, the frame breathes out.",
    },
  ],
  music: {
    bpm: 124,
    key: "A minor",
    mood: "intimate turning driving turning euphoric",
    instrumentation: [
      "felt piano",
      "bright arpeggiated synth",
      "four-on-the-floor kick",
      "layered handclaps",
      "sub bass",
      "string swell",
    ],
    // The opening stays sparse on purpose: contrast is what makes a drop land, and a
    // track that is busy from the first bar has nowhere to go by fifteen seconds. What
    // was missing is everything after the build. "Euphoric rather than aggressive"
    // produced a score with no rhythm section at all, so the film had nothing to cut
    // against and the reel felt slow however well the cuts were placed.
    notes:
      "Sparse and intimate for the first four seconds, one felt piano note at a time over a warm pad. From eleven seconds a four-on-the-floor kick enters under the piano and the arpeggio doubles in rate, building real momentum into the drop. The drop at fifteen seconds is big and euphoric: full kick, handclaps on the offbeat, a wide bright arpeggio over sub bass and soaring strings. Keep that energy through the variation, then pull the drums out at twenty-five seconds and resolve into one sustained warm chord that decays into the tail.",
  },
  transitions: ["crossfade", "luma_wipe", "dip_to_white", "match_cut", "flash", "cut"],
  swatches: ["#F6B26B", "#E8788A", "#8FA37A", "#243B5A", "#C96A4B", "#FBEBD2"],
  grade: { warmth: 0.28, contrast: 0.12, saturation: 0.1, lift: 0.06 },
};

const neonAnime: TemplateBundle = {
  id: "neon_anime",
  label: "Neon Anime",
  blurb: "Cel-shaded, rim-lit, magenta and cyan on near-black. Cuts hit like drums.",
  versions: {
    director: 1,
    styleBible: 1,
    scenePrompt: 1,
    criticRubric: 1,
    transitionPolicy: 1,
    musicPolicy: 1,
  },
  styleBible: {
    preset: "neon_anime",
    medium:
      "cel-shaded anime illustration with hard ink outlines, flat blocked shadows and speed lines behind anything moving",
    palette: [
      "saturated magenta",
      "electric cyan",
      "near-black indigo ground",
      "hot white rim light",
      "acid violet bloom",
    ],
    lighting:
      "hard cyan rim light from behind with a magenta key from low left, shadows crushed to near-black",
    character_rules: [
      "one protagonist with an unchanging silhouette, hair shape and jacket",
      "eye shape and eye colour never change between scenes",
      "the rim light always comes from behind the protagonist",
    ],
    negative_rules: [
      "no muddy or desaturated colour",
      "no watercolour or airbrush softness",
      "no 3D CGI shading",
      "no flat daylight ambience",
    ],
    grain: 0.14,
  },
  beats: [
    {
      atS: 0,
      endS: 4,
      purpose: "recognition",
      renderMode: "stylized_keyframe",
      camera: "static",
      transitionIn: "cut",
      intent: "Locked-off hero pose, eyes to camera, rim light already burning.",
    },
    {
      atS: 4,
      endS: 9,
      purpose: "world_opens",
      renderMode: "stylized_keyframe",
      camera: "whip",
      transitionIn: "whip_pan",
      intent: "Snap to the city: neon signage, wet asphalt, the scale of the place.",
    },
    {
      atS: 9,
      endS: 15,
      purpose: "build",
      renderMode: "collage",
      camera: "pan_left",
      transitionIn: "flash",
      intent: "Escalating montage of speed lines and eye-flashes, cuts shortening into the drop.",
    },
    {
      atS: 15,
      endS: 21.6,
      purpose: "hero_drop",
      renderMode: "text_reference_video",
      camera: "whip",
      transitionIn: "flash",
      intent: "Full power: the protagonist mid-leap, coat and hair thrown by the impact.",
    },
    {
      atS: 21.6,
      endS: 26.4,
      purpose: "variation",
      renderMode: "image_to_video",
      camera: "handheld_drift",
      transitionIn: "whip_pan",
      intent: "Aftermath at street level, energy still crawling over every surface.",
    },
    {
      atS: 26.4,
      endS: 30,
      purpose: "resolution",
      renderMode: "stylized_keyframe",
      camera: "pull_out",
      transitionIn: "dip_to_black",
      intent: "One held frame, then out: the protagonist small against the skyline.",
    },
  ],
  music: {
    bpm: 152,
    key: "F# minor",
    mood: "defiant turning electric turning triumphant",
    instrumentation: [
      "distorted saw lead",
      "gated drums",
      "808 sub",
      "orchestral hit",
      "arpeggiated synth",
      "taiko fill",
    ],
    notes:
      "Start on a single filtered arpeggio with no drums at all. Four bars of riser into fifteen seconds. The drop is a hard downbeat with a taiko fill and the lead an octave up. Cut everything for one silent beat near twenty-six seconds, then the final hit.",
  },
  transitions: ["whip_pan", "flash", "cut", "match_cut", "luma_wipe", "dip_to_black"],
  swatches: ["#FF2D95", "#12E2F2", "#0B0B14", "#F5F7FF", "#7A2BFF"],
  grade: { warmth: -0.12, contrast: 0.34, saturation: 0.3, lift: -0.06 },
};

const retro90s: TemplateBundle = {
  id: "retro_90s",
  label: "Retro 90s",
  blurb: "Grainy 35mm, halation, faded Kodak colour. Looks found rather than made.",
  versions: {
    director: 1,
    styleBible: 1,
    scenePrompt: 1,
    criticRubric: 1,
    transitionPolicy: 1,
    musicPolicy: 1,
  },
  styleBible: {
    preset: "retro_90s",
    medium:
      "grainy 1990s 35mm film photograph with halation around the highlights and faint gate weave, framed as though cropped from a 4:3 negative into the tall frame",
    palette: [
      "faded Kodak Gold amber",
      "washed teal shadows",
      "milky cream highlights",
      "dusty brick red",
      "grey-green olive",
    ],
    lighting: "flat overcast daylight with one blown window highlight blooming into the frame",
    character_rules: [
      "one protagonist in the same period clothing in every scene",
      "hair length, build and skin tone never change",
      "lit by available light only, never by a camera flash",
    ],
    negative_rules: [
      "no digital sharpening",
      "no modern phones, screens or brand logos",
      "no clean vector edges",
      "no HDR contrast",
      "no saturation boost",
    ],
    grain: 0.74,
  },
  beats: [
    {
      atS: 0,
      endS: 6,
      purpose: "recognition",
      renderMode: "source_motion",
      camera: "static",
      transitionIn: "cut",
      intent: "A photograph held long enough to feel remembered rather than shown.",
    },
    {
      atS: 6,
      endS: 11.5,
      purpose: "world_opens",
      renderMode: "stylized_keyframe",
      camera: "handheld_drift",
      transitionIn: "film_burn",
      intent: "The camcorder finds the room: cheap wallpaper, a window, dust in the light.",
    },
    {
      atS: 11.5,
      endS: 15,
      purpose: "build",
      renderMode: "stylized_keyframe",
      camera: "tilt_down",
      transitionIn: "dip_to_white",
      intent: "Exposure climbs and grain thickens; the frame runs hot toward the drop.",
    },
    {
      atS: 15,
      endS: 22.5,
      purpose: "hero_drop",
      renderMode: "image_to_video",
      camera: "pull_out",
      transitionIn: "flash",
      intent: "The summer-afternoon shot: bleached, wide, everyone in it forever.",
    },
    {
      atS: 22.5,
      endS: 30,
      purpose: "resolution",
      renderMode: "source_motion",
      camera: "static",
      transitionIn: "film_burn",
      intent: "The reel runs out on a quiet frame and the emulsion burns away.",
    },
  ],
  music: {
    bpm: 96,
    key: "D minor",
    mood: "hazy turning wistful turning warm",
    instrumentation: [
      "tape-saturated drum break",
      "muted electric guitar",
      "Rhodes piano",
      "upright bass",
      "radio static texture",
    ],
    notes:
      "Cassette-warm throughout: slight wow and flutter, top end rolled off. Let the drum break enter alone before anything harmonic arrives. The lift at fifteen seconds widens the existing loop instead of starting a new section. End on a tape stop.",
  },
  transitions: ["film_burn", "dip_to_white", "cut", "crossfade", "dip_to_black", "flash"],
  swatches: ["#D9A661", "#4E6E6B", "#EFE3CB", "#A8523C", "#2E2A26"],
  grade: { warmth: 0.18, contrast: -0.08, saturation: -0.22, lift: 0.12 },
};

const paperCollage: TemplateBundle = {
  id: "paper_collage",
  label: "Paper Collage",
  blurb: "Torn paper, matte colour, visible fibre. Everything snaps like stop-motion.",
  versions: {
    director: 1,
    styleBible: 1,
    scenePrompt: 1,
    criticRubric: 1,
    transitionPolicy: 1,
    musicPolicy: 1,
  },
  styleBible: {
    preset: "paper_collage",
    medium:
      "cut-paper collage with torn deckled edges, matte flat colour, visible paper fibre and one small hard drop shadow under every layer",
    palette: [
      "muted primary red",
      "chalk ochre yellow",
      "slate cobalt blue",
      "bone white ground",
      "moss green",
    ],
    lighting: "even soft studio light from above left, one short crisp shadow per paper layer",
    character_rules: [
      "the protagonist is built from the same cut shapes in every scene",
      "the face is a simple paper cut-out with no rendered detail",
      "layer order never changes: ground, setting, protagonist, foreground scrap",
    ],
    negative_rules: [
      "no gradients or airbrushed shading",
      "no glossy or plastic surfaces",
      "no photographic depth of field",
      "no rendered facial detail",
    ],
    grain: 0.42,
  },
  beats: [
    {
      atS: 0,
      endS: 4.5,
      purpose: "recognition",
      renderMode: "source_motion",
      camera: "static",
      transitionIn: "cut",
      intent: "One flat pasted figure on bone white, dead centre, held like a title card.",
    },
    {
      atS: 4.5,
      endS: 9.5,
      purpose: "world_opens",
      renderMode: "stylized_keyframe",
      camera: "parallax_drift",
      transitionIn: "match_cut",
      intent: "Paper layers slide apart and a whole cut-out landscape appears behind the figure.",
    },
    {
      atS: 9.5,
      endS: 15,
      purpose: "build",
      renderMode: "stylized_keyframe",
      camera: "pan_right",
      transitionIn: "luma_wipe",
      intent: "More scraps arrive on every beat until the frame is crowded and about to burst.",
    },
    {
      atS: 15,
      endS: 21,
      purpose: "hero_drop",
      renderMode: "image_to_video",
      camera: "dolly_out",
      transitionIn: "luma_wipe",
      intent: "Every layer lands at once into one bold, symmetrical, poster-clean composition.",
    },
    {
      atS: 21,
      endS: 25.5,
      purpose: "variation",
      renderMode: "collage",
      camera: "tilt_up",
      transitionIn: "match_cut",
      intent: "The same shapes rearranged into a second idea, as if a hand had moved them.",
    },
    {
      atS: 25.5,
      endS: 30,
      purpose: "resolution",
      renderMode: "stylized_keyframe",
      camera: "static",
      transitionIn: "crossfade",
      intent: "Scraps are lifted away one by one until only the figure and the ground remain.",
    },
  ],
  music: {
    bpm: 108,
    key: "G major",
    mood: "playful turning bright turning content",
    instrumentation: [
      "pizzicato strings",
      "marimba",
      "hand claps",
      "toy piano",
      "shaker and kick",
      "bowed saw",
    ],
    notes:
      "Everything staccato and hand-made; nothing sustains longer than a bar. Build by adding one instrument at a time so each new layer is audible. The drop is the whole ensemble on the downbeat with the claps doubled. Finish on a single marimba note and room silence.",
  },
  transitions: ["match_cut", "luma_wipe", "cut", "crossfade", "dip_to_white", "whip_pan"],
  swatches: ["#C8483C", "#E0B247", "#3B5C93", "#F2EDE2", "#5C7A52"],
  grade: { warmth: 0.06, contrast: 0.16, saturation: -0.05, lift: 0.08 },
};

/** Every shipped preset, keyed by id. */
export const BUNDLES: Record<string, TemplateBundle> = {
  [dreamyAnimatedMemories.id]: dreamyAnimatedMemories,
  [neonAnime.id]: neonAnime,
  [retro90s.id]: retro90s,
  [paperCollage.id]: paperCollage,
};

/**
 * Look up a preset. An unknown id means a stale link or an old persisted
 * project, neither of which should be able to fail a render, so this falls back
 * to the default instead of throwing.
 */
export function getBundle(id: string): TemplateBundle {
  return BUNDLES[id] ?? BUNDLES[DEFAULT_BUNDLE_ID];
}

/** Presets in picker order: the default first, then the rest alphabetically. */
export function listBundles(): TemplateBundle[] {
  const rest = Object.keys(BUNDLES)
    .filter((k) => k !== DEFAULT_BUNDLE_ID)
    .sort();
  return [BUNDLES[DEFAULT_BUNDLE_ID], ...rest.map((k) => BUNDLES[k])];
}
