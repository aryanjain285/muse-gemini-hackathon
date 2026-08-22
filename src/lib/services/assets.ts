/**
 * Asset service: validation, storage, hashing and retrieval.
 *
 * The storage interface is deliberately narrow — put bytes, get bytes, get a URL
 * — so the local filesystem implementation can be swapped for a bucket without
 * touching any caller.
 *
 * Uploads are validated against real file signatures rather than the
 * client-supplied MIME type, because the declared type is attacker-controlled and
 * a mislabelled file would otherwise reach ffmpeg.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LIMITS } from "@/lib/core/config";
import { assetUrl, projectDir } from "@/lib/core/paths";
import { permanent, safeFilename, sha256 } from "@/lib/core/util";
import { Assets } from "@/lib/db/repo";
import { ffmpeg } from "@/lib/compose/ffmpeg";
import type { AssetRow, AssetType } from "@/lib/db/types";

// ── file signature sniffing ──────────────────────────────────────────────────

export type SniffedKind =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "audio/mpeg"
  | "audio/wav"
  | "audio/mp4"
  | "audio/ogg"
  | "video/mp4"
  | "unknown";

/**
 * Identify a file from its leading bytes. Only formats we can actually decode
 * are recognised; anything else is rejected rather than passed through.
 */
/** ISO brands used by HEIF stills and by the sequences a burst or Live Photo makes. */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif"]);

export function sniff(buf: Buffer): SniffedKind {
  const b = buf;
  const startsWith = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  const ascii = (offset: number, text: string) =>
    b.length >= offset + text.length && b.subarray(offset, offset + text.length).toString("latin1") === text;

  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (startsWith(0x49, 0x44, 0x33)) return "audio/mpeg"; // ID3-tagged mp3
  // Bare MPEG audio frame sync: 11 set bits.
  if (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (ascii(4, "ftyp")) {
    const brand = b.subarray(8, 12).toString("latin1");
    if (brand.startsWith("M4A") || brand.startsWith("M4B")) return "audio/mp4";
    // What an iPhone actually produces. These brands share the ISO container with
    // MP4, so without naming them a photo library arrives as "video/mp4" and is
    // rejected for not being an image — which is the wrong answer to the commonest
    // upload there is.
    if (HEIF_BRANDS.has(brand)) return "image/heic";
    return "video/mp4";
  }
  return "unknown";
}

export interface ValidationOk {
  ok: true;
  mime: SniffedKind;
  bytes: number;
}
export interface ValidationFail {
  ok: false;
  reason: string;
}

/** Validate an upload before it is written anywhere. */
export function validateUpload(
  buf: Buffer,
  expect: "image" | "audio",
): ValidationOk | ValidationFail {
  if (buf.length === 0) return { ok: false, reason: "file is empty" };

  const limit = expect === "image" ? LIMITS.maxUploadBytes : LIMITS.maxAudioBytes;
  if (buf.length > limit) {
    return {
      ok: false,
      reason: `file is ${(buf.length / 1024 / 1024).toFixed(1)}MB, limit is ${(limit / 1024 / 1024).toFixed(0)}MB`,
    };
  }

  const mime = sniff(buf);
  if (mime === "unknown") {
    return { ok: false, reason: "unrecognised file format" };
  }
  const allowed: readonly string[] = expect === "image" ? LIMITS.imageMime : LIMITS.audioMime;
  if (!allowed.includes(mime)) {
    return {
      ok: false,
      reason: `${mime} is not accepted here; expected ${expect === "image" ? "JPEG, PNG, WebP or HEIC" : "MP3, WAV, M4A or OGG"}`,
    };
  }
  return { ok: true, mime, bytes: buf.length };
}

// ── storage ──────────────────────────────────────────────────────────────────

const EXT_FOR: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
};

export function extFor(mime: string): string {
  return EXT_FOR[mime.split(";")[0].trim().toLowerCase()] ?? "bin";
}

/**
 * Bring an upload into a format the rest of MUSE can rely on.
 *
 * HEIC is accepted because it is what a phone produces, and converted here because
 * nothing downstream should have to know that. The image model, the styliser and every
 * ffmpeg still are all fed JPEG either way, so normalising once at the boundary is
 * cheaper than teaching four other places about a container.
 *
 * A failed conversion returns the original bytes rather than throwing: the upload is
 * still the user's photograph, and a clear failure later beats losing it here.
 */
export async function normaliseUpload(
  bytes: Buffer,
  mime: SniffedKind,
): Promise<{ bytes: Buffer; mime: SniffedKind }> {
  if (mime !== "image/heic") return { bytes, mime };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-heic-"));
  const inPath = path.join(dir, "in.heic");
  const outPath = path.join(dir, "out.jpg");
  try {
    fs.writeFileSync(inPath, bytes);
    // -update 1 is required for a single still: without it ffmpeg wants a numbered
    // sequence pattern and refuses the write.
    await ffmpeg(["-y", "-i", inPath, "-frames:v", "1", "-update", "1", "-q:v", "2", outPath], {
      timeoutMs: 45_000,
    });
    if (!fs.existsSync(outPath)) return { bytes, mime };
    return { bytes: fs.readFileSync(outPath), mime: "image/jpeg" };
  } catch {
    return { bytes, mime };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Persist bytes for a project and register the asset. Content-addressed name. */
export function putBytes(input: {
  projectId: string;
  type: AssetType;
  role?: string | null;
  bytes: Buffer;
  mime: string;
  /** Original filename, only used to keep a readable suffix. */
  name?: string;
  metadata?: Record<string, unknown>;
}): AssetRow {
  const dir = projectDir(input.projectId);
  const hash = sha256(input.bytes);
  const label = input.name ? safeFilename(path.parse(input.name).name).slice(0, 24) : input.type;
  const filename = `${input.type}-${label}-${hash.slice(0, 10)}.${extFor(input.mime)}`;
  const abs = path.join(dir, filename);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, input.bytes);

  return Assets.create({
    projectId: input.projectId,
    type: input.type,
    role: input.role ?? null,
    uri: abs,
    mime: input.mime,
    bytes: input.bytes.length,
    sha256: hash,
    metadata: input.metadata,
  });
}

/**
 * Register a file the pipeline already wrote to disk (a render, a stylised
 * still) without copying it.
 */
export function registerFile(input: {
  projectId: string;
  type: AssetType;
  role?: string | null;
  filePath: string;
  mime: string;
  metadata?: Record<string, unknown>;
  /**
   * Insert a row even though this exact file is already registered.
   *
   * Readers resolve a scene's asset by taking the newest row, so re-registering a file is how
   * an earlier take is made current again. That is a deliberate act and the only reason to
   * want a duplicate.
   */
  duplicate?: boolean;
}): AssetRow {
  if (!fs.existsSync(input.filePath)) {
    throw permanent(`cannot register missing file ${input.filePath}`);
  }
  const bytes = fs.readFileSync(input.filePath);
  const digest = sha256(bytes);

  // A cache hit hands back the same path and bytes it did last time, and every caller that
  // reaches one registered the result again: one project accumulated eleven rows for a single
  // score, nine for its reel, nine for its poster. Nothing read wrongly, because readers take
  // the newest, but the table grew for no reason and any count over it was inflated.
  if (!input.duplicate) {
    const already = Assets.byProject(input.projectId, input.type).find(
      (row) => row.uri === input.filePath && row.sha256 === digest,
    );
    if (already) return already;
  }

  return Assets.create({
    projectId: input.projectId,
    type: input.type,
    role: input.role ?? null,
    uri: input.filePath,
    mime: input.mime,
    bytes: bytes.length,
    sha256: digest,
    metadata: input.metadata,
  });
}

export function readAsset(assetId: string): { row: AssetRow; bytes: Buffer } {
  const row = Assets.get(assetId);
  if (!row) throw permanent(`asset ${assetId} not found`);
  if (!fs.existsSync(row.uri)) throw permanent(`asset ${assetId} is missing from storage`);
  return { row, bytes: fs.readFileSync(row.uri) };
}

export function assetBytes(row: AssetRow): Buffer {
  if (!fs.existsSync(row.uri)) throw permanent(`asset ${row.id} is missing from storage`);
  return fs.readFileSync(row.uri);
}

/** Browser-facing URL for an asset. */
export function urlFor(row: AssetRow): string {
  return assetUrl(row.uri);
}

/**
 * Verify stored bytes still match the recorded hash. Run before a render so a
 * truncated download cannot reach the composer.
 */
export function verifyChecksum(row: AssetRow): boolean {
  try {
    return sha256(fs.readFileSync(row.uri)) === row.sha256;
  } catch {
    return false;
  }
}

/** Remove every file for a project, then the rows. Used by project deletion. */
export function purgeProjectAssets(projectId: string): number {
  const dir = path.join(projectDir(projectId));
  let removed = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        removed++;
      } catch {
        /* leave a locked file behind rather than failing the delete */
      }
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      /* non-empty is fine */
    }
  }
  return removed;
}
