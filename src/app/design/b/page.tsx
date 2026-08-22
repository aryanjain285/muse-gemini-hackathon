/**
 * Variant B — the grading suite.
 *
 * The page is a thin server shell: it reads the film once and hands it to the
 * suite. Nothing is fetched on the client, so the first paint already holds the
 * film, its shots, its score and its photographs.
 */
import type { Metadata } from "next";
import { designFilm } from "@/app/design/data";
import VariantSuite from "@/components/design/VariantSuite";

export const metadata: Metadata = {
  title: "The grading suite",
  description:
    "One film on a large screen, with the score, the beats, the cuts and the shots arranged around it.",
};

/** The suite reads the workspace at request time, so it is never prerendered. */
export const dynamic = "force-dynamic";

export default function GradingSuitePage() {
  const film = designFilm();
  return <VariantSuite film={film} />;
}
