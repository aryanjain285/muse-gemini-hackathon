/** Read, update or delete one project. */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { PROFILE_NAMES } from "@/lib/core/config";
import { Audit, Projects } from "@/lib/db/repo";
import { getBundle } from "@/lib/templates/bundles";
import { purgeProjectAssets } from "@/lib/services/assets";
import { cancel, isRunning } from "@/lib/jobs/runner";
import { projectView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  brief: z.string().max(600).optional(),
  preset: z.string().min(1).optional(),
  profile: z.enum(PROFILE_NAMES as unknown as [string, ...string[]]).optional(),
  consent: z.boolean().optional(),
  title: z.string().max(80).optional(),
  mode: z.enum(["generated", "uploaded"]).optional(),
});

export const GET = handler("project.get", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const view = projectView(id);
  return view ? ok({ project: view }) : fail("project not found", 404);
});

export const PATCH = handler("project.patch", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  if (isRunning(id)) return fail("the project is busy; cancel it before editing", 409);

  const input = await body(req, PatchSchema);
  Projects.patch(id, {
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
    ...(input.preset !== undefined ? { preset: getBundle(input.preset).id } : {}),
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(input.consent !== undefined ? { consent: input.consent ? 1 : 0 } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
  });
  Audit.record({ projectId: id, actor: "user", action: "project_updated", payload: input });
  return ok({ project: projectView(id) });
});

export const DELETE = handler("project.delete", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  // Stop work before removing the files it is writing to.
  cancel(id);
  const removed = purgeProjectAssets(id);
  Projects.delete(id);
  return ok({ deleted: true, filesRemoved: removed });
});
