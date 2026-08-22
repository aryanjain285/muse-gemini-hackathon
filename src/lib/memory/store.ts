import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { PATHS, assetUrl } from "@/lib/core/paths";
import { id } from "@/lib/core/util";
import type { MemoryInsight, MemoryRecord, MemoryView } from "./types";

const RECORDS = path.join(PATHS.memories, "records");
const MEDIA = path.join(PATHS.memories, "media");
const MEMORY_ID = /^mem_[A-Za-z0-9_-]+$/;

function ensure(): void {
  fs.mkdirSync(RECORDS, { recursive: true });
  fs.mkdirSync(MEDIA, { recursive: true });
}

function extFor(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

export function isMemoryId(value: string): boolean {
  return MEMORY_ID.test(value);
}

function recordPath(memoryId: string): string {
  if (!isMemoryId(memoryId)) throw new Error("invalid memory id");
  return path.join(RECORDS, `${memoryId}.json`);
}

function mediaPath(record: MemoryRecord): string {
  const abs = path.resolve(PATHS.memories, record.mediaFile);
  const root = path.resolve(PATHS.memories);
  if (!(abs === root || abs.startsWith(root + path.sep))) throw new Error("invalid memory media path");
  return abs;
}

function atomicJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

function readOne(file: string): MemoryRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MemoryRecord;
    if (!parsed || !isMemoryId(parsed.id) || typeof parsed.mediaFile !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function searchText(record: MemoryRecord): string {
  return [
    record.title,
    record.description,
    record.setting,
    record.location ?? "",
    record.event ?? "",
    record.userNote,
    record.context,
    ...record.people,
    ...record.activities,
    ...record.objects,
    ...record.mood,
    ...record.tags,
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function memoryView(record: MemoryRecord): MemoryView {
  const { mediaFile: _mediaFile, ...rest } = record;
  return { ...rest, imageUrl: assetUrl(mediaPath(record)), searchText: searchText(record) };
}

export const Memories = {
  create(input: {
    bytes: Buffer;
    mime: string;
    originalName: string;
    insight: MemoryInsight;
    userNote?: string;
    context?: string;
    capturedAt?: string | null;
    route?: string;
  }): MemoryRecord {
    ensure();
    const digest = crypto.createHash("sha256").update(input.bytes).digest("hex");
    const existing = Memories.findBySha(digest);
    if (existing) return existing;

    const memoryId = id("mem");
    const ext = extFor(input.mime);
    const mediaFile = `media/${memoryId}${ext}`;
    const mediaAbs = path.join(PATHS.memories, mediaFile);
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: memoryId,
      mediaFile,
      mime: input.mime,
      bytes: input.bytes.length,
      sha256: digest,
      originalName: input.originalName,
      capturedAt: input.capturedAt ?? null,
      userNote: input.userNote?.trim() ?? "",
      context: input.context?.trim() ?? "",
      importance: 0.7,
      createdAt: now,
      updatedAt: now,
      provenance: {
        observedBy: input.route?.startsWith("gemini:") ? "gemini" : "local",
        modelRoute: input.route ?? "local",
      },
      ...input.insight,
    };

    let mediaWritten = false;
    try {
      fs.writeFileSync(mediaAbs, input.bytes, { flag: "wx" });
      mediaWritten = true;
      atomicJson(recordPath(memoryId), record);
      return record;
    } catch (error) {
      if (mediaWritten) fs.rmSync(mediaAbs, { force: true });
      throw error;
    }
  },

  get(memoryId: string): MemoryRecord | null {
    ensure();
    if (!isMemoryId(memoryId)) return null;
    const file = recordPath(memoryId);
    return fs.existsSync(file) ? readOne(file) : null;
  },

  list(): MemoryRecord[] {
    ensure();
    return fs
      .readdirSync(RECORDS)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readOne(path.join(RECORDS, name)))
      .filter((r): r is MemoryRecord => Boolean(r))
      .filter((record) => {
        try {
          return fs.existsSync(mediaPath(record));
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  views(): MemoryView[] {
    return Memories.list().map(memoryView);
  },

  findBySha(digest: string): MemoryRecord | null {
    return Memories.list().find((record) => record.sha256 === digest) ?? null;
  },

  search(query: string, limit = 40): MemoryRecord[] {
    const all = Memories.list();
    const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (tokens.length === 0) return all.slice(0, limit);
    return all
      .map((record) => {
        const haystack = searchText(record).toLowerCase();
        const title = record.title.toLowerCase();
        const location = (record.location ?? "").toLowerCase();
        const event = (record.event ?? "").toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (title.includes(token)) score += 5;
          if (location.includes(token)) score += 6;
          if (event.includes(token)) score += 6;
          if (haystack.includes(token)) score += 2;
        }
        score += record.importance;
        return { record, score };
      })
      .filter((x) => x.score > 0.8)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.record);
  },

  patch(memoryId: string, fields: Partial<Pick<MemoryRecord,
    "title" | "description" | "location" | "event" | "userNote" | "context" | "importance" | "people" | "mood" | "tags"
  >>): MemoryRecord {
    const current = Memories.get(memoryId);
    if (!current) throw new Error("memory not found");
    const next: MemoryRecord = { ...current, ...fields, updatedAt: new Date().toISOString() };
    atomicJson(recordPath(memoryId), next);
    return next;
  },

  remove(memoryId: string): void {
    const current = Memories.get(memoryId);
    if (!current) return;
    fs.rmSync(mediaPath(current), { force: true });
    fs.rmSync(recordPath(memoryId), { force: true });
  },

  bytes(record: MemoryRecord): Buffer {
    const file = mediaPath(record);
    if (!fs.existsSync(file)) throw new Error(`memory media missing for ${record.id}`);
    return fs.readFileSync(file);
  },

  mediaPath(record: MemoryRecord): string {
    return mediaPath(record);
  },
};
