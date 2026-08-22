"use client";

/**
 * MUSE — VARIANT C: THE PROGRAMME
 *
 * A printed cinema programme. One sheet, the plate tipped in over the masthead
 * rule, the credits set properly, and enough air to let the film be the loudest
 * thing on the page.
 *
 * ── MEASURE ─────────────────────────────────────────────────────────────────
 * ONE measure: 1280px of content, 12 columns, 24px gutters, 40px page margin
 * (24px below 760px). Every block on this page is a `.pg-row`, so everything
 * hangs off the same twelve column edges. The spine is a 7/5 split:
 *   columns 1–7   authored text, lists, credits
 *   column  8     air — never filled; this is what keeps the page asymmetric
 *   columns 9–12  plates and figure rails
 * The timing chart is the single deliberate exception: it spans 1–12, and it is
 * the only full-measure band on the sheet, which is what gives it its weight.
 *
 * ── SPACING SCALE ───────────────────────────────────────────────────────────
 * 8px base with Fibonacci multipliers — 8 / 16 / 24 / 40 / 64 / 104
 * (--s1 … --s6), plus a 4px optical unit (--s0) reserved for tips and nudges
 * where a plate has to sit against a cap-height rather than a box edge. No gap
 * in this file comes from anywhere else.
 *
 * ── BASELINES ───────────────────────────────────────────────────────────────
 * Side-by-side blocks share a baseline by construction: section rules are grid
 * children spanning 1–12, a section title and its figure rail sit in the same
 * grid row with `align-items: baseline` and identical padding above, and the
 * credits list declares its five columns once so the figure column keeps one
 * right edge on every row.
 *
 * ── TYPE ────────────────────────────────────────────────────────────────────
 * Bodoni Moda (Didone, high contrast) for display and authored prose, never
 * below 15px. Geist letterspaced uppercase for labels, 11px floor, metadata
 * only. Geist Mono with tabular figures for every number, timing and duration.
 *
 * ── CONTRAST (measured against the #EAE9E3 ground, not eyeballed) ───────────
 * ink #111310 15.3:1 · ink-2 #3A3D36 9.1:1 · ink-3 #565951 5.9:1
 * gold-ink #6E5C24 5.4:1 — the only gold permitted to carry type
 * gold #8A7433 3.7:1 — marks, meters and dots only, never type
 */

import * as React from "react";
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

/* ══════════════════════════════════════════════════════════════════════════
   The sheet's own stylesheet: scoped under `.pg` so it cannot reach a sibling
   variant, and unlayered so it wins over the app's dark base without editing
   it.
   ══════════════════════════════════════════════════════════════════════════ */

const GRAIN_TILE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='pgn' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.86' numOctaves='4' stitchTiles='stitch' seed='7'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23pgn)'/%3E%3C/svg%3E\")";

const SHEET_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..700;1,6..96,400..600&display=swap");

/* The app paints a near-black ground, a heavy vignette and a projector grain on
   the document root. A programme is printed, not projected, so those ambient
   loops are dialled almost out — addressed through :has, so this page only. */
:root:has(.pg) {
  color-scheme: light;
  --grain-opacity: 0.016;
  --vignette-strength: 0.05;
}
:root:has(.pg) ::selection { background-color: #111310; color: #eae9e3; }
:root:has(.pg) ::-webkit-scrollbar-track { background-color: #e2e1d9; }
:root:has(.pg) ::-webkit-scrollbar-thumb { background-color: #b3b2aa; border: 2px solid #e2e1d9; }
:root:has(.pg) ::-webkit-scrollbar-thumb:hover { background-color: #8f8e86; }

.pg {
  /* palette — cool newsprint grey-green, true ink black, one dull gold */
  --paper: #eae9e3;
  --paper-raise: #f1f0ea;
  --paper-sink: #e2e1d9;
  --ink: #111310;
  --ink-2: #3a3d36;
  --ink-3: #565951;
  --gold: #8a7433;
  --gold-ink: #6e5c24;
  --gold-lit: #c9ae62;
  --frame: #14150f;
  --rule-ink: rgba(17, 19, 16, 0.72);
  --rule-hair: rgba(17, 19, 16, 0.24);

  /* grid */
  --measure: 1280px;
  --gutter: 24px;
  --margin: 40px;

  /* spacing: 8px base, Fibonacci multipliers, plus a 4px optical unit */
  --s0: 4px;
  --s1: 8px;
  --s2: 16px;
  --s3: 24px;
  --s4: 40px;
  --s5: 64px;
  --s6: 104px;

  /* type */
  --serif: "Bodoni Moda", "Bodoni MT", Didot, "Playfair Display", Georgia, "Times New Roman", serif;
  --util: "Geist", "Segoe UI Variable Text", system-ui, -apple-system, sans-serif;
  --fig: "Geist Mono", "IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;

  /* motion — asymmetric curves only */
  --settle: cubic-bezier(0.22, 0.86, 0.14, 1);
  --leaf: cubic-bezier(0.34, 0.02, 0.2, 1);

  position: relative;
  isolation: isolate;
  overflow-x: clip;
  min-height: 100dvh;
  padding-bottom: var(--s6);
  background-color: var(--paper);
  color: var(--ink);
  font-family: var(--util);
  font-size: 0.9375rem;
  line-height: 1.6;
  font-synthesis-weight: none;
  -webkit-font-smoothing: antialiased;
}

/* Two ground layers, both beneath the content: a faint diagonal tint so the
   sheet is not a flat fill, and a multiplied grain so it reads as paper. The
   grain sits under the plates on purpose — the paper is grained, the prints
   tipped onto it are clean. */
.pg-ground,
.pg-grain {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
.pg-ground {
  background-image: radial-gradient(120% 90% at 8% 0%, #f2f1eb 0%, #eae9e3 46%, #e3e2da 100%);
}
.pg-grain {
  opacity: 0.07;
  mix-blend-mode: multiply;
  background-image: ${GRAIN_TILE};
  background-repeat: repeat;
}
.pg-sheet { position: relative; z-index: 1; }

/* ── the one grid ─────────────────────────────────────────────────────────── */
.pg-row {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  column-gap: var(--gutter);
  width: 100%;
  max-width: calc(var(--measure) + var(--margin) * 2);
  margin-inline: auto;
  padding-inline: var(--margin);
}
.pg-text { grid-column: 1 / 8; }
.pg-rail { grid-column: 9 / 13; }
.pg-full { grid-column: 1 / -1; }

/* Rules are structure, not decoration: they close sections and align columns. */
.pg-rule {
  grid-column: 1 / -1;
  height: 0;
  border-top: 1px solid var(--rule-ink);
}
.pg-rule--hair { border-top-color: var(--rule-hair); }

/* ── type roles ───────────────────────────────────────────────────────────── */
.pg-label {
  margin: 0;
  font-family: var(--util);
  font-size: 0.6875rem;
  font-weight: 500;
  line-height: 1.45;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.pg-label--ink { color: var(--ink); }
.pg-label--gold { color: var(--gold-ink); }
.pg-fig {
  font-family: var(--fig);
  font-size: 0.8125rem;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
  letter-spacing: 0.01em;
}
.pg-fig--sm { font-size: 0.6875rem; letter-spacing: 0.04em; }
.pg-prose {
  font-family: var(--serif);
  font-size: 0.9375rem;
  line-height: 1.62;
  color: var(--ink-2);
}
/* a figure and its unit, locked to one baseline */
.pg-figcell { display: inline-flex; align-items: baseline; gap: var(--s1); }

/* the only spacing utilities on the sheet, and all four come off the scale */
.pg-t3 { margin-top: var(--s3); }
.pg-t4 { margin-top: var(--s4); }
.pg-b4 { margin-bottom: var(--s4); }

/* a block that opens on an ink rule. Two of these side by side put their first
   labels, and every rule under them, on the same lines. */
.pg-block { border-top: 1px solid var(--rule-ink); padding-top: var(--s2); }

.pg-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.pg :focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.pg-plate__ink :focus-visible { outline-color: var(--gold-lit); }

/* ── masthead: sits in columns 1–8, its rule spans all twelve, and columns
      9–12 are left empty so the reel plate can crash through them ─────────── */
.pg-mast { padding-top: var(--s3); }
.pg-mast__brand {
  grid-column: 1 / 4;
  grid-row: 1;
  margin: 0;
  font-family: var(--util);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--ink);
}
.pg-mast__kind { grid-column: 4 / 7; grid-row: 1; margin: 0; }
.pg-mast__date { grid-column: 7 / 9; grid-row: 1; margin: 0; text-align: right; color: var(--ink-3); }
.pg-mast__rule { grid-row: 2; margin-top: var(--s2); }

/* ── head spread ──────────────────────────────────────────────────────────── */
.pg-head { padding-top: var(--s5); row-gap: var(--s3); }
.pg-head__eyebrow {
  grid-column: 1 / 8;
  grid-row: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s2);
  margin: 0;
}
.pg-head__title {
  grid-column: 1 / 8;
  grid-row: 2;
  margin: 0;
  font-family: var(--serif);
  font-optical-sizing: auto;
  font-weight: 500;
  font-size: clamp(2.75rem, 6.4vw, 5.5rem);
  line-height: 0.94;
  letter-spacing: -0.022em;
  text-wrap: balance;
  color: var(--ink);
}
.pg-head__logline {
  grid-column: 1 / 7;
  grid-row: 3;
  margin: 0;
  font-family: var(--serif);
  font-style: italic;
  font-weight: 400;
  font-size: clamp(1.25rem, 1.9vw, 1.75rem);
  line-height: 1.32;
  color: var(--ink-2);
}
.pg-head__credits { grid-column: 1 / 8; grid-row: 4; align-self: end; }

/* the tipped-in plate: offset into the right columns and pulled up so it
   overlaps the masthead rule by exactly one --s3 */
.pg-head__plate {
  grid-column: 9 / 13;
  grid-row: 1 / span 4;
  align-self: start;
  position: relative;
  z-index: 2;
  margin-top: calc((var(--s5) + var(--s3)) * -1);
}

/* ── the credits strip under the title ────────────────────────────────────── */
.pg-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: var(--gutter);
  row-gap: var(--s3);
  margin: 0;
  padding-top: var(--s2);
  border-top: 1px solid var(--rule-hair);
}
.pg-strip > div { display: flex; flex-direction: column; gap: var(--s0); }
.pg-strip dd { margin: 0; font-family: var(--serif); font-size: 1rem; line-height: 1.3; color: var(--ink); }
.pg-strip dd.pg-fig { font-family: var(--fig); font-size: 0.8125rem; }

/* ── plates ───────────────────────────────────────────────────────────────── */
.pg-plate { margin: 0; }
.pg-plate__mat {
  background-color: var(--paper-raise);
  padding: var(--s2);
  box-shadow: 0 1px 0 0 rgba(17, 19, 16, 0.18), 0 18px 34px -26px rgba(17, 19, 16, 0.55);
  transform: rotate(-0.4deg);
  transition: transform 420ms var(--settle);
}
.pg-plate__mat:hover,
.pg-plate__mat:focus-within { transform: rotate(0deg); }
/* the heavy ink surround: a light ground would swallow a moving image, so the
   film sits in ink and reads as a plate laid onto the paper */
.pg-plate__ink {
  position: relative;
  padding: 14px;
  background-color: var(--frame);
  overflow: hidden;
}
.pg-plate__film,
.pg-plate__still {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 9 / 16;
  object-fit: cover;
  background-color: #000000;
}
.pg-plate__veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background-color: rgba(20, 21, 15, 0.26);
  color: var(--paper-raise);
  cursor: pointer;
  transition: background-color 260ms var(--leaf);
}
.pg-plate__veil:hover { background-color: rgba(20, 21, 15, 0.08); }
.pg-plate__veil span {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border: 1px solid var(--gold-lit);
  border-radius: 50%;
  background-color: rgba(20, 21, 15, 0.62);
  transition: transform 340ms var(--settle);
}
.pg-plate__veil:hover span { transform: scale(1.06); }
.pg-plate__cap {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: var(--s2);
  align-items: baseline;
  margin-top: var(--s2);
}
.pg-plate__note { margin: var(--s1) 0 0; }
.pg-plate--shot .pg-plate__mat { transform: rotate(0.3deg); }
/* the one-sheet hangs off the right edge of the measure, three columns wide */
.pg-poster { grid-column: 10 / 13; }
.pg-plate--poster .pg-plate__mat { transform: rotate(0.6deg); }

/* ── media controls, set as a printed strip on the mat ────────────────────── */
.pg-controls {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  column-gap: var(--s2);
  align-items: center;
  margin-top: var(--s2);
}
.pg-play {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--ink);
  background-color: transparent;
  color: var(--ink);
  cursor: pointer;
  transition: background-color 200ms var(--leaf), color 200ms var(--leaf);
}
.pg-play:hover { background-color: var(--ink); color: var(--paper-raise); }
.pg-scrub {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 12px;
  background-color: transparent;
  cursor: pointer;
}
.pg-scrub::-webkit-slider-runnable-track { height: 1px; background-color: var(--rule-ink); }
.pg-scrub::-moz-range-track { height: 1px; background-color: var(--rule-ink); }
.pg-scrub::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 9px;
  height: 9px;
  margin-top: -4px;
  border: 0;
  background-color: var(--gold);
  transform: rotate(45deg);
}
.pg-scrub::-moz-range-thumb {
  width: 9px;
  height: 9px;
  border: 0;
  border-radius: 0;
  background-color: var(--gold);
  transform: rotate(45deg);
}
.pg-clock { color: var(--ink-2); white-space: nowrap; }
.pg-clock em { font-style: normal; color: var(--ink-3); padding-inline: var(--s0); }

/* ── section heads ────────────────────────────────────────────────────────── */
.pg-sec { padding-top: var(--s6); }
.pg-sec__rule { grid-row: 1; }
.pg-sec__title {
  grid-column: 1 / 8;
  grid-row: 2;
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  margin: 0;
  padding-top: var(--s2);
}
.pg-sec__num {
  font-family: var(--fig);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.16em;
  color: var(--gold-ink);
}
.pg-sec__name {
  font-family: var(--serif);
  font-weight: 500;
  font-size: clamp(1.5rem, 2.4vw, 2rem);
  line-height: 1.05;
  letter-spacing: -0.012em;
  color: var(--ink);
}
.pg-sec__figs {
  grid-column: 9 / 13;
  grid-row: 2;
  display: flex;
  flex-wrap: wrap;
  gap: var(--s3);
  margin: 0;
  padding-top: var(--s2);
  color: var(--ink-2);
}
.pg-sec__body { padding-top: var(--s4); row-gap: var(--s4); }

/* ══════════════════════════════════════════════════════════════════════════
   SIGNATURE — the shot list set as a printed credits block. The five columns
   are declared once, so the leader dots fill whatever space is left and the
   figure column keeps a single right edge down the whole list.
   ══════════════════════════════════════════════════════════════════════════ */
.pg-credits { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule-ink); }
.pg-credit {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 24px;
  column-gap: var(--s2);
  align-items: start;
  border-bottom: 1px solid var(--rule-hair);
}
.pg-credit__body {
  display: grid;
  grid-template-columns: 40px 3.5ch minmax(0, max-content) minmax(24px, 1fr) 5.5ch;
  column-gap: var(--s2);
  row-gap: var(--s0);
  align-items: baseline;
  width: 100%;
  padding: var(--s1) 0;
  border: 0;
  background-color: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 220ms var(--leaf);
}
.pg-credit__body:hover { background-color: rgba(17, 19, 16, 0.045); }
.pg-credit[data-on="true"] .pg-credit__body { background-color: rgba(17, 19, 16, 0.07); }
/* the frame, tipped in beside its entry — optically aligned to the cap-height
   of the role rather than to the row box */
.pg-credit__plate {
  grid-column: 1;
  grid-row: 1 / 3;
  align-self: start;
  margin-top: var(--s0);
  padding: 3px;
  background-color: var(--paper-raise);
  box-shadow: 0 1px 0 0 rgba(17, 19, 16, 0.2);
  transform: rotate(var(--tip, -1deg));
  transition: transform 320ms var(--settle);
}
.pg-credit__body:hover .pg-credit__plate,
.pg-credit[data-on="true"] .pg-credit__plate { transform: rotate(0deg) translateY(-2px); }
.pg-credit__plate img,
.pg-credit__plate span {
  display: block;
  width: 100%;
  aspect-ratio: 9 / 16;
  object-fit: cover;
  background-color: var(--frame);
}
.pg-credit__n { grid-column: 2; grid-row: 1; color: var(--ink-3); }
.pg-credit__role {
  grid-column: 3;
  grid-row: 1;
  font-family: var(--serif);
  font-weight: 500;
  font-size: 1.0625rem;
  line-height: 1.4;
  color: var(--ink);
}
.pg-credit__fig { grid-column: 5; grid-row: 1; text-align: right; color: var(--ink); }
.pg-credit__meta { grid-column: 3 / 6; grid-row: 2; margin: 0; }
.pg-credit__meta b { font-weight: 600; color: var(--gold-ink); }

/* real leader dots: a repeating radial-gradient dot that fills the column and
   is dropped onto the baseline of the 17px serif beside it */
.pg-lead {
  grid-column: 4;
  grid-row: 1;
  align-self: end;
  height: 2px;
  margin-bottom: 0.38em;
  background-image: radial-gradient(circle at 1px 1px, var(--ink-3) 1px, transparent 1.15px);
  background-size: 6px 2px;
  background-repeat: repeat-x;
}

.pg-mark {
  grid-column: 2;
  align-self: start;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-top: calc(var(--s2) + var(--s0));
  border: 1px solid var(--rule-ink);
  background-color: transparent;
  cursor: pointer;
  transition: border-color 200ms var(--leaf), background-color 200ms var(--leaf);
}
.pg-mark:hover { border-color: var(--ink); background-color: rgba(138, 116, 51, 0.14); }
.pg-mark i {
  display: block;
  width: 8px;
  height: 8px;
  background-color: transparent;
  transform: rotate(45deg) scale(0.4);
  transition: transform 260ms var(--settle), background-color 260ms var(--leaf);
}
.pg-mark[aria-pressed="true"] { border-color: var(--gold-ink); }
.pg-mark[aria-pressed="true"] i { background-color: var(--gold); transform: rotate(45deg) scale(1); }

/* the column foot: the same five columns, so the total lands under the figures */
.pg-total {
  display: grid;
  grid-template-columns: 40px 3.5ch minmax(0, max-content) minmax(24px, 1fr) 5.5ch;
  column-gap: var(--s2);
  align-items: baseline;
  margin: 0;
  padding: var(--s2) 0 0;
  border-top: 1px solid var(--rule-ink);
}
.pg-total__role { grid-column: 3; font-family: var(--serif); font-size: 1.0625rem; font-weight: 500; }
.pg-total__lead { grid-column: 4; }
.pg-total__fig { grid-column: 5; text-align: right; }

/* ── the programme note: two-column setting for the longer text ──────────── */
.pg-note__lead {
  margin: 0 0 var(--s3);
  font-family: var(--serif);
  font-style: italic;
  font-size: 1.0625rem;
  line-height: 1.45;
  color: var(--ink);
}
.pg-note__body { margin: 0; }
.pg-note__body--two {
  columns: 2;
  column-gap: var(--s3);
  column-rule: 1px solid var(--rule-hair);
}
.pg-note__body sup {
  font-family: var(--fig);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  color: var(--gold-ink);
  padding-right: var(--s0);
  vertical-align: 0.34em;
}
.pg-facts { margin: 0; }
.pg-facts > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--s0);
  padding: var(--s2) 0;
  border-top: 1px solid var(--rule-hair);
}
.pg-facts > div:first-child { border-top: 1px solid var(--rule-ink); }
.pg-facts dd { margin: 0; font-size: 0.875rem; line-height: 1.5; color: var(--ink-2); }
.pg-swatches { display: flex; flex-wrap: wrap; gap: var(--s1); margin-top: var(--s1); }
.pg-swatches i { display: block; width: 14px; height: 14px; box-shadow: inset 0 0 0 1px rgba(17, 19, 16, 0.55); }

/* ── the timing chart: the one full-measure band ─────────────────────────── */
.pg-chart__scroll { overflow-x: auto; overscroll-behavior-x: contain; }
.pg-chart { min-width: 660px; }
.pg-chart__events { position: relative; height: 56px; }
.pg-chart__event {
  position: absolute;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background-color: var(--gold);
}
.pg-chart__peak {
  position: absolute;
  bottom: calc(100% + var(--s0));
  transform: translateX(-50%);
  white-space: nowrap;
  color: var(--gold-ink);
}
.pg-chart__bands { display: flex; border-block: 1px solid var(--rule-ink); }
.pg-band {
  display: block;
  padding: var(--s1) 0 var(--s1) var(--s1);
  border: 0;
  border-right: 1px solid var(--rule-hair);
  background-color: transparent;
  color: var(--ink-3);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background-color 240ms var(--leaf), color 240ms var(--leaf);
}
.pg-band:last-child { border-right: 0; }
.pg-band:hover { background-color: rgba(17, 19, 16, 0.06); color: var(--ink); }
.pg-band[data-on="true"] { background-color: var(--frame); color: var(--paper-raise); }
.pg-ruler { position: relative; height: 28px; }
.pg-ruler__tick { position: absolute; top: 0; width: 1px; height: var(--s1); margin-left: -1px; background-color: var(--rule-ink); }
.pg-ruler__num { position: absolute; top: calc(var(--s1) + var(--s0)); color: var(--ink-3); }
.pg-anchors { position: relative; height: var(--s2); }
.pg-anchors i { position: absolute; top: 0; width: 1px; height: var(--s1); margin-left: -1px; background-color: var(--gold); }

/* ── cue list, the credits idiom at a smaller size ───────────────────────── */
.pg-cues { list-style: none; margin: var(--s2) 0 0; padding: 0; border-top: 1px solid var(--rule-ink); }
.pg-cue {
  display: grid;
  grid-template-columns: 3.5ch minmax(0, max-content) 34px minmax(16px, 1fr) 6.5ch;
  column-gap: var(--s2);
  align-items: baseline;
  padding: var(--s1) 0;
  border-bottom: 1px solid var(--rule-hair);
}
.pg-cue__n { color: var(--ink-3); }
.pg-cue__kind { font-family: var(--serif); font-size: 1rem; font-weight: 500; color: var(--ink); }
.pg-cue__fig { text-align: right; color: var(--ink); }
.pg-swell { display: flex; gap: 2px; align-self: center; }
.pg-swell i { display: block; width: 4px; height: 10px; box-shadow: inset 0 0 0 1px rgba(17, 19, 16, 0.45); }
.pg-swell i[data-fill="true"] { background-color: var(--gold); }

/* ── the score panel ─────────────────────────────────────────────────────── */
.pg-score { min-width: 0; }
.pg-score__bpm { display: flex; align-items: baseline; gap: var(--s2); margin: var(--s2) 0 0; }
.pg-score__n {
  font-family: var(--fig);
  font-variant-numeric: tabular-nums;
  font-size: 2.5rem;
  line-height: 1;
  letter-spacing: -0.03em;
  color: var(--ink);
}

/* ── photographs, tipped in ──────────────────────────────────────────────── */
.pg-photos__scroll { overflow-x: auto; overscroll-behavior-x: contain; padding-bottom: var(--s1); }
.pg-photos { display: flex; gap: var(--s3); margin: 0; padding: 0; list-style: none; }
.pg-photo { flex: 0 0 auto; width: 148px; }
.pg-photo__mat {
  padding: var(--s1);
  background-color: var(--paper-raise);
  box-shadow: 0 1px 0 0 rgba(17, 19, 16, 0.18), 0 14px 24px -20px rgba(17, 19, 16, 0.5);
  transform: rotate(var(--tip, -1deg));
  transition: transform 380ms var(--settle);
}
.pg-photo:hover .pg-photo__mat { transform: rotate(0deg) translateY(-3px); }
.pg-photo__mat img { display: block; width: 100%; aspect-ratio: 3 / 4; object-fit: cover; background-color: var(--paper-sink); }
.pg-photo__cap { display: flex; align-items: baseline; gap: var(--s1); margin-top: var(--s1); }

/* ── colophon ────────────────────────────────────────────────────────────── */
.pg-colophon { padding-top: var(--s6); row-gap: var(--s4); }
.pg-slip { border: 1px solid var(--ink); padding: var(--s3); background-color: var(--paper-raise); }
.pg-slip__head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s2); margin-bottom: var(--s2); }
.pg-slip__list { list-style: none; margin: 0; padding: 0; }
.pg-slip__row { display: grid; grid-template-columns: 3.5ch minmax(0, max-content) minmax(16px, 1fr) 5.5ch; column-gap: var(--s2); align-items: baseline; padding: var(--s0) 0; }
.pg-slip__role { font-family: var(--serif); font-size: 1rem; font-weight: 500; }
.pg-slip__fig { text-align: right; }
/* the slip is set in four columns, so its leader runs in the third */
.pg-slip__row .pg-lead { grid-column: 3; }
.pg-slip__foot { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s3); margin-top: var(--s3); padding-top: var(--s2); border-top: 1px solid var(--rule-hair); }
.pg-clear {
  border: 0;
  padding: 0;
  background: transparent;
  font-family: var(--util);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 4px;
  cursor: pointer;
  transition: color 200ms var(--leaf);
}
.pg-clear:hover { color: var(--gold-ink); }
.pg-imprint { margin: 0; }
.pg-imprint > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: var(--s2);
  align-items: baseline;
  padding: var(--s1) 0;
  border-top: 1px solid var(--rule-hair);
}
.pg-imprint > div:first-child { border-top: 1px solid var(--rule-ink); }
.pg-imprint dd { margin: 0; text-align: right; color: var(--ink); }

/* ── the empty sheet ─────────────────────────────────────────────────────── */
.pg-empty { padding-top: var(--s6); row-gap: var(--s3); }
.pg-empty__title {
  grid-column: 1 / 8;
  margin: 0;
  font-family: var(--serif);
  font-weight: 500;
  font-size: clamp(2rem, 4.4vw, 3.5rem);
  line-height: 1;
  letter-spacing: -0.02em;
}
.pg-empty__body { grid-column: 1 / 6; margin: 0; }

/* one-shot entrance: the sheet arrives, it does not animate forever */
.pg-fall { animation: pg-fall 620ms var(--settle) both; }
@keyframes pg-fall {
  from { opacity: 0; transform: translate3d(0, 12px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}

/* ── responsive: one measure, fewer columns ──────────────────────────────── */
@media (max-width: 1080px) {
  .pg-sec__figs { grid-column: 1 / 8; grid-row: 3; padding-top: var(--s2); }
  .pg-head__plate { grid-column: 8 / 13; }
}
@media (max-width: 860px) {
  .pg { --margin: 24px; }
  .pg-head__plate {
    grid-column: 1 / 13;
    grid-row: 3;
    margin-top: 0;
    max-width: 22rem;
  }
  .pg-head__logline { grid-column: 1 / 13; grid-row: 4; }
  .pg-head__credits { grid-column: 1 / 13; grid-row: 5; }
  .pg-head__eyebrow,
  .pg-head__title { grid-column: 1 / 13; }
  .pg-text,
  .pg-rail,
  .pg-poster { grid-column: 1 / 13; }
  .pg-poster .pg-plate__mat { max-width: 17rem; }
  .pg-mast__brand { grid-column: 1 / 6; }
  .pg-mast__kind { grid-column: 6 / 10; }
  .pg-mast__date { grid-column: 10 / 13; }
  .pg-sec__title,
  .pg-sec__figs { grid-column: 1 / 13; }
  .pg-note__body--two { columns: 1; }
  .pg-plate--sticky { position: static; }
}
@media (max-width: 560px) {
  .pg-strip { grid-template-columns: minmax(0, 1fr); }
  .pg-mast__brand { grid-column: 1 / 8; }
  .pg-mast__kind { grid-column: 1 / 8; grid-row: 2; }
  .pg-mast__date { grid-column: 8 / 13; grid-row: 1; }
  .pg-mast__rule { grid-row: 3; }
  .pg-facts > div { grid-template-columns: minmax(0, 1fr); }
  .pg-credit__body,
  .pg-total {
    grid-template-columns: 32px 3ch minmax(0, max-content) minmax(16px, 1fr) 5ch;
    column-gap: var(--s1);
  }
  .pg-credit__role,
  .pg-total__role { font-size: 1rem; }
  .pg-cue { grid-template-columns: 3ch minmax(0, max-content) 34px minmax(16px, 1fr) 6.5ch; column-gap: var(--s1); }
}
@media (min-width: 861px) {
  .pg-plate--sticky { position: sticky; top: var(--s3); align-self: start; }
}

@media (prefers-reduced-motion: reduce) {
  .pg *,
  .pg *::before,
  .pg *::after {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
  }
  .pg-plate__mat,
  .pg-credit__plate,
  .pg-photo__mat { transition: none; }
}
`;

/* ══════════════════════════════════════════════════════════════════════════
   Typesetting helpers. Every figure on the sheet passes through one of these,
   so no number is formatted twice in two different ways.
   ══════════════════════════════════════════════════════════════════════════ */

const pad2 = (n: number): string => String(Math.trunc(Math.abs(n))).padStart(2, "0");

/** A point on the timeline, m:ss. */
function timecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

/**
 * A cue point, m:ss.t. A thirty second film is cut on half seconds, so a cue
 * sheet set to whole seconds would print two different instants as one time.
 */
function stamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${pad2(whole % 60)}.${Math.floor((seconds - whole) * 10)}`;
}

/**
 * A length in the figure column, to one decimal. Whole seconds would round each
 * shot independently and the column would stop adding up to the runtime printed
 * underneath it, which in a programme is a typesetting error.
 */
function figure(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0.0s";
  return `${seconds.toFixed(1)}s`;
}

/** dd.mm.yyyy in UTC, so the server and the browser print the same sheet. */
function sheetDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** The film's own number, set in fours the way a catalogue sets one. */
function catalogueNo(id: string): string {
  const tail = (id.includes("_") ? id.slice(id.indexOf("_") + 1) : id).toUpperCase();
  return (tail.match(/.{1,4}/g) ?? [tail]).join(" ");
}

/** Sentence case for a word that arrives lowercase from the lexicon. */
function opening(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Deterministic tip angle, so a plate reads as pasted on rather than placed. */
function tipAngle(index: number): string {
  const magnitude = 0.7 + (index % 3) * 0.35;
  return `${(index % 2 === 0 ? -magnitude : magnitude).toFixed(2)}deg`;
}

/** Keep a mark's label inside the measure at either end of the band. */
function edgeShift(fraction: number): string {
  if (fraction < 0.12) return "translateX(0)";
  if (fraction > 0.88) return "translateX(-100%)";
  return "translateX(-50%)";
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI"] as const;

function tipStyle(index: number): React.CSSProperties {
  return { "--tip": tipAngle(index) } as React.CSSProperties;
}

/* ══════════════════════════════════════════════════════════════════════════
   Media: one clock and one control strip, shared by the reel, the takes and
   the score, so the three never disagree about what a player looks like.
   ══════════════════════════════════════════════════════════════════════════ */

interface Clock {
  playing: boolean;
  current: number;
  duration: number;
  toggle: () => void;
  seek: (t: number) => void;
}

function useMediaClock<T extends HTMLMediaElement>(ref: React.RefObject<T | null>): Clock {
  const [state, setState] = React.useState({ playing: false, current: 0, duration: 0 });

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      setState({
        playing: !el.paused && !el.ended,
        current: Number.isFinite(el.currentTime) ? el.currentTime : 0,
        duration: Number.isFinite(el.duration) ? el.duration : 0,
      });
    };
    const names = ["play", "pause", "ended", "timeupdate", "loadedmetadata", "durationchange", "seeked", "emptied"];
    for (const name of names) el.addEventListener(name, sync);
    sync();
    return () => {
      for (const name of names) el.removeEventListener(name, sync);
    };
  }, [ref]);

  const toggle = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      const started = el.play();
      if (started) void started.catch(() => undefined);
    } else {
      el.pause();
    }
  }, [ref]);

  const seek = React.useCallback(
    (t: number) => {
      const el = ref.current;
      if (el) el.currentTime = t;
    },
    [ref],
  );

  return { ...state, toggle, seek };
}

function PlayGlyph(): React.ReactElement {
  return (
    <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden="true" focusable="false">
      <path d="M0 0 L9 5.5 L0 11 Z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph(): React.ReactElement {
  return (
    <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="3" height="11" fill="currentColor" />
      <rect x="6" y="0" width="3" height="11" fill="currentColor" />
    </svg>
  );
}

interface ControlsProps {
  clock: Clock;
  /** The length we already know from the film, used until metadata arrives. */
  known: number;
  /** Reads inside the control labels: "Play the film", "Scrub the score". */
  subject: string;
}

function Controls({ clock, known, subject }: ControlsProps): React.ReactElement {
  const total = clock.duration > 0 ? clock.duration : known;
  const at = Math.min(clock.current, total);
  return (
    <div className="pg-controls">
      <button
        type="button"
        className="pg-play"
        onClick={clock.toggle}
        aria-label={`${clock.playing ? "Pause" : "Play"} ${subject}`}
      >
        {clock.playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>
      <input
        className="pg-scrub"
        type="range"
        min={0}
        max={Number(total.toFixed(2))}
        step={0.05}
        value={Number(at.toFixed(2))}
        onChange={(e) => clock.seek(Number(e.currentTarget.value))}
        aria-label={`Scrub ${subject}`}
        aria-valuetext={`${timecode(at)} of ${timecode(total)}`}
      />
      <p className="pg-fig pg-clock">
        {timecode(at)}
        <em>/</em>
        {timecode(total)}
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Small set pieces
   ══════════════════════════════════════════════════════════════════════════ */

function FigureCell({ value, label }: { value: string; label: string }): React.ReactElement {
  return (
    <span className="pg-figcell">
      <span className="pg-fig">{value}</span>
      <span className="pg-label">{label}</span>
    </span>
  );
}

function Masthead({ printed, since }: { printed: string | null; since: string | null }): React.ReactElement {
  return (
    <header className="pg-row pg-mast">
      <p className="pg-mast__brand">Muse</p>
      <p className="pg-mast__kind pg-label">Film lab · Programme</p>
      <p className="pg-mast__date pg-fig pg-fig--sm" suppressHydrationWarning>
        {printed ?? "—"}
        {since ? ` · ${since}` : ""}
      </p>
      <div className="pg-rule pg-mast__rule" />
    </header>
  );
}

interface SectionHeadProps {
  index: number;
  name: string;
  id: string;
  figures: React.ReactNode;
}

function SectionHead({ index, name, id, figures }: SectionHeadProps): React.ReactElement {
  return (
    <div className="pg-row">
      <div className="pg-rule pg-sec__rule" />
      <h2 className="pg-sec__title" id={id}>
        <span className="pg-sec__num">{ROMAN[index] ?? String(index + 1)}</span>
        <span className="pg-sec__name">{name}</span>
      </h2>
      <p className="pg-sec__figs">{figures}</p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   The sheet
   ══════════════════════════════════════════════════════════════════════════ */

export default function VariantProgramme({ film }: { film: DesignFilm | null }): React.ReactElement {
  return (
    <div className="pg">
      <style dangerouslySetInnerHTML={{ __html: SHEET_CSS }} />
      <div className="pg-ground" aria-hidden="true" />
      <div className="pg-grain" aria-hidden="true" />
      {film ? <Programme film={film} /> : <EmptySheet />}
    </div>
  );
}

function EmptySheet(): React.ReactElement {
  return (
    <div className="pg-sheet">
      <Masthead printed={null} since={null} />
      <main className="pg-row pg-empty">
        <h1 className="pg-empty__title">Nothing is set yet.</h1>
        <p className="pg-empty__body pg-prose">
          This sheet prints a film — its plate, its credits, its score and the photographs it came
          from. Bring a handful of photographs and one sentence, and the press has something to set.
        </p>
        <div className="pg-rule pg-t4" />
      </main>
    </div>
  );
}

function Programme({ film }: { film: DesignFilm }): React.ReactElement {
  const shots = film.shots;
  const events = film.events;
  const anchors = film.music?.anchors ?? [];

  const [selectedId, setSelectedId] = React.useState<string>(shots.length > 0 ? shots[0].id : "");
  const [marked, setMarked] = React.useState<readonly string[]>([]);

  const reelRef = React.useRef<HTMLVideoElement>(null);
  const takeRef = React.useRef<HTMLVideoElement>(null);
  const scoreRef = React.useRef<HTMLAudioElement>(null);
  const reelClock = useMediaClock(reelRef);
  const takeClock = useMediaClock(takeRef);
  const scoreClock = useMediaClock(scoreRef);

  const selected: DesignShot | null =
    shots.find((s) => s.id === selectedId) ?? (shots.length > 0 ? shots[0] : null);

  // A newly chosen take needs a fresh load, or the element keeps showing the
  // frame belonging to the shot before it.
  React.useEffect(() => {
    const el = takeRef.current;
    if (el && el.currentSrc !== "") el.load();
  }, [selectedId]);

  const toggleMark = React.useCallback((id: string) => {
    setMarked((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }, []);

  const runtime = film.durationS > 0 ? film.durationS : shots.reduce((a, s) => a + s.durationS, 0);
  const cut = shots.reduce((a, s) => a + s.durationS, 0);
  const printed = sheetDate(film.createdAt);
  const markedShots = shots.filter((s) => marked.includes(s.id));
  const note = film.brief.trim();
  const synopsis = shots.filter((s) => s.action.trim().length > 0);
  const synopsisLength = synopsis.reduce((a, s) => a + s.action.length, 0);
  const peak = events.reduce<DesignEvent | null>(
    (best, e) => (best === null || e.intensity > best.intensity ? e : best),
    null,
  );
  const ticks: number[] = [];
  for (let t = 0; t <= runtime + 0.001; t += 5) ticks.push(Math.round(t));
  const pct = (t: number): string => `${((Math.max(0, Math.min(t, runtime)) / runtime) * 100).toFixed(3)}%`;

  return (
    <div className="pg-sheet">
      <Masthead printed={printed} since={ago(film.createdAt)} />

      {/* ── the head spread: display hard left, the film tipped in on the right,
             crossing the masthead rule ─────────────────────────────────────── */}
      <main className="pg-row pg-head pg-fall">
        <p className="pg-head__eyebrow">
          <span className="pg-label pg-label--gold">{filmStatus(film.status).label}</span>
          <span className="pg-label">{presetLabel(film.preset)}</span>
          <span className="pg-fig">{duration(runtime)}</span>
        </p>

        <h1 className="pg-head__title">{film.title}</h1>

        {film.logline.trim().length > 0 ? (
          <p className="pg-head__logline">{film.logline}</p>
        ) : null}

        <figure className="pg-plate pg-head__plate">
          <div className="pg-plate__mat">
            <div className="pg-plate__ink">
              {film.reelUrl ? (
                <>
                  <video
                    ref={reelRef}
                    className="pg-plate__film"
                    src={film.reelUrl}
                    poster={film.posterUrl ?? undefined}
                    preload="metadata"
                    playsInline
                    aria-label={`${film.title}, the finished film, vertical, ${duration(runtime)}`}
                  />
                  {reelClock.playing ? null : (
                    <button
                      type="button"
                      className="pg-plate__veil"
                      onClick={reelClock.toggle}
                      aria-label={`Play ${film.title}`}
                    >
                      <span>
                        <PlayGlyph />
                      </span>
                    </button>
                  )}
                </>
              ) : film.posterUrl ? (
                <img
                  className="pg-plate__still"
                  src={film.posterUrl}
                  alt={`Poster for ${film.title}`}
                  loading="eager"
                  decoding="async"
                />
              ) : (
                <div className="pg-plate__still" />
              )}
            </div>
            {film.reelUrl ? <Controls clock={reelClock} known={runtime} subject="the film" /> : null}
          </div>
          <figcaption className="pg-plate__cap">
            <span className="pg-label pg-label--ink">
              {film.reelUrl
                ? "The film · vertical"
                : film.posterUrl
                  ? "The poster · vertical"
                  : "Not printed yet"}
            </span>
            <span className="pg-fig">{duration(runtime)}</span>
          </figcaption>
        </figure>

        <dl className="pg-head__credits pg-strip">
          <div>
            <dt className="pg-label">{opening(noun("upload_image", film.photos.length))}</dt>
            <dd className="pg-fig">{pad2(film.photos.length)}</dd>
          </div>
          <div>
            <dt className="pg-label">Shots</dt>
            <dd className="pg-fig">{pad2(shots.length)}</dd>
          </div>
          <div>
            <dt className="pg-label">Look</dt>
            <dd>{presetLabel(film.preset)}</dd>
          </div>
        </dl>
      </main>

      {/* ── the programme note ───────────────────────────────────────────────── */}
      <section className="pg-sec" aria-labelledby="pg-note-h">
        <SectionHead
          index={0}
          id="pg-note-h"
          name="The note"
          figures={
            <>
              <FigureCell value={pad2(shots.length)} label={noun("scene_video", shots.length)} />
              <FigureCell value={figure(cut)} label="cut" />
            </>
          }
        />
        <div className="pg-row pg-sec__body">
          <div className="pg-text">
            {note.length > 0 ? <p className="pg-note__lead">“{note}”</p> : null}
            {synopsis.length > 0 ? (
              <p
                className={`pg-prose pg-note__body${synopsisLength > 320 ? " pg-note__body--two" : ""}`}
              >
                {synopsis.map((s) => (
                  <React.Fragment key={s.id}>
                    <sup>{pad2(s.number)}</sup>
                    {s.action}{" "}
                  </React.Fragment>
                ))}
              </p>
            ) : null}
          </div>
          <dl className="pg-rail pg-facts">
            <div>
              <dt className="pg-label">Medium</dt>
              <dd>{film.medium}</dd>
            </div>
            <div>
              <dt className="pg-label">Light</dt>
              <dd>{film.lighting}</dd>
            </div>
            {film.paletteWords.length > 0 ? (
              <div>
                <dt className="pg-label">Palette</dt>
                <dd>
                  {film.paletteWords.join(", ")}
                  {film.swatches.length > 0 ? (
                    <span className="pg-swatches" aria-hidden="true">
                      {film.swatches.map((hex) => (
                        <i key={hex} style={{ backgroundColor: hex }} />
                      ))}
                    </span>
                  ) : null}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </section>

      {/* ── I · the shots, set as a credits block ───────────────────────────── */}
      <section className="pg-sec" aria-labelledby="pg-shots-h">
        <SectionHead
          index={1}
          id="pg-shots-h"
          name={`The ${noun("scene_video", shots.length)}`}
          figures={
            <>
              <FigureCell value={pad2(shots.length)} label="in the cut" />
              <FigureCell value={pad2(markedShots.length)} label="marked" />
            </>
          }
        />
        <div className="pg-row pg-sec__body">
          <div className="pg-text">
            {shots.length === 0 ? (
              <p className="pg-prose">No shots have been set for this film yet.</p>
            ) : null}
            {shots.length > 0 ? (
              <>
                <ol className="pg-credits">
                  {shots.map((shot, i) => {
                    const on = selected !== null && selected.id === shot.id;
                    const isMarked = marked.includes(shot.id);
                    return (
                      <li className="pg-credit" key={shot.id} data-on={on ? "true" : "false"}>
                        <button
                          type="button"
                          className="pg-credit__body"
                          onClick={() => setSelectedId(shot.id)}
                          aria-current={on ? "true" : undefined}
                        >
                          <span className="pg-credit__plate" style={tipStyle(i)}>
                            {shot.frameUrl ? (
                              <img src={shot.frameUrl} alt={shot.action} loading="lazy" decoding="async" />
                            ) : (
                              <span />
                            )}
                          </span>
                          <span className="pg-credit__n pg-fig">{pad2(shot.number)}</span>
                          <span className="pg-credit__role">{purposeLabel(shot.purpose)}</span>
                          <span className="pg-lead" aria-hidden="true" />
                          <span className="pg-credit__fig pg-fig">{figure(shot.durationS)}</span>
                          <span className="pg-credit__meta pg-label">
                            {cameraLabel(shot.camera)} · {transitionLabel(shot.transitionIn)}
                            {shot.review ? ` · ${reviewLabel(shot.review)}` : ""}
                            {isMarked ? (
                              <>
                                {" · "}
                                <b>marked for a retake</b>
                              </>
                            ) : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="pg-mark"
                          aria-pressed={isMarked}
                          aria-label={`Mark shot ${shot.number}, ${purposeLabel(shot.purpose)}, for a retake`}
                          onClick={() => toggleMark(shot.id)}
                        >
                          <i />
                        </button>
                      </li>
                    );
                  })}
                </ol>
                <p className="pg-total">
                  <span className="pg-total__role">the whole film</span>
                  <span className="pg-lead pg-total__lead" aria-hidden="true" />
                  <span className="pg-total__fig pg-fig">{figure(cut)}</span>
                </p>
              </>
            ) : null}
          </div>

          {selected !== null ? (
            <figure className="pg-plate pg-plate--shot pg-plate--sticky pg-rail">
              <div className="pg-plate__mat">
                <div className="pg-plate__ink">
                  {selected.takeUrl ? (
                    <>
                      <video
                        ref={takeRef}
                        className="pg-plate__film"
                        src={selected.takeUrl}
                        poster={selected.frameUrl ?? undefined}
                        preload="metadata"
                        playsInline
                        aria-label={`Shot ${selected.number}, ${purposeLabel(selected.purpose)}. ${selected.action}`}
                      />
                      {takeClock.playing ? null : (
                        <button
                          type="button"
                          className="pg-plate__veil"
                          onClick={takeClock.toggle}
                          aria-label={`Play shot ${selected.number}, ${purposeLabel(selected.purpose)}`}
                        >
                          <span>
                            <PlayGlyph />
                          </span>
                        </button>
                      )}
                    </>
                  ) : selected.frameUrl ? (
                    <img
                      className="pg-plate__still"
                      src={selected.frameUrl}
                      alt={selected.action}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="pg-plate__still" />
                  )}
                </div>
                {selected.takeUrl ? (
                  <Controls clock={takeClock} known={selected.durationS} subject={`shot ${selected.number}`} />
                ) : null}
              </div>
              <figcaption>
                <div className="pg-plate__cap">
                  <span className="pg-figcell">
                    <span className="pg-fig">{pad2(selected.number)}</span>
                    <span className="pg-label pg-label--ink">{purposeLabel(selected.purpose)}</span>
                  </span>
                  <span className="pg-fig">
                    {stamp(selected.startS)}–{stamp(selected.endS)}
                  </span>
                </div>
                <p className="pg-label pg-plate__note">
                  {opening(cameraLabel(selected.camera))} · enters on {transitionLabel(selected.transitionIn)}
                  {selected.takeUrl ? "" : " · no take yet"}
                </p>
              </figcaption>
            </figure>
          ) : null}
        </div>
      </section>

      {/* ── II · the score and the cuts. The one full-measure band. ─────────── */}
      <section className="pg-sec" aria-labelledby="pg-score-h">
        <SectionHead
          index={2}
          id="pg-score-h"
          name={`The ${noun("music", 1)} and the cuts`}
          figures={
            <>
              <FigureCell value={pad2(events.length)} label="cues" />
              <FigureCell value={pad2(shots.length)} label="cuts" />
            </>
          }
        />
        <div className="pg-row pg-sec__body">
          <div className="pg-full pg-chart__scroll">
            <div className="pg-chart">
              <div className="pg-chart__events">
                {events.map((e, i) => {
                  const fraction = runtime > 0 ? e.t / runtime : 0;
                  return (
                    <span
                      key={`${e.t}-${e.kind}-${i}`}
                      className="pg-chart__event"
                      style={{
                        left: pct(e.t),
                        height: `calc(var(--s1) + ${e.intensity.toFixed(2)} * var(--s4))`,
                      }}
                    >
                      {peak !== null && peak === e ? (
                        <span
                          className="pg-chart__peak pg-label pg-label--gold"
                          style={{ transform: edgeShift(fraction) }}
                        >
                          {e.kind.replace(/_/g, " ")} {stamp(e.t)}
                        </span>
                      ) : null}
                    </span>
                  );
                })}
              </div>
              <div className="pg-chart__bands">
                {shots.map((shot) => {
                  const on = selected !== null && selected.id === shot.id;
                  return (
                    <button
                      key={shot.id}
                      type="button"
                      className="pg-band"
                      data-on={on ? "true" : "false"}
                      style={{ flex: `0 0 ${((shot.durationS / (cut || runtime)) * 100).toFixed(3)}%` }}
                      aria-pressed={on}
                      onClick={() => setSelectedId(shot.id)}
                    >
                      <span className="pg-fig pg-fig--sm" aria-hidden="true">
                        {pad2(shot.number)}
                      </span>
                      <span className="pg-sr">
                        Shot {shot.number}, {purposeLabel(shot.purpose)}, {figure(shot.durationS)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="pg-ruler">
                {ticks.map((t, i) => (
                  <React.Fragment key={t}>
                    <span className="pg-ruler__tick" style={{ left: pct(t) }} />
                    <span
                      className="pg-ruler__num pg-fig pg-fig--sm"
                      style={{ left: pct(t), transform: edgeShift(runtime > 0 ? t / runtime : 0) }}
                    >
                      {i === 0 ? "0:00" : timecode(t)}
                    </span>
                  </React.Fragment>
                ))}
              </div>
              {anchors.length > 0 ? (
                <div className="pg-anchors">
                  <span className="pg-sr">{anchors.length} cuts land on the beat.</span>
                  {anchors.map((a, i) => (
                    <i key={`${a}-${i}`} style={{ left: pct(a) }} aria-hidden="true" />
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {events.length > 0 ? (
            <div className="pg-text pg-block">
              <p className="pg-label pg-label--ink">The cue sheet</p>
              <ol className="pg-cues">
                {events.map((e, i) => {
                  const steps = Math.max(1, Math.round(e.intensity * 5));
                  return (
                    <li className="pg-cue" key={`${e.t}-${e.kind}-cue-${i}`}>
                      <span className="pg-cue__n pg-fig">{pad2(i + 1)}</span>
                      <span className="pg-cue__kind">{e.kind.replace(/_/g, " ")}</span>
                      <span className="pg-swell">
                        <span className="pg-sr">swell {steps} of 5</span>
                        {[0, 1, 2, 3, 4].map((step) => (
                          <i key={step} data-fill={step < steps ? "true" : "false"} aria-hidden="true" />
                        ))}
                      </span>
                      <span className="pg-lead" aria-hidden="true" />
                      <span className="pg-cue__fig pg-fig">{stamp(e.t)}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          <div className="pg-rail pg-block pg-score">
            <p className="pg-label pg-label--ink">{opening(noun("music", 1))}</p>
            {film.music ? (
              <>
                {film.music.bpm ? (
                  <p className="pg-score__bpm">
                    <span className="pg-score__n">{film.music.bpm}</span>
                    <span className="pg-label">beats a minute</span>
                  </p>
                ) : null}
                <dl className="pg-facts pg-t3">
                  <div>
                    <dt className="pg-label">Length</dt>
                    <dd className="pg-fig">{duration(film.music.durationS ?? runtime)}</dd>
                  </div>
                  <div>
                    <dt className="pg-label">Cuts on the beat</dt>
                    <dd className="pg-fig">{anchors.length > 0 ? pad2(anchors.length) : "—"}</dd>
                  </div>
                </dl>
                {film.music.url ? (
                  <>
                    <audio ref={scoreRef} src={film.music.url} preload="metadata" />
                    <Controls
                      clock={scoreClock}
                      known={film.music.durationS ?? runtime}
                      subject="the score"
                    />
                  </>
                ) : null}
              </>
            ) : (
              <p className="pg-prose">No score has been written for this film yet.</p>
            )}
          </div>
        </div>
      </section>

      {/* ── III · the photographs it came from, and the one-sheet ───────────── */}
      <section className="pg-sec" aria-labelledby="pg-photos-h">
        <SectionHead
          index={3}
          id="pg-photos-h"
          name={`The ${noun("upload_image", film.photos.length)}`}
          figures={<FigureCell value={pad2(film.photos.length)} label="tipped in" />}
        />
        <div className="pg-row pg-sec__body">
          <div className="pg-text">
            {film.photos.length > 0 ? (
              <div className="pg-photos__scroll">
                <ul className="pg-photos">
                  {film.photos.map((src, i) => (
                    <li className="pg-photo" key={src}>
                      <div className="pg-photo__mat" style={tipStyle(i)}>
                        <img
                          src={src}
                          alt={`Photograph ${i + 1} of ${film.photos.length} that ${film.title} was made from`}
                          loading="lazy"
                          decoding="async"
                        />
                      </div>
                      <p className="pg-photo__cap">
                        <span className="pg-fig pg-fig--sm">{pad2(i + 1)}</span>
                        <span className="pg-label">{noun("upload_image", 1)}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="pg-prose">No photographs were kept with this film.</p>
            )}
          </div>

          {film.posterUrl ? (
            <figure className="pg-plate pg-plate--poster pg-poster">
              <div className="pg-plate__mat">
                <div className="pg-plate__ink">
                  <img
                    className="pg-plate__still"
                    src={film.posterUrl}
                    alt={`The poster for ${film.title}`}
                    loading="lazy"
                    decoding="async"
                  />
                </div>
              </div>
              <figcaption className="pg-plate__cap">
                <span className="pg-label pg-label--ink">{opening(noun("poster", 1))}</span>
                <span className="pg-fig">9:16</span>
              </figcaption>
            </figure>
          ) : null}
        </div>
      </section>

      {/* ── the colophon, and the one decision this page asks for ───────────── */}
      <footer className="pg-row pg-colophon">
        <div className="pg-rule pg-b4" />
        <div className="pg-text" aria-live="polite">
          {markedShots.length > 0 ? (
            <div className="pg-slip">
              <div className="pg-slip__head">
                <span className="pg-label pg-label--ink">Retake slip</span>
                <FigureCell value={pad2(markedShots.length)} label={noun("scene_video", markedShots.length)} />
              </div>
              <ol className="pg-slip__list">
                {markedShots.map((shot) => (
                  <li className="pg-slip__row" key={shot.id}>
                    <span className="pg-fig">{pad2(shot.number)}</span>
                    <span className="pg-slip__role">{purposeLabel(shot.purpose)}</span>
                    <span className="pg-lead" aria-hidden="true" />
                    <span className="pg-slip__fig pg-fig">{figure(shot.durationS)}</span>
                  </li>
                ))}
              </ol>
              <div className="pg-slip__foot">
                <span className="pg-prose">Set aside to be painted again.</span>
                <button type="button" className="pg-clear" onClick={() => setMarked([])}>
                  Tear up the slip
                </button>
              </div>
            </div>
          ) : (
            <p className="pg-prose">
              Nothing is marked. The square beside a shot sets it aside for a retake, and a slip is
              drawn up here.
            </p>
          )}
        </div>
        <dl className="pg-rail pg-imprint">
          <div>
            <dt className="pg-label">Catalogue</dt>
            <dd className="pg-fig">{catalogueNo(film.id)}</dd>
          </div>
          <div>
            <dt className="pg-label">Runtime</dt>
            <dd className="pg-fig">{duration(runtime)}</dd>
          </div>
          <div>
            <dt className="pg-label">State</dt>
            <dd>{filmStatus(film.status).label}</dd>
          </div>
          <div>
            <dt className="pg-label">Printed</dt>
            <dd className="pg-fig">{printed ?? "—"}</dd>
          </div>
        </dl>
      </footer>
    </div>
  );
}
