"use client";

/**
 * Storyboard and shot inspector.
 *
 * The claim this panel has to make in front of a room is that MUSE planned a
 * film rather than generated clips, so everything here is framed as production
 * paperwork: a filmstrip of the plan, one shot on a slate, and the critic's
 * reading of that shot with its numbers left visible. Nothing is smoothed over
 * - a fallback says it was a fallback, and a weak score is drawn short of the
 * pass line, because a console that hides its failures cannot be believed
 * about its successes.
 *
 * Presentational only. Every value arrives on props and every action leaves
 * through a callback.
 */

import * as React from "react";

import type { ScenePanelProps, SceneView } from "@/components/studio/types";
import { formatSeconds } from "@/components/studio/useProjectStream";
import {
  Badge,
  Button,
  Display,
  Eyebrow,
  Icon,
  Meta,
  Panel,
  Spinner,
  Stat,
  cx,
  pct,
  useDomId,
  type BadgeTone,
  type IconName,
} from "@/components/ui/primitives";
import { SceneStrip, type StripScene } from "@/components/ui/timeline";
import { shotSizeLabel } from "@/lib/brand";

// ── vocabulary ───────────────────────────────────────────────────────────────

/** The same five words the timeline uses, so one shot reads identically twice. */
const STATUS: Record<SceneView["status"], { word: string; tone: BadgeTone; icon: IconName }> = {
  pending: { word: "Queued", tone: "neutral", icon: "frame" },
  running: { word: "Rendering", tone: "live", icon: "waveform" },
  done: { word: "Ready", tone: "ok", icon: "check" },
  fallback: { word: "Local", tone: "local", icon: "wand" },
  failed: { word: "Failed", tone: "fail", icon: "alert" },
};

/** Critic verdicts, each with the sentence a judge needs in order to read it. */
const DECISION: Record<string, { tone: BadgeTone; note: string }> = {
  PASS: { tone: "ok", note: "The critic approved this shot as rendered." },
  RETRY: { tone: "warn", note: "The critic asked for another attempt at this shot." },
  FALLBACK: { tone: "fail", note: "The critic handed this shot to the local composer." },
};

const UNKNOWN_DECISION: { tone: BadgeTone; note: string } = {
  tone: "neutral",
  note: "The critic returned a verdict this console does not recognise.",
};

/** Drawn in this order because it is the order the critic reasons in. */
const SCORE_KEYS = ["identity", "continuity", "motion", "adherence", "composition"] as const;

/** At or above the pass line a score reads as sound; below the weak line, poor. */
const PASS_LINE = 0.75;
const WEAK_LINE = 0.55;

type ScoreTone = "ok" | "warn" | "fail";

function scoreTone(value: number): ScoreTone {
  if (value >= PASS_LINE) return "ok";
  if (value >= WEAK_LINE) return "warn";
  return "fail";
}

const SCORE_BAR: Record<ScoreTone, string> = {
  ok: "bg-signal-ok",
  warn: "bg-signal-warn",
  fail: "bg-signal-fail",
};

const SCORE_TEXT: Record<ScoreTone, string> = {
  ok: "text-signal-ok",
  warn: "text-signal-warn",
  fail: "text-signal-fail",
};

/** Colour is reinforcement: the figure and the glyph carry the reading. */
const SCORE_WORD: Record<ScoreTone, string> = { ok: "sound", warn: "weak", fail: "poor" };
const SCORE_GLYPH: Record<ScoreTone, IconName> = { ok: "check", warn: "alert", fail: "close" };

/** `hero_drop` has to read as "hero drop" from the back of the room. */
function humanise(value: string): string {
  return value.replace(/[_-]+/g, " ").trim();
}

/** Plan text can legitimately arrive blank; say so rather than leaving a gap. */
function prose(value: string, absent: string): string {
  return value.trim().length > 0 ? value.trim() : absent;
}

// ── score meter ──────────────────────────────────────────────────────────────

interface ScoreMeterProps {
  name: string;
  value: number;
}

/**
 * One critic axis: a name, a thin bar and the figure in mono, so a column of
 * scores cannot jitter as new verdicts land. The tick sitting at the pass line
 * turns "short" into geometry, which survives a projector with a crushed gamut
 * better than any difference in hue.
 */
function ScoreMeter({ name, value }: ScoreMeterProps) {
  const labelId = useDomId("score");
  const v = Math.min(1, Math.max(0, value));
  const tone = scoreTone(v);

  return (
    <li className="flex items-center gap-3">
      <span
        id={labelId}
        className="w-24 shrink-0 truncate font-mono text-micro uppercase tracking-meta text-paper-400"
      >
        {humanise(name)}
      </span>
      <span
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(v.toFixed(2))}
        aria-valuetext={`${v.toFixed(2)} of 1, ${SCORE_WORD[tone]}`}
        className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-pill bg-ink-800 shadow-well"
      >
        <span
          className={cx(
            "block h-full w-full origin-left rounded-pill transition-transform duration-500 ease-entrance",
            SCORE_BAR[tone],
          )}
          style={{ transform: `scaleX(${v.toFixed(4)})` }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-hair bg-paper-500"
          style={{ left: pct(PASS_LINE) }}
        />
      </span>
      <span
        className={cx(
          "flex w-16 shrink-0 items-center justify-end gap-1.5 tabular font-mono text-meta",
          SCORE_TEXT[tone],
        )}
      >
        <Icon name={SCORE_GLYPH[tone]} size={10} />
        {v.toFixed(2)}
      </span>
    </li>
  );
}

// ── panel ────────────────────────────────────────────────────────────────────

export default function ScenePanel({
  project,
  selectedSceneId,
  onSelectScene,
  onRegenerate,
  action,
  busySceneId,
}: ScenePanelProps) {
  const headingId = useDomId("storyboard");
  const inspectorId = useDomId("inspector");
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  // The shot loops so it moves in front of the judges, but a loop nobody can
  // stop is not acceptable: this is a real control, and it starts switched off
  // for anyone who asked the system for less motion.
  const [playing, setPlaying] = React.useState(true);

  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setPlaying(!query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const spec = project.spec;
  const scenes = project.scenes;

  // The inspector always has a subject once there are scenes: an unset
  // selection shows the opening shot rather than an empty right-hand column.
  const selected: SceneView | null =
    scenes.find((s) => s.id === selectedSceneId) ?? (scenes.length > 0 ? scenes[0] : null);
  const clipUrl = selected?.clipUrl ?? null;

  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (playing) {
      // A rejected play() only means the browser declined autoplay; the poster
      // still stands in for the shot, so there is nothing to recover from.
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, [playing, clipUrl]);

  // ── no plan yet ────────────────────────────────────────────────────────────

  if (!spec) {
    return (
      <section aria-labelledby={headingId} className="flex w-full min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Eyebrow>Storyboard</Eyebrow>
          <span role="status" aria-live="polite">
            {project.running ? (
              <Badge tone="live">{humanise(project.runningKind ?? "working")}</Badge>
            ) : null}
          </span>
        </div>
        <Panel tone="ink" padding="lg">
          <div className="flex flex-col items-start gap-3">
            <span className="text-paper-400">
              <Icon name="film" size={24} />
            </span>
            <Display level={3} id={headingId}>
              The storyboard appears once the director has written the plan.
            </Display>
            <p className="max-w-prose text-body text-paper-300">
              Shots, camera moves and cut points are all decided before a single frame is
              rendered. This panel fills in with the plan, not with progress.
            </p>
          </div>
        </Panel>
      </section>
    );
  }

  // ── plan identity ──────────────────────────────────────────────────────────

  const identity: { label: string; value: string }[] = [
    { label: "Plan", value: project.specVersion === null ? "draft" : `v${project.specVersion}` },
    { label: "Scenes", value: String(scenes.length).padStart(2, "0") },
    { label: "Runtime", value: formatSeconds(spec.durationS) },
    { label: "Preset", value: humanise(spec.preset) },
  ];

  const strip: StripScene[] = scenes.map((s) => ({
    id: s.id,
    label: `${s.id} · ${humanise(s.purpose)}`,
    thumbUrl: s.keyframeUrl ?? undefined,
    status: s.status,
    durationS: s.durationS,
  }));

  const title = prose(spec.title, prose(project.title, "Untitled reel"));

  // ── selected shot ──────────────────────────────────────────────────────────

  const status = selected ? STATUS[selected.status] : null;
  const shotNumber = selected ? scenes.findIndex((s) => s.id === selected.id) + 1 : 0;
  const qc = selected?.qc ?? null;
  const decision = qc ? (DECISION[qc.decision] ?? UNKNOWN_DECISION) : null;

  // Known axes first, then anything else the critic reported, so an added score
  // shows up rather than silently vanishing.
  const meters: { name: string; value: number }[] = [];
  if (qc) {
    for (const key of SCORE_KEYS) {
      const v = qc.scores[key];
      if (typeof v === "number") meters.push({ name: key, value: v });
    }
    for (const [key, v] of Object.entries(qc.scores)) {
      const known = (SCORE_KEYS as readonly string[]).includes(key);
      if (!known && typeof v === "number") meters.push({ name: key, value: v });
    }
  }

  const sceneBusy = selected !== null && busySceneId === selected.id;
  const blocked = action.busy || project.running;

  const motionCaption = selected
    ? clipUrl
      ? selected.generated
        ? "Generated motion. A video model animated this keyframe."
        : "Deterministic camera work. The local composer moved this still along a fixed path."
      : selected.generated
        ? "Generated motion planned. A video model will animate this keyframe."
        : "Deterministic camera work planned. The local composer will move this still."
    : "";

  return (
    <section aria-labelledby={headingId} className="flex w-full min-w-0 flex-col gap-5">
      {/* Plan identity. */}
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow>Storyboard</Eyebrow>
            <span role="status" aria-live="polite">
              {project.running ? (
                <Badge tone="live">{humanise(project.runningKind ?? "working")}</Badge>
              ) : null}
            </span>
          </div>
          <Display level={3} id={headingId}>
            {title}
          </Display>
          <p className="max-w-prose text-label text-paper-300">
            {prose(spec.logline, "No logline was written for this plan.")}
          </p>
        </div>
        <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-3 font-mono">
          {identity.map((row) => (
            <div key={row.label} className="flex flex-col gap-1">
              <dt className="text-micro uppercase tracking-console text-paper-400">{row.label}</dt>
              <dd className="tabular text-meta text-paper-100">{row.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      {/* Filmstrip. It scrolls inside itself; the page never scrolls sideways. */}
      <Panel tone="ink" padding="sm">
        {scenes.length > 0 ? (
          <SceneStrip scenes={strip} selectedId={selected?.id} onSelect={onSelectScene} />
        ) : (
          <p className="py-6 text-center font-mono text-meta uppercase tracking-console text-paper-400">
            the plan carries no shots yet
          </p>
        )}
      </Panel>

      {/* Inspector. */}
      {selected && status ? (
        <Panel tone="raised" padding="md">
          <section aria-labelledby={inspectorId} className="flex flex-col gap-5">
            <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="tabular font-mono text-micro uppercase tracking-console text-paper-400">
                  Shot {String(shotNumber).padStart(2, "0")} of{" "}
                  {String(scenes.length).padStart(2, "0")} · {selected.id}
                </span>
                <Display level={3} id={inspectorId}>
                  {prose(selected.title ?? "", humanise(selected.purpose))}
                </Display>
              </div>
              <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2.5">
                <Badge tone={status.tone}>{status.word}</Badge>
                <span className="tabular font-mono text-meta text-paper-400">
                  {selected.attempts === 0 ? "no attempt yet" : `attempt ${selected.attempts}`}
                </span>
              </div>
            </header>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
              {/* The frame, on a slate. */}
              <figure className="flex w-full max-w-80 flex-col gap-2.5">
                <div className="rounded-shell border border-hairline bg-ink-900 p-bezel">
                  <div className="overflow-hidden rounded-core bg-ink-950 shadow-core">
                    <div className="sprocket-edges bg-ink-750 py-bezel-lg">
                      <div
                        className={cx(
                          "relative aspect-[9/16] w-full overflow-hidden bg-ink-1000",
                          selected.status === "running" && "scanning",
                        )}
                      >
                        {clipUrl ? (
                          <video
                            ref={videoRef}
                            src={clipUrl}
                            poster={selected.keyframeUrl ?? undefined}
                            muted
                            loop
                            playsInline
                            autoPlay={playing}
                            preload="metadata"
                            aria-label={`Shot ${selected.id}, silent looping preview`}
                            className="size-full object-cover"
                          />
                        ) : selected.keyframeUrl ? (
                          <img
                            src={selected.keyframeUrl}
                            alt={`Keyframe for shot ${selected.id}: ${prose(selected.action, humanise(selected.purpose))}`}
                            draggable={false}
                            className="size-full object-cover"
                          />
                        ) : (
                          <div className="flex size-full flex-col items-center justify-center gap-2 text-paper-400">
                            <Icon name={status.icon} size={26} />
                            <span className="font-mono text-micro uppercase tracking-console">
                              {selected.status === "running" ? "rendering" : "no frame yet"}
                            </span>
                          </div>
                        )}

                        {clipUrl ? (
                          <div className="absolute right-2 bottom-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setPlaying((p) => !p)}
                              aria-label={
                                playing ? "Pause the shot preview" : "Play the shot preview"
                              }
                            >
                              <Icon name={playing ? "pause" : "play"} size={12} />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                <figcaption className="flex items-start gap-2 font-mono text-meta text-paper-300">
                  <span className="mt-0.5 text-paper-400">
                    <Icon name={clipUrl && selected.generated ? "sparkle" : "film"} size={12} />
                  </span>
                  <span>{motionCaption}</span>
                </figcaption>
              </figure>

              {/* The slate. */}
              <div className="flex min-w-0 flex-col gap-5">
                <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2 2xl:grid-cols-3">
                  <Meta
                    label="Window"
                    value={`${formatSeconds(selected.startS)} → ${formatSeconds(selected.endS)}`}
                  />
                  <Meta label="Duration" value={formatSeconds(selected.durationS)} accent />
                  <Meta label="Clip" value={formatSeconds(selected.clipDurationS)} />
                  <Meta label="Purpose" value={humanise(selected.purpose)} />
                  <Meta label="Render" value={humanise(selected.renderMode)} />
                  <Meta label="Shot" value={shotSizeLabel(selected.shotSize)} />
                  <Meta label="Camera" value={humanise(selected.camera)} />
                  <Meta label="Transition in" value={humanise(selected.transitionIn)} />
                  <Meta
                    label="Route"
                    value={<span className="break-all">{selected.route ?? "local composer"}</span>}
                  />
                  <Meta label="Attempts" value={String(selected.attempts)} />
                </div>

                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-micro uppercase tracking-console text-paper-400">
                      Action
                    </span>
                    <p className="max-w-prose text-body text-paper-100">
                      {prose(selected.action, "The plan left this shot's action unwritten.")}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-micro uppercase tracking-console text-paper-400">
                      Setting
                    </span>
                    <p className="max-w-prose text-body text-paper-200">
                      {prose(selected.setting, "The plan left this shot's setting unwritten.")}
                    </p>
                  </div>
                </div>

                {/* Critic. */}
                {qc && decision ? (
                  <Panel tone="ink" padding="sm">
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Eyebrow tone="ember">Critic</Eyebrow>
                        <Badge tone={decision.tone}>{qc.decision}</Badge>
                        <Badge tone="neutral">
                          {qc.source === "gemini" ? "Gemini vision" : humanise(qc.source)}
                        </Badge>
                      </div>
                      <p className="max-w-prose text-label text-paper-300">{decision.note}</p>

                      <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start sm:gap-8">
                        <Stat
                          label="Overall"
                          value={qc.overall.toFixed(2)}
                          hint={`pass line ${PASS_LINE.toFixed(2)}`}
                        />
                        {meters.length > 0 ? (
                          <ul className="flex list-none flex-col gap-2.5">
                            {meters.map((m) => (
                              <ScoreMeter key={m.name} name={m.name} value={m.value} />
                            ))}
                          </ul>
                        ) : (
                          <p className="font-mono text-meta text-paper-400">
                            No per-axis scores were recorded for this verdict.
                          </p>
                        )}
                      </div>

                      <figure className="flex flex-col gap-1.5">
                        <span className="font-mono text-micro uppercase tracking-console text-paper-400">
                          Repair instruction
                        </span>
                        <blockquote className="max-w-prose border-l border-hairline-strong pl-3 text-body text-paper-200">
                          {`“${prose(qc.repairInstruction, "no change requested")}”`}
                        </blockquote>
                      </figure>
                    </div>
                  </Panel>
                ) : (
                  <p className="font-mono text-meta text-paper-400">
                    The critic has not scored this shot yet.
                  </p>
                )}

                {/* Fallbacks are stated, never absorbed. */}
                {selected.fallbackReason ? (
                  <Panel tone="ink" padding="sm">
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Eyebrow>Fallback</Eyebrow>
                        <Badge tone="local">Local render</Badge>
                      </div>
                      <p className="max-w-prose text-body text-paper-200">
                        {selected.fallbackReason}
                      </p>
                      <p className="max-w-prose font-mono text-meta text-paper-400">
                        Reported rather than hidden: this shot exists because the local engine
                        covered for the model.
                      </p>
                    </div>
                  </Panel>
                ) : null}
              </div>
            </div>

            {/* Regenerate. */}
            <div className="flex flex-col gap-2.5 border-t border-hairline pt-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
                <Button
                  variant="primary"
                  trailingIcon="retry"
                  loading={sceneBusy}
                  disabled={blocked}
                  onClick={() => onRegenerate(selected.id)}
                >
                  Regenerate this scene
                </Button>
                {sceneBusy ? (
                  <span
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 font-mono text-meta text-ember-200"
                  >
                    <Spinner size={13} />
                    re-rendering {selected.id}
                  </span>
                ) : project.running ? (
                  <span className="font-mono text-meta text-paper-400">
                    the pipeline is running — regeneration waits for it to finish
                  </span>
                ) : action.busy ? (
                  <span className="flex items-center gap-2 font-mono text-meta text-paper-400">
                    <Spinner size={13} />
                    another change is in flight
                  </span>
                ) : null}
              </div>
              <p className="max-w-prose font-mono text-meta text-paper-400">
                Regenerating re-renders only this scene and recomposes the reel. Every other shot
                is left exactly as it is.
              </p>
              {action.error ? (
                <p
                  role="alert"
                  className="flex max-w-prose items-start gap-2 font-mono text-meta text-signal-fail"
                >
                  <span className="mt-0.5">
                    <Icon name="alert" size={12} />
                  </span>
                  {action.error}
                </p>
              ) : null}
            </div>
          </section>
        </Panel>
      ) : null}
    </section>
  );
}
