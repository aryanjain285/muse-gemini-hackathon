import { bootstrap } from "@/lib/server/bootstrap";
import { Memories } from "@/lib/memory/store";
import SketchStand from "@/components/memory/SketchStand";
import { existingSketches } from "@/lib/services/caricature";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sketch studio · MUSE" };

export default async function SketchPage() {
  bootstrap();
  const memories = Memories.views();
  const drawn = existingSketches();
  return (
    <main className="min-h-screen w-full overflow-x-hidden pb-24">
      <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)] pt-12">
        <SketchStand memories={memories} drawn={drawn} />
      </section>
    </main>
  );
}
