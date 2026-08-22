/**
 * The finished reel. Redirects to the asset route by default so range requests
 * and seeking are handled in one place; `?download=1` forces a save with a
 * readable filename.
 */
import fs from "node:fs";
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok, str } from "@/lib/server/http";
import { slug } from "@/lib/core/util";
import { Assets, Projects, Renders } from "@/lib/db/repo";
import { urlFor } from "@/lib/services/assets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler("project.output", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const project = Projects.get(id);
  if (!project) return fail("project not found", 404);

  const reel = Assets.byRole(id, "final", "reel");
  if (!reel) return fail("no reel has been exported yet", 404);
  if (!fs.existsSync(reel.uri)) return fail("the exported reel is missing from storage", 410);

  const meta = Assets.meta<{ durationS?: number; check?: { ok?: boolean; issues?: string[] } }>(reel);
  const render = Renders.latestDone(id);

  if (str(req, "download") === null) {
    return ok({
      url: urlFor(reel),
      downloadUrl: `/api/projects/${id}/output?download=1`,
      filename: `${slug(project.title)}.mp4`,
      durationS: meta.durationS ?? null,
      bytes: reel.bytes,
      sha256: reel.sha256,
      checkOk: meta.check?.ok !== false,
      issues: meta.check?.issues ?? [],
      specVersion: render?.spec_version ?? null,
      manifest: render ? JSON.parse(render.manifest_json) : null,
    });
  }

  const bytes = fs.readFileSync(reel.uri);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${slug(project.title)}.mp4"`,
      "Cache-Control": "no-store",
    },
  });
});
