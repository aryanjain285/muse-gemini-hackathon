"use client";

/**
 * The sketch studio: a photograph on the left of the easel, the drawing made from it on the
 * canvas, under a light.
 *
 * The studio is drawn rather than decorated — a warm pool of light from above, a canvas that
 * sits a degree off square the way a real one does, a ledge and legs beneath it. All of it from
 * the palette tokens, so it sits in the same room as the rest of the product instead of looking
 * like a different app's illustration.
 */
import { useCallback, useMemo, useState } from "react";
import type { MemoryView } from "@/lib/memory/types";
import type { ExistingSketch } from "@/lib/services/caricature";
import { Badge, Button, Eyebrow, Panel, Segmented, Spinner } from "@/components/ui/primitives";

const STYLES = [
  { value: "caricature", label: "Caricature" },
  { value: "pencil", label: "Pencil" },
  { value: "ink", label: "Ink" },
  { value: "watercolour", label: "Watercolour" },
] as const;

type Style = (typeof STYLES)[number]["value"];

interface Drawing {
  imageUrl: string;
  sourceUrl: string;
  style: Style;
  drawnBy: string;
  cached: boolean;
  title: string;
}

/** A warm key light from above and a cooler fill, so the canvas reads as lit rather than pasted. */
const STUDIO_LIGHT: React.CSSProperties = {
  background:
    "radial-gradient(70% 52% at 50% -4%, color-mix(in oklab, var(--color-ember-400) 20%, transparent), transparent 68%)," +
    "radial-gradient(120% 90% at 50% 120%, color-mix(in oklab, var(--color-ink-850) 70%, transparent), transparent 70%)",
};

const EASEL_WOOD: React.CSSProperties = {
  background:
    "linear-gradient(180deg, color-mix(in oklab, var(--color-ember-700) 55%, var(--color-ink-850)), " +
    "color-mix(in oklab, var(--color-ember-900) 70%, var(--color-ink-1000)))",
};

export default function SketchStand({
  memories,
  drawn = [],
}: {
  memories: MemoryView[];
  /** Drawings already on disk, so the easel opens with work on it rather than blank. */
  drawn?: ExistingSketch[];
}) {
  const withPeople = useMemo(
    () => [...memories].sort((a, b) => b.people.length - a.people.length),
    [memories],
  );
  const [selected, setSelected] = useState<MemoryView | null>(withPeople[0] ?? null);
  const [style, setStyle] = useState<Style>("caricature");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [drawing, setDrawing] = useState<Drawing | null>(null);

  // Keyed on memory and hand, which is exactly how the files are named.
  const already = useMemo(() => {
    const index = new Map<string, string>();
    for (const d of drawn) index.set(`${d.memoryId}:${d.style}`, d.url);
    return index;
  }, [drawn]);

  const byMemory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of drawn) counts.set(d.memoryId, (counts.get(d.memoryId) ?? 0) + 1);
    return counts;
  }, [drawn]);

  // What is on the easel: whatever was just drawn, or whatever already existed for this choice.
  const shown =
    drawing ??
    (selected && already.has(`${selected.id}:${style}`)
      ? {
          imageUrl: already.get(`${selected.id}:${style}`) as string,
          sourceUrl: selected.imageUrl,
          style,
          drawnBy: "",
          cached: true,
          title: selected.title,
        }
      : null);

  const draw = useCallback(async () => {
    if (!selected) return;
    setWorking(true);
    setError("");
    try {
      const res = await fetch(`/api/memories/${selected.id}/sketch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "the drawing could not be made");
      setDrawing(json as Drawing);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }, [selected, style]);

  if (memories.length === 0) {
    return (
      <Panel tone="raised" padding="lg">
        <Eyebrow tone="ember">Sketch studio</Eyebrow>
        <p className="mt-3 font-sans text-[14px] text-paper-400">
          The studio draws from your memory library, and the library is empty. Import a photograph
          from the gallery first.
        </p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <Panel tone="raised" padding="lg">
        <Eyebrow tone="ember">Sketch studio</Eyebrow>
        <h1 className="mt-3 max-w-2xl font-display text-[clamp(2.2rem,5vw,3.6rem)] leading-[1.02] tracking-[-0.03em] text-paper-50">
          Put a memory on the easel.
        </h1>
        <p className="mt-3 max-w-2xl font-sans text-[14px] leading-7 text-paper-400">
          The same image model that paints the films will draw one of your photographs by hand —
          and when there is no key or no budget left, the deterministic engine draws it instead, so
          the easel is never empty.
        </p>

        <div className="mt-7 flex flex-col gap-5">
          <div>
            <Eyebrow>Choose a memory</Eyebrow>
            <ul className="mt-3 flex list-none gap-3 overflow-x-auto pb-1">
              {withPeople.map((memory) => {
                const active = selected?.id === memory.id;
                return (
                  <li key={memory.id} className="shrink-0">
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setSelected(memory);
                        setDrawing(null);
                      }}
                      className={`block w-28 overflow-hidden rounded-core border text-left transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-300 ${
                        active
                          ? "border-hairline-ember bg-ink-850"
                          : "border-hairline bg-ink-950 hover:border-hairline-strong"
                      }`}
                    >
                      <img
                        src={`${memory.imageUrl}?w=160`}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="aspect-square w-full object-cover"
                      />
                      <span className="flex items-center justify-between gap-1 px-2 py-1.5 font-mono text-[10px] leading-tight text-paper-400">
                        <span className="truncate">
                          {memory.people.length > 0
                            ? `${memory.people.length} ${memory.people.length === 1 ? "person" : "people"}`
                            : "no people"}
                        </span>
                        {byMemory.get(memory.id) ? (
                          <span className="shrink-0 text-ember-300" title="already drawn">
                            {byMemory.get(memory.id)}&#9679;
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <Segmented
            label="Drawing style"
            options={STYLES.map((s) => ({ value: s.value, label: s.label }))}
            value={style}
            onChange={(next) => {
              setStyle(next);
              setDrawing(null);
            }}
          />

          <div className="flex flex-wrap items-center gap-4">
            <Button onClick={draw} loading={working} disabled={!selected} trailingIcon="wand">
              {working ? "Drawing" : shown ? "Draw it again" : "Draw it"}
            </Button>
            {shown ? (
              <Badge tone={shown.cached ? "neutral" : "ok"}>
                {shown.cached ? "already drawn" : `drawn by ${shown.drawnBy}`}
              </Badge>
            ) : null}
            {error ? <span className="font-sans text-[13px] text-signal-fail">{error}</span> : null}
          </div>
        </div>
      </Panel>

      {/* ── the studio ────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-shell border border-hairline bg-ink-1000">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={STUDIO_LIGHT} />

        <div className="relative flex flex-col items-center px-5 py-12 md:py-16">
          {/* the canvas, a degree off square the way one leans on a real easel */}
          <div className="relative w-full max-w-lg -rotate-[0.6deg]">
            <div className="rounded-core-sm border border-hairline-strong bg-paper-50 p-3 shadow-lift">
              <div className="relative aspect-square w-full overflow-hidden bg-paper-100">
                {shown ? (
                  <img
                    src={shown.imageUrl}
                    alt={`${shown.style} drawing of ${shown.title}`}
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                ) : working ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                    <Spinner size={18} />
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-700">
                      drawing
                    </span>
                  </div>
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <span className="max-w-[18ch] text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.16em] text-ink-600">
                      the canvas is blank
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* the photograph being worked from, clipped to the corner of the frame */}
            {selected ? (
              <figure className="absolute -left-3 -top-6 w-24 rotate-[-5deg] md:-left-14 md:w-28">
                <img
                  src={`${selected.imageUrl}?w=320`}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-full rounded-[2px] border-[6px] border-paper-50 object-cover shadow-core"
                />
                <figcaption className="mt-1 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-paper-600">
                  reference
                </figcaption>
              </figure>
            ) : null}
          </div>

          {/* the ledge, then the legs behind it */}
          <div className="relative z-10 mt-0 h-3 w-[min(30rem,92%)] rounded-b-core-sm" style={EASEL_WOOD} />
          <div aria-hidden className="relative -mt-1 flex h-24 w-[min(30rem,92%)] justify-between">
            <div className="h-full w-2.5 origin-top -rotate-6 rounded-b-pill" style={EASEL_WOOD} />
            <div className="h-full w-2.5 origin-top rotate-6 rounded-b-pill" style={EASEL_WOOD} />
          </div>

          {drawn.length > 0 ? (
            <div className="mt-9 w-full max-w-2xl">
              <p className="mb-3 text-center">
                <Eyebrow>Drawn already</Eyebrow>
              </p>
              <ul className="flex list-none flex-wrap justify-center gap-2">
                {drawn.map((d) => {
                  const memory = memories.find((m) => m.id === d.memoryId);
                  const active = shown?.imageUrl === d.url;
                  return (
                    <li key={d.url}>
                      <button
                        type="button"
                        title={`${memory?.title ?? "memory"} — ${d.style}`}
                        onClick={() => {
                          if (memory) setSelected(memory);
                          setStyle(d.style as Style);
                          setDrawing(null);
                        }}
                        className={`block overflow-hidden rounded-core-sm border transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-300 ${
                          active ? "border-hairline-ember" : "border-hairline hover:border-hairline-strong"
                        }`}
                      >
                        <img
                          src={`${d.url}?w=160`}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="size-16 object-cover"
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {shown ? (
            <p className="mt-6 text-center font-sans text-[13px] text-paper-400">
              <span className="font-display text-lg text-paper-100">{shown.title}</span>
              <span className="mx-2 text-paper-700">·</span>
              {shown.style}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
