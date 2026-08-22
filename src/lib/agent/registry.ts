/**
 * Tool registry for the director agent.
 *
 * A tool is the only way the agent can affect anything. Each one declares a
 * Gemini function schema for the model, a zod validator so a hallucinated
 * argument set is rejected before any work starts, and an effect class so the
 * loop can refuse to spend money it was not authorised to spend.
 *
 * Keeping the registry separate from the loop means the same tools are driven by
 * either policy — a real model, or the deterministic local script — and the
 * console the user watches looks the same either way.
 */
import type { z } from "zod";
import type { FunctionDeclaration } from "@/lib/models/gemini";
import { MuseError, truncate } from "@/lib/core/util";
import type { Logger } from "@/lib/core/logger";
import type { RunContext } from "@/lib/jobs/runner";

/** What a tool is allowed to do. The loop gates `spend` behind an explicit budget. */
export type ToolEffect = "read" | "write" | "spend";

export interface ToolContext {
  projectId: string;
  runId: string;
  log: Logger;
  /** The job context, so tools inherit cancellation and the deadline. */
  job: RunContext;
  /** Remaining USD this agent run may spend. */
  remainingUsd: number;
  /** Record a tool's spend so the loop can enforce its cap. */
  charge(usd: number): void;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  /** Written for the model: what it does and when to reach for it. */
  description: string;
  /** Gemini function-declaration parameters. */
  parameters: unknown;
  /** Runtime validation of whatever the model actually sent. */
  input: z.ZodType<I>;
  effect: ToolEffect;
  /** One-line summary of a result, shown in the console instead of raw JSON. */
  summarize(output: O): string;
  run(ctx: ToolContext, input: I): Promise<O>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<never, never>>();

  add<I, O>(tool: Tool<I, O>): this {
    if (this.tools.has(tool.name)) {
      throw new MuseError("permanent", `duplicate tool '${tool.name}'`);
    }
    this.tools.set(tool.name, tool as unknown as Tool<never, never>);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool<never, never> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Function declarations for a Gemini tool-calling turn. */
  declarations(only?: string[]): FunctionDeclaration[] {
    return [...this.tools.values()]
      .filter((t) => !only || only.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
  }

  /**
   * Validate and execute. Validation failures are returned as errors the model
   * can read and correct, rather than thrown, because a retry with a corrected
   * argument set is almost always the right recovery.
   */
  async call(
    ctx: ToolContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; output: unknown; summary: string } | { ok: false; error: string }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `unknown tool '${name}'. Available: ${this.names().join(", ")}` };
    }

    const parsed = (tool.input as z.ZodType<unknown>).safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `invalid arguments for ${name}: ${detail}` };
    }

    if (tool.effect === "spend" && ctx.remainingUsd <= 0) {
      return {
        ok: false,
        error: `${name} would spend money but this run has no budget left; use a tool that does not generate, or finish`,
      };
    }

    try {
      ctx.job.checkpoint();
      const output = await (tool as unknown as Tool<unknown, unknown>).run(ctx, parsed.data);
      const summary = (tool as unknown as Tool<unknown, unknown>).summarize(output);
      return { ok: true, output, summary };
    } catch (e) {
      if (e instanceof MuseError && e.kind === "cancelled") throw e;
      const message = e instanceof Error ? e.message : String(e);
      ctx.log.warn(`tool ${name} failed`, { error: message });
      return { ok: false, error: truncate(message, 500) };
    }
  }
}
