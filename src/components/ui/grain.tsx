"use client";

/**
 * Atmosphere layers.
 *
 * These two components carry the whole "we are looking at projected film"
 * conceit, and they are the only place in the app allowed to run a permanent
 * animation. Both are pure decoration: fixed to the viewport, never
 * interactive, and animated on transform, opacity and filter only so a running
 * render never competes with them for layout.
 *
 * Reduced motion is handled in globals.css, which stops every loop declared
 * here. Nothing in this file needs to branch on the media query.
 */

import * as React from "react";

export interface GrainOverlayProps {
  /**
   * Grain density, 0..1, mapped onto a narrow physical range. The base layer on
   * the body already carries a little grain; this deepens it on hero surfaces.
   */
  intensity?: number;
  /** Corner falloff, 0..1. */
  vignette?: number;
  /** The horizontal signal-path lines. Off for dense reading views. */
  scanlines?: boolean;
  className?: string;
}

/** Map a 0..1 dial onto the range where grain reads as film rather than as dirt. */
function grainOpacity(intensity: number): number {
  const t = Math.min(1, Math.max(0, intensity));
  return Number((0.02 + t * 0.06).toFixed(4));
}

/** Fixed-precision viewport units, so inline geometry carries no float noise. */
const vw = (fraction: number) => `${Number((fraction * 100).toFixed(3))}%`;
const vmax = (fraction: number) => `${Number((fraction * 100).toFixed(3))}vmax`;

/**
 * Film grain, vignette and an optional scanline pass over the entire viewport.
 * Mount once, high in the tree; it sits above page content and below nothing.
 */
export function GrainOverlay({
  intensity = 0.5,
  vignette = 0.32,
  scanlines = true,
  className,
}: GrainOverlayProps) {
  const style = {
    "--grain-opacity": grainOpacity(intensity),
    "--vignette-strength": Math.min(1, Math.max(0, vignette)),
  } as React.CSSProperties;

  return (
    <div aria-hidden="true" className={["film-layer", className].filter(Boolean).join(" ")} style={style}>
      <div className="film-grain absolute inset-0" />
      <div className="film-vignette absolute inset-0" />
      {scanlines ? <div className="film-scanline absolute inset-0" /> : null}
    </div>
  );
}

/** One drifting pool of light. Positions are fractions of the viewport. */
interface GlowSpec {
  /** Horizontal centre, 0..1 of viewport width. */
  x: number;
  /** Vertical centre, 0..1 of viewport height. */
  y: number;
  /** Diameter, as a fraction of the viewport's larger edge. */
  size: number;
  /** Peak opacity before the drift keyframe modulates it. */
  opacity: number;
  /** Seconds of negative delay, so the two pools are never in phase. */
  offsetS: number;
  reverse: boolean;
}

/**
 * Two pools, deliberately asymmetric: a large warm one low and left behind the
 * timeline, and a tighter hotter one high and right behind the header. Equal,
 * mirrored glows read as a gradient background; unequal ones read as a room.
 */
const GLOWS: readonly GlowSpec[] = [
  { x: 0.16, y: 0.82, size: 0.62, opacity: 0.13, offsetS: 0, reverse: false },
  { x: 0.88, y: 0.1, size: 0.38, opacity: 0.09, offsetS: 13, reverse: true },
];

export interface AmbientGlowProps {
  /** Scales both pools together, 0..1. */
  strength?: number;
  className?: string;
}

/**
 * Slow ember light behind the content. Sits on a negative z-index so it renders
 * in front of the root canvas and behind everything in the page, which is why
 * the ground colour lives on the root element in globals.css.
 */
export function AmbientGlow({ strength = 1, className }: AmbientGlowProps) {
  const scale = Math.min(1, Math.max(0, strength));

  return (
    <div
      aria-hidden="true"
      className={["fixed inset-0 -z-10 overflow-hidden", className].filter(Boolean).join(" ")}
    >
      {GLOWS.map((g, i) => (
        // The pool's own opacity lives on this wrapper because the drift
        // keyframe sets opacity in absolute terms to make the light breathe.
        // Nesting multiplies the two instead of letting the keyframe win.
        <div
          key={i}
          className="absolute"
          style={{
            left: vw(g.x),
            top: vw(g.y),
            width: vmax(g.size),
            height: vmax(g.size),
            marginLeft: vmax(g.size / -2),
            marginTop: vmax(g.size / -2),
            opacity: Number((g.opacity * scale).toFixed(4)),
          }}
        >
          <div
            className="ambient-glow animate-drift inset-0"
            style={{
              animationDelay: g.offsetS === 0 ? "0s" : `-${g.offsetS}s`,
              animationDirection: g.reverse ? "reverse" : "normal",
              backgroundImage:
                i === 0
                  ? "radial-gradient(circle at 50% 50%, var(--color-ember-500) 0%, var(--color-ember-700) 30%, transparent 62%)"
                  : "radial-gradient(circle at 50% 50%, var(--color-ember-400) 0%, var(--color-ember-700) 28%, transparent 60%)",
            }}
          />
        </div>
      ))}
    </div>
  );
}
