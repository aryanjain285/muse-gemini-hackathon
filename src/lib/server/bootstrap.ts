/**
 * Server bootstrap. Route handlers call `bootstrap()` before doing anything, so
 * the job registry is populated and interrupted work is reconciled regardless of
 * which route happens to be hit first after a restart.
 *
 * Idempotent and cheap: everything after the first call is a boolean check.
 */
import { ensureDirs } from "@/lib/core/paths";
import { db } from "@/lib/db/client";
import { log } from "@/lib/core/logger";
import { resumeOrphans } from "@/lib/jobs/runner";
import { registerPipelineHandlers } from "@/lib/services/pipeline";
import { registerAgentHandler } from "@/lib/agent/loop";

const g = globalThis as unknown as { __museBootstrapped?: boolean };

export function bootstrap(): void {
  if (g.__museBootstrapped) return;
  g.__museBootstrapped = true;

  ensureDirs();
  // Touching the database applies the schema, so there is no migrate step to
  // forget before a demo.
  db();

  registerPipelineHandlers();
  registerAgentHandler();

  const orphans = resumeOrphans();
  log.info("muse server ready", { resumableJobs: orphans.length });
}
