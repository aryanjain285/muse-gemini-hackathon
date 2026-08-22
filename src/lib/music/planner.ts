/**
 * Music planning: turn the Director's timeline into the brief handed to the
 * music model, plus the planned map that survives as the audit trail.
 *
 * The brief is prose because that is what a music model follows, but it is
 * generated deterministically from the spec so two identical specs produce the
 * same request — which is what makes the response cacheable and the divergence
 * between planned and actual attributable to the model rather than to us.
 */
import { clamp, round, truncate } from "@/lib/core/util";
import type { DirectorSpec, TimelineEvent } from "@/lib/spec/directorSpec";
import type { PlannedMusicMap } from "@/lib/music/types";

/** Music models degrade badly on long prompts; this is the working ceiling. */
export const MAX_BRIEF_CHARS = 1200;

/** Used when the Director named no instruments, so the brief is never vague. */
const DEFAULT_INSTRUMENTATION = ["warm analogue pads", "felt piano", "soft percussion"];

/**
 * Caps that keep one verbose field from crowding out the structure. A music
 * model needs the timeline far more than it needs a paragraph about mood.
 */
const MAX_MOOD_CHARS = 120;
const MAX_INSTRUMENT_CHARS = 40;
const MAX_CLAUSES = 9;

/**
 * Seconds as a music model reads them: whole numbers stay whole, everything
 * else keeps one decimal.
 */
function seconds(t: number): string {
  const safe = Number.isFinite(t) ? Math.max(0, t) : 0;
  return Math.abs(safe - Math.round(safe)) < 0.05 ? String(Math.round(safe)) : safe.toFixed(1);
}

/** Comma list with a trailing "and", so the brief reads as a sentence. */
function joinPhrases(items: string[]): string {
  const clean = items.map((s) => s.trim()).filter((s) => s.length > 0);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

interface Clause {
  text: string;
  /** 0 clauses carry the structure; 1 clauses are colour and can be cut. */
  priority: 0 | 1;
  intensity: number;
  t: number;
}

function clauseFor(e: TimelineEvent): Clause {
  const at = `${seconds(e.t)} seconds`;
  const intensity = clamp(e.intensity, 0, 1);
  switch (e.kind) {
    case "intro":
      return {
        text: `open sparse at ${at} with one sustained voice and plenty of air`,
        priority: 0,
        intensity,
        t: e.t,
      };
    case "build":
      return {
        text: `bring percussion in and let density and brightness rise from ${at}`,
        priority: 0,
        intensity,
        t: e.t,
      };
    case "drop":
      return {
        text: `land the strongest moment at ${at} with full low end and a wide bright figure`,
        priority: 0,
        intensity,
        t: e.t,
      };
    case "resolve":
      return {
        text: `resolve into a warm sustained chord from ${at}`,
        priority: 0,
        intensity,
        t: e.t,
      };
    case "final_hit":
      return {
        text: `finish with one decisive hit at ${at}`,
        priority: 0,
        intensity,
        t: e.t,
      };
    case "variation":
      return {
        text: `shift the texture at ${at} without losing the pulse`,
        priority: 1,
        intensity,
        t: e.t,
      };
    case "accent":
      return {
        text: intensity >= 0.7 ? `hit a hard accent at ${at}` : `place a clear accent at ${at}`,
        priority: 1,
        intensity,
        t: e.t,
      };
  }
}

/**
 * Structure clauses in playback order. A sparse opening and a percussion entry
 * are stated even when the Director did not spell them out as events, because a
 * music model that is not told to start quietly rarely does.
 */
function buildClauses(events: TimelineEvent[]): Clause[] {
  const clauses = events.map(clauseFor);

  if (!events.some((e) => e.kind === "intro") && !events.some((e) => e.t < 1)) {
    clauses.unshift({
      text: "open sparse and quiet with one sustained voice",
      priority: 0,
      intensity: 0.2,
      t: 0,
    });
  }

  if (!events.some((e) => e.kind === "build")) {
    const drop = events.find((e) => e.kind === "drop");
    const limit = drop ? drop.t : Infinity;
    const entry = events.find((e) => e.t > 0 && e.t < limit && clamp(e.intensity, 0, 1) >= 0.4);
    if (entry) {
      clauses.push({
        text: `bring percussion in by ${seconds(entry.t)} seconds and let density rise from there`,
        priority: 0,
        intensity: clamp(entry.intensity, 0, 1),
        t: entry.t,
      });
    }
  }

  return clauses.sort((a, b) => (a.t === b.t ? a.priority - b.priority : a.t - b.t));
}

function compose(spec: DirectorSpec, clauses: Clause[], instruments: string[]): string {
  const bpm = round(spec.music.bpm_target, 1);
  const dur = seconds(spec.duration_s);
  const lines = [
    "Instrumental only, no vocals, no speech and no vocal samples.",
    `${bpm} BPM in ${spec.music.key}, ${dur} seconds long.`,
    `Built from ${joinPhrases(instruments)}.`,
    `The mood arc is ${truncate(spec.music.mood.trim(), MAX_MOOD_CHARS)}.`,
    `Structure: ${clauses.map((c) => c.text).join("; ")}.`,
    `End cleanly by ${dur} seconds, with the tail inside that window and no fade beyond it.`,
  ];
  return lines.join(" ");
}

/**
 * Build the music brief and the planned map from a validated spec. The brief is
 * trimmed to the model's working prompt length by dropping colour clauses, the
 * weakest first, so the structural beats always survive.
 */
export function planMusic(spec: DirectorSpec): { planned: PlannedMusicMap; brief: string } {
  const events = [...spec.events].sort((a, b) => (a.t === b.t ? 0 : a.t - b.t));
  const named = spec.music.instrumentation.filter((s) => s.trim().length > 0);
  const instruments = (named.length > 0 ? named : DEFAULT_INSTRUMENTATION).map((s) =>
    truncate(s.trim(), MAX_INSTRUMENT_CHARS),
  );

  let clauses = buildClauses(events);
  // Too many clauses reads as a list rather than a structure, and crowds out the
  // beats that matter. Colour goes first, weakest and latest first.
  while (clauses.length > MAX_CLAUSES) {
    const droppable = clauses
      .filter((c) => c.priority === 1)
      .sort((a, b) => (a.intensity === b.intensity ? b.t - a.t : a.intensity - b.intensity));
    if (droppable.length === 0) break;
    const victim = droppable[0];
    clauses = clauses.filter((c) => c !== victim);
  }
  let brief = compose(spec, clauses, instruments);

  // Shed the least load-bearing detail until the brief fits: optional clauses
  // first (weakest, then latest), then the instrument tail.
  while (brief.length > MAX_BRIEF_CHARS - 20) {
    const droppable = clauses
      .filter((c) => c.priority === 1)
      .sort((a, b) => (a.intensity === b.intensity ? b.t - a.t : a.intensity - b.intensity));
    if (droppable.length > 0) {
      const victim = droppable[0];
      clauses = clauses.filter((c) => c !== victim);
    } else if (instruments.length > 1) {
      instruments.pop();
    } else {
      break;
    }
    brief = compose(spec, clauses, instruments);
  }
  brief = truncate(brief, MAX_BRIEF_CHARS);

  const planned: PlannedMusicMap = {
    bpm: round(spec.music.bpm_target, 2),
    durationS: round(spec.duration_s, 3),
    key: spec.music.key,
    mood: spec.music.mood,
    brief,
    events: events.map((e) => ({
      t: round(clamp(e.t, 0, spec.duration_s), 3),
      kind: e.kind,
      intensity: round(clamp(e.intensity, 0, 1), 3),
    })),
  };
  return { planned, brief };
}
