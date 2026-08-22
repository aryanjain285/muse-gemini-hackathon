import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok } from "@/lib/server/http";
import { Storybooks } from "@/lib/memory/storybooks";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = handler("storybook.get", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const storybook = Storybooks.get(id);
  if (!storybook) return fail("no such storybook", 404);
  return ok({ storybook });
});

export const DELETE = handler("storybook.remove", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Storybooks.remove(id)) return fail("no such storybook", 404);
  return ok({ removed: true });
});
