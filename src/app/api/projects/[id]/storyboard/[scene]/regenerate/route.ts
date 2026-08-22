/** Regenerate one scene and recompose, leaving every other scene untouched. */
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok } from "@/lib/server/http";
import { Audit, Projects, Specs } from "@/lib/db/repo";
import { isRunning, start } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; scene: string }> };

export const POST = handler("scene.regenerate", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id, scene } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  if (isRunning(id)) return fail("this project is already running", 409);

  const active = Specs.active(id);
  if (!active) return fail("this project has no plan yet", 409);
  if (!active.spec.scenes.some((s) => s.id === scene)) {
    return fail(
      `no scene '${scene}'. Scenes: ${active.spec.scenes.map((s) => s.id).join(", ")}`,
      404,
    );
  }

  // The attempt counter is part of the idempotency key, so asking twice for the
  // same scene genuinely re-renders it instead of returning the first result.
  const result = start(
    id,
    "scene_revision",
    { sceneId: scene },
    { idempotency: { scene, at: Date.now() } },
  );
  if (!result.started) return fail(result.reason ?? "could not start", 409);

  Audit.record({
    projectId: id,
    actor: "user",
    action: "scene_regenerate",
    payload: { scene, jobId: result.jobId },
  });
  return ok({ started: true, jobId: result.jobId, scene }, 202);
});
