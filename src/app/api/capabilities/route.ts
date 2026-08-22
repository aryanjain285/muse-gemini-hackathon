/**
 * What this installation can do right now: which tasks route to a real model,
 * what a full reel would cost under each profile, and how much budget is left.
 * The studio reads this before offering to spend anything.
 */
import { bootstrap } from "@/lib/server/bootstrap";
import { handler, ok } from "@/lib/server/http";
import { capabilityView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

export const GET = handler("capabilities", async () => {
  bootstrap();
  return ok(capabilityView());
});
