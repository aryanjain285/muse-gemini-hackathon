/** The spend ledger: the ceiling, what has gone, and where it went. */
import { bootstrap } from "@/lib/server/bootstrap";
import { handler, ok, num } from "@/lib/server/http";
import { round } from "@/lib/core/util";
import { Ledger } from "@/lib/db/repo";
import { budget } from "@/lib/models/governor";

export const dynamic = "force-dynamic";

export const GET = handler("budget", async (req: Request) => {
  bootstrap();
  const limit = Math.max(1, Math.min(200, num(req, "limit", 50)));
  return ok({
    budget: budget(),
    byModel: Ledger.byModel().map((r) => ({ ...r, usd: round(r.usd, 5) })),
    recent: Ledger.recent(limit).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      task: r.task,
      model: r.model,
      unit: r.unit,
      quantity: r.quantity,
      usd: round(r.usd, 6),
      cacheHit: r.cache_hit === 1,
      estimated: r.estimated === 1,
      at: r.created_at,
    })),
  });
});
