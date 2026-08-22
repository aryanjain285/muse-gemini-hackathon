/** Liveness plus a one-glance summary of what the server can currently do. */
import { bootstrap } from "@/lib/server/bootstrap";
import { handler, ok } from "@/lib/server/http";
import { snapshot } from "@/lib/jobs/runner";
import { capabilityView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

export const GET = handler("health", async () => {
  bootstrap();
  const caps = capabilityView();
  return ok({
    ok: true,
    at: new Date().toISOString(),
    hasApiKey: caps.hasApiKey,
    profile: caps.activeProfile,
    budget: caps.budget,
    runner: snapshot(),
  });
});
