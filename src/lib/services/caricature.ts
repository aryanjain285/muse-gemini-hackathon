/**
 * The sketch stand: a drawing made from a photograph.
 *
 * Routed like every other model call, which is what makes it demonstrable. With a key and a
 * budget the image model draws it; without either, ffmpeg does — and the local path is a real
 * drawing rather than a placeholder, because a feature that shows nothing when the key is absent
 * cannot be shown at all.
 *
 * The result is written into the memory media directory, which is already a served root, so the
 * browser reaches it by the same URL shape as the photograph it was drawn from.
 */
import fs from "node:fs";
import path from "node:path";

import { LIMITS } from "@/lib/core/config";
import { PATHS } from "@/lib/core/paths";
import { sha256 } from "@/lib/core/util";
import { logger } from "@/lib/core/logger";
import { generateImage } from "@/lib/models/adapters";
import { mediaCodec, route } from "@/lib/models/router";
import { caricaturePrompt, SKETCH_STYLES, type SketchStyle } from "@/lib/templates/prompts";
import { exec as runFfmpeg } from "@/lib/visual/ffmpegExec";
import type { Profile } from "@/lib/core/config";

export interface SketchResult {
  /** Path relative to the served memories root, e.g. "mem_x-pencil.png". */
  file: string;
  route: string;
  usd: number;
  cached: boolean;
}

/**
 * ffmpeg filter chains that read as drawing rather than as a filter.
 *
 * Each ends by compositing onto a paper tone, because what makes a sketch legible as a sketch is
 * the paper showing through — a pure white ground reads as a scan of a document instead.
 */
const LOCAL_DRAWING: Record<SketchStyle, string> = {
  // Edges from a blurred difference, inverted so the line is dark on light, then softened so
  // the stroke has a graphite edge rather than a digital one.
  pencil:
    "format=gray,gblur=sigma=0.6,edgedetect=low=0.06:high=0.22,negate," +
    "eq=contrast=1.18:brightness=0.06,gblur=sigma=0.35," +
    "colorlevels=rimin=0.04:gimin=0.04:bimin=0.02:rimax=0.98:gimax=0.97:bimax=0.94",
  // Fewer tones and a heavier line: closer to a printed cartoon.
  caricature:
    "format=gray,gblur=sigma=0.9,edgedetect=low=0.05:high=0.18,negate," +
    "eq=contrast=1.5:brightness=0.02,gblur=sigma=0.5," +
    "colorlevels=rimax=0.99:gimax=0.95:bimax=0.86",
  // Hard threshold, no grey at all.
  ink:
    "format=gray,gblur=sigma=1.1,edgedetect=low=0.04:high=0.14,negate," +
    "eq=contrast=2.6:brightness=-0.04,colorlevels=rimin=0.30:gimin=0.30:bimin=0.30",
  // Keeps the colour, drops the detail, lets the tones pool.
  watercolour:
    "gblur=sigma=1.6,eq=saturation=1.28:contrast=0.94:brightness=0.05," +
    "colorlevels=rimin=0.03:gimin=0.03:bimin=0.03:rimax=0.96:gimax=0.96:bimax=0.92," +
    "unsharp=5:5:0.6",
};

/** Draw one photograph. */
export async function makeSketch(input: {
  /** Used for the output filename and the cache identity. */
  key: string;
  sourcePath: string;
  mime: string;
  style: SketchStyle;
  /** What is in the photograph, so the model draws the right thing. */
  subject: string;
  people: number;
  profile: Profile;
  deadlineAt?: number;
}): Promise<SketchResult> {
  const log = logger({ template: `sketch:${input.style}` });
  const dir = path.join(PATHS.memories, "media");
  fs.mkdirSync(dir, { recursive: true });

  const file = `${input.key}-${input.style}.png`;
  const outPath = path.join(dir, file);
  const source = fs.readFileSync(input.sourcePath);
  const prompt = caricaturePrompt({
    style: input.style,
    subject: input.subject,
    people: input.people,
  });

  const result = await route<{ bytes: Buffer; mime: string }>({
    task: "keyframe",
    projectId: null,
    identity: {
      kind: "sketch-v1",
      style: input.style,
      prompt,
      source: sha256(source),
    },
    hint: { images: 1, inputTokens: 300 },
    codec: mediaCodec<{ bytes: Buffer; mime: string }>(),
    profile: input.profile,
    deadlineAt: input.deadlineAt,
    logger: log,
    real: async (model) =>
      generateImage({
        model,
        prompt,
        references: [{ bytes: source, mime: input.mime, label: "the photograph to draw from" }],
        // Drawings are shown on a stand rather than as a reel, so they are square-ish rather
        // than vertical: a portrait crop would cut the people out of a group photograph.
        aspectRatio: "1:1",
        imageSize: "1K",
        timeoutMs: LIMITS.timeoutMs.keyframe,
      }),
    local: async () => {
      await runFfmpeg("ffmpeg", [
        "-y",
        "-i",
        input.sourcePath,
        "-vf",
        `scale=1024:-1,${LOCAL_DRAWING[input.style]},crop=1024:min(1024\\,ih):0:(ih-min(1024\\,ih))/2`,
        "-frames:v",
        "1",
        outPath,
      ]);
      return { bytes: fs.readFileSync(outPath), mime: "image/png" };
    },
  });

  // The real route returns bytes it has not written anywhere; the local route wrote the file
  // itself and reading it back costs nothing, so both end with the file on disk.
  fs.writeFileSync(outPath, result.value.bytes);

  return { file, route: result.route, usd: result.usd, cached: result.cached };
}

export interface ExistingSketch {
  memoryId: string;
  style: SketchStyle;
  /** Browser URL, already under a served root. */
  url: string;
}

/**
 * Drawings that have already been made.
 *
 * The studio only ever showed a drawing it had just produced, so opening it presented a blank
 * canvas and nine finished drawings sitting on disk unmentioned — and pressing the button to see
 * one you already had looked like it was working rather than remembering. The filename carries
 * both the memory and the hand it was drawn in, so the directory listing is the index.
 */
export function existingSketches(): ExistingSketch[] {
  const dir = path.join(PATHS.memories, "media");
  if (!fs.existsSync(dir)) return [];
  const found: ExistingSketch[] = [];
  for (const name of fs.readdirSync(dir)) {
    const match = /^(mem_[a-z0-9]+)-([a-z]+)\.png$/i.exec(name);
    if (!match) continue;
    const style = SKETCH_STYLES.find((s) => s === match[2]);
    if (!style) continue;
    found.push({ memoryId: match[1], style, url: `/api/assets/memories/${name}` });
  }
  return found;
}
