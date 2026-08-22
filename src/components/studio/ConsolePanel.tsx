"use client";

/**
 * The director's console: the surface an audience actually watches while a reel
 * is being made.
 *
 * Two views over the same run. "Signal" is the event log, laid out like equipment
 * telemetry — fixed columns, monospace, elapsed time rather than wall clock, so
 * scanning it feels like reading an instrument. "Director" is the agent's own
 * trace, where a tool call and its result are visually paired so the reasoning
 * reads as cause and effect.
 *
 * Auto-scroll only follows when the reader is already at the bottom. Yanking
 * someone back to the newest line while they are reading an earlier one is the
 * fastest way to make a log feel hostile.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Eyebrow,
  Icon,
  Panel,
  Progress,
  Segmented,
  cx,
} from "@/components/ui/primitives";
import type { ConsoleLine, ConsolePanelProps } from "./types";

type View = "signal" | "director";

/** Rows kept in the DOM. Beyond this the oldest are elided, and we say so. */
const RENDER_CAP = 160;

const STATE_STYLE: Record<string, { rail: string; text: string; word: string }> = {
  start: { rail: "bg-ember-500", text: "text-ember-300", word: "run" },
  done: { rail: "bg-signal-ok", text: "text-signal-ok", word: "ok" },
  fallback: { rail: "bg-signal-local", text: "text-signal-local", word: "local" },
  skip: { rail: "bg-ink-700", text: "text-paper-500", word: "skip" },
  warn: { rail: "bg-signal-warn", text: "text-signal-warn", word: "warn" },
  fail: { rail: "bg-signal-fail", text: "text-signal-fail", word: "fail" },
  error: { rail: "bg-signal-fail", text: "text-signal-fail", word: "err" },
  info: { rail: "bg-ink-700", text: "text-paper-400", word: "info" },
};

function styleFor(state: string) {
  return STATE_STYLE[state] ?? STATE_STYLE.info;
}

/** Elapsed seconds since the run's first line, so the log reads as a stopwatch. */
function elapsed(line: ConsoleLine, originMs: number): string {
  const ms = new Date(line.at).getTime() - originMs;
  const s = Math.max(0, ms) / 1000;
  return `+${s.toFixed(1)}s`;
}

export default function ConsolePanel({
  lines,
  agentSteps,
  project,
  progress,
  connected,
  onClear,
}: ConsolePanelProps) {
  const [view, setView] = useState<View>("signal");
  const [pinned, setPinned] = useState(true);
  const logRef = useRef<HTMLDivElement | null>(null);

  const originMs = useMemo(
    () => (lines.length > 0 ? new Date(lines[0].at).getTime() : Date.now()),
    [lines],
  );

  const hidden = Math.max(0, lines.length - RENDER_CAP);
  const visible = hidden > 0 ? lines.slice(-RENDER_CAP) : lines;

  // Follow the tail only while the reader is already there.
  useEffect(() => {
    const el = logRef.current;
    if (!el || !pinned || view !== "signal") return;
    el.scrollTop = el.scrollHeight;
  }, [visible.length, pinned, view]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom !== pinned) setPinned(atBottom);
  };

  const jumpToLatest = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  };

  const statusTone =
    project.status === "READY"
      ? "ok"
      : project.status === "FAILED"
        ? "fail"
        : project.status === "DRAFT"
          ? "neutral"
          : "live";


  return (
    <Panel tone="ink" padding="md">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* A record light is the one place a pulse is the right metaphor. */}
          <span className="flex items-center gap-2">
            <span
              className={cx(
                "h-1.5 w-1.5 rounded-pill",
                project.running ? "bg-signal-live animate-[muse-pulse_1.8s_var(--ease-drift)_infinite]" : "bg-ink-700",
              )}
              aria-hidden="true"
            />
            <Eyebrow tone={project.running ? "ember" : "dim"}>Director&rsquo;s console</Eyebrow>
          </span>
          <Badge tone={statusTone}>{project.status}</Badge>
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-paper-500">
            {connected ? "stream live" : "stream idle"}
          </span>
          <Segmented
            label="Console view"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "signal", label: "Signal", detail: `${lines.length}` },
              { value: "director", label: "Director", detail: `${agentSteps.length}` },
            ]}
          />
          {lines.length > 0 ? (
            <Button variant="quiet" size="sm" onClick={onClear}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {progress ? (
        <div className="mb-5">
          <div className="mb-2 flex items-baseline justify-between font-mono text-[11px] text-paper-400">
            <span>{progress.label}</span>
            <span className="tabular-nums">{Math.round(progress.fraction * 100)}%</span>
          </div>
          <Progress value={progress.fraction} tone="ember" label={`Composing: ${progress.label}`} />
        </div>
      ) : null}

      {view === "signal" ? (
        <div className="relative">
          <div
            ref={logRef}
            onScroll={onScroll}
            aria-live="polite"
            aria-label="Run event log"
            className="max-h-[26rem] min-h-[9rem] overflow-y-auto overflow-x-auto rounded-core border border-hairline bg-ink-1000/60"
          >
            {hidden > 0 ? (
              <p className="border-b border-hairline px-3 py-2 font-mono text-[11px] text-paper-500">
                {hidden} earlier {hidden === 1 ? "line" : "lines"} not shown
              </p>
            ) : null}

            {visible.length === 0 ? (
              <p className="px-3 py-8 text-center font-sans text-[12px] text-paper-500">
                Nothing has run yet. Start a film and every stage, route and fallback appears here
                as it happens.
              </p>
            ) : (
              <ol className="list-none">
                {visible.map((line, i) => {
                  const s = styleFor(line.state);
                  // A divider whenever the channel changes turns a flat log into
                  // scannable sections without adding headings.
                  const newGroup = i === 0 || visible[i - 1].channel !== line.channel;
                  return (
                    <li
                      key={line.id}
                      className={cx(
                        "flex items-start gap-0 font-mono text-[11px]",
                        newGroup && i > 0 ? "border-t border-hairline" : "",
                      )}
                    >
                      <span className={cx("mt-[7px] mb-[7px] ml-2 w-0.5 shrink-0 self-stretch rounded-pill", s.rail)} aria-hidden="true" />
                      <span className="w-[4.2rem] shrink-0 py-1.5 pl-2 tabular-nums text-paper-500">
                        {elapsed(line, originMs)}
                      </span>
                      <span className={cx("w-[3.2rem] shrink-0 py-1.5 uppercase tracking-wide", s.text)}>
                        {s.word}
                      </span>
                      {/* Hidden on a narrow panel: the channel is the least useful of the four columns, and 6rem of
                          it was coming out of the message. */}
                      <span className="hidden w-[6rem] shrink-0 py-1.5 text-paper-500 sm:block">{line.channel}</span>
                      <span className="w-[7rem] shrink-0 truncate py-1.5 text-paper-200 lg:w-[10rem]">{line.label}</span>
                      <span className="min-w-0 flex-1 py-1.5 pr-3 break-words text-paper-400">
                        {line.detail}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          {!pinned && visible.length > 0 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
              <span className="pointer-events-auto">
                <Button variant="ghost" size="sm" onClick={jumpToLatest}>
                  Jump to latest
                </Button>
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <div
          aria-live="polite"
          aria-label="Director agent transcript"
          className="max-h-[26rem] min-h-[9rem] overflow-y-auto rounded-core border border-hairline bg-ink-1000/60 px-3 py-3"
        >
          {agentSteps.length === 0 ? (
            <p className="px-1 py-6 text-center font-sans text-[12px] leading-relaxed text-paper-500">
              The agent transcript appears when a run is driven by the director agent. Runs started
              with <span className="font-mono text-paper-400">Direct this film</span> use the fixed
              pipeline instead and report into Signal.
            </p>
          ) : (
            <>
              {agentSteps.length > 0 ? (
                <p className="mb-3 font-mono text-[11px] text-paper-500">
                  {agentSteps.length} steps this run
                </p>
              ) : null}
              <ol className="relative list-none border-l border-hairline pl-4">
                {agentSteps.map((step) => {
                  const isResult = step.kind === "tool_result";
                  const isCall = step.kind === "tool_call";
                  const isThought = step.kind === "thought";
                  const isError = step.kind === "error";
                  return (
                    <li
                      key={step.seq}
                      className={cx("relative mb-2.5 last:mb-0", isResult ? "ml-4" : "")}
                    >
                      {/* The spine node marks where a step attaches to the trace. */}
                      <span
                        className={cx(
                          "absolute top-2.5 h-1.5 w-1.5 rounded-pill",
                          isResult ? "-left-[1.3rem]" : "-left-[1.3rem]",
                          isError
                            ? "bg-signal-fail"
                            : isCall
                              ? "bg-ember-500"
                              : isThought
                                ? "bg-ink-600"
                                : "bg-signal-ok",
                        )}
                        aria-hidden="true"
                      />
                      <div
                        className={cx(
                          "rounded-core border px-3 py-2",
                          isError
                            ? "border-signal-fail/40 bg-signal-fail/5"
                            : isCall
                              ? "border-hairline-ember bg-ember-500/5"
                              : "border-hairline bg-ink-900/50",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            {isCall ? (
                              <span className="inline-flex items-center gap-1.5">
                                <Icon name="wand" size={11} className="shrink-0 text-ember-400" />
                                <span className="rounded-chip bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-ember-200">
                                  {step.name}
                                </span>
                              </span>
                            ) : isThought ? (
                              <span className="inline-flex items-center gap-1.5">
                                <Icon name="sparkle" size={11} className="shrink-0 text-paper-500" />
                                <span className="font-mono text-[11px] uppercase tracking-wide text-paper-500">
                                  reasoning
                                </span>
                              </span>
                            ) : isError ? (
                              <span className="inline-flex items-center gap-1.5">
                                <Icon name="alert" size={11} className="shrink-0 text-signal-fail" />
                                <span className="font-mono text-[11px] text-signal-fail">
                                  {step.name || "error"}
                                </span>
                              </span>
                            ) : (
                              <span className="font-mono text-[11px] uppercase tracking-wide text-paper-500">
                                {step.kind === "message" ? "note" : step.name}
                              </span>
                            )}

                            <p
                              className={cx(
                                "mt-1 break-words font-sans text-[12px] leading-relaxed",
                                isThought
                                  ? "italic text-paper-400"
                                  : isError
                                    ? "text-signal-fail"
                                    : "text-paper-300",
                              )}
                            >
                              {step.summary}
                            </p>
                          </div>

                        </div>

                        <details className="mt-1.5 group">
                          <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-wider text-paper-500 outline-none transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-paper-400 focus-visible:ring-1 focus-visible:ring-ember-500/60">
                            payload
                          </summary>
                          <pre className="mt-1.5 max-h-40 overflow-auto rounded-chip bg-ink-1000 p-2 font-mono text-[11px] leading-relaxed text-paper-500">
                            {JSON.stringify(step.payload, null, 2)}
                          </pre>
                        </details>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
