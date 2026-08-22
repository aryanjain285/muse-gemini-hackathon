"use client";

/**
 * The edit bay: the film, the readings of it, and the comparison.
 *
 * Two ideas live here, and both come from the same architectural fact — that
 * generation and composition are separate, so the footage is paid for once and can
 * be re-read for nothing.
 *
 * The first is Recut: a different transition vocabulary, grade and cut density over
 * the same shots, instantly and at no cost.
 *
 * The second is the comparison. Two players hold the same film — one with cuts
 * placed on accents measured in the returned audio, one with cuts left where the
 * plan guessed. Switching between them preserves the playhead, so the difference
 * arrives as sound rather than as a claim. It is the only honest way to show that
 * the reconciliation step does anything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Eyebrow, Icon, Panel, Progress, Spinner, cx } from "@/components/ui/primitives";
import { duration } from "@/lib/brand";
import type { ProjectView } from "./useProjectStream";

export interface EditPanelProps {
  project: ProjectView;
  progress: { fraction: number; label: string } | null;
  /** Ask the server to cut this reading. Free and instant. */
  onRecut: (editId: string) => void;
  busyEdit: string | null;
  error: string | null;
  playheadS: number;
  onPlayhead: (s: number) => void;
  seekToS: number | null;
  onSeekHandled: () => void;
}

const COMPARE_ID = "unsnapped";

export default function EditPanel({
  project,
  progress,
  onRecut,
  busyEdit,
  error,
  playheadS,
  onPlayhead,
  seekToS,
  onSeekHandled,
}: EditPanelProps) {
  const offered = project.edits.filter((e) => e.offered);
  const ready = offered.filter((e) => e.url);
  const compare = project.edits.find((e) => e.id === COMPARE_ID) ?? null;

  const [current, setCurrent] = useState<string>(ready[0]?.id ?? "as_cut");
  const [comparing, setComparing] = useState(false);

  const mainRef = useRef<HTMLVideoElement | null>(null);
  const altRef = useRef<HTMLVideoElement | null>(null);
  const lastReported = useRef(0);

  const active = project.edits.find((e) => e.id === current) ?? null;
  const activeUrl = active?.url ?? project.reel?.url ?? null;
  const compareUrl = compare?.url ?? null;

  // Whichever player is on screen owns the clock.
  const visible = comparing && compareUrl ? altRef : mainRef;

  /** Switching reading must not lose the moment: it is the whole comparison. */
  const swap = useCallback(
    (toCompare: boolean) => {
      const from = toCompare ? mainRef.current : altRef.current;
      const to = toCompare ? altRef.current : mainRef.current;
      const at = from?.currentTime ?? playheadS;
      const wasPlaying = from ? !from.paused : false;
      from?.pause();
      setComparing(toCompare);
      if (to) {
        try {
          to.currentTime = at;
        } catch {
          // A player that has not loaded metadata yet will accept the seek later.
        }
        if (wasPlaying) void to.play().catch(() => undefined);
      }
    },
    [playheadS],
  );

  // Seeks arriving from the timeline apply to whichever player is showing.
  useEffect(() => {
    if (seekToS === null) return;
    const el = visible.current;
    if (el) {
      try {
        el.currentTime = seekToS;
      } catch {
        /* metadata not ready; the next seek will land */
      }
    }
    onSeekHandled();
  }, [seekToS, onSeekHandled, visible]);

  const onTime = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const t = e.currentTarget.currentTime;
      // Roughly eight reports a second is enough for a playhead and spares the
      // timeline a re-render per frame.
      if (Math.abs(t - lastReported.current) < 0.12) return;
      lastReported.current = t;
      onPlayhead(t);
    },
    [onPlayhead],
  );

  const totalS = project.reel?.durationS ?? project.spec?.durationS ?? 0;

  if (!project.reel && !progress) {
    return (
      <Panel tone="ink" padding="lg">
        <Eyebrow tone="dim">Edit bay</Eyebrow>
        <p className="mt-3 max-w-prose font-sans text-[13px] leading-relaxed text-paper-300">
          Your film appears here once it is cut.
        </p>
      </Panel>
    );
  }

  return (
    <Panel tone="raised" padding="md">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Eyebrow tone="ember">Edit bay</Eyebrow>
        {comparing ? (
          <Badge tone="warn">off the beat</Badge>
        ) : active ? (
          <Badge tone="ok">{active.label}</Badge>
        ) : null}
      </div>

      {progress ? (
        <div className="mb-5">
          <div className="mb-2 flex items-baseline justify-between font-mono text-[11px] text-paper-400">
            <span>{progress.label}</span>
            <span className="tabular-nums">{Math.round(progress.fraction * 100)}%</span>
          </div>
          <Progress value={progress.fraction} tone="ember" label={`Cutting: ${progress.label}`} />
        </div>
      ) : null}

      {/* Both players are mounted so a switch is instant. The hidden one keeps its
          buffer, which is what makes the comparison land rather than stutter. */}
      <div className="mx-auto w-full max-w-[420px]">
        <div className="rounded-shell border border-hairline bg-ink-1000 p-1.5">
          <div className="relative aspect-[9/16] max-h-[68dvh] overflow-hidden rounded-core bg-ink-1000">
            {activeUrl ? (
              <video
                ref={mainRef}
                src={activeUrl}
                poster={project.reel?.posterUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                onTimeUpdate={onTime}
                aria-label={`${active?.label ?? "Your film"}, cuts on the beat`}
                className={cx(
                  "h-full w-full object-cover transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                  comparing && compareUrl ? "pointer-events-none absolute inset-0 opacity-0" : "opacity-100",
                )}
              />
            ) : null}

            {compareUrl ? (
              <video
                ref={altRef}
                src={compareUrl}
                poster={project.reel?.posterUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                onTimeUpdate={onTime}
                aria-label="The same film with cuts off the beat"
                className={cx(
                  "h-full w-full object-cover transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                  comparing ? "opacity-100" : "pointer-events-none absolute inset-0 opacity-0",
                )}
              />
            ) : null}
          </div>
        </div>

        <p className="mt-2.5 flex items-baseline justify-between font-mono text-[11px] text-paper-400">
          <span className="tabular-nums">{duration(playheadS)}</span>
          <span className="tabular-nums">{duration(totalS)}</span>
        </p>
      </div>

      {/* ── the readings ────────────────────────────────────────────────────── */}
      <div className="mt-7">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <Eyebrow tone="dim">This edit</Eyebrow>
          <span className="font-mono text-[11px] text-paper-400">re-cutting is free</span>
        </div>

        <ul className="grid list-none grid-cols-1 gap-2 sm:grid-cols-3">
          {offered.map((e) => {
            const selected = !comparing && e.id === current;
            const busy = busyEdit === e.id;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  disabled={project.running || busy}
                  onClick={() => {
                    if (e.url) {
                      setComparing(false);
                      setCurrent(e.id);
                    } else {
                      onRecut(e.id);
                    }
                  }}
                  className={cx(
                    "flex h-full w-full flex-col gap-1.5 rounded-core border px-3.5 py-3 text-left",
                    "transition-colors duration-400 ease-[cubic-bezier(0.32,0.72,0,1)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    selected
                      ? "border-hairline-ember bg-ember-500/10"
                      : "border-hairline bg-ink-900/50 hover:border-hairline-strong",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span
                      className={cx(
                        "font-sans text-[13px]",
                        selected ? "text-ember-200" : "text-paper-100",
                      )}
                    >
                      {e.label}
                    </span>
                    {busy ? (
                      <Spinner size={12} />
                    ) : selected ? (
                      <Icon name="check" size={13} className="shrink-0 text-ember-400" />
                    ) : e.url ? null : (
                      <Icon name="scissors" size={12} className="shrink-0 text-paper-400" />
                    )}
                  </span>
                  <span className="font-sans text-[12px] leading-relaxed text-paper-400">
                    {e.blurb}
                  </span>
                  {!e.url && !busy ? (
                    <span className="font-mono text-[11px] text-paper-500">cut it</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ── the comparison ──────────────────────────────────────────────────── */}
      <div className="mt-7 border-t border-hairline pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-prose">
            <Eyebrow tone="dim">Hear the difference</Eyebrow>
            <p className="mt-2 font-sans text-[13px] leading-relaxed text-paper-300">
              MUSE places every cut on a beat it measured in the finished score, not on the
              time the plan asked for. Switch between the two and listen.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {compareUrl ? (
              <>
                <Button
                  variant={comparing ? "ghost" : "primary"}
                  size="sm"
                  onClick={() => swap(false)}
                  disabled={project.running}
                >
                  On the beat
                </Button>
                <Button
                  variant={comparing ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => swap(true)}
                  disabled={project.running}
                >
                  Off the beat
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRecut(COMPARE_ID)}
                loading={busyEdit === COMPARE_ID}
                disabled={project.running || busyEdit !== null}
                trailingIcon="scissors"
              >
                Cut the comparison
              </Button>
            )}
          </div>
        </div>

        {/* The cut points of both readings, on one axis. Seeing them diverge is what
            makes the audible difference legible. */}
        {compareUrl && active && totalS > 0 ? (
          <figure className="mt-5">
            <svg
              viewBox="0 0 600 62"
              className="h-[62px] w-full"
              role="img"
              aria-label={`Cut positions compared. On the beat: ${active.cuts
                .map((c) => c.toFixed(2))
                .join(", ")} seconds. Off the beat: ${(compare?.cuts ?? [])
                .map((c) => c.toFixed(2))
                .join(", ")} seconds.`}
            >
              <title>Where the cuts land</title>
              <line x1="0" y1="20" x2="600" y2="20" stroke="var(--color-hairline)" strokeWidth="1" />
              <line x1="0" y1="46" x2="600" y2="46" stroke="var(--color-hairline)" strokeWidth="1" />
              <text x="0" y="12" className="font-mono" fontSize="9" fill="var(--color-paper-400)">
                on the beat
              </text>
              <text x="0" y="60" className="font-mono" fontSize="9" fill="var(--color-paper-400)">
                off the beat
              </text>
              {(project.reel?.anchors ?? []).map((a, i) => (
                <line
                  key={`anchor-${i}`}
                  x1={(a / totalS) * 600}
                  y1={16}
                  x2={(a / totalS) * 600}
                  y2={24}
                  stroke="var(--color-ink-600)"
                  strokeWidth="1"
                />
              ))}
              {active.cuts.map((c, i) => (
                <line
                  key={`on-${i}`}
                  x1={(c / totalS) * 600}
                  y1={13}
                  x2={(c / totalS) * 600}
                  y2={27}
                  stroke="var(--color-signal-ok)"
                  strokeWidth="2"
                />
              ))}
              {(compare?.cuts ?? []).map((c, i) => (
                <line
                  key={`off-${i}`}
                  x1={(c / totalS) * 600}
                  y1={39}
                  x2={(c / totalS) * 600}
                  y2={53}
                  stroke="var(--color-signal-warn)"
                  strokeWidth="2"
                />
              ))}
            </svg>
            <figcaption className="mt-2 font-mono text-[11px] text-paper-400">
              faint ticks are the beats measured in the score
            </figcaption>
          </figure>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-5 font-sans text-[13px] text-signal-fail">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-hairline pt-5">
        {project.reel ? (
          <a
            href={`/api/projects/${project.id}/output?download=1`}
            download
            className="inline-flex items-center gap-2 rounded-pill border border-hairline-ember bg-ember-500/10 px-4 py-2 font-sans text-[13px] text-ember-200 transition-colors duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-ember-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
          >
            <Icon name="download" size={13} />
            Save this film
          </a>
        ) : null}
        {project.reel && !project.reel.checkOk && project.reel.issues.length > 0 ? (
          <span className="font-mono text-[11px] text-signal-warn">
            {project.reel.issues.length} thing{project.reel.issues.length === 1 ? "" : "s"} to look at
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-paper-500">
          made with AI · 1080&times;1920
        </span>
      </div>
    </Panel>
  );
}
