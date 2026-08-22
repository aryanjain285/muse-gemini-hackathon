/**
 * A storybook made from the memory library.
 *
 * The pages are written by the model and illustrated by drawings that already exist — the sketch
 * studio's output, cached, so a book assembles in a moment rather than in a minute. Where a
 * drawing has not been made the photograph itself is used, which is the honest fallback and looks
 * like a photograph pasted into a book, because that is what it is.
 *
 * Persisted, so opening the book a second time is instant and so it can be committed and travel.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { Memories } from "@/lib/memory/store";
import { existingSketches } from "@/lib/services/caricature";
import { route } from "@/lib/models/router";
import { generateContent, jsonOf, usageOf } from "@/lib/models/gemini";
import { storybookPrompt, STORYBOOK_SCHEMA } from "@/lib/templates/prompts";
import { profileFor } from "@/lib/core/config";
import { autoProfile } from "@/lib/server/views";
import { PATHS } from "@/lib/core/paths";
import { truncate } from "@/lib/core/util";

export const dynamic = "force-dynamic";

const AskSchema = z.object({
  request: z.string().max(300).default(""),
  /** Rebuild even though a book is already saved. */
  fresh: z.boolean().default(false),
});

const WireSchema = z.object({
  title: z.string().min(1).max(80),
  dedication: z.string().max(200).default(""),
  pages: z
    .array(
      z.object({
        memory_id: z.string(),
        heading: z.string().max(80).default(""),
        text: z.string().min(1).max(700),
      }),
    )
    .min(1),
});

export interface StorybookPage {
  memoryId: string;
  heading: string;
  text: string;
  /** The drawing if one exists, otherwise the photograph. */
  imageUrl: string;
  drawn: boolean;
}

export interface Storybook {
  title: string;
  dedication: string;
  pages: StorybookPage[];
  route: string;
  createdAt: string;
}

const SAVED = () => path.join(PATHS.workspace, "storybook.json");

function illustrate(memoryId: string): { imageUrl: string; drawn: boolean } {
  const memory = Memories.get(memoryId);
  const photo = memory
    ? `/api/assets/memories/${memory.mediaFile.replace(/^media\//, "")}`
    : "";
  // Watercolour first: of the four hands it is the one that reads as a book illustration rather
  // than as a portrait study.
  const drawings = existingSketches().filter((d) => d.memoryId === memoryId);
  const preferred =
    drawings.find((d) => d.style === "watercolour") ??
    drawings.find((d) => d.style === "pencil") ??
    drawings.find((d) => d.style === "caricature") ??
    drawings[0];
  return preferred ? { imageUrl: preferred.url, drawn: true } : { imageUrl: photo, drawn: false };
}

export const GET = handler("storybook.read", async () => {
  bootstrap();
  const file = SAVED();
  if (!fs.existsSync(file)) return ok({ storybook: null });
  try {
    return ok({ storybook: JSON.parse(fs.readFileSync(file, "utf8")) as Storybook });
  } catch {
    return ok({ storybook: null });
  }
});

export const POST = handler("storybook.write", async (req: Request) => {
  bootstrap();
  const input = await body(req, AskSchema);
  const file = SAVED();

  if (!input.fresh && fs.existsSync(file)) {
    try {
      return ok({ storybook: JSON.parse(fs.readFileSync(file, "utf8")) as Storybook, reused: true });
    } catch {
      /* fall through and write a new one */
    }
  }

  const memories = Memories.list();
  if (memories.length === 0) return fail("there are no memories to make a book from", 400);

  const { system, user, schema } = storybookPrompt({
    request: input.request,
    memories: memories.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      note: m.userNote,
      event: m.event,
      location: m.location,
      people: m.people.length,
      mood: m.mood,
    })),
  });

  const result = await route<z.infer<typeof WireSchema>>({
    task: "director",
    projectId: null,
    identity: { kind: "storybook-v1", request: input.request, ids: memories.map((m) => m.id) },
    hint: { inputTokens: 1400, outputTokens: 900, thoughtTokens: 200 },
    profile: profileFor(autoProfile()),
    // No key, no budget: the book is still a book. Their own note is the page when there is one,
    // and the description when there is not — which is exactly what the model was asked to build
    // on, so the shape of the thing does not change, only the prose.
    local: async () => ({
      title: memories[0]?.event ? truncate(memories[0].event, 40) : "A few days",
      dedication: "",
      pages: memories.map((m) => ({
        memory_id: m.id,
        heading: truncate(m.title, 40),
        text: m.userNote || m.description,
      })),
    }),
    real: async (model) => {
      const res = await generateContent(
        model,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.75,
            // Thinking draws on the same allowance as the answer, and a book cut off mid-sentence
            // is worse than a slow one.
            maxOutputTokens: 2600,
            responseMimeType: "application/json",
            responseSchema: schema ?? STORYBOOK_SCHEMA,
            thinkingConfig: { thinkingLevel: "low" },
          },
        },
        { timeoutMs: 90_000, attempts: 2 },
      );
      return {
        value: WireSchema.parse(jsonOf<unknown>(res)),
        usage: usageOf(res),
        modelVersion: res.modelVersion,
      };
    },
  });

  const known = new Set(memories.map((m) => m.id));
  const storybook: Storybook = {
    title: result.value.title,
    dedication: result.value.dedication,
    // A page about a memory that does not exist is dropped rather than shown: the instruction says
    // never to invent one, and this is the check that makes it true rather than hoped for.
    pages: result.value.pages
      .filter((p) => known.has(p.memory_id))
      .map((p) => ({
        memoryId: p.memory_id,
        heading: p.heading,
        text: p.text,
        ...illustrate(p.memory_id),
      })),
    route: result.route,
    createdAt: new Date().toISOString(),
  };

  if (storybook.pages.length === 0) return fail("the book came back with no usable pages", 502);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(storybook, null, 2));
  return ok({ storybook, reused: false });
});
