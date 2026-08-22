import fs from "node:fs";
import path from "node:path";
import { bootstrap } from "@/lib/server/bootstrap";
import { PATHS } from "@/lib/core/paths";
import Storybook, { type StorybookData } from "@/components/memory/Storybook";

export const dynamic = "force-dynamic";
export const metadata = { title: "Storybook" };

/**
 * The saved book is read here rather than fetched by the client, so the first paint already has
 * the cover on it. A book that appears after a spinner is a web page; one that is simply there is
 * a book.
 */
function saved(): StorybookData | null {
  const file = path.join(PATHS.workspace, "storybook.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as StorybookData;
  } catch {
    return null;
  }
}

export default async function StorybookPage() {
  bootstrap();
  return (
    <main className="min-h-screen w-full overflow-x-hidden pb-24">
      <section className="mx-auto w-[min(var(--measure-wide),100%-var(--gutter-page)*2)] pt-12">
        <Storybook initial={saved()} />
      </section>
    </main>
  );
}
