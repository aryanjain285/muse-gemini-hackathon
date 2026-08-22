/**
 * MUSE — design variant C, "The Programme".
 *
 * The route is a server component so the film is read on the server and handed
 * to the sheet already typeset: one query, no client fetch, no loading state to
 * design around. `designFilm()` returns null when nothing has been made yet, and
 * the variant prints an empty sheet for that case rather than a blank page.
 */
import type { Metadata } from "next";
import { designFilm } from "@/app/design/data";
import VariantProgramme from "@/components/design/VariantProgramme";

export const metadata: Metadata = {
  title: "Programme",
  description:
    "A film read as a printed programme: the plate tipped in, the shots set as a credits block, the score and the photographs it came from.",
};

// The sheet is a picture of one film at one moment, so it is never cached.
export const dynamic = "force-dynamic";

export default function ProgrammePage() {
  const film = designFilm();
  return <VariantProgramme film={film} />;
}
