/**
 * Upload references. Files are validated against their real signatures, not the
 * browser's declared MIME type, and are rejected before anything is written.
 */
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok } from "@/lib/server/http";
import { LIMITS } from "@/lib/core/config";
import { Assets, Audit, Projects } from "@/lib/db/repo";
import { normaliseUpload, putBytes, validateUpload } from "@/lib/services/assets";
import { isRunning } from "@/lib/jobs/runner";
import { projectView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler("assets.upload", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);
  if (isRunning(id)) return fail("the project is busy; cancel it before uploading", 409);

  const form = await req.formData().catch(() => null);
  if (!form) return fail("expected multipart/form-data", 400);

  const images = form.getAll("images").filter((v): v is File => v instanceof File);
  const single = form.get("image");
  if (single instanceof File) images.push(single);
  const audio = form.get("audio");

  const existing = Assets.byProject(id, "upload_image").length;
  if (existing + images.length > LIMITS.maxUploads) {
    return fail(
      `that would be ${existing + images.length} photographs; the limit is ${LIMITS.maxUploads}`,
      400,
    );
  }

  const accepted: string[] = [];
  const rejected: { name: string; reason: string }[] = [];

  for (const file of images) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const check = validateUpload(bytes, "image");
    if (!check.ok) {
      rejected.push({ name: file.name, reason: check.reason });
      continue;
    }
    // A phone photograph arrives as HEIC; convert once here so nothing downstream
    // has to know about the container.
    const normal = await normaliseUpload(bytes, check.mime);
    const row = putBytes({
      projectId: id,
      type: "upload_image",
      bytes: normal.bytes,
      mime: normal.mime,
      name: file.name,
      metadata: { originalName: file.name, ...(normal.mime !== check.mime ? { converted: check.mime } : {}) },
    });
    accepted.push(row.id);
  }

  if (audio instanceof File) {
    const bytes = Buffer.from(await audio.arrayBuffer());
    const check = validateUpload(bytes, "audio");
    if (!check.ok) {
      rejected.push({ name: audio.name, reason: check.reason });
    } else {
      const row = putBytes({
        projectId: id,
        type: "upload_audio",
        role: "source_track",
        bytes,
        mime: check.mime,
        name: audio.name,
        metadata: { originalName: audio.name },
      });
      accepted.push(row.id);
      // Bringing a song implies the uploaded-music path.
      Projects.patch(id, { mode: "uploaded" });
    }
  }

  // A request carrying no file at all answered 200 with an empty accepted list, so a client
  // that named the field wrongly — as one of my own test scripts did — read a silent success
  // and went on to start a run with no photographs in the project.
  if (images.length === 0 && !(audio instanceof File)) {
    return fail("no files were sent; attach them as `images` or `audio`", 400);
  }

  if (accepted.length === 0 && rejected.length > 0) {
    return fail(`nothing was accepted: ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}`, 400);
  }

  Audit.record({
    projectId: id,
    actor: "user",
    action: "assets_uploaded",
    payload: { accepted: accepted.length, rejected },
  });

  return ok({ accepted, rejected, project: projectView(id) }, 201);
});
