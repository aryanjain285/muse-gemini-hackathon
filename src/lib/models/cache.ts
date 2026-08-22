/**
 * Content-addressed cache for model responses.
 *
 * Every request is hashed with its model, task and full payload. A hit replays
 * the stored response without touching the network, which makes a second run of
 * the same project free. Binary payloads (images, video, audio) are stored
 * alongside their JSON envelope rather than base64-inlined, so the cache stays
 * cheap to read.
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS, ensureDirs } from "@/lib/core/paths";
import { hashJson } from "@/lib/core/util";
import { readEnv } from "@/lib/core/config";
import { log } from "@/lib/core/logger";

export interface CacheEntry<T = unknown> {
  key: string;
  json: T;
  /** Absolute path to the binary payload, when the response carried bytes. */
  binPath?: string;
  createdAt: string;
}

function keyFor(parts: {
  model: string;
  task: string;
  payload: unknown;
  /** Bump to invalidate a whole class of cached responses after a prompt change. */
  version?: string;
}): string {
  return hashJson({
    m: parts.model,
    t: parts.task,
    v: parts.version ?? "1",
    p: parts.payload,
  });
}

function slotFor(key: string): { dir: string; json: string; bin: string } {
  // Shard by first two hex chars so a long demo session does not create one
  // directory with thousands of entries.
  const dir = path.join(PATHS.cache, key.slice(0, 2));
  return {
    dir,
    json: path.join(dir, `${key}.json`),
    bin: path.join(dir, `${key}.bin`),
  };
}

export const cache = {
  key: keyFor,

  enabled(): boolean {
    return readEnv().cacheEnabled;
  },

  get<T = unknown>(key: string): CacheEntry<T> | null {
    if (!cache.enabled()) return null;
    const slot = slotFor(key);
    try {
      if (!fs.existsSync(slot.json)) return null;
      const raw = JSON.parse(fs.readFileSync(slot.json, "utf8")) as {
        json: T;
        hasBin: boolean;
        createdAt: string;
      };
      const entry: CacheEntry<T> = { key, json: raw.json, createdAt: raw.createdAt };
      if (raw.hasBin && fs.existsSync(slot.bin)) entry.binPath = slot.bin;
      return entry;
    } catch (e) {
      log.warn("cache read failed", { key, error: String(e) });
      return null;
    }
  },

  /** Read the cached binary payload, if any. */
  bytes(key: string): Buffer | null {
    const slot = slotFor(key);
    try {
      return fs.existsSync(slot.bin) ? fs.readFileSync(slot.bin) : null;
    } catch {
      return null;
    }
  },

  put<T = unknown>(key: string, json: T, bin?: Buffer | null): CacheEntry<T> {
    ensureDirs();
    const slot = slotFor(key);
    fs.mkdirSync(slot.dir, { recursive: true });
    const hasBin = Boolean(bin && bin.length > 0);
    if (hasBin && bin) fs.writeFileSync(slot.bin, bin);
    const createdAt = new Date().toISOString();
    fs.writeFileSync(slot.json, JSON.stringify({ json, hasBin, createdAt }), "utf8");
    return { key, json, createdAt, ...(hasBin ? { binPath: slot.bin } : {}) };
  },

  has(key: string): boolean {
    return cache.enabled() && fs.existsSync(slotFor(key).json);
  },

  /** Count and total size, for the doctor script. */
  stats(): { entries: number; bytes: number } {
    let entries = 0;
    let bytes = 0;
    if (!fs.existsSync(PATHS.cache)) return { entries, bytes };
    for (const shard of fs.readdirSync(PATHS.cache)) {
      const dir = path.join(PATHS.cache, shard);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const st = fs.statSync(path.join(dir, f));
        bytes += st.size;
        if (f.endsWith(".json")) entries++;
      }
    }
    return { entries, bytes };
  },

  clear(): void {
    if (!fs.existsSync(PATHS.cache)) return;
    fs.rmSync(PATHS.cache, { recursive: true, force: true });
    fs.mkdirSync(PATHS.cache, { recursive: true });
  },
};
