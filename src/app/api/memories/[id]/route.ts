import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { Memories, memoryView } from "@/lib/memory/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  title: z.string().max(80).optional(),
  description: z.string().max(500).optional(),
  location: z.string().max(120).nullable().optional(),
  event: z.string().max(120).nullable().optional(),
  userNote: z.string().max(700).optional(),
  context: z.string().max(400).optional(),
  importance: z.number().min(0).max(1).optional(),
  people: z.array(z.string().max(80)).max(12).optional(),
  mood: z.array(z.string().max(40)).max(8).optional(),
  tags: z.array(z.string().max(40)).max(16).optional(),
});

export const GET = handler("memories.get", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const record = Memories.get(id);
  return record ? ok({ memory: memoryView(record) }) : fail("memory not found", 404);
});

export const PATCH = handler("memories.patch", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Memories.get(id)) return fail("memory not found", 404);
  const input = await body(req, PatchSchema);
  return ok({ memory: memoryView(Memories.patch(id, input)) });
});

export const DELETE = handler("memories.delete", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Memories.get(id)) return fail("memory not found", 404);
  Memories.remove(id);
  return ok({ removed: true, id });
});
