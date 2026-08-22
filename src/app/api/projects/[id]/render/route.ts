/**
 * Re-render specific scenes, or every scene a patch invalidated, then recompose.
 * With no scenes named it re-renders whatever the most recent patch invalidated.
 */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { Assets, Audit, Projects, Specs } from "@/lib/db/repo";
import { isRunning, start } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const RenderSchema = z.object({
  scenes: z.array(z.string()).max(9).optional(),
  regenerateMusic: z.boolean().optional(),
});

export const POST = handler("project.render", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  if (isRunning(id)) return fail("this project is already running", 409);

  const active = Specs.active(id);
  if (!active) return fail("this project has no plan yet", 409);

  const input = await body(req, RenderSchema);

  // Default to the scenes a patch marked stale, then to anything with no clip.
  const invalidated = active.spec.scenes
    .filter((s) => {
      const clip = Assets.byRole(id, s.id, "scene_video");
      if (!clip) return true;
      return Assets.meta<{ invalidated?: boolean }>(clip).invalidated === true;
    })
    .map((s) => s.id);

  const known = new Set(active.spec.scenes.map((s) => s.id));
  const requested = (input.scenes ?? invalidated).filter((s) => known.has(s));

  if (requested.length === 0) {
    // Nothing to regenerate: recomposing is the correct and cheapest answer.
    const result = start(id, "recompose", {}, { idempotency: { at: Date.now() } });
    if (!result.started) return fail(result.reason ?? "could not start", 409);
    return ok({ started: true, jobId: result.jobId, scenes: [], recomposeOnly: true }, 202);
  }

  const result = start(
    id,
    "patch_render",
    { sceneIds: requested, regenerateMusic: input.regenerateMusic ?? false },
    { idempotency: { scenes: requested, at: Date.now() } },
  );
  if (!result.started) return fail(result.reason ?? "could not start", 409);

  Audit.record({
    projectId: id,
    actor: "user",
    action: "render_requested",
    payload: { scenes: requested, jobId: result.jobId },
  });
  return ok({ started: true, jobId: result.jobId, scenes: requested }, 202);
});
