/** Create a project, or list the ones that exist. */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, handler, ok } from "@/lib/server/http";
import { PROFILE_NAMES } from "@/lib/core/config";
import { Audit, Projects } from "@/lib/db/repo";
import { DEFAULT_BUNDLE_ID, getBundle } from "@/lib/templates/bundles";
import { autoProfile, projectListView, projectView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  mode: z.enum(["generated", "uploaded"]),
  preset: z.string().min(1).default("dreamy_animated_memories"),
  brief: z.string().max(600).default(""),
  profile: z.enum(PROFILE_NAMES as unknown as [string, ...string[]]).optional(),
  title: z.string().max(80).optional(),
});

export const GET = handler("projects.list", async () => {
  bootstrap();
  return ok({ projects: projectListView() });
});

export const POST = handler("projects.create", async (req: Request) => {
  bootstrap();
  const input = await body(req, CreateSchema);
  // An unknown preset id resolves to the default rather than failing the request.
  const bundle = getBundle(input.preset ?? DEFAULT_BUNDLE_ID);
  const project = Projects.create({
    mode: input.mode,
    preset: bundle.id,
    // Chosen from the remaining ceiling rather than asked of the user.
    profile: input.profile ?? autoProfile(),
    brief: input.brief,
    ...(input.title ? { title: input.title } : {}),
  });
  Audit.record({
    projectId: project.id,
    actor: "user",
    action: "project_created",
    payload: { mode: input.mode, preset: bundle.id, profile: project.profile },
  });
  return ok({ project: projectView(project.id) }, 201);
});
