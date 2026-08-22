"use client";

/**
 * Film Lab primitives.
 *
 * Every component here is presentational: props in, markup out, no data
 * fetching and no knowledge of routes. Two conventions run through the whole
 * file and are worth stating once.
 *
 * The double bezel. A container is an outer shell carrying the hairline border
 * and a small padding, wrapped around an inner core with its own fill and an
 * inset top highlight. The core radius is the shell radius minus the bezel
 * width, which is why the tokens come in matched pairs - it keeps the two
 * curves concentric instead of merely similar.
 *
 * Status is never colour alone. Anything that reports state pairs its colour
 * with a glyph and a word, so the console still reads correctly for a
 * colour-blind viewer and survives a projector with a crushed gamut.
 */

import * as React from "react";

/** Join class names, dropping anything falsy. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * A stable per-instance id safe to use in `for`, `aria-*` and `url(#...)`
 * references. React's own useId returns a value wrapped in guillemets, which is
 * legal in an HTML id but not in a CSS or SVG fragment reference, so the
 * decorative characters are stripped.
 */
export function useDomId(prefix: string): string {
  const raw = React.useId();
  return `${prefix}-${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** Fixed-precision percentage, so inline geometry never carries float noise. */
export function pct(fraction: number): string {
  return `${Number((fraction * 100).toFixed(4))}%`;
}

// ── icons ────────────────────────────────────────────────────────────────────

/** Every glyph the console draws. One stroke weight, no fills, no icon font. */
export type IconName =
  | "play"
  | "pause"
  | "upload"
  | "sparkle"
  | "wand"
  | "film"
  | "frame"
  | "music"
  | "waveform"
  | "check"
  | "alert"
  | "retry"
  | "download"
  | "chevron"
  | "close"
  | "mic"
  | "scissors";

const ICON_GEOMETRY: Record<IconName, React.ReactNode> = {
  play: <path d="M8.5 5.8 18.5 12 8.5 18.2Z" />,
  pause: <path d="M9.5 6v12M14.5 6v12" />,
  upload: <path d="M12 16.5V4.5M8 8.5 12 4.5l4 4M4.5 15v3.5h15V15" />,
  sparkle: (
    <>
      <path d="M11.5 3.5 13.1 9l5.5 1.6-5.5 1.6-1.6 5.5-1.6-5.5L4.4 10.6 9.9 9Z" />
      <path d="M18.5 15v3.5M16.75 16.75h3.5" />
    </>
  ),
  wand: (
    <>
      <path d="M5 19 16.4 7.6M14.4 5.6l4 4" />
      <path d="M9 3.5v3M7.5 5h3M18.5 12.5v3M17 14h3" />
    </>
  ),
  film: (
    <>
      <path d="M3.5 5.5h17v13h-17z" />
      <path d="M7.5 5.5v13M16.5 5.5v13" />
      <path d="M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4" />
    </>
  ),
  frame: (
    <>
      <path d="M5.5 4.5h13v15h-13z" />
      <path d="M5.5 9.5h13M5.5 14.5h13" />
    </>
  ),
  music: (
    <>
      <path d="M9 17.4V6.1l11-2.1v11.3" />
      <path d="M9 17.4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 15.3a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    </>
  ),
  waveform: <path d="M3.5 12h2M7.5 8.5v7M11.5 5v14M15.5 9.5v5M19.5 11v2" />,
  check: <path d="M5 12.4 9.6 17 19 6.8" />,
  alert: (
    <>
      <path d="M12 4.2 21 19.6H3Z" />
      <path d="M12 10v4.2M12 16.9h.01" />
    </>
  ),
  retry: <path d="M20 12a8 8 0 1 1-2.8-6.1M20 4v4.6h-4.6" />,
  download: <path d="M12 4.5v12M8 12.5l4 4 4-4M4.5 19.5h15" />,
  chevron: <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  mic: (
    <>
      <path d="M12 4.2a2.8 2.8 0 0 1 2.8 2.8v4a2.8 2.8 0 0 1-5.6 0V7A2.8 2.8 0 0 1 12 4.2Z" />
      <path d="M6.8 11a5.2 5.2 0 0 0 10.4 0M12 16.4v3.1M9.2 19.5h5.6" />
    </>
  ),
  scissors: (
    <>
      <path d="M8.7 8.4a2.4 2.4 0 1 1-3.4-3.4 2.4 2.4 0 0 1 3.4 3.4ZM8.7 15.6a2.4 2.4 0 1 0-3.4 3.4 2.4 2.4 0 0 0 3.4-3.4Z" />
      <path d="M8.7 8.4 19 18.7M8.7 15.6 19 5.3" />
    </>
  ),
};

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: IconName;
  /** Edge length in pixels. Stroke weight stays hairline at every size. */
  size?: number;
}

/**
 * Hairline inline-SVG icon. Inherits `currentColor`, and is aria-hidden by
 * default because an icon next to a label would otherwise be read twice.
 */
export function Icon({ name, size = 16, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cx("shrink-0", className)}
      {...rest}
    >
      {ICON_GEOMETRY[name]}
    </svg>
  );
}

// ── panel ────────────────────────────────────────────────────────────────────

export type PanelTone = "ink" | "raised" | "ember";
export type PanelPadding = "none" | "sm" | "md" | "lg";

const PANEL_SHELL: Record<PanelTone, string> = {
  ink: "bg-ink-900 border-hairline",
  raised: "bg-ink-850 border-hairline-strong shadow-lift",
  ember: "bg-ember-900 border-hairline-ember shadow-ember",
};

const PANEL_CORE: Record<PanelTone, string> = {
  ink: "bg-ink-850",
  raised: "bg-ink-800",
  ember: "bg-ink-850",
};

const PANEL_PADDING: Record<PanelPadding, string> = {
  none: "p-0",
  sm: "p-3",
  md: "p-5",
  lg: "p-7",
};

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: PanelTone;
  padding?: PanelPadding;
  /** Opt into the entrance. A number is a stagger index within its group. */
  enter?: boolean | number;
  children?: React.ReactNode;
}

/**
 * The console's container: a hairline shell wrapped around an inset core, with
 * concentric radii. Everything with a boundary in MUSE is one of these.
 */
export function Panel({
  tone = "ink",
  padding = "md",
  enter,
  className,
  children,
  style,
  ...rest
}: PanelProps) {
  const entering = enter !== undefined && enter !== false;
  const staggerStyle =
    typeof enter === "number" ? ({ "--stagger": enter } as React.CSSProperties) : undefined;

  return (
    <div
      className={cx(
        "rounded-shell border p-bezel",
        PANEL_SHELL[tone],
        entering && "animate-fade-up stagger",
        className,
      )}
      style={{ ...staggerStyle, ...style }}
      {...rest}
    >
      <div className={cx("h-full rounded-core shadow-core", PANEL_CORE[tone], PANEL_PADDING[padding])}>
        {children}
      </div>
    </div>
  );
}

// ── button ───────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "ghost" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-ember-400 text-ink-1000 border-ember-300 shadow-ember hover:bg-ember-300 hover:border-ember-200",
  ghost:
    "bg-ink-850 text-paper-100 border-hairline shadow-core hover:bg-ink-800 hover:border-hairline-strong",
  quiet:
    "bg-transparent text-paper-300 border-transparent hover:bg-ink-850 hover:text-paper-100 hover:border-hairline",
  danger:
    "bg-ink-850 text-signal-fail border-signal-fail/45 shadow-core hover:bg-signal-fail/12 hover:border-signal-fail/70",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-2 px-3 text-micro",
  md: "h-10 gap-2.5 px-4 text-label",
  lg: "h-12 gap-3 px-5 text-body",
};

/** The trailing icon well shrinks with the control but stays a true circle. */
const BUTTON_WELL: Record<ButtonSize, string> = {
  sm: "size-5 -mr-1.5",
  md: "size-7 -mr-2",
  lg: "size-8 -mr-2.5",
};

const BUTTON_WELL_TONE: Record<ButtonVariant, string> = {
  primary: "bg-ink-1000/25 text-ink-1000",
  ghost: "bg-ink-950 text-paper-200 border border-hairline",
  quiet: "bg-ink-900 text-paper-300",
  danger: "bg-signal-fail/15 text-signal-fail",
};

export interface ButtonProps extends React.ComponentPropsWithoutRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Optional glyph seated in its own circular well, flush to the right padding.
   * Named for its position because the well only exists on that edge.
   */
  trailingIcon?: IconName;
  /** Shows the shimmer and blocks input without changing the control's width. */
  loading?: boolean;
}

/**
 * Primary interactive control. Uppercase mono labels at the two smaller sizes
 * so a row of buttons reads as console switches rather than web links.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", trailingIcon, loading = false, disabled, className, children, type, ...rest },
  ref,
) {
  const inert = disabled === true || loading;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={inert}
      aria-busy={loading || undefined}
      className={cx(
        "relative inline-flex select-none items-center justify-center overflow-hidden border font-mono uppercase",
        "rounded-pill tracking-console transition-[background-color,border-color,color,transform,box-shadow]",
        "duration-200 ease-settle active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2",
        "focus-visible:outline-ember-300 disabled:pointer-events-none disabled:opacity-45",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        trailingIcon && "pr-1.5",
        loading && "shimmer",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === "lg" ? 16 : 13} /> : null}
      <span className="whitespace-nowrap">{children}</span>
      {trailingIcon ? (
        <span
          aria-hidden="true"
          className={cx(
            "grid place-items-center rounded-pill",
            BUTTON_WELL[size],
            BUTTON_WELL_TONE[variant],
          )}
        >
          <Icon name={trailingIcon} size={size === "sm" ? 12 : 14} />
        </span>
      ) : null}
    </button>
  );
});

// ── type ─────────────────────────────────────────────────────────────────────

export type EyebrowTone = "neutral" | "ember" | "dim";

const EYEBROW_TONE: Record<EyebrowTone, string> = {
  neutral: "border-hairline text-paper-300",
  ember: "border-hairline-ember text-ember-300",
  dim: "border-transparent text-paper-400",
};

export interface EyebrowProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: EyebrowTone;
  children?: React.ReactNode;
}

/** Microscopic uppercase label. Names a region; never carries the region's data. */
export function Eyebrow({ tone = "neutral", className, children, ...rest }: EyebrowProps) {
  return (
    <span
      className={cx(
        "inline-flex w-fit items-center rounded-pill border px-2.5 py-1 font-mono text-micro uppercase",
        "tracking-console",
        EYEBROW_TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export interface DisplayProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** 1 is the page's single thesis line; 3 is a section head. */
  level?: 1 | 2 | 3;
  children?: React.ReactNode;
}

/**
 * The only place the editorial serif appears. Fluid sizing plus a measure
 * capped in characters keeps a heading inside three lines at any viewport, and
 * the clamp is a hard stop for the case where the copy is longer than planned.
 */
export function Display({ level = 1, className, children, ...rest }: DisplayProps) {
  const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as "h1" | "h2" | "h3";
  const size =
    level === 1 ? "text-display-1" : level === 2 ? "text-display-2" : "text-display-3";
  return (
    <Tag
      className={cx(
        "max-w-display font-display font-normal leading-display text-paper-50",
        "line-clamp-3 text-balance",
        size,
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export interface MetaProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  /** Draws the value in the accent, for the one figure that matters on a row. */
  accent?: boolean;
}

/**
 * A single line of measured metadata. The dotted leader between key and value
 * is what lets a stack of these read as a slate rather than as a form.
 */
export function Meta({ label, value, accent = false, className, ...rest }: MetaProps) {
  return (
    <div className={cx("flex items-baseline gap-2 font-mono text-meta", className)} {...rest}>
      <span className="uppercase tracking-meta text-paper-400">{label}</span>
      <span aria-hidden="true" className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-ink-700" />
      <span className={cx("tabular", accent ? "text-ember-300" : "text-paper-200")}>{value}</span>
    </div>
  );
}

// ── status ───────────────────────────────────────────────────────────────────

export type BadgeTone = "neutral" | "live" | "ok" | "warn" | "fail" | "local";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "border-hairline bg-ink-850 text-paper-300",
  live: "border-signal-live/50 bg-signal-live/10 text-signal-live",
  ok: "border-signal-ok/45 bg-signal-ok/10 text-signal-ok",
  warn: "border-signal-warn/45 bg-signal-warn/10 text-signal-warn",
  fail: "border-signal-fail/50 bg-signal-fail/10 text-signal-fail",
  local: "border-signal-local/45 bg-signal-local/10 text-signal-local",
};

/**
 * A distinct mark per tone, so the six states stay distinguishable without
 * colour: a hollow ring, a pulsing disc, a tick, a bar, a cross, a square.
 */
function BadgeMark({ tone }: { tone: BadgeTone }) {
  if (tone === "live") {
    return (
      <span aria-hidden="true" className="grid size-2.5 place-items-center">
        <span className="size-2 rounded-pill bg-signal-live animate-rec" />
      </span>
    );
  }
  const common = "size-2.5";
  switch (tone) {
    case "ok":
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true" className={common} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
          <path d="M1.5 5.4 3.8 7.6 8.5 2.4" />
        </svg>
      );
    case "warn":
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true" className={common} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
          <path d="M5 1.4v4.2M5 8.1h.01" />
        </svg>
      );
    case "fail":
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true" className={common} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
          <path d="M2.4 2.4l5.2 5.2M7.6 2.4 2.4 7.6" />
        </svg>
      );
    case "local":
      return <span aria-hidden="true" className="size-2 rounded-chip bg-current" />;
    default:
      return <span aria-hidden="true" className="size-2 rounded-pill border border-current" />;
  }
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children?: React.ReactNode;
}

/** Status chip. Always shows a mark and a word alongside the tone colour. */
export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex w-fit items-center gap-1.5 rounded-pill border px-2 py-0.5 font-mono text-micro uppercase",
        "tracking-console",
        BADGE_TONE[tone],
        className,
      )}
      {...rest}
    >
      <BadgeMark tone={tone} />
      {children}
    </span>
  );
}

export type ProgressTone = "ember" | "ok" | "fail";

const PROGRESS_FILL: Record<ProgressTone, string> = {
  ember: "bg-ember-400",
  ok: "bg-signal-ok",
  fail: "bg-signal-fail",
};

export interface ProgressProps {
  /** 0..1. Ignored while indeterminate. */
  value?: number;
  /** Work is running but its extent is unknown; shows the shimmer instead. */
  indeterminate?: boolean;
  tone?: ProgressTone;
  size?: "sm" | "md";
  /** Accessible name. Required, because a bare bar names nothing. */
  label: string;
  className?: string;
}

/** Determinate bar with an indeterminate shimmer mode. */
export function Progress({
  value = 0,
  indeterminate = false,
  tone = "ember",
  size = "md",
  label,
  className,
}: ProgressProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10;
  const height = size === "sm" ? "h-1" : "h-1.5";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : pct}
      aria-valuetext={indeterminate ? "in progress" : `${pct}%`}
      className={cx(
        "relative w-full overflow-hidden rounded-pill bg-ink-800 shadow-well",
        height,
        indeterminate && "shimmer",
        className,
      )}
    >
      {indeterminate ? null : (
        <div
          className={cx(
            "h-full origin-left rounded-pill transition-transform duration-500 ease-entrance",
            PROGRESS_FILL[tone],
          )}
          style={{ transform: `scaleX(${pct / 100})`, width: "100%" }}
        />
      )}
    </div>
  );
}

export interface SpinnerProps {
  /** Edge length in pixels. */
  size?: number;
  className?: string;
}

/** Hairline arc spinner. Decorative; the surrounding control carries the label. */
export function Spinner({ size = 14, className }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cx("animate-arc shrink-0", className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={1.25} opacity={0.22} />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── inputs ───────────────────────────────────────────────────────────────────

const CONTROL_SURFACE = cx(
  "w-full rounded-core-sm border border-hairline bg-ink-900 px-3 text-paper-100 shadow-well",
  "placeholder:text-paper-400 transition-[border-color,box-shadow] duration-200 ease-settle",
  "hover:border-hairline-strong focus:border-ember-500 focus:outline-2 focus:outline-offset-2",
  "focus:outline-ember-300 disabled:opacity-50",
);

export type InputProps = React.ComponentPropsWithoutRef<"input">;

/** Single-line text control. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(CONTROL_SURFACE, "h-10 text-body", className)} {...rest} />;
});

export type TextareaProps = React.ComponentPropsWithoutRef<"textarea">;

/** Multi-line text control, used for the brief. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 4, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx(CONTROL_SURFACE, "resize-y py-2.5 text-body leading-relaxed", className)}
      {...rest}
    />
  );
});

/** Props a Field can wire onto whatever control it wraps. */
type WiredControl = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

export interface FieldProps {
  label: string;
  /** Quiet guidance shown under the control. Suppressed while an error shows. */
  hint?: string;
  /** Present means invalid; the text replaces the hint. */
  error?: string;
  /** Supply to control the id yourself; otherwise one is generated. */
  id?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Labelled control wrapper. It wires the generated id, the description and the
 * invalid flag onto its child so a caller cannot forget the association.
 */
export function Field({ label, hint, error, id, children, className }: FieldProps) {
  const generated = useDomId("field");
  const controlId = id ?? generated;
  const messageId = `${controlId}-msg`;
  const message = error ?? hint;

  const control = React.isValidElement<WiredControl>(children)
    ? React.cloneElement(children, {
        id: children.props.id ?? controlId,
        "aria-describedby": message ? messageId : children.props["aria-describedby"],
        "aria-invalid": error ? true : children.props["aria-invalid"],
      })
    : children;

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <label
        htmlFor={controlId}
        className="font-mono text-micro uppercase tracking-console text-paper-400"
      >
        {label}
      </label>
      {control}
      {message ? (
        <p
          id={messageId}
          className={cx("font-mono text-meta", error ? "text-signal-fail" : "text-paper-400")}
        >
          {error ? (
            <span className="mr-1.5 inline-flex translate-y-0.5">
              <Icon name="alert" size={12} />
            </span>
          ) : null}
          {message}
        </p>
      ) : null}
    </div>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Visible text beside the switch. Omit only if `label` is supplied. */
  children?: React.ReactNode;
  /** Accessible name when there is no visible text. */
  label?: string;
  disabled?: boolean;
  className?: string;
}

/** Accessible switch: a real button carrying `role="switch"` and `aria-checked`. */
export function Toggle({ checked, onChange, children, label, disabled, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={children ? undefined : label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "group inline-flex w-fit items-center gap-3 rounded-pill font-mono text-micro uppercase tracking-console",
        "text-paper-300 transition-colors duration-200 ease-settle hover:text-paper-100",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-300",
        "disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "relative h-5 w-9 rounded-pill border transition-colors duration-200 ease-settle",
          checked ? "border-ember-400 bg-ember-600" : "border-hairline bg-ink-800",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 left-0.5 size-3.5 rounded-pill transition-transform duration-300 ease-snap",
            checked ? "translate-x-4 bg-ember-100" : "translate-x-0 bg-paper-400",
          )}
        />
      </span>
      {children}
    </button>
  );
}

/** One choice in a Segmented control. */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Secondary line, e.g. the price or the model behind a profile. */
  detail?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  /** Two to six options; beyond that a control this shape stops being scannable. */
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the group. */
  label: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * Segmented control with roving focus: one tab stop for the group, arrow keys
 * to move between options, Home and End to jump to the ends.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: SegmentedProps<T>) {
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const move = (delta: number) => {
    const n = options.length;
    for (let step = 1; step <= n; step++) {
      const next = options[(activeIndex + delta * step + n * n) % n];
      if (next && next.disabled !== true) {
        onChange(next.value);
        return;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      const first = options.find((o) => o.disabled !== true);
      if (first) onChange(first.value);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = [...options].reverse().find((o) => o.disabled !== true);
      if (last) onChange(last.value);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx(
        "inline-flex w-fit rounded-shell-sm border border-hairline bg-ink-900 p-bezel-sm",
        className,
      )}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative flex flex-col items-start justify-center rounded-core-sm font-mono uppercase",
              "tracking-console transition-[background-color,color,box-shadow] duration-200 ease-settle",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-300",
              "disabled:pointer-events-none disabled:opacity-40",
              size === "sm" ? "h-7 px-2.5 text-micro" : "min-h-9 px-3.5 py-1.5 text-micro",
              selected
                ? "bg-ink-750 text-ember-200 shadow-core"
                : "text-paper-400 hover:bg-ink-850 hover:text-paper-200",
            )}
          >
            <span className="whitespace-nowrap">{o.label}</span>
            {o.detail ? (
              <span
                className={cx(
                  "text-[11px] normal-case tracking-meta",
                  selected ? "text-paper-300" : "text-paper-400",
                )}
              >
                {o.detail}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ── overlays and readouts ────────────────────────────────────────────────────

export type TooltipSide = "top" | "bottom" | "left" | "right";

const TOOLTIP_POSITION: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
};

export interface TooltipProps {
  /** The text to reveal. Kept short; this is not a help panel. */
  label: string;
  side?: TooltipSide;
  children: React.ReactElement;
  className?: string;
}

/**
 * Hover and focus tooltip with no positioning dependency: the trigger becomes
 * the containing block and the bubble is offset from one of its edges. It stays
 * in the accessibility tree as the trigger's description, so keyboard users get
 * the same text screen readers do.
 */
export function Tooltip({ label, side = "top", children, className }: TooltipProps) {
  const tipId = useDomId("tip");
  const trigger = React.isValidElement<{ "aria-describedby"?: string }>(children)
    ? React.cloneElement(children, { "aria-describedby": tipId })
    : children;

  return (
    <span className={cx("group relative inline-flex", className)}>
      {trigger}
      <span
        id={tipId}
        role="tooltip"
        className={cx(
          "pointer-events-none absolute z-50 w-max max-w-56 rounded-chip border border-hairline-strong",
          "bg-ink-1000 px-2.5 py-1.5 font-mono text-meta text-paper-200 shadow-lift",
          "opacity-0 transition-[opacity,transform] duration-200 ease-settle",
          "group-hover:opacity-100 group-focus-within:opacity-100",
          TOOLTIP_POSITION[side],
        )}
      >
        {label}
      </span>
    </span>
  );
}

export type TrendDirection = "up" | "down" | "flat";

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  /** Pre-formatted. The tile never does arithmetic or rounding. */
  value: string;
  /** Suffix set smaller than the figure, e.g. "s" or "USD". */
  unit?: string;
  /** Quiet line under the figure. */
  hint?: string;
  trend?: { direction: TrendDirection; label: string };
}

const TREND_TONE: Record<TrendDirection, string> = {
  up: "text-signal-ok",
  down: "text-signal-fail",
  flat: "text-paper-400",
};

const TREND_GLYPH: Record<TrendDirection, string> = {
  up: "M2 8.5 6 4l4 4.5",
  down: "M2 3.5 6 8l4-4.5",
  flat: "M2 6h8",
};

/**
 * Big-number tile. Figures are set in mono rather than the serif: in this
 * console the serif is the authored voice and mono is anything measured, so a
 * readout that came from ffprobe or a cost ledger belongs in mono.
 */
export function Stat({ label, value, unit, hint, trend, className, ...rest }: StatProps) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)} {...rest}>
      <span className="font-mono text-micro uppercase tracking-console text-paper-400">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="tabular font-mono text-readout text-paper-50">{value}</span>
        {unit ? <span className="font-mono text-meta uppercase text-paper-400">{unit}</span> : null}
      </span>
      {trend ? (
        <span className={cx("inline-flex items-center gap-1.5 font-mono text-meta", TREND_TONE[trend.direction])}>
          <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
            <path d={TREND_GLYPH[trend.direction]} />
          </svg>
          {trend.label}
        </span>
      ) : null}
      {hint ? <span className="font-mono text-meta text-paper-400">{hint}</span> : null}
    </div>
  );
}
