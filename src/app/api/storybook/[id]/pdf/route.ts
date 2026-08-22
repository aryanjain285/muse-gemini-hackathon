/**
 * Download a storybook as a PDF.
 *
 * The illustrations are resolved back from the URLs the book stores to the files on disk, because
 * the PDF embeds the JPEG bytes directly — `DCTDecode` means no decode and no re-encode, so what
 * lands in the file is the same picture the browser was showing.
 */
import fs from "node:fs";
import path from "node:path";
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler } from "@/lib/server/http";
import { Storybooks } from "@/lib/memory/storybooks";
import { PATHS, resolveAssetPath } from "@/lib/core/paths";
import { sha256 } from "@/lib/core/util";
import { exec as runFfmpeg } from "@/lib/visual/ffmpegExec";
import { storybookPdf } from "@/lib/memory/storybookPdf";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** "/api/assets/memories/x.png" back to the file it serves. */
function fileFor(imageUrl: string): string | null {
  const marker = "/api/assets/";
  const at = imageUrl.indexOf(marker);
  if (at < 0) return null;
  const relative = imageUrl.slice(at + marker.length).split("?")[0];
  const abs = resolveAssetPath(decodeURIComponent(relative));
  return abs && fs.existsSync(abs) ? abs : null;
}

/**
 * A JPEG of an image, whatever it started as.
 *
 * PDF embeds JPEG natively and nothing else here does, so the first version of this export skipped
 * anything that was not one — and every drawing the sketch studio makes is a PNG, so the book
 * exported with all of its text and none of its pictures. Converting is a few hundred milliseconds
 * once and free thereafter.
 *
 * Downscaled on the way through: a 1024-pixel illustration is more than an A4 page can show, and
 * five of them at full size make a file nobody wants to send anybody.
 */
async function jpegFor(abs: string): Promise<string | null> {
  if (/\.jpe?g$/i.test(abs)) return abs;
  const stat = fs.statSync(abs);
  const key = sha256(`pdf|${abs}|${Math.trunc(stat.mtimeMs)}`).slice(0, 32);
  const dir = path.join(PATHS.cache, "pdf-jpg");
  const out = path.join(dir, `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(dir, { recursive: true });
  const staging = `${out}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  try {
    await runFfmpeg("ffmpeg", [
      "-y", "-i", abs,
      "-vf", "scale='min(1100,iw)':-2:flags=lanczos",
      "-frames:v", "1", "-q:v", "3",
      staging,
    ]);
    if (!fs.existsSync(staging)) return null;
    try {
      fs.renameSync(staging, out);
    } catch {
      fs.rmSync(staging, { force: true });
    }
    return fs.existsSync(out) ? out : null;
  } catch {
    fs.rmSync(staging, { force: true });
    return null;
  }
}

export const GET = handler("storybook.pdf", async (_req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  const book = Storybooks.get(id);
  if (!book) return fail("no such storybook", 404);

  const pages = await Promise.all(
    book.pages.map(async (page, i) => {
      const source = fileFor(page.imageUrl);
      return {
        heading: page.heading,
        text: page.text,
        imagePath: source ? await jpegFor(source) : null,
        number: i + 1,
      };
    }),
  );

  const bytes = storybookPdf({ title: book.title, dedication: book.dedication, pages });

  const name = `${book.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "storybook"}.pdf`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-cache",
    },
  });
});
