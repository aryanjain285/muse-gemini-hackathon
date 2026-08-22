/**
 * Provider adapters. Each turns a MUSE-shaped request into a Gemini call and
 * normalises the response, so nothing above this layer knows a wire format.
 *
 * The request and response shapes here were verified against the live API rather
 * than inferred; `workspace/reference/shapes/*.json` holds the recorded
 * envelopes. Notably:
 *   - image models return `candidates[0].content.parts[].inlineData` as JPEG,
 *     and report image tokens separately under `candidatesTokensDetails`;
 *   - Lyria returns a text part reading "<instrumental>" followed by an
 *     `audio/mpeg` inline part, roughly 30s at 44.1kHz stereo;
 *   - Veo returns a long-running operation whose result carries a download URI
 *     at `response.generateVideoResponse.generatedSamples[0].video.uri`, plus a
 *     silent AAC track the composer must discard.
 */
import {
  awaitOperation,
  downloadFile,
  generateContent,
  inlineOf,
  jsonOf,
  predictLongRunning,
  textOf,
  usageOf,
  type Content,
  type FunctionDeclaration,
  type GenerateContentRequest,
  type GenerateContentResponse,
  type Part,
} from "./gemini";
import type { Usage } from "./governor";
import { permanent, semantic } from "@/lib/core/util";
import { LIMITS, videoDurationFor } from "@/lib/core/config";

// ── shared ───────────────────────────────────────────────────────────────────

export interface AdapterOut<T> {
  value: T;
  usage: Usage;
  /** Raw model version string the provider echoed back, for the audit trail. */
  modelVersion?: string;
}

export function imageTokensOf(res: GenerateContentResponse): number {
  const details = (res.usageMetadata as unknown as {
    candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
  })?.candidatesTokensDetails;
  if (!details) return 0;
  return details
    .filter((d) => (d.modality ?? "").toUpperCase() === "IMAGE")
    .reduce((a, d) => a + (d.tokenCount ?? 0), 0);
}

function usageWithImages(res: GenerateContentResponse, images: number): Usage {
  const base = usageOf(res);
  return { ...base, outputImageTokens: imageTokensOf(res), images };
}

export function inlinePart(bytes: Buffer, mime: string): Part {
  return { inlineData: { mimeType: mime, data: bytes.toString("base64") } };
}

// ── structured text ──────────────────────────────────────────────────────────

export interface TextRequest {
  model: string;
  system?: string;
  /** Text and inline media, in order. */
  parts: Part[];
  /** When present the model is forced into JSON matching this schema. */
  schema?: unknown;
  /**
   * "low" keeps thinking to ~50 tokens on Gemini 3 Flash instead of ~540, which
   * is the single largest lever on text cost. Use "high" only for the Director.
   */
  thinking?: "low" | "high";
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** Structured JSON generation. Throws `permanent` if the model returns no JSON. */
export async function generateJson<T>(req: TextRequest): Promise<AdapterOut<T>> {
  const body: GenerateContentRequest = {
    contents: [{ role: "user", parts: req.parts }],
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    generationConfig: {
      ...(req.schema
        ? { responseMimeType: "application/json", responseSchema: req.schema }
        : { responseMimeType: "application/json" }),
      maxOutputTokens: req.maxOutputTokens ?? 8192,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.thinking ? { thinkingConfig: { thinkingLevel: req.thinking } } : {}),
    },
  };
  const res = await generateContent(req.model, body, {
    timeoutMs: req.timeoutMs ?? LIMITS.timeoutMs.director,
  });
  return { value: jsonOf<T>(res), usage: usageOf(res), modelVersion: res.modelVersion };
}

/** Free-form text generation, used for short prose the UI narrates. */
export async function generateText(req: TextRequest): Promise<AdapterOut<string>> {
  const body: GenerateContentRequest = {
    contents: [{ role: "user", parts: req.parts }],
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens ?? 1024,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.thinking ? { thinkingConfig: { thinkingLevel: req.thinking } } : {}),
    },
  };
  const res = await generateContent(req.model, body, {
    timeoutMs: req.timeoutMs ?? LIMITS.timeoutMs.critic,
  });
  const text = textOf(res).trim();
  if (!text) throw permanent("model returned empty text");
  return { value: text, usage: usageOf(res), modelVersion: res.modelVersion };
}

/** Function-calling turn for the agent harness. */
export interface ToolTurnRequest {
  model: string;
  system?: string;
  contents: Content[];
  tools: FunctionDeclaration[];
  thinking?: "low" | "high";
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Force a tool call rather than allowing a bare text reply. */
  requireTool?: boolean;
}

export async function toolTurn(req: ToolTurnRequest): Promise<AdapterOut<GenerateContentResponse>> {
  const body: GenerateContentRequest = {
    contents: req.contents,
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    tools: [{ functionDeclarations: req.tools }],
    toolConfig: { functionCallingConfig: { mode: req.requireTool ? "ANY" : "AUTO" } },
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens ?? 4096,
      ...(req.thinking ? { thinkingConfig: { thinkingLevel: req.thinking } } : {}),
    },
  };
  const res = await generateContent(req.model, body, {
    timeoutMs: req.timeoutMs ?? LIMITS.timeoutMs.director,
  });
  return { value: res, usage: usageOf(res), modelVersion: res.modelVersion };
}

// ── image generation ─────────────────────────────────────────────────────────

export interface ImageRequest {
  model: string;
  prompt: string;
  /**
   * Reference images that anchor subject identity and prior-scene continuity.
   *
   * The label is sent to the model as text immediately before its image. Without it the
   * model receives an unnamed pile of pictures and cannot tell which face belongs to whom:
   * given a portrait and a family photograph it matched the portrait and invented the rest
   * of the family.
   */
  references?: { bytes: Buffer; mime: string; label?: string }[];
  aspectRatio?: string;
  /** One of 512, 1K, 2K, 4K. The API rejects anything else. */
  imageSize?: string;
  timeoutMs?: number;
}

export interface GeneratedImage {
  bytes: Buffer;
  mime: string;
}

export async function generateImage(req: ImageRequest): Promise<AdapterOut<GeneratedImage>> {
  const parts: Part[] = [];
  // References first: the model treats leading images as the subject to preserve. Each is
  // introduced by name, so a prompt that talks about "the group" and a prompt that talks
  // about "the protagonist" are each pointed at the right picture.
  for (const r of req.references ?? []) {
    if (r.label) parts.push({ text: `Reference image — ${r.label}:` });
    parts.push(inlinePart(r.bytes, r.mime));
  }
  parts.push({ text: req.prompt });

  const body: GenerateContentRequest = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: req.aspectRatio ?? "9:16",
        imageSize: req.imageSize ?? "1K",
      },
    },
  };
  const res = await generateContent(req.model, body, {
    timeoutMs: req.timeoutMs ?? LIMITS.timeoutMs.keyframe,
  });
  const img = inlineOf(res, "image/");
  if (!img) {
    const why = res.promptFeedback?.blockReason ?? textOf(res).slice(0, 160);
    throw semantic(`image model returned no image${why ? `: ${why}` : ""}`);
  }
  return {
    value: { bytes: img.bytes, mime: img.mime },
    usage: usageWithImages(res, 1),
    modelVersion: res.modelVersion,
  };
}

// ── music generation ─────────────────────────────────────────────────────────

export interface MusicRequest {
  model: string;
  prompt: string;
  timeoutMs?: number;
}

export interface GeneratedMusic {
  bytes: Buffer;
  mime: string;
}

export async function generateMusic(req: MusicRequest): Promise<AdapterOut<GeneratedMusic>> {
  const body: GenerateContentRequest = {
    contents: [{ role: "user", parts: [{ text: req.prompt }] }],
  };
  const res = await generateContent(req.model, body, {
    timeoutMs: req.timeoutMs ?? LIMITS.timeoutMs.music,
  });
  const audio = inlineOf(res, "audio/");
  if (!audio) {
    const why = res.promptFeedback?.blockReason ?? textOf(res).slice(0, 160);
    throw semantic(`music model returned no audio${why ? `: ${why}` : ""}`);
  }
  const base = usageOf(res);
  return {
    value: { bytes: audio.bytes, mime: audio.mime },
    usage: { ...base, clips: 1 },
    modelVersion: res.modelVersion,
  };
}

// ── video generation ─────────────────────────────────────────────────────────

export interface VideoRequest {
  model: string;
  prompt: string;
  /** Seed frame for image-to-video. Strongly preferred: it anchors identity. */
  image?: { bytes: Buffer; mime: string };
  /** The API accepts 4 to 8 inclusive. */
  seconds: number;
  resolution?: "720p" | "1080p";
  aspectRatio?: string;
  personGeneration?: "allow_adult" | "allow_all" | "dont_allow";
  timeoutMs?: number;
  onTick?: (elapsedMs: number) => void;
}

export interface GeneratedVideo {
  bytes: Buffer;
  mime: string;
  seconds: number;
}

/** Long-running video generation, polled to completion and downloaded. */
export async function generateVideo(req: VideoRequest): Promise<AdapterOut<GeneratedVideo>> {
  // The accepted set, not a range, and NaN must not survive: Math.round(NaN) is NaN
  // and passes straight through min/max to serialise as null.
  const seconds = videoDurationFor(req.seconds);
  const instance: Record<string, unknown> = { prompt: req.prompt };
  if (req.image) {
    instance.image = {
      bytesBase64Encoded: req.image.bytes.toString("base64"),
      mimeType: req.image.mime,
    };
  }

  const op = await predictLongRunning(
    req.model,
    {
      instances: [instance as { prompt: string }],
      parameters: {
        aspectRatio: req.aspectRatio ?? "9:16",
        durationSeconds: seconds,
        resolution: req.resolution ?? "720p",
        sampleCount: 1,
        ...(req.personGeneration ? { personGeneration: req.personGeneration } : {}),
      },
    },
    { timeoutMs: 90_000 },
  );

  const done = await awaitOperation<{
    generateVideoResponse?: {
      generatedSamples?: { video?: { uri?: string; bytesBase64Encoded?: string } }[];
      raiMediaFilteredReasons?: string[];
    };
  }>(op, { timeoutMs: req.timeoutMs ?? LIMITS.timeoutMs.video, onTick: req.onTick });

  const sample = done.response?.generateVideoResponse?.generatedSamples?.[0];
  const filtered = done.response?.generateVideoResponse?.raiMediaFilteredReasons;
  if (!sample) {
    throw semantic(
      filtered?.length
        ? `video was filtered: ${filtered.join("; ")}`
        : "video operation completed without a sample",
    );
  }

  let bytes: Buffer;
  if (sample.video?.bytesBase64Encoded) {
    bytes = Buffer.from(sample.video.bytesBase64Encoded, "base64");
  } else if (sample.video?.uri) {
    bytes = await downloadFile(sample.video.uri);
  } else {
    throw semantic("video sample carried neither bytes nor a uri");
  }
  if (bytes.length < 1024) throw semantic(`video download was only ${bytes.length} bytes`);

  return {
    value: { bytes, mime: "video/mp4", seconds },
    usage: { seconds },
    modelVersion: req.model,
  };
}

/**
 * Conversational video via `generateContent`, used as the fallback route when the
 * long-running Veo path is unavailable. Returns inline MP4 bytes.
 */
export async function generateVideoInline(req: {
  model: string;
  prompt: string;
  image?: { bytes: Buffer; mime: string };
  seconds: number;
  timeoutMs?: number;
}): Promise<AdapterOut<GeneratedVideo>> {
  const parts: Part[] = [];
  if (req.image) parts.push(inlinePart(req.image.bytes, req.image.mime));
  parts.push({ text: req.prompt });

  const res = await generateContent(
    req.model,
    {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    },
    { timeoutMs: req.timeoutMs ?? LIMITS.timeoutMs.video },
  );
  const vid = inlineOf(res, "video/");
  if (!vid) throw semantic("inline video route returned no video part");
  const base = usageOf(res);
  return {
    value: { bytes: vid.bytes, mime: vid.mime, seconds: req.seconds },
    usage: { ...base, seconds: req.seconds },
    modelVersion: res.modelVersion,
  };
}
