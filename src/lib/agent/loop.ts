/**
 * The director agent loop.
 *
 * Two policies drive the same tool registry. The Gemini policy is a real
 * function-calling conversation: the model reads the project, pulls the craft
 * guides it needs, and decides what to render and in what order. The local policy
 * walks a fixed, sensible plan through the identical tools.
 *
 * That symmetry is the point. The console the user watches shows the same stream
 * of tool calls and results either way, so the system is demonstrable with no
 * credentials, and switching to a real key changes who is deciding rather than
 * what is possible.
 *
 * Every run is bounded three ways — turns, tool calls and spend — because an
 * unbounded agent pointed at paid generation is a way to lose a budget.
 */
import { LIMITS, profileFor, readEnv, type Profile } from "@/lib/core/config";
import { id as newId, MuseError, round, truncate } from "@/lib/core/util";
import { logger } from "@/lib/core/logger";
import { AgentSteps, Audit, Ledger, Projects } from "@/lib/db/repo";
import type { AgentStepRow } from "@/lib/db/types";
import { toolTurn } from "@/lib/models/adapters";
import { functionCallsOf, hasApiKey, modelTurnOf, textOf } from "@/lib/models/gemini";
import type { Content } from "@/lib/models/gemini";
import { reserve } from "@/lib/models/governor";
import { Specs } from "@/lib/db/repo";
import type { RunContext } from "@/lib/jobs/runner";
import { buildRegistry, CANONICAL_ORDER } from "./tools";
import type { ToolContext, ToolRegistry } from "./registry";
import { coreSkills, skillIndex, skillsVersion } from "./skills";

export type PolicyName = "gemini" | "local";

export interface AgentRunResult {
  runId: string;
  policy: PolicyName;
  turns: number;
  toolCalls: number;
  usd: number;
  finished: boolean;
  summary: string;
  outstanding: string[];
  transcript: AgentStepRow[];
  /** Why the run stopped, when it was not a clean finish. */
  stopReason?: string;
}

export interface AgentOptions {
  /** What the user asked for, in their own words. */
  goal: string;
  policy?: PolicyName | "auto";
  /** Ceiling for this run, on top of the global budget. */
  maxUsd?: number;
  maxTurns?: number;
  maxToolCalls?: number;
}

// ── system instruction ───────────────────────────────────────────────────────

function systemInstruction(projectId: string): string {
  const project = Projects.require(projectId);
  const profile = profileFor(project.profile as never);
  const realTasks = Object.entries(profile.routes)
    .filter(([, target]) => target.kind === "gemini")
    .map(([task]) => task);

  return `You are the director of MUSE. People bring you photographs of something that mattered,
and you direct them into a thirty second vertical film — cast, scored, and cut to the beat.

You work by calling tools. You cannot generate anything directly and you cannot write files; the
tools do the work and report back. Read before you act, and react to what the tools actually tell
you rather than assuming a call succeeded as intended.

## How to run a project
1. get_project, to see what you have been given.
2. plan_film, once, to write the timeline and scene breakdown.
3. make_score, so the real musical accents are known before the cuts are placed.
4. render_scene for each scene, one at a time. Read each critic verdict before moving on.
5. compose_reel, then inspect_reel to verify it.
6. finish, with an honest summary.

If a critic verdict comes back RETRY or FALLBACK, decide whether to patch the plan
(patch_plan) or accept it. Do not blindly re-render the same scene more than once — the
tool already spends the scene's own retry budget internally.

## Craft guides
Read a guide with read_skill before a decision it covers. Available:
${skillIndex()}

Two of them are already loaded below because they shape every decision.

## What is real right now
Profile "${profile.name}": ${profile.blurb}
${realTasks.length > 0 ? `Real model calls are enabled for: ${realTasks.join(", ")}.` : "Every stage is running on the deterministic local engine."}
Anything not listed runs deterministically. That is not a failure — deterministic camera work
over a strong still is often the better shot, and it always exports.

## Budget
Generation costs real money against a hard ceiling, and the ceiling is small. Prefer the cheap
correct answer. Re-running an identical request is free because responses are cached; changing a
prompt is not. If a spend tool reports no budget left, stop generating and compose what exists.

## Tone
When you write anything the user reads, be plain and specific. No exclamation marks, no
marketing language, no claiming something looks great when you have not verified it.

${coreSkills()}`;
}

function openingMessage(projectId: string, goal: string): string {
  const project = Projects.require(projectId);
  return `Project ${projectId}.
The user chose the "${project.preset}" preset in "${project.mode}" mode and wrote:
"${project.brief || "(no brief given)"}"

Your instruction for this run: ${goal}

Begin by reading the project.`;
}

// ── transcript ───────────────────────────────────────────────────────────────

function record(
  ctx: RunContext,
  runId: string,
  kind: AgentStepRow["kind"],
  name: string,
  summary: string,
  payload: unknown,
  usd = 0,
): void {
  const row = AgentSteps.append({
    projectId: ctx.projectId,
    runId,
    kind,
    name,
    payload,
    usd,
  });
  ctx.emit({
    kind: "agent",
    seq: row.seq,
    step: kind,
    name,
    summary: truncate(summary, 400),
    ...(usd > 0 ? { usd: round(usd, 6) } : {}),
  });
}

// ── the loop ─────────────────────────────────────────────────────────────────

export async function runAgent(ctx: RunContext, opts: AgentOptions): Promise<AgentRunResult> {
  const runId = newId("run", 10);
  const registry = buildRegistry();
  const profile = profileFor(Projects.require(ctx.projectId).profile as never);
  const maxUsd = Math.min(opts.maxUsd ?? LIMITS.agent.maxUsdPerRun, LIMITS.agent.maxUsdPerRun);
  const maxTurns = opts.maxTurns ?? LIMITS.agent.maxTurns;
  const maxToolCalls = opts.maxToolCalls ?? LIMITS.agent.maxToolCalls;

  const requested = opts.policy ?? "auto";
  const policy: PolicyName =
    requested === "local"
      ? "local"
      : requested === "gemini"
        ? "gemini"
        : hasApiKey() && profile.routes.director.kind === "gemini"
          ? "gemini"
          : "local";

  const log = ctx.log.child({ job_id: runId });
  log.info(`agent run starting`, { policy, maxUsd, goal: truncate(opts.goal, 120) });

  let spent = 0;
  const toolCtx: ToolContext = {
    projectId: ctx.projectId,
    runId,
    log,
    job: ctx,
    get remainingUsd() {
      return round(maxUsd - spent, 6);
    },
    charge(usd: number) {
      spent = round(spent + Math.max(0, usd), 6);
    },
  };

  record(ctx, runId, "message", "goal", truncate(opts.goal, 300), {
    goal: opts.goal,
    policy,
    maxUsd,
    skillsVersion: skillsVersion(),
  });
  Audit.record({
    projectId: ctx.projectId,
    traceId: ctx.traceId,
    actor: "director",
    action: "agent_run_start",
    payload: { runId, policy, goal: opts.goal, maxUsd },
  });

  const outcome =
    policy === "gemini"
      ? await geminiPolicy(ctx, { runId, registry, toolCtx, opts, maxTurns, maxToolCalls, profile })
      : await localPolicy(ctx, { runId, registry, toolCtx, maxToolCalls });

  const result: AgentRunResult = {
    runId,
    policy,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    usd: spent,
    finished: outcome.finished,
    summary: outcome.summary,
    outstanding: outcome.outstanding,
    transcript: AgentSteps.byRun(ctx.projectId, runId),
    ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
  };

  record(ctx, runId, "message", "result", outcome.summary || "run ended", {
    finished: outcome.finished,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    usd: spent,
    stopReason: outcome.stopReason ?? null,
  });
  Audit.record({
    projectId: ctx.projectId,
    traceId: ctx.traceId,
    actor: "director",
    action: "agent_run_end",
    payload: {
      runId,
      finished: outcome.finished,
      turns: outcome.turns,
      toolCalls: outcome.toolCalls,
      usd: spent,
    },
  });
  log.info("agent run finished", {
    finished: outcome.finished,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    usd: spent,
  });

  return result;
}

interface PolicyOutcome {
  turns: number;
  toolCalls: number;
  finished: boolean;
  summary: string;
  outstanding: string[];
  stopReason?: string;
}

// ── gemini policy ────────────────────────────────────────────────────────────

async function geminiPolicy(
  ctx: RunContext,
  input: {
    runId: string;
    registry: ToolRegistry;
    toolCtx: ToolContext;
    opts: AgentOptions;
    maxTurns: number;
    maxToolCalls: number;
    profile: Profile;
  },
): Promise<PolicyOutcome> {
  const { registry, toolCtx, runId } = input;
  const model =
    input.profile.routes.director.kind === "gemini"
      ? input.profile.routes.director.model
      : "gemini-3.6-flash";

  const system = systemInstruction(ctx.projectId);
  const history: Content[] = [
    { role: "user", parts: [{ text: openingMessage(ctx.projectId, input.opts.goal) }] },
  ];

  let turns = 0;
  let toolCalls = 0;
  let finished = false;
  let summary = "";
  let outstanding: string[] = [];
  let stopReason: string | undefined;

  while (turns < input.maxTurns) {
    ctx.checkpoint();
    turns++;

    if (Date.now() > ctx.deadlineAt) {
      stopReason = "deadline reached";
      break;
    }

    // Reserve before the turn so an agent cannot walk past the global ceiling.
    let reservation;
    try {
      reservation = reserve({
        model,
        task: "director",
        hint: { inputTokens: 3000 + turns * 900, outputTokens: 600, thoughtTokens: 500 },
        projectId: ctx.projectId,
        callCapUsd: Math.max(0.02, toolCtx.remainingUsd),
      });
    } catch (e) {
      stopReason = `no budget for another turn: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    let response;
    try {
      response = await toolTurn({
        model,
        system,
        contents: history,
        tools: registry.declarations(),
        thinking: turns === 1 ? "high" : "low",
        maxOutputTokens: 3000,
        timeoutMs: LIMITS.timeoutMs.director,
      });
      const usd = reservation.settle(response.usage, { projectId: ctx.projectId, requestHash: `${runId}-t${turns}` });
      toolCtx.charge(usd);
    } catch (e) {
      reservation.release();
      const message = e instanceof Error ? e.message : String(e);
      record(ctx, runId, "error", "model_turn", message, { turn: turns, error: message });
      // A failed turn is not a failed run: fall through to the deterministic
      // policy so the project still completes.
      stopReason = `model turn failed: ${truncate(message, 200)}`;
      const fallback = await localPolicy(ctx, {
        runId,
        registry,
        toolCtx,
        maxToolCalls: input.maxToolCalls - toolCalls,
      });
      return {
        turns: turns + fallback.turns,
        toolCalls: toolCalls + fallback.toolCalls,
        finished: fallback.finished,
        summary: fallback.summary,
        outstanding: fallback.outstanding,
        stopReason,
      };
    }

    const modelTurn = modelTurnOf(response.value);
    if (modelTurn) history.push(modelTurn);

    const text = textOf(response.value).trim();
    if (text) record(ctx, runId, "thought", "reasoning", truncate(text, 400), { turn: turns, text });

    const calls = functionCallsOf(response.value);
    if (calls.length === 0) {
      // No tool call and no finish: nudge once, then stop rather than looping.
      if (text) {
        history.push({
          role: "user",
          parts: [
            {
              text:
                "Continue by calling a tool. If the reel is finished and verified, call finish. " +
                "Do not reply with prose alone.",
            },
          ],
        });
        continue;
      }
      stopReason = "model returned neither a tool call nor text";
      break;
    }

    const responses: Content["parts"] = [];
    for (const call of calls) {
      if (toolCalls >= input.maxToolCalls) {
        stopReason = `tool call limit of ${input.maxToolCalls} reached`;
        break;
      }
      toolCalls++;
      record(ctx, runId, "tool_call", call.name, describeArgs(call.args), {
        turn: turns,
        args: call.args,
      });

      const before = Ledger.projectUsd(ctx.projectId);
      const result = await registry.call(toolCtx, call.name, call.args);
      const delta = round(Ledger.projectUsd(ctx.projectId) - before, 6);

      if (result.ok) {
        record(ctx, runId, "tool_result", call.name, result.summary, { output: result.output }, delta);
        responses.push({
          functionResponse: { name: call.name, response: asRecord(result.output) },
        });
        if (call.name === "finish") {
          const out = result.output as { summary: string; outstanding: string[] };
          finished = true;
          summary = out.summary;
          outstanding = out.outstanding ?? [];
        }
      } else {
        record(ctx, runId, "error", call.name, result.error, { error: result.error });
        responses.push({
          functionResponse: { name: call.name, response: { error: result.error } },
        });
      }
    }

    if (responses.length > 0) history.push({ role: "user", parts: responses });
    if (finished || stopReason) break;
  }

  if (!finished && !stopReason && turns >= input.maxTurns) {
    stopReason = `turn limit of ${input.maxTurns} reached`;
  }

  // Never leave a project without a reel just because the agent ran out of room.
  if (!finished) {
    const salvage = await ensureReel(ctx, { runId, registry, toolCtx });
    if (salvage) {
      summary = summary || salvage;
      finished = true;
    }
  }

  return { turns, toolCalls, finished, summary, outstanding, stopReason };
}

// ── local policy ─────────────────────────────────────────────────────────────

/**
 * The deterministic director. Walks the canonical order, reacting to real tool
 * results the same way the model is asked to: it reads the plan to learn the scene
 * ids, renders each one, and only composes once scenes exist.
 */
async function localPolicy(
  ctx: RunContext,
  input: { runId: string; registry: ToolRegistry; toolCtx: ToolContext; maxToolCalls: number },
): Promise<PolicyOutcome> {
  const { registry, toolCtx, runId } = input;
  let toolCalls = 0;
  const notes: string[] = [];
  const outstanding: string[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (toolCalls >= input.maxToolCalls) return null;
    ctx.checkpoint();
    toolCalls++;
    record(ctx, runId, "tool_call", name, describeArgs(args), { args });
    const before = Ledger.projectUsd(ctx.projectId);
    const result = await registry.call(toolCtx, name, args);
    const delta = round(Ledger.projectUsd(ctx.projectId) - before, 6);
    if (result.ok) {
      record(ctx, runId, "tool_result", name, result.summary, { output: result.output }, delta);
      return result.output;
    }
    record(ctx, runId, "error", name, result.error, { error: result.error });
    outstanding.push(`${name}: ${result.error}`);
    return null;
  };

  record(ctx, runId, "thought", "plan", "Running the canonical order deterministically.", {
    order: CANONICAL_ORDER,
  });

  await call("get_project");

  const existing = Specs.active(ctx.projectId);
  if (!existing) {
    const planned = await call("plan_film");
    if (!planned) {
      return {
        turns: 1,
        toolCalls,
        finished: false,
        summary: "could not write a plan",
        outstanding,
        stopReason: "plan_film failed",
      };
    }
  }

  const active = Specs.active(ctx.projectId);
  if (!active) {
    return {
      turns: 1,
      toolCalls,
      finished: false,
      summary: "no plan is available",
      outstanding,
      stopReason: "no active spec",
    };
  }

  await call("make_score");

  for (const scene of active.spec.scenes) {
    if (Date.now() > ctx.deadlineAt) {
      outstanding.push(`stopped before ${scene.id}: deadline reached`);
      break;
    }
    const out = (await call("render_scene", { scene_id: scene.id })) as
      | { decision?: string }
      | null;
    if (out?.decision && out.decision !== "PASS") {
      notes.push(`${scene.id} finished as ${out.decision}`);
    }
  }

  await call("compose_reel");
  const check = (await call("inspect_reel")) as { ok?: boolean; issues?: string[] } | null;
  if (check && check.ok === false) outstanding.push(...(check.issues ?? []));

  const summary =
    `Directed ${active.spec.scenes.length} scenes for "${active.spec.title}" and exported a ` +
    `${active.spec.duration_s.toFixed(0)} second vertical reel with cuts placed on the measured ` +
    `musical accents.` + (notes.length > 0 ? ` ${notes.join("; ")}.` : "");

  record(ctx, runId, "message", "finish", summary, { summary, outstanding });

  return { turns: 1, toolCalls, finished: true, summary, outstanding };
}

// ── salvage ──────────────────────────────────────────────────────────────────

/**
 * If a run ends without a reel, compose whatever exists. An unfinished agent
 * conversation should still leave the user with something to watch.
 */
async function ensureReel(
  ctx: RunContext,
  input: { runId: string; registry: ToolRegistry; toolCtx: ToolContext },
): Promise<string | null> {
  const { Assets } = await import("@/lib/db/repo");
  if (Assets.byRole(ctx.projectId, "final", "reel")) return null;
  const active = Specs.active(ctx.projectId);
  if (!active) return null;
  const rendered = active.spec.scenes.filter((s) =>
    Boolean(Assets.byRole(ctx.projectId, s.id, "scene_video")),
  );
  if (rendered.length === 0) return null;

  record(ctx, input.runId, "thought", "salvage", "Composing from the scenes that exist.", {
    rendered: rendered.length,
    total: active.spec.scenes.length,
  });
  const result = await input.registry.call(input.toolCtx, "compose_reel", {});
  if (!result.ok) return null;
  return `Composed a reel from ${rendered.length} of ${active.spec.scenes.length} scenes after the run was cut short.`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function describeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "no arguments";
  return truncate(
    keys
      .map((k) => {
        const v = args[k];
        if (typeof v === "string") return `${k}="${truncate(v, 60)}"`;
        if (Array.isArray(v)) return `${k}=[${v.length}]`;
        return `${k}=${JSON.stringify(v)}`;
      })
      .join(" "),
    220,
  );
}

/** Gemini requires a function response to be a JSON object, never a bare value. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

/** Register the agent as a job kind so routes can start it like any other work. */
export function registerAgentHandler(): void {
  // Imported lazily to keep the module graph acyclic at load time.
  void import("@/lib/jobs/runner").then(({ register }) => {
    register<{ goal: string; policy?: PolicyName | "auto"; maxUsd?: number }>(
      "agent",
      async (ctx, payload) =>
        runAgent(ctx, {
          goal: payload.goal,
          policy: payload.policy ?? "auto",
          maxUsd: payload.maxUsd,
        }),
    );
  });
}

/** True when a real model can drive the agent. */
export function agentPolicyAvailable(): PolicyName {
  const env = readEnv();
  return env.apiKey && profileFor(undefined).routes.director.kind === "gemini" ? "gemini" : "local";
}

export { MuseError };
