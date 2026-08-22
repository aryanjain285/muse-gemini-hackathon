import { bootstrap } from "@/lib/server/bootstrap";
import { Storybooks } from "@/lib/memory/storybooks";
import Storybook, { type StorybookData } from "@/components/memory/Storybook";

export const dynamic = "force-dynamic";
export const metadata = { title: "Storybook" };

/**
 * The shelf is read here rather than fetched by the client, so the first paint already has a cover
 * on it. A book that appears after a spinner is a web page; one that is simply there is a book.
 */
export default async function StorybookPage() {
  bootstrap();
  return (
    <main className="min-h-screen w-full overflow-x-hidden pb-24">
      <section className="mx-auto w-[min(var(--measure-wide),100%-var(--gutter-page)*2)] pt-12">
        <Storybook shelf={Storybooks.list() as StorybookData[]} />
      </section>
    </main>
  );
}
