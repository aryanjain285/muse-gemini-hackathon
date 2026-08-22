/**
 * Serve a stored asset.
 *
 * Assets are deliberately not placed in `public/`: routing them through a handler
 * keeps one place to add signed, expiring access later, and one place that refuses
 * any path escaping the asset root. Range requests are supported so the preview
 * player can seek without downloading the whole reel.
 */
import fs from "node:fs";
import path from "node:path";
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler } from "@/lib/server/http";
import { PATHS, resolveAssetPath } from "@/lib/core/paths";
import { sha256 } from "@/lib/core/util";
import { exec as runFfmpeg } from "@/lib/visual/ffmpegExec";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  // A phone photograph is converted to JPEG on ingest, but conversion is allowed to fail
  // rather than lose somebody's picture — and then the file keeps its .heic name. Without
  // these it was served as application/octet-stream, so the browser downloaded it instead
  // of showing it, which looks like a broken upload rather than an unconverted one.
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".json": "application/json",
};

function contentType(p: string): string {
  const dot = p.lastIndexOf(".");
  return (dot >= 0 ? CONTENT_TYPES[p.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}

/** Widths a caller may ask for. A free-form number would be a cache the client controls. */
const THUMB_WIDTHS = [160, 320, 640, 1024] as const;

/**
 * A resized copy of an image, made once and kept.
 *
 * A memory gallery showed five photographs at 112 pixels and downloaded 10.2 MB to do it: the
 * originals are phone photographs of two to five megabytes each and every grid, picker and
 * result card was pulling them whole. Resizing on the way out is the difference between a page
 * that appears and a page that arrives.
 *
 * Derived files live under the cache directory, keyed by the source path, its modification time
 * and the width — so re-generating a shot under the same filename produces a different key
 * rather than serving the previous picture at a smaller size.
 */
async function thumbnail(abs: string, width: number): Promise<string | null> {
  const stat = fs.statSync(abs);
  const key = sha256(`${abs}|${Math.trunc(stat.mtimeMs)}|${width}`).slice(0, 32);
  const dir = path.join(PATHS.cache, "thumbs");
  const out = path.join(dir, `${key}.jpg`);
  if (fs.existsSync(out)) return out;

  fs.mkdirSync(dir, { recursive: true });
  try {
    await runFfmpeg("ffmpeg", [
      "-y", "-i", abs,
      "-vf", `scale=${width}:-2:flags=lanczos`,
      "-frames:v", "1", "-q:v", "4",
      out,
    ]);
    return fs.existsSync(out) ? out : null;
  } catch {
    // A resize that fails is not a reason to fail the request: the original still serves.
    return null;
  }
}

export const GET = handler("assets.serve", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { path: segments } = await ctx.params;
  const relative = (segments ?? []).join("/");
  if (!relative) return fail("no asset requested", 400);

  const abs = resolveAssetPath(relative);
  if (!abs) return fail("forbidden", 403);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return fail("not found", 404);

  // ?w= asks for a resized copy. Images only, and only at the widths named above.
  const wanted = Number(new URL(req.url).searchParams.get("w") ?? "");
  const type0 = contentType(abs);
  let served = abs;
  let resized = false;
  if (type0.startsWith("image/") && THUMB_WIDTHS.includes(wanted as (typeof THUMB_WIDTHS)[number])) {
    const thumb = await thumbnail(abs, wanted);
    if (thumb) {
      served = thumb;
      resized = true;
    }
  }

  const stat = fs.statSync(served);
  const type = resized ? "image/jpeg" : type0;
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      // `bytes=-N` is a suffix range: the LAST N bytes, not the first N. Reading an
      // absent first group as 0 answered it with the head of the file, which is a
      // plausible-looking 206 carrying the wrong bytes. Players use suffix ranges to read
      // the moov atom at the end of an MP4, so this is how seeking silently misbehaves.
      const suffix = !match[1] && Boolean(match[2]);
      const start = suffix
        ? Math.max(0, stat.size - Number(match[2]))
        : match[1]
          ? Number(match[1])
          : 0;
      const end = suffix
        ? stat.size - 1
        : match[2]
          ? Math.min(Number(match[2]), stat.size - 1)
          : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size || end < start) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${stat.size}` },
        });
      }
      const buf = Buffer.alloc(end - start + 1);
      const fd = fs.openSync(served, "r");
      try {
        fs.readSync(fd, buf, 0, buf.length, start);
      } finally {
        fs.closeSync(fd);
      }
      return new Response(new Uint8Array(buf), {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Length": String(buf.length),
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-cache",
        },
      });
    }
  }

  const bytes = fs.readFileSync(served);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Accept-Ranges": "bytes",
      // Re-generating a shot or re-cutting a reel writes new bytes to the SAME name:
      // clip-s01-v1-a0.mp4 and the reel keep their filenames across renders, so the
      // premise that these are content-addressed was wrong and a long cache served the
      // previous cut for five minutes after a change. Revalidation keeps the storyboard
      // responsive without ever showing a stale film.
      // A thumbnail's key already contains the source's modification time, so it can never
      // go stale and is worth caching hard. Originals keep revalidating, because a re-render
      // writes new bytes to the same name.
      "Cache-Control": resized ? "public, max-age=31536000, immutable" : "private, no-cache",
      ETag: `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
    },
  });
});
