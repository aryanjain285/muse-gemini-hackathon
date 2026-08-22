import Link from "next/link";
import { bootstrap } from "@/lib/server/bootstrap";
import { designFilm } from "./data";
import { Logo } from "@/components/brand/Logo";

export const dynamic = "force-dynamic";
export const metadata = { title: "Directions" };

/**
 * Three competing directions for the studio, rendering the same film so a
 * difference between them is a design decision rather than a difference in content.
 */
const DIRECTIONS = [
  {
    href: "/design/a",
    name: "Slate",
    commits: "Cool graphite, condensed lettering, shot roles colour-coded like camera-report fields.",
    signature: "The shot ribbon is a clapper stripe whose bar widths are the shot durations.",
    feels: "Working equipment. Dense, precise, readable across a room.",
  },
  {
    href: "/design/b",
    name: "Suite",
    commits: "One bright image in a dark room. The interface takes its accent from the film's own palette.",
    signature: "The score drawn as a waveform with the cuts marked against the measured beats.",
    feels: "A grading room. The film is the only thing carrying colour.",
  },
  {
    href: "/design/c",
    name: "Programme",
    commits: "Newsprint ground, ink and dull gold, asymmetric editorial setting on a 12-column grid.",
    signature: "The shot list set as a credits block with leader dots to a right-aligned figure column.",
    feels: "A printed one-sheet. Quiet, and exact about it.",
  },
];

export default async function DesignIndex() {
  bootstrap();
  const film = designFilm();

  return (
    <main className="w-full max-w-full overflow-x-hidden pb-24">
      <header className="mx-auto mt-6 flex w-[min(var(--measure-page),100%-var(--gutter-page)*2)] items-center justify-between">
        <Link
          href="/"
          aria-label="MUSE home"
          className="text-paper-200 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-paper-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
        >
          <Logo size={20} wordSize={12} />
        </Link>
        <span className="font-mono text-[11px] text-paper-500">three directions</span>
      </header>

      <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)] pt-14 pb-10">
        <h1 className="max-w-3xl font-display text-[clamp(2.4rem,5.4vw,4rem)] leading-[1.02] tracking-[-0.025em] text-paper-50">
          Pick a direction.
        </h1>
        <p className="mt-4 max-w-xl font-sans text-[15px] leading-relaxed text-paper-300">
          Each one presents the same film. What differs is the point of view.
        </p>
        {film ? (
          <p className="mt-3 font-mono text-[11px] text-paper-500">
            showing &ldquo;{film.title}&rdquo; · {film.shots.length} shots ·{" "}
            {film.durationS.toFixed(0)}s
          </p>
        ) : (
          <p className="mt-3 font-mono text-[11px] text-signal-warn">
            no film yet — make one first and these will fill in
          </p>
        )}
      </section>

      <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)]">
        <ul className="grid list-none grid-cols-1 gap-5 lg:grid-cols-3">
          {DIRECTIONS.map((d, i) => (
            <li key={d.href}>
              <Link
                href={d.href}
                className="group flex h-full flex-col rounded-shell border border-hairline bg-ink-900/50 p-6 transition-colors duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-hairline-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-display text-3xl leading-none text-paper-50">{d.name}</h2>
                  <span className="font-mono text-[11px] text-paper-500">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>

                <p className="mt-4 font-sans text-[13px] leading-relaxed text-paper-200">
                  {d.commits}
                </p>

                <dl className="mt-5 flex flex-col gap-3 border-t border-hairline pt-4">
                  <div>
                    <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-paper-500">
                      Signature
                    </dt>
                    <dd className="mt-1 font-sans text-[13px] leading-relaxed text-paper-300">
                      {d.signature}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-paper-500">
                      Feels like
                    </dt>
                    <dd className="mt-1 font-sans text-[13px] leading-relaxed text-paper-300">
                      {d.feels}
                    </dd>
                  </div>
                </dl>

                <span className="mt-6 inline-flex items-center gap-2 font-mono text-[11px] text-ember-300 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-1">
                  see it
                  <span aria-hidden="true">&rarr;</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
