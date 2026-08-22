import { bootstrap } from "@/lib/server/bootstrap";
import { designFilm } from "@/app/design/data";
import VariantSlate from "@/components/design/VariantSlate";

/**
 * Direction A — the Slate.
 *
 * The film is read at request time, so the page always shows the newest finished
 * work rather than whatever existed when the app was built. Two faces are pulled
 * in here rather than in the shared stylesheet: a condensed grotesk for slate
 * lettering and one monospace for everything that was measured or written.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Slate" };

const FONTS =
  "https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

export default function DesignSlatePage() {
  bootstrap();
  const film = designFilm();

  return (
    <>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={FONTS} precedence="default" />
      <VariantSlate film={film} />
    </>
  );
}
