/**
 * Planned-to-actual reconciliation: match the Director's intended beats to the
 * accents that actually exist in the returned audio.
 *
 * The composer cuts on the output of this file. Three rules make it safe to do
 * that blindly: one anchor can only serve one event, a snap can never reorder
 * the timeline, and an event with no honest candidate stays where it was planned
 * and is reported as unmatched so the composer can place its own accent.
 */
import { clamp, round } from "@/lib/core/util";
import type { EventKind } from "@/lib/spec/directorSpec";
import type {
  ActualMusicMap,
  AnchorMatch,
  MusicAnchor,
  PlannedMusicMap,
  Reconciliation,
  Dynamics,
  EnergyPoint,
} from "@/lib/music/types";
import { DROP_TOLERANCE_S, SNAP_TOLERANCE_S } from "@/lib/music/types";

/**
 * How much each anchor kind is trusted as a cut point. A plain onset is a real
 * event but a weak place to cut; an accent, a downbeat or the peak is what an
 * editor would choose.
 */
const KIND_TRUST: Record<MusicAnchor["kind"], number> = {
  peak: 1,
  drop: 1,
  accent: 1,
  downbeat: 0.95,
  section: 0.9,
  onset: 0.75,
};

/** Extra weight for a drop candidate inside the loudest sustained region. */
const PEAK_REGION_BONUS = 0.3;

/** Below this there is no honest match, even inside the tolerance window. */
const MIN_CONFIDENCE = 0.12;

/** Keeps two events from being snapped onto the same instant. */
const ORDER_EPSILON = 1e-6;

/** The drop moves furthest in generated audio, so it gets the wider window. */
export function toleranceFor(kind: EventKind): number {
  return kind === "drop" ? DROP_TOLERANCE_S : SNAP_TOLERANCE_S;
}

interface Candidate {
  eventIndex: number;
  anchorIndex: number;
  /** Anchor time. */
  t: number;
  deltaS: number;
  confidence: number;
  /** Ranking key: confidence plus situational bonuses. */
  score: number;
}

function insidePeakRegion(t: number, region: [number, number] | null): boolean {
  if (!region) return false;
  const lo = Math.min(region[0], region[1]);
  const hi = Math.max(region[0], region[1]);
  return t >= lo - 0.05 && t <= hi + 0.05;
}

/**
 * Usable anchors only: finite time, finite strength, sorted. Analysis output is
 * already clean, but reconciliation also runs on maps loaded from disk.
 */
function sanitiseAnchors(anchors: MusicAnchor[] | undefined): MusicAnchor[] {
  if (!Array.isArray(anchors)) return [];
  return anchors
    .filter((a) => a && Number.isFinite(a.t) && a.t >= 0)
    .map((a) => ({ t: a.t, kind: a.kind, strength: clamp(Number(a.strength) || 0, 0, 1) }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Match planned events to measured anchors and produce the timeline the composer
 * cuts on. Total by construction: bad or empty input yields a reconciliation
 * that simply snaps nothing.
 */
export function reconcile(planned: PlannedMusicMap, actual: ActualMusicMap): Reconciliation {
  const events = (Array.isArray(planned.events) ? planned.events : [])
    .filter((e) => e && Number.isFinite(e.t) && e.t >= 0)
    .map((e) => ({ t: e.t, kind: e.kind, intensity: clamp(Number(e.intensity) || 0, 0, 1) }))
    .sort((a, b) => a.t - b.t);

  const anchors = sanitiseAnchors(actual?.anchors);
  const peakRegion = actual?.peakRegionS ?? null;

  // Every plausible pairing, scored once. The list is small: a dozen events
  // against a few hundred anchors, and only those inside the tolerance window.
  const candidates: Candidate[] = [];
  for (let ei = 0; ei < events.length; ei++) {
    const event = events[ei];
    const tol = toleranceFor(event.kind);
    for (let ai = 0; ai < anchors.length; ai++) {
      const anchor = anchors[ai];
      const dist = Math.abs(anchor.t - event.t);
      if (dist > tol) continue;
      const closeness = 1 - dist / tol;
      const trust = KIND_TRUST[anchor.kind] ?? 0.75;
      const confidence = clamp((0.55 * closeness + 0.45 * anchor.strength) * trust, 0, 1);
      if (confidence < MIN_CONFIDENCE) continue;
      const bonus =
        event.kind === "drop" && insidePeakRegion(anchor.t, peakRegion) ? PEAK_REGION_BONUS : 0;
      candidates.push({
        eventIndex: ei,
        anchorIndex: ai,
        t: anchor.t,
        deltaS: anchor.t - event.t,
        confidence,
        score: confidence + bonus,
      });
    }
  }

  // Best match wins the anchor; the loser falls through to its next candidate on
  // a later pass of the same sorted list. Ties break on event then anchor index
  // so the result never depends on sort stability.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
    return a.anchorIndex - b.anchorIndex;
  });

  const chosen = new Array<Candidate | null>(events.length).fill(null);
  const claimed = new Set<number>();
  // Repeated passes because resolving one event can widen a neighbour's legal
  // window: an event snapped later than planned frees space after it. Each pass
  // must place at least one match or the loop is done.
  for (let pass = 0; pass <= events.length; pass++) {
    let placed = false;
    for (const c of candidates) {
      if (chosen[c.eventIndex] !== null || claimed.has(c.anchorIndex)) continue;
      // Order guard: the snapped time must still sit between its neighbours,
      // using their resolved times where known and their planned times otherwise.
      let lower = -Infinity;
      for (let j = 0; j < c.eventIndex; j++) {
        const jc = chosen[j];
        lower = Math.max(lower, jc ? jc.t : events[j].t);
      }
      let upper = Infinity;
      for (let j = c.eventIndex + 1; j < events.length; j++) {
        const jc = chosen[j];
        upper = Math.min(upper, jc ? jc.t : events[j].t);
      }
      if (c.t < lower + ORDER_EPSILON || c.t > upper - ORDER_EPSILON) continue;
      chosen[c.eventIndex] = c;
      claimed.add(c.anchorIndex);
      placed = true;
    }
    if (!placed) break;
  }

  const matches: AnchorMatch[] = [];
  const unmatched: EventKind[] = [];
  const snappedEvents: Reconciliation["snappedEvents"] = [];
  let maxDeltaS = 0;

  for (let ei = 0; ei < events.length; ei++) {
    const event = events[ei];
    const pick = chosen[ei];
    if (pick) {
      matches.push({
        kind: event.kind,
        plannedT: round(event.t, 3),
        actualT: round(pick.t, 3),
        deltaS: round(pick.deltaS, 3),
        confidence: round(pick.confidence, 3),
      });
      maxDeltaS = Math.max(maxDeltaS, Math.abs(pick.deltaS));
      snappedEvents.push({
        t: round(pick.t, 3),
        kind: event.kind,
        intensity: round(event.intensity, 3),
        snapped: true,
      });
    } else {
      matches.push({
        kind: event.kind,
        plannedT: round(event.t, 3),
        actualT: null,
        deltaS: 0,
        confidence: 0,
      });
      if (!unmatched.includes(event.kind)) unmatched.push(event.kind);
      snappedEvents.push({
        t: round(event.t, 3),
        kind: event.kind,
        intensity: round(event.intensity, 3),
        snapped: false,
      });
    }
  }

  return { matches, unmatched, snappedEvents, maxDeltaS: round(maxDeltaS, 3) };
}

/**
 * One-line diagnostic for the logs and the UI panel: how much of the intended
 * timeline actually exists in the audio.
 */
export function reconciliationSummary(r: Reconciliation): string {
  const snapped = r.snappedEvents.filter((e) => e.snapped).length;
  return `${snapped}/${r.snappedEvents.length} events snapped, max correction ${r.maxDeltaS}s${
    r.unmatched.length > 0 ? `, unmatched: ${r.unmatched.join(", ")}` : ""
  }`;
}

/**
 * A score with less lift than this has no arc of its own and the mix has to supply one.
 *
 * Normalised RMS, so 0.08 is a small but clearly audible difference between the quiet
 * opening and the payoff. The flat score that prompted this measured 0.01.
 */
export const FLAT_DYNAMICS = 0.08;

/**
 * Measure how much the score rises into its payoff.
 *
 * Windows are taken from the plan rather than from the audio: what matters is whether the
 * music lifts where the film needs it to, not whether it lifts somewhere.
 */
export function measureDynamics(input: {
  energy: EnergyPoint[];
  buildFromS: number;
  dropAtS: number;
  resolveAtS: number;
}): Dynamics {
  const { energy } = input;
  const mean = (from: number, to: number): number => {
    const inWindow = energy.filter((e) => e.t >= from && e.t < to);
    if (inWindow.length === 0) return 0;
    return inWindow.reduce((a, e) => a + e.v, 0) / inWindow.length;
  };

  const quiet = mean(0, Math.max(0.5, input.buildFromS));
  const loud = mean(input.dropAtS, Math.max(input.dropAtS + 1, input.resolveAtS));
  const lift = round(loud - quiet, 4);
  return { quiet: round(quiet, 4), loud: round(loud, 4), lift, flat: lift <= FLAT_DYNAMICS };
}
