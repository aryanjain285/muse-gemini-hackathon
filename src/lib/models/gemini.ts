/**
 * Low-level Gemini REST transport. Knows about HTTP, retries, long-running
 * operations and usage metadata; knows nothing about MUSE's domain.
 *
 * Deliberately hand-rolled over `fetch` rather than pulling an SDK: the surface
 * we need is small, the failure classification has to be ours, and every request
 * body has to be hashable for the cache and the ledger.
 */
import { GEMINI_BASE, readEnv } from "@/lib/core/config";
import {
  kindForStatus,
  MuseError,
  permanent,
  retry,
  sleep,
  transient,
  withTimeout,
} from "@/lib/core/util";
import { log } from "@/lib/core/logger";
import type { Usage } from "./governor";

// ── wire types ───────────────────────────────────────────────────────────────

export interface InlineData {
  mimeType: string;
  /** base64 */
  data: string;
}

export type Part =
  | { text: string }
  | { inlineData: InlineData }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: FunctionCall }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface Content {
  role?: "user" | "model";
  parts: Part[];
}

export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: unknown;
  responseModalities?: ("TEXT" | "IMAGE" | "AUDIO")[];
  /**
   * Gemini 3 exposes thinking as a level rather than a token budget. Setting it
   * to "low" is the single biggest cost lever on the text path: a trivial prompt
   * drops from ~540 thinking tokens to ~50.
   */
  thinkingConfig?: { thinkingLevel?: "low" | "high" };
  imageConfig?: { aspectRatio?: string; imageSize?: string };
  speechConfig?: unknown;
  seed?: number;
  stopSequences?: string[];
}

export interface GenerateContentRequest {
  contents: Content[];
  systemInstruction?: { parts: Part[] };
  generationConfig?: GenerationConfig;
  tools?: { functionDeclarations: FunctionDeclaration[] }[];
  toolConfig?: { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] } };
  safetySettings?: { category: string; threshold: string }[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * A model turn's parts carry an opaque `thoughtSignature` on Gemini 3. It must be
 * echoed back verbatim in subsequent turns of a tool-calling conversation, so
 * history is stored as the raw content rather than being reconstructed.
 */
export type ModelPart = Part & { thought?: boolean; thoughtSignature?: string };

export interface Candidate {
  content?: { role?: string; parts?: ModelPart[] };
  finishReason?: string;
  index?: number;
}

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface GenerateContentResponse {
  candidates?: Candidate[];
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
  responseId?: string;
  promptFeedback?: { blockReason?: string };
}

// ── client ───────────────────────────────────────────────────────────────────

export function hasApiKey(): boolean {
  return readEnv().apiKey !== null;
}

function requireKey(): string {
  const key = readEnv().apiKey;
  if (!key) throw permanent("GEMINI_API_KEY is not set");
  return key;
}

/** Never let a key reach a log line or an error message. */
function scrub(s: string): string {
  return s.replace(/key=[^&\s"']+/g, "key=[redacted]");
}

async function request<T>(
  method: "GET" | "POST",
  urlPath: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const key = requireKey();
  const url = `${GEMINI_BASE}${urlPath}${urlPath.includes("?") ? "&" : "?"}key=${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = scrub(text.slice(0, 600));
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
        if (parsed.error?.message) message = scrub(parsed.error.message);
      } catch {
        /* keep the raw body */
      }
      throw new MuseError(kindForStatus(res.status), `gemini ${res.status}: ${message}`, {
        status: res.status,
        path: urlPath.split("?")[0],
      });
    }
    return JSON.parse(text) as T;
  } catch (e) {
    if (e instanceof MuseError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new MuseError("timeout", `gemini request exceeded ${timeoutMs}ms`, { path: urlPath });
    }
    throw transient(`gemini transport error: ${String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** One `generateContent` call with transport retries. */
export async function generateContent(
  model: string,
  req: GenerateContentRequest,
  opts: { timeoutMs: number; attempts?: number } = { timeoutMs: 90_000 },
): Promise<GenerateContentResponse> {
  return retry(
    () =>
      request<GenerateContentResponse>(
        "POST",
        `/models/${model}:generateContent`,
        req,
        opts.timeoutMs,
      ),
    { attempts: opts.attempts ?? 2, label: `generateContent:${model}` },
  );
}

// ── long-running operations (video) ──────────────────────────────────────────

export interface Operation<T = unknown> {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: T;
  metadata?: unknown;
}

export interface PredictLongRunningRequest {
  instances: {
    prompt: string;
    image?: { bytesBase64Encoded?: string; mimeType?: string; gcsUri?: string };
    lastFrame?: { bytesBase64Encoded?: string; mimeType?: string };
    referenceImages?: {
      image: { bytesBase64Encoded: string; mimeType: string };
      referenceType?: string;
    }[];
  }[];
  parameters: Record<string, unknown>;
}

export async function predictLongRunning(
  model: string,
  req: PredictLongRunningRequest,
  opts: { timeoutMs: number } = { timeoutMs: 60_000 },
): Promise<Operation> {
  return retry(
    () =>
      request<Operation>("POST", `/models/${model}:predictLongRunning`, req, opts.timeoutMs),
    { attempts: 2, label: `predictLongRunning:${model}` },
  );
}

export async function getOperation<T = unknown>(name: string): Promise<Operation<T>> {
  // Operation names already include the resource path, e.g. "models/veo.../operations/abc".
  const path = name.startsWith("/") ? name : `/${name}`;
  return request<Operation<T>>("GET", path, undefined, 30_000);
}

/**
 * Poll an operation to completion. Video generation is minutes-scale, so this
 * backs off from 4s to 15s rather than hammering the endpoint.
 */
export async function awaitOperation<T = unknown>(
  op: Operation,
  opts: { timeoutMs: number; onTick?: (elapsedMs: number) => void },
): Promise<Operation<T>> {
  const started = Date.now();
  let delay = 4_000;
  let current: Operation<T> = op as Operation<T>;

  while (!current.done) {
    const elapsed = Date.now() - started;
    if (elapsed > opts.timeoutMs) {
      throw new MuseError("timeout", `operation ${current.name} exceeded ${opts.timeoutMs}ms`, {
        operation: current.name,
      });
    }
    opts.onTick?.(elapsed);
    await sleep(delay);
    delay = Math.min(15_000, Math.round(delay * 1.35));
    current = await getOperation<T>(current.name);
  }

  if (current.error) {
    const kind = kindForStatus(current.error.code >= 400 ? current.error.code : 500);
    throw new MuseError(kind, `operation failed: ${scrub(current.error.message)}`, {
      operation: current.name,
    });
  }
  return current;
}

/**
 * Download a generated media file. Gemini returns either inline base64 or a URI
 * on the file service, which needs the key appended.
 */
export async function downloadFile(uri: string, timeoutMs = 180_000): Promise<Buffer> {
  const key = requireKey();
  const url = uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new MuseError(kindForStatus(res.status), `download ${res.status} for generated media`, {
        status: res.status,
      });
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof MuseError) throw e;
    throw transient(`download failed: ${String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── response helpers ─────────────────────────────────────────────────────────

export function usageOf(res: GenerateContentResponse): Usage {
  const u = res.usageMetadata ?? {};
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    thoughtTokens: u.thoughtsTokenCount ?? 0,
  };
}

/** Concatenated text parts, skipping thought parts. */
export function textOf(res: GenerateContentResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => "text" in p && typeof p.text === "string" && !p.thought)
    .map((p) => (p as { text: string }).text)
    .join("");
}

/** First inline binary part matching a mime prefix, decoded. */
export function inlineOf(
  res: GenerateContentResponse,
  mimePrefix: string,
): { bytes: Buffer; mime: string } | null {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if ("inlineData" in p && p.inlineData?.mimeType?.startsWith(mimePrefix)) {
      return {
        bytes: Buffer.from(p.inlineData.data, "base64"),
        mime: p.inlineData.mimeType,
      };
    }
  }
  return null;
}

export function functionCallsOf(res: GenerateContentResponse): FunctionCall[] {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p): p is ModelPart & { functionCall: FunctionCall } =>
      Boolean((p as { functionCall?: FunctionCall }).functionCall),
    )
    .map((p) => p.functionCall);
}

/** The model turn exactly as returned, for appending to a tool-calling history. */
export function modelTurnOf(res: GenerateContentResponse): Content | null {
  const content = res.candidates?.[0]?.content;
  if (!content?.parts || content.parts.length === 0) return null;
  return { role: "model", parts: content.parts as Part[] };
}

/**
 * Parse a JSON response, tolerating the fenced-code wrapper models occasionally
 * emit even under `responseMimeType: application/json`.
 */
export function jsonOf<T>(res: GenerateContentResponse): T {
  const raw = textOf(res).trim();
  if (!raw) {
    const blocked = res.promptFeedback?.blockReason;
    throw permanent(blocked ? `response blocked: ${blocked}` : "model returned no text");
  }
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last resort: take the outermost brace-balanced object.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    log.warn("unparseable model JSON", { preview: cleaned.slice(0, 200) });
    throw permanent("model returned unparseable JSON");
  }
}

// ── model listing (free, used by the doctor and probe scripts) ────────────────

export interface ModelInfo {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export async function listModels(): Promise<ModelInfo[]> {
  const res = await withTimeout(
    request<{ models: ModelInfo[] }>("GET", `/models?pageSize=1000`, undefined, 30_000),
    35_000,
    "listModels",
  );
  return (res.models ?? []).map((m) => ({ ...m, name: m.name.replace(/^models\//, "") }));
}
