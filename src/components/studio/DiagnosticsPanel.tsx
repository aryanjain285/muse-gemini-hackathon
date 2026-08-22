"use client";

/**
 * The show-your-work panel.
 *
 * Its job is to make the system's claims checkable rather than asserted: what was
 * spent and on what, where the music's real accents turned out to be versus where
 * the plan asked for them, and the exact manifest the composer executed. The
 * planned-versus-measured graphic is the centrepiece — it is the clearest evidence
 * that cuts follow the waveform instead of the wish.
 */
import { useMemo } from "react";
import { Badge, Button, Eyebrow, Icon, Panel, Stat, cx } from "@/components/ui/primitives";
import { formatBytes, formatSeconds } from "./useProjectStream";
import type { DiagnosticsPanelProps } from "./types";

/** Relative time, because an absolute clock tells you nothing while watching a run. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Read a possibly-missing field off an unknown object without casting blindly. */
function field(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  return (source as Record<string, unknown>)[key];
}
function numField(source: unknown, key: string): number | null {
  const v = field(source, key);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function Section({
  title,
  hint,
  open = false,
  children,
}: {
  title: string;
  hint?: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group border-t border-hairline first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3.5 outline-none focus-visible:ring-1 focus-visible:ring-ember-500/60">
        <span className="flex items-center gap-2">
          <Icon
            name="chevron"
            size={12}
            className="shrink-0 text-paper-500 transition-transform duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] group-open:rotate-90"
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-paper-400">
            {title}
          </span>
        </span>
        {hint ? <span className="font-mono text-[11px] text-paper-500">{hint}</span> : null}
      </summary>
      <div className="pb-5">{children}</div>
    </details>
  );
}

function Meter({ value, tone }: { value: number; tone: "ok" | "warn" | "fail" | "ember" }) {
  const cls =
    tone === "fail"
      ? "bg-signal-fail"
      : tone === "warn"
        ? "bg-signal-warn"
        : tone === "ok"
          ? "bg-signal-ok"
          : "bg-ember-500";
  return (
    <span className="block h-1 w-full overflow-hidden rounded-pill bg-ink-800" aria-hidden="true">
      <span
        className={cx("block h-full rounded-pill transition-[width] duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]", cls)}
        style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
      />
    </span>
  );
}

export default function DiagnosticsPanel({
  project,
  capabilities,
  ledger,
  manifest,
  onRefresh,
}: DiagnosticsPanelProps) {

  const music = project.music;
  const spec = project.spec;

  // Pair each planned event with the nearest measured anchor so the graphic can
  // draw the correction the composer actually applied.
  const pairs = useMemo(() => {
    if (!spec || !music || music.anchors.length === 0) return [];
    return spec.events.map((e) => {
      let nearest = music.anchors[0];
      let best = Math.abs(nearest - e.t);
      for (const a of music.anchors) {
        const d = Math.abs(a - e.t);
        if (d < best) {
          best = d;
          nearest = a;
        }
      }
      // Beyond half a second the composer would not snap, so do not imply it did.
      return { kind: e.kind, planned: e.t, measured: nearest, delta: best, snapped: best <= 0.5 };
    });
  }, [spec, music]);

  const durationS = spec?.durationS ?? 30;

  return (
    <Panel tone="ink" padding="md">
      <div className="mb-2 flex items-center justify-between gap-3">
        <Eyebrow tone="dim">Diagnostics</Eyebrow>
        <Button variant="quiet" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>


      {/* ── music map ────────────────────────────────────────────────────── */}
      <Section
        title="Music map"
        hint={music ? `${music.bpm ?? "?"} BPM · ${music.anchors.length} anchors` : "not yet"}
      >
        {!music ? (
          <p className="font-sans text-[12px] text-paper-500">
            The score has not been produced yet. Once it exists, this shows where its real accents
            landed against the plan.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {music.fromFallback ? (
                <Badge tone="local">local synth</Badge>
              ) : (
                <Badge tone="ok">{music.route ?? "generated"}</Badge>
              )}
              <span className="font-mono text-[11px] text-paper-400">
                {music.bpm ?? "?"} BPM · {music.durationS ? formatSeconds(music.durationS) : "?"} ·{" "}
                {music.anchors.length} measured anchors
              </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Beats matched" value={String(music.snapped ?? 0)} />
              <Stat
                label="Largest correction"
                value={music.maxDeltaS !== null ? `${Math.round(music.maxDeltaS * 1000)}` : "0"}
                unit="ms"
              />
              <Stat label="Not found" value={String(music.unmatched.length)} />
            </div>

            {music.unmatched.length > 0 ? (
              <p className="mt-3 font-sans text-[12px] leading-relaxed text-paper-400">
                <span className="font-mono text-signal-warn">
                  {music.unmatched.join(", ")}
                </span>{" "}
                had no accent close enough in the audio to cut on. The composer adds a deterministic
                impact or riser at those moments rather than spending another generation hoping for
                one.
              </p>
            ) : null}

            {/* Two lanes on one time axis. Planned above, measured below, with a
                connector wherever the composer moved a cut onto a real accent. */}
            {pairs.length > 0 ? (
              <figure className="mt-5 overflow-x-auto">
                <svg
                  viewBox="0 0 640 118"
                  className="h-[118px] w-full min-w-[30rem]"
                  role="img"
                  aria-label={`Planned event times against measured audio accents over ${durationS.toFixed(0)} seconds. ${pairs.filter((p) => p.snapped).length} of ${pairs.length} planned beats matched a real accent.`}
                >
                  <title>Planned beats versus measured accents</title>

                  {/* time axis */}
                  {Array.from({ length: Math.floor(durationS / 5) + 1 }, (_, i) => i * 5).map((t) => {
                    const x = 40 + (t / durationS) * 580;
                    return (
                      <g key={`tick-${t}`}>
                        <line x1={x} y1={22} x2={x} y2={96} stroke="var(--color-hairline)" strokeWidth="1" />
                        <text
                          x={x}
                          y={110}
                          textAnchor="middle"
                          className="font-mono"
                          fontSize="8"
                          fill="var(--color-paper-700)"
                        >
                          {t}s
                        </text>
                      </g>
                    );
                  })}

                  <text x={0} y={30} className="font-mono" fontSize="8" fill="var(--color-paper-600)">
                    planned
                  </text>
                  <text x={0} y={92} className="font-mono" fontSize="8" fill="var(--color-paper-600)">
                    measured
                  </text>

                  <line x1={40} y1={30} x2={620} y2={30} stroke="var(--color-hairline)" strokeWidth="1" />
                  <line x1={40} y1={88} x2={620} y2={88} stroke="var(--color-hairline)" strokeWidth="1" />

                  {/* every measured anchor, so the density of real hits is visible */}
                  {music.anchors.map((a, i) => (
                    <line
                      key={`anchor-${i}`}
                      x1={40 + (a / durationS) * 580}
                      y1={83}
                      x2={40 + (a / durationS) * 580}
                      y2={93}
                      stroke="var(--color-ink-600)"
                      strokeWidth="1"
                    />
                  ))}

                  {pairs.map((p, i) => {
                    const xp = 40 + (p.planned / durationS) * 580;
                    const xm = 40 + (p.measured / durationS) * 580;
                    const isDrop = p.kind === "drop";
                    const stroke = p.snapped
                      ? isDrop
                        ? "var(--color-ember-400)"
                        : "var(--color-signal-ok)"
                      : "var(--color-signal-warn)";
                    return (
                      <g key={`pair-${i}`}>
                        {p.snapped ? (
                          <line x1={xp} y1={34} x2={xm} y2={84} stroke={stroke} strokeWidth="1" opacity="0.55" />
                        ) : null}
                        <line x1={xp} y1={25} x2={xp} y2={35} stroke={stroke} strokeWidth={isDrop ? 2.5 : 1.5} />
                        {p.snapped ? (
                          <circle cx={xm} cy={88} r={isDrop ? 3 : 2} fill={stroke} />
                        ) : null}
                        {isDrop ? (
                          <text
                            x={xp}
                            y={18}
                            textAnchor="middle"
                            className="font-mono"
                            fontSize="8"
                            fill="var(--color-ember-300)"
                          >
                            drop
                          </text>
                        ) : null}
                      </g>
                    );
                  })}
                </svg>
                <figcaption className="mt-2 font-sans text-[11px] leading-relaxed text-paper-500">
                  Each planned beat is drawn on the upper lane and the accent the composer actually
                  cut on below it. A connector means the cut moved onto a measured hit; the largest
                  correction here was{" "}
                  <span className="font-mono text-paper-400">
                    {music.maxDeltaS !== null ? `${Math.round(music.maxDeltaS * 1000)}ms` : "0ms"}
                  </span>
                  .
                </figcaption>
              </figure>
            ) : null}
          </>
        )}
      </Section>

      {/* ── plan ─────────────────────────────────────────────────────────── */}
      <Section title="Plan" hint={spec ? `${spec.events.length} events` : "not yet"}>
        {!spec ? (
          <p className="font-sans text-[12px] text-paper-500">
            The plan appears once the director has written it.
          </p>
        ) : (
          <>
            <p className="font-display text-lg leading-snug text-paper-100">{spec.logline}</p>

            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {[
                ["medium", spec.medium],
                ["lighting", spec.lighting],
                ["grain", spec.grain.toFixed(2)],
                ["music", `${spec.music.mode} · ${spec.music.bpm} BPM · ${spec.music.key}`],
                ["mood", spec.music.mood],
                [
                  "instruments",
                  spec.music.instrumentation.length > 0
                    ? spec.music.instrumentation.join(", ")
                    : "unspecified",
                ],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="font-mono text-[11px] uppercase tracking-wider text-paper-500">{k}</dt>
                  <dd className="mt-0.5 break-words font-sans text-[12px] text-paper-400">{v}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-4">
              <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-paper-500">
                palette
              </p>
              <div className="flex flex-wrap gap-2">
                {spec.palette.map((p, i) => (
                  <span
                    key={`${p}-${i}`}
                    className="rounded-chip border border-hairline bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-400"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[26rem] border-collapse font-mono text-[11px]">
                <caption className="mb-2 text-left text-paper-500">Event timeline</caption>
                <thead>
                  <tr className="border-b border-hairline text-paper-500">
                    <th className="py-1 pr-3 text-right font-normal">t</th>
                    <th className="py-1 pr-3 text-left font-normal">kind</th>
                    <th className="py-1 pr-3 text-left font-normal">intensity</th>
                    <th className="py-1 text-left font-normal">visual</th>
                  </tr>
                </thead>
                <tbody>
                  {spec.events.map((e, i) => (
                    <tr key={`${e.kind}-${e.t}-${i}`} className="border-b border-hairline/50">
                      <td className="py-1 pr-3 text-right tabular-nums text-paper-300">
                        {e.t.toFixed(1)}s
                      </td>
                      <td
                        className={cx(
                          "py-1 pr-3",
                          e.kind === "drop" ? "text-ember-300" : "text-paper-400",
                        )}
                      >
                        {e.kind}
                      </td>
                      <td className="w-24 py-1 pr-3">
                        <span className="flex items-center gap-1.5">
                          <Meter value={e.intensity} tone={e.kind === "drop" ? "ember" : "ok"} />
                          <span className="shrink-0 tabular-nums text-paper-500">
                            {e.intensity.toFixed(2)}
                          </span>
                        </span>
                      </td>
                      <td className="py-1 text-paper-400">{e.visual}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      {/* ── manifest ─────────────────────────────────────────────────────── */}
      <Section title="Render manifest" hint={manifest ? "recorded" : "after first compose"}>
        {!manifest ? (
          <p className="font-sans text-[12px] leading-relaxed text-paper-500">
            A manifest is recorded the first time the composer runs. It contains every trim,
            transition, effect and content hash, which is what makes a render reproducible from the
            manifest alone.
          </p>
        ) : (
          (() => {
            const width = numField(manifest, "width");
            const height = numField(manifest, "height");
            const fps = numField(manifest, "fps");
            const dur = numField(manifest, "durationS");
            const clips = field(manifest, "clips");
            const clipCount = Array.isArray(clips) ? clips.length : null;
            const versions = field(manifest, "templateVersions");
            return (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat
                    label="Frame"
                    value={width !== null && height !== null ? `${width}×${height}` : "unknown"}
                  />
                  <Stat label="Rate" value={fps !== null ? String(fps) : "?"} unit="fps" />
                  <Stat label="Length" value={dur !== null ? dur.toFixed(2) : "?"} unit="s" />
                  <Stat label="Clips" value={clipCount !== null ? String(clipCount) : "?"} />
                </div>

                {versions && typeof versions === "object" ? (
                  <p className="mt-3 break-words font-mono text-[11px] text-paper-500">
                    template versions:{" "}
                    {Object.entries(versions as Record<string, unknown>)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(" · ")}
                  </p>
                ) : null}

                <details className="mt-4">
                  <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-wider text-paper-500 outline-none transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-paper-400 focus-visible:ring-1 focus-visible:ring-ember-500/60">
                    full manifest
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-core border border-hairline bg-ink-1000 p-3 font-mono text-[11px] leading-relaxed text-paper-500">
                    {JSON.stringify(manifest, null, 2)}
                  </pre>
                </details>
              </>
            );
          })()
        )}
      </Section>
    </Panel>
  );
}
