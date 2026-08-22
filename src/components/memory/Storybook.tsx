"use client";

/**
 * A book you turn the pages of.
 *
 * The prose is the easy half. This is the half worth building: a real spread with a spine, leaves
 * that swing on their inside edge in 3D, a shadow that sweeps across the page beneath as the leaf
 * passes over it, and a back face that is the next page rather than a mirror of the last one.
 *
 * How it works. Every leaf is one absolutely-positioned element on the right half of the spread,
 * hinged at its left edge. Its front face carries page 2n and its back face page 2n+1, rotated a
 * half turn so it reads correctly once flipped. Turning a leaf rotates it by -180 degrees about
 * that hinge; the stacking order is driven off the current index so the leaf in motion is always
 * above the ones it is moving between. `backface-visibility: hidden` is what keeps the two faces
 * from showing through one another, and `transform-style: preserve-3d` on the leaf is what makes
 * the two faces share a volume rather than a plane.
 *
 * Everything animates on the same easing the rest of the product uses, and the whole thing is
 * driven by arrow keys, click zones, and a drag — because a book that only responds to buttons is
 * a slideshow with a border.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Eyebrow, Icon, Panel, Spinner, Textarea } from "@/components/ui/primitives";

export interface StorybookPage {
  memoryId: string;
  heading: string;
  text: string;
  imageUrl: string;
  drawn: boolean;
}

export interface StorybookData {
  id: string;
  title: string;
  dedication: string;
  request: string;
  pages: StorybookPage[];
  route: string;
  createdAt: string;
}

/** One side of a leaf. */
interface Sheet {
  kind: "cover" | "page" | "end";
  page?: StorybookPage;
  index?: number;
  title?: string;
  dedication?: string;
}

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

export default function Storybook({ shelf }: { shelf: StorybookData[] }) {
  const [books, setBooks] = useState<StorybookData[]>(shelf);
  const [openId, setOpenId] = useState<string | null>(shelf[0]?.id ?? null);
  const [request, setRequest] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const book = books.find((b) => b.id === openId) ?? null;
  /** How many leaves have been turned. 0 is the closed cover. */
  const [turned, setTurned] = useState(0);
  const dragFrom = useRef<number | null>(null);

  /**
   * Sheets in reading order: front cover, then a spread per page, then the back.
   *
   * Paired two to a leaf, so leaf n shows sheet 2n on its front and sheet 2n+1 on its back — the
   * arrangement a real book has, and the reason a turn reveals two new sides at once.
   */
  const sheets = useMemo<Sheet[]>(() => {
    if (!book) return [];
    const out: Sheet[] = [
      { kind: "cover", title: book.title, dedication: book.dedication },
    ];
    book.pages.forEach((page, i) => out.push({ kind: "page", page, index: i }));
    out.push({ kind: "end" });
    // A leaf needs two faces; an odd count would leave the last one showing the page behind it.
    if (out.length % 2 === 1) out.push({ kind: "end" });
    return out;
  }, [book]);

  const leaves = Math.floor(sheets.length / 2);

  const turn = useCallback(
    (delta: number) => {
      setTurned((was) => Math.min(leaves, Math.max(0, was + delta)));
    },
    [leaves],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        turn(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        turn(-1);
      }
      if (e.key === "Home") setTurned(0);
      if (e.key === "End") setTurned(leaves);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn, leaves]);

  const make = useCallback(async () => {
    setWorking(true);
    setError("");
    try {
      const res = await fetch("/api/storybook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: request.trim() }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "the book could not be written");
      const fresh = json.storybook as StorybookData;
      setBooks((was) => [fresh, ...was]);
      setOpenId(fresh.id);
      setRequest("");
      setTurned(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }, [request]);

  const remove = useCallback(
    async (bookId: string) => {
      const res = await fetch(`/api/storybook/${bookId}`, { method: "DELETE" });
      if (!res.ok) return;
      setBooks((was) => {
        const left = was.filter((b) => b.id !== bookId);
        setOpenId((current) => (current === bookId ? (left[0]?.id ?? null) : current));
        return left;
      });
      setTurned(0);
    },
    [],
  );

  /** The form that makes a book, shown whether or not one is open. */
  const composer = (
    <Panel tone="raised" padding="lg" className="w-full">
      <Eyebrow tone="ember">New book</Eyebrow>
      <p className="mt-2 max-w-xl font-sans text-[13px] leading-relaxed text-paper-400">
        Say what this one is about, or leave it blank and MUSE will decide. It writes a page for
        each memory and illustrates it with the drawing it made.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <Textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={2}
          placeholder="A book about the cold, and waiting for the mountains to come out."
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void make()} loading={working} trailingIcon="wand">
            {working ? "Writing" : "Write the book"}
          </Button>
          {error ? <span className="font-sans text-[13px] text-signal-fail">{error}</span> : null}
        </div>
      </div>
    </Panel>
  );

  /** Every book written so far, newest first. */
  const shelfStrip =
    books.length === 0 ? null : (
      <div className="w-full">
        <Eyebrow>On the shelf · {books.length}</Eyebrow>
        <ul className="mt-3 flex list-none flex-wrap gap-2">
          {books.map((b) => {
            const open = b.id === book?.id;
            return (
              <li key={b.id} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-current={open ? "true" : undefined}
                  onClick={() => {
                    setOpenId(b.id);
                    setTurned(0);
                  }}
                  className={`flex items-center gap-2 rounded-core border px-3 py-2 text-left transition-colors duration-200 ${
                    open
                      ? "border-hairline-ember bg-ink-850 text-paper-50"
                      : "border-hairline bg-ink-950 text-paper-300 hover:border-hairline-strong"
                  }`}
                >
                  <img
                    src={`${b.pages[0]?.imageUrl ?? ""}?w=160`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-9 shrink-0 rounded-core-sm object-cover"
                  />
                  <span className="min-w-0">
                    <span className="block max-w-[16ch] truncate font-sans text-[13px] leading-tight">
                      {b.title}
                    </span>
                    <span className="block font-mono text-[10px] leading-tight text-paper-600">
                      {b.pages.length} pages
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${b.title}`}
                  title="Delete"
                  onClick={() => void remove(b.id)}
                  className="rounded-core p-1.5 text-paper-700 transition-colors hover:bg-ink-850 hover:text-signal-fail"
                >
                  <Icon name="close" size={11} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );

  if (!book) {
    return (
      <div className="flex flex-col items-center gap-7">
        <div className="w-full text-center">
          <Eyebrow tone="ember">Storybook</Eyebrow>
          <h1 className="mt-3 font-display text-[clamp(2.2rem,5vw,3.6rem)] leading-[1.02] tracking-[-0.03em] text-paper-50">
            Bind your memories into a book.
          </h1>
        </div>
        {composer}
      </div>
    );
  }

  const atStart = turned === 0;
  const atEnd = turned >= leaves;

  return (
    <div className="flex flex-col items-center gap-7">
      <div className="flex w-full flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow tone="ember">Storybook</Eyebrow>
          <h1 className="mt-2 font-display text-[clamp(1.8rem,4vw,2.8rem)] leading-tight tracking-[-0.02em] text-paper-50">
            {book.title}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="neutral">{book.pages.length} pages</Badge>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              // A download rather than a print dialog: the file is built server-side, so what
              // arrives is the book, not a screenshot of a web page.
              window.location.href = `/api/storybook/${book.id}/pdf`;
            }}
            trailingIcon="download"
          >
            PDF
          </Button>
        </div>
      </div>

      {/* ── the book ──────────────────────────────────────────────────────────── */}
      <div
        className="relative w-full select-none"
        style={{ perspective: "2200px", perspectiveOrigin: "50% 42%" }}
        onPointerDown={(e) => {
          dragFrom.current = e.clientX;
        }}
        onPointerUp={(e) => {
          const from = dragFrom.current;
          dragFrom.current = null;
          if (from === null) return;
          const dx = e.clientX - from;
          // A deliberate drag, not a click that wandered.
          if (Math.abs(dx) > 60) turn(dx < 0 ? 1 : -1);
        }}
      >
        <div className="relative mx-auto aspect-[3/2] w-full max-w-4xl">
          {/* the left half: the page already turned, and the spine's shadow over it */}
          <div className="absolute inset-y-0 left-0 w-1/2 overflow-hidden rounded-l-core border border-hairline bg-paper-100">
            <SheetFace sheet={sheets[turned * 2 - 1]} side="left" total={book.pages.length} />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-16"
              style={{
                background:
                  "linear-gradient(to right, transparent, color-mix(in oklab, var(--color-ink-1000) 26%, transparent))",
              }}
            />
          </div>

          {/* the right half: the pages still to come */}
          <div className="absolute inset-y-0 right-0 w-1/2 overflow-hidden rounded-r-core border border-hairline bg-paper-100">
            <SheetFace sheet={sheets[turned * 2]} side="right" total={book.pages.length} />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 w-16"
              style={{
                background:
                  "linear-gradient(to left, transparent, color-mix(in oklab, var(--color-ink-1000) 26%, transparent))",
              }}
            />
          </div>

          {/* the leaves themselves, hinged on the spine */}
          {Array.from({ length: leaves }, (_, leaf) => {
            const isTurned = leaf < turned;
            const front = sheets[leaf * 2];
            const back = sheets[leaf * 2 + 1];
            return (
              <div
                key={leaf}
                aria-hidden={!(leaf === turned || leaf === turned - 1)}
                className="absolute inset-y-0 right-0 w-1/2 origin-left"
                style={{
                  transformStyle: "preserve-3d",
                  transform: `rotateY(${isTurned ? -180 : 0}deg)`,
                  transition: `transform 780ms ${EASE}`,
                  // The leaf in motion has to sit above both stacks. Turned leaves stack in
                  // reverse so the most recently turned is on top of the pile on the left.
                  zIndex: isTurned ? leaves + leaf : leaves - leaf,
                }}
              >
                <div
                  className="absolute inset-0 overflow-hidden rounded-r-core border border-hairline bg-paper-100"
                  style={{ backfaceVisibility: "hidden" }}
                >
                  <SheetFace sheet={front} side="right" total={book.pages.length} />
                  <Curl side="right" />
                </div>
                <div
                  className="absolute inset-0 overflow-hidden rounded-l-core border border-hairline bg-paper-100"
                  style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
                >
                  <SheetFace sheet={back} side="left" total={book.pages.length} />
                  <Curl side="left" />
                </div>
              </div>
            );
          })}

          {/* click zones, so the book turns where you would touch it */}
          <button
            type="button"
            aria-label="Previous page"
            onClick={() => turn(-1)}
            disabled={atStart}
            className="absolute inset-y-0 left-0 z-[999] w-[22%] cursor-w-resize disabled:cursor-default"
          />
          <button
            type="button"
            aria-label="Next page"
            onClick={() => turn(1)}
            disabled={atEnd}
            className="absolute inset-y-0 right-0 z-[999] w-[22%] cursor-e-resize disabled:cursor-default"
          />
        </div>
      </div>

      {/* ── where you are ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        <Button variant="quiet" size="sm" onClick={() => turn(-1)} disabled={atStart}>
          <span className="rotate-180">
            <Icon name="chevron" size={13} />
          </span>
          Back
        </Button>
        <ol className="flex list-none items-center gap-1.5">
          {Array.from({ length: leaves + 1 }, (_, i) => (
            <li key={i}>
              <button
                type="button"
                aria-label={`Go to spread ${i + 1}`}
                aria-current={turned === i ? "true" : undefined}
                onClick={() => setTurned(i)}
                className={`block h-1.5 rounded-pill transition-all duration-300 ${
                  turned === i ? "w-6 bg-ember-400" : "w-1.5 bg-ink-700 hover:bg-ink-600"
                }`}
              />
            </li>
          ))}
        </ol>
        <Button variant="quiet" size="sm" onClick={() => turn(1)} disabled={atEnd}>
          Next
          <Icon name="chevron" size={13} />
        </Button>
      </div>

      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper-700">
        arrow keys, or drag the page
      </p>

      {working ? (
        <div className="flex items-center gap-2">
          <Spinner size={13} />
          <Eyebrow>writing</Eyebrow>
        </div>
      ) : null}

      <div className="mt-4 flex w-full flex-col gap-7">
        {shelfStrip}
        {composer}
      </div>
    </div>
  );
}

/** The soft shadow along a leaf's outer edge, so it reads as paper with thickness. */
function Curl({ side }: { side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-y-0 w-14 ${side === "right" ? "left-0" : "right-0"}`}
      style={{
        background:
          side === "right"
            ? "linear-gradient(to right, color-mix(in oklab, var(--color-ink-1000) 22%, transparent), transparent)"
            : "linear-gradient(to left, color-mix(in oklab, var(--color-ink-1000) 22%, transparent), transparent)",
      }}
    />
  );
}

/**
 * One side of one leaf.
 *
 * The illustration sits above the prose rather than beside it, because the page is portrait and a
 * side-by-side split gives the words a column four inches wide.
 */
function SheetFace({
  sheet,
  side,
  total,
}: {
  sheet: Sheet | undefined;
  side: "left" | "right";
  total: number;
}) {
  if (!sheet) {
    return <div className="h-full w-full bg-paper-100" />;
  }

  if (sheet.kind === "cover") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-5 bg-ink-900 px-10 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-ember-300">MUSE</span>
        <h2 className="font-display text-[clamp(1.6rem,3.4vw,2.6rem)] leading-tight tracking-[-0.02em] text-paper-50">
          {sheet.title}
        </h2>
        {sheet.dedication ? (
          <p className="max-w-[24ch] font-sans text-[13px] italic leading-relaxed text-paper-400">
            {sheet.dedication}
          </p>
        ) : null}
        <span className="mt-2 h-px w-16 bg-hairline-strong" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-600">
          {total} pages
        </span>
      </div>
    );
  }

  if (sheet.kind === "end" || !sheet.page) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-paper-100 px-10 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-600">
          the end
        </span>
      </div>
    );
  }

  const page = sheet.page;
  return (
    <div className="flex h-full w-full flex-col bg-paper-100 p-6 md:p-8">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-core-sm border border-ink-400/25 bg-paper-200">
        <img
          src={`${page.imageUrl}?w=640`}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        {!page.drawn ? (
          <span className="absolute right-2 top-2 rounded-pill bg-ink-1000/70 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-paper-200">
            photograph
          </span>
        ) : null}
      </div>
      <div className="shrink-0 pt-4">
        {page.heading ? (
          <h3 className="font-display text-[clamp(1rem,1.5vw,1.35rem)] leading-snug text-ink-1000">
            {page.heading}
          </h3>
        ) : null}
        <p className="mt-1.5 font-sans text-[12.5px] leading-relaxed text-ink-800 md:text-[13.5px]">
          {page.text}
        </p>
      </div>
      <span
        className={`mt-3 shrink-0 font-mono text-[9px] text-ink-600 ${
          side === "left" ? "text-left" : "text-right"
        }`}
      >
        {(sheet.index ?? 0) + 1}
      </span>
    </div>
  );
}
