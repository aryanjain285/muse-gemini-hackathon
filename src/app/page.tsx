/**
 * The front door. Reads capabilities and recent work directly rather than through
 * the API, so the first paint is complete and there is no loading flash in front
 * of an audience.
 */
import Link from "next/link";
import { bootstrap } from "@/lib/server/bootstrap";
import { capabilityView, featuredFilmView, projectListView } from "@/lib/server/views";
import { Badge, Eyebrow, Icon, Panel } from "@/components/ui/primitives";
import BeginForm from "@/components/landing/BeginForm";
import FeaturedFilm from "@/components/landing/FeaturedFilm";
import { Logo } from "@/components/brand/Logo";

export const dynamic = "force-dynamic";

/** The seven beats of the golden template, used as the "how it works" strip. */
const BEATS = [
  { at: "0.0", label: "Recognition", note: "your photograph, stylised" },
  { at: "3.5", label: "World opens", note: "parallax, particles" },
  { at: "7.0", label: "Motion begins", note: "the subject moves" },
  { at: "11.0", label: "Build", note: "faster cuts, rising light" },
  { at: "15.0", label: "Hero drop", note: "the transformation" },
  { at: "21.0", label: "Variation", note: "whip into the answer" },
  { at: "25.0", label: "Resolution", note: "slow down, title" },
];


export default async function Home() {
  bootstrap();
  const caps = capabilityView();
  const projects = projectListView().slice(0, 8);
  const featured = featuredFilmView();

  return (
    <main className="w-full max-w-full overflow-x-hidden">
      {/* Detached header rather than an edge-to-edge bar: it reads as equipment
          sitting on the surface rather than browser chrome. */}
      <header className="mx-auto mt-6 flex w-[min(var(--measure-page),100%-var(--gutter-page)*2)] items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo size={22} wordSize={13} className="text-paper-100" />
          <span className="sprocket hidden h-3 w-24 opacity-40 sm:block" aria-hidden="true" />
        </div>
        {/* The landing page carries no navigation rail, so every way in has to be here. It
            linked only to the gallery, which left the memory agent and the sketch studio with
            no door on the first screen anybody sees. */}
        <nav className="flex items-center gap-4">
          {[
            ["/ask", "Ask MUSE"],
            ["/gallery", "Gallery"],
            ["/sketch", "Sketch"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="font-sans text-[13px] text-paper-300 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-paper-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ember-500/60"
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>

      <section className="mx-auto flex w-[min(var(--measure-page),100%-var(--gutter-page)*2)] flex-col items-center pt-12 pb-16 text-center sm:pt-16">
        <Eyebrow tone="ember">Build with Gemini · Lorong AI</Eyebrow>

        {/* Wide container so the display line breaks at three short lines rather
            than wrapping into a column of words. */}
        {/* An idea rather than a specification. "Five photos. One sentence. A film." described
            the input fields, which is a form, not a promise — and the promise is the interesting
            part: a photograph freezes a moment, and nobody's memory of it is frozen. */}
        <h1 className="mt-6 max-w-5xl font-display text-[clamp(2.9rem,7.4vw,6.2rem)] leading-[0.94] tracking-[-0.03em] text-paper-50">
          Nobody remembers
          <br />
          in <span className="italic text-ember-300">stills</span>.
        </h1>

        <p className="mt-6 max-w-xl font-sans text-[16px] leading-relaxed text-paper-300">
          Hand MUSE the photographs you already have. It casts the faces, writes the story,
          composes a score for it, and lands every cut on the beat.
        </p>

        <div className="mt-10 w-full max-w-4xl">
          <BeginForm presets={caps.presets} hasApiKey={caps.hasApiKey} />
        </div>
      </section>

      {featured ? (
        <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)] pb-20">
          <FeaturedFilm film={featured} />
        </section>
      ) : null}

      {/* The timeline strip doubles as an explanation and as a preview of the
          product's own central object. */}
      <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)] pb-20">
        <Panel tone="raised" padding="lg">
          <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
            <Eyebrow tone="dim">How a film moves</Eyebrow>
            <span className="font-mono text-[11px] text-paper-500">seven beats · thirty seconds</span>
          </div>

          <ol className="grid list-none grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-4 lg:grid-cols-7">
            {BEATS.map((b, i) => (
              <li key={b.at} className="relative">
                <div className="mb-3 flex items-center gap-2">
                  <span className="font-mono text-[11px] tabular-nums text-ember-400">{b.at}s</span>
                  <span
                    className={
                      i === 4
                        ? "h-px flex-1 bg-ember-500/50"
                        : "h-px flex-1 bg-hairline"
                    }
                    aria-hidden="true"
                  />
                </div>
                <p
                  className={
                    i === 4
                      ? "font-sans text-[13px] font-medium text-ember-200"
                      : "font-sans text-[13px] font-medium text-paper-200"
                  }
                >
                  {b.label}
                </p>
                <p className="mt-1 font-sans text-[11px] leading-relaxed text-paper-500">{b.note}</p>
              </li>
            ))}
          </ol>
        </Panel>
      </section>

      {projects.length > 0 ? (
        <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)] pb-20">
          <div className="mb-6 flex items-baseline justify-between gap-4">
            <Eyebrow tone="dim">Your films</Eyebrow>
            <Link
              href="/gallery"
              className="font-mono text-[11px] text-paper-400 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-ember-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ember-500/60"
            >
              see all {projects.length}
            </Link>
          </div>
          <ul className="grid list-none grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {projects.slice(0, 5).map((p) => (
              <li key={p.id}>
                <Link
                  href={`/studio/${p.id}`}
                  className="group block rounded-shell border border-hairline bg-ink-900/50 p-1.5 transition-colors duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-hairline-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
                >
                  <div className="relative aspect-[9/16] overflow-hidden rounded-core bg-ink-1000">
                    {p.posterUrl ? (
                      <img
                        src={p.posterUrl}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Icon name="film" size={18} className="text-paper-500" />
                      </div>
                    )}
                  </div>
                  <div className="px-1.5 pt-2.5 pb-1">
                    <p className="truncate font-sans text-[13px] text-paper-100">{p.title}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-paper-500">
                      {p.reelUrl ? "ready" : "unfinished"}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)] border-t border-hairline py-8">
        <p className="font-mono text-[11px] text-paper-500">
          Films are made with AI and labelled as such. Your photographs stay on this machine.
        </p>
      </footer>
    </main>
  );
}
