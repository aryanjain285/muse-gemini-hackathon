import Link from "next/link";
import { bootstrap } from "@/lib/server/bootstrap";
import { galleryView } from "@/lib/server/gallery";
import { Memories } from "@/lib/memory/store";
import GalleryClient from "@/components/gallery/GalleryClient";
import MemoryGallery from "@/components/memory/MemoryGallery";

export const dynamic = "force-dynamic";
export const metadata = { title: "Gallery" };

export default async function GalleryPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  bootstrap();
  const params = await searchParams;
  const view = params.view === "films" ? "films" : "memories";
  const { films, totals } = galleryView();
  const memories = Memories.views();

  return (
    <main className="w-full max-w-full overflow-x-hidden pb-24">

      <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)] pt-14 pb-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember-300">Your memory system</p>
        <h1 className="mt-2 font-display text-[clamp(2.4rem,5vw,3.8rem)] leading-[1.02] tracking-[-0.025em] text-paper-50">
          {view === "memories" ? "Your memories" : "Your films"}
        </h1>
        <p className="mt-3 max-w-2xl font-sans text-[14px] leading-relaxed text-paper-400">
          {view === "memories"
            ? memories.length === 0
              ? "Import photographs once. MUSE keeps an agent-readable memory beside each one, locally."
              : `${memories.length} ${memories.length === 1 ? "memory" : "memories"} MUSE can search, remember and turn into new films.`
            : totals.films === 0
              ? "Nothing made yet."
              : `${totals.films} ${totals.films === 1 ? "film" : "films"}, ${totals.ready} ready.`}
        </p>

        <div className="mt-7 inline-flex rounded-pill border border-hairline bg-ink-950 p-1">
          <Link
            href="/gallery?view=memories"
            className={`rounded-pill px-4 py-2 font-mono text-[11px] transition-colors ${view === "memories" ? "bg-ink-800 text-paper-100" : "text-paper-500 hover:text-paper-300"}`}
          >
            Memories · {memories.length}
          </Link>
          <Link
            href="/gallery?view=films"
            className={`rounded-pill px-4 py-2 font-mono text-[11px] transition-colors ${view === "films" ? "bg-ink-800 text-paper-100" : "text-paper-500 hover:text-paper-300"}`}
          >
            Films · {totals.films}
          </Link>
        </div>
      </section>

      <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)]">
        {view === "memories" ? <MemoryGallery initial={memories} /> : <GalleryClient films={films} totals={totals} />}
      </section>
    </main>
  );
}
