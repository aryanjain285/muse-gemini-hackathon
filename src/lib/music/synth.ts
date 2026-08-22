/**
 * Local music synthesiser.
 *
 * MUSE has to finish a reel with no API key, no network and no budget, so the
 * fallback score is generated here rather than lifted from a sample pack: the
 * chord progression, the drum kit, the pad, the arpeggio and the mastering are
 * all real DSP. The arrangement is driven by the DirectorSpec's own event
 * timeline, which is what lets the composer cut picture to music it generated
 * itself and still land every hit.
 *
 * Everything is deterministic: one explicit seed feeds one small PRNG, so the
 * same spec renders byte-identical audio on every machine and the render cache
 * stays meaningful.
 */
import type { DirectorSpec, EventKind, TimelineEvent } from "@/lib/spec/directorSpec";
import { OUTPUT } from "@/lib/core/config";
import { clamp, round } from "@/lib/core/util";

/** 16-bit PCM stereo buffer plus the metadata the composer needs. */
export interface SynthResult {
  wav: Buffer;
  durationS: number;
  sampleRate: number;
  bpm: number;
  /** Every percussive/structural instant the synth deliberately placed, in seconds. */
  anchors: { t: number; kind: "downbeat" | "accent" | "drop" | "peak" | "section"; strength: number }[];
  /** Per-frame RMS envelope at 20 frames/sec, values 0..1. */
  energy: { t: number; v: number }[];
}

/** Native rate of the synth. Matches the reel's audio track so nothing resamples. */
const SR: number = OUTPUT.audioSampleRate;
/** Analysis rate of the returned energy envelope. */
const ENERGY_FPS = 20;
/** Length of the near-silence before the drop. Short enough to read as a held breath. */
const DROPOUT_S = 0.15;
/** Peak ceiling, -1 dBFS. */
const PEAK_CEILING = 0.8913;
/**
 * Programme loudness aim, inside a musical -16..-12 dBFS window. A cinematic
 * reel keeps a real transient at the drop, so the crest factor stays around
 * 14 dB rather than being flattened for streaming loudness.
 */
const RMS_TARGET = 0.1884; // -14.5 dBFS

// ── randomness ───────────────────────────────────────────────────────────────

/** mulberry32: tiny, fast, well distributed. Seeded, so renders repeat exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── dsp primitives ───────────────────────────────────────────────────────────

/** Smoothstep, used for click-free envelope ramps. */
function smooth(x: number): number {
  const u = clamp(x, 0, 1);
  return u * u * (3 - 2 * u);
}

/** Exponential decay normalised so `x === decayS` is -40 dB. */
function decay(x: number, decayS: number): number {
  return Math.exp((-4.6 * x) / decayS);
}

/**
 * PolyBLEP step correction. Naive saws alias badly at pad frequencies and the
 * result sounds like hiss on speakers, which is exactly what a fallback score
 * cannot afford.
 */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Band-limited sawtooth sample for a phase in [0,1) advancing by `dt` per sample. */
function sawAt(phase: number, dt: number): number {
  return 2 * phase - 1 - polyBlep(phase, dt);
}

/** MIDI note number to frequency in Hz. */
function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Constant-power pan, -1 hard left to +1 hard right. */
function panGains(p: number): [number, number] {
  const a = (clamp(p, -1, 1) + 1) * 0.25 * Math.PI;
  return [Math.cos(a), Math.sin(a)];
}

/**
 * Topology-preserving state variable filter. One instance yields low, band and
 * high outputs from the same state, which is why the pad, the clap and the hats
 * can all share it.
 */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  private low = 0;
  private band = 0;
  private high = 0;

  constructor(cutoffHz: number, q: number, sr: number) {
    this.set(cutoffHz, q, sr);
  }

  /** Retune the filter. Cheap enough to drive from an LFO every few dozen samples. */
  set(cutoffHz: number, q: number, sr: number): void {
    const g = Math.tan((Math.PI * clamp(cutoffHz, 15, sr * 0.45)) / sr);
    this.k = 1 / clamp(q, 0.4, 8);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  private tick(v0: number): void {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = v0 - this.k * v1 - v2;
  }

  /** Advance one sample and return the low-pass output. */
  lp(v0: number): number {
    this.tick(v0);
    return this.low;
  }

  /** Advance one sample and return the band-pass output. */
  bp(v0: number): number {
    this.tick(v0);
    return this.band;
  }

  /** Advance one sample and return the high-pass output. */
  hp(v0: number): number {
    this.tick(v0);
    return this.high;
  }
}

/** A stereo scratch buffer. Each instrument group accumulates into one of these. */
interface Bus {
  l: Float32Array;
  r: Float32Array;
}

function makeBus(n: number): Bus {
  return { l: new Float32Array(n), r: new Float32Array(n) };
}

/** Everything a voice needs: where to write, at what rate, and its noise source. */
interface Vox {
  bus: Bus;
  sr: number;
  nz: () => number;
}

// ── bus effects ──────────────────────────────────────────────────────────────

/**
 * Cross-fed feedback delay. Reading samples that were already written is what
 * makes it regenerate, and swapping channels turns the repeats into a ping-pong
 * that widens the arpeggio without detuning it.
 */
function applyPingPong(bus: Bus, sr: number, timeS: number, feedback: number): void {
  const d = Math.max(1, Math.round(timeS * sr));
  const fb = clamp(feedback, 0, 0.85);
  for (let i = d; i < bus.l.length; i++) {
    bus.l[i] += bus.r[i - d] * fb;
    bus.r[i] += bus.l[i - d] * fb;
  }
}

/**
 * Freeverb-style room: four damped combs into two allpasses, with the right
 * channel's delay lengths offset so the tail is genuinely stereo. Pads and bells
 * need a space to sit in or they sound like a synth test.
 */
function applyReverb(bus: Bus, sr: number, roomS: number, mix: number): void {
  const combs = [1116, 1188, 1277, 1356];
  const allpass = [556, 441];
  const wetGain = clamp(mix, 0, 1) * 0.22;
  for (let ch = 0; ch < 2; ch++) {
    const x = ch === 0 ? bus.l : bus.r;
    const off = ch === 0 ? 0 : 23;
    const wet = new Float32Array(x.length);
    for (const cd of combs) {
      const len = Math.max(2, Math.round(((cd + off) * sr) / 44100));
      const buf = new Float32Array(len);
      const fb = clamp(Math.exp((-3 * (len / sr)) / roomS), 0, 0.94);
      let store = 0;
      let p = 0;
      for (let i = 0; i < x.length; i++) {
        const y = buf[p];
        wet[i] += y;
        store = y * 0.72 + store * 0.28;
        buf[p] = x[i] + store * fb;
        if (++p >= len) p = 0;
      }
    }
    for (const ad of allpass) {
      const len = Math.max(2, Math.round(((ad + off) * sr) / 44100));
      const buf = new Float32Array(len);
      let p = 0;
      for (let i = 0; i < wet.length; i++) {
        const held = buf[p];
        const inv = wet[i];
        buf[p] = inv + held * 0.5;
        wet[i] = held - inv;
        if (++p >= len) p = 0;
      }
    }
    for (let i = 0; i < x.length; i++) x[i] += wet[i] * wetGain;
  }
}

/** Duck a window of the mix with short ramps, so a gate never clicks. */
function applyGate(l: Float32Array, r: Float32Array, sr: number, t0: number, t1: number, floor: number): void {
  const a = Math.max(0, Math.round(t0 * sr));
  const b = Math.min(l.length, Math.round(t1 * sr));
  const ramp = Math.max(1, Math.round(0.004 * sr));
  for (let i = a; i < b; i++) {
    const depth = Math.min(1, (i - a) / ramp, (b - 1 - i) / ramp);
    const g = 1 - (1 - floor) * depth;
    l[i] *= g;
    r[i] *= g;
  }
}

// ── harmony ──────────────────────────────────────────────────────────────────

const PITCH_CLASS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** A parsed key. `minor` picks both the scale colour and the progression. */
interface Key {
  tonicPc: number;
  minor: boolean;
  label: string;
}

/**
 * Accept the shapes a language model actually emits — "A minor", "F# major",
 * "Cm", "Bb Minor" — and fall back to A minor rather than failing a render.
 */
function parseKey(raw: string | undefined): Key {
  const text = typeof raw === "string" ? raw.trim() : "";
  const m = /^([A-Ga-g])\s*([#b♯♭]?)[\s\-_]*(minor|min|major|maj|m|M)?/.exec(text);
  if (!m) return { tonicPc: 9, minor: true, label: "A minor" };
  let pc = PITCH_CLASS[m[1].toLowerCase()];
  if (m[2] === "#" || m[2] === "♯") pc += 1;
  if (m[2] === "b" || m[2] === "♭") pc -= 1;
  pc = ((pc % 12) + 12) % 12;
  const word = m[3] ?? "";
  const minor = word === "M" ? false : word === "" ? true : /^(min|m$)/.test(word.toLowerCase());
  return { tonicPc: pc, minor, label: `${PITCH_NAMES[pc]} ${minor ? "minor" : "major"}` };
}

/** One step of a four-chord loop: root offset in semitones plus its quality. */
interface LoopStep {
  semi: number;
  minor: boolean;
}

/** i - VI - III - VII, the workhorse minor loop. */
const MINOR_LOOP: LoopStep[] = [
  { semi: 0, minor: true },
  { semi: 8, minor: false },
  { semi: 3, minor: false },
  { semi: 10, minor: false },
];

/** I - V - vi - IV for major keys. */
const MAJOR_LOOP: LoopStep[] = [
  { semi: 0, minor: false },
  { semi: 7, minor: false },
  { semi: 9, minor: true },
  { semi: 5, minor: false },
];

/** A voiced chord: MIDI notes already spread across octaves per instrument. */
interface Chord {
  rootMidi: number;
  /** Root, fifth, third and a colour tone, spread rather than stacked. */
  pad: number[];
  arp: number[];
  bell: number[];
}

/**
 * Voice one bar of the loop. Wide spacing at the bottom with the third lifted an
 * octave is what stops four simultaneous saws sounding like a cluster.
 */
function buildChord(key: Key, barIndex: number): Chord {
  const loop = key.minor ? MINOR_LOOP : MAJOR_LOOP;
  const step = loop[((barIndex % loop.length) + loop.length) % loop.length];
  const rootMidi = 36 + ((key.tonicPc + step.semi) % 12);
  const third = step.minor ? 3 : 4;
  const base = rootMidi + 12;
  const pad = step.minor
    ? [base, base + 7, base + 15, base + 22] // root, 5th, m3 up an octave, m7
    : [base, base + 7, base + 16, base + 26]; // root, 5th, M3 up an octave, 9th
  const arpBase = rootMidi + 24;
  const bellBase = rootMidi + 36;
  return {
    rootMidi,
    pad,
    arp: [arpBase, arpBase + third, arpBase + 7, arpBase + 12],
    bell: [bellBase, bellBase + 7, bellBase + 12, bellBase + 12 + third],
  };
}

// ── voices ───────────────────────────────────────────────────────────────────

/** Kick: 120 Hz swept to 45 Hz in ~60 ms, plus a noise transient. Centred. */
function addKick(v: Vox, t0: number, gain: number): void {
  const { bus, sr, nz } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round(0.34 * sr);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const k = start + i;
    const x = i / sr;
    const f = 45 + 75 * Math.exp(-x / 0.02);
    phase += f / sr;
    const body = Math.sin(2 * Math.PI * phase) * decay(x, 0.3);
    const click = nz() * decay(x, 0.006) * 0.45;
    const s = (body * 1.05 + click) * gain;
    if (k < 0) continue;
    if (k >= bus.l.length) break;
    bus.l[k] += s;
    bus.r[k] += s;
  }
}

/** Clap: band-passed noise with three pre-delay taps and a short room tail. */
function addClap(v: Vox, t0: number, gain: number): void {
  const { bus, sr, nz } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round(0.32 * sr);
  for (let ch = 0; ch < 2; ch++) {
    const out = ch === 0 ? bus.l : bus.r;
    const jitter = ch === 0 ? 0 : 0.0009; // decorrelates the two hands
    const taps = [0 + jitter, 0.008 + jitter, 0.017 + jitter];
    const bp = new Svf(1400 + ch * 120, 1.4, sr);
    for (let i = 0; i < n; i++) {
      const k = start + i;
      const x = i / sr;
      let a = 0;
      for (let tp = 0; tp < taps.length; tp++) {
        const dx = x - taps[tp];
        if (dx >= 0) a += decay(dx, 0.011) * (0.6 + 0.2 * tp);
      }
      a += decay(x, 0.19) * 0.3;
      const s = bp.bp(nz()) * a * gain;
      if (k < 0) continue;
      if (k >= out.length) break;
      out[k] += s;
    }
  }
}

/** Hat: high-passed noise with a very short decay, panned just off centre. */
function addHat(v: Vox, t0: number, gain: number, decayS: number, pan: number): void {
  const { bus, sr, nz } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round(decayS * 2.2 * sr);
  const hp = new Svf(7400, 0.9, sr);
  const [gl, gr] = panGains(pan);
  for (let i = 0; i < n; i++) {
    const k = start + i;
    const s = hp.hp(nz()) * decay(i / sr, decayS) * gain;
    if (k < 0) continue;
    if (k >= bus.l.length) break;
    bus.l[k] += s * gl;
    bus.r[k] += s * gr;
  }
}

/**
 * Sub bass: sine plus two quiet harmonics so the pitch survives a laptop
 * speaker. `attackS` is what turns the same voice from an intro swell into a
 * plucked drop bass.
 */
function addSub(v: Vox, t0: number, holdS: number, freq: number, gain: number, attackS: number, decayS: number): void {
  const { bus, sr } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round((holdS + 0.22) * sr);
  const step = freq / sr;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const k = start + i;
    const x = i / sr;
    phase += step;
    if (phase >= 1) phase -= 1;
    const w = 2 * Math.PI * phase;
    const tone = Math.sin(w) + 0.16 * Math.sin(2 * w) + 0.05 * Math.sin(3 * w);
    const env =
      (x < attackS ? smooth(x / attackS) : 1) *
      decay(Math.max(0, x - attackS), decayS) *
      (x <= holdS ? 1 : Math.max(0, 1 - (x - holdS) / 0.2));
    const s = tone * env * gain;
    if (k < 0) continue;
    if (k >= bus.l.length) break;
    bus.l[k] += s;
    bus.r[k] += s;
  }
}

/**
 * Warm pad: three detuned band-limited saws per chord tone through a resonant
 * low-pass with a slow LFO on cutoff. The two channels get mirrored detune and
 * an 11 ms offset, which is where the width comes from.
 */
function addPad(
  v: Vox,
  t0: number,
  holdS: number,
  freqs: number[],
  gain: number,
  cutoffHz: number,
  rnd: () => number,
): void {
  const { bus, sr } = v;
  const attack = 0.85;
  const release = 1.3;
  const n = Math.round((holdS + release) * sr);
  const start = Math.round(t0 * sr);
  const lfoHz = 0.09 + 0.06 * rnd();
  const seeds: number[] = [];
  for (let i = 0; i < freqs.length * 3; i++) seeds.push(rnd());
  for (let ch = 0; ch < 2; ch++) {
    const out = ch === 0 ? bus.l : bus.r;
    const offset = ch === 0 ? 0 : Math.round(0.011 * sr);
    const detune = ch === 0 ? [-0.16, 0, 0.13] : [0.15, 0, -0.14];
    const filt = new Svf(cutoffHz, 1.15, sr);
    const phase = seeds.slice();
    const voices = freqs.length * detune.length;
    let age = 1e9;
    for (let i = 0; i < n; i++) {
      const k = start + offset + i;
      const x = i / sr;
      if (age++ >= 32) {
        const lfo = Math.sin(2 * Math.PI * lfoHz * x + ch * 1.7);
        filt.set(cutoffHz * (1 + 0.22 * lfo), 1.15, sr);
        age = 0;
      }
      let s = 0;
      let vi = 0;
      for (let f = 0; f < freqs.length; f++) {
        for (let d = 0; d < detune.length; d++, vi++) {
          const fr = freqs[f] * Math.pow(2, detune[d] / 12);
          const dt = fr / sr;
          let p = phase[vi] + dt;
          if (p >= 1) p -= 1;
          phase[vi] = p;
          s += sawAt(p, dt);
        }
      }
      const env = x < attack ? smooth(x / attack) : x <= holdS ? 1 : smooth(1 - (x - holdS) / release);
      const y = filt.lp(s / voices) * env * gain;
      if (k < 0) continue;
      if (k >= out.length) break;
      out[k] += y;
    }
  }
}

/** Pluck: narrow band-limited pulse, percussive envelope, gently filtered. */
function addPluck(v: Vox, t0: number, freq: number, gain: number, decayS: number, pan: number, cutoffHz: number): void {
  const { bus, sr } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round((decayS * 1.9 + 0.01) * sr);
  const lp = new Svf(cutoffHz, 1.05, sr);
  const [gl, gr] = panGains(pan);
  const dt = freq / sr;
  const width = 0.28;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const k = start + i;
    const x = i / sr;
    phase += dt;
    if (phase >= 1) phase -= 1;
    const p2 = phase + width >= 1 ? phase + width - 1 : phase + width;
    const raw = (sawAt(phase, dt) - sawAt(p2, dt)) * 0.6;
    const s = lp.lp(raw) * Math.min(1, x / 0.002) * decay(x, decayS) * gain;
    if (k < 0) continue;
    if (k >= bus.l.length) break;
    bus.l[k] += s * gl;
    bus.r[k] += s * gr;
  }
}

/** Shimmer: two-operator FM bell, index decaying faster than amplitude. */
function addBell(v: Vox, t0: number, freq: number, gain: number, decayS: number, pan: number): void {
  const { bus, sr } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round(decayS * 1.4 * sr);
  const [gl, gr] = panGains(pan);
  let cp = 0;
  let mp = 0;
  for (let i = 0; i < n; i++) {
    const k = start + i;
    const x = i / sr;
    cp += freq / sr;
    mp += (freq * 3.51) / sr;
    const index = 2.6 * decay(x, decayS * 0.3);
    const s =
      Math.sin(2 * Math.PI * cp + index * Math.sin(2 * Math.PI * mp)) *
      Math.min(1, x / 0.003) *
      decay(x, decayS) *
      gain;
    if (k < 0) continue;
    if (k >= bus.l.length) break;
    bus.l[k] += s * gl;
    bus.r[k] += s * gr;
  }
}

/** Riser: sweeping band-passed noise plus an upward saw, amplitude accelerating. */
function addRiser(v: Vox, t0: number, durS: number, gain: number): void {
  const { bus, sr, nz } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round(durS * sr);
  const bpL = new Svf(300, 2.4, sr);
  const bpR = new Svf(318, 2.4, sr);
  let phase = 0;
  let age = 1e9;
  for (let i = 0; i < n; i++) {
    const k = start + i;
    const x = i / sr;
    const u = x / durS;
    if (age++ >= 32) {
      const f = 300 * Math.pow(24, u);
      bpL.set(f, 2.4, sr);
      bpR.set(f * 1.06, 2.4, sr);
      age = 0;
    }
    const f0 = 180 * Math.pow(2, u * 2.4);
    phase += f0 / sr;
    if (phase >= 1) phase -= 1;
    const tone = sawAt(phase, f0 / sr) * 0.3;
    // Tremolo that speeds up as the riser climbs; the ear reads it as urgency.
    const trem = 0.78 + 0.22 * Math.sin(2 * Math.PI * (6 + 20 * u) * x);
    const amp = Math.pow(u, 2.2) * trem * gain;
    const sl = (bpL.bp(nz()) * 0.9 + tone) * amp;
    const sr2 = (bpR.bp(nz()) * 0.9 + tone) * amp;
    if (k < 0) continue;
    if (k >= bus.l.length) break;
    bus.l[k] += sl;
    bus.r[k] += sr2;
  }
}

/** Impact: low sine boom with a long tail plus a filtered noise slam. Centred. */
function addImpact(v: Vox, t0: number, gain: number, tailS: number): void {
  const { bus, sr, nz } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round(tailS * 1.15 * sr);
  const lp = new Svf(900, 0.9, sr);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const k = start + i;
    const x = i / sr;
    const f = 30 + 34 * Math.exp(-x / 0.09);
    phase += f / sr;
    const boom = Math.sin(2 * Math.PI * phase) * decay(x, tailS);
    const slam = lp.lp(nz()) * decay(x, 0.2) * 0.5;
    const s = (boom + slam) * gain;
    if (k < 0) continue;
    if (k >= bus.l.length) break;
    bus.l[k] += s;
    bus.r[k] += s;
  }
}

/** Sweep: downward filtered noise whoosh, used to mark section changes. */
function addSweep(v: Vox, t0: number, durS: number, gain: number): void {
  const { bus, sr, nz } = v;
  const start = Math.round(t0 * sr);
  const n = Math.round(durS * sr);
  const bpL = new Svf(6500, 1.6, sr);
  const bpR = new Svf(6100, 1.6, sr);
  let age = 1e9;
  for (let i = 0; i < n; i++) {
    const k = start + i;
    const x = i / sr;
    const u = x / durS;
    if (age++ >= 32) {
      const f = 6500 * Math.pow(0.06, u);
      bpL.set(f, 1.6, sr);
      bpR.set(f * 0.94, 1.6, sr);
      age = 0;
    }
    const amp = Math.min(1, x / 0.04) * decay(Math.max(0, x - 0.04), durS * 0.7) * gain;
    const sl = bpL.bp(nz()) * amp;
    const sr2 = bpR.bp(nz()) * amp;
    if (k < 0) continue;
    if (k >= bus.l.length) break;
    bus.l[k] += sl;
    bus.r[k] += sr2;
  }
}

// ── arrangement plan ─────────────────────────────────────────────────────────

/** Piecewise-linear curve over time, used for the density and brightness arcs. */
function makeCurve(points: [number, number][]): (t: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const last = pts[pts.length - 1];
  return (t: number) => {
    if (t <= pts[0][0]) return pts[0][1];
    if (t >= last[0]) return last[1];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      if (t <= x1) {
        const [x0, y0] = pts[i - 1];
        if (x1 - x0 <= 1e-9) return y1;
        return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
      }
    }
    return last[1];
  };
}

/** Section times, grid and arcs derived from the spec before a sample is rendered. */
interface Plan {
  bpm: number;
  spb: number;
  stepS: number;
  barS: number;
  durationS: number;
  frames: number;
  introEndS: number;
  buildStartS: number;
  dropAtS: number;
  resolveAtS: number;
  finalHitS: number;
  /** Bar grid origin, at or before zero, chosen so a downbeat lands on the drop. */
  gridStartS: number;
  density: (t: number) => number;
  bright: (t: number) => number;
  /** Mix automation ride, 0..1. Sustained voices otherwise make a sparse intro loud. */
  level: (t: number) => number;
  events: TimelineEvent[];
}

function buildPlan(spec: DirectorSpec): Plan {
  const durationS = round(clamp(spec.duration_s, 6, 120), 3);
  const bpm = round(clamp(spec.music.bpm_target, 60, 190), 3);
  const spb = 60 / bpm;
  const barS = 4 * spb;
  const events = [...spec.events].sort((a, b) => a.t - b.t);
  const at = (kind: EventKind): number | undefined => events.find((e) => e.kind === kind)?.t;

  const dropAtS = clamp(spec.music.drop_at_s ?? at("drop") ?? durationS * 0.45, 3.2, durationS - 2.5);
  const resolveAtS = clamp(
    spec.music.resolve_at_s ?? at("resolve") ?? durationS - 5,
    dropAtS + 1.5,
    durationS - 1.2,
  );
  const buildStartS = clamp(spec.music.build_region_s?.[0] ?? at("build") ?? dropAtS - 6, 1.0, dropAtS - 1.8);
  const introEndS = clamp(at("accent") ?? buildStartS * 0.6, 0.7, buildStartS);
  const finalHitS = clamp(at("final_hit") ?? durationS - 1.2, resolveAtS, durationS - 1.0);

  // Density arc: sparse intro, percussion at the first accent, a build that
  // brightens, everything at the drop, then stripped back after the resolve.
  const density = makeCurve([
    [0, 0.02],
    [introEndS * 0.5, 0.13],
    [introEndS, 0.3],
    [buildStartS, 0.42],
    [dropAtS - 0.25, 0.86],
    [dropAtS, 1],
    [(dropAtS + resolveAtS) / 2, 0.95],
    [resolveAtS - 0.02, 0.9],
    [resolveAtS, 0.15],
    [durationS, 0.08],
  ]);
  const bright = makeCurve([
    [0, 0.06],
    [introEndS, 0.16],
    [buildStartS, 0.3],
    [dropAtS - 0.25, 0.82],
    [dropAtS, 1],
    [resolveAtS, 0.8],
    [durationS, 0.22],
  ]);

  // Mix automation. Pad and sub are sustained voices, so instrument count alone
  // does not make an intro quiet — RMS has to be ridden down as well, and lifted
  // again for the final hit so the last accent still reads as an accent.
  const level = makeCurve([
    [0, 0.3],
    [introEndS, 0.4],
    [buildStartS, 0.52],
    [dropAtS - 0.25, 0.9],
    [dropAtS, 1],
    [(dropAtS + resolveAtS) / 2, 0.98],
    [resolveAtS - 0.02, 0.95],
    [resolveAtS, 0.5],
    [Math.max(resolveAtS + 0.05, finalHitS - 0.4), 0.5],
    [finalHitS, 0.82],
    [durationS, 0.7],
  ]);

  // Put a bar line exactly on the drop so the impact lands on a downbeat.
  const gridStartS = dropAtS - Math.ceil(dropAtS / barS) * barS;

  return {
    bpm,
    spb,
    stepS: spb / 4,
    barS,
    durationS,
    frames: Math.round(durationS * SR),
    introEndS,
    buildStartS,
    dropAtS,
    resolveAtS,
    finalHitS,
    gridStartS,
    density,
    bright,
    level,
    events,
  };
}

// ── arrangement render ───────────────────────────────────────────────────────

/** Spec events become anchors so the composer can cut on the beat it asked for. */
const EVENT_ANCHOR: Record<EventKind, SynthResult["anchors"][number]["kind"]> = {
  intro: "section",
  accent: "accent",
  build: "section",
  drop: "drop",
  variation: "section",
  resolve: "section",
  final_hit: "peak",
};

/** Sixteenth-note figures the arpeggio walks through, chosen per bar. */
const ARP_PATTERNS = [
  [0, 1, 2, 3, 2, 1],
  [0, 2, 1, 3],
  [3, 2, 1, 0, 1, 2],
  [0, 1, 2, 1],
];

interface Rendered {
  mixL: Float32Array;
  mixR: Float32Array;
  anchors: SynthResult["anchors"];
}

/**
 * Render every voice into its own bus, apply the bus effects, gain-stage and sum.
 * Nothing here clips: each bus is normalised to a fixed headroom target and the
 * master chain runs afterwards on the sum.
 */
function renderVoices(plan: Plan, key: Key, seed: number): Rendered {
  const sr = SR;
  const n = plan.frames;
  const rnd = mulberry32(seed);
  const nz = () => rnd() * 2 - 1;

  const drums = makeBus(n);
  const hats = makeBus(n);
  const sub = makeBus(n);
  const pad = makeBus(n);
  const arp = makeBus(n);
  const bell = makeBus(n);
  const fx = makeBus(n);
  const vDrums: Vox = { bus: drums, sr, nz };
  // Hats get their own gain stage: inside the drum bus the kick would set the
  // peak and leave the top octave 16 dB down, which reads as a dull mix.
  const vHats: Vox = { bus: hats, sr, nz };
  const vSub: Vox = { bus: sub, sr, nz };
  const vPad: Vox = { bus: pad, sr, nz };
  const vArp: Vox = { bus: arp, sr, nz };
  const vBell: Vox = { bus: bell, sr, nz };
  const vFx: Vox = { bus: fx, sr, nz };

  const anchors: SynthResult["anchors"] = [];
  const barAt = (t: number) => Math.floor((t - plan.gridStartS) / plan.barS);
  const patSeed = Math.floor(rnd() * ARP_PATTERNS.length);

  const totalSteps = Math.ceil((plan.durationS - plan.gridStartS) / plan.stepS);
  for (let i = 0; i < totalSteps; i++) {
    const t = plan.gridStartS + i * plan.stepS;
    if (t >= plan.durationS - 0.02) break;
    const bar = Math.floor(i / 16);
    const s16 = i % 16;
    const tc = Math.max(0, t);
    const d = plan.density(tc);
    const br = plan.bright(tc);
    const chord = buildChord(key, bar);
    const tailRoom = plan.durationS - t;
    // Nothing new starts inside the drop-out; the silence is the point.
    const muted = t > plan.dropAtS - DROPOUT_S - 1e-6 && t < plan.dropAtS - 0.004;

    if (s16 === 0) {
      const hold = Math.min(plan.barS, Math.max(0.3, tailRoom - 0.5));
      addPad(vPad, t, hold, chord.pad.map(midiHz), 0.13 + 0.55 * d, 380 + 3500 * br, rnd);
    }

    if (muted || tailRoom <= 0.3) continue;

    // Sub: one swelling note per bar until the drop, then plucked with the kick.
    const plucked = t >= plan.dropAtS && t < plan.resolveAtS;
    if (plucked) {
      if (s16 % 4 === 0) addSub(vSub, t, plan.spb * 0.85, midiHz(chord.rootMidi - 12), 0.85, 0.004, 0.32);
    } else if (s16 === 0) {
      const hold = Math.min(plan.barS * 0.95, Math.max(0.3, tailRoom - 0.35));
      const slow = t < plan.introEndS;
      addSub(vSub, t, hold, midiHz(chord.rootMidi - 12), 0.22 + 0.55 * d, slow ? 0.7 : 0.06, 2.8);
    }

    // Kick: half-time while sparse, four-on-the-floor from the drop.
    const kick =
      d >= 0.2 &&
      (d < 0.45
        ? s16 === 0 || s16 === 8
        : d < 0.72
          ? s16 === 0 || s16 === 8 || s16 === 14
          : s16 % 4 === 0 || (s16 === 14 && bar % 2 === 1));
    if (kick) {
      addKick(vDrums, t, 0.9 + 0.1 * d);
      if (t >= 0) {
        anchors.push({
          t: round(t, 4),
          kind: s16 === 0 ? "downbeat" : "accent",
          strength: round(clamp(s16 === 0 ? 0.72 + 0.28 * d : 0.42 + 0.2 * d, 0, 1), 3),
        });
      }
    }

    if (d >= 0.34 && (s16 === 4 || s16 === 12)) {
      addClap(vDrums, t, 0.5 + 0.12 * d);
      if (t >= 0 && d >= 0.7) anchors.push({ t: round(t, 4), kind: "accent", strength: 0.6 });
    }
    if (d >= 0.82 && s16 === 15 && bar % 4 === 3) addClap(vDrums, t, 0.32);

    const hatDense = d >= 0.62;
    if (d >= 0.3 && (hatDense ? s16 % 2 === 0 : s16 % 4 === 2)) {
      const accented = s16 % 4 === 2;
      addHat(
        vHats,
        t,
        (accented ? 0.3 : 0.17) * (0.7 + 0.5 * d),
        accented ? 0.045 : 0.024,
        accented ? 0.18 : -0.22,
      );
    }

    // Arpeggio: eighths from the build, sixteenths once the drop is running.
    const arpDense = d >= 0.74;
    if (d >= 0.46 && (arpDense || s16 % 2 === 0)) {
      const pat = ARP_PATTERNS[(bar * 3 + patSeed) % ARP_PATTERNS.length];
      const hitIdx = arpDense ? s16 : s16 >> 1;
      const tone = chord.arp[pat[hitIdx % pat.length]];
      const lift = s16 === 6 || s16 === 14 ? 12 : 0;
      addPluck(
        vArp,
        t,
        midiHz(tone + lift),
        0.5 + 0.4 * d,
        arpDense ? 0.1 : 0.16,
        hitIdx % 2 === 0 ? -0.42 : 0.42,
        1600 + 5200 * br,
      );
    }

    // Shimmer on the bar line once the drop is running.
    if (d >= 0.85 && s16 === 0) {
      addBell(vBell, t, midiHz(chord.bell[bar % 2 === 0 ? 2 : 3]), 0.5, 1.5, bar % 2 === 0 ? 0.35 : -0.35);
    }
  }

  // Riser into the drop, stopping exactly where the drop-out begins.
  const riserStart = Math.max(0, plan.dropAtS - 1.85);
  const riserLen = plan.dropAtS - DROPOUT_S - riserStart;
  if (riserLen > 0.25) addRiser(vFx, riserStart, riserLen, 0.9);

  addImpact(vFx, plan.dropAtS, 1, 1.9);
  const dropChord = buildChord(key, barAt(plan.dropAtS));
  for (let k = 0; k < 3; k++) {
    addBell(
      vFx,
      plan.dropAtS + k * plan.stepS * 2,
      midiHz(dropChord.bell[k + 1]),
      0.55 - 0.1 * k,
      1.8,
      k === 0 ? -0.4 : k === 1 ? 0 : 0.4,
    );
  }

  // A downward sweep into the resolve, then a last impact and a clean tail.
  if (plan.resolveAtS > 1) addSweep(vFx, Math.max(0, plan.resolveAtS - 0.3), 1.2, 0.42);
  const lastImpactT = Math.min(plan.finalHitS, plan.durationS - 1.5);
  addImpact(vFx, lastImpactT, 0.95, Math.max(0.6, plan.durationS - lastImpactT - 0.35));
  const finalChord = buildChord(key, barAt(lastImpactT));
  addBell(vBell, lastImpactT, midiHz(finalChord.bell[1]), 0.7, Math.max(0.8, plan.durationS - lastImpactT - 0.3), 0);

  // Every spec accent gets audible support, so a visual hit is never silent.
  for (const e of plan.events) {
    if (e.kind !== "accent" && e.kind !== "variation") continue;
    addSweep(vFx, Math.max(0, e.t - 0.2), 0.6, 0.16 + 0.26 * e.intensity);
    addBell(
      vBell,
      e.t,
      midiHz(buildChord(key, barAt(e.t)).bell[2]),
      0.35 + 0.35 * e.intensity,
      1.1,
      e.kind === "accent" ? -0.28 : 0.28,
    );
  }

  applyPingPong(arp, sr, plan.spb * 0.75, 0.36); // dotted eighth, tempo synced
  applyReverb(pad, sr, 2.4, 0.55);
  applyReverb(bell, sr, 3.2, 0.8);
  applyReverb(fx, sr, 1.8, 0.22);

  // Gain staging: a fixed peak target per bus, so no instrument can clip alone.
  const mixL = new Float32Array(n);
  const mixR = new Float32Array(n);
  const layers: [Bus, number][] = [
    [drums, 0.8],
    [hats, 0.32],
    [sub, 0.62],
    [pad, 0.44],
    [arp, 0.32],
    [bell, 0.28],
    [fx, 0.72],
  ];
  for (const [b, target] of layers) {
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(b.l[i]);
      const c = Math.abs(b.r[i]);
      if (a > peak) peak = a;
      if (c > peak) peak = c;
    }
    const g = peak > 1e-9 ? target / peak : 0;
    for (let i = 0; i < n; i++) {
      mixL[i] += b.l[i] * g;
      mixR[i] += b.r[i] * g;
    }
  }

  // Ride the mix along the arrangement arc, recomputed every 64 samples because
  // the curve is far slower than audio rate.
  for (let i = 0; i < n; i += 64) {
    const g0 = plan.level(i / sr);
    const g1 = plan.level(Math.min(n - 1, i + 64) / sr);
    const end = Math.min(n, i + 64);
    for (let k = i; k < end; k++) {
      const g = g0 + ((g1 - g0) * (k - i)) / 64;
      mixL[k] *= g;
      mixR[k] *= g;
    }
  }

  // The drop-out: duck the last breath of the build so the impact lands on silence.
  applyGate(mixL, mixR, sr, plan.dropAtS - DROPOUT_S, plan.dropAtS - 0.006, 0.05);

  anchors.push({ t: round(plan.dropAtS, 4), kind: "drop", strength: 1 });
  for (const e of plan.events) {
    anchors.push({
      t: round(clamp(e.t, 0, plan.durationS), 4),
      kind: EVENT_ANCHOR[e.kind],
      strength: round(clamp(0.4 + 0.6 * e.intensity, 0, 1), 3),
    });
  }

  return { mixL, mixR, anchors };
}

// ── mastering ────────────────────────────────────────────────────────────────

interface MasterOut {
  l: Float32Array;
  r: Float32Array;
  peak: number;
  rms: number;
}

/**
 * Bus compressor, soft-clip limiter, DC block, peak normalise, fades. `drive` is
 * the only free parameter; the caller searches it so programme RMS lands in a
 * musical window without the peak ever reaching full scale.
 */
function runMaster(srcL: Float32Array, srcR: Float32Array, sr: number, drive: number): MasterOut {
  const n = srcL.length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(srcL[i]);
    const b = Math.abs(srcR[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const pre = peak > 1e-9 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) {
    l[i] = srcL[i] * pre;
    r[i] = srcR[i] * pre;
  }

  // Peak-detecting bus compression: 5 ms attack, 120 ms release, 3:1 over -14 dBFS.
  const th = 0.2;
  const ratio = 3;
  const atk = Math.exp(-1 / (0.005 * sr));
  const rel = Math.exp(-1 / (0.12 * sr));
  let env = 0;
  for (let i = 0; i < n; i++) {
    const det = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    env = det > env ? atk * env + (1 - atk) * det : rel * env + (1 - rel) * det;
    if (env > th) {
      const g = (th + (env - th) / ratio) / env;
      l[i] *= g;
      r[i] *= g;
    }
  }

  // Soft clip. tanh at these levels reads as glue rather than distortion, and it
  // makes hard digital clipping arithmetically impossible.
  for (let i = 0; i < n; i++) {
    l[i] = Math.tanh(l[i] * drive);
    r[i] = Math.tanh(r[i] * drive);
  }

  // DC block near 10 Hz: kick and sub waveforms are asymmetric enough to matter.
  const pole = 0.9985;
  let xl = 0;
  let yl = 0;
  let xr = 0;
  let yr = 0;
  for (let i = 0; i < n; i++) {
    const il = l[i];
    const ir = r[i];
    yl = il - xl + pole * yl;
    xl = il;
    l[i] = yl;
    yr = ir - xr + pole * yr;
    xr = ir;
    r[i] = yr;
  }

  let post = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(l[i]);
    const b = Math.abs(r[i]);
    if (a > post) post = a;
    if (b > post) post = b;
  }
  const norm = post > 1e-9 ? PEAK_CEILING / post : 1;
  for (let i = 0; i < n; i++) {
    l[i] *= norm;
    r[i] *= norm;
  }

  const fadeIn = Math.max(1, Math.round(0.015 * sr));
  for (let i = 0; i < Math.min(fadeIn, n); i++) {
    const g = smooth(i / fadeIn);
    l[i] *= g;
    r[i] *= g;
  }
  const fadeOut = Math.max(1, Math.round(0.4 * sr));
  for (let i = 0; i < Math.min(fadeOut, n); i++) {
    const k = n - 1 - i;
    const g = smooth(i / fadeOut);
    l[k] *= g;
    r[k] *= g;
  }

  let outPeak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(l[i]);
    const b = Math.abs(r[i]);
    if (a > outPeak) outPeak = a;
    if (b > outPeak) outPeak = b;
    sum += l[i] * l[i] + r[i] * r[i];
  }
  return { l, r, peak: outPeak, rms: n > 0 ? Math.sqrt(sum / (2 * n)) : 0 };
}

/**
 * Find the limiter drive that puts programme RMS on target. Drive versus RMS is
 * monotonic once the peak is normalised, so nine bisections on a log scale are
 * plenty, and the search stays deterministic.
 */
function masterToTarget(mixL: Float32Array, mixR: Float32Array, sr: number): MasterOut {
  let lo = 0.6;
  let hi = 8;
  let best = runMaster(mixL, mixR, sr, Math.sqrt(lo * hi));
  let bestErr = Math.abs(best.rms - RMS_TARGET);
  for (let it = 0; it < 9; it++) {
    const mid = Math.sqrt(lo * hi);
    const cand = runMaster(mixL, mixR, sr, mid);
    const err = Math.abs(cand.rms - RMS_TARGET);
    if (err < bestErr) {
      best = cand;
      bestErr = err;
    }
    if (cand.rms < RMS_TARGET) lo = mid;
    else hi = mid;
  }
  return best;
}

// ── analysis ─────────────────────────────────────────────────────────────────

/** Frame-wise RMS of the finished master, normalised to 0..1. */
function computeEnergy(l: Float32Array, r: Float32Array, sr: number, durationS: number): { t: number; v: number }[] {
  const hop = Math.max(1, Math.round(sr / ENERGY_FPS));
  const frames = Math.max(1, Math.floor(durationS * ENERGY_FPS));
  const raw = new Float64Array(frames);
  let max = 0;
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    const e = Math.min(l.length, s + hop);
    let acc = 0;
    let cnt = 0;
    for (let i = s; i < e; i++) {
      const m = (l[i] + r[i]) * 0.5;
      acc += m * m;
      cnt++;
    }
    raw[f] = cnt > 0 ? Math.sqrt(acc / cnt) : 0;
    if (raw[f] > max) max = raw[f];
  }
  const inv = max > 1e-9 ? 1 / max : 0;
  const out: { t: number; v: number }[] = [];
  for (let f = 0; f < frames; f++) {
    out.push({ t: round(f / ENERGY_FPS, 3), v: round(clamp(raw[f] * inv, 0, 1), 4) });
  }
  return out;
}

/** Sort, clamp and collapse anchors that name the same instant twice. */
function tidyAnchors(anchors: SynthResult["anchors"], durationS: number): SynthResult["anchors"] {
  const sorted = anchors
    .filter((a) => a.t >= 0 && a.t <= durationS)
    .sort((a, b) => (a.t === b.t ? b.strength - a.strength : a.t - b.t));
  const out: SynthResult["anchors"] = [];
  for (const a of sorted) {
    const dup = out.find((o) => o.kind === a.kind && Math.abs(o.t - a.t) < 0.01);
    if (dup) {
      if (a.strength > dup.strength) dup.strength = a.strength;
      continue;
    }
    out.push({ ...a });
  }
  return out;
}

// ── public api ───────────────────────────────────────────────────────────────

/**
 * Render a complete soundtrack for a spec. Deterministic in (spec, seed): the
 * same pair always produces the same bytes.
 */
export function synthesizeScore(spec: DirectorSpec, seed = 0x5eed1e): SynthResult {
  const plan = buildPlan(spec);
  const key = parseKey(spec.music.key);
  const { mixL, mixR, anchors } = renderVoices(plan, key, (seed >>> 0) ^ 0x9e3779b9);
  const master = masterToTarget(mixL, mixR, SR);
  const energy = computeEnergy(master.l, master.r, SR, plan.durationS);

  // The loudest analysis frame is the single most useful cut point in the reel.
  let peakFrame = 0;
  for (let i = 1; i < energy.length; i++) if (energy[i].v > energy[peakFrame].v) peakFrame = i;
  const withPeak = [
    ...anchors,
    { t: energy.length > 0 ? energy[peakFrame].t : 0, kind: "peak" as const, strength: 1 },
  ];

  return {
    wav: encodeWav(master.l, master.r, SR),
    durationS: round(master.l.length / SR, 6),
    sampleRate: SR,
    bpm: plan.bpm,
    anchors: tidyAnchors(withPeak, plan.durationS),
    energy,
  };
}

/** Fixed seeds so a given accent shape is bit-identical every time it is asked for. */
const ACCENT_SEEDS: Record<"impact" | "riser" | "sweep", number> = {
  impact: 0x1a9c07,
  riser: 0x215370,
  sweep: 0x5e3390,
};

/** Standalone one-shot used by the composer to add a missing accent to real audio. */
export function renderAccent(kind: "impact" | "riser" | "sweep", durationS: number, sampleRate: number = SR): Float32Array {
  const sr = clamp(Math.round(sampleRate), 8000, 192000);
  const n = Math.max(1, Math.round(clamp(durationS, 0.05, 12) * sr));
  const rnd = mulberry32(ACCENT_SEEDS[kind]);
  const v: Vox = { bus: makeBus(n), sr, nz: () => rnd() * 2 - 1 };
  const dur = n / sr;
  if (kind === "impact") addImpact(v, 0, 1, dur * 0.85);
  else if (kind === "riser") addRiser(v, 0, dur, 1);
  else addSweep(v, 0, dur, 1);

  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const m = (v.bus.l[i] + v.bus.r[i]) * 0.5;
    out[i] = m;
    const a = Math.abs(m);
    if (a > peak) peak = a;
  }
  // Normalise to -1 dBFS and taper both ends so the composer can drop it anywhere.
  const g = peak > 1e-9 ? PEAK_CEILING / peak : 0;
  const fi = Math.max(1, Math.round(0.004 * sr));
  const fo = Math.max(1, Math.round(0.02 * sr));
  for (let i = 0; i < n; i++) {
    out[i] = out[i] * g * smooth(Math.min(1, (i + 1) / fi, (n - i) / fo));
  }
  return out;
}

function toPcm16(v: number): number {
  const s = Math.round(clamp(v, -1, 1) * 32767);
  return s < -32768 ? -32768 : s > 32767 ? 32767 : s;
}

/** Write a Float32 stereo pair to a RIFF/WAVE buffer. The composer reuses this. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Buffer {
  const frames = Math.min(left.length, right.length);
  const blockAlign = 4; // 2 channels * 16 bit
  const data = Buffer.alloc(frames * blockAlign);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(toPcm16(left[i]), i * blockAlign);
    data.writeInt16LE(toPcm16(right[i]), i * blockAlign + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
