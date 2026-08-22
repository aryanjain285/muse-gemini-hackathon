/**
 * The director agent. POST starts a run, GET returns the transcript so the
 * console can show what the director did and why.
 */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok, str } from "@/lib/server/http";
import { LIMITS } from "@/lib/core/config";
import { Audit, Projects } from "@/lib/db/repo";
import { isRunning, start } from "@/lib/jobs/runner";
import { agentPolicyAvailable } from "@/lib/agent/loop";
import { agentTranscript } from "@/lib/server/views";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const RunSchema = z.object({
  goal: z.string().min(1).max(400).default("Direct this project end to end and export a finished reel."),
  policy: z.enum(["auto", "gemini", "local"]).default("auto"),
  maxUsd: z.number().min(0).max(LIMITS.agent.maxUsdPerRun).optional(),
});

export const GET = handler("agent.transcript", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  const runId = str(req, "run") ?? undefined;
  return ok({ ...agentTranscript(id, runId), policyAvailable: agentPolicyAvailable() });
});

export const POST = handler("agent.run", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const project = Projects.get(id);
  if (!project) return fail("project not found", 404);
  if (isRunning(id)) return fail("this project is already running", 409);
  if (project.consent !== 1) {
    return fail("confirm you have the rights to the uploaded media before generating", 400);
  }

  const input = await body(req, RunSchema);
  if (project.status === "FAILED") Projects.setStatus(id, "DRAFT", null);

  const result = start(
    id,
    "agent",
    { goal: input.goal, policy: input.policy, ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}) },
    { idempotency: { goal: input.goal, at: Date.now() } },
  );
  if (!result.started) return fail(result.reason ?? "could not start", 409);

  Audit.record({
    projectId: id,
    actor: "user",
    action: "agent_run_requested",
    payload: { goal: input.goal, policy: input.policy, jobId: result.jobId },
  });
  return ok({ started: true, jobId: result.jobId, policy: input.policy }, 202);
});
