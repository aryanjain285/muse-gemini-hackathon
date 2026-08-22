"use client";

/**
 * VARIANT A — THE SLATE
 *
 * The surface of a working production: a clapperboard and a camera report. Cool
 * graphite, condensed lettering, one monospace face for everything that was
 * measured or written, and shot roles colour-coded from a muted SMPTE bar set so
 * that the same shot carries the same colour in the ribbon, the timeline, the
 * index and the legend.
 *
 * ── THE SPINE ───────────────────────────────────────────────────────────────
 * MEASURE   1320px, held everywhere. The page is anchored to the LEFT gutter
 *           (margin-right:auto) and is never centred; only the header and footer
 *           rules bleed to the viewport edge, so a 2560px screen reads as a
 *           machine bed rather than a narrow column adrift in the middle.
 * COLUMNS   index 264 (232 of content + 32 pad) · rule 1 · pad 32 · film 1023.
 *           Inside the film column every two-part block splits 320 | 32 | 671,
 *           so the film gate and the shot gate are the same 320px object on the
 *           same left edge. Those blocks use grid-rows-subgrid: their heading
 *           rules and their bodies share rows by construction, not by eye.
 * SPACING   8px base. Only 8 / 16 / 24 / 32 / 48 / 64 are used for gaps and
 *           padding. 4px is a half step permitted inside marks and bars only
 *           (label slugs, tick insets); 1px is hairline. Nothing else.
 * BASELINE  Index rows are a fixed 56px. Every block heading row is 24px.
 *           Timeline tracks are 24 / 56 / 24 / 24 with an 8px gap, declared once
 *           in TRACK and read by both the label column and the tracks, so a
 *           label cannot drift off its row.
 * TYPE      Two families. Archivo Narrow (condensed grotesk) for display
 *           lettering, IBM Plex Mono for everything else including prose. 11px
 *           is metadata only, prose is 13px, tabular figures throughout.
 * CONTRAST  Measured against the ground #15171B: ink #E8ECF1 15.1:1, ink-2
 *           #A8B2BF 8.4:1, ink-3 #8A95A3 5.9:1 (5.3:1 on the lightest surface,
 *           #1E2228). Every role colour clears 5.0:1 on that same surface.
 *           Nothing dimmer than ink-3 is ever used for text, and disabled
 *           controls change their edge rather than their colour.
 * MOTION    Three uses only: a staggered rise on entry, a brightness lift on a
 *           ribbon bar, and a fade when the shot changes. Transform, opacity and
 *           filter, custom curves, all of it off under prefers-reduced-motion.
 */

import Link from "next/link";
import * as React from "react";
import type { DesignFilm, DesignShot } from "@/app/design/data";
import {
  ago,
  cameraLabel,
  duration,
  filmStatus,
  frameLabel,
  presetLabel,
  purposeLabel,
  reviewLabel,
  transitionLabel,
} from "@/lib/brand";

/* ── the colour code ───────────────────────────────────────────────────────────
   A muted SMPTE bar set — bone, yellow, cyan, green, magenta, red, blue — every
   hue under 50% saturation so it reads as a field on a report rather than as
   decoration. The two-letter code travels with the colour everywhere it appears,
   so the coding is never carried by hue alone. */
interface Role {
  hex: string;
  code: string;
}

const ROLE: Record<string, Role> = {
  recognition: { hex: "#C9CFD6", code: "OP" },
  world_opens: { hex: "#C6B26A", code: "WO" },
  motion_begins: { hex: "#6FA9AE", code: "MV" },
  build: { hex: "#7FA774", code: "BD" },
  hero_drop: { hex: "#C57A93", code: "DR" },
  variation: { hex: "#CE8471", code: "AN" },
  resolution: { hex: "#7C93C4", code: "EN" },
};

const ROLE_OTHER: Role = { hex: "#94A0AE", code: "··" };

function roleOf(purpose: string): Role {
  return ROLE[purpose] ?? ROLE_OTHER;
}

/** Status marks. Always drawn beside the status word, never instead of it. */
const TONE: Record<string, string> = {
  ok: "#86B98F",
  live: "#DDA05A",
  warn: "#D8CB6E",
  neutral: "#94A0AE",
};

/** The musical beats the cut is built on, said as a person would say them. */
const BEAT: Record<string, string> = {
  intro: "opening",
  accent: "accent",
  build: "build",
  drop: "the drop",
  variation: "the answer",
  resolve: "resolve",
  final_hit: "last hit",
};

function beatLabel(kind: string): string {
  return BEAT[kind] ?? kind.replace(/_/g, " ");
}

/** Track heights, on the 8px scale. The label column reads the same numbers. */
const TRACK = { beats: 24, shots: 56, score: 24, ruler: 24 } as const;

/** The composer only ever cuts one frame shape, so it is stated, not measured. */
const FORMAT = frameLabel(1080, 1920) ?? "vertical";

/** What a person can ask to change about a shot. */
type ChangeKind = "retake" | "move" | "cut";

const CHANGES: readonly { kind: ChangeKind; label: string; code: string }[] = [
  { kind: "retake", label: "Retake this shot", code: "R" },
  { kind: "move", label: "Change the move", code: "M" },
  { kind: "cut", label: "Change the cut", code: "C" },
];

/* ── helpers ─────────────────────────────────────────────────────────────────── */

function pad2(n: number): string {
  return String(Math.max(0, Math.round(n))).padStart(2, "0");
}

/** A position on the film's clock, to a tenth. Lengths use brand duration(). */
function tc(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  return `${Math.max(0, seconds).toFixed(1)}s`;
}

/** Fixed-precision percentage, so inline geometry carries no float noise. */
function at(t: number, total: number): string {
  const f = total > 0 ? Math.min(1, Math.max(0, t / total)) : 0;
  return `${Number((f * 100).toFixed(3))}%`;
}

/** The clapper fill: diagonal bars in the shot's role colour, alternating lean. */
function clapper(hex: string, index: number, live: boolean): React.CSSProperties {
  const angle = index % 2 === 0 ? 115 : 65;
  const alpha = live ? "F2" : "A6";
  return {
    backgroundColor: live ? "#22272E" : "#191D22",
    backgroundImage: `repeating-linear-gradient(${angle}deg, ${hex}${alpha} 0 7px, transparent 7px 14px)`,
    boxShadow: live ? `inset 0 0 0 1px ${hex}` : "none",
  };
}

interface Mark {
  t: number;
  strong: boolean;
}

/** The score's marks: its own beat anchors, else a grid derived from its tempo. */
function scoreMarks(film: DesignFilm, total: number): { marks: Mark[]; word: string } {
  const anchors = (film.music?.anchors ?? []).filter(
    (a) => Number.isFinite(a) && a >= 0 && a <= total,
  );
  if (anchors.length > 0) {
    return { marks: anchors.map((t, i) => ({ t, strong: i % 4 === 0 })), word: "anchors" };
  }
  const bpm = film.music?.bpm ?? null;
  if (bpm && bpm > 0) {
    const step = 60 / bpm;
    const marks: Mark[] = [];
    for (let i = 0; i * step <= total && i < 240; i += 1) {
      marks.push({ t: i * step, strong: i % 4 === 0 });
    }
    return { marks, word: "beats" };
  }
  return { marks: [], word: "" };
}

/* ── this variant's stylesheet ────────────────────────────────────────────────
   Scoped to .slate so it cannot reach the other two directions, and holding its
   own tokens rather than editing the shared theme. */

const SLATE_CSS = `
.slate{
  --sl-measure:1320px;
  --sl-gut:clamp(16px,3vw,64px);
  --sl-index:264px;
  --sl-gate:320px;

  --sl-ground:#15171B;
  --sl-deep:#101216;
  --sl-panel:#191C21;
  --sl-raised:#1E2228;
  --sl-rule:#2A2F37;
  --sl-rule-2:#3B434E;
  --sl-ink:#E8ECF1;
  --sl-ink-2:#A8B2BF;
  --sl-ink-3:#8A95A3;
  --sl-focus:#CFE0F2;

  --sl-display:"Archivo Narrow","Oswald","Saira Condensed","Roboto Condensed","Arial Narrow",system-ui,sans-serif;
  --sl-mono:"IBM Plex Mono","Geist Mono",ui-monospace,"Cascadia Mono","SFMono-Regular",monospace;

  --sl-in:cubic-bezier(0.32,0.72,0,1);
  --sl-out:cubic-bezier(0.62,0.04,0.36,1);

  position:relative;
  min-height:100dvh;
  overflow-x:clip;
  background-color:var(--sl-ground);
  color:var(--sl-ink-2);
  font-family:var(--sl-mono);
  font-size:13px;
  font-variant-numeric:tabular-nums;
  font-feature-settings:"tnum" 1;
}

.slate :focus-visible{outline:2px solid var(--sl-focus);outline-offset:2px}
.slate ::selection{background:#2E3742;color:var(--sl-ink)}

/* The spine: one measure, one gutter, anchored left. */
.sl-spine{
  width:100%;
  max-width:calc(var(--sl-measure) + var(--sl-gut) * 2);
  margin-left:0;
  margin-right:auto;
  padding-left:var(--sl-gut);
  padding-right:var(--sl-gut);
}

/* Wider than the measure, the plate gets a visible right edge, so the space
   beyond it reads as bed rather than as an accident. */
@media (min-width:1450px){
  .sl-edge::after{
    content:"";
    position:absolute;
    top:0;
    bottom:0;
    left:calc(var(--sl-gut) + var(--sl-measure));
    width:1px;
    background:var(--sl-rule);
    pointer-events:none;
  }
}

/* The index column: fixed width, hard left, held in place while the film column
   scrolls past it. */
.sl-main{display:grid;grid-template-columns:minmax(0,1fr);gap:32px}
.sl-index{min-width:0}
.sl-film{min-width:0;border-top:1px solid var(--sl-rule);padding-top:32px}
@media (min-width:1024px){
  .sl-main{grid-template-columns:var(--sl-index) minmax(0,1fr);gap:0}
  .sl-index{
    position:sticky;
    top:0;
    align-self:start;
    max-height:100dvh;
    overflow-y:auto;
    overscroll-behavior:contain;
    padding-right:32px;
    padding-bottom:32px;
  }
  .sl-film{border-top:0;border-left:1px solid var(--sl-rule);padding-top:0;padding-left:32px}
}

/* Type. Colour is set here and only here, so nothing downstream can dim it. */
.sl-mark{font-family:var(--sl-display);font-weight:600;font-size:16px;line-height:1;letter-spacing:.22em;text-transform:uppercase;color:var(--sl-ink)}
.sl-title{font-family:var(--sl-display);font-weight:600;font-size:clamp(28px,2.4vw,40px);line-height:1.02;letter-spacing:.012em;text-transform:uppercase;color:var(--sl-ink);overflow-wrap:anywhere}
.sl-logline{font-family:var(--sl-display);font-weight:400;font-size:clamp(20px,1.7vw,27px);line-height:1.22;color:var(--sl-ink);max-width:32ch}
.sl-label{font-size:11px;font-weight:500;line-height:1.2;letter-spacing:.18em;text-transform:uppercase;color:var(--sl-ink-3)}
.sl-meta{font-size:11px;line-height:1.4;letter-spacing:.08em;color:var(--sl-ink-3)}
.sl-meta-hi{font-size:11px;line-height:1.4;letter-spacing:.08em;color:var(--sl-ink-2)}
.sl-value{font-size:15px;font-weight:500;line-height:1.3;color:var(--sl-ink);overflow-wrap:anywhere}
.sl-value-sm{font-size:13px;font-weight:500;line-height:1.3;color:var(--sl-ink)}
.sl-prose{font-size:13px;line-height:1.55;color:var(--sl-ink-2);max-width:62ch}
.sl-code{font-size:11px;font-weight:600;letter-spacing:.14em}
.sl-slash{color:var(--sl-rule-2)}
.sl-link{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--sl-ink-2);text-decoration:none;border-bottom:1px solid var(--sl-rule-2);transition:color 200ms var(--sl-in),border-color 200ms var(--sl-in)}
.sl-link:hover{color:var(--sl-ink);border-color:var(--sl-ink)}

/* Index rows, on a fixed 56px baseline. */
.sl-field{display:flex;flex-direction:column;justify-content:space-between;height:56px;padding-top:8px;padding-bottom:8px;border-bottom:1px solid var(--sl-rule)}
.sl-field-auto{display:flex;flex-direction:column;gap:8px;min-height:56px;padding-top:8px;padding-bottom:8px;border-bottom:1px solid var(--sl-rule)}
.sl-dot{width:8px;height:8px;flex:none}
.sl-swatch{width:8px;height:8px;flex:none}
.sl-tag{display:inline-flex;align-items:center;height:16px;padding-left:4px;padding-right:4px;background:var(--sl-deep);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--sl-ink-2)}

/* Controls. Disabled changes the edge and the word, never the contrast. */
.sl-btn{display:inline-flex;align-items:center;gap:8px;height:32px;padding-left:16px;padding-right:16px;border:1px solid var(--sl-rule);background:var(--sl-panel);color:var(--sl-ink-2);font-size:12px;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;transition:transform 200ms var(--sl-in),background-color 200ms var(--sl-in),color 200ms var(--sl-in),border-color 200ms var(--sl-in)}
.sl-btn:hover:not(:disabled){transform:translateY(-1px);background:var(--sl-raised);color:var(--sl-ink);border-color:var(--sl-rule-2)}
.sl-btn:disabled{border-style:dashed;color:var(--sl-ink-3);cursor:not-allowed}
.sl-btn-on{background:var(--sl-raised);border-color:var(--sl-rule-2);color:var(--sl-ink)}
.sl-btn-sm{height:24px;padding-left:8px;padding-right:8px}
.sl-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--sl-rule);background:var(--sl-panel);color:var(--sl-ink);transition:background-color 200ms var(--sl-in),border-color 200ms var(--sl-in)}
.sl-icon:hover:not(:disabled){background:var(--sl-raised);border-color:var(--sl-rule-2)}
.sl-icon:disabled{border-style:dashed;color:var(--sl-ink-3);cursor:not-allowed}

/* The gate: one machined object, reused at one width for the reel and the take. */
.sl-gate{width:min(var(--sl-gate),100%);border:1px solid var(--sl-rule);background:var(--sl-panel)}
.sl-aperture{position:relative;aspect-ratio:9 / 16;width:100%;overflow:hidden;background:var(--sl-deep)}
.sl-aperture > img,.sl-aperture > video{display:block;width:100%;height:100%;object-fit:cover}

/* The ribbon: the signature. Bar widths are shot lengths, drawn on the same
   clock as the tracks above and below, so the ribbon IS the timeline. */
.sl-ribbon{position:relative;height:56px;border:1px solid var(--sl-rule);background:var(--sl-deep);overflow:hidden}
.sl-bar{position:absolute;top:0;bottom:0;display:flex;align-items:flex-end;padding:4px;border-right:1px solid var(--sl-deep);overflow:hidden;transition:filter 220ms var(--sl-in),box-shadow 220ms var(--sl-in)}
.sl-bar:hover{filter:brightness(1.22)}
.sl-bar button{background:none;border:0;padding:0;cursor:pointer}
.sl-bar button:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--sl-focus)}
.sl-bar-slug{display:inline-flex;align-items:center;gap:4px;height:16px;padding-left:4px;padding-right:4px;background:var(--sl-deep);font-size:11px;letter-spacing:.1em;color:var(--sl-ink-2);white-space:nowrap}
.sl-bar-slug-on{color:var(--sl-ink)}

.sl-track{position:relative;border-bottom:1px solid var(--sl-rule)}
.sl-tick{position:absolute;width:1px;background:var(--sl-rule-2)}
.sl-tick-major{background:var(--sl-ink-3)}
.sl-playhead{position:absolute;top:0;bottom:0;width:1px;background:var(--sl-ink);pointer-events:none}
.sl-playhead::before{content:"";position:absolute;top:0;left:-4px;width:8px;height:4px;background:var(--sl-ink)}

/* The index table. Density is the point, and the role edge repeats the code. */
.sl-table{width:100%;border-collapse:collapse}
.sl-table th{padding:8px;border-bottom:1px solid var(--sl-rule-2);font-size:11px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--sl-ink-3);text-align:left;vertical-align:bottom;white-space:nowrap}
.sl-table td{padding:8px;border-bottom:1px solid var(--sl-rule);font-size:13px;line-height:1.45;color:var(--sl-ink-2);vertical-align:top}
.sl-table tbody tr{transition:background-color 220ms var(--sl-in)}
.sl-table tbody tr:hover{background:#1A1E24}
.sl-row-on{background:var(--sl-raised)}
.sl-row-on td{color:var(--sl-ink)}
.sl-num{text-align:right;white-space:nowrap;color:var(--sl-ink)}
.sl-row-btn{padding:0;border:0;background:none;font-size:13px;font-weight:600;letter-spacing:.06em;color:var(--sl-ink);cursor:pointer}
.sl-row-btn:hover{color:var(--sl-focus)}
.sl-thumb{display:block;width:24px;height:42px;object-fit:cover;background:var(--sl-deep)}
.sl-scroll{overflow-x:auto;overflow-y:hidden}

/* Motion. Three uses, none of it load-bearing. */
@keyframes sl-rise{from{opacity:0;transform:translate3d(0,10px,0)}to{opacity:1;transform:translate3d(0,0,0)}}
@keyframes sl-fade{from{opacity:0;filter:blur(4px)}to{opacity:1;filter:blur(0)}}
.sl-rise{animation:sl-rise 520ms var(--sl-in) both;animation-delay:calc(var(--sl-i,0) * 70ms)}
.sl-fade{animation:sl-fade 320ms var(--sl-out) both}

@media (prefers-reduced-motion:reduce){
  .sl-rise,.sl-fade{animation:none}
  .slate *,.slate *::before,.slate *::after{transition-duration:1ms !important}
}
`;

/* ── measuring the ribbon ──────────────────────────────────────────────────────
   A bar carries its number and its role code only if it is wide enough to hold
   them, and how wide a bar is depends on the viewport, so the ribbon is measured
   rather than guessed. Before the first measurement the proportions decide. */
function useTrackWidth(): [React.RefObject<HTMLOListElement | null>, number] {
  const ref = React.useRef<HTMLOListElement | null>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/* ── glyphs ──────────────────────────────────────────────────────────────────── */

function PlayGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
      <path d="M3 2 10 6 3 10Z" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
      <path d="M3.5 2h2v8h-2zM6.5 2h2v8h-2z" />
    </svg>
  );
}

/* ── small parts ─────────────────────────────────────────────────────────────── */

function Field({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="sl-field">
      <dt className="sl-label">{label}</dt>
      <dd className="flex items-baseline gap-2">
        <span className="sl-value">{value}</span>
        {note ? <span className="sl-meta">{note}</span> : null}
      </dd>
    </div>
  );
}

function TextField({ label, value }: { label: string; value: string }) {
  return (
    <div className="sl-field-auto">
      <dt className="sl-label">{label}</dt>
      <dd className="sl-prose">{value}</dd>
    </div>
  );
}

/** Every block opens on the same 24px rule, which is what lets two blocks sit
    side by side without their headings drifting apart. */
function BlockHead({ label, meta, id }: { label: string; meta?: string; id?: string }) {
  return (
    <div className="flex h-6 items-baseline justify-between gap-4 border-b border-[var(--sl-rule)]">
      <h2 className="sl-label" id={id}>
        {label}
      </h2>
      {meta ? <span className="sl-meta">{meta}</span> : null}
    </div>
  );
}

function RoleTag({ purpose }: { purpose: string }) {
  const r = roleOf(purpose);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="sl-swatch" style={{ background: r.hex }} />
      <span className="sl-code" style={{ color: r.hex }}>
        {r.code}
      </span>
      <span className="sl-value-sm">{purposeLabel(purpose)}</span>
    </span>
  );
}

function SlateHead({ film }: { film: DesignFilm | null }) {
  const status = film ? filmStatus(film.status) : null;
  return (
    <header className="w-full border-b border-[var(--sl-rule)]">
      <div className="sl-spine flex h-12 items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="sl-mark">Muse</span>
          <span aria-hidden="true" className="sl-slash">
            /
          </span>
          <span className="sl-label">Slate</span>
        </div>
        <div className="flex items-center gap-4">
          {status ? (
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="sl-dot"
                style={{ background: TONE[status.tone] ?? TONE.neutral }}
              />
              <span className="sl-meta-hi">{status.label}</span>
            </span>
          ) : null}
          <Link href="/design" className="sl-link">
            Directions
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ── the index column ────────────────────────────────────────────────────────── */

function IndexColumn({
  film,
  scoreWord,
  markCount,
}: {
  film: DesignFilm;
  scoreWord: string;
  markCount: number;
}) {
  const bpm = film.music?.bpm ?? null;
  const scoreLength = film.music?.durationS ?? null;
  const scoreNote = [scoreLength ? duration(scoreLength) : null, scoreWord || null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const roles: string[] = [];
  for (const s of film.shots) {
    if (!roles.includes(s.purpose)) roles.push(s.purpose);
  }

  return (
    <div className="sl-index sl-rise pt-8" style={{ "--sl-i": 0 } as React.CSSProperties}>
      <dl>
        <div className="sl-field-auto">
          <dt className="sl-label">Title</dt>
          <dd className="sl-title">{film.title}</dd>
        </div>
        <Field label="Length" value={duration(film.durationS)} />
        <Field label="Shots" value={pad2(film.shots.length)} />
        <Field label="Format" value={FORMAT} />
        <Field
          label="Score"
          value={bpm ? `${bpm} BPM` : film.music ? "no tempo read" : "silent"}
          note={scoreNote || undefined}
        />
        <Field label="Made" value={ago(film.createdAt)} />
        <Field label="Treatment" value={film.presetLabel || presetLabel(film.preset)} />
      </dl>

      {roles.length > 0 ? (
        <section className="mt-8">
          <h2 className="sl-label">Shot roles</h2>
          <ul className="mt-2 flex list-none flex-col gap-2">
            {roles.map((p) => {
              const r = roleOf(p);
              return (
                <li key={p} className="flex items-center gap-2">
                  <span aria-hidden="true" className="sl-swatch" style={{ background: r.hex }} />
                  <span className="sl-code" style={{ color: r.hex }}>
                    {r.code}
                  </span>
                  <span className="sl-prose">{purposeLabel(p)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {film.photos.length > 0 ? (
        <section className="mt-8">
          <h2 className="sl-label">From {pad2(film.photos.length)} photographs</h2>
          <ul className="mt-2 grid list-none grid-cols-3 gap-2">
            {film.photos.map((src, i) => (
              <li
                key={`${src}-${i}`}
                className="border border-[var(--sl-rule)] bg-[var(--sl-deep)]"
              >
                <img
                  src={src}
                  alt={`Photograph ${i + 1} of ${film.photos.length} that ${film.title} was made from`}
                  className="aspect-square w-full object-cover"
                  loading="lazy"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {markCount > 0 ? (
        <p className="sl-meta-hi mt-8 border-t border-[var(--sl-rule)] pt-2">
          {pad2(markCount)} {markCount === 1 ? "shot marked to change" : "shots marked to change"}
        </p>
      ) : null}
    </div>
  );
}

/* ── the index table ─────────────────────────────────────────────────────────── */

function ShotTable({
  shots,
  selected,
  marks,
  onSelect,
}: {
  shots: DesignShot[];
  selected: number;
  marks: Record<string, ChangeKind[]>;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="sl-scroll mt-4">
      <table className="sl-table" style={{ minWidth: 940 }}>
        <caption className="sr-only">
          Every shot in the film, with its role, what happens, its timing and what the review
          decided.
        </caption>
        <thead>
          <tr>
            <th scope="col">Shot</th>
            <th scope="col">Role</th>
            <th scope="col">Frame</th>
            <th scope="col">What happens</th>
            <th scope="col">Move</th>
            <th scope="col">Cut in</th>
            <th scope="col" className="sl-num">
              In
            </th>
            <th scope="col" className="sl-num">
              Out
            </th>
            <th scope="col" className="sl-num">
              Length
            </th>
            <th scope="col">Review</th>
            <th scope="col">Marked</th>
          </tr>
        </thead>
        <tbody>
          {shots.map((s, i) => {
            const r = roleOf(s.purpose);
            const flags = marks[s.id] ?? [];
            return (
              <tr key={s.id} className={i === selected ? "sl-row-on" : undefined}>
                <td style={{ borderLeft: `3px solid ${r.hex}` }}>
                  <button
                    type="button"
                    className="sl-row-btn"
                    aria-pressed={i === selected}
                    onClick={() => onSelect(i)}
                  >
                    {pad2(s.number)}
                    <span className="sr-only">{` — show this shot, ${purposeLabel(s.purpose)}`}</span>
                  </button>
                </td>
                <td>
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="sl-swatch" style={{ background: r.hex }} />
                    <span className="sl-code" style={{ color: r.hex }}>
                      {r.code}
                    </span>
                    <span>{purposeLabel(s.purpose)}</span>
                  </span>
                </td>
                <td>
                  {s.frameUrl ? (
                    <img
                      src={s.frameUrl}
                      alt={`Frame from shot ${pad2(s.number)}: ${s.action}`}
                      className="sl-thumb"
                      loading="lazy"
                    />
                  ) : (
                    <span className="sl-meta">not painted</span>
                  )}
                </td>
                <td style={{ minWidth: 224 }}>{s.action}</td>
                <td>{cameraLabel(s.camera)}</td>
                <td>{transitionLabel(s.transitionIn)}</td>
                <td className="sl-num">{tc(s.startS)}</td>
                <td className="sl-num">{tc(s.endS)}</td>
                <td className="sl-num">{tc(s.durationS)}</td>
                <td>{s.review ? reviewLabel(s.review) : "not reviewed"}</td>
                <td>
                  {flags.length > 0 ? (
                    <span className="flex items-center gap-2">
                      {CHANGES.filter((c) => flags.includes(c.kind)).map((c) => (
                        <span key={c.kind} className="sl-tag">
                          {c.code}
                          <span className="sr-only">{` ${c.label}`}</span>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="sl-meta">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── the empty slate ─────────────────────────────────────────────────────────── */

const EMPTY_FIELDS = ["Title", "Length", "Shots", "Format", "Score", "Made"];

function EmptySlate() {
  return (
    <div className="slate sl-edge">
      <style>{SLATE_CSS}</style>
      <SlateHead film={null} />
      <main className="sl-spine pb-16 pt-8">
        <div className="sl-main">
          <div className="sl-index">
            <dl>
              {EMPTY_FIELDS.map((label) => (
                <div key={label} className="sl-field">
                  <dt className="sl-label">{label}</dt>
                  <dd className="sl-value">
                    <span aria-hidden="true">——</span>
                    <span className="sr-only">not set yet</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="sl-film">
            <BlockHead label="The film" meta="empty" />
            <h1 className="sl-title mt-4">Nothing on the slate</h1>
            <p className="sl-prose mt-4">
              A few photographs and one sentence fill every field in this column, and the ribbon
              underneath it.
            </p>
            <Link href="/" className="sl-btn mt-6">
              Load some photographs
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ── the slate ───────────────────────────────────────────────────────────────── */

function Slate({ film }: { film: DesignFilm }) {
  const shots = film.shots;
  const lastEnd = shots.length > 0 ? shots[shots.length - 1].endS : 0;
  const total = Math.max(film.durationS, lastEnd, 1);

  const [selected, setSelected] = React.useState(0);
  const [reelPlaying, setReelPlaying] = React.useState(false);
  const [takePlaying, setTakePlaying] = React.useState(false);
  const [playheadS, setPlayheadS] = React.useState(0);
  const [view, setView] = React.useState<"frame" | "take">("frame");
  const [marks, setMarks] = React.useState<Record<string, ChangeKind[]>>({});

  const reelRef = React.useRef<HTMLVideoElement | null>(null);
  const takeRef = React.useRef<HTMLVideoElement | null>(null);
  const lastReportRef = React.useRef(0);
  const [ribbonRef, ribbonWidth] = useTrackWidth();

  const index = shots.length > 0 ? Math.min(selected, shots.length - 1) : -1;
  const shot: DesignShot | null = index >= 0 ? shots[index] : null;
  const shotRole = shot ? roleOf(shot.purpose) : ROLE_OTHER;
  const score = scoreMarks(film, total);
  const markCount = Object.keys(marks).length;

  /* A new shot means a new frame: the previous take is put away. */
  React.useEffect(() => {
    setView("frame");
    setTakePlaying(false);
  }, [index]);

  /* Asking for the take rolls it, once the element for this shot exists. */
  React.useEffect(() => {
    if (view !== "take") return;
    const el = takeRef.current;
    if (!el) return;
    void el.play().catch(() => setTakePlaying(false));
  }, [view, index]);

  /* Eight reports a second: continuous to the eye, cheap to redraw. While the
     reel runs the selection follows the playhead, so the ribbon and the shot
     below it always describe what is on screen. */
  function onReelTime(event: React.SyntheticEvent<HTMLVideoElement>) {
    const el = event.currentTarget;
    const now = performance.now();
    if (now - lastReportRef.current < 125) return;
    lastReportRef.current = now;
    const t = el.currentTime;
    setPlayheadS(t);
    const under = shots.findIndex((s) => t >= s.startS && t < s.endS);
    if (under >= 0) setSelected((prev) => (prev === under ? prev : under));
  }

  function toggleReel() {
    const el = reelRef.current;
    if (!el) return;
    if (el.paused) {
      takeRef.current?.pause();
      void el.play().catch(() => setReelPlaying(false));
    } else {
      el.pause();
    }
  }

  function toggleTake() {
    const el = takeRef.current;
    if (!el) return;
    if (el.paused) {
      reelRef.current?.pause();
      void el.play().catch(() => setTakePlaying(false));
    } else {
      el.pause();
    }
  }

  function selectShot(i: number) {
    setSelected(i);
    const target = shots[i];
    const el = reelRef.current;
    if (target && el) {
      el.currentTime = Math.min(Math.max(target.startS, 0), total);
      setPlayheadS(target.startS);
    }
  }

  const seconds = Math.floor(total);
  const ticks: number[] = [];
  for (let s = 0; s <= seconds; s += 1) ticks.push(s);

  return (
    <div className="slate sl-edge">
      <style>{SLATE_CSS}</style>
      <SlateHead film={film} />

      <main className="sl-spine pb-16 pt-8">
        <div className="sl-main">
          <IndexColumn film={film} scoreWord={score.word} markCount={markCount} />

          <div className="sl-film">
            {/* ── the film, and the report that came with it ────────────────── */}
            <section
              className="sl-rise grid gap-8 lg:grid-cols-[var(--sl-gate)_minmax(0,1fr)] lg:grid-rows-[24px_auto]"
              style={{ "--sl-i": 1 } as React.CSSProperties}
              aria-labelledby="sl-film-head"
            >
              <div className="grid content-start gap-4 lg:row-span-2 lg:grid-rows-subgrid">
                <BlockHead
                  label="The film"
                  meta={reelPlaying ? "running" : "held"}
                  id="sl-film-head"
                />
                <figure className="sl-gate">
                  <div className="sl-aperture">
                    {film.reelUrl ? (
                      <video
                        ref={reelRef}
                        src={film.reelUrl}
                        poster={film.posterUrl ?? undefined}
                        preload="metadata"
                        playsInline
                        aria-label={`The film: ${film.title}`}
                        onTimeUpdate={onReelTime}
                        onPlay={() => setReelPlaying(true)}
                        onPause={() => setReelPlaying(false)}
                        onEnded={() => setReelPlaying(false)}
                      />
                    ) : film.posterUrl ? (
                      <img src={film.posterUrl} alt={`Poster for ${film.title}`} />
                    ) : (
                      <span className="sl-meta absolute bottom-2 left-2">not cut yet</span>
                    )}
                    <span className="sl-tag absolute left-2 top-2">Reel</span>
                  </div>
                  <figcaption className="flex h-8 items-center justify-between gap-2 border-t border-[var(--sl-rule)] px-2">
                    <button
                      type="button"
                      className="sl-icon"
                      onClick={toggleReel}
                      disabled={!film.reelUrl}
                      aria-label={reelPlaying ? "Pause the film" : "Play the film"}
                    >
                      {reelPlaying ? <PauseGlyph /> : <PlayGlyph />}
                    </button>
                    <span className="sl-meta-hi">
                      {tc(playheadS)} / {duration(film.durationS)}
                    </span>
                  </figcaption>
                </figure>
              </div>

              <div className="grid content-start gap-4 lg:row-span-2 lg:grid-rows-subgrid">
                <BlockHead
                  label="Camera report"
                  meta={film.presetLabel || presetLabel(film.preset)}
                />
                <div>
                  {film.logline ? <p className="sl-logline">{film.logline}</p> : null}

                  <dl className="mt-6 grid gap-x-8 sm:grid-cols-2">
                    <TextField label="The sentence" value={film.brief} />
                    <TextField label="Medium" value={film.medium} />
                    <TextField label="Light" value={film.lighting} />
                    <div className="sl-field-auto">
                      <dt className="sl-label">Palette</dt>
                      <dd>
                        <span className="flex flex-wrap items-center gap-2">
                          {film.swatches.map((hex, i) => (
                            <span
                              key={`${hex}-${i}`}
                              aria-hidden="true"
                              className="sl-swatch"
                              style={{ background: hex }}
                            />
                          ))}
                        </span>
                        {film.paletteWords.length > 0 ? (
                          <span className="sl-prose mt-2 block">
                            {film.paletteWords.join(", ")}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-6 flex flex-wrap items-center gap-4">
                    <button type="button" className="sl-btn" disabled={markCount === 0}>
                      {markCount === 0
                        ? "Nothing marked to change"
                        : `Send ${pad2(markCount)} back to be recut`}
                    </button>
                    {markCount > 0 ? (
                      <button type="button" className="sl-btn" onClick={() => setMarks({})}>
                        Clear the marks
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            {/* ── the ribbon: bar widths are shot lengths ───────────────────── */}
            <section
              className="sl-rise mt-12"
              style={{ "--sl-i": 2 } as React.CSSProperties}
              aria-labelledby="sl-ribbon-head"
            >
              <BlockHead
                label="Shot ribbon"
                meta="bar width is shot length"
                id="sl-ribbon-head"
              />

              <div className="mt-4 grid grid-cols-[56px_minmax(0,1fr)] gap-x-2">
                <div className="flex flex-col gap-2">
                  <span className="sl-label flex items-center" style={{ height: TRACK.beats }}>
                    Beats
                  </span>
                  <span className="sl-label flex items-center" style={{ height: TRACK.shots }}>
                    Shots
                  </span>
                  <span className="sl-label flex items-center" style={{ height: TRACK.score }}>
                    Score
                  </span>
                  <span className="sl-label flex items-center" style={{ height: TRACK.ruler }}>
                    Time
                  </span>
                </div>

                <div className="relative flex flex-col gap-2">
                  {/* The ticks draw the beats; the list underneath the timeline is
                      where they are read, so nothing is announced twice. */}
                  <div className="sl-track" style={{ height: TRACK.beats }} aria-hidden="true">
                    {film.events.map((e, i) => {
                      const level = Math.min(1, Math.max(0, e.intensity));
                      return (
                        <span
                          key={`${e.kind}-${i}`}
                          className="sl-tick"
                          style={{
                            left: at(e.t, total),
                            bottom: 0,
                            height: 8 + Math.round(level * 14),
                            width: level > 0.66 ? 2 : 1,
                            background: level > 0.66 ? "var(--sl-ink-2)" : "var(--sl-ink-3)",
                          }}
                        />
                      );
                    })}
                  </div>

                  <ol
                    ref={ribbonRef}
                    className="sl-ribbon list-none"
                    aria-label="The shots, laid out on the film's clock"
                  >
                    {shots.map((s, i) => {
                      const r = roleOf(s.purpose);
                      const live = i === index;
                      const share = s.durationS / total;
                      const barPx = ribbonWidth * share;
                      const showNumber = ribbonWidth === 0 || barPx >= 26;
                      const showCode = ribbonWidth === 0 ? share > 0.14 : barPx >= 52;
                      return (
                        <li
                          key={s.id}
                          className="sl-bar"
                          style={{
                            left: at(s.startS, total),
                            width: at(s.durationS, total),
                            ...clapper(r.hex, i, live),
                          }}
                        >
                          <button
                            type="button"
                            className="flex h-full w-full items-end"
                            aria-pressed={live}
                            aria-label={`Shot ${pad2(s.number)}, ${purposeLabel(
                              s.purpose,
                            )}, ${tc(s.durationS)} long, from ${tc(s.startS)} to ${tc(s.endS)}`}
                            onClick={() => selectShot(i)}
                          >
                            {showNumber ? (
                              <span
                                className={live ? "sl-bar-slug sl-bar-slug-on" : "sl-bar-slug"}
                              >
                                {pad2(s.number)}
                                {showCode ? (
                                  <span style={{ color: r.hex }}>{r.code}</span>
                                ) : null}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                    {shots.length === 0 ? (
                      <li className="sl-meta absolute bottom-2 left-2">no shots cut yet</li>
                    ) : null}
                  </ol>

                  <div className="sl-track" style={{ height: TRACK.score }} aria-hidden="true">
                    {score.marks.map((m, i) => (
                      <span
                        key={`${m.t}-${i}`}
                        className={m.strong ? "sl-tick sl-tick-major" : "sl-tick"}
                        style={{ left: at(m.t, total), top: 8, height: m.strong ? 12 : 8 }}
                      />
                    ))}
                  </div>

                  <div className="relative" style={{ height: TRACK.ruler }} aria-hidden="true">
                    {ticks.map((s) => {
                      const major = s % 5 === 0;
                      const last = s === seconds;
                      return (
                        <React.Fragment key={s}>
                          <span
                            className={major ? "sl-tick sl-tick-major" : "sl-tick"}
                            style={{ left: at(s, total), top: 0, height: major ? 8 : 4 }}
                          />
                          {major ? (
                            <span
                              className="sl-meta absolute bottom-0"
                              style={{
                                left: at(s, total),
                                transform: last ? "translateX(-100%)" : "translateX(0)",
                              }}
                            >
                              {s}s
                            </span>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                  </div>

                  {film.reelUrl ? (
                    <span
                      className="sl-playhead"
                      style={{ left: at(playheadS, total) }}
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              </div>

              {film.events.length > 0 ? (
                <ul className="mt-4 grid list-none grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-x-8 gap-y-2">
                  {film.events.map((e, i) => (
                    <li
                      key={`beat-${e.kind}-${i}`}
                      className="border-l border-[var(--sl-rule)] pl-2"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="sl-value-sm">{tc(e.t)}</span>
                        <span className="sl-prose">{beatLabel(e.kind)}</span>
                      </span>
                      <span className="sl-meta block">
                        level {Math.min(1, Math.max(0, e.intensity)).toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            {/* ── the shot on the slate ─────────────────────────────────────── */}
            {shot ? (
              <section
                className="sl-rise mt-12 grid gap-8 lg:grid-cols-[var(--sl-gate)_minmax(0,1fr)] lg:grid-rows-[24px_auto]"
                style={{ "--sl-i": 3 } as React.CSSProperties}
                aria-labelledby="sl-shot-head"
              >
                <div className="grid content-start gap-4 lg:row-span-2 lg:grid-rows-subgrid">
                  <div className="flex h-6 items-baseline justify-between gap-4 border-b border-[var(--sl-rule)]">
                    <h2 className="sl-label" id="sl-shot-head">
                      Shot {pad2(shot.number)}
                    </h2>
                    <span className="sl-code" style={{ color: shotRole.hex }}>
                      {shotRole.code}
                    </span>
                  </div>
                  <figure className="sl-gate" style={{ borderTop: `3px solid ${shotRole.hex}` }}>
                    <div className="sl-aperture">
                      {view === "take" && shot.takeUrl ? (
                        <video
                          key={shot.id}
                          ref={takeRef}
                          src={shot.takeUrl}
                          poster={shot.frameUrl ?? undefined}
                          preload="metadata"
                          playsInline
                          loop
                          className="sl-fade"
                          aria-label={`The take for shot ${pad2(shot.number)}: ${shot.action}`}
                          onPlay={() => setTakePlaying(true)}
                          onPause={() => setTakePlaying(false)}
                        />
                      ) : shot.frameUrl ? (
                        <img
                          key={shot.id}
                          src={shot.frameUrl}
                          alt={`Frame from shot ${pad2(shot.number)}: ${shot.action}`}
                          className="sl-fade"
                        />
                      ) : (
                        <span className="sl-meta absolute bottom-2 left-2">not painted yet</span>
                      )}
                    </div>
                    <figcaption className="flex h-8 items-center justify-between gap-2 border-t border-[var(--sl-rule)] px-2">
                      <span className="flex items-center gap-2">
                        <button
                          type="button"
                          className={
                            view === "frame" ? "sl-btn sl-btn-sm sl-btn-on" : "sl-btn sl-btn-sm"
                          }
                          aria-pressed={view === "frame"}
                          onClick={() => {
                            setView("frame");
                            takeRef.current?.pause();
                          }}
                        >
                          Frame
                        </button>
                        <button
                          type="button"
                          className={
                            view === "take" ? "sl-btn sl-btn-sm sl-btn-on" : "sl-btn sl-btn-sm"
                          }
                          aria-pressed={view === "take"}
                          disabled={!shot.takeUrl}
                          onClick={() => {
                            reelRef.current?.pause();
                            setView("take");
                          }}
                        >
                          Take
                        </button>
                      </span>
                      {view === "take" && shot.takeUrl ? (
                        <button
                          type="button"
                          className="sl-icon"
                          onClick={toggleTake}
                          aria-label={takePlaying ? "Pause the take" : "Play the take"}
                        >
                          {takePlaying ? <PauseGlyph /> : <PlayGlyph />}
                        </button>
                      ) : (
                        <span className="sl-meta">{shot.takeUrl ? "held" : "no take yet"}</span>
                      )}
                    </figcaption>
                  </figure>
                </div>

                <div className="grid content-start gap-4 lg:row-span-2 lg:grid-rows-subgrid">
                  <BlockHead label="What happens" meta={`${tc(shot.startS)} → ${tc(shot.endS)}`} />
                  <div>
                    <p className="sl-prose">{shot.action}</p>

                    <dl className="mt-6 grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
                      <div className="sl-field">
                        <dt className="sl-label">Role</dt>
                        <dd>
                          <RoleTag purpose={shot.purpose} />
                        </dd>
                      </div>
                      <Field label="Move" value={cameraLabel(shot.camera)} />
                      <Field label="Cut in" value={transitionLabel(shot.transitionIn)} />
                      <Field label="Length" value={tc(shot.durationS)} />
                      <Field
                        label="Review"
                        value={shot.review ? reviewLabel(shot.review) : "not reviewed"}
                      />
                      <Field
                        label="Origin"
                        value={shot.generated ? "painted" : "made on this machine"}
                      />
                    </dl>

                    <div className="mt-6 flex flex-wrap items-center gap-4">
                      {CHANGES.map((c) => {
                        const on = (marks[shot.id] ?? []).includes(c.kind);
                        return (
                          <button
                            key={c.kind}
                            type="button"
                            className={on ? "sl-btn sl-btn-on" : "sl-btn"}
                            aria-pressed={on}
                            onClick={() => {
                              const id = shot.id;
                              setMarks((prev) => {
                                const current = prev[id] ?? [];
                                const next = current.includes(c.kind)
                                  ? current.filter((k) => k !== c.kind)
                                  : [...current, c.kind];
                                const copy: Record<string, ChangeKind[]> = { ...prev };
                                if (next.length === 0) delete copy[id];
                                else copy[id] = next;
                                return copy;
                              });
                            }}
                          >
                            <span
                              aria-hidden="true"
                              className="sl-swatch"
                              style={{
                                background: on ? "var(--sl-ink)" : "transparent",
                                boxShadow: "inset 0 0 0 1px var(--sl-rule-2)",
                              }}
                            />
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {/* ── the index ─────────────────────────────────────────────────── */}
            {shots.length > 0 ? (
              <section
                className="sl-rise mt-12"
                style={{ "--sl-i": 4 } as React.CSSProperties}
                aria-labelledby="sl-index-head"
              >
                <BlockHead
                  label="Shot index"
                  meta={`${pad2(shots.length)} shots · ${duration(film.durationS)}`}
                  id="sl-index-head"
                />
                <ShotTable shots={shots} selected={index} marks={marks} onSelect={selectShot} />
              </section>
            ) : null}
          </div>
        </div>
      </main>

      <footer className="w-full border-t border-[var(--sl-rule)]">
        <div className="sl-spine flex h-12 items-center justify-between gap-4">
          <span className="sl-label">End of report</span>
          <span className="sl-meta">
            {pad2(shots.length)} shots · {duration(film.durationS)} · {ago(film.createdAt)}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default function VariantSlate({ film }: { film: DesignFilm | null }) {
  if (!film) return <EmptySlate />;
  return <Slate film={film} />;
}
