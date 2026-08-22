/**
 * One-time shape discovery against the live API.
 *
 * Records the exact response envelope for image, music and video generation so
 * the adapters can be written against fact rather than assumption, and saves the
 * returned media into `workspace/reference/` where it doubles as recovery
 * material for the deterministic engine.
 *
 * Run:  npx tsx scripts/probe-shapes.ts [image|music|video|all]
 *
 * This is deliberately a script and not a test: it costs real money. Roughly
 * $0.07 for the image, $0.04 for the music clip and $0.20 for a 4s video.
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error("GEMINI_API_KEY missing; put it in .env.local");
  process.exit(1);
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const OUT = path.join(process.cwd(), "workspace", "reference");
const SHAPES = path.join(OUT, "shapes");
fs.mkdirSync(SHAPES, { recursive: true });

/** Save a response with binary parts elided so the envelope stays readable. */
function saveShape(name: string, body: unknown, response: unknown) {
  const elide = (v: unknown, depth = 0): unknown => {
    if (depth > 10) return "[deep]";
    if (typeof v === "string") return v.length > 240 ? `[str ${v.length}b]` : v;
    if (Array.isArray(v)) return v.map((x) => elide(x, depth + 1));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = elide(val, depth + 1);
      return o;
    }
    return v;
  };
  fs.writeFileSync(
    path.join(SHAPES, `${name}.json`),
    JSON.stringify({ request: elide(body), response: elide(response) }, null, 2),
    "utf8",
  );
  console.log(`  shape -> workspace/reference/shapes/${name}.json`);
}

async function post(urlPath: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${urlPath}?key=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${res.status}: ${json?.error?.message ?? text.slice(0, 300)}`);
  return json;
}

async function get(urlPath: string): Promise<any> {
  const res = await fetch(`${BASE}${urlPath}?key=${KEY}`);
  const text = await res.text();
  const json = JSON.parse(text);
  if (!res.ok) throw new Error(`${res.status}: ${json?.error?.message ?? text.slice(0, 300)}`);
  return json;
}

/** Walk a response and pull out every inline binary part we can find. */
function collectInline(node: unknown, found: { mime: string; data: string; at: string }[] = [], at = "$"): typeof found {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectInline(v, found, `${at}[${i}]`));
    return found;
  }
  const o = node as Record<string, any>;
  if (typeof o.data === "string" && typeof o.mimeType === "string") {
    found.push({ mime: o.mimeType, data: o.data, at });
  }
  if (typeof o.bytesBase64Encoded === "string") {
    found.push({ mime: o.mimeType ?? "application/octet-stream", data: o.bytesBase64Encoded, at });
  }
  for (const [k, v] of Object.entries(o)) collectInline(v, found, `${at}.${k}`);
  return found;
}

function collectUris(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach((v) => collectUris(v, found));
    return found;
  }
  for (const [k, v] of Object.entries(node as Record<string, any>)) {
    if ((k === "uri" || k === "fileUri" || k === "videoUri") && typeof v === "string") found.push(v);
    else collectUris(v, found);
  }
  return found;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/L16": "pcm",
  "video/mp4": "mp4",
};

function ext(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return EXT[base] ?? "bin";
}

// ── image ────────────────────────────────────────────────────────────────────

const KEYFRAME_PROMPT = `A painterly illustrated vertical portrait: a young person standing at the edge of a
rooftop at golden hour, wind in their hair, looking out over a soft-focus city of warm terracotta
rooftops. Loose gouache brushwork with visible texture, warm sunset palette of amber and rose with
deep blue shadows, soft greens in distant trees. Cinematic low-angle light with gentle halation.
Medium-wide shot, subject centred in the lower two-thirds, generous sky above.
No text, no watermark, no duplicate limbs, no distorted hands.`;

async function probeImage() {
  console.log("\n[image] gemini-3.1-flash-image @ 1K, 9:16");
  const body = {
    contents: [{ parts: [{ text: KEYFRAME_PROMPT }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "9:16", imageSize: "1K" },
    },
  };
  const res = await post("/models/gemini-3.1-flash-image:generateContent", body);
  saveShape("image", body, res);
  console.log("  usage:", JSON.stringify(res.usageMetadata ?? {}));
  const parts = collectInline(res);
  for (const [i, p] of parts.entries()) {
    const buf = Buffer.from(p.data, "base64");
    const file = path.join(OUT, `keyframe-probe-${i}.${ext(p.mime)}`);
    fs.writeFileSync(file, buf);
    console.log(`  ${p.at} -> ${path.relative(process.cwd(), file)} (${p.mime}, ${buf.length}b)`);
  }
  if (parts.length === 0) console.log("  no inline media found; check the shape file");
}

// ── music ────────────────────────────────────────────────────────────────────

const MUSIC_PROMPT = `Instrumental only, no vocals. 118 BPM, A minor. Dreamy electronic and orchestral
hybrid for a 30 second vertical film. Structure: sparse warm pad and single piano note for the first
4 seconds; soft percussion enters around 3.5 seconds; density and brightness rise from 11 to 15
seconds; the strongest euphoric drop lands at 15 seconds with a wide arpeggio and sub bass; energy
holds to 25 seconds; resolve into a warm sustained chord after 25 seconds; a clean final hit and
tail by 30 seconds. Nostalgic turning euphoric turning warm. No speech, no vocal samples.`;

async function probeMusic() {
  console.log("\n[music] lyria-3-clip-preview");
  const body = {
    contents: [{ parts: [{ text: MUSIC_PROMPT }] }],
  };
  const res = await post("/models/lyria-3-clip-preview:generateContent", body);
  saveShape("music", body, res);
  console.log("  usage:", JSON.stringify(res.usageMetadata ?? {}));
  const parts = collectInline(res);
  for (const [i, p] of parts.entries()) {
    const buf = Buffer.from(p.data, "base64");
    const file = path.join(OUT, `soundtrack-probe-${i}.${ext(p.mime)}`);
    fs.writeFileSync(file, buf);
    console.log(`  ${p.at} -> ${path.relative(process.cwd(), file)} (${p.mime}, ${buf.length}b)`);
  }
  const uris = collectUris(res);
  if (uris.length) console.log("  uris:", uris);
  if (parts.length === 0 && uris.length === 0) {
    console.log("  no media found. Full text response follows:");
    console.log("  ", JSON.stringify(res).slice(0, 1200));
  }
}

// ── video ────────────────────────────────────────────────────────────────────

async function probeVideo() {
  console.log("\n[video] veo-3.1-lite-generate-preview, 4s 720p 9:16, image-to-video");
  // Prefer animating the keyframe the image probe just produced, which is also
  // the real production path.
  const candidates = fs
    .readdirSync(OUT)
    .filter((f) => f.startsWith("keyframe-probe") && /\.(png|jpg|webp)$/.test(f));
  const instance: Record<string, unknown> = {
    prompt:
      "Slow cinematic dolly out. The wind moves the subject's hair and the distant clouds drift. " +
      "Painterly gouache texture is preserved. No camera shake, no morphing faces.",
  };
  if (candidates[0]) {
    const file = path.join(OUT, candidates[0]);
    instance.image = {
      bytesBase64Encoded: fs.readFileSync(file).toString("base64"),
      mimeType: candidates[0].endsWith(".png") ? "image/png" : "image/jpeg",
    };
    console.log(`  seeding from ${candidates[0]}`);
  } else {
    console.log("  no keyframe available; running text-to-video instead");
  }

  const body = {
    instances: [instance],
    parameters: { aspectRatio: "9:16", durationSeconds: 4, resolution: "720p", sampleCount: 1 },
  };
  const op = await post("/models/veo-3.1-lite-generate-preview:predictLongRunning", body);
  console.log("  operation:", op.name);

  const started = Date.now();
  let current = op;
  while (!current.done) {
    if (Date.now() - started > 8 * 60_000) throw new Error("video operation timed out");
    await new Promise((r) => setTimeout(r, 6000));
    current = await get(`/${current.name}`);
    process.stdout.write(`  polling ${Math.round((Date.now() - started) / 1000)}s\r`);
  }
  console.log("");
  saveShape("video", body, current);
  if (current.error) throw new Error(`operation failed: ${JSON.stringify(current.error)}`);

  const parts = collectInline(current);
  for (const [i, p] of parts.entries()) {
    const buf = Buffer.from(p.data, "base64");
    const file = path.join(OUT, `hero-probe-${i}.${ext(p.mime)}`);
    fs.writeFileSync(file, buf);
    console.log(`  ${p.at} -> ${path.relative(process.cwd(), file)} (${p.mime}, ${buf.length}b)`);
  }
  const uris = collectUris(current);
  for (const [i, uri] of uris.entries()) {
    console.log(`  uri: ${uri.slice(0, 120)}`);
    const res = await fetch(uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${KEY}`);
    if (!res.ok) {
      console.log(`    download failed ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const file = path.join(OUT, `hero-probe-uri-${i}.mp4`);
    fs.writeFileSync(file, buf);
    console.log(`    -> ${path.relative(process.cwd(), file)} (${buf.length}b)`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const which = (process.argv[2] ?? "all").toLowerCase();
  const run = async (name: string, fn: () => Promise<void>) => {
    if (which !== "all" && which !== name) return;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await run("image", probeImage);
  await run("music", probeMusic);
  await run("video", probeVideo);
  console.log("\nDone. Shapes in workspace/reference/shapes, media in workspace/reference.");
}

void main();
