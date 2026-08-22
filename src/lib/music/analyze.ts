/**
 * Audio analysis: decode whatever the music model actually returned and measure
 * where the real musical moments are.
 *
 * A generative music model treats a requested timestamp as intent. The only way
 * to cut convincingly to its output is to look at the waveform: find the onsets,
 * estimate the tempo, locate the loudest sustained region, and hand the composer
 * a list of instants that genuinely exist in the audio. Everything here is pure
 * arithmetic over decoded PCM, so the same file always yields the same map.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { OUTPUT } from "@/lib/core/config";
import { clamp, permanent, round, transient } from "@/lib/core/util";
import type { ActualMusicMap, EnergyPoint, MusicAnchor } from "@/lib/music/types";

// ── tuning ───────────────────────────────────────────────────────────────────

/**
 * Analysis constants. Frame and hop are in samples: at 44.1kHz that is a 23ms
 * window every 11.6ms, fine enough to place a hit inside one 30fps video frame.
 */
export const ANALYSIS = {
  frame: 1024,
  hop: 512,
  /** Two novelty peaks closer than this are one hit smeared across frames. */
  minOnsetGapS: 0.06,
  /** Half-width of the moving window backing the adaptive onset threshold. */
  thresholdWindowS: 0.35,
  /** Standard deviations above the local mean a peak must clear. */
  thresholdK: 1.35,
  /** Novelty under this fraction of the loudest peak is noise, not a hit. */
  noiseFloorFraction: 0.02,
  /** Tempo band. Estimates outside it are octave-folded into it. */
  minBpm: 70,
  maxBpm: 180,
  /** Energy envelope resolution, points per second. */
  energyHz: 20,
  minPeakRegionS: 1.5,
  maxPeakRegionS: 6,
  /** Window compared before and after a candidate section boundary. */
  sectionWindowS: 1.0,
  sectionMinGapS: 2.0,
  /** Combined relative RMS/centroid change that counts as a new section. */
  sectionThreshold: 0.18,
} as const;

// ── FFT ──────────────────────────────────────────────────────────────────────

/**
 * In-place iterative radix-2 Cooley-Tukey FFT. There is no DSP dependency in
 * this project, so the transform lives here; it is constructed once per analysis
 * and reused for every frame.
 */
export class Fft {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly bitReverse: Uint32Array;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw permanent(`FFT size must be a power of two >= 2, got ${size}`);
    }
    this.size = size;
    const half = size >>> 1;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    let levels = 0;
    while (1 << levels < size) levels++;
    this.bitReverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) if ((i >>> b) & 1) r |= 1 << (levels - 1 - b);
      this.bitReverse[i] = r;
    }
  }

  /**
   * Forward DFT with the exp(-2i*pi*kn/N) kernel. Both arrays are overwritten
   * with the result.
   */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) {
      throw permanent(`FFT expects two arrays of length ${n}`);
    }
    for (let i = 0; i < n; i++) {
      const j = this.bitReverse[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let span = 2; span <= n; span <<= 1) {
      const half = span >>> 1;
      const step = n / span;
      for (let base = 0; base < n; base += span) {
        for (let j = base, k = 0; j < base + half; j++, k += step) {
          const l = j + half;
          const c = this.cosTable[k];
          const s = this.sinTable[k];
          const tre = re[l] * c + im[l] * s;
          const tim = -re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

/** Magnitude spectrum of one real frame, bins 0..size/2 inclusive. */
export function magnitudeSpectrum(fft: Fft, frame: ArrayLike<number>): Float64Array {
  const n = fft.size;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n && i < frame.length; i++) re[i] = frame[i];
  fft.transform(re, im);
  const bins = (n >>> 1) + 1;
  const out = new Float64Array(bins);
  for (let b = 0; b < bins; b++) out[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
  return out;
}

// ── decoding ─────────────────────────────────────────────────────────────────

/**
 * Decode any audio container ffmpeg can read to mono 32-bit float PCM. The
 * output is streamed off ffmpeg's stdout as binary chunks and never buffered as
 * text, so a multi-megabyte clip costs one copy.
 */
export async function decodeToMono(
  filePath: string,
  sampleRate: number = OUTPUT.audioSampleRate,
): Promise<{ samples: Float32Array; sampleRate: number; durationS: number }> {
  if (!fs.existsSync(filePath)) throw permanent(`audio file not found: ${filePath}`);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) {
    throw permanent(`invalid sample rate ${sampleRate}`);
  }
  const sr = Math.round(sampleRate);
  const args = [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "-ac",
    "1",
    "-ar",
    String(sr),
    "-",
  ];

  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let errBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      // Keep only the head of stderr: enough to diagnose, bounded in memory.
      if (errBytes < 8192) {
        errChunks.push(c);
        errBytes += c.length;
      }
    });
    child.on("error", (e) => reject(transient(`ffmpeg could not be started: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const msg = Buffer.concat(errChunks).toString("utf8").trim();
      reject(
        permanent(`ffmpeg decode failed (exit ${code}): ${msg || "no stderr"}`, { filePath }),
      );
    });
  });

  const raw = Buffer.concat(chunks);
  const count = Math.floor(raw.length / 4);
  if (count === 0) throw permanent(`decoded zero samples from ${filePath}`);
  // A DataView reads little-endian floats regardless of how the concatenated
  // buffer happens to be aligned, which a Float32Array view cannot promise.
  const view = new DataView(raw.buffer, raw.byteOffset, count * 4);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getFloat32(i * 4, true);
  return { samples, sampleRate: sr, durationS: count / sr };
}

// ── framewise features ───────────────────────────────────────────────────────

interface FrameFeatures {
  /** Centre of the analysis window in seconds, where Hann weighting peaks. */
  t: number;
  /** Half-wave-rectified spectral flux against the previous frame. */
  flux: number;
  rms: number;
  /** Spectral centroid in Hz; a proxy for brightness. */
  centroid: number;
}

function computeFrames(samples: Float32Array, sampleRate: number): FrameFeatures[] {
  const { frame, hop } = ANALYSIS;
  const total = Math.floor((samples.length - frame) / hop) + 1;
  if (total < 1) return [];
  const fft = new Fft(frame);
  const win = new Float64Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
  const bins = (frame >>> 1) + 1;
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const prev = new Float64Array(bins);
  const cur = new Float64Array(bins);
  const binHz = sampleRate / frame;
  const out: FrameFeatures[] = [];

  for (let f = 0; f < total; f++) {
    const off = f * hop;
    let sumSq = 0;
    for (let i = 0; i < frame; i++) {
      const s = samples[off + i];
      sumSq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    let magSum = 0;
    let weighted = 0;
    let flux = 0;
    for (let b = 0; b < bins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      // Log compression keeps a quiet intro's onsets comparable with the drop's,
      // which a linear flux curve would bury.
      const comp = Math.log1p(mag);
      cur[b] = comp;
      const d = comp - prev[b];
      if (d > 0) flux += d;
      magSum += mag;
      weighted += mag * b * binHz;
    }
    prev.set(cur);
    out.push({
      t: (off + frame / 2) / sampleRate,
      flux: f === 0 ? 0 : flux,
      rms: Math.sqrt(sumSq / frame),
      centroid: magSum > 1e-9 ? weighted / magSum : 0,
    });
  }
  return out;
}

/** Centred moving average, used to smooth novelty, RMS and centroid curves. */
function movingAverage(values: Float64Array, halfWidth: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const w = Math.max(0, Math.floor(halfWidth));
  if (w === 0) {
    out.set(values);
    return out;
  }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(n - 1, i + w);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

// ── onsets ───────────────────────────────────────────────────────────────────

interface RawOnset {
  frame: number;
  t: number;
  /** Raw novelty height, normalised later against the loudest hits. */
  flux: number;
}

function pickOnsets(frames: FrameFeatures[], sampleRate: number): RawOnset[] {
  const n = frames.length;
  if (n < 4) return [];
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = frames[i].flux;
  const nov = movingAverage(raw, 1);

  const hopS = ANALYSIS.hop / sampleRate;
  const win = Math.max(3, Math.round(ANALYSIS.thresholdWindowS / hopS));
  const prefix = new Float64Array(n + 1);
  const prefixSq = new Float64Array(n + 1);
  let globalMax = 0;
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + nov[i];
    prefixSq[i + 1] = prefixSq[i] + nov[i] * nov[i];
    if (nov[i] > globalMax) globalMax = nov[i];
  }
  if (globalMax <= 1e-9) return [];
  const noiseFloor = globalMax * ANALYSIS.noiseFloorFraction;
  const gapFrames = Math.max(1, Math.round(ANALYSIS.minOnsetGapS / hopS));
  const peakHalf = 3;

  const onsets: RawOnset[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = nov[i];
    if (v <= noiseFloor) continue;

    // Strict local maximum, ties resolved toward the earlier frame so the result
    // never depends on iteration order.
    let isMax = true;
    const lo = Math.max(0, i - peakHalf);
    const hi = Math.min(n - 1, i + peakHalf);
    for (let j = lo; j <= hi && isMax; j++) {
      if (j === i) continue;
      if (nov[j] > v || (nov[j] === v && j < i)) isMax = false;
    }
    if (!isMax) continue;

    const wlo = Math.max(0, i - win);
    const whi = Math.min(n - 1, i + win);
    const cnt = whi - wlo + 1;
    const mean = (prefix[whi + 1] - prefix[wlo]) / cnt;
    const variance = Math.max(0, (prefixSq[whi + 1] - prefixSq[wlo]) / cnt - mean * mean);
    if (v < mean + ANALYSIS.thresholdK * Math.sqrt(variance)) continue;

    // The smoothed curve decides whether this is an onset; the unsmoothed curve
    // decides exactly when, because smoothing can shift a peak by a frame.
    let best = i;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
      if (raw[j] > raw[best]) best = j;
    }

    const last = onsets.length > 0 ? onsets[onsets.length - 1] : null;
    if (last && best - last.frame < gapFrames) {
      // Same hit: keep whichever frame carries more novelty.
      if (v > last.flux) onsets[onsets.length - 1] = { frame: best, t: frames[best].t, flux: v };
      continue;
    }
    onsets.push({ frame: best, t: frames[best].t, flux: v });
  }
  return onsets;
}

/**
 * Reference level for normalising onset strength. The loudest onset defines 1.0,
 * which keeps strengths strictly ordered so ranking anchors never hits a tie.
 */
function strengthReference(onsets: RawOnset[]): number {
  let max = 0;
  for (const o of onsets) if (o.flux > max) max = o.flux;
  return Math.max(max, 1e-9);
}

// ── tempo ────────────────────────────────────────────────────────────────────

/** Fold a tempo into the analysis band by octave halving or doubling. */
function foldBpm(bpm: number): number | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  let b = bpm;
  let guard = 0;
  while (b < ANALYSIS.minBpm && guard++ < 24) b *= 2;
  while (b > ANALYSIS.maxBpm && guard++ < 48) b /= 2;
  if (b < ANALYSIS.minBpm || b > ANALYSIS.maxBpm) return null;
  return b;
}

/** Broad log-normal preference for mid tempi, which resolves octave ambiguity. */
function tempoPrior(bpm: number): number {
  const z = Math.log2(bpm / 120) / 0.9;
  return Math.exp(-0.5 * z * z);
}

const BPM_STEP = 0.25;

function bpmAxisLength(): number {
  return Math.round((ANALYSIS.maxBpm - ANALYSIS.minBpm) / BPM_STEP) + 1;
}

function addBpmVote(scores: Float64Array, bpm: number, weight: number, sigma: number): void {
  if (!(weight > 0)) return;
  const len = scores.length;
  const centre = (bpm - ANALYSIS.minBpm) / BPM_STEP;
  const spread = Math.ceil((3 * sigma) / BPM_STEP);
  const lo = Math.max(0, Math.floor(centre - spread));
  const hi = Math.min(len - 1, Math.ceil(centre + spread));
  for (let i = lo; i <= hi; i++) {
    const d = (i - centre) * BPM_STEP;
    scores[i] += weight * Math.exp(-0.5 * (d / sigma) * (d / sigma));
  }
}

function normaliseInPlace(scores: Float64Array): void {
  let max = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i] > max) max = scores[i];
  if (max <= 0) return;
  for (let i = 0; i < scores.length; i++) scores[i] /= max;
}

/**
 * Tempo from two independent views of the same evidence: the inter-onset
 * interval histogram, which is sharp when the onsets are clean, and
 * autocorrelation of the novelty curve, which survives missed onsets. Each is
 * normalised before they are summed so neither can dominate on scale alone.
 */
function estimateTempo(frames: FrameFeatures[], onsets: RawOnset[], sampleRate: number): number {
  const len = bpmAxisLength();
  const ioi = new Float64Array(len);
  const acf = new Float64Array(len);
  const ref = strengthReference(onsets);

  for (let i = 0; i < onsets.length; i++) {
    for (let j = i + 1; j < Math.min(i + 5, onsets.length); j++) {
      const dt = onsets[j].t - onsets[i].t;
      if (dt < 0.2 || dt > 2.2) continue;
      const folded = foldBpm(60 / dt);
      if (folded === null) continue;
      const si = clamp(onsets[i].flux / ref, 0, 1);
      const sj = clamp(onsets[j].flux / ref, 0, 1);
      addBpmVote(ioi, folded, ((si * sj) / (j - i)) * tempoPrior(folded), 1);
    }
  }

  const n = frames.length;
  const hopS = ANALYSIS.hop / sampleRate;
  const voteLo = Math.max(2, Math.round(60 / (330 * hopS)));
  const voteHi = Math.min(Math.floor(n / 2), Math.round(60 / (30 * hopS)));
  if (n > 8 && voteHi > voteLo) {
    const nov = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += frames[i].flux;
    mean /= n;
    for (let i = 0; i < n; i++) nov[i] = frames[i].flux - mean;

    // Detrend width, in lags. The raw autocorrelation of a novelty curve falls
    // away smoothly with lag, which would always favour the shortest lag; what
    // identifies the beat is the comb of local bumps riding on that decay.
    const trendHalf = 12;
    const lagLo = Math.max(2, voteLo - trendHalf);
    const lagHi = Math.min(n - 2, voteHi + trendHalf);
    const r = new Float64Array(lagHi + 1);
    for (let lag = lagLo; lag <= lagHi; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < n; i++) sum += nov[i] * nov[i + lag];
      r[lag] = sum / (n - lag);
    }
    for (let lag = voteLo; lag <= voteHi; lag++) {
      let base = 0;
      let cnt = 0;
      for (let j = Math.max(lagLo, lag - trendHalf); j <= Math.min(lagHi, lag + trendHalf); j++) {
        base += r[j];
        cnt++;
      }
      const residual = r[lag] - base / Math.max(1, cnt);
      if (residual <= 0) continue;
      const folded = foldBpm(60 / (lag * hopS));
      if (folded === null) continue;
      addBpmVote(acf, folded, residual * tempoPrior(folded), 1);
    }
  }

  normaliseInPlace(ioi);
  normaliseInPlace(acf);
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < len; i++) {
    const s = ioi[i] + acf[i];
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  // Nothing periodic in the signal: report the band centre rather than a lie.
  if (bestIdx < 0) return 120;
  return round(ANALYSIS.minBpm + bestIdx * BPM_STEP, 2);
}

/**
 * Beat-grid phase: the offset that best aligns strong onsets to a grid of the
 * estimated period. Searched on a fixed lattice so the answer is reproducible.
 */
function beatPhase(onsets: RawOnset[], periodS: number, ref: number): number {
  if (onsets.length === 0 || !(periodS > 0)) return 0;
  const steps = 96;
  const sigma = Math.max(0.02, periodS * 0.08);
  let bestPhase = 0;
  let bestScore = -1;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * periodS;
    let score = 0;
    for (const o of onsets) {
      const rel = (((o.t - phase) % periodS) + periodS) % periodS;
      const d = Math.min(rel, periodS - rel);
      score += clamp(o.flux / ref, 0, 1) * Math.exp(-0.5 * (d / sigma) * (d / sigma));
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return bestPhase;
}

// ── sections, peak region, energy ────────────────────────────────────────────

function detectSections(
  frames: FrameFeatures[],
  sampleRate: number,
): { t: number; strength: number }[] {
  const n = frames.length;
  const hopS = ANALYSIS.hop / sampleRate;
  const w = Math.max(2, Math.round(ANALYSIS.sectionWindowS / hopS));
  if (n < 4 * w) return [];
  const rmsRaw = new Float64Array(n);
  const centRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    rmsRaw[i] = frames[i].rms;
    centRaw[i] = frames[i].centroid;
  }
  const smoothHalf = Math.max(1, Math.round(0.25 / hopS));
  const rms = movingAverage(rmsRaw, smoothHalf);
  const cent = movingAverage(centRaw, smoothHalf);

  const change = new Float64Array(n);
  for (let i = w; i < n - w; i++) {
    let rb = 0;
    let ra = 0;
    let cb = 0;
    let ca = 0;
    for (let j = 1; j <= w; j++) {
      rb += rms[i - j];
      ra += rms[i + j - 1];
      cb += cent[i - j];
      ca += cent[i + j - 1];
    }
    rb /= w;
    ra /= w;
    cb /= w;
    ca /= w;
    // Relative changes, so a loud track and a quiet one share one threshold.
    const rc = Math.abs(ra - rb) / (ra + rb + 1e-9);
    const cc = Math.abs(ca - cb) / (ca + cb + 1e-9);
    change[i] = 0.65 * rc + 0.35 * cc;
  }

  const minGap = Math.round(ANALYSIS.sectionMinGapS / hopS);
  const localHalf = Math.max(2, Math.round(w / 2));
  const out: { t: number; strength: number }[] = [];
  let lastIdx = -Infinity;
  for (let i = w; i < n - w; i++) {
    const v = change[i];
    if (v < ANALYSIS.sectionThreshold) continue;
    let isMax = true;
    for (let j = Math.max(0, i - localHalf); j <= Math.min(n - 1, i + localHalf) && isMax; j++) {
      if (j === i) continue;
      if (change[j] > v || (change[j] === v && j < i)) isMax = false;
    }
    if (!isMax) continue;
    if (i - lastIdx < minGap) continue;
    out.push({ t: frames[i].t, strength: clamp(v * 3, 0.35, 1) });
    lastIdx = i;
  }
  return out;
}

function findPeakRegion(frames: FrameFeatures[], sampleRate: number): [number, number] | null {
  const n = frames.length;
  if (n === 0) return null;
  const hopS = ANALYSIS.hop / sampleRate;
  const w = Math.min(n, Math.max(2, Math.round(ANALYSIS.minPeakRegionS / hopS)));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + frames[i].rms;
  let bestStart = 0;
  let bestMean = -1;
  for (let s = 0; s + w <= n; s++) {
    const mean = (prefix[s + w] - prefix[s]) / w;
    if (mean > bestMean) {
      bestMean = mean;
      bestStart = s;
    }
  }
  if (bestMean <= 0) return null;
  // Grow outward while the region's own mean stays near the peak level, so the
  // result covers the whole sustained passage instead of an arbitrary window
  // length, and a single dipping frame does not stop the expansion.
  const maxFrames = Math.round(ANALYSIS.maxPeakRegionS / hopS);
  let lo = bestStart;
  let hi = Math.min(n - 1, bestStart + w - 1);
  const keep = bestMean * 0.85;
  while (hi - lo + 1 < maxFrames) {
    const loRms = lo > 0 ? frames[lo - 1].rms : -1;
    const hiRms = hi < n - 1 ? frames[hi + 1].rms : -1;
    if (loRms < 0 && hiRms < 0) break;
    const takeLo = loRms >= hiRms;
    const next = takeLo ? lo - 1 : hi + 1;
    const span = hi - lo + 2;
    const mean = (prefix[Math.max(hi, next) + 1] - prefix[Math.min(lo, next)]) / span;
    if (mean < keep) break;
    if (takeLo) lo = next;
    else hi = next;
  }
  return [round(frames[lo].t, 3), round(frames[hi].t, 3)];
}

function buildEnergy(frames: FrameFeatures[], durationS: number): EnergyPoint[] {
  if (frames.length === 0) return [];
  let maxRms = 0;
  for (const f of frames) if (f.rms > maxRms) maxRms = f.rms;
  const scale = maxRms > 1e-9 ? 1 / maxRms : 0;
  const step = 1 / ANALYSIS.energyHz;
  const count = Math.max(1, Math.floor(durationS * ANALYSIS.energyHz));
  const out: EnergyPoint[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const lo = i * step;
    const hi = lo + step;
    while (cursor < frames.length && frames[cursor].t < lo) cursor++;
    let sum = 0;
    let seen = 0;
    let scan = cursor;
    while (scan < frames.length && frames[scan].t < hi) {
      sum += frames[scan].rms;
      seen++;
      scan++;
    }
    // Buckets past the last frame centre reuse the final frame's level rather
    // than reading as sudden silence.
    const v = seen > 0 ? sum / seen : frames[Math.min(frames.length - 1, cursor)].rms;
    out.push({ t: round(lo, 3), v: round(clamp(v * scale, 0, 1), 4) });
  }
  return out;
}

// ── assembly ─────────────────────────────────────────────────────────────────

/**
 * Which label survives when two anchors name the same instant. Ordered by how
 * much the label tells the composer about cutting there, which is the same order
 * reconciliation trusts them in.
 */
const KIND_PRIORITY: Record<MusicAnchor["kind"], number> = {
  peak: 5,
  drop: 5,
  accent: 4,
  downbeat: 3,
  section: 2,
  onset: 1,
};

/** Collapse anchors that name the same instant, keeping the more specific kind. */
function dedupeAnchors(anchors: MusicAnchor[]): MusicAnchor[] {
  const sorted = [...anchors].sort((a, b) =>
    a.t === b.t ? KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] : a.t - b.t,
  );
  const out: MusicAnchor[] = [];
  for (const a of sorted) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last && Math.abs(a.t - last.t) < 0.012) {
      if (KIND_PRIORITY[a.kind] > KIND_PRIORITY[last.kind]) out[out.length - 1] = a;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Turn decoded PCM into the map the composer cuts against. Total: degenerate
 * input yields an empty but valid map instead of an exception.
 */
export function analyzeSamples(samples: Float32Array, sampleRate: number): ActualMusicMap {
  const sr = Math.max(1, Math.round(sampleRate));
  const durationS = round(samples.length / sr, 3);
  // The samples are already decoded and in hand, so the peak is free to take here rather
  // than by shelling out to a second ffmpeg pass later.
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  peak = round(peak, 5);
  const frames = computeFrames(samples, sr);
  if (frames.length === 0) {
    return {
      durationS,
      bpm: 120,
      sampleRate: sr,
      anchors: [],
      energy: [],
      peakRegionS: null,
      peak,
      measured: true,
    };
  }

  const onsets = pickOnsets(frames, sr);
  const ref = strengthReference(onsets);
  const bpm = estimateTempo(frames, onsets, sr);
  const periodS = 60 / bpm;
  const phase = beatPhase(onsets, periodS, ref);

  // Top quartile of onset strength is what reads as an accent worth cutting on.
  const strengths = onsets.map((o) => clamp(o.flux / ref, 0, 1)).sort((a, b) => b - a);
  const accentThreshold =
    strengths.length >= 4 ? strengths[Math.floor(strengths.length * 0.25)] : Infinity;
  const gridTolerance = Math.min(0.07, periodS * 0.12);

  const anchors: MusicAnchor[] = [];
  for (const o of onsets) {
    const strength = clamp(o.flux / ref, 0, 1);
    const rel = (((o.t - phase) % periodS) + periodS) % periodS;
    const onGrid = Math.min(rel, periodS - rel) <= gridTolerance;
    const kind: MusicAnchor["kind"] =
      strength >= accentThreshold ? "accent" : onGrid ? "downbeat" : "onset";
    anchors.push({ t: round(o.t, 3), kind, strength: round(strength, 4) });
  }

  for (const s of detectSections(frames, sr)) {
    anchors.push({ t: round(s.t, 3), kind: "section", strength: round(s.strength, 4) });
  }

  let loudest = 0;
  for (let i = 1; i < frames.length; i++) if (frames[i].rms > frames[loudest].rms) loudest = i;
  if (frames[loudest].rms > 1e-9) {
    anchors.push({ t: round(frames[loudest].t, 3), kind: "peak", strength: 1 });
  }

  return {
    durationS,
    bpm,
    sampleRate: sr,
    anchors: dedupeAnchors(anchors),
    energy: buildEnergy(frames, durationS),
    peakRegionS: findPeakRegion(frames, sr),
    peak,
    measured: true,
  };
}

/** Decode a file and analyse it in one call. */
export async function analyzeFile(
  filePath: string,
  sampleRate: number = OUTPUT.audioSampleRate,
): Promise<ActualMusicMap> {
  const decoded = await decodeToMono(filePath, sampleRate);
  return analyzeSamples(decoded.samples, decoded.sampleRate);
}
