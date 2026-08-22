/**
 * The PDF export, checked the way a reader parses it.
 *
 * This shipped broken twice, and both times because "the structure looks right" was the whole of
 * the verification. The first export had every page and no pictures, because the illustrations are
 * PNGs and PDF embeds only JPEG. The second was rejected by a strict reader while a lenient one
 * showed it, which is the worst way to find out: the file opens on the machine that made it.
 *
 * So these assert the things a parser actually requires, on a real generated file:
 *   - every cross-reference offset lands on the object header it claims
 *   - every stream's declared /Length matches the bytes between `stream` and `endstream`
 *   - every text literal is balanced, so no page can end mid-sentence
 *   - an image, when one is given, is embedded and drawn
 *   - a title full of smart punctuation cannot smuggle a parenthesis into a literal
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { storybookPdf } from "@/lib/memory/storybookPdf";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-pdf-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A tiny valid JPEG, so the image path is exercised rather than skipped. */
function jpeg(): string {
  const at = path.join(dir, "tile.jpg");
  // 1x1 baseline JPEG. Small, but a real one: it carries an SOF0 marker to read a size from.
  const base64 =
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDc0NP/bAEMBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgAAQABAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAG/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA/9k=";
  fs.writeFileSync(at, Buffer.from(base64, "base64"));
  return at;
}

interface Stream {
  declared: number;
  actual: number;
}

/** Pull every stream's declared length and the bytes that follow, the way a parser would. */
function streams(pdf: Buffer): Stream[] {
  const found: Stream[] = [];
  const text = pdf.toString("latin1");
  const re = /\/Length (\d+)[^>]*>>\s*stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const declared = Number(match[1]);
    const start = match.index + match[0].length;
    const end = text.indexOf("endstream", start);
    // The bytes between the stream keyword and `endstream`, less the newline before it.
    found.push({ declared, actual: Math.max(0, end - start - 1) });
  }
  return found;
}

function crossReferences(pdf: Buffer): { offset: number; lands: boolean }[] {
  const text = pdf.toString("latin1");
  // Follow `startxref` to the table rather than searching for the keyword: "startxref" contains
  // "xref", so looking for the last occurrence lands past the table and finds nothing — which is
  // a test that passes by measuring zero things.
  const pointer = /startxref\s+(\d+)/.exec(text);
  if (!pointer) return [];
  const at = Number(pointer[1]);
  const rows = [...text.slice(at).matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
  return rows.map((offset, i) => ({
    offset,
    lands: text.startsWith(`${i + 1} 0 obj`, offset),
  }));
}

const BOOK = {
  title: "Where The Light Touched",
  dedication: "For all of us, through the cold days.",
  pages: [
    {
      heading: "Three Days Waiting",
      text: "We stand close together at the roadside railing. After three days of waiting, the range comes out.",
      imagePath: jpeg(),
      number: 1,
    },
    { heading: "No Picture", text: "A page whose illustration is missing keeps its words.", imagePath: null, number: 2 },
  ],
};

describe("the storybook pdf", () => {
  const pdf = storybookPdf(BOOK);

  it("is a pdf, opening and closing as one", () => {
    expect(pdf.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(pdf.subarray(-6).toString("latin1").trim()).toBe("%%EOF");
  });

  it("has a page per page, plus a cover", () => {
    const pages = pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? [];
    expect(pages.length).toBe(BOOK.pages.length + 1);
  });

  it("cross-references every object at the offset it actually starts at", () => {
    const rows = crossReferences(pdf);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.lands)).toEqual([]);
  });

  it("declares a length for every stream that matches its bytes", () => {
    const all = streams(pdf);
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) expect(s.actual).toBe(s.declared);
  });

  it("embeds the illustration it was given, and draws it", () => {
    const text = pdf.toString("latin1");
    expect(text).toContain("/DCTDecode");
    expect(text).toContain("/Im0 Do");
    // One image for one page that has one, not for the page that does not.
    expect((text.match(/\/DCTDecode/g) ?? []).length).toBe(1);
  });

  it("keeps the page without an illustration, with its words", () => {
    expect(pdf.toString("latin1")).toContain("No Picture");
  });

  it("declares an encoding for its fonts", () => {
    // Without this a reader may map bytes through a standard font's built-in encoding, which is
    // not WinAnsi, and show the wrong glyph or none.
    expect((pdf.toString("latin1").match(/WinAnsiEncoding/g) ?? []).length).toBe(2);
  });

  it("cannot be broken by punctuation the model likes to write", () => {
    // An em dash truncated by latin1 encoding becomes a single byte, and a byte that happens to be
    // a parenthesis ends the literal early — the page then renders blank in a strict reader. The
    // fold happens before the escape so no such byte can reach the file.
    const risky = storybookPdf({
      title: "Curly ‘quotes’ — and  separators",
      dedication: "For “them”…",
      pages: [
        {
          heading: "A (parenthesised) heading",
          text: "Backslashes \\ and (nested (parens)) and a dash — all of it.",
          imagePath: null,
          number: 1,
        },
      ],
    });
    const literals = [...risky.toString("latin1").matchAll(/\((?:[^()\\]|\\.)*\)\s*Tj/g)];
    expect(literals.length).toBeGreaterThan(0);
    // Nothing outside the printable range reached a literal.
    for (const [lit] of literals) {
      for (const ch of lit) expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x20);
    }
    for (const s of streams(risky)) expect(s.actual).toBe(s.declared);
    expect(crossReferences(risky).filter((r) => !r.lands)).toEqual([]);
  });
});
