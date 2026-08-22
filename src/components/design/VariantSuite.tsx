"use client";

/**
 * MUSE — VARIANT B: THE GRADING SUITE
 * ============================================================================
 * A colour grading room. One bright image in a dark room, with the instruments
 * arranged around it. The film is the only thing in here that carries colour;
 * the room borrows its accent from the film's own palette so every project
 * literally recolours its own suite.
 *
 * MEASURE — one spine, held everywhere on this page.
 *   content max-width 1440px, gutter 32px (20px below 640px), 12 columns with a
 *   24px column gap. At 1440 a column is 98px. Every zone begins and ends on a
 *   column line. Three vertical rules carry the whole page:
 *     · the spine's left edge   — slate, legend, strip
 *     · column 4               — the film's left edge, the waveform's left edge,
 *                                 the shot detail's left edge
 *     · the spine's right edge  — readouts, instrument values, actions
 *
 * SPACING — 4px base. The only permitted steps are 4, 8, 12, 16, 24, 32, 48, 72,
 *   exposed as --s1 … --s8. Nothing on this page uses a value outside that set.
 *   Every zone head is exactly 25px tall (a 12px label, 12px of pad, a 1px rule)
 *   so the first baseline of all three columns lands on one line, and the bay is
 *   one fixed height so all three columns also end flush.
 *
 * TYPE — one wide, low-contrast neutral grotesk at 300/400/500 and one mono with
 *   tabular figures for anything that was measured. No display face at all: the
 *   image is the display element. 11px is metadata only; prose is 13px and up.
 *
 * COLOUR — see pickPalette(). The ground is a near-neutral very dark grey. The
 *   accent comes from film.swatches at runtime, measured against the ground
 *   before it is allowed anywhere near type.
 *
 * MOTION — transform, opacity and filter only, custom cubic-beziers only, and
 *   the whole treatment stands still under prefers-reduced-motion.
 * ============================================================================
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DesignEvent, DesignFilm, DesignShot } from "@/app/design/data";
import {
  ago,
  cameraLabel,
  duration,
  filmStatus,
  noun,
  presetLabel,
  purposeLabel,
  reviewLabel,
  transitionLabel,
} from "@/lib/brand";

/* ==========================================================================
   Colour: the room takes its accent from the work, but only if it can be read.
   ========================================================================== */

/** The surface the accent is judged against — the lightest plate in the room. */
const JUDGED_AGAINST = "#141416";
/** Neutrals the room falls back to when a film's palette cannot carry an accent. */
const NEUTRAL_ACCENT = "#cac8c2";
const NEUTRAL_SECOND = "#96938d";

interface RoomPalette {
  /** Rules, fills, indicators and large readouts. Floor 3:1. */
  accent: string;
  /** Small type. Floor 4.5:1, else a neutral. */
  accentText: string;
  /** The second mark: measured accents on the score lane. Floor 3:1. */
  second: string;
  /** True when the film's own colour survived the measurement. */
  fromFilm: boolean;
}

function channel(hex: string, at: number): number {
  const v = Number.parseInt(hex.slice(at, at + 2), 16);
  return Number.isFinite(v) ? v : 0;
}

function normalise(input: string): string | null {
  const raw = input.trim().replace("#", "");
  const hex =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? "#" + hex.toLowerCase() : null;
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const h = hex.replace("#", "");
  return 0.2126 * lin(channel(h, 0)) + 0.7152 * lin(channel(h, 2)) + 0.0722 * lin(channel(h, 4));
}

/** Measured, not eyeballed. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hue(hex: string): number {
  const h = hex.replace("#", "");
  const r = channel(h, 0) / 255;
  const g = channel(h, 2) / 255;
  const b = channel(h, 4) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let deg = 0;
  if (max === r) deg = 60 * (((g - b) / d) % 6);
  else if (max === g) deg = 60 * ((b - r) / d + 2);
  else deg = 60 * ((r - g) / d + 4);
  return (deg + 360) % 360;
}

/**
 * The film's first swatch becomes the room's accent, provided it clears 3:1
 * against the lightest plate it will ever sit on — that is the floor for a rule,
 * a fill or a readout above 24px. If it does not clear it, the next swatch that
 * does takes over, and if none do the room stays neutral. Small type only ever
 * uses a colour that clears 4.5:1, so on a dark-palette film the labels quietly
 * go back to bone white instead of dropping below the floor.
 *
 * The second mark is the surviving swatch furthest away in hue from the accent,
 * which keeps the measured accents on the score lane distinguishable from the
 * cuts without introducing a colour that is not in the film.
 */
function pickPalette(swatches: string[]): RoomPalette {
  const clean = swatches.map(normalise).filter((c): c is string => c !== null);
  const usable = clean.filter((c) => contrast(c, JUDGED_AGAINST) >= 3);
  const accent = usable[0] ?? NEUTRAL_ACCENT;
  const rest = usable.filter((c) => c !== accent);
  const second =
    rest.length > 0
      ? rest.reduce((best, c) => {
          const d = (x: string) => {
            const raw = Math.abs(hue(x) - hue(accent));
            return raw > 180 ? 360 - raw : raw;
          };
          return d(c) > d(best) ? c : best;
        }, rest[0])
      : NEUTRAL_SECOND;
  return {
    accent,
    accentText: contrast(accent, JUDGED_AGAINST) >= 4.5 ? accent : NEUTRAL_ACCENT,
    second,
    fromFilm: usable.length > 0,
  };
}

/* ==========================================================================
   The signature lane: one time axis, three lanes.
   ========================================================================== */

const BINS = 176;
const LANE_W = 1000;
const LANE_H = 132;

/**
 * The score's envelope, derived from the score's own measurements: the density of
 * measured accents around each bin, lifted by the arrangement's planned intensity
 * between beats. It is deterministic — the same film draws the same lane on the
 * server and in the browser.
 */
function scoreEnvelope(anchors: number[], events: DesignEvent[], totalS: number): number[] {
  const out = new Array<number>(BINS).fill(0.12);
  if (totalS <= 0) return out;
  const step = totalS / BINS;
  const beats = [...events].sort((a, b) => a.t - b.t);

  const intensityAt = (t: number): number => {
    if (beats.length === 0) return 0.5;
    let prev = beats[0];
    let next = beats[beats.length - 1];
    for (const b of beats) if (b.t <= t) prev = b;
    for (let i = beats.length - 1; i >= 0; i -= 1) if (beats[i].t >= t) next = beats[i];
    if (next.t === prev.t) return prev.intensity;
    const k = (t - prev.t) / (next.t - prev.t);
    return prev.intensity + (next.intensity - prev.intensity) * k;
  };

  const reach = step * 3;
  for (let i = 0; i < BINS; i += 1) {
    const t = (i + 0.5) * step;
    let hit = 0;
    for (const a of anchors) {
      const d = Math.abs(a - t);
      if (d < reach) hit += 1 - d / reach;
    }
    const density = Math.min(1, hit / 2.1);
    const body = 0.16 + intensityAt(t) * 0.5;
    const texture = 0.84 + 0.16 * Math.abs(Math.sin(i * 12.9898));
    out[i] = Math.min(1, body * (0.6 + density * 0.7) * texture);
  }
  return out;
}

interface CutFit {
  cuts: number;
  worst: number;
}

/** How close every cut lands to a measured accent. Real arithmetic, no claims. */
function cutFit(shots: DesignShot[], anchors: number[]): CutFit | null {
  const cuts = shots.slice(1).map((s) => s.startS);
  if (cuts.length === 0 || anchors.length === 0) return null;
  let worst = 0;
  for (const c of cuts) {
    let best = Number.POSITIVE_INFINITY;
    for (const a of anchors) best = Math.min(best, Math.abs(a - c));
    worst = Math.max(worst, best);
  }
  return { cuts: cuts.length, worst };
}

/* ==========================================================================
   Small local copy. Everything with a noun in it comes from the lexicon; these
   two are the beat vocabulary and the running clock, which the lexicon does not
   carry, written in the same voice.
   ========================================================================== */

const BEAT: Record<string, string> = {
  intro: "the opening",
  accent: "an accent",
  build: "the build",
  drop: "the drop",
  variation: "a variation",
  resolve: "the resolve",
  final_hit: "the last hit",
};

function beatLabel(kind: string): string {
  return BEAT[kind] ?? kind.replace(/_/g, " ");
}

function timecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/* ==========================================================================
   Icons. Two shapes, one weight, no decoration.
   ========================================================================== */

function PlayMark() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M2.5 1.4 10.4 6 2.5 10.6Z" fill="currentColor" />
    </svg>
  );
}

function PauseMark() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M2.8 1.6h2.3v8.8H2.8Zm4.1 0h2.3v8.8H6.9Z" fill="currentColor" />
    </svg>
  );
}

function SoundMark({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 14 12" width="13" height="11" aria-hidden="true" focusable="false">
      <path d="M1 4.4h2.2L6.2 1.8v8.4L3.2 7.6H1Z" fill="currentColor" />
      {on ? (
        <path
          d="M8.4 3.6a4 4 0 0 1 0 4.8M10.4 2.2a6.4 6.4 0 0 1 0 7.6"
          stroke="currentColor"
          strokeWidth="1"
          fill="none"
        />
      ) : (
        <path d="M8.6 4 12 8M12 4 8.6 8" stroke="currentColor" strokeWidth="1" fill="none" />
      )}
    </svg>
  );
}

/* ==========================================================================
   Styles. Scoped to .suite-b so the sibling variants are untouched.
   ========================================================================== */

const CSS = `
.suite-b {
  --measure: 1440px;
  --gutter: 32px;
  --col-gap: 24px;

  --s1: 4px;  --s2: 8px;  --s3: 12px; --s4: 16px;
  --s5: 24px; --s6: 32px; --s7: 48px; --s8: 72px;

  --bay: clamp(520px, 78vh, 960px);
  --lane-h: 132px;
  --r: 2px;

  --room: #0a0a0b;
  --room-deep: #060607;
  --room-lift: #141416;
  --rule: #ffffff17;
  --rule-strong: #ffffff2e;
  --ink-0: #f4f3f0;
  --ink-1: #cac8c2;
  --ink-2: #a8a59f;
  --ink-3: #8b8882;

  --face: "Geist", "SF Pro Text", "Segoe UI Variable Text", system-ui, -apple-system, sans-serif;
  --mono: "Geist Mono", "IBM Plex Mono", ui-monospace, "Cascadia Mono", "SFMono-Regular", monospace;

  --t-label: 11px;
  --t-num: 12px;
  --t-prose: 13px;
  --t-body: 15px;
  --t-read: 20px;
  --t-read-lg: 30px;
  --t-title: clamp(26px, 2.4vw + 12px, 42px);

  --e-in: cubic-bezier(0.22, 0.72, 0, 1);
  --e-hover: cubic-bezier(0.2, 0.8, 0.24, 1);
  --e-bloom: cubic-bezier(0.33, 0, 0.2, 1);

  position: relative;
  overflow-x: clip;
  min-height: 100dvh;
  padding-block: var(--s7) var(--s8);
  background-color: var(--room);
  color: var(--ink-1);
  font-family: var(--face);
  font-size: var(--t-body);
  font-weight: 400;
  line-height: 1.5;
}

@media (max-width: 639px) {
  .suite-b { --gutter: 20px; --col-gap: 16px; }
}

.suite-b .spine {
  width: 100%;
  max-width: calc(var(--measure) + var(--gutter) * 2);
  margin-inline: auto;
  padding-inline: var(--gutter);
}
.suite-b .grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  column-gap: var(--col-gap);
}

.suite-b .num {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}
.suite-b .label {
  font-family: var(--mono);
  font-size: var(--t-label);
  line-height: 12px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-2);
}

/* Every zone head is 25px tall, so the columns share one first baseline. */
.suite-b .head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s4);
  padding-bottom: var(--s3);
  border-bottom: 1px solid var(--rule);
}
.suite-b .head h2 { margin: 0; }
.suite-b .head-value {
  font-family: var(--mono);
  font-size: var(--t-num);
  line-height: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-3);
  white-space: nowrap;
}

/* -- slate ---------------------------------------------------------------- */

/* Three rows, three shared baselines: the labels sit on one line across the
   whole measure, the title sits on one line with the readouts, and the logline
   sits on one line with the state. */
.suite-b .slate { row-gap: var(--s3); align-items: baseline; }
.suite-b .slate-eyebrow { grid-column: 1 / -1; }
.suite-b .slate-title {
  grid-column: 1 / -1;
  margin: 0;
  font-size: var(--t-title);
  font-weight: 300;
  line-height: 1.06;
  letter-spacing: -0.018em;
  color: var(--ink-0);
  text-wrap: balance;
}
.suite-b .slate-logline {
  grid-column: 1 / -1;
  margin: 0;
  max-width: 54ch;
  font-size: var(--t-body);
  color: var(--ink-2);
}
.suite-b .slate-labels,
.suite-b .slate-values {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: var(--col-gap);
  align-items: baseline;
}
.suite-b .slate-values span {
  font-family: var(--mono);
  font-size: var(--t-read);
  line-height: 20px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--ink-0);
}
.suite-b .slate-state {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  font-size: var(--t-prose);
  color: var(--ink-2);
}
.suite-b .ink-3 { color: var(--ink-3); }
.suite-b .contents { display: contents; }
.suite-b .after-head { margin-top: var(--s4); }
.suite-b .pip {
  width: 8px; height: 8px; flex: none;
  transform: translateY(-1px);
  background: var(--accent);
}
.suite-b .pip[data-hollow="true"] { background: transparent; box-shadow: inset 0 0 0 1px var(--accent); }

/* -- the bay: left instruments | viewer | rail --------------------------- */

.suite-b .bay { margin-top: var(--s7); row-gap: var(--s7); }
.suite-b .zone { grid-column: 1 / -1; display: flex; flex-direction: column; min-width: 0; }
.suite-b .zone > * + * { margin-top: var(--s4); }

.suite-b .film-mat {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
}
.suite-b .film-frame {
  position: relative;
  width: min(100%, 380px);
  aspect-ratio: 9 / 16;
  background: var(--room-deep);
  box-shadow: 0 0 0 1px var(--rule);
  overflow: hidden;
}
.suite-b .film-frame video,
.suite-b .film-frame .poster {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.suite-b .film-frame .poster {
  transition: opacity 520ms var(--e-bloom);
}
.suite-b .film-frame .poster[data-hidden="true"] { opacity: 0; }
/* Light spill: the film's own colour thrown onto the wall behind it. One hue,
   one radial, and it lifts only while the film is running. */
.suite-b .bloom {
  position: absolute;
  inset: -12% -22% -18% -14%;
  z-index: -1;
  background: radial-gradient(56% 46% at 34% 42%, var(--accent) 0%, transparent 72%);
  filter: blur(64px);
  opacity: 0.09;
  transition: opacity 900ms var(--e-bloom);
  pointer-events: none;
}
.suite-b .bay[data-running="true"] .bloom { opacity: 0.2; }

.suite-b .transport {
  display: flex;
  align-items: center;
  gap: var(--s4);
}
.suite-b .clock {
  font-family: var(--mono);
  font-size: var(--t-num);
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
}
.suite-b .clock .of { color: var(--ink-3); }

/* -- left instruments ---------------------------------------------------- */

.suite-b .thumbs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s2); list-style: none; margin: 0; padding: 0; }
.suite-b .thumbs img {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  display: block;
  background: var(--room-lift);
  filter: saturate(0.35) brightness(0.78);
}
.suite-b .chips { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s3) var(--s3); list-style: none; margin: 0; padding: 0; }
.suite-b .chips li { display: flex; flex-direction: column; gap: var(--s1); }
.suite-b .chip { height: 16px; box-shadow: inset 0 0 0 1px #ffffff26; }
.suite-b .chip-hex {
  font-family: var(--mono);
  font-size: var(--t-label);
  line-height: 12px;
  letter-spacing: 0.02em;
  color: var(--ink-3);
  text-transform: uppercase;
}
.suite-b .chip-use { color: var(--ink-2); }
.suite-b .words { list-style: none; margin: 0; padding: 0; font-size: var(--t-prose); color: var(--ink-2); }
.suite-b .words li { display: flex; gap: var(--s2); padding-block: 2px; }
.suite-b .words li::before {
  content: "";
  flex: none;
  width: 4px; height: 4px;
  margin-top: var(--s2);
  background: var(--accent);
  opacity: 0.85;
}
.suite-b .zone--left .stack > * + * { margin-top: var(--s6); }
.suite-b .look { display: flex; flex-direction: column; gap: var(--s3); }
.suite-b .look div { display: flex; flex-direction: column; gap: var(--s1); }
.suite-b .look p { margin: 0; font-size: var(--t-prose); color: var(--ink-1); }

/* -- rail ---------------------------------------------------------------- */

.suite-b .rail { gap: var(--s6); }
.suite-b .rail > * + * { margin-top: 0; }
.suite-b .instrument { display: flex; flex-direction: column; min-height: 0; }
.suite-b .instrument > * + * { margin-top: var(--s4); }
.suite-b .instrument--beats { flex: 1; }

.suite-b .tempo { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s5); }
.suite-b .tempo .pairs { flex: 1; }
.suite-b .tempo-big {
  font-family: var(--mono);
  font-size: var(--t-read-lg);
  line-height: 30px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--accent-text);
}
.suite-b .tempo-unit { font-family: var(--mono); font-size: var(--t-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); margin-left: var(--s2); }
.suite-b .pairs { display: grid; grid-template-columns: 1fr auto; column-gap: var(--s4); row-gap: var(--s2); align-items: baseline; }
.suite-b .pairs dt { font-size: var(--t-prose); color: var(--ink-2); }
.suite-b .pairs dd {
  margin: 0;
  font-family: var(--mono);
  font-size: var(--t-num);
  font-variant-numeric: tabular-nums;
  color: var(--ink-1);
  text-align: right;
}

.suite-b .beats { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; }
.suite-b .beat {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 40px 36px;
  column-gap: var(--s3);
  align-items: baseline;
  width: 100%;
  padding-block: var(--s2);
  border: 0;
  border-bottom: 1px solid var(--rule);
  background: none;
  text-align: left;
  cursor: pointer;
  transition: background-color 220ms var(--e-hover);
}
.suite-b .beats li:last-child .beat { border-bottom: 0; }
.suite-b .beat:hover { background-color: #ffffff0a; }
.suite-b .beat-t { font-family: var(--mono); font-size: var(--t-num); font-variant-numeric: tabular-nums; color: var(--ink-2); text-align: right; }
.suite-b .beat-k { font-size: var(--t-prose); color: var(--ink-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.suite-b .beat-v { font-family: var(--mono); font-size: var(--t-num); font-variant-numeric: tabular-nums; color: var(--ink-3); text-align: right; }
.suite-b .meter { display: block; height: 4px; transform: translateY(-3px); background: #ffffff14; }
.suite-b .meter i { display: block; height: 100%; background: var(--accent); transform-origin: left center; }
.suite-b .beat[data-peak="true"] .beat-k { color: var(--ink-0); }

/* -- the lane ------------------------------------------------------------ */

.suite-b .lane-row { margin-top: var(--s7); }
.suite-b .legend {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--s5);
  margin-bottom: var(--s4);
}
.suite-b .legend-row { display: flex; flex-direction: column; gap: var(--s1); }
.suite-b .legend-v { font-family: var(--mono); font-size: var(--t-num); font-variant-numeric: tabular-nums; color: var(--ink-1); }
.suite-b .lane { grid-column: 1 / -1; min-width: 0; }
.suite-b .lane-scroll { overflow-x: auto; overflow-y: hidden; }
.suite-b .lane-plate {
  position: relative;
  min-width: 460px;
  overflow: hidden;
  background: var(--room-deep);
  box-shadow: inset 0 0 0 1px var(--rule);
}
.suite-b .lane-plate svg { display: block; width: 100%; height: var(--lane-h); }
.suite-b .lane-ticks { position: relative; height: var(--s5); }
.suite-b .lane-ticks span {
  position: absolute;
  top: 4px;
  font-family: var(--mono);
  font-size: var(--t-label);
  line-height: 12px;
  letter-spacing: 0.08em;
  color: var(--ink-3);
}
.suite-b .playtrack {
  position: absolute;
  top: 0; left: 0;
  width: 100%;
  height: var(--lane-h);
  pointer-events: none;
  transform: translate3d(calc(var(--p, 0) * 100%), 0, 0);
}
.suite-b .playtrack i {
  position: absolute;
  top: 0; left: 0;
  width: 1px;
  height: 100%;
  background: var(--ink-0);
}
.suite-b .playtrack i::after {
  content: "";
  position: absolute;
  top: 0; left: -1px;
  width: 4px; height: 4px;
  background: var(--ink-0);
}
.suite-b .lane-hit {
  position: absolute;
  inset: 0 0 var(--s5) 0;
  width: 100%;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: col-resize;
}
.suite-b .lane-hit::-webkit-slider-runnable-track { height: 100%; background: transparent; }
.suite-b .lane-hit::-webkit-slider-thumb { -webkit-appearance: none; width: 3px; height: var(--lane-h); background: transparent; }
.suite-b .lane-hit::-moz-range-track { height: 100%; background: transparent; }
.suite-b .lane-hit::-moz-range-thumb { width: 3px; height: var(--lane-h); border: 0; border-radius: 0; background: transparent; }
.suite-b .lane-note { margin: var(--s3) 0 0; font-size: var(--t-prose); color: var(--ink-2); }
.suite-b .lane-note b { font-family: var(--mono); font-weight: 400; font-variant-numeric: tabular-nums; color: var(--ink-0); }

/* -- shots strip --------------------------------------------------------- */

.suite-b .strip-row { margin-top: var(--s7); row-gap: var(--s4); align-items: baseline; }
.suite-b .strip-head { grid-column: 1 / -1; }
.suite-b .detail { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s3) var(--s4); }
.suite-b .detail-n { font-family: var(--mono); font-size: var(--t-read); line-height: 20px; font-variant-numeric: tabular-nums; color: var(--accent-text); }
.suite-b .detail-p { font-size: var(--t-body); color: var(--ink-0); }
.suite-b .detail-m { font-size: var(--t-prose); color: var(--ink-2); }
.suite-b .detail-actions { display: flex; gap: var(--s2); margin-left: auto; }
.suite-b .detail-action { grid-column: 1 / -1; }
.suite-b .action-line {
  grid-column: 1 / -1;
  margin: 0;
  max-width: 62ch;
  min-height: 4.5em;
  font-size: var(--t-body);
  color: var(--ink-1);
}

.suite-b .strip { grid-column: 1 / -1; overflow-x: auto; padding-bottom: var(--s2); }
.suite-b .strip ol {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(148px, 1fr);
  column-gap: var(--s4);
  list-style: none;
  margin: 0;
  padding: 0;
  scroll-snap-type: x proximity;
}
.suite-b .card {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
  scroll-snap-align: start;
}
.suite-b .card-plate {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  background: var(--room-lift);
  overflow: hidden;
  box-shadow: inset 0 0 0 1px var(--rule);
}
.suite-b .card-plate img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  filter: saturate(0.32) brightness(0.72);
  transition: filter 380ms var(--e-bloom), transform 300ms var(--e-hover);
}
.suite-b .card:hover .card-plate img { filter: saturate(0.6) brightness(0.9); transform: scale(1.02); }
.suite-b .card[aria-current="true"] .card-plate img { filter: none; }
.suite-b .card[aria-current="true"] .card-plate::after {
  content: "";
  position: absolute;
  inset: auto 0 0 0;
  height: 2px;
  background: var(--accent);
}
.suite-b .card-top { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s2); }
.suite-b .card-n { font-family: var(--mono); font-size: var(--t-read); line-height: 20px; font-variant-numeric: tabular-nums; color: var(--ink-3); }
.suite-b .card[aria-current="true"] .card-n { color: var(--accent-text); }
.suite-b .card-d { font-family: var(--mono); font-size: var(--t-label); line-height: 12px; font-variant-numeric: tabular-nums; color: var(--ink-3); }
.suite-b .card-p { font-size: var(--t-prose); color: var(--ink-1); }
.suite-b .card-meta { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s2); font-family: var(--mono); font-size: var(--t-label); line-height: 12px; letter-spacing: 0.06em; color: var(--ink-3); text-transform: uppercase; }
.suite-b .card-flag { color: var(--ink-2); }

/* -- controls ------------------------------------------------------------ */

.suite-b .btn {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s2) var(--s3);
  border: 1px solid var(--rule-strong);
  border-radius: var(--r);
  background: transparent;
  color: var(--ink-1);
  font-family: var(--face);
  font-size: var(--t-prose);
  line-height: 14px;
  cursor: pointer;
  transition: background-color 240ms var(--e-hover), border-color 240ms var(--e-hover), color 240ms var(--e-hover), transform 240ms var(--e-hover);
}
.suite-b .btn:hover { background-color: #ffffff0d; border-color: var(--accent); transform: translateY(-1px); }
.suite-b .btn[data-primary="true"] { border-color: var(--accent); color: var(--accent-text); }
.suite-b .btn[data-on="true"] { background-color: #ffffff12; color: var(--ink-0); }
.suite-b .btn:disabled { opacity: 0.45; cursor: default; transform: none; }
.suite-b .icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px; height: 32px;
  flex: none;
  padding: 0;
  border: 1px solid var(--rule-strong);
  border-radius: var(--r);
  background: transparent;
  color: var(--ink-0);
  cursor: pointer;
  transition: border-color 240ms var(--e-hover), background-color 240ms var(--e-hover);
}
.suite-b .icon-btn:hover { border-color: var(--accent); background-color: #ffffff0d; }
.suite-b .icon-btn--sm { width: 24px; height: 24px; border-color: var(--rule); color: var(--ink-2); }
.suite-b .icon-btn[data-primary="true"] { border-color: var(--accent); color: var(--accent-text); }

.suite-b :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* The plate clips its children, so the scrub ring is drawn inside it. */
.suite-b .lane-hit:focus-visible { outline-offset: -2px; }

/* -- three zones, one grid ---------------------------------------------- */

@media (min-width: 900px) {
  .suite-b .slate-eyebrow { grid-column: 1 / 9; grid-row: 1; }
  .suite-b .slate-title { grid-column: 1 / 9; grid-row: 2; }
  .suite-b .slate-logline { grid-column: 1 / 9; grid-row: 3; }
  .suite-b .slate-labels { grid-column: 9 / -1; grid-row: 1; }
  .suite-b .slate-values { grid-column: 9 / -1; grid-row: 2; }
  .suite-b .slate-state { grid-column: 9 / -1; grid-row: 3; }

  .suite-b .zone--view { grid-column: 1 / 8; grid-row: 1; }
  .suite-b .zone--rail { grid-column: 8 / -1; grid-row: 1; }
  .suite-b .zone--left { grid-column: 1 / -1; grid-row: 2; }
  .suite-b .zone--left .stack { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: var(--col-gap); align-items: start; }
  .suite-b .zone--left .stack > * + * { margin-top: 0; }
}

@media (min-width: 1240px) {
  .suite-b .zone--left { grid-column: 1 / 4; grid-row: 1; height: var(--bay); overflow-y: auto; scrollbar-gutter: stable; }
  .suite-b .zone--left .stack { display: block; }
  .suite-b .zone--left .stack > * + * { margin-top: var(--s6); }
  .suite-b .zone--view { grid-column: 4 / 9; grid-row: 1; height: var(--bay); }
  .suite-b .zone--rail { grid-column: 9 / -1; grid-row: 1; height: var(--bay); }
  .suite-b .film-frame { width: auto; height: 100%; max-width: 100%; }

  /* The legend's three rows are the lane bands, to the pixel: 0-58, 68-96,
     104-132. Each label's baseline sits on the bottom edge of the lane it
     names, and the three counts share one right-hand rule. */
  .suite-b .legend {
    grid-column: 1 / 4;
    display: grid;
    grid-template-rows: 58px 10px 28px 8px 28px;
    grid-template-columns: minmax(0, 1fr) 44px;
    column-gap: var(--s3);
    margin-bottom: 0;
    text-align: right;
  }
  .suite-b .legend-row {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px;
    column-gap: var(--s3);
    align-items: end;
  }
  .suite-b .legend-row:nth-of-type(1) { grid-row: 1; }
  .suite-b .legend-row:nth-of-type(2) { grid-row: 3; }
  .suite-b .legend-row:nth-of-type(3) { grid-row: 5; }
  .suite-b .legend-v { text-align: right; }
  .suite-b .lane { grid-column: 4 / -1; }

  .suite-b .strip-head { grid-column: 1 / 4; }
  .suite-b .detail { grid-column: 4 / -1; }
  .suite-b .action-line { grid-column: 4 / 10; min-height: 3em; }
  .suite-b .strip { grid-column: 1 / -1; }
}

/* -- entrances ----------------------------------------------------------- */

@keyframes suite-b-in {
  from { opacity: 0; transform: translate3d(0, 10px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
.suite-b .enter { animation: suite-b-in 640ms var(--e-in) both; }
.suite-b .enter--2 { animation-delay: 90ms; }
.suite-b .enter--3 { animation-delay: 180ms; }

/* Atmosphere stops; state changes still land, they simply arrive instantly. */
@media (prefers-reduced-motion: reduce) {
  .suite-b .enter { animation-duration: 1ms !important; animation-delay: 0ms !important; }
  .suite-b *, .suite-b *::before, .suite-b *::after { transition-duration: 1ms !important; }
  .suite-b .card:hover .card-plate img { transform: none; }
  .suite-b .btn:hover { transform: none; }
}

/* -- empty room ---------------------------------------------------------- */

.suite-b .empty { padding-block: var(--s8); }
.suite-b .empty h1 {
  grid-column: 1 / -1;
  margin: var(--s5) 0 0;
  font-size: var(--t-title);
  font-weight: 300;
  letter-spacing: -0.018em;
  color: var(--ink-0);
}
.suite-b .empty p { grid-column: 1 / -1; margin: var(--s4) 0 0; max-width: 46ch; font-size: var(--t-body); color: var(--ink-2); }
@media (min-width: 900px) {
  .suite-b .empty h1 { grid-column: 1 / 8; }
  .suite-b .empty p { grid-column: 1 / 7; }
}
`;

/* ==========================================================================
   Component
   ========================================================================== */

type Source = { kind: "film" } | { kind: "take"; shot: DesignShot };

export default function VariantSuite({ film }: { film: DesignFilm | null }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const palette = useMemo(() => pickPalette(film?.swatches ?? []), [film]);
  const roomStyle = {
    "--accent": palette.accent,
    "--accent-2": palette.second,
    "--accent-text": palette.accentText,
  } as React.CSSProperties;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const rangeRef = useRef<HTMLInputElement | null>(null);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const offsetRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const secondRef = useRef(-1);
  const shotRef = useRef("");

  const [source, setSource] = useState<Source>({ kind: "film" });
  const [running, setRunning] = useState<"none" | "film" | "score">("none");
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [reelOk, setReelOk] = useState(true);
  const [selectedId, setSelectedId] = useState(film?.shots[0]?.id ?? "");
  const [queued, setQueued] = useState<string[]>([]);

  const shots = film?.shots ?? [];
  const total = film?.durationS ?? 0;
  const anchors = film?.music?.anchors ?? [];
  const events = film?.events ?? [];
  const selected = shots.find((s) => s.id === selectedId) ?? shots[0] ?? null;

  const envelope = useMemo(() => scoreEnvelope(anchors, events, total), [anchors, events, total]);
  const fit = useMemo(() => cutFit(shots, anchors), [shots, anchors]);

  /** One paint of the playhead, the clock and the scrub position. */
  const paint = useCallback(() => {
    const el = running === "score" ? audioRef.current : videoRef.current;
    const raw = el ? offsetRef.current + el.currentTime : 0;
    const t = total > 0 ? Math.min(Math.max(raw, 0), total) : 0;
    const p = total > 0 ? t / total : 0;
    trackRef.current?.style.setProperty("--p", p.toFixed(5));
    if (rangeRef.current) rangeRef.current.value = t.toFixed(2);
    const sec = Math.floor(t);
    if (sec !== secondRef.current) {
      secondRef.current = sec;
      if (clockRef.current) clockRef.current.textContent = timecode(t);
      rangeRef.current?.setAttribute("aria-valuetext", timecode(t) + " of " + timecode(total));
    }
    if (running === "film" && shots.length > 0) {
      const at = shots.find((s) => t >= s.startS && t < s.endS) ?? shots[shots.length - 1];
      if (at.id !== shotRef.current) {
        shotRef.current = at.id;
        setSelectedId(at.id);
      }
    }
  }, [running, total, shots]);

  useEffect(() => {
    if (running === "none") {
      paint();
      return;
    }
    let id = window.requestAnimationFrame(function step() {
      paint();
      id = window.requestAnimationFrame(step);
    });
    return () => window.cancelAnimationFrame(id);
  }, [running, paint]);

  useEffect(() => {
    shotRef.current = selectedId;
  }, [selectedId]);

  /** Move the film to a point on the timeline. The timeline is always the film. */
  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(t, 0), Math.max(total - 0.05, 0));
      offsetRef.current = 0;
      if (source.kind === "film") {
        const v = videoRef.current;
        if (v) v.currentTime = clamped;
        paint();
      } else {
        pendingRef.current = clamped;
        setSource({ kind: "film" });
      }
    },
    [source, total, paint],
  );

  const playFilm = useCallback(() => {
    audioRef.current?.pause();
    const v = videoRef.current;
    if (!v) return;
    void v.play().catch(() => setRunning("none"));
  }, []);

  const playTake = useCallback((shot: DesignShot) => {
    audioRef.current?.pause();
    offsetRef.current = shot.startS;
    pendingRef.current = 0;
    setSelectedId(shot.id);
    setSource({ kind: "take", shot });
  }, []);

  /** After a source swap the element is new, so the queued position is applied here. */
  const onMeta = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (pendingRef.current !== null) {
      v.currentTime = pendingRef.current;
      pendingRef.current = null;
    }
    v.muted = muted;
    if (source.kind === "take") void v.play().catch(() => setRunning("none"));
    paint();
  }, [source, muted, paint]);

  const toggleFilm = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (running !== "none") {
      v.pause();
      audioRef.current?.pause();
      return;
    }
    if (source.kind === "film" && !reelOk && selected?.takeUrl) {
      playTake(selected);
      return;
    }
    playFilm();
  }, [running, source, reelOk, selected, playTake, playFilm]);

  const toggleScore = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (running === "score") {
      a.pause();
      return;
    }
    videoRef.current?.pause();
    offsetRef.current = 0;
    a.currentTime = 0;
    void a.play().catch(() => setRunning("none"));
  }, [running]);

  const toggleQueue = useCallback((id: string) => {
    setQueued((q) => (q.includes(id) ? q.filter((x) => x !== id) : [...q, id]));
  }, []);

  /* ---------------------------------------------------------------- empty */

  if (!film) {
    return (
      <main className="suite-b" style={roomStyle}>
        <style href="muse-suite-b" precedence="medium">
          {CSS}
        </style>
        <div className="spine">
          <div className="grid empty">
            <p className="label slate-eyebrow">The grading suite</p>
            <h1>The room is dark.</h1>
            <p>
              Nothing has been cut yet. Add a few photographs and one sentence, and the film you
              make opens here with its score, its beats and its shots laid out around it.
            </p>
          </div>
        </div>
      </main>
    );
  }

  /* ---------------------------------------------------------------- film */

  const state = filmStatus(film.status);
  const music = film.music;
  const reviewCounts = new Map<string, number>();
  for (const s of shots) {
    const key = s.review ?? "";
    reviewCounts.set(key, (reviewCounts.get(key) ?? 0) + 1);
  }
  const laneX = (t: number) => (total > 0 ? (Math.min(Math.max(t, 0), total) / total) * LANE_W : 0);
  const binW = (LANE_W / BINS) * 0.66;
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += 10) ticks.push(t);
  const laneDesc =
    "The score runs " +
    (music?.durationS ? duration(music.durationS) : duration(film.durationS)) +
    (music?.bpm ? " at " + music.bpm + " beats per minute" : "") +
    " with " +
    anchors.length +
    " measured accents. " +
    events.length +
    " beats were planned. " +
    (fit
      ? "The film's " + fit.cuts + " cuts each land within " + fit.worst.toFixed(2) + " seconds of a measured accent."
      : "The film's cuts are drawn on the same axis.");

  const takeReady = Boolean(selected?.takeUrl);
  const videoSrc = source.kind === "film" ? film.reelUrl : source.shot.takeUrl;
  const viewLabel = source.kind === "film" ? "The film" : "Shot " + String(source.shot.number).padStart(2, "0");

  return (
    <main className="suite-b" style={roomStyle}>
      <style href="muse-suite-b" precedence="medium">
        {CSS}
      </style>

      {/* ---- slate: three shared baselines across the whole measure ---- */}
      <header className="spine">
        <div className="grid slate enter">
          <p className="label slate-eyebrow">{presetLabel(film.preset)}</p>
          <h1 className="slate-title">{film.title}</h1>
          <p className="slate-logline">{film.logline || film.brief}</p>
          <div className="slate-labels">
            <span className="label">Running</span>
            <span className="label">Shots</span>
            <span className="label">Photographs</span>
          </div>
          <div className="slate-values">
            <span>{duration(film.durationS)}</span>
            <span>{shots.length}</span>
            <span>{film.photos.length}</span>
          </div>
          <p className="slate-state">
            <span className="pip" data-hollow={state.tone === "warn" || state.tone === "neutral"} aria-hidden="true" />
            <span>{state.label}</span>
            <span className="num ink-3">{ago(film.createdAt)}</span>
          </p>
        </div>
      </header>

      {/* ---- the bay ---- */}
      <div className="spine">
        <div className="grid bay enter enter--2" data-running={running !== "none"}>
          {/* viewer */}
          <section className="zone zone--view" aria-labelledby={uid + "-view"}>
            <div className="head">
              <h2 id={uid + "-view"} className="label">
                {viewLabel}
              </h2>
              <span className="head-value">
                {source.kind === "film"
                  ? reelOk
                    ? "vertical " + duration(film.durationS)
                    : "shot by shot"
                  : purposeLabel(source.shot.purpose)}
              </span>
            </div>

            <div className="film-mat">
              <span className="bloom" aria-hidden="true" />
              <div className="film-frame">
                {film.posterUrl ? (
                  <img
                    className="poster"
                    src={film.posterUrl}
                    alt={"Poster frame from " + film.title + ": " + (film.logline || film.brief)}
                    data-hidden={started}
                    decoding="async"
                  />
                ) : null}
                <video
                  key={source.kind === "film" ? "film" : source.shot.id}
                  ref={videoRef}
                  src={videoSrc ?? undefined}
                  playsInline
                  preload="metadata"
                  aria-label={
                    source.kind === "film"
                      ? film.title + ", a " + duration(film.durationS) + " vertical film"
                      : "The take for shot " + source.shot.number + ", " + purposeLabel(source.shot.purpose)
                  }
                  onLoadedMetadata={onMeta}
                  onPlay={() => {
                    setStarted(true);
                    setRunning("film");
                  }}
                  onPause={() => setRunning("none")}
                  onEnded={() => setRunning("none")}
                  onError={() => {
                    if (source.kind === "film") setReelOk(false);
                  }}
                />
              </div>
            </div>

            <div className="transport">
              <button
                type="button"
                className="icon-btn"
                data-primary={running === "none"}
                onClick={toggleFilm}
                aria-label={running !== "none" ? "Pause" : "Play " + viewLabel.toLowerCase()}
              >
                {running !== "none" ? <PauseMark /> : <PlayMark />}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  if (videoRef.current) videoRef.current.muted = next;
                }}
                aria-pressed={muted}
                aria-label={muted ? "Turn the sound on" : "Turn the sound off"}
              >
                <SoundMark on={!muted} />
              </button>
              <span className="clock">
                <span ref={clockRef}>{timecode(0)}</span>
                <span className="of"> / {timecode(total)}</span>
              </span>
              {source.kind === "take" ? (
                <button type="button" className="btn" onClick={() => seek(source.shot.startS)}>
                  Back to the film
                </button>
              ) : null}
            </div>
          </section>

          {/* instrument rail */}
          <div className="zone zone--rail rail">
            <section className="instrument" aria-labelledby={uid + "-score"}>
              <div className="head">
                <h2 id={uid + "-score"} className="label">
                  Score
                </h2>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  onClick={toggleScore}
                  disabled={!music?.url}
                  data-on={running === "score"}
                  aria-label={running === "score" ? "Pause the score" : "Play the score on its own"}
                >
                  {running === "score" ? <PauseMark /> : <PlayMark />}
                </button>
              </div>
              <div className="tempo">
                <span className="tempo-big">
                  {music?.bpm ?? "—"}
                  <span className="tempo-unit">bpm</span>
                </span>
                <dl className="pairs">
                  <dt>Length</dt>
                  <dd>{music?.durationS ? duration(music.durationS) : "—"}</dd>
                  <dt>Accents measured</dt>
                  <dd>{anchors.length}</dd>
                  <dt>Widest gap to a cut</dt>
                  <dd>{fit ? fit.worst.toFixed(2) + "s" : "—"}</dd>
                </dl>
              </div>
            </section>

            <section className="instrument instrument--beats" aria-labelledby={uid + "-beats"}>
              <div className="head">
                <h2 id={uid + "-beats"} className="label">
                  Beats
                </h2>
                <span className="head-value">{events.length} planned</span>
              </div>
              <ul className="beats">
                {events.map((e) => (
                  <li key={e.kind + "-" + e.t}>
                    <button
                      type="button"
                      className="beat"
                      data-peak={e.intensity >= 0.95}
                      onClick={() => seek(e.t)}
                      aria-label={"Move to " + beatLabel(e.kind) + " at " + e.t.toFixed(1) + " seconds"}
                    >
                      <span className="beat-t">{e.t.toFixed(1)}</span>
                      <span className="beat-k">{beatLabel(e.kind)}</span>
                      <span className="meter" aria-hidden="true">
                        <i style={{ transform: "scaleX(" + e.intensity.toFixed(2) + ")" }} />
                      </span>
                      <span className="beat-v">{e.intensity.toFixed(2)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="instrument" aria-labelledby={uid + "-status"}>
              <div className="head">
                <h2 id={uid + "-status"} className="label">
                  Shots
                </h2>
                <span className="head-value">{shots.length} in the cut</span>
              </div>
              <dl className="pairs">
                {[...reviewCounts.entries()].map(([key, count]) => (
                  <div key={key || "none"} className="contents">
                    <dt>{key ? reviewLabel(key) : "not reviewed yet"}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
                <dt>queued for a retake</dt>
                <dd aria-live="polite">{queued.length}</dd>
              </dl>
            </section>
          </div>

          {/* left instruments: what the film was made from and how it was graded */}
          <div className="zone zone--left">
            <div className="stack">
              <section aria-labelledby={uid + "-photos"}>
                <div className="head">
                  <h2 id={uid + "-photos"} className="label">
                    Photographs
                  </h2>
                  <span className="head-value">{film.photos.length}</span>
                </div>
                {film.photos.length > 0 ? (
                  <ul className="thumbs after-head">
                    {film.photos.map((p, i) => (
                      <li key={p}>
                        <img
                          src={p}
                          alt={
                            "Photograph " +
                            (i + 1) +
                            " of " +
                            film.photos.length +
                            " that this film was made from"
                          }
                          loading="lazy"
                          decoding="async"
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="label after-head">
                    none kept
                  </p>
                )}
              </section>

              <section aria-labelledby={uid + "-palette"}>
                <div className="head">
                  <h2 id={uid + "-palette"} className="label">
                    Palette
                  </h2>
                  <span className="head-value">
                    {palette.fromFilm ? "from the film" : "neutral room"}
                  </span>
                </div>
                <ul className="chips after-head">
                  {film.swatches.map((raw) => {
                    const hex = normalise(raw) ?? raw;
                    const use =
                      hex === palette.accent ? "accent" : hex === palette.second ? "second" : null;
                    return (
                      <li key={raw}>
                        <span className="chip" style={{ background: hex }} aria-hidden="true" />
                        <span className="chip-hex">{hex}</span>
                        {use ? <span className="chip-hex chip-use">{use}</span> : null}
                      </li>
                    );
                  })}
                </ul>
                {film.paletteWords.length > 0 ? (
                  <ul className="words after-head">
                    {film.paletteWords.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <section aria-labelledby={uid + "-look"}>
                <div className="head">
                  <h2 id={uid + "-look"} className="label">
                    The look
                  </h2>
                </div>
                <div className="look after-head">
                  <div>
                    <span className="label">Medium</span>
                    <p>{film.medium}</p>
                  </div>
                  <div>
                    <span className="label">Light</span>
                    <p>{film.lighting}</p>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>

      {/* ---- signature: the score, the beats and the cuts on one axis ---- */}
      <div className="spine">
        <div className="grid lane-row enter enter--3">
          <div className="legend">
            <div className="legend-row">
              <span className="label">Score, accents measured</span>
              <span className="legend-v">{anchors.length}</span>
            </div>
            <div className="legend-row">
              <span className="label">Beats planned</span>
              <span className="legend-v">{events.length}</span>
            </div>
            <div className="legend-row">
              <span className="label">Shots and cuts</span>
              <span className="legend-v">{shots.length}</span>
            </div>
          </div>

          <div className="lane">
            <div className="lane-scroll">
              <div className="lane-plate">
                <svg
                  viewBox={"0 0 " + LANE_W + " " + LANE_H}
                  preserveAspectRatio="none"
                  role="img"
                  aria-labelledby={uid + "-lt " + uid + "-ld"}
                >
                  <title id={uid + "-lt"}>
                    The score, the planned beats and the cuts of {film.title} on one{" "}
                    {duration(film.durationS)} axis
                  </title>
                  <desc id={uid + "-ld"}>{laneDesc}</desc>

                  {selected ? (
                    <rect
                      x={laneX(selected.startS)}
                      y={0}
                      width={Math.max(laneX(selected.endS) - laneX(selected.startS), 1)}
                      height={LANE_H}
                      fill="var(--accent)"
                      opacity="0.07"
                    />
                  ) : null}

                  {/* lane one: the score's envelope, with its measured accents combed
                      along the top edge */}
                  <g fill="var(--accent)" opacity="0.3">
                    {envelope.map((v, i) => (
                      <rect
                        key={i}
                        x={((i * LANE_W) / BINS).toFixed(2)}
                        y={(29 - v * 25).toFixed(2)}
                        width={binW.toFixed(2)}
                        height={Math.max(v * 50, 0.8).toFixed(2)}
                      />
                    ))}
                  </g>
                  <line
                    x1="0"
                    y1="29"
                    x2={LANE_W}
                    y2="29"
                    stroke="var(--rule)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  <g stroke="var(--accent-2)" strokeWidth="1" opacity="0.8">
                    {anchors.map((a, i) => (
                      <line
                        key={i}
                        x1={laneX(a).toFixed(2)}
                        y1="0"
                        x2={laneX(a).toFixed(2)}
                        y2="7"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </g>

                  {/* lane two: the beats the arrangement planned, height is intensity */}
                  <g>
                    {events.map((e) => {
                      const h = 5 + e.intensity * 23;
                      return (
                        <rect
                          key={e.kind + "-" + e.t}
                          x={Math.max(laneX(e.t) - 1.5, 0).toFixed(2)}
                          y={(96 - h).toFixed(2)}
                          width="3"
                          height={h.toFixed(2)}
                          fill={e.intensity >= 0.95 ? "var(--accent)" : "var(--ink-2)"}
                          opacity={e.intensity >= 0.95 ? 1 : 0.72}
                        />
                      );
                    })}
                  </g>
                  <line
                    x1="0"
                    y1="96"
                    x2={LANE_W}
                    y2="96"
                    stroke="var(--rule)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />

                  {/* lane three: the shots, end to end */}
                  <g>
                    {shots.map((s) => {
                      const x = laneX(s.startS);
                      const w = Math.max(laneX(s.endS) - x - 2, 2);
                      const on = selected?.id === s.id;
                      return (
                        <rect
                          key={s.id}
                          x={x.toFixed(2)}
                          y="112"
                          width={w.toFixed(2)}
                          height="12"
                          fill={on ? "var(--accent)" : "var(--ink-3)"}
                          opacity={on ? 0.95 : 0.5}
                        />
                      );
                    })}
                  </g>

                  {/* the cuts, ruled through every lane so a cut can be seen sitting
                      on an accent rather than described as doing so */}
                  <g stroke="var(--accent)" strokeWidth="1" opacity="0.62">
                    {shots.slice(1).map((s) => (
                      <line
                        key={s.id}
                        x1={laneX(s.startS).toFixed(2)}
                        y1="0"
                        x2={laneX(s.startS).toFixed(2)}
                        y2={LANE_H}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </g>
                </svg>

                <div className="playtrack" ref={trackRef}>
                  <i />
                </div>

                <div className="lane-ticks" aria-hidden="true">
                  {ticks.map((t) => (
                    <span
                      key={t}
                      style={{
                        left: (total > 0 ? (t / total) * 100 : 0) + "%",
                        transform: t === total ? "translateX(-100%)" : undefined,
                      }}
                    >
                      {t}s
                    </span>
                  ))}
                </div>

                <input
                  ref={rangeRef}
                  className="lane-hit"
                  type="range"
                  min={0}
                  max={total || 1}
                  step={0.05}
                  defaultValue={0}
                  aria-label="Scrub the film"
                  onChange={(e) => seek(e.currentTarget.valueAsNumber)}
                />
              </div>
            </div>
            {fit ? (
              <p className="lane-note">
                Every cut lands within <b>{fit.worst.toFixed(2)}s</b> of a measured accent.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* ---- the shots ---- */}
      <div className="spine">
        <div className="grid strip-row">
          <div className="strip-head">
            <div className="head">
              <h2 className="label" id={uid + "-shots"}>
                Shots
              </h2>
              <span className="head-value">{noun("scene_video", shots.length)}</span>
            </div>
          </div>

          {selected ? (
            <>
              <div className="detail">
                <span className="detail-n">{String(selected.number).padStart(2, "0")}</span>
                <span className="detail-p">{purposeLabel(selected.purpose)}</span>
                <span className="detail-m">
                  {cameraLabel(selected.camera)} · enters on {transitionLabel(selected.transitionIn)}
                  {selected.review ? " · " + reviewLabel(selected.review) : ""}
                </span>
                <span className="detail-actions">
                  <button
                    type="button"
                    className="btn"
                    data-primary
                    disabled={!takeReady}
                    onClick={() => playTake(selected)}
                  >
                    <PlayMark />
                    Play this take
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-on={queued.includes(selected.id)}
                    aria-pressed={queued.includes(selected.id)}
                    onClick={() => toggleQueue(selected.id)}
                  >
                    {queued.includes(selected.id) ? "Queued for a retake" : "Retake this shot"}
                  </button>
                </span>
              </div>
              <p className="action-line">{selected.action}</p>
            </>
          ) : null}

          <div className="strip">
            {shots.length > 0 ? (
              <ol aria-labelledby={uid + "-shots"}>
                {shots.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="card"
                      aria-current={selected?.id === s.id}
                      onClick={() => {
                        setSelectedId(s.id);
                        seek(s.startS);
                      }}
                    >
                      <span className="card-top">
                        <span className="card-n">{String(s.number).padStart(2, "0")}</span>
                        <span className="card-d">{duration(s.durationS)}</span>
                      </span>
                      <span className="card-plate">
                        {s.frameUrl ? (
                          <img src={s.frameUrl} alt={"Shot " + s.number + ": " + s.action} loading="lazy" decoding="async" />
                        ) : null}
                      </span>
                      <span className="card-p">{purposeLabel(s.purpose)}</span>
                      <span className="card-meta">
                        <span className="num">
                          {s.startS.toFixed(1)}–{s.endS.toFixed(1)}
                        </span>
                        <span>{s.generated ? "painted" : "from the frame"}</span>
                        {s.review ? <span className="card-flag">{reviewLabel(s.review)}</span> : null}
                        {queued.includes(s.id) ? <span className="card-flag">retake queued</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="label">no shots cut yet</p>
            )}
          </div>
        </div>
      </div>

      {music?.url ? (
        <audio
          ref={audioRef}
          src={music.url}
          preload="none"
          onPlay={() => setRunning("score")}
          onPause={() => setRunning("none")}
          onEnded={() => setRunning("none")}
        />
      ) : null}
    </main>
  );
}
