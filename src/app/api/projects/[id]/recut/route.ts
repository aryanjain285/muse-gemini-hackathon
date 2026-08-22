/**
 * Re-cut an existing film in a different edit style.
 *
 * Nothing is generated. The shots, the score and the frames are already paid for,
 * so this is deterministic composition over existing material: instant, free, and
 * repeatable. GET lists the edits that exist and the ones on offer.
 */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { Assets, Audit, Projects, Specs } from "@/lib/db/repo";
import { EDIT_STYLES, EDIT_STYLE_IDS, OFFERED_STYLES, editRole } from "@/lib/compose/edit";
import { urlFor } from "@/lib/services/assets";
import { isRunning, start } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const RecutSchema = z.object({
  edit: z.enum(EDIT_STYLE_IDS as unknown as [string, ...string[]]),
});

export const GET = handler("recut.list", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);

  const existing = EDIT_STYLE_IDS.map((editId) => {
    const row = Assets.byRole(id, editRole(editId), "reel");
    const meta = row
      ? Assets.meta<{ durationS?: number; cuts?: number[]; check?: { ok?: boolean } }>(row)
      : null;
    return {
      id: editId,
      label: EDIT_STYLES[editId].label,
      blurb: EDIT_STYLES[editId].blurb,
      offered: OFFERED_STYLES.includes(editId),
      url: row ? urlFor(row) : null,
      durationS: meta?.durationS ?? null,
      cuts: meta?.cuts ?? [],
      checkOk: meta?.check?.ok !== false,
    };
  });

  const active = Specs.active(id);
  const shots = active
    ? active.spec.scenes.filter((s) => Assets.byRole(id, s.id, "scene_video")).length
    : 0;

  return ok({ edits: existing, canRecut: shots > 0, shots });
});

export const POST = handler("recut.run", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  if (isRunning(id)) return fail("this project is already working", 409);

  const active = Specs.active(id);
  if (!active) return fail("there is no film to re-cut yet", 409);

  const input = await body(req, RecutSchema);
  const rendered = active.spec.scenes.filter((s) => Assets.byRole(id, s.id, "scene_video")).length;
  if (rendered === 0) return fail("there are no shots to re-cut yet", 409);

  const result = start(
    id,
    "recut",
    { editId: input.edit },
    // A re-cut of the same edit should genuinely run again, so the key includes
    // the moment rather than collapsing to the previous result.
    { idempotency: { edit: input.edit, at: Date.now() } },
  );
  if (!result.started) return fail(result.reason ?? "could not start", 409);

  Audit.record({
    projectId: id,
    actor: "user",
    action: "recut",
    payload: { edit: input.edit, jobId: result.jobId },
  });
  return ok({ started: true, jobId: result.jobId, edit: input.edit }, 202);
});
