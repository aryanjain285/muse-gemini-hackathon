/**
 * The MUSE mark.
 *
 * One glyph carrying the three things the product is about: a vertical 9:16
 * aperture (the format), a bar sequence inside it that reads as both a waveform
 * and a timeline (the score), and a single taller accent bar where the drop lands
 * (the moment every cut is placed against). Sprocket notches on the frame edges
 * tie it to the film-lab language used throughout the interface.
 *
 * Deliberately built from rectangles on an integer grid so it stays crisp at
 * favicon sizes, and drawn in `currentColor` plus one accent so it inverts
 * cleanly on any ground.
 */

export interface MarkProps {
  size?: number;
  /** Colour of the accent bar. Defaults to the ember token. */
  accent?: string;
  className?: string;
  /** Decorative when a wordmark sits beside it; labelled when standing alone. */
  title?: string;
}

/** The symbol alone. Square viewBox so it drops into any icon slot. */
export function Mark({ size = 24, accent, className, title }: MarkProps) {
  const ember = accent ?? "var(--color-ember-400, #E8A44C)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : "presentation"}
      {...(title ? {} : { "aria-hidden": true })}
    >
      {title ? <title>{title}</title> : null}

      {/* The 9:16 aperture. Its proportions are the product's one hard constraint,
          so the mark states them literally: 15 wide by 26.6 tall is 9:16. */}
      <rect
        x="8.5"
        y="2.7"
        width="15"
        height="26.6"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.92"
      />

      {/* Sprocket notches, two per long edge. */}
      <g fill="currentColor" opacity="0.4">
        <rect x="5.4" y="8.4" width="2.2" height="3" rx="0.7" />
        <rect x="5.4" y="20.6" width="2.2" height="3" rx="0.7" />
        <rect x="24.4" y="8.4" width="2.2" height="3" rx="0.7" />
        <rect x="24.4" y="20.6" width="2.2" height="3" rx="0.7" />
      </g>

      {/* The waveform: four bars rising to a peak, then resolving. The tall one is
          the drop, and it is the only element that carries the accent. */}
      <g fill="currentColor">
        <rect x="11.6" y="18.2" width="2" height="5.4" rx="1" opacity="0.55" />
        <rect x="14.8" y="14.8" width="2" height="8.8" rx="1" opacity="0.75" />
        <rect x="21.2" y="16.9" width="2" height="6.7" rx="1" opacity="0.65" />
      </g>
      <rect x="18" y="8.2" width="2" height="15.4" rx="1" fill={ember} />
    </svg>
  );
}

export interface LogoProps extends MarkProps {
  /** Hide the wordmark and show only the symbol. */
  markOnly?: boolean;
  /** Wordmark scale, in px of cap height. */
  wordSize?: number;
}

/**
 * Mark plus wordmark. The wordmark is set in the interface mono at wide tracking
 * rather than a display face, because it has to sit beside monospace metadata
 * without looking like a different brand.
 */
export function Logo({
  size = 22,
  wordSize = 13,
  accent,
  className,
  markOnly = false,
  title,
}: LogoProps) {
  if (markOnly) return <Mark size={size} accent={accent} className={className} title={title ?? "MUSE"} />;
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <Mark size={size} accent={accent} />
      <span
        className="font-mono font-medium leading-none tracking-[0.34em] text-current"
        style={{ fontSize: `${wordSize}px` }}
      >
        MUSE
      </span>
    </span>
  );
}

export default Logo;
