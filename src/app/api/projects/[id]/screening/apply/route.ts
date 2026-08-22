/**
 * Act on one screening note.
 *
 * The note names the change; this carries it out. Taking a note index rather than a
 * patch keeps the vocabulary closed — a caller cannot invent an operation by posting
 * one, it can only accept something the screening already offered.
 */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { Audit, Projects, Specs } from "@/lib/db/repo";
import { lastScreening } from "@/lib/services/screening";
import { commitDirection } from "@/lib/services/pipeline";
import { isRunning, start } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ApplySchema = z.object({ noteIndex: z.number().int().min(0).max(7) });

export const POST = handler("screening.apply", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  if (isRunning(id)) return fail("this project is already working", 409);

  const screening = lastScreening(id);
  if (!screening) return fail("there are no notes to act on yet", 409);

  const input = await body(req, ApplySchema);
  const note = screening.notes[input.noteIndex];
  if (!note) return fail("no such note", 404);

  if (note.fix.kind === "recut" && note.fix.edit) {
    const result = start(
      id,
      "recut",
      { editId: note.fix.edit },
      { idempotency: { edit: note.fix.edit, at: Date.now() } },
    );
    if (!result.started) return fail(result.reason ?? "could not start", 409);
    Audit.record({
      projectId: id,
      actor: "user",
      action: "screening.apply",
      payload: { note: note.note, fix: note.fix },
    });
    return ok({ applied: true, kind: "recut", jobId: result.jobId, label: note.fix.label }, 202);
  }

  if (note.fix.kind === "reframe" && note.fix.sceneId && note.fix.shotSize) {
    const active = Specs.active(id);
    if (!active) return fail("there is no plan to change", 409);
    const committed = commitDirection({
      projectId: id,
      request: {
        summary: note.fix.label,
        ops: [
          {
            op: "scene_shot_size",
            scene_id: note.fix.sceneId,
            shot_size: note.fix.shotSize as never,
          },
        ],
      },
    });
    if (!committed.accepted) {
      return ok({ applied: false, rejected: committed.rejected, impact: committed.impact });
    }
    Audit.record({
      projectId: id,
      actor: "user",
      action: "screening.apply",
      payload: { note: note.note, fix: note.fix },
    });
    // Reframing changes the plan, so the affected shot has to be made again. Committing
    // the new spec on its own leaves the old picture on screen while the panel reports
    // success, which is the one outcome worse than refusing: the note looks answered and
    // the film has not changed.
    const scenes = committed.invalidatedScenes.filter((sceneId) =>
      active.spec.scenes.some((sc) => sc.id === sceneId),
    );
    const result = start(
      id,
      scenes.length > 0 ? "patch_render" : "recompose",
      scenes.length > 0 ? { sceneIds: scenes, regenerateMusic: false } : {},
      { idempotency: { scenes, at: Date.now() } },
    );
    if (!result.started) {
      return ok({
        applied: false,
        kind: "reframe",
        label: note.fix.label,
        reason: result.reason ?? "the plan changed but the shot could not be re-made",
        invalidatedScenes: scenes,
      });
    }

    return ok(
      {
        applied: true,
        kind: "reframe",
        jobId: result.jobId,
        label: note.fix.label,
        impact: committed.impact,
        invalidatedScenes: scenes,
      },
      202,
    );
  }

  return fail("this note has nothing to apply", 422);
});
