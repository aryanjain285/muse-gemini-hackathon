import { afterEach, describe, expect, it } from "vitest";

import { assetUrl, resolveAssetPath } from "@/lib/core/paths";
import { Memories, isMemoryId, memoryView } from "@/lib/memory/store";

const created = new Set<string>();

afterEach(() => {
  for (const id of created) Memories.remove(id);
  created.clear();
});

function makeMemory(seed: string) {
  const bytes = Buffer.from(`memory-test-${seed}-${Date.now()}-${Math.random()}`);
  const record = Memories.create({
    bytes,
    mime: "image/jpeg",
    originalName: `${seed}.jpg`,
    context: "Family trip to Mussoorie",
    userNote: "We stopped here for the view.",
    route: "local",
    insight: {
      title: `Mountain ${seed}`,
      description: "A family memory in the mountains.",
      people: [],
      setting: "mountain viewpoint",
      location: "Mussoorie",
      event: "Family trip",
      activities: ["sightseeing"],
      objects: ["mountains"],
      mood: ["nostalgic"],
      tags: ["mountains", "family"],
      visualQuality: 0.9,
    },
  });
  created.add(record.id);
  return { record, bytes };
}

describe("local JSON memory store", () => {
  it("round-trips a memory and its media URL through the protected asset route", () => {
    const { record } = makeMemory("roundtrip");
    expect(isMemoryId(record.id)).toBe(true);
    expect(Memories.get(record.id)?.title).toBe(record.title);

    const view = memoryView(record);
    expect(view.imageUrl).toMatch(/^\/api\/assets\/memories\//);
    const requestPath = view.imageUrl.replace(/^\/api\/assets\//, "");
    expect(resolveAssetPath(requestPath)).toBe(Memories.mediaPath(record));
    expect(assetUrl(Memories.mediaPath(record))).toBe(view.imageUrl);
  });

  it("returns null rather than throwing for malformed ids", () => {
    expect(Memories.get("../../muse.db")).toBeNull();
    expect(Memories.get("not-a-memory")).toBeNull();
  });

  it("deduplicates identical image bytes", () => {
    const first = makeMemory("dedupe");
    const again = Memories.create({
      bytes: first.bytes,
      mime: "image/jpeg",
      originalName: "copy.jpg",
      route: "local",
      insight: {
        title: "Duplicate",
        description: "duplicate",
        people: [],
        setting: "",
        location: null,
        event: null,
        activities: [],
        objects: [],
        mood: [],
        tags: [],
        visualQuality: 0.5,
      },
    });
    expect(again.id).toBe(first.record.id);
  });

  it("searches user-authored memory truth and persists edits", () => {
    const { record } = makeMemory("search");
    const patched = Memories.patch(record.id, {
      userNote: "Dad insisted we stop here even though we were late.",
      importance: 0.95,
    });
    expect(patched.userNote).toContain("Dad insisted");
    expect(Memories.get(record.id)?.importance).toBe(0.95);
    expect(Memories.search("Dad insisted", 10).map((m) => m.id)).toContain(record.id);
  });

  it("removes the JSON record and media together", () => {
    const { record } = makeMemory("remove");
    Memories.remove(record.id);
    created.delete(record.id);
    expect(Memories.get(record.id)).toBeNull();
  });
});
