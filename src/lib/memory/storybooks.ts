/**
 * The shelf: every storybook that has been written, kept as one JSON file each.
 *
 * It began as a single `storybook.json`, which meant writing a second book destroyed the first and
 * the only control the interface could offer was "write it again". A book somebody liked is worth
 * keeping, so they are addressed, listed, and deleted individually — and the earlier single file is
 * adopted onto the shelf rather than orphaned.
 */
import fs from "node:fs";
import path from "node:path";

import { PATHS } from "@/lib/core/paths";
import { id } from "@/lib/core/util";

export interface StorybookPage {
  memoryId: string;
  heading: string;
  text: string;
  /** The drawing if one exists, otherwise the photograph. */
  imageUrl: string;
  drawn: boolean;
}

export interface Storybook {
  id: string;
  title: string;
  dedication: string;
  /** What was asked for, kept so the shelf can show why a book exists. */
  request: string;
  pages: StorybookPage[];
  route: string;
  createdAt: string;
}

const DIR = () => path.join(PATHS.workspace, "storybooks");
const LEGACY = () => path.join(PATHS.workspace, "storybook.json");

function ensure(): void {
  fs.mkdirSync(DIR(), { recursive: true });
  // The first book was written before the shelf existed. Adopt it once, then leave it alone.
  const legacy = LEGACY();
  if (!fs.existsSync(legacy)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacy, "utf8")) as Partial<Storybook>;
    if (parsed.pages && parsed.pages.length > 0) {
      const adopted: Storybook = {
        id: parsed.id ?? id("bk"),
        title: parsed.title ?? "A few days",
        dedication: parsed.dedication ?? "",
        request: parsed.request ?? "",
        pages: parsed.pages as StorybookPage[],
        route: parsed.route ?? "local",
        createdAt: parsed.createdAt ?? new Date().toISOString(),
      };
      const to = path.join(DIR(), `${adopted.id}.json`);
      if (!fs.existsSync(to)) fs.writeFileSync(to, JSON.stringify(adopted, null, 2));
    }
  } catch {
    /* a corrupt legacy file is not worth failing over */
  }
  fs.rmSync(legacy, { force: true });
}

function file(bookId: string): string {
  return path.join(DIR(), `${bookId}.json`);
}

/** Ids are generated here, so anything that does not look like one is not looked up. */
export function isStorybookId(value: string): boolean {
  return /^bk_[a-z0-9]{6,}$/.test(value);
}

export const Storybooks = {
  create(input: Omit<Storybook, "id" | "createdAt">): Storybook {
    ensure();
    const book: Storybook = { ...input, id: id("bk"), createdAt: new Date().toISOString() };
    fs.writeFileSync(file(book.id), JSON.stringify(book, null, 2));
    return book;
  },

  get(bookId: string): Storybook | null {
    ensure();
    if (!isStorybookId(bookId)) return null;
    const at = file(bookId);
    if (!fs.existsSync(at)) return null;
    try {
      return JSON.parse(fs.readFileSync(at, "utf8")) as Storybook;
    } catch {
      return null;
    }
  },

  /** Newest first, which is the order a shelf is read in. */
  list(): Storybook[] {
    ensure();
    const dir = DIR();
    if (!fs.existsSync(dir)) return [];
    const books: Storybook[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        books.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Storybook);
      } catch {
        /* skip a file that is not a book */
      }
    }
    return books.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  remove(bookId: string): boolean {
    ensure();
    if (!isStorybookId(bookId)) return false;
    const at = file(bookId);
    if (!fs.existsSync(at)) return false;
    fs.rmSync(at, { force: true });
    return true;
  },
};
