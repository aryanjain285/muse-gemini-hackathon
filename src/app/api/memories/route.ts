import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, ok } from "@/lib/server/http";
import { Memories, memoryView } from "@/lib/memory/store";
import { enrichMemory } from "@/lib/memory/enrich";
import { normaliseUpload, validateUpload } from "@/lib/services/assets";
import { sha256 } from "@/lib/core/util";

export const dynamic = "force-dynamic";

export const GET = handler("memories.list", async (req: Request) => {
  bootstrap();
  const url = new URL(req.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const records = query ? Memories.search(query, 80) : Memories.list().slice(0, 120);
  return ok({ memories: records.map(memoryView), total: records.length });
});

export const POST = handler("memories.upload", async (req: Request) => {
  bootstrap();
  const form = await req.formData().catch(() => null);
  if (!form) return fail("expected multipart/form-data", 400);

  const images = form.getAll("images").filter((v): v is File => v instanceof File);
  const single = form.get("image");
  if (single instanceof File) images.push(single);
  if (images.length === 0) return fail("attach at least one photograph as `images`", 400);
  if (images.length > 12) return fail("import at most 12 memories at a time", 400);

  const context = typeof form.get("context") === "string" ? String(form.get("context")).slice(0, 400) : "";
  const userNote = typeof form.get("note") === "string" ? String(form.get("note")).slice(0, 500) : "";
  const accepted = [];
  const duplicates = [];
  const rejected: { name: string; reason: string }[] = [];

  // Deliberately sequential. A burst of vision calls is more likely to trip demo quota
  // than save meaningful wall time, and each accepted record appears independently.
  for (const file of images) {
    try {
      const raw = Buffer.from(await file.arrayBuffer());
      const check = validateUpload(raw, "image");
      if (!check.ok) {
        rejected.push({ name: file.name, reason: check.reason });
        continue;
      }
      const normal = await normaliseUpload(raw, check.mime);
      const digest = sha256(normal.bytes);
      const existing = Memories.findBySha(digest);
      if (existing) {
        duplicates.push(memoryView(existing));
        continue;
      }

      const enriched = await enrichMemory({ bytes: normal.bytes, mime: normal.mime, filename: file.name, context });
      const record = Memories.create({
        bytes: normal.bytes,
        mime: normal.mime,
        originalName: file.name,
        insight: enriched.insight,
        context,
        userNote,
        route: enriched.route,
      });
      accepted.push(memoryView(record));
    } catch (error) {
      rejected.push({ name: file.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (accepted.length === 0 && duplicates.length === 0) {
    return fail(`nothing was accepted: ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}`, 400);
  }
  return ok({ memories: accepted, duplicates, rejected }, accepted.length > 0 ? 201 : 200);
});
