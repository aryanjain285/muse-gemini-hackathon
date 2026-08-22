/**
 * A storybook as a PDF, written by hand.
 *
 * No dependency, for two reasons. A PDF writer is a large amount of code to carry for one export,
 * and the one thing this export needs — putting a JPEG on a page — the format does natively:
 * `DCTDecode` means the image bytes go in exactly as they are, no decoding and no re-encoding, so
 * a page's illustration is the same file the browser was serving.
 *
 * Text uses Helvetica, which every reader has because it is one of the fourteen fonts the
 * specification requires them to provide. That avoids embedding a font file, at the cost of
 * measuring lines against a table of widths rather than against the real thing.
 */
import fs from "node:fs";

/** A4 portrait, in points. */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 54;

export interface PdfPage {
  heading: string;
  text: string;
  /** Absolute path to a JPEG. Anything else is skipped rather than corrupting the file. */
  imagePath: string | null;
  number: number;
}

/**
 * Helvetica advance widths for the printable ASCII range, in 1/1000 em.
 *
 * Wrapping by character count puts a ragged edge in the wrong place — "iiiii" and "MMMMM" are not
 * the same width — and the whole point of the export is that it looks composed.
 */
const HELVETICA: Record<string, number> = (() => {
  const w: Record<string, number> = {};
  const groups: [string, number][] = [
    [" !", 278],
    ['"', 355],
    ["#$", 556],
    ["%", 889],
    ["&", 667],
    ["'", 191],
    ["()", 333],
    ["*", 389],
    ["+", 584],
    [",.", 278],
    ["-", 333],
    ["/", 278],
    ["0123456789", 556],
    [":;", 278],
    ["<=>", 584],
    ["?", 556],
    ["@", 1015],
    ["ABDEHKNOPQRUXY", 722],
    ["C", 722],
    ["FI", 278],
    ["G", 778],
    ["JLS", 611],
    ["M", 833],
    ["T", 611],
    ["V", 667],
    ["W", 944],
    ["Z", 611],
    ["[]", 278],
    ["\\", 278],
    ["^", 469],
    ["_", 556],
    ["`", 333],
    ["abcdeghnopqsu", 556],
    ["f", 278],
    ["ijl", 222],
    ["k", 500],
    ["m", 833],
    ["rt", 333],
    ["vxyz", 500],
    ["w", 722],
    ["{}", 334],
    ["|", 260],
    ["~", 584],
  ];
  for (const [chars, width] of groups) for (const c of chars) w[c] = width;
  return w;
})();

function textWidth(s: string, size: number): number {
  let total = 0;
  for (const ch of s) total += HELVETICA[ch] ?? 556;
  return (total / 1000) * size;
}

/** Break a paragraph into lines that fit, on word boundaries. */
function wrap(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Escape the three characters that would otherwise end a PDF string early. */
function pdfString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Read a JPEG's dimensions from its own markers.
 *
 * Needed to place the image without distorting it, and reading the file is cheaper and more
 * reliable than asking something else what shape it is.
 */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at < bytes.length - 9) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1];
    // Start-of-frame markers carry the dimensions; the four excluded are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/** Build the file. Objects are numbered as they are appended and cross-referenced at the end. */
export function storybookPdf(input: {
  title: string;
  dedication: string;
  pages: PdfPage[];
}): Buffer {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return objects.length; // object numbers are 1-based
  };

  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const boldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  interface Placed {
    contentId: number;
    imageId: number | null;
    imageBox: { x: number; y: number; w: number; h: number } | null;
  }
  const placed: Placed[] = [];

  // ── the cover ─────────────────────────────────────────────────────────────
  {
    const lines: string[] = [];
    const titleSize = 30;
    lines.push("BT /F2 " + titleSize + " Tf");
    const titleLines = wrap(input.title, titleSize, PAGE_W - MARGIN * 2);
    let y = PAGE_H / 2 + 40;
    for (const line of titleLines) {
      const x = (PAGE_W - textWidth(line, titleSize)) / 2;
      lines.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(line)}) Tj`);
      y -= titleSize * 1.2;
    }
    lines.push("ET");
    if (input.dedication) {
      const size = 12;
      const ded = wrap(input.dedication, size, PAGE_W - MARGIN * 4);
      lines.push("BT /F1 " + size + " Tf 0.35 0.35 0.35 rg");
      let dy = y - 18;
      for (const line of ded) {
        const x = (PAGE_W - textWidth(line, size)) / 2;
        lines.push(`1 0 0 1 ${x.toFixed(2)} ${dy.toFixed(2)} Tm (${pdfString(line)}) Tj`);
        dy -= size * 1.4;
      }
      lines.push("ET");
    }
    const stream = lines.join("\n");
    placed.push({
      contentId: add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
      imageId: null,
      imageBox: null,
    });
  }

  // ── one page per page ─────────────────────────────────────────────────────
  for (const page of input.pages) {
    let imageId: number | null = null;
    let imageBox: Placed["imageBox"] = null;

    if (page.imagePath && fs.existsSync(page.imagePath)) {
      const bytes = fs.readFileSync(page.imagePath);
      const size = jpegSize(bytes);
      if (size) {
        imageId = add(
          Buffer.concat([
            Buffer.from(
              `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} ` +
                `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
              "latin1",
            ),
            bytes,
            Buffer.from("\nendstream", "latin1"),
          ]),
        );
        // Fit inside the upper two thirds, keeping the aspect ratio.
        const boxW = PAGE_W - MARGIN * 2;
        const boxH = PAGE_H * 0.52;
        const scale = Math.min(boxW / size.width, boxH / size.height);
        const w = size.width * scale;
        const h = size.height * scale;
        imageBox = { x: (PAGE_W - w) / 2, y: PAGE_H - MARGIN - h, w, h };
      }
    }

    const lines: string[] = [];
    if (imageId && imageBox) {
      lines.push(
        `q ${imageBox.w.toFixed(2)} 0 0 ${imageBox.h.toFixed(2)} ${imageBox.x.toFixed(2)} ${imageBox.y.toFixed(2)} cm /Im0 Do Q`,
      );
    }

    let y = (imageBox ? imageBox.y : PAGE_H - MARGIN) - 46;
    if (page.heading) {
      const size = 17;
      lines.push(`BT /F2 ${size} Tf 0.08 0.08 0.09 rg`);
      for (const line of wrap(page.heading, size, PAGE_W - MARGIN * 2)) {
        lines.push(`1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${pdfString(line)}) Tj`);
        y -= size * 1.25;
      }
      lines.push("ET");
      y -= 8;
    }
    {
      const size = 12;
      lines.push(`BT /F1 ${size} Tf 0.16 0.16 0.18 rg`);
      for (const line of wrap(page.text, size, PAGE_W - MARGIN * 2)) {
        lines.push(`1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${pdfString(line)}) Tj`);
        y -= size * 1.55;
      }
      lines.push("ET");
    }
    {
      const size = 9;
      const label = String(page.number);
      lines.push(
        `BT /F1 ${size} Tf 0.45 0.45 0.45 rg 1 0 0 1 ${(PAGE_W - MARGIN - textWidth(label, size)).toFixed(2)} ${(
          MARGIN - 18
        ).toFixed(2)} Tm (${pdfString(label)}) Tj ET`,
      );
    }

    const stream = lines.join("\n");
    placed.push({
      contentId: add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
      imageId,
      imageBox,
    });
  }

  // Page objects reference the pages tree, which does not exist yet, so its number is reserved by
  // knowing it comes directly after them.
  const pageIds: number[] = [];
  const pagesTreeId = objects.length + placed.length + 1;
  for (const p of placed) {
    const resources =
      `<< /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >>` +
      (p.imageId ? ` /XObject << /Im0 ${p.imageId} 0 R >>` : "") +
      " >>";
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources ${resources} /Contents ${p.contentId} 0 R >>`,
      ),
    );
  }

  const treeId = add(
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] >>`,
  );
  if (treeId !== pagesTreeId) {
    // The reservation above is arithmetic, and arithmetic that is wrong produces a file a reader
    // opens as blank. Better to refuse than to hand somebody a broken book.
    throw new Error(`pdf page tree numbering is off: expected ${pagesTreeId}, got ${treeId}`);
  }
  const catalogId = add(`<< /Type /Catalog /Pages ${treeId} 0 R >>`);
  const infoId = add(
    `<< /Title (${pdfString(input.title)}) /Producer (MUSE) /Creator (MUSE) >>`,
  );

  // ── assemble, recording where each object starts ──────────────────────────
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks: Buffer[] = [header];
  let offset = header.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    const opener = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const closer = Buffer.from("\nendobj\n", "latin1");
    offsets.push(offset);
    chunks.push(opener, body, closer);
    offset += opener.length + body.length + closer.length;
  });

  const xrefAt = offset;
  const xref = [
    `xref`,
    `0 ${objects.length + 1}`,
    `0000000000 65535 f `,
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    `trailer`,
    `<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>`,
    `startxref`,
    String(xrefAt),
    `%%EOF`,
  ].join("\n");
  chunks.push(Buffer.from(`${xref}\n`, "latin1"));

  return Buffer.concat(chunks);
}
