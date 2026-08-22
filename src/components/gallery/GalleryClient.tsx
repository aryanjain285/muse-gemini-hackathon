"use client";

/**
 * The gallery. Films, their shots, and their scores.
 *
 * Deliberately quiet: a poster, a title, a length, a date. Everything else appears
 * only when a film is opened, and even then in film language rather than in the
 * names the pipeline uses internally.
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { Badge, Button, Icon, cx } from "@/components/ui/primitives";
import {
  ago,
  cameraLabel,
  duration,
  fileSize,
  filmStatus,
  purposeLabel,
  reviewLabel,
  shotSizeLabel,
} from "@/lib/brand";

/**
 * The shapes come from the view model rather than being restated here. They were
 * restated once, and the two copies drifted the moment a field was added on one
 * side only. `import type` is erased at build time, so nothing server-side is
 * pulled into the client bundle.
 */
export type { FilmView, ShotView } from "@/lib/server/gallery";
import type { FilmView } from "@/lib/server/gallery";
import type { ShotView } from "@/lib/server/gallery";

export interface GalleryClientProps {
  films: FilmView[];
  totals: { films: number; ready: number; shots: number; bytes: number };
}

type Tab = "all" | "ready" | "working";

function Shot({ shot }: { shot: ShotView }) {
  const [playing, setPlaying] = useState(false);
  const media = playing && shot.takeUrl ? shot.takeUrl : null;

  return (
    <li className="w-[132px] shrink-0">
      <button
        type="button"
        onClick={() => setPlaying((v) => !v)}
        disabled={!shot.takeUrl}
        aria-label={
          shot.takeUrl
            ? `${playing ? "Stop" : "Play"} shot ${shot.number}, ${purposeLabel(shot.purpose)}`
            : `Shot ${shot.number}, ${purposeLabel(shot.purpose)}`
        }
        className="group relative block w-full overflow-hidden rounded-core border border-hairline bg-ink-1000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
      >
        <span className="block aspect-[9/16]">
          {media ? (
            <video src={media} autoPlay loop muted playsInline className="h-full w-full object-cover" />
          ) : shot.frameUrl ? (
            <img
              src={shot.frameUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-[1.04]"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center">
              <Icon name="film" size={16} className="text-paper-500" />
            </span>
          )}
        </span>

        {shot.takeUrl && !playing ? (
          <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:opacity-100">
            <span className="flex h-8 w-8 items-center justify-center rounded-pill bg-ink-1000/80">
              <Icon name="play" size={13} className="text-paper-50" />
            </span>
          </span>
        ) : null}

        <span className="absolute left-1.5 top-1.5 rounded-chip bg-ink-1000/85 px-1.5 py-0.5 font-mono text-[11px] text-paper-100">
          {shot.number}
        </span>
      </button>

      <p className="mt-2 font-sans text-[12px] text-paper-200">{purposeLabel(shot.purpose)}</p>
      <p className="font-mono text-[11px] text-paper-500">
        {duration(shot.durationS)} · {shotSizeLabel(shot.shotSize)}, {cameraLabel(shot.camera)}
      </p>
    </li>
  );
}

function Film({ film }: { film: FilmView }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [gone, setGone] = useState(false);
  const status = filmStatus(film.status);
  const isReady = Boolean(film.reelUrl);

  const remove = useCallback(async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setRemoving(true);
    try {
      const res = await fetch(`/api/projects/${film.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("could not remove");
      setGone(true);
    } catch {
      setRemoving(false);
      setConfirming(false);
    }
  }, [confirming, film.id]);

  // Drop it from the list immediately rather than re-fetching the page: the row is gone
  // on the server and leaving it on screen would invite a second press.
  if (gone) return null;

  return (
    <li className="rounded-shell border border-hairline bg-ink-900/50 p-1.5 transition-colors duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-hairline-strong">
      <div className="flex flex-col gap-4 rounded-core bg-ink-950/60 p-4 sm:flex-row">
        {/* The poster is the film's face, so it leads. */}
        <div className="w-full shrink-0 sm:w-[168px]">
          <div className="relative overflow-hidden rounded-core-sm border border-hairline bg-ink-1000">
            <div className="aspect-[9/16]">
              {isReady && film.reelUrl ? (
                <video
                  src={film.reelUrl}
                  poster={film.posterUrl ?? undefined}
                  controls
                  preload="metadata"
                  playsInline
                  className="h-full w-full object-cover"
                />
              ) : film.posterUrl ? (
                <img src={film.posterUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Icon name="film" size={20} className="text-paper-500" />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate font-display text-2xl leading-tight text-paper-50">
                {film.title}
              </h2>
              <p className="mt-1 font-mono text-[11px] text-paper-500">
                {film.durationS ? `${duration(film.durationS)} · ` : ""}
                {ago(film.createdAt)}
              </p>
            </div>
            {isReady ? <Badge tone="ok">{status.label}</Badge> : <Badge tone={status.tone}>{status.label}</Badge>}
          </div>

          {film.brief ? (
            <p className="max-w-prose font-sans text-[13px] leading-relaxed text-paper-300">
              &ldquo;{film.brief}&rdquo;
            </p>
          ) : film.logline ? (
            <p className="max-w-prose font-sans text-[13px] leading-relaxed text-paper-300">
              {film.logline}
            </p>
          ) : null}

          <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
            {film.shots.length > 0 ? (
              <Button variant="quiet" size="sm" onClick={() => setOpen((v) => !v)}>
                {open ? "Hide shots" : `${film.shots.length} shots`}
              </Button>
            ) : null}
            <Link
              href={`/studio/${film.id}`}
              className="rounded-pill border border-hairline px-3 py-1.5 font-mono text-[11px] text-paper-300 transition-colors duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-hairline-ember hover:text-ember-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
            >
              Open
            </Link>
            {isReady ? (
              <a
                href={`/api/projects/${film.id}/output?download=1`}
                download
                className="inline-flex items-center gap-1.5 rounded-pill border border-hairline px-3 py-1.5 font-mono text-[11px] text-paper-300 transition-colors duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-hairline-ember hover:text-ember-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
              >
                <Icon name="download" size={12} />
                Save
              </a>
            ) : null}
            {film.bytes ? (
              <span className="font-mono text-[11px] text-paper-500">{fileSize(film.bytes)}</span>
            ) : null}

            {/* Films could only ever accumulate: every reset left a draft behind and there
                was nothing anywhere to remove one. Two presses rather than a dialog, since
                this deletes the reel and its frames from disk and cannot be undone. */}
            <button
              type="button"
              onClick={() => void remove()}
              disabled={removing}
              className="ml-auto rounded-pill px-2.5 py-1.5 font-mono text-[11px] text-paper-600 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-signal-fail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60 disabled:opacity-50"
            >
              {removing ? "Removing" : confirming ? "Really remove?" : "Remove"}
            </button>
          </div>
        </div>
      </div>

      {open ? (
        <div className="flex flex-col gap-5 px-4 pb-4 pt-1">
          <ul className="flex list-none gap-3 overflow-x-auto pb-2">
            {film.shots.map((s) => (
              <Shot key={s.id} shot={s} />
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-5">
            {film.score ? (
              <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-paper-500">
                  Score
                  {film.score.bpm ? <span className="ml-2 normal-case tracking-normal">{film.score.bpm} BPM</span> : null}
                </p>
                <audio src={film.score.url} controls preload="metadata" className="w-full" />
              </div>
            ) : null}

            {film.photos.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-paper-500">
                  From your photographs
                </p>
                <ul className="flex list-none gap-2">
                  {film.photos.slice(0, 5).map((p) => (
                    <li key={p.id}>
                      <img
                        src={p.url}
                        alt=""
                        loading="lazy"
                        className="h-14 w-14 rounded-core-sm border border-hairline object-cover"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {film.shots.some((s) => s.review && s.review !== "PASS") ? (
            <ul className="flex list-none flex-col gap-1">
              {film.shots
                .filter((s) => s.review && s.review !== "PASS")
                .map((s) => (
                  <li key={s.id} className="font-mono text-[11px] text-paper-500">
                    Shot {s.number} {reviewLabel(s.review ?? "")}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default function GalleryClient({ films, totals }: GalleryClientProps) {
  const [tab, setTab] = useState<Tab>("all");

  const visible = films.filter((f) =>
    tab === "all" ? true : tab === "ready" ? Boolean(f.reelUrl) : !f.reelUrl,
  );

  const tabs: { key: Tab; label: string; n: number }[] = [
    { key: "all", label: "All", n: films.length },
    { key: "ready", label: "Ready", n: films.filter((f) => f.reelUrl).length },
    { key: "working", label: "Unfinished", n: films.filter((f) => !f.reelUrl).length },
  ];

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex gap-2" role="group" aria-label="Filter films">
          {tabs
            .filter((t) => t.key === "all" || t.n > 0)
            .map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cx(
                  "rounded-pill border px-3.5 py-1.5 font-sans text-[13px] transition-colors duration-400",
                  "ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60",
                  tab === t.key
                    ? "border-hairline-ember bg-ember-500/10 text-ember-200"
                    : "border-hairline bg-ink-900/50 text-paper-300 hover:border-hairline-strong hover:text-paper-100",
                )}
              >
                {t.label}
                <span className="ml-2 font-mono text-[11px] text-paper-500">{t.n}</span>
              </button>
            ))}
        </div>
        <p className="font-mono text-[11px] text-paper-500">
          {totals.shots} shots · {fileSize(totals.bytes)}
        </p>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-shell border border-hairline bg-ink-900/50 p-10 text-center">
          <p className="font-display text-2xl text-paper-100">Nothing here yet</p>
          <p className="mt-2 font-sans text-[13px] text-paper-400">
            Make a film and it will appear here with all of its shots.
          </p>
          <div className="mt-6 flex justify-center">
            <Link
              href="/"
              className="rounded-pill border border-hairline-ember bg-ember-500/10 px-5 py-2 font-sans text-[13px] text-ember-200 transition-colors duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-ember-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
            >
              Start one
            </Link>
          </div>
        </div>
      ) : (
        <ul className="flex list-none flex-col gap-4">
          {visible.map((f) => (
            <Film key={f.id} film={f} />
          ))}
        </ul>
      )}
    </div>
  );
}
