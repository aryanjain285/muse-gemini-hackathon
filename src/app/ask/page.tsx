import { bootstrap } from "@/lib/server/bootstrap";
import AskMuseClient from "@/components/memory/AskMuseClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask MUSE" };

export default async function AskPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  bootstrap();
  const params = await searchParams;
  return (
    <main className="min-h-screen w-full overflow-x-hidden pb-24">
      <section className="mx-auto w-[min(var(--measure-page),100%-var(--gutter-page)*2)] pt-14">
        <AskMuseClient initialQuery={params.q ?? ""} />
      </section>
    </main>
  );
}
