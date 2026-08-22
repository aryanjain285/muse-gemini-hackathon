"use client";

/**
 * The film timeline: the one object in MUSE that shows music and picture on the
 * same axis, which is the whole claim the product makes.
 *
 * Four lanes share a single time base. A ruler carries the seconds and the
 * musical anchors the composer actually cut on. A marker lane shows the planned
 * events, drawn at a height proportional to intensity so the shape of the
 * arrangement is legible at a glance. A scene lane shows the picture, one block
 * per scene, coloured by render status. A waveform lane shows the measured
 * energy of the real audio underneath it all.
 *
 * The ruler and marker lanes together are the scrub surface: a single ARIA
 * slider, so a keyboard user moves the playhead with the arrow keys and jumps
 * between anchors with the bracket keys. Scene blocks are separate buttons,
 * matching an editor where clicking a clip selects it and clicking the ruler
 * moves the playhead.
 *
 * Ruler, markers and waveform are SVG at device pixel scale rather than DOM
 * boxes, because a hairline tick has to survive being thrown at a projector.
 */

import * as React from "react";
import { cx, Icon, pct, useDomId, type IconName } from "@/components/ui/primitives";

// ── contracts ────────────────────────────────────────────────────────────────

/** Per-scene render state, as reported by the pipeline. */
export type SceneStatus = "pending" | "running" | "done" | "fallback" | "failed";

/** One scene block on the timeline. */
export interface TimelineScene {
  id: string;
  startS: number;
  endS: number;
  /** Narrative role, shown under the label when there is room. */
  purpose: string;
  status: SceneStatus;
  label: string;
}

/** A planned musical event, drawn as a marker whose height is its intensity. */
export interface TimelineEventMark {
  t: number;
  kind: string;
  /** 0..1. */
  intensity: number;
}

/** One sample of the measured energy envelope. */
export interface TimelineEnergy {
  t: number;
  /** 0..1. */
  v: number;
}

// ── status vocabulary ────────────────────────────────────────────────────────

interface StatusStyle {
  /** The word shown to the user. Colour is never the only signal. */
  word: string;
  rail: string;
  edge: string;
  text: string;
  icon: IconName;
}

const STATUS: Record<SceneStatus, StatusStyle> = {
  pending: { word: "Queued", rail: "bg-signal-idle", edge: "border-hairline", text: "text-paper-400", icon: "frame" },
  running: { word: "Rendering", rail: "bg-signal-live", edge: "border-hairline-ember", text: "text-ember-200", icon: "waveform" },
  done: { word: "Ready", rail: "bg-signal-ok", edge: "border-signal-ok/40", text: "text-paper-100", icon: "check" },
  fallback: { word: "Local", rail: "bg-signal-local", edge: "border-signal-local/40", text: "text-paper-100", icon: "wand" },
  failed: { word: "Failed", rail: "bg-signal-fail", edge: "border-signal-fail/50", text: "text-signal-fail", icon: "alert" },
};

/** The marker cap tells the kind apart; the colour only reinforces it. */
type MarkerShape = "diamond" | "disc" | "chevron" | "ring";

function markerShape(kind: string): MarkerShape {
  if (kind === "drop" || kind === "final_hit") return "diamond";
  if (kind === "accent") return "disc";
  if (kind === "build") return "chevron";
  return "ring";
}

function markerColor(kind: string): string {
  if (kind === "drop" || kind === "final_hit") return "var(--color-ember-300)";
  if (kind === "accent" || kind === "build") return "var(--color-ember-400)";
  return "var(--color-paper-300)";
}

// ── geometry helpers ─────────────────────────────────────────────────────────

const RULER_H = 30;
const MARKER_H = 34;
const WAVE_H = 36;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fixed to 2dp so the same inputs always emit the same path string. */
const fx = (v: number) => v.toFixed(2);

/**
 * Choose the labelled tick interval so labels never collide: the first
 * candidate that gives each label at least 46px of room wins. Exported so a
 * secondary readout of the same reel can share one tick vocabulary.
 */
export function pickTickStep(durationS: number, width: number): number {
  const perSecond = durationS > 0 ? width / durationS : 0;
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60]) {
    if (perSecond * step >= 46) return step;
  }
  return 60;
}

function fmtTick(t: number, step: number): string {
  return step < 1 ? t.toFixed(1) : String(Math.round(t));
}

/**
 * Mirrored area path for the energy envelope, in SVG user units.
 *
 * An RMS envelope arrives at whatever hop the analyser used, which for a 30s
 * reel is normally more samples than the lane has pixels. Drawing all of them
 * produces a muddy blob and a path with a thousand nodes, so a denser envelope
 * is reduced to the peak within each `bucketPx` column - the same peak-picking
 * an audio editor does, and the reason transients stay visible after the
 * reduction. A sparser envelope is drawn sample for sample instead, because
 * bucketing it would only introduce stair-steps.
 */
export function waveformPath(
  energy: TimelineEnergy[],
  durationS: number,
  width: number,
  height: number,
  bucketPx = 2,
): string {
  if (energy.length === 0 || durationS <= 0 || width <= 0) return "";
  const mid = height / 2;
  const half = height / 2 - 7;

  const buckets = Math.max(1, Math.floor(width / Math.max(1, bucketPx)));
  let xs: number[];
  let vs: number[];

  if (energy.length >= buckets) {
    const peaks = new Array<number>(buckets).fill(0);
    for (const e of energy) {
      const at = clampTo(e.t, 0, durationS) / durationS;
      const i = Math.min(buckets - 1, Math.floor(at * buckets));
      const v = clamp01(e.v);
      if (v > peaks[i]) peaks[i] = v;
    }
    xs = peaks.map((_, i) => ((i + 0.5) / buckets) * width);
    vs = peaks;
  } else {
    xs = energy.map((e) => (clampTo(e.t, 0, durationS) / durationS) * width);
    vs = energy.map((e) => clamp01(e.v));
  }

  let up = "";
  for (let i = 0; i < xs.length; i++) {
    up += `${i === 0 ? "M" : "L"}${fx(xs[i])} ${fx(mid - vs[i] * half)}`;
  }
  let down = "";
  for (let i = xs.length - 1; i >= 0; i--) {
    down += `L${fx(xs[i])} ${fx(mid + vs[i] * half)}`;
  }
  return `${up}${down}Z`;
}

/** Container width in CSS pixels, tracked so the SVG lanes stay at 1:1 scale. */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(Math.round(entry.contentRect.width));
      }
    });
    observer.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

// ── timeline ─────────────────────────────────────────────────────────────────

export interface TimelineProps {
  durationS: number;
  scenes: TimelineScene[];
  events: TimelineEventMark[];
  /** Measured audio energy. Omit before the score exists and the lane is hidden. */
  energy?: TimelineEnergy[];
  playheadS: number;
  /** Reconciled musical anchors. Drawn in the accent because cuts land on them. */
  anchors: number[];
  onScrub?: (s: number) => void;
  onSelectScene?: (id: string) => void;
  selectedSceneId?: string;
  /**
   * Width assumed before the first measurement lands. Supplying the real
   * container width keeps a server-rendered timeline from snapping on hydration.
   */
  initialWidth?: number;
  className?: string;
}

/**
 * The full timeline. Responsive from 380px up: the tick interval, the scene
 * block detail and the marker density all follow the measured width.
 */
export function Timeline({
  durationS,
  scenes,
  events,
  energy,
  playheadS,
  anchors,
  onScrub,
  onSelectScene,
  selectedSceneId,
  initialWidth = 720,
  className,
}: TimelineProps) {
  const [hostRef, measured] = useMeasuredWidth();
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const duration = durationS > 0 ? durationS : 1;
  // A sane first paint before the ResizeObserver reports; the wrapper clips.
  const width = measured > 0 ? measured : Math.max(120, Math.round(initialWidth));
  const compact = width < 480;
  const sceneH = compact ? 46 : 60;
  const waveId = useDomId("muse-wave");

  const head = clampTo(playheadS, 0, duration);
  const headFraction = head / duration;

  const emit = (t: number) => {
    if (onScrub) onScrub(Number(clampTo(t, 0, duration).toFixed(3)));
  };

  const scrubFrom = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    emit(((clientX - rect.left) / rect.width) * duration);
  };

  const jumpAnchor = (direction: 1 | -1) => {
    const sorted = [...anchors].sort((a, b) => a - b);
    const next =
      direction === 1
        ? sorted.find((a) => a > head + 0.01)
        : [...sorted].reverse().find((a) => a < head - 0.01);
    emit(next ?? (direction === 1 ? duration : 0));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const coarse = e.shiftKey ? 1 : 0.25;
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        emit(head + coarse);
        return;
      case "ArrowLeft":
        e.preventDefault();
        emit(head - coarse);
        return;
      case "PageUp":
        e.preventDefault();
        emit(head + 5);
        return;
      case "PageDown":
        e.preventDefault();
        emit(head - 5);
        return;
      case "Home":
        e.preventDefault();
        emit(0);
        return;
      case "End":
        e.preventDefault();
        emit(duration);
        return;
      case "]":
        e.preventDefault();
        jumpAnchor(1);
        return;
      case "[":
        e.preventDefault();
        jumpAnchor(-1);
        return;
      default:
        return;
    }
  };

  const tickStep = pickTickStep(duration, width);
  const minorStep = (width / duration) * 1 >= 7 ? 1 : tickStep;

  const majorTicks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += tickStep) majorTicks.push(Number(t.toFixed(3)));
  const minorTicks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += minorStep) {
    const v = Number(t.toFixed(3));
    if (!majorTicks.includes(v)) minorTicks.push(v);
  }

  const laneH = RULER_H + MARKER_H;
  // Caps are inset from the edges so a marker at 0s or at the final second is
  // not sliced in half by the lane's own clip.
  const xOf = (t: number) => clampTo((clampTo(t, 0, duration) / duration) * width, 4.5, width - 4.5);

  return (
    <div
      ref={hostRef}
      className={cx(
        "relative overflow-hidden rounded-shell border border-hairline bg-ink-900 p-bezel",
        className,
      )}
    >
      <div className="relative overflow-hidden rounded-core bg-ink-850 shadow-core">
        {/* Scrub surface: ruler over markers, one slider. */}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Playhead position"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Number(duration.toFixed(2))}
          aria-valuenow={Number(head.toFixed(2))}
          aria-valuetext={`${head.toFixed(2)} of ${duration.toFixed(2)} seconds`}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            scrubFrom(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging) scrubFrom(e.clientX);
          }}
          onPointerUp={(e) => {
            setDragging(false);
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          }}
          onPointerCancel={() => setDragging(false)}
          className={cx(
            "relative touch-none border-b border-hairline bg-ink-900",
            onScrub ? "cursor-ew-resize" : "cursor-default",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ember-300",
          )}
        >
          <svg
            width={width}
            height={laneH}
            viewBox={`0 0 ${width} ${laneH}`}
            className="block"
            aria-hidden="true"
          >
            {/* minor seconds */}
            {minorTicks.map((t) => (
              <line
                key={`m${t}`}
                x1={fx(xOf(t))}
                x2={fx(xOf(t))}
                y1={RULER_H - 4}
                y2={RULER_H}
                stroke="var(--color-ink-600)"
                strokeWidth={1}
              />
            ))}

            {/* labelled seconds */}
            {majorTicks.map((t) => (
              <g key={`M${t}`}>
                <line
                  x1={fx(xOf(t))}
                  x2={fx(xOf(t))}
                  y1={RULER_H - 9}
                  y2={RULER_H}
                  stroke="var(--color-ink-500)"
                  strokeWidth={1}
                />
                <text
                  x={fx(xOf(t))}
                  y={RULER_H - 13}
                  textAnchor={t === 0 ? "start" : t >= duration - 1e-6 ? "end" : "middle"}
                  fontSize={9}
                  letterSpacing="0.08em"
                  fill="var(--color-paper-400)"
                  className="font-mono"
                >
                  {fmtTick(t, tickStep)}
                </text>
              </g>
            ))}

            <line
              x1={0}
              x2={width}
              y1={RULER_H}
              y2={RULER_H}
              stroke="var(--color-hairline)"
              strokeWidth={1}
            />

            {/* Anchors: the moments the composer is allowed to cut on. */}
            {anchors.map((t, i) => (
              <g key={`a${i}-${t}`}>
                <line
                  x1={fx(xOf(t))}
                  x2={fx(xOf(t))}
                  y1={0}
                  y2={laneH}
                  stroke="var(--color-hairline-ember)"
                  strokeWidth={1}
                />
                <path
                  d={`M${fx(xOf(t) - 3.5)} ${RULER_H + 4}L${fx(xOf(t))} ${RULER_H - 1}L${fx(xOf(t) + 3.5)} ${RULER_H + 4}Z`}
                  fill="var(--color-ember-400)"
                />
              </g>
            ))}

            {/* Planned events. Stem height is intensity. */}
            {events.map((e, i) => {
              const x = xOf(e.t);
              const base = laneH - 1;
              const h = 7 + clamp01(e.intensity) * (MARKER_H - 13);
              const capY = base - h;
              const colour = markerColor(e.kind);
              const shape = markerShape(e.kind);
              return (
                <g key={`e${i}-${e.t}-${e.kind}`}>
                  <line
                    x1={fx(x)}
                    x2={fx(x)}
                    y1={base}
                    y2={fx(capY)}
                    stroke={colour}
                    strokeWidth={1}
                    opacity={0.9}
                  />
                  {shape === "diamond" ? (
                    <path
                      d={`M${fx(x)} ${fx(capY - 4)}L${fx(x + 4)} ${fx(capY)}L${fx(x)} ${fx(capY + 4)}L${fx(x - 4)} ${fx(capY)}Z`}
                      fill={colour}
                    />
                  ) : shape === "disc" ? (
                    <circle cx={fx(x)} cy={fx(capY)} r={2.6} fill={colour} />
                  ) : shape === "chevron" ? (
                    <path
                      d={`M${fx(x - 3.2)} ${fx(capY + 2.4)}L${fx(x)} ${fx(capY - 2.4)}L${fx(x + 3.2)} ${fx(capY + 2.4)}`}
                      fill="none"
                      stroke={colour}
                      strokeWidth={1.25}
                      strokeLinecap="round"
                    />
                  ) : (
                    <circle
                      cx={fx(x)}
                      cy={fx(capY)}
                      r={2.4}
                      fill="none"
                      stroke={colour}
                      strokeWidth={1.1}
                    />
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Scene lane. */}
        <div
          role="group"
          aria-label="Scenes"
          className="relative bg-ink-850"
          style={{ height: sceneH }}
        >
          {scenes.map((s) => {
            const left = clampTo(s.startS, 0, duration) / duration;
            const right = clampTo(s.endS, 0, duration) / duration;
            const style = STATUS[s.status];
            const selected = s.id === selectedSceneId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelectScene?.(s.id)}
                aria-pressed={selected}
                aria-label={`Scene ${s.label}, ${s.purpose.replace(/_/g, " ")}, ${style.word}, ${(s.endS - s.startS).toFixed(1)} seconds`}
                className={cx(
                  "absolute top-1 bottom-1 overflow-hidden rounded-chip border text-left",
                  "transition-[transform,box-shadow,border-color] duration-200 ease-settle",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ember-300",
                  s.status === "running" && "scanning",
                  selected
                    ? "z-10 border-ember-400 bg-ink-750 shadow-ember"
                    : cx("bg-ink-800 hover:border-hairline-strong", style.edge),
                )}
                style={{ left: pct(left), width: pct(Math.max(right - left, 0.006)) }}
              >
                {/* Frame edge: the block is a piece of film, not a bar chart bar. */}
                <span
                  aria-hidden="true"
                  className="sprocket absolute inset-x-0 top-0 h-[4px] bg-ink-700"
                  style={{ "--sprocket-pitch": "9px", "--sprocket-hole": "4px" } as React.CSSProperties}
                />
                <span className={cx("absolute inset-x-0 bottom-0 h-[3px]", style.rail)} aria-hidden="true" />
                <span className="pointer-events-none absolute inset-x-1.5 top-[8px] flex flex-col gap-0.5 overflow-hidden">
                  <span
                    className={cx(
                      "truncate font-mono text-micro uppercase",
                      // Console tracking is a luxury a 50px-wide block cannot
                      // afford; tighten it so the label survives truncation.
                      compact ? "tracking-meta" : "tracking-console",
                      style.text,
                    )}
                  >
                    {s.label}
                  </span>
                  {compact ? null : (
                    <span className="truncate font-mono text-[11px] tracking-meta text-paper-400">
                      {s.purpose.replace(/_/g, " ")}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* Energy lane, present only once real audio has been measured. */}
        {energy && energy.length > 1 ? (
          <div className="relative overflow-hidden border-t border-hairline bg-ink-900">
            <svg
              width={width}
              height={WAVE_H}
              viewBox={`0 0 ${width} ${WAVE_H}`}
              className="block"
              role="img"
              aria-label="Measured audio energy"
            >
              <defs>
                <clipPath id={waveId}>
                  <rect x={0} y={0} width={fx(xOf(head))} height={WAVE_H} />
                </clipPath>
              </defs>
              <line
                x1={0}
                x2={width}
                y1={WAVE_H / 2}
                y2={WAVE_H / 2}
                stroke="var(--color-ink-700)"
                strokeWidth={1}
              />
              <path
                d={waveformPath(energy, duration, width, WAVE_H)}
                fill="var(--color-ink-700)"
              />
              <path
                d={waveformPath(energy, duration, width, WAVE_H)}
                fill="var(--color-ember-700)"
                clipPath={`url(#${waveId})`}
              />
            </svg>
          </div>
        ) : null}

        {/* Playhead. Non-interactive: the slider above owns the interaction. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-20 w-0"
          style={{ left: pct(headFraction) }}
        >
          <span className="absolute inset-y-0 -left-px w-[2px] bg-ember-300" />
          <span className="absolute -left-[5px] top-0 size-[10px] rotate-45 rounded-[2px] bg-ember-300" />
          <span
            className={cx(
              "absolute bottom-1 whitespace-nowrap rounded-chip bg-ink-1000/85 px-1.5 py-0.5",
              "tabular font-mono text-[11px] text-ember-200",
              headFraction > 0.82 ? "right-1.5" : "left-1.5",
            )}
          >
            {head.toFixed(2)}s
          </span>
        </div>
      </div>
    </div>
  );
}

// ── filmstrip ────────────────────────────────────────────────────────────────

/** One cell of the filmstrip. */
export interface StripScene {
  id: string;
  label: string;
  /** Object URL or data URI for the keyframe. Absent before it is generated. */
  thumbUrl?: string;
  status: SceneStatus;
  durationS: number;
}

export interface SceneStripProps {
  scenes: StripScene[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  className?: string;
}

/**
 * A horizontal filmstrip of keyframes. Each cell is a real frame: perforated on
 * both long edges, with the render status shown as a coloured rail plus a word,
 * so a judge can see at a glance which shots came back from a model and which
 * the local engine covered.
 */
export function SceneStrip({ scenes, selectedId, onSelect, className }: SceneStripProps) {
  return (
    <ul
      className={cx("flex list-none gap-2 overflow-x-auto pb-1", className)}
      aria-label="Scene keyframes"
    >
      {scenes.map((s, i) => {
        const style = STATUS[s.status];
        const selected = s.id === selectedId;
        return (
          <li key={s.id} className="shrink-0">
            <button
              type="button"
              onClick={() => onSelect?.(s.id)}
              aria-pressed={selected}
              aria-label={`${s.label}, ${style.word}, ${s.durationS.toFixed(1)} seconds`}
              className={cx(
                "group block rounded-shell-sm border p-bezel-sm text-left",
                "transition-[transform,box-shadow,border-color] duration-300 ease-settle",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-300",
                selected
                  ? "-translate-y-0.5 border-ember-400 bg-ember-900 shadow-ember"
                  : cx("border-hairline bg-ink-900 hover:-translate-y-px hover:border-hairline-strong", style.edge),
              )}
            >
              <span className="sprocket-edges block rounded-core-sm bg-ink-750 py-[7px]">
                <span
                  className={cx(
                    "relative block w-[74px] overflow-hidden bg-ink-950",
                    s.status === "running" && "scanning",
                  )}
                  style={{ aspectRatio: "9 / 16" }}
                >
                  {s.thumbUrl ? (
                    <img
                      src={s.thumbUrl}
                      alt=""
                      className="size-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <span className="grid size-full place-items-center text-paper-500">
                      <Icon name={style.icon} size={18} />
                    </span>
                  )}
                  <span
                    aria-hidden="true"
                    className={cx("absolute inset-x-0 bottom-0 h-[3px]", style.rail)}
                  />
                </span>
              </span>
              <span className="mt-1.5 flex items-center justify-between gap-1.5 px-0.5">
                <span className="tabular font-mono text-[11px] text-paper-400">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={cx("flex items-center gap-1 font-mono text-[11px] uppercase tracking-meta", style.text)}>
                  <Icon name={style.icon} size={9} />
                  {style.word}
                </span>
              </span>
              <span className="mt-0.5 block truncate px-0.5 font-mono text-[11px] text-paper-400">
                {s.label}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
