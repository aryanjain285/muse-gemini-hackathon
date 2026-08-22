import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { Audit } from "@/lib/db/repo";
import { Memories } from "@/lib/memory/store";
import { makeSketch } from "@/lib/services/caricature";
import { SKETCH_STYLES } from "@/lib/templates/prompts";
import { profileFor } from "@/lib/core/config";
import { autoProfile } from "@/lib/server/views";

export const dynamic = "force-dynamic";

const SketchSchema = z.object({
  style: z.enum(SKETCH_STYLES).default("pencil"),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = handler("memories.sketch", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const memory = Memories.get(id);
  if (!memory) return fail("no such memory", 404);

  const input = await body(req, SketchSchema);

  // The same budget-aware choice the rest of the product makes: a drawing is worth a model call
  // when there is room for one, and worth ffmpeg when there is not.
  const profile = profileFor(autoProfile());

  const drawn = await makeSketch({
    key: memory.id,
    sourcePath: Memories.mediaPath(memory),
    mime: memory.mime,
    style: input.style,
    // The note the owner wrote is the truest description there is, so it leads.
    subject: [memory.userNote, memory.description].filter(Boolean).join(". "),
    people: memory.people.length,
    profile,
  });

  Audit.record({
    projectId: null,
    actor: "user",
    action: "memory_sketch",
    payload: { memoryId: memory.id, style: input.style, route: drawn.route, usd: drawn.usd },
  });

  return ok({
    memoryId: memory.id,
    style: input.style,
    imageUrl: `/api/assets/memories/${drawn.file}`,
    sourceUrl: `/api/assets/memories/${memory.mediaFile.replace(/^media\//, "")}`,
    title: memory.title,
    drawnBy: drawn.route === "local" ? "the deterministic engine" : drawn.route,
    cached: drawn.cached,
  });
});
