/** Stop whatever the project is doing. Queued work is dropped, not paused. */
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok } from "@/lib/server/http";
import { Audit, Projects } from "@/lib/db/repo";
import { activeKind, cancel } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler("project.cancel", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  const kind = activeKind(id);
  const stopped = cancel(id);
  if (stopped) {
    Audit.record({ projectId: id, actor: "user", action: "cancelled", payload: { kind } });
  }
  return ok({ cancelled: stopped, kind });
});
