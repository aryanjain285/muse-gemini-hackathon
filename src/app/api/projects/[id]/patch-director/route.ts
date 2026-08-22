/**
 * Live direction. An utterance becomes a bounded patch, which is validated and
 * measured before it is accepted, so the user is told what will be re-rendered
 * instead of discovering it afterwards.
 *
 * With `apply` false this only interprets and reports the impact.
 */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { Projects, Specs } from "@/lib/db/repo";
import { applyPatch, describeImpact } from "@/lib/spec/patch";
import { commitDirection, interpretDirection } from "@/lib/services/pipeline";
import { isRunning, start } from "@/lib/jobs/runner";
import { projectView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const DirectSchema = z.object({
  utterance: z.string().min(1).max(400),
  /** false previews the change without committing it. */
  apply: z.boolean().default(true),
  /** Start re-rendering the invalidated scenes immediately. */
  render: z.boolean().default(false),
  /** Accept a change that touches nearly every scene. */
  force: z.boolean().default(false),
});

export const POST = handler("project.patchDirector", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);

  const active = Specs.active(id);
  if (!active) return fail("this project has no plan to change yet", 409);

  const input = await body(req, DirectSchema);
  const interpreted = await interpretDirection({ projectId: id, utterance: input.utterance });

  if (!interpreted.request) {
    return fail(interpreted.reason ?? "could not interpret that instruction", 422);
  }

  // Always report the impact before committing anything.
  const preview = applyPatch(active.spec, interpreted.request);
  const impact = describeImpact(preview.impact);

  if (!input.apply) {
    return ok({
      applied: false,
      summary: interpreted.request.summary,
      ops: interpreted.request.ops,
      impact,
      invalidatedScenes: preview.impact.invalidatedScenes,
      rejected: preview.rejected.map((r) => `${r.op.op}: ${r.reason}`),
      route: interpreted.route,
      usd: interpreted.usd,
    });
  }

  if (isRunning(id)) return fail("the project is busy; wait for it to finish", 409);

  const committed = commitDirection({
    projectId: id,
    request: interpreted.request,
    force: input.force,
  });

  if (!committed.accepted) {
    // Asking for confirmation is an answer, not a failure. This carried a 409, which made
    // the client treat it as a transport error: the body — impact, blast radius, and the
    // needsForce flag the override button depends on — was thrown away, and a change that
    // needed one more click surfaced as "request failed (409)" with no way forward.
    return ok({
      applied: false,
      summary: committed.summary,
      impact: committed.impact,
      invalidatedScenes: committed.invalidatedScenes,
      rejected: committed.rejected,
      needsForce: true,
      route: interpreted.route,
      usd: interpreted.usd,
    });
  }

  let jobId: string | null = null;
  if (input.render) {
    const started = start(
      id,
      committed.invalidatedScenes.length > 0 ? "patch_render" : "recompose",
      {
        sceneIds: committed.invalidatedScenes,
        regenerateMusic: preview.impact.invalidatesMusic,
      },
      { idempotency: { version: committed.specVersion, at: Date.now() } },
    );
    jobId = started.started ? started.jobId : null;
  }

  return ok({
    applied: true,
    specVersion: committed.specVersion,
    summary: committed.summary,
    impact: committed.impact,
    invalidatedScenes: committed.invalidatedScenes,
    rejected: committed.rejected,
    route: interpreted.route,
    usd: interpreted.usd,
    jobId,
    project: projectView(id),
  });
});
