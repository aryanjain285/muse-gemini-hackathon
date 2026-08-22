import { z } from "zod";
import { generateContent, jsonOf, usageOf } from "@/lib/models/gemini";
import { jsonCodec, route } from "@/lib/models/router";
import { sha256 } from "@/lib/core/util";
import type { MemoryInsight, MemoryRecord, MemorySelection } from "./types";
import { Memories, memoryView } from "./store";

const MEMORY_SCHEMA = {
  type: "OBJECT",
  required: ["title", "description", "people", "setting", "activities", "objects", "mood", "tags", "visualQuality"],
  properties: {
    title: { type: "STRING" },
    description: { type: "STRING" },
    people: { type: "ARRAY", items: { type: "STRING" } },
    setting: { type: "STRING" },
    location: { type: "STRING", nullable: true },
    event: { type: "STRING", nullable: true },
    activities: { type: "ARRAY", items: { type: "STRING" } },
    objects: { type: "ARRAY", items: { type: "STRING" } },
    mood: { type: "ARRAY", items: { type: "STRING" } },
    tags: { type: "ARRAY", items: { type: "STRING" } },
    visualQuality: { type: "NUMBER" },
  },
};

function cleanStrings(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max);
}

function normalize(value: Partial<MemoryInsight>, filename: string, context: string): MemoryInsight {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return {
    title: (value.title ?? stem ?? "A memory").slice(0, 80),
    description: (value.description ?? context ?? "A personal photograph.").slice(0, 500),
    people: cleanStrings(value.people),
    setting: (value.setting ?? "").slice(0, 160),
    location: typeof value.location === "string" && value.location.trim() ? value.location.trim().slice(0, 120) : null,
    event: typeof value.event === "string" && value.event.trim() ? value.event.trim().slice(0, 120) : null,
    activities: cleanStrings(value.activities),
    objects: cleanStrings(value.objects),
    mood: cleanStrings(value.mood, 8),
    tags: cleanStrings(value.tags),
    visualQuality: Math.max(0, Math.min(1, Number(value.visualQuality ?? 0.7))),
  };
}

export async function enrichMemory(input: {
  bytes: Buffer;
  mime: string;
  filename: string;
  context?: string;
}): Promise<{ insight: MemoryInsight; route: string }> {
  const context = input.context?.trim() ?? "";
  const local = () => normalize({
    title: input.filename.replace(/\.[^.]+$/, ""),
    description: context || "A personal photograph saved in MUSE.",
    setting: context,
    tags: context.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 8) ?? [],
  }, input.filename, context);

  const result = await route<MemoryInsight>({
    task: "vision",
    projectId: null,
    identity: {
      kind: "memory-enrichment-v1",
      filename: input.filename,
      context,
      sha256: sha256(input.bytes),
    },
    hint: { inputTokens: 1200, outputTokens: 500, thoughtTokens: 100 },
    codec: jsonCodec<MemoryInsight>(),
    local: async () => local(),
    real: async (model) => {
      const res = await generateContent(model, {
        systemInstruction: {
          parts: [{ text:
            "You are the memory archivist inside MUSE. Describe only what is visually supported. " +
            "A filename/context may identify the trip or place; treat that as user-provided context, not visual fact. " +
            "Do not identify unknown people by name. Write useful retrieval metadata for a future creative agent." }],
        },
        contents: [{ role: "user", parts: [
          { text: `Context from the owner: ${context || "none"}. Create compact memory metadata for this image.` },
          { inlineData: { mimeType: input.mime, data: input.bytes.toString("base64") } },
        ] }],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 900,
          responseMimeType: "application/json",
          responseSchema: MEMORY_SCHEMA,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }, { timeoutMs: 90_000, attempts: 2 });
      return { value: normalize(jsonOf<Partial<MemoryInsight>>(res), input.filename, context), usage: usageOf(res), modelVersion: res.modelVersion };
    },
  });

  return { insight: normalize(result.value, input.filename, context), route: result.route };
}

const SelectionSchema = z.object({
  ids: z.array(z.string()).max(12).default([]),
  summary: z.string().max(500).default(""),
  storyAngle: z.string().max(500).default(""),
});
type SelectionWire = z.infer<typeof SelectionSchema>;

export async function selectMemories(query: string, limit = 5): Promise<MemorySelection> {
  const candidates = Memories.search(query, 24);
  const fallback = (): SelectionWire => ({
    ids: candidates.slice(0, limit).map((m) => m.id),
    summary: candidates.length ? `I found ${Math.min(candidates.length, limit)} memories that match.` : "I could not find a matching memory yet.",
    storyAngle: query,
  });
  if (candidates.length === 0) return { memories: [], summary: fallback().summary, storyAngle: query, route: "local" };

  const compact = candidates.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    location: m.location,
    event: m.event,
    people: m.people,
    mood: m.mood,
    tags: m.tags,
    userNote: m.userNote,
    importance: m.importance,
    visualQuality: m.visualQuality,
  }));

  const result = await route<SelectionWire>({
    task: "director",
    projectId: null,
    identity: { kind: "memory-selection-v2", query, compact, limit },
    hint: { inputTokens: 2200, outputTokens: 500, thoughtTokens: 150 },
    local: async () => fallback(),
    real: async (model) => {
      const res = await generateContent(model, {
        systemInstruction: { parts: [{ text:
          "You are MUSE, a memory-film curator. Select memories that best answer the user's request AND form a varied visual story. " +
          "Prefer a mix of establishing place, people, intimate detail and emotional payoff. Never invent memories." }] },
        contents: [{ role: "user", parts: [{ text:
          `Request: ${query}\nChoose at most ${limit} ids from this JSON and return {ids, summary, storyAngle}.\n${JSON.stringify(compact)}` }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 700, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } },
      }, { timeoutMs: 75_000, attempts: 2 });
      const parsed = SelectionSchema.parse(jsonOf<unknown>(res));
      return { value: parsed, usage: usageOf(res), modelVersion: res.modelVersion };
    },
  });

  const safe = SelectionSchema.safeParse(result.value);
  const selection = safe.success ? safe.data : fallback();
  const byId = new Map(candidates.map((m) => [m.id, m]));
  const picked: MemoryRecord[] = [];
  for (const memoryId of selection.ids) {
    const m = byId.get(memoryId);
    if (m && !picked.some((p) => p.id === m.id)) picked.push(m);
    if (picked.length >= limit) break;
  }
  for (const m of candidates) {
    if (picked.length >= limit) break;
    if (!picked.some((p) => p.id === m.id)) picked.push(m);
  }

  return {
    memories: picked.map(memoryView),
    summary: selection.summary || `I found ${picked.length} memories.`,
    storyAngle: selection.storyAngle || query,
    route: safe.success ? result.route : "local",
  };
}
