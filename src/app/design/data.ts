/**
 * Read-only data for the design variants.
 *
 * The three variants exist to be compared, so they must render the same film with
 * the same numbers — a difference in layout is a design decision, a difference in
 * content is a confound. Nothing here mutates or spends.
 */
import { Projects, Specs, Assets, Qc } from "@/lib/db/repo";
import { urlFor } from "@/lib/services/assets";
import { round } from "@/lib/core/util";
import { getBundle } from "@/lib/templates/bundles";

export interface DesignShot {
  id: string;
  number: number;
  purpose: string;
  action: string;
  camera: string;
  transitionIn: string;
  startS: number;
  endS: number;
  durationS: number;
  frameUrl: string | null;
  takeUrl: string | null;
  review: string | null;
  generated: boolean;
}

export interface DesignEvent {
  t: number;
  kind: string;
  intensity: number;
}

export interface DesignFilm {
  id: string;
  title: string;
  logline: string;
  brief: string;
  preset: string;
  presetLabel: string;
  status: string;
  createdAt: string;
  durationS: number;
  reelUrl: string | null;
  posterUrl: string | null;
  /** The film's own colours, so a variant may take its palette from the work. */
  swatches: string[];
  paletteWords: string[];
  medium: string;
  lighting: string;
  shots: DesignShot[];
  events: DesignEvent[];
  music: { url: string | null; bpm: number | null; durationS: number | null; anchors: number[] } | null;
  photos: string[];
}

/** The film a variant should present: the requested one, else the newest finished. */
export function designFilm(projectId?: string): DesignFilm | null {
  const all = Projects.list(60);
  const chosen =
    (projectId ? all.find((p) => p.id === projectId) : undefined) ??
    all.find((p) => p.status === "READY") ??
    all[0];
  if (!chosen) return null;

  const active = Specs.active(chosen.id);
  const spec = active?.spec ?? null;
  const bundle = getBundle(chosen.preset);
  const reel = Assets.byRole(chosen.id, "final", "reel");
  const poster = Assets.byRole(chosen.id, "final", "poster");
  const score = Assets.byProject(chosen.id, "music").slice(-1)[0] ?? null;
  const scoreMeta = score
    ? Assets.meta<{ bpm?: number; durationS?: number }>(score)
    : null;
  const reelMeta = reel ? Assets.meta<{ durationS?: number; anchors?: number[] }>(reel) : null;

  const shots: DesignShot[] = (spec?.scenes ?? []).map((s, i) => {
    const frame = Assets.byRole(chosen.id, s.id, "keyframe");
    const take = Assets.byRole(chosen.id, s.id, "scene_video");
    const takeMeta = take ? Assets.meta<{ generated?: boolean }>(take) : null;
    return {
      id: s.id,
      number: i + 1,
      purpose: s.purpose,
      action: s.action,
      camera: s.camera,
      transitionIn: s.transition_in,
      startS: s.start_s,
      endS: s.end_s,
      durationS: round(s.end_s - s.start_s, 2),
      frameUrl: frame ? urlFor(frame) : null,
      takeUrl: take ? urlFor(take) : null,
      review: Qc.latestForScene(chosen.id, s.id)?.decision ?? null,
      generated: Boolean(takeMeta?.generated),
    };
  });

  return {
    id: chosen.id,
    title: spec?.title ?? chosen.title,
    logline: spec?.logline ?? "",
    brief: chosen.brief,
    preset: chosen.preset,
    presetLabel: bundle.label,
    status: chosen.status,
    createdAt: chosen.created_at,
    durationS: spec?.duration_s ?? 30,
    reelUrl: reel ? urlFor(reel) : null,
    posterUrl: poster ? urlFor(poster) : null,
    swatches: bundle.swatches,
    paletteWords: spec?.style_bible.palette ?? [],
    medium: spec?.style_bible.medium ?? bundle.styleBible.medium,
    lighting: spec?.style_bible.lighting ?? bundle.styleBible.lighting,
    shots,
    events: (spec?.events ?? []).map((e) => ({ t: e.t, kind: e.kind, intensity: e.intensity })),
    music: score
      ? {
          url: urlFor(score),
          bpm: typeof scoreMeta?.bpm === "number" ? Math.round(scoreMeta.bpm) : null,
          durationS: typeof scoreMeta?.durationS === "number" ? round(scoreMeta.durationS, 2) : null,
          anchors: reelMeta?.anchors ?? [],
        }
      : null,
    photos: Assets.byProject(chosen.id, "upload_image").map((p) => urlFor(p)),
  };
}

/** Every film, for a variant that wants to show a gallery alongside. */
export function designFilms(): { id: string; title: string; posterUrl: string | null; durationS: number; status: string }[] {
  return Projects.list(24).map((p) => {
    const poster = Assets.byRole(p.id, "final", "poster");
    const reel = Assets.byRole(p.id, "final", "reel");
    const meta = reel ? Assets.meta<{ durationS?: number }>(reel) : null;
    return {
      id: p.id,
      title: Specs.active(p.id)?.spec.title ?? p.title,
      posterUrl: poster ? urlFor(poster) : null,
      durationS: meta?.durationS ?? 0,
      status: p.status,
    };
  });
}
