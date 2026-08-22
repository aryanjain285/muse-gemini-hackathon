/**
 * The studio route. Reads the project on the server so the first paint is
 * complete — important during a live demo, where a loading skeleton in front of
 * an audience is a worse failure than a slow response.
 */
import { notFound } from "next/navigation";
import { bootstrap } from "@/lib/server/bootstrap";
import { capabilityView, projectView } from "@/lib/server/views";
import StudioClient from "@/components/studio/StudioClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  bootstrap();
  const { id } = await params;
  const project = projectView(id);
  return {
    title: project ? `${project.spec?.title ?? project.title} — MUSE` : "MUSE",
  };
}

export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  bootstrap();
  const { id } = await params;
  const project = projectView(id);
  if (!project) notFound();

  return (
    <StudioClient
      projectId={id}
      initialProject={project}
      initialCapabilities={capabilityView()}
    />
  );
}
