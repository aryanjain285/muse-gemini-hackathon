import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, fail, handler, ok } from "@/lib/server/http";
import { Assets, Audit, Projects } from "@/lib/db/repo";
import { Memories, isMemoryId } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import { selectMemories } from "@/lib/memory/enrich";
import { putBytes, urlFor } from "@/lib/services/assets";
import { getBundle } from "@/lib/templates/bundles";
import { autoProfile } from "@/lib/server/views";
import { start } from "@/lib/jobs/runner";
import { truncate } from "@/lib/core/util";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  query: z.string().max(500).default(""),
  memoryIds: z.array(z.string().max(80)).max(8).optional(),
  brief: z.string().max(600).optional(),
  preset: z.string().min(1).default("dreamy_animated_memories"),
  useAgent: z.boolean().default(true),
  autoStart: z.boolean().default(true),
});

/**
 * A finished film already made from exactly these photographs.
 *
 * The memory library holds the same images a project was built from, so asking for a film about
 * them a second time is usually a request to see the one that exists rather than to spend an
 * hour and a budget making a lesser copy. It is also what makes this demonstrable on a machine
 * with no key: the interesting half — which memories belong together and why — costs nothing,
 * and the payoff is a real reel rather than a progress bar.
 *
 * Matched on the digests of the bytes, not on filenames or titles, so a photograph renamed on
 * the way into the library still counts as the same photograph.
 */
function filmAlreadyMadeFrom(memories: MemoryRecord[]): { projectId: string; reelUrl: string } | null {
  const wanted = new Set(memories.map((m) => m.sha256));
  if (wanted.size === 0) return null;

  for (const project of Projects.list(60)) {
    const reel = Assets.byRole(project.id, "final", "reel");
    if (!reel) continue;
    const have = new Set(Assets.byProject(project.id, "upload_image").map((a) => a.sha256));
    const covered = [...wanted].every((digest) => have.has(digest));
    if (covered) return { projectId: project.id, reelUrl: urlFor(reel) };
  }
  return null;
}

export const POST = handler("memories.film", async (req: Request) => {
  bootstrap();
  const input = await body(req, CreateSchema);

  let selectionSummary = "";
  let storyAngle = input.query.trim();
  let selected: MemoryRecord[];
  if (input.memoryIds?.length) {
    const invalid = input.memoryIds.filter((memoryId) => !isMemoryId(memoryId));
    if (invalid.length > 0) return fail("one or more memory ids are invalid", 400);
    selected = input.memoryIds
      .map((memoryId) => Memories.get(memoryId))
      .filter((m): m is MemoryRecord => Boolean(m))
      .slice(0, 5);
    if (selected.length !== Math.min(input.memoryIds.length, 5)) {
      return fail("one or more selected memories no longer exist", 404);
    }
    selectionSummary = `Using ${selected.length} memories you selected.`;
  } else {
    const selection = await selectMemories(input.query || "memories worth turning into a film", 5);
    selectionSummary = selection.summary;
    storyAngle = selection.storyAngle || storyAngle;
    selected = selection.memories
      .map((m) => Memories.get(m.id))
      .filter((m): m is MemoryRecord => Boolean(m));
  }

  if (selected.length === 0) return fail("I could not find any memories for that film", 404);

  // Nothing is created or spent when the film already exists.
  const already = filmAlreadyMadeFrom(selected);
  if (already) {
    return ok({
      projectId: already.projectId,
      jobId: null,
      started: false,
      existing: true,
      reelUrl: already.reelUrl,
      selectionSummary,
      storyAngle,
      memories: selected.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        location: m.location,
        event: m.event,
        imageUrl: `/api/assets/memories/${m.mediaFile.replace(/^media\//, "")}`,
      })),
      story: "",
      studioUrl: `/studio/${already.projectId}`,
    });
  }

  // Read all bytes before creating the project. A missing/corrupt local memory should fail
  // cleanly without leaving a half-created film in the Gallery.
  const sources = selected.map((memory) => ({ memory, bytes: Memories.bytes(memory) }));
  const bundle = getBundle(input.preset);
  const baseBrief = input.brief?.trim() || input.query.trim() || "Turn these memories into a warm, coherent short film.";
  const memoryContext = selected
    .map((m, i) => {
      const where = [m.event, m.location].filter(Boolean).join(" · ");
      const truth = m.userNote || m.description;
      return `${i + 1}) ${m.title}${where ? ` [${where}]` : ""}: ${truncate(truth, 95)}`;
    })
    .join(" ");
  const angle = storyAngle && storyAngle !== input.query.trim() ? ` Story angle: ${truncate(storyAngle, 100)}.` : "";
  const brief = `${truncate(baseBrief, 250)}${angle} Memories: ${memoryContext}`.slice(0, 600);

  const project = Projects.create({
    mode: "generated",
    preset: bundle.id,
    profile: autoProfile(),
    brief,
    title: selected[0]?.event ? `${selected[0].event} — memory film` : "Memory film",
  });

  try {
    // Importing a photograph into the owner's private local memory library is the
    // provenance used by this path; the normal upload flow still asks for consent.
    Projects.patch(project.id, { consent: 1 });
    for (const { memory, bytes } of sources) {
      putBytes({
        projectId: project.id,
        type: "upload_image",
        bytes,
        mime: memory.mime,
        name: memory.originalName,
        metadata: {
          originalName: memory.originalName,
          memoryId: memory.id,
          memoryTitle: memory.title,
          memoryDescription: memory.description,
          memoryNote: memory.userNote,
          memoryContext: memory.context,
          memoryEvent: memory.event,
          memoryLocation: memory.location,
          memoryPeople: memory.people,
          memoryMood: memory.mood,
        },
      });
    }
  } catch (error) {
    Projects.delete(project.id);
    throw error;
  }

  let jobId: string | null = null;
  if (input.autoStart) {
    const result = input.useAgent
      ? start(project.id, "agent", {
          goal:
            "Create a finished 30-second memory film from these selected memories. Preserve the people and emotional truth of the photos. Treat owner-written memory notes as ground truth, use the brief as the narrative, generate the soundtrack, render, critique, repair if needed, and export the reel.",
        }, { idempotency: { memories: selected.map((m) => m.id), at: Date.now() } })
      : start(project.id, "pipeline", {}, { idempotency: { memories: selected.map((m) => m.id), at: Date.now() } });
    if (!result.started) return fail(result.reason ?? "could not start memory film", 409);
    jobId = result.jobId;
  }

  Audit.record({
    projectId: project.id,
    actor: "user",
    action: "memory_film_created",
    payload: { memoryIds: selected.map((m) => m.id), query: input.query, preset: bundle.id, jobId },
  });

  return ok({
    projectId: project.id,
    jobId,
    started: Boolean(jobId),
    selectionSummary,
    storyAngle,
    memories: selected.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      location: m.location,
      event: m.event,
      imageUrl: `/api/assets/memories/${m.mediaFile.replace(/^media\//, "")}`,
    })),
    story: brief,
    studioUrl: `/studio/${project.id}`,
  }, input.autoStart ? 202 : 201);
});
