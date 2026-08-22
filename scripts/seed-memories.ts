/**
 * Seed the memory library with the photographs the committed film was made from.
 *
 * Two reasons this exists rather than being an import run on the demo machine.
 *
 * Enrichment routes on the ambient profile, and a machine with no budget left — or no key at
 * all, which is the point of a portable demo — takes the local route. That route cannot look at
 * a photograph: it titles the record after the filename, copies the context line into the
 * description, and splits the same line into tags. A gallery full of that reads as broken
 * software rather than as a memory library, and it is the first screen anybody sees.
 *
 * And a demo cannot depend on generating anything. The metadata below is written from the
 * photographs, committed, and restored on any machine, so the gallery is populated before the
 * app has made a single call.
 *
 * Idempotent: memories are addressed by the digest of their bytes, so running this twice adds
 * nothing. `--reset` clears the library first, which is how a run of placeholder records made
 * by the local route gets cleaned out.
 *
 *   npx tsx scripts/seed-memories.ts [--reset]
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { Memories } from "../src/lib/memory/store";
import { PATHS } from "../src/lib/core/paths";
import type { MemoryInsight } from "../src/lib/memory/types";

const SOURCE_PROJECT = process.env.MUSE_SEED_PROJECT ?? "prj_v0b74ybbt2ki";
const reset = process.argv.includes("--reset");

/**
 * Written from the photographs, in the voice the vision pass would use if it could see them:
 * present tense, only what is visible, no names, no guesses about who anybody is.
 */
interface Seed {
  match: string;
  note: string;
  insight: MemoryInsight;
}

const SEEDS: Seed[] = [
  {
    match: "IMG_9849",
    note: "The one morning the whole range came out. We had been waiting three days for this.",
    insight: {
      title: "The three of us under Kanchenjunga",
      description:
        "three people stand close together at a roadside railing, the snow range behind them catching " +
        "first light; an older man in a blue and black jacket, a young man in a cream hooded sweatshirt, " +
        "a woman in an olive quilted coat and round sunglasses",
      people: ["an older man in a blue and black jacket", "a young man in a cream hooded sweatshirt", "a woman in an olive quilted coat"],
      setting: "a roadside viewpoint above a valley, snow peaks on the horizon",
      location: "Gangtok, Sikkim",
      event: "winter family trip",
      activities: ["standing together for a photograph", "looking at the mountains"],
      objects: ["metal crash barrier", "bare winter tree", "snow range"],
      mood: ["still", "proud", "cold and bright"],
      tags: ["family", "mountains", "kanchenjunga", "winter", "portrait", "sikkim"],
      visualQuality: 0.94,
    },
  },
  {
    match: "IMG_9893",
    note: "Freezing. My hands were in my sleeves the whole time.",
    insight: {
      title: "Alone on the forest road",
      description:
        "a young man in a cream hooded sweatshirt and black cargo trousers stands on a gravel verge, " +
        "arms folded, a steep pine slope rising behind him into low cloud",
      people: ["a young man in a cream hooded sweatshirt"],
      setting: "a mountain road cut into a pine slope, mist sitting on the ridge",
      location: "Gangtok, Sikkim",
      event: "winter family trip",
      activities: ["standing on the verge", "waiting out the cold"],
      objects: ["pine forest", "green roofed sheds", "parked cars", "low cloud"],
      mood: ["quiet", "grey", "patient"],
      tags: ["portrait", "forest", "road", "winter", "mist", "sikkim"],
      visualQuality: 0.88,
    },
  },
  {
    match: "IMG_9907",
    note: "The valley filled with cloud below us while we watched.",
    insight: {
      title: "Cloud coming up the valley",
      description:
        "a wide view down a forested valley with cloud lying along the floor, ridgelines fading " +
        "paler into the distance and a warm band of light along the top of the sky",
      people: [],
      setting: "a high viewpoint over a forested valley, cloud below the treeline",
      location: "Sikkim",
      event: "winter family trip",
      activities: ["watching the weather move"],
      objects: ["pine ridges", "valley cloud", "distant peaks"],
      mood: ["vast", "calm", "cold"],
      tags: ["landscape", "valley", "cloud", "mountains", "wide", "sikkim"],
      visualQuality: 0.9,
    },
  },
  {
    match: "IMG_9969",
    note: "Last morning before the drive back down.",
    insight: {
      title: "The last morning",
      description:
        "a hillside town in early light, low buildings stacked along the contour with terraced " +
        "ground below and mountains standing behind the roofline",
      people: [],
      setting: "a hill town in the early morning, terraces below the houses",
      location: "Gangtok, Sikkim",
      event: "winter family trip",
      activities: ["leaving", "looking back at the town"],
      objects: ["hillside houses", "terraced fields", "mountain ridge"],
      mood: ["ending", "soft", "early"],
      tags: ["town", "morning", "hills", "terraces", "winter", "sikkim"],
      visualQuality: 0.85,
    },
  },
  {
    match: "02C48E4D",
    note: "Somewhere on the road up. I do not remember stopping here.",
    insight: {
      title: "A stop on the way up",
      description:
        "a moment from the drive into the hills, road and slope and winter scrub, the light flat " +
        "under cloud",
      people: [],
      setting: "the road up into the hills, winter scrub on the verge",
      location: "Sikkim",
      event: "winter family trip",
      activities: ["driving up", "stopping on the way"],
      objects: ["hill road", "winter scrub", "cloud"],
      mood: ["in transit", "overcast"],
      tags: ["road", "drive", "hills", "winter", "sikkim"],
      visualQuality: 0.72,
    },
  },
];

function sourceFiles(): string[] {
  const dir = path.join(PATHS.assets, SOURCE_PROJECT);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("upload_image-"))
    .map((f) => path.join(dir, f));
}

if (reset) {
  const cleared = Memories.list();
  for (const m of cleared) Memories.remove(m.id);
  console.log(`  cleared ${cleared.length} existing memor${cleared.length === 1 ? "y" : "ies"}`);
}

const files = sourceFiles();
if (files.length === 0) {
  console.error(`  no uploads found for ${SOURCE_PROJECT}; run demo:restore first`);
  process.exit(1);
}

let added = 0;
let already = 0;
let unmatched = 0;

for (const seed of SEEDS) {
  const file = files.find((f) => path.basename(f).includes(seed.match));
  if (!file) {
    unmatched++;
    console.log(`  no photograph matching ${seed.match}; skipped`);
    continue;
  }
  const bytes = fs.readFileSync(file);
  const before = Memories.list().length;
  const record = Memories.create({
    bytes,
    mime: file.endsWith(".png") ? "image/png" : "image/jpeg",
    originalName: path.basename(file),
    insight: seed.insight,
    userNote: seed.note,
    context: "winter family trip to Gangtok, Sikkim",
    // Written by hand from the photographs, so it claims the local route rather than
    // pretending a model looked at them.
    route: "local",
  });
  if (Memories.list().length > before) {
    added++;
    console.log(`  ${record.id}  ${seed.insight.title}`);
  } else {
    already++;
  }
}

console.log(`\n  added ${added}, already present ${already}${unmatched ? `, unmatched ${unmatched}` : ""}`);
console.log(`  the library now holds ${Memories.list().length} memories`);
