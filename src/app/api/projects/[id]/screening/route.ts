/**
 * Run a screening, or read the last one.
 *
 * The reel is already made and already paid for; this looks at it. GET returns the most
 * recent screening so the panel has something to show without spending anything.
 */
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok } from "@/lib/server/http";
import { Assets, Projects, Renders, Specs } from "@/lib/db/repo";
import { lastScreening, screenReel } from "@/lib/services/screening";
import { profileFor } from "@/lib/core/config";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Cuts and accents come from the manifest: the spec holds where a cut was asked for. */
function cutsAndAnchors(projectId: string): { cutsS: number[]; anchorsS: number[] } {
  const render = Renders.latestDone(projectId);
  if (!render) return { cutsS: [], anchorsS: [] };
  try {
    const m = JSON.parse(render.manifest_json) as {
      clips?: { startS: number }[];
      anchorsS?: number[];
    };
    return {
      cutsS: (m.clips ?? []).map((c) => c.startS),
      anchorsS: m.anchorsS ?? [],
    };
  } catch {
    return { cutsS: [], anchorsS: [] };
  }
}

export const GET = handler("screening.read", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  const reel = Assets.byRole(id, "final", "reel");
  return ok({ screening: lastScreening(id), canScreen: Boolean(reel) });
});

export const POST = handler("screening.run", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const project = Projects.get(id);
  if (!project) return fail("project not found", 404);

  const reel = Assets.byRole(id, "final", "reel");
  if (!reel) return fail("there is no film to watch yet", 409);
  const active = Specs.active(id);
  if (!active) return fail("there is no plan to compare against", 409);

  const { cutsS, anchorsS } = cutsAndAnchors(id);
  const screening = await screenReel({
    projectId: id,
    spec: active.spec,
    reel,
    cutsS,
    anchorsS,
    profile: profileFor(project.profile as never),
  });
  return ok({ screening });
});
