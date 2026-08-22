"use client";

/**
 * The screening room.
 *
 * MUSE plans the film, makes it, and then watches it. This is where that last part
 * surfaces: notes on the finished edit rather than on any one shot, each one carrying
 * the change it would take to answer it.
 *
 * The notes are the content, so they get the space and the type. Everything else stays
 * out of the way.
 */
import { useCallback, useState } from "react";
import { Badge, Button, Eyebrow, Icon, Panel, Spinner } from "@/components/ui/primitives";

export interface ScreeningFixView {
  kind: "recut" | "reframe" | "none";
  edit?: string;
  sceneId?: string;
  shotSize?: string;
  label: string;
}

export interface ScreeningNoteView {
  topic: string;
  note: string;
  sceneIds: string[];
  fix: ScreeningFixView;
}

export interface ScreeningView {
  working: string;
  notes: ScreeningNoteView[];
  createdAt: string;
}

/** Each topic gets a word a person would use, not the enum. */
const TOPIC: Record<string, string> = {
  pacing: "Pacing",
  coverage: "Coverage",
  continuity: "Continuity",
  payoff: "The payoff",
  sound: "Against the music",
};

export default function ScreeningPanel({
  projectId,
  screening,
  canScreen,
  busy,
  onChanged,
}: {
  projectId: string;
  screening: ScreeningView | null;
  canScreen: boolean;
  busy: boolean;
  onChanged: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const screen = useCallback(async () => {
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/screening`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "the screening could not be run");
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [projectId, onChanged]);

  const apply = useCallback(
    async (index: number, label: string) => {
      setApplying(index);
      setError(null);
      setDone(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/screening/apply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ noteIndex: index }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          applied?: boolean;
          reason?: string;
        };
        if (!res.ok) throw new Error(body.error ?? "that change could not be made");
        // A 200 can still carry applied:false — a patch the spec module refused, or a
        // change that could not be started because the project is busy. Reporting that
        // as done is the one outcome worse than an error: the note looks answered and
        // the film has not moved.
        if (body.applied === false) {
          throw new Error(body.reason ?? "that change was refused");
        }
        setDone(label);
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setApplying(null);
      }
    },
    [projectId, onChanged],
  );

  return (
    <Panel tone="raised" padding="lg">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Eyebrow tone="ember">Screening room</Eyebrow>
          <p className="mt-2 max-w-md font-sans text-[13px] leading-relaxed text-paper-400">
            MUSE watches the film it just made and says what it would change.
          </p>
        </div>
        <Button
          onClick={screen}
          disabled={!canScreen || running || busy}
          variant={screening ? "quiet" : "primary"}
        >
          {running ? <Spinner size={13} /> : <Icon name="film" size={14} />}
          {running ? "Watching" : screening ? "Watch again" : "Watch the film"}
        </Button>
      </div>

      {!canScreen ? (
        <p className="font-sans text-[13px] text-paper-500">
          There is no finished film to watch yet.
        </p>
      ) : null}

      {error ? (
        <p className="mb-4 font-sans text-[13px] text-signal-fail">{error}</p>
      ) : null}
      {done ? (
        <p className="mb-4 font-sans text-[13px] text-signal-ok">{done} — done.</p>
      ) : null}

      {screening ? (
        <>
          {screening.working ? (
            <p className="mb-7 max-w-2xl font-display text-[clamp(1.05rem,1.7vw,1.35rem)] leading-snug tracking-[-0.01em] text-paper-100">
              {screening.working}
            </p>
          ) : null}

          {screening.notes.length === 0 ? (
            <p className="font-sans text-[13px] text-paper-400">
              Nothing it would change.
            </p>
          ) : (
            <ol className="flex list-none flex-col gap-3">
              {screening.notes.map((n, i) => (
                <li
                  key={`${n.topic}-${i}`}
                  className="rounded-core border border-hairline bg-ink-950/50 p-4 transition-colors duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-hairline-strong"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-ember-300">
                      {TOPIC[n.topic] ?? n.topic}
                    </span>
                    {n.sceneIds.map((id) => (
                      <Badge key={id} tone="neutral">
                        {id}
                      </Badge>
                    ))}
                  </div>

                  <p className="font-sans text-[14px] leading-relaxed text-paper-150">{n.note}</p>

                  {n.fix.kind !== "none" && n.fix.label ? (
                    <div className="mt-3">
                      <Button
                        variant="quiet"
                        onClick={() => void apply(i, n.fix.label)}
                        disabled={applying !== null || busy}
                      >
                        {applying === i ? <Spinner size={12} /> : <Icon name="wand" size={13} />}
                        {n.fix.label}
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-3 font-mono text-[11px] text-paper-500">
                      Nothing to press — this one needs a different plan.
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </Panel>
  );
}
