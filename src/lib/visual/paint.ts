/**
 * The pure half of the local visual engine: seeded numbers, colour reading, and
 * the procedural painter.
 *
 * Nothing in this module touches the filesystem or a child process, which is what
 * makes the engine reproducible. Randomness always comes from an explicit seed
 * through a local PRNG, and the pixel maths deliberately sticks to arithmetic and
 * sqrt so a frame painted here does not depend on a platform math library.
 *
 * The colour lexicon exists because a StyleBible palette is prose written for an
 * image model ("dusty teal", "burnt amber"), not hex. The local engine has to
 * grade toward those words, so it needs its own reading of them.
 */
import { clamp, lerp } from "@/lib/core/util";
import type { StyleBible } from "@/lib/spec/directorSpec";

// ── determinism helpers ──────────────────────────────────────────────────────

/** mulberry32: small, fast, fully reproducible. Never Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, used to fold prose (a scene action, a palette phrase) into a seed. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pixel maths uses arithmetic and sqrt only, so a frame is not libm-bound. */
const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ── colour ───────────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

export const lum = (c: RGB): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function chroma(c: RGB): number {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  return mx <= 0 ? 0 : (mx - mn) / mx;
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function toHex(c: RGB): string {
  const part = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  return `#${part(c[0])}${part(c[1])}${part(c[2])}`;
}

/**
 * Colour words a Director actually writes into a palette. StyleBible palettes are
 * prose ("dusty teal", "burnt amber"), not hex, so the local engine needs its own
 * reading of them to grade toward.
 */
const COLOUR_WORDS: Record<string, number> = {
  black: 0x0d0d10, ink: 0x14161f, charcoal: 0x2b2b30, graphite: 0x35373c, slate: 0x4a5a6a,
  grey: 0x8a8a8e, gray: 0x8a8a8e, silver: 0xc0c4c8, smoke: 0x9aa0a6, pearl: 0xe8e6e0,
  white: 0xf6f5f2, cream: 0xf2e6cd, ivory: 0xefe7d6, bone: 0xe3dccb, sand: 0xd9c39a,
  beige: 0xd8caa8, tan: 0xc39a6f, taupe: 0x9c8b78, khaki: 0xb3a578, brown: 0x6b4a32,
  sepia: 0x8a6a44, umber: 0x6a4a2c, rust: 0xa4522a, terracotta: 0xb85f3c, brick: 0x8f4231,
  copper: 0xb87333, bronze: 0x8a6236, brass: 0xb59a4a, gold: 0xd8a63c, amber: 0xd98f2b,
  honey: 0xdca94a, ochre: 0xc08a2a, yellow: 0xe3c34a, lime: 0xa8c73c, chartreuse: 0xb6c94a,
  olive: 0x6f7238, moss: 0x5c6b46, green: 0x3f7a4f, emerald: 0x2f8a63, mint: 0x9fd6bd,
  teal: 0x2f6f75, turquoise: 0x3aa8a0, aqua: 0x6fc7cb, cyan: 0x4fbcd0, azure: 0x3f86c4,
  blue: 0x3560a8, navy: 0x1e2a52, indigo: 0x2d2a6b, cobalt: 0x2a4fa8, periwinkle: 0x8fa2dc,
  violet: 0x6b4aa8, purple: 0x5f3f86, lavender: 0xb3a4d6, mauve: 0xa2849a, plum: 0x6b3a55,
  magenta: 0xb03a7a, fuchsia: 0xc44a92, pink: 0xdca0ae, blush: 0xe0b3ad, rose: 0xc9787c,
  coral: 0xdc7a5e, salmon: 0xd98a72, peach: 0xe8b394, apricot: 0xdfa268, orange: 0xd97a2b,
  red: 0xb83a32, scarlet: 0xc4362c, crimson: 0xa22a3a, maroon: 0x6b2430, burgundy: 0x5c2130,
  midnight: 0x141c33, dusk: 0x4a3f5c, sunset: 0xd9723c, sky: 0x7fa8cc, sea: 0x2f6a7a,
  earth: 0x6b503a, stone: 0x8c8579, paper: 0xe8e0cf, neon: 0x33f0a8, chrome: 0xcdd2d6,
};

/** Words that shift a base colour rather than naming one. */
function applyModifier(word: string, c: RGB): RGB | null {
  switch (word) {
    case "deep":
    case "dark":
    case "shadowed":
      return mixRgb(c, [0, 0, 0], 0.34);
    case "burnt":
    case "smoked":
      return mixRgb(mixRgb(c, [0, 0, 0], 0.18), [140, 60, 24], 0.16);
    case "pale":
    case "light":
    case "soft":
    case "washed":
      return mixRgb(c, [246, 244, 238], 0.42);
    case "muted":
    case "dusty":
    case "faded":
    case "hazy": {
      const g = lum(c);
      return mixRgb(c, [g, g, g], 0.38);
    }
    case "warm":
      return mixRgb(c, [214, 132, 62], 0.18);
    case "cool":
      return mixRgb(c, [70, 118, 168], 0.18);
    case "electric":
    case "neon":
    case "vivid": {
      const g = lum(c);
      return [
        clamp(c[0] + (c[0] - g) * 0.5, 0, 255),
        clamp(c[1] + (c[1] - g) * 0.5, 0, 255),
        clamp(c[2] + (c[2] - g) * 0.5, 0, 255),
      ];
    }
    default:
      return null;
  }
}

export function resolveColor(phrase: string): RGB {
  const trimmed = phrase.trim();
  const hex = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (hex) {
    const v = parseInt(hex[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const words = trimmed.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let base: RGB | null = null;
  for (const w of words) {
    const hit = COLOUR_WORDS[w];
    if (hit !== undefined) base = [(hit >> 16) & 255, (hit >> 8) & 255, hit & 255];
  }
  if (!base) {
    // Deterministic but deliberately restrained: moderate chroma and mid luma, so
    // even a palette phrase we cannot read still grades like an art direction.
    const rnd = mulberry32(hash32(trimmed));
    const a = rnd();
    const b = rnd();
    base = [90 + 110 * a, 80 + 100 * b, 90 + 110 * (1 - a * 0.7)];
  }
  for (const w of words) {
    const shifted = applyModifier(w, base);
    if (shifted) base = shifted;
  }
  return [clamp(base[0], 0, 255), clamp(base[1], 0, 255), clamp(base[2], 0, 255)];
}

/** Read one palette entry — hex or prose — as a hex string. */
export function paletteColor(phrase: string): string {
  return toHex(resolveColor(phrase));
}

/** Resolve a whole style bible palette, always yielding at least two colours. */
export function stylePalette(style: StyleBible): RGB[] {
  const cols = style.palette.map(resolveColor);
  if (cols.length === 0) return [[36, 34, 48], [226, 198, 150]];
  if (cols.length === 1) return [mixRgb(cols[0], [0, 0, 0], 0.55), cols[0]];
  return cols;
}

// ── procedural composition ───────────────────────────────────────────────────

/** A seeded value-noise lattice; several of these stacked give painterly mottle. */
function noiseGrid(rnd: () => number, cells: number): Float64Array {
  const g = new Float64Array((cells + 1) * (cells + 1));
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return g;
}

function sampleNoise(g: Float64Array, cells: number, u: number, v: number): number {
  const fx = clamp(u, 0, 1) * cells;
  const fy = clamp(v, 0, 1) * cells;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  if (x0 > cells - 1) x0 = cells - 1;
  if (y0 > cells - 1) y0 = cells - 1;
  const tx = smoothstep(fx - x0);
  const ty = smoothstep(fy - y0);
  const row = y0 * (cells + 1) + x0;
  const next = (y0 + 1) * (cells + 1) + x0;
  const a = lerp(g[row], g[row + 1], tx);
  const b = lerp(g[next], g[next + 1], tx);
  return lerp(a, b, ty);
}

/** Sample a palette as a continuous ramp, 0 at the first colour. */
function rampAt(cols: RGB[], t: number): RGB {
  if (cols.length === 1) return [cols[0][0], cols[0][1], cols[0][2]];
  const s = clamp(t, 0, 1) * (cols.length - 1);
  const i = Math.min(cols.length - 2, Math.floor(s));
  return mixRgb(cols[i], cols[i + 1], smoothstep(s - i));
}

interface Ridge {
  x: number;
  w: number;
  h: number;
}

function ridgeHeight(ridges: Ridge[], u: number): number {
  let d = 0;
  for (const r of ridges) {
    const t = Math.abs(u - r.x) / r.w;
    if (t < 1) d += r.h * smoothstep(1 - t);
  }
  return d;
}

/**
 * Composition biases read out of the scene action. The action is prose meant for
 * an image model, but a handful of words reliably imply a shape, and honouring
 * them is what keeps procedural frames feeling authored rather than random.
 */
export interface Bias {
  exposure: number;
  glow: number;
  streaks: number;
  layers: number;
  tilt: number;
  horizon: number;
  reflect: boolean;
}

export function biasFromAction(action: string): Bias {
  const a = action.toLowerCase();
  const bias: Bias = { exposure: 1, glow: 1, streaks: 1, layers: 0, tilt: 1, horizon: 0, reflect: false };
  if (/\b(night|midnight|dark|shadow|silhouett)/.test(a)) {
    bias.exposure = 0.78;
    bias.glow = 0.72;
  }
  if (/\b(dawn|sunrise|sunset|dusk|golden|glow|firelight|neon)/.test(a)) bias.glow *= 1.18;
  if (/\b(close|closer|face|portrait|eyes|hands|breath)/.test(a)) {
    bias.horizon = 0.12;
    bias.layers = -1;
  }
  if (/\b(city|skyline|rooftop|street|window|town|bridge)/.test(a)) bias.layers = 1;
  if (/\b(water|sea|ocean|river|lake|rain|reflect)/.test(a)) bias.reflect = true;
  if (/\b(run|rush|race|speed|whip|spin|fall|dive)/.test(a)) {
    bias.tilt = 2.1;
    bias.streaks = 1.35;
  }
  return bias;
}

/** Paint one composition into a raw rgb24 buffer. All pixel maths lives here. */
export function paintComposition(w: number, h: number, cols: RGB[], seed: number, bias: Bias): Buffer {
  const rnd = mulberry32(seed);
  const asc = [...cols].sort((a, b) => lum(a) - lum(b));
  const desc = [...asc].reverse();
  const dark = asc[0];
  const glow = asc[asc.length - 1];
  let accent = asc[0];
  for (const c of asc) if (chroma(c) > chroma(accent)) accent = c;

  const horizon = clamp(0.5 + 0.14 * rnd() + bias.horizon, 0.32, 0.82);
  const tilt = (rnd() - 0.5) * 0.14 * bias.tilt;
  const sunX = 0.24 + 0.52 * rnd();
  const sunY = horizon - (0.04 + 0.1 * rnd());
  const sunR = 0.05 + 0.045 * rnd();

  const makeRidge = (count: number, maxH: number): Ridge[] => {
    const out: Ridge[] = [];
    for (let i = 0; i < count; i++) {
      out.push({ x: -0.1 + 1.2 * rnd(), w: 0.1 + 0.24 * rnd(), h: 0.006 + maxH * rnd() });
    }
    return out;
  };
  const skyline = makeRidge(3 + Math.floor(rnd() * 4), 0.03);

  // Receding masses below the horizon: the cheapest honest way to read as depth.
  const layerCount = clamp(2 + Math.floor(rnd() * 2) + bias.layers, 1, 4);
  const layers: { top: number; ridge: Ridge[]; c: RGB }[] = [];
  for (let i = 0; i < layerCount; i++) {
    layers.push({
      top: 0.045 + 0.085 * i + 0.03 * rnd(),
      ridge: makeRidge(2 + Math.floor(rnd() * 3), 0.022 + 0.012 * i),
      c: mixRgb(mixRgb(dark, accent, 0.26 - 0.05 * i), [0, 0, 0], 0.06 + 0.13 * i),
    });
  }

  const blobs: { x: number; y: number; rx: number; ry: number; k: number; c: RGB }[] = [];
  for (let i = 0, n = 3 + Math.floor(rnd() * 3); i < n; i++) {
    blobs.push({
      x: 0.06 + 0.88 * rnd(),
      y: 0.04 + Math.max(0.02, horizon - 0.1) * rnd(),
      rx: 0.16 + 0.34 * rnd(),
      ry: 0.07 + 0.18 * rnd(),
      k: 0.13 + 0.2 * rnd(),
      c: [accent, glow, desc[Math.min(1, desc.length - 1)]][Math.floor(rnd() * 3)],
    });
  }
  // Cloud bands are what stop the sky reading as a linear gradient, so there are
  // deliberately many of them, at low opacity, shaped by the noise field.
  const streaks: { x: number; y: number; rx: number; ry: number; k: number; c: RGB }[] = [];
  for (let i = 0, n = 6 + Math.floor(rnd() * 5); i < n; i++) {
    streaks.push({
      x: 0.08 + 0.84 * rnd(),
      y: 0.05 + Math.max(0.02, horizon - 0.08) * rnd(),
      rx: 0.2 + 0.4 * rnd(),
      ry: 0.014 + 0.038 * rnd(),
      k: (0.24 + 0.36 * rnd()) * bias.streaks,
      c: rnd() < 0.55 ? glow : accent,
    });
  }

  const gWarp = noiseGrid(rnd, 4);
  const gCoarse = noiseGrid(rnd, 5);
  const gMid = noiseGrid(rnd, 11);
  const gFine = noiseGrid(rnd, 23);
  const gRidge = noiseGrid(rnd, 7);
  const gGround = noiseGrid(rnd, 13);

  const haze = mixRgb(mixRgb(dark, accent, 0.34), glow, 0.16);
  const floorColour = mixRgb(dark, [0, 0, 0], 0.26);
  const sunColour: RGB = [
    clamp(glow[0] * 1.12 + 42, 0, 255),
    clamp(glow[1] * 1.08 + 36, 0, 255),
    clamp(glow[2] * 1.04 + 28, 0, 255),
  ];
  const buf = Buffer.alloc(w * h * 3);
  const aspect = w / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      // A slight roll on the composition axis; the horizon itself is irregular.
      const gv = v + tilt * (u - 0.5);
      const hh = horizon - ridgeHeight(skyline, u) - 0.005 * (sampleNoise(gRidge, 7, u, 0.5) - 0.5);
      const fb = 0.55 * sampleNoise(gMid, 11, u, v) + 0.45 * sampleNoise(gFine, 23, u * 1.7, v * 1.7);

      // Warping the ramp coordinate with low-frequency noise is what separates a
      // painted sky from a linear gradient: the colour boundaries stop being level.
      const skyT =
        ((hh - gv) / Math.max(0.001, hh)) * 1.16 + 0.12 * (sampleNoise(gWarp, 4, u * 0.9, v * 0.6) - 0.5);
      let sky = rampAt(desc, smoothstep(clamp(skyT, 0, 1)));
      for (const s of streaks) {
        const dx = (u - s.x) / s.rx;
        const dy = (gv - s.y) / s.ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) {
          // Fade cloud bands out of the zenith, where they would read as scratches.
          const height = smoothstep((gv - 0.04) / 0.16);
          sky = mixRgb(sky, s.c, smoothstep(1 - d) * s.k * (0.3 + 0.95 * fb) * height);
        }
      }
      const dh = Math.abs(gv - hh) / 0.05;
      const rim = (1 / (1 + dh * dh * 3)) * 0.34 * bias.glow;
      sky = [
        sky[0] + (255 - sky[0]) * rim * (glow[0] / 255),
        sky[1] + (255 - sky[1]) * rim * (glow[1] / 255),
        sky[2] + (255 - sky[2]) * rim * (glow[2] / 255),
      ];
      const sdx = (u - sunX) * aspect;
      const sdy = v - sunY;
      const sd = Math.sqrt(sdx * sdx + sdy * sdy);
      const sun = clamp(smoothstep(1 - sd / sunR) * 0.95 + smoothstep(1 - sd / (sunR * 3.6)) * 0.42, 0, 1);
      sky = mixRgb(sky, sunColour, sun * 0.92 * bias.glow);
      for (const b of blobs) {
        const dx = (u - b.x) / b.rx;
        const dy = (v - b.y) / b.ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) {
          const f = smoothstep(1 - d);
          sky = mixRgb(sky, b.c, f * f * b.k * (0.5 + 0.8 * fb));
        }
      }

      let ground = mixRgb(haze, floorColour, smoothstep(clamp(((gv - hh) / Math.max(0.001, 1 - hh)) * 1.25, 0, 1)));
      ground = mixRgb(ground, accent, 0.1 * sampleNoise(gGround, 13, u, v));
      if (bias.reflect) {
        // Water: fold the sky glow back under the horizon in soft bands.
        const mirror = rampAt(desc, smoothstep(clamp(((gv - hh) / Math.max(0.001, 1 - hh)) * 1.5, 0, 1)));
        const band = 0.5 + 0.5 * sampleNoise(gMid, 11, u * 0.6, hh - (gv - hh));
        ground = mixRgb(ground, mirror, 0.3 * band);
      }

      let col = mixRgb(sky, ground, smoothstep(clamp((gv - hh) / 0.012 + 0.5, 0, 1)));
      for (let li = 0; li < layers.length; li++) {
        const ly = layers[li];
        const lt = hh + ly.top + ridgeHeight(ly.ridge, u);
        const wgt = smoothstep(clamp((gv - lt) / 0.01 + 0.5, 0, 1));
        if (wgt > 0) {
          col = mixRgb(col, mixRgb(ly.c, accent, 0.06 * sampleNoise(gGround, 13, u * 1.3, v * 1.3)), wgt);
          // A catchlight along each ridge separates the masses, but only where the
          // light actually falls: strongest near the sun, fading with distance and
          // broken up by the noise field so it never reads as a contour line.
          const rimT = (gv - lt) / 0.006;
          if (rimT > -1 && rimT < 4) {
            const facing = 0.25 + 0.75 * smoothstep(1 - Math.abs(u - sunX) / 0.55);
            const broken = 0.35 + 0.9 * sampleNoise(gMid, 11, u * 1.4, lt);
            const gain = 0.13 * (1 - 0.22 * li) * facing * broken * bias.glow;
            col = mixRgb(col, glow, gain / (1 + rimT * rimT));
          }
        }
      }

      const mottle =
        (sampleNoise(gCoarse, 5, u, v) - 0.5) * 7 +
        (sampleNoise(gMid, 11, u, v) - 0.5) * 4.5 +
        (sampleNoise(gFine, 23, u, v) - 0.5) * 3;
      const i3 = (y * w + x) * 3;
      buf[i3] = clamp(Math.round((col[0] + mottle * 1.05) * bias.exposure), 0, 255);
      buf[i3 + 1] = clamp(Math.round((col[1] + mottle) * bias.exposure), 0, 255);
      buf[i3 + 2] = clamp(Math.round((col[2] + mottle * 0.88) * bias.exposure), 0, 255);
    }
  }
  return buf;
}

/** Soft central mask that decides which pixels belong to the near layer. */
export function parallaxMask(w: number, h: number, seed: number): Buffer {
  const rnd = mulberry32(seed);
  const cx = (0.5 + (rnd() - 0.5) * 0.06) * w;
  const cy = (0.42 + (rnd() - 0.5) * 0.08) * h;
  const rx = 0.44 * w;
  const ry = 0.34 * h;
  const buf = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      buf[y * w + x] = Math.round(255 * smoothstep(1 - (d - 0.55) / 0.8));
    }
  }
  return buf;
}
