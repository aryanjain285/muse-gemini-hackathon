/**
 * Music timeline contracts.
 *
 * The distinction between planned and actual is load-bearing. A generative music
 * model treats requested timestamps as intent, not instruction: asking for a drop
 * at 15.0s does not guarantee one lands there. So MUSE keeps two maps — what the
 * Director asked for, and what the returned waveform actually contains — and the
 * composer reconciles them. Visual cuts snap to real accents, never to hoped-for
 * ones.
 */
import type { EventKind } from "@/lib/spec/directorSpec";

/** A musically meaningful instant detected in real audio. */
export interface MusicAnchor {
  t: number;
  kind: "onset" | "downbeat" | "accent" | "section" | "drop" | "peak";
  /** 0..1 relative salience, used to pick the best anchor near a planned event. */
  strength: number;
}

/** Coarse energy envelope, one sample per analysis frame. */
export interface EnergyPoint {
  t: number;
  /** 0..1 normalised RMS. */
  v: number;
}

/** What the Director asked the music to do. */
export interface PlannedMusicMap {
  bpm: number;
  durationS: number;
  key: string;
  mood: string;
  /** The brief actually sent to the music model, kept for the audit trail. */
  brief: string;
  events: { t: number; kind: EventKind; intensity: number }[];
}

/** What the returned audio actually contains. */
export interface ActualMusicMap {
  durationS: number;
  /** Estimated from inter-onset intervals; may differ from the requested BPM. */
  bpm: number;
  sampleRate: number;
  anchors: MusicAnchor[];
  energy: EnergyPoint[];
  /** Loudest sustained region, a good candidate for the drop. */
  peakRegionS: [number, number] | null;
  /**
   * Highest absolute sample in the score, 0..1.
   *
   * A generated score can arrive already clipped — one came back with 5,621 samples at full
   * scale — and leaving that to the master limiter means the mix is rescuing the source
   * rather than shaping it. Knowing the peak lets the bed be trimmed before anything is
   * added to it.
   */
  peak: number;
  /** True when analysis ran on real decoded audio rather than a synthesis plan. */
  measured: boolean;
}

/**
 * How much the score actually rises into its payoff.
 *
 * A music model takes a tempo and an instrument list far more reliably than it takes
 * structure. Asked for "sparse and intimate for four seconds, density rising from eleven,
 * a big drop at fifteen", a score came back at the right tempo with the right instruments
 * and a level that never moved: measured in five-second windows it sat within 0.6 dB of
 * itself from the first bar to the last. Cuts can be placed on its beats and the film
 * still feels slow, because nothing about it builds.
 *
 * Measuring that is the first half of doing something about it.
 */
export interface Dynamics {
  /** Mean normalised energy before the build begins. */
  quiet: number;
  /** Mean normalised energy through the payoff. */
  loud: number;
  /** loud - quiet. At or below FLAT_DYNAMICS the score has no arc of its own. */
  lift: number;
  flat: boolean;
}

/** One planned event matched to a real anchor. */
export interface AnchorMatch {
  kind: EventKind;
  plannedT: number;
  /** The anchor chosen, or null when nothing was close enough. */
  actualT: number | null;
  deltaS: number;
  /** 0..1. Combines anchor strength with how far it had to move. */
  confidence: number;
}

export interface Reconciliation {
  matches: AnchorMatch[];
  /** Event kinds with no acceptable anchor. The composer adds its own accent. */
  unmatched: EventKind[];
  /**
   * The timeline the composer actually cuts on: planned event times replaced by
   * matched anchor times where a good match existed.
   */
  snappedEvents: { t: number; kind: EventKind; intensity: number; snapped: boolean }[];
  /** Largest correction applied, for the diagnostics panel. */
  maxDeltaS: number;
}

/** Tolerance for treating an anchor as "the same moment" as a planned event. */
export const SNAP_TOLERANCE_S = 0.45;

/** A wider window used only for the drop, which matters most and moves most. */
export const DROP_TOLERANCE_S = 1.2;
