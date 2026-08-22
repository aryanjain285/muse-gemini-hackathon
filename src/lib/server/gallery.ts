/**
 * Gallery data, shaped around films rather than stored files.
 *
 * A person does not think "I have 47 assets"; they think "I made four films, and
 * this one has seven shots". So the view is a list of films, each carrying its
 * shots, its score and its photographs.
 *
 * Pixel dimensions are read from the file header rather than by shelling out to
 * ffprobe: a gallery can hold hundreds of images, and a process per card would make
 * the page unusable.
 */
import { Assets, Projects, Qc, Specs } from "@/lib/db/repo";
import { shotSize } from "@/lib/spec/directorSpec";
import { round } from "@/lib/core/util";
import { urlFor } from "@/lib/services/assets";

export interface ShotView {
  id: string;
  /** Ordinal shown to the reader: 1-based, not the internal s01. */
  number: number;
  purpose: string;
  action: string;
  camera: string;
  /** How far the camera sits, so a reader can see the film was covered. */
  shotSize: string;
  transitionIn: string;
  startS: number;
  durationS: number;
  frameUrl: string | null;
  takeUrl: string | null;
  /** True when a model painted it rather than the local engine computing it. */
  generated: boolean;
  review: string | null;
}

export interface FilmView {
  id: string;
  title: string;
  /** The sentence the person wrote. */
  brief: string;
  logline: string | null;
  preset: string;
  status: string;
  createdAt: string;
  reelUrl: string | null;
  posterUrl: string | null;
  durationS: number | null;
  bytes: number | null;
  frameSize: { width: number; height: number } | null;
  shots: ShotView[];
  score: { url: string; durationS: number | null; bpm: number | null; generated: boolean } | null;
  photos: { id: string; url: string }[];
}

export interface GalleryView {
  films: FilmView[];
  totals: { films: number; ready: number; shots: number; bytes: number };
}

// ── dimensions from file headers ─────────────────────────────────────────────


// ── assembly ─────────────────────────────────────────────────────────────────

interface Meta {
  route?: string;
  generated?: boolean;
  durationS?: number;
  bytes?: number;
  bpm?: number;
  fromFallback?: boolean;
}

export function galleryView(limit = 60): GalleryView {
  const films: FilmView[] = [];
  let shots = 0;
  let bytes = 0;
  let ready = 0;

  for (const project of Projects.list(limit)) {
    const spec = Specs.active(project.id)?.spec ?? null;
    const reel = Assets.byRole(project.id, "final", "reel");

    // A gallery of films shows films. Every project ever started was listed here, so an
    // abandoned draft and a run that died half way through appeared beside finished work with
    // nothing to play — fourteen entries for one film. A project still running is kept, so a
    // demo can watch one arrive; anything else without a reel is not a film yet.
    const running = ["PREFLIGHT", "DIRECTING", "STORYBOARDING", "RENDERING", "QC", "REPAIRING", "COMPOSING"];
    if (!reel && !running.includes(project.status)) continue;

    const poster = Assets.byRole(project.id, "final", "poster");
    const score = Assets.byProject(project.id, "music").slice(-1)[0] ?? null;
    const photos = Assets.byProject(project.id, "upload_image");

    for (const a of Assets.byProject(project.id)) bytes += a.bytes;
    if (project.status === "READY") ready++;

    const reelMeta = reel ? Assets.meta<Meta>(reel) : null;
    const scoreMeta = score ? Assets.meta<Meta>(score) : null;

    const shotViews: ShotView[] = (spec?.scenes ?? []).map((scene, i) => {
      const frame = Assets.byRole(project.id, scene.id, "keyframe");
      const take = Assets.byRole(project.id, scene.id, "scene_video");
      const takeMeta = take ? Assets.meta<Meta>(take) : null;
      const qc = Qc.latestForScene(project.id, scene.id);
      shots++;
      return {
        id: scene.id,
        number: i + 1,
        purpose: scene.purpose,
        action: scene.action,
        camera: scene.camera,
        shotSize: shotSize(scene),
        transitionIn: scene.transition_in,
        startS: scene.start_s,
        durationS: round(scene.end_s - scene.start_s, 2),
        frameUrl: frame ? urlFor(frame) : null,
        takeUrl: take ? urlFor(take) : null,
        // Keyframes record `route`, not `generated` — the second half of this test used to
        // read a key nothing writes, so a shot whose still came from a model but whose
        // motion did not was shown as entirely local. The route is the signal that exists.
        generated:
          Boolean(takeMeta?.generated) ||
          (frame ? (Assets.meta<Meta>(frame).route ?? "").startsWith("gemini:") : false),
        review: qc?.decision ?? null,
      };
    });

    films.push({
      id: project.id,
      title: spec?.title ?? project.title,
      brief: project.brief,
      logline: spec?.logline ?? null,
      preset: project.preset,
      status: project.status,
      createdAt: project.created_at,
      reelUrl: reel ? urlFor(reel) : null,
      posterUrl: poster ? urlFor(poster) : null,
      durationS: typeof reelMeta?.durationS === "number" ? round(reelMeta.durationS, 2) : null,
      bytes: reel ? reel.bytes : null,
      frameSize: reel ? { width: 1080, height: 1920 } : null,
      shots: shotViews,
      score: score
        ? {
            url: urlFor(score),
            durationS: typeof scoreMeta?.durationS === "number" ? round(scoreMeta.durationS, 2) : null,
            bpm: typeof scoreMeta?.bpm === "number" ? Math.round(scoreMeta.bpm) : null,
            generated: scoreMeta?.fromFallback !== true,
          }
        : null,
      photos: photos.map((p) => ({ id: p.id, url: urlFor(p) })),
    });
  }

  return { films, totals: { films: films.length, ready, shots, bytes } };
}
