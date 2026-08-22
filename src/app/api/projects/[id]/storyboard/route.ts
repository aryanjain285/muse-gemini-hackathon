/** The current plan and the state of every scene in it. */
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok } from "@/lib/server/http";
import { Projects, Specs } from "@/lib/db/repo";
import { sceneViews } from "@/lib/server/views";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler("storyboard.get", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  const active = Specs.active(id);
  if (!active) return ok({ specVersion: null, scenes: [], events: [], durationS: 0 });
  return ok({
    specVersion: active.version,
    title: active.spec.title,
    logline: active.spec.logline,
    durationS: active.spec.duration_s,
    events: active.spec.events,
    scenes: sceneViews(id, active.spec),
  });
});
