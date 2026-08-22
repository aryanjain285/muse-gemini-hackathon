/** Recompose from existing assets. The cheapest possible revision. */
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok } from "@/lib/server/http";
import { Assets, Projects, Specs } from "@/lib/db/repo";
import { isRunning, start } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler("project.compose", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  if (isRunning(id)) return fail("this project is already running", 409);

  const active = Specs.active(id);
  if (!active) return fail("this project has no plan yet", 409);

  const rendered = active.spec.scenes.filter((s) => Assets.byRole(id, s.id, "scene_video"));
  if (rendered.length === 0) {
    return fail("no scenes have been rendered yet", 409);
  }

  const result = start(id, "recompose", {}, { idempotency: { at: Date.now() } });
  if (!result.started) return fail(result.reason ?? "could not start", 409);
  return ok(
    { started: true, jobId: result.jobId, scenes: rendered.length, total: active.spec.scenes.length },
    202,
  );
});
