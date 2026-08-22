"use client";

/**
 * One finished film on the front door.
 *
 * The claim is that a sentence becomes a directed film. A visitor who has not made
 * one has no way to see that, so the most recent finished reel plays here beside the
 * sentence that produced it and the shot list it was cut from. The film is the
 * argument; everything around it stays quiet.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eyebrow, Icon, Panel } from "@/components/ui/primitives";
import { cameraLabel, duration, shotSizeLabel } from "@/lib/brand";
import type { FeaturedFilm as Film } from "@/lib/server/views";

export default function FeaturedFilm({ film }: { film: Film }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  // A muted loop is atmosphere, and atmosphere is exactly what reduced motion asks
  // us not to start on its own. Those visitors get the poster and a play control.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    video.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  }, []);

  const evidence = [
    duration(film.durationS),
    film.bpm !== null ? `${Math.round(film.bpm)} BPM` : null,
    film.cutDriftMs !== null ? `every cut within ${film.cutDriftMs}ms of a beat` : null,
    film.coverage ? `${film.coverage.sizes} shot sizes across ${film.coverage.shots} shots` : null,
  ].filter((x): x is string => x !== null);

  return (
    <Panel tone="raised" padding="lg">
      <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <Eyebrow tone="dim">Directed here, from five photographs</Eyebrow>
        <Link
          href={`/studio/${film.id}`}
          className="font-mono text-[11px] text-paper-400 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-ember-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ember-500/60"
        >
          open in the studio
        </Link>
      </div>

      <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
        <div className="relative w-full max-w-[268px] shrink-0 self-center overflow-hidden rounded-core bg-ink-1000 lg:self-start">
          <video
            ref={videoRef}
            src={film.reelUrl}
            poster={film.posterUrl ?? undefined}
            controls
            loop
            muted
            playsInline
            preload="metadata"
            aria-label={`${film.title}, a ${duration(film.durationS)} film`}
            className="aspect-[9/16] h-auto w-full object-cover"
          />
          {!playing ? (
            <span
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
              aria-hidden="true"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-1000/70 backdrop-blur-sm">
                <Icon name="film" size={16} className="text-paper-200" />
              </span>
            </span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          {/* The sentence is the input, so it is set as the thing worth reading. */}
          <blockquote className="font-display text-[clamp(1.5rem,2.6vw,2.1rem)] leading-[1.18] tracking-[-0.02em] text-paper-50">
            <span className="text-ember-400/70">&ldquo;</span>
            {film.brief}
            <span className="text-ember-400/70">&rdquo;</span>
          </blockquote>

          <p className="mt-4 font-sans text-[14px] leading-relaxed text-paper-300">
            MUSE turned that into <span className="text-paper-100">{film.title}</span>
            {film.logline ? ` — ${film.logline.replace(/\.$/, "")}` : ""}.
          </p>

          <ol className="mt-7 grid list-none grid-cols-1 gap-x-8 gap-y-0 sm:grid-cols-2">
            {film.shots.map((shot, i) => (
              <li
                key={shot.id}
                className="flex items-baseline gap-3 border-b border-hairline py-2 last:border-b-0 sm:last:border-b"
              >
                <span className="w-4 shrink-0 font-mono text-[11px] tabular-nums text-paper-500">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-paper-200">
                  {shotSizeLabel(shot.shotSize)}, {cameraLabel(shot.camera)}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-paper-500">
                  {duration(shot.durationS)}
                </span>
              </li>
            ))}
          </ol>

          {evidence.length > 0 ? (
            <p className="mt-6 font-mono text-[11px] leading-relaxed text-paper-400">
              {evidence.join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
