/**
 * Start the full run: preflight, plan, then music and visuals concurrently,
 * quality control, and composition. Returns as soon as the work is scheduled;
 * progress arrives on the status stream.
 */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { PROFILE_NAMES } from "@/lib/core/config";
import { Audit, Projects } from "@/lib/db/repo";
import { getBundle } from "@/lib/templates/bundles";
import { isRunning, start } from "@/lib/jobs/runner";
import { projectView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const StartSchema = z.object({
  brief: z.string().max(600).optional(),
  preset: z.string().min(1).optional(),
  profile: z.enum(PROFILE_NAMES as unknown as [string, ...string[]]).optional(),
  consent: z.boolean().optional(),
  /** Drive the run with the director agent rather than the fixed pipeline. */
  useAgent: z.boolean().optional(),
  /** Extra instruction for the agent. */
  goal: z.string().max(400).optional(),
});

export const POST = handler("project.direct", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const project = Projects.get(id);
  if (!project) return fail("project not found", 404);
  if (isRunning(id)) return fail("this project is already running", 409);

  const input = await body(req, StartSchema);
  Projects.patch(id, {
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
    ...(input.preset !== undefined ? { preset: getBundle(input.preset).id } : {}),
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(input.consent !== undefined ? { consent: input.consent ? 1 : 0 } : {}),
  });

  const after = Projects.require(id);
  if (after.consent !== 1) {
    return fail("confirm you have the rights to the uploaded media before generating", 400);
  }

  // A previous failure is a legitimate starting point; reset so the state machine
  // will accept the run.
  if (after.status === "FAILED") Projects.setStatus(id, "DRAFT", null);

  const result = input.useAgent
    ? start(
        id,
        "agent",
        { goal: input.goal ?? "Direct this project end to end and export a finished reel." },
        { idempotency: { at: Date.now() } },
      )
    : start(id, "pipeline", {}, { idempotency: { at: Date.now() } });

  if (!result.started) return fail(result.reason ?? "could not start", 409);

  Audit.record({
    projectId: id,
    actor: "user",
    action: input.useAgent ? "agent_started" : "pipeline_started",
    payload: { jobId: result.jobId, profile: after.profile, preset: after.preset },
  });

  return ok({ started: true, jobId: result.jobId, project: projectView(id) }, 202);
});
