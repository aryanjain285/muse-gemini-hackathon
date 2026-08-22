/**
 * Design-system contract tests.
 *
 * The Film Lab components are driven entirely by tokens declared in
 * globals.css, and Tailwind fails silently when a utility names a token that
 * does not exist: `bg-ink-975` simply emits nothing and the element renders
 * transparent. Nothing in a type check or a render test catches that, so these
 * tests read the stylesheet and the component sources as text and enforce the
 * invariants the design depends on.
 *
 * The run is deliberately node-only. It asserts on the source, not on rendered
 * output, which keeps it fast and keeps it honest about the failure mode it
 * exists to catch.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ── sources ──────────────────────────────────────────────────────────────────

const ROOT = process.cwd();

function read(rel: string): string {
  const abs = path.resolve(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`expected ${rel} to exist at ${abs}`);
  return fs.readFileSync(abs, "utf8");
}

const CSS_REL = "src/app/globals.css";
const CSS = read(CSS_REL);

const COMPONENT_RELS = [
  "src/components/ui/primitives.tsx",
  "src/components/ui/timeline.tsx",
  "src/components/ui/grain.tsx",
] as const;

const COMPONENTS: ReadonlyArray<{ rel: string; src: string }> = COMPONENT_RELS.map((rel) => ({
  rel,
  src: read(rel),
}));

// ── token parsing ────────────────────────────────────────────────────────────

/** Every custom property the stylesheet declares, including nested rules. */
function declaredProperties(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) out.add(m[1]);
  return out;
}

/**
 * Token names under one `@theme` namespace, e.g. `--color-ink-950` becomes
 * `ink-950`. Per-token modifiers such as `--text-micro--line-height` are not
 * tokens themselves and are dropped.
 */
function tokensIn(props: Set<string>, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const p of props) {
    if (!p.startsWith(`--${prefix}-`)) continue;
    const name = p.slice(prefix.length + 3);
    if (name.length === 0 || name.includes("--")) continue;
    out.add(name);
  }
  return out;
}

/** The first hyphen-separated segment of each token, used to gate utilities. */
function families(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    const head = t.split("-")[0];
    if (head) out.add(head);
  }
  return out;
}

const PROPS = declaredProperties(CSS);

const NS = {
  color: tokensIn(PROPS, "color"),
  font: tokensIn(PROPS, "font"),
  text: tokensIn(PROPS, "text"),
  radius: tokensIn(PROPS, "radius"),
  spacing: tokensIn(PROPS, "spacing"),
  container: tokensIn(PROPS, "container"),
  shadow: tokensIn(PROPS, "shadow"),
  tracking: tokensIn(PROPS, "tracking"),
  leading: tokensIn(PROPS, "leading"),
  ease: tokensIn(PROPS, "ease"),
  animate: tokensIn(PROPS, "animate"),
};

// ── class-token extraction ───────────────────────────────────────────────────

/** Variants that may prefix a utility; stripped before the token is checked. */
const VARIANT = /^(?:[a-z0-9-]+(?:-\[[^\]]*\])?:)+/;

/**
 * Candidate utility class names found in a component's string literals. All
 * className content in these files is written as plain quoted strings, so this
 * sees every class the components can emit.
 */
function classTokens(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
    const literal = m[1] ?? m[2] ?? "";
    if (literal.includes("<") || literal.includes("{")) continue;
    for (const raw of literal.split(/\s+/)) {
      if (raw.length === 0) continue;
      const noVariant = raw.replace(VARIANT, "");
      const token = noVariant.replace(/^-/, "").replace(/\/\d+$/, "");
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9.[\]%_-]+)+$/.test(token)) continue;
      if (token.includes("[")) continue; // arbitrary value, nothing to resolve
      out.add(token);
    }
  }
  return out;
}

interface Rule {
  prefixes: string[];
  tokens: Set<string>;
  /** Namespaces with no core-Tailwind equivalent are checked unconditionally. */
  strict: boolean;
  label: string;
}

const RULES: Rule[] = [
  {
    label: "--color-*",
    strict: false,
    tokens: NS.color,
    prefixes: [
      "bg", "text", "border", "border-t", "border-b", "border-l", "border-r",
      "border-x", "border-y", "ring", "outline", "fill", "stroke", "from", "via",
      "to", "shadow", "decoration", "divide", "accent", "caret", "placeholder",
    ],
  },
  { label: "--font-*", strict: false, tokens: NS.font, prefixes: ["font"] },
  { label: "--text-*", strict: false, tokens: NS.text, prefixes: ["text"] },
  { label: "--radius-*", strict: false, tokens: NS.radius, prefixes: ["rounded"] },
  { label: "--shadow-*", strict: false, tokens: NS.shadow, prefixes: ["shadow"] },
  { label: "--tracking-*", strict: false, tokens: NS.tracking, prefixes: ["tracking"] },
  { label: "--leading-*", strict: false, tokens: NS.leading, prefixes: ["leading"] },
  { label: "--container-*", strict: false, tokens: NS.container, prefixes: ["max-w", "w"] },
  {
    label: "--spacing-*",
    strict: false,
    tokens: NS.spacing,
    prefixes: [
      "p", "px", "py", "pt", "pr", "pb", "pl", "m", "mx", "my", "mt", "mr", "mb",
      "ml", "gap", "gap-x", "gap-y", "w", "h", "size", "min-w", "min-h", "max-w",
      "max-h", "top", "right", "bottom", "left", "inset", "inset-x", "inset-y",
      "space-x", "space-y",
    ],
  },
  // No core Tailwind curve or keyframe may be used: naming one is how a
  // component quietly ends up on a default easing.
  { label: "--ease-*", strict: true, tokens: NS.ease, prefixes: ["ease"] },
  { label: "--animate-*", strict: true, tokens: NS.animate, prefixes: ["animate"] },
];

/** Custom classes globals.css defines outside the theme namespaces. */
const LOCAL_CLASSES = new Set([
  "film-layer", "film-grain", "film-vignette", "film-scanline", "ambient-glow",
  "stagger", "shimmer", "scanning", "sprocket", "sprocket-edges", "tabular",
]);

const STRICT_EXEMPT = new Set(["animate-none", "ease-initial"]);

function undeclaredTokenUsages(src: string): string[] {
  const failures: string[] = [];
  for (const token of classTokens(src)) {
    if (LOCAL_CLASSES.has(token) || STRICT_EXEMPT.has(token)) continue;
    let familyMatched = false;
    let validated = false;
    for (const rule of RULES) {
      const prefix = rule.prefixes.find((p) => token.startsWith(`${p}-`));
      if (prefix === undefined) continue;
      const rest = token.slice(prefix.length + 1);
      const head = rest.split("-")[0] ?? "";
      const relevant = rule.strict || families(rule.tokens).has(head);
      if (!relevant) continue;
      familyMatched = true;
      if (rule.tokens.has(rest)) validated = true;
    }
    if (familyMatched && !validated) failures.push(token);
  }
  return failures.sort();
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("globals.css token declarations", () => {
  it("declares the full ink, paper, ember and signal ramps", () => {
    for (const family of ["ink", "paper", "ember", "signal"]) {
      const steps = [...NS.color].filter((t) => t.startsWith(`${family}-`));
      expect(steps.length, `expected several --color-${family}-* steps`).toBeGreaterThanOrEqual(6);
    }
    // The ground and the accent are named explicitly by the art direction.
    expect(CSS).toMatch(/--color-ink-950:\s*#08080a/i);
    expect(NS.color.has("ember-400")).toBe(true);
    for (const structural of ["hairline", "hairline-strong", "hairline-ember", "sprocket", "shimmer", "scanline"]) {
      expect(NS.color.has(structural), `missing --color-${structural}`).toBe(true);
    }
  });

  it("declares the three type roles, the easing set and the bezel radii", () => {
    for (const role of ["display", "sans", "mono"]) {
      expect(NS.font.has(role), `missing --font-${role}`).toBe(true);
    }
    for (const curve of ["entrance", "settle", "exit", "snap", "drift"]) {
      expect(NS.ease.has(curve), `missing --ease-${curve}`).toBe(true);
    }
    for (const r of ["shell", "core", "shell-sm", "core-sm", "shell-lg", "core-lg", "chip", "pill"]) {
      expect(NS.radius.has(r), `missing --radius-${r}`).toBe(true);
    }
  });

  it("keeps every custom easing on an explicit cubic-bezier", () => {
    const curves = [...CSS.matchAll(/--ease-([a-z-]+):\s*([^;]+);/g)];
    expect(curves.length).toBeGreaterThanOrEqual(5);
    for (const [, name, value] of curves) {
      expect(value.trim(), `--ease-${name} must be an explicit curve`).toMatch(/^cubic-bezier\(/);
    }
  });

  it("keeps the double bezel concentric: shell radius minus bezel equals core radius", () => {
    const px = (value: string): number =>
      value.trim().endsWith("rem") ? Number.parseFloat(value) * 16 : Number.parseFloat(value);
    const prop = (name: string): string => {
      const m = CSS.match(new RegExp(`${name}:\\s*([^;]+);`));
      if (!m) throw new Error(`missing ${name}`);
      return m[1];
    };
    const pairs: Array<[string, string, string]> = [
      ["--radius-shell-sm", "--spacing-bezel-sm", "--radius-core-sm"],
      ["--radius-shell", "--spacing-bezel", "--radius-core"],
      ["--radius-shell-lg", "--spacing-bezel-lg", "--radius-core-lg"],
    ];
    for (const [shell, bezel, core] of pairs) {
      expect(px(prop(shell)) - px(prop(bezel)), `${shell} - ${bezel} should equal ${core}`).toBeCloseTo(
        px(prop(core)),
        5,
      );
    }
  });

  it("draws the sprocket utility with repeating-linear-gradient", () => {
    const m = CSS.match(/@utility\s+sprocket\s*\{[\s\S]*?\n\}/);
    expect(m, "expected an @utility sprocket block").not.toBeNull();
    expect(m?.[0]).toContain("repeating-linear-gradient");
    expect(m?.[0]).toContain("var(--color-sprocket)");
  });

  it("fixes the film grain and vignette layers to the viewport without capturing pointers", () => {
    for (const pseudo of ["body::before", "body::after"]) {
      const m = CSS.match(new RegExp(`${pseudo}\\s*\\{[\\s\\S]*?\\n  \\}`));
      expect(m, `expected a ${pseudo} film layer`).not.toBeNull();
      expect(m?.[0]).toContain("position: fixed");
      expect(m?.[0]).toContain("pointer-events: none");
    }
    expect(CSS).toMatch(/feTurbulence/);
  });
});

describe("typography", () => {
  it("imports Instrument Serif, Geist and Geist Mono", () => {
    const imports = [...CSS.matchAll(/@import\s+url\("([^"]+)"\)/g)].map((m) => m[1]);
    const googleFonts = imports.filter((u) => u.startsWith("https://fonts.googleapis.com/"));
    expect(googleFonts.length).toBeGreaterThan(0);
    const joined = googleFonts.join(" ");
    for (const family of ["Instrument+Serif", "Geist", "Geist+Mono"]) {
      expect(joined, `expected ${family} in the font import`).toContain(family);
    }
  });

  it("never uses a default web font as the first entry of a stack", () => {
    const banned = ["inter", "roboto", "arial", "helvetica", "open sans"];
    const stacks = [...CSS.matchAll(/(--font-[a-z-]+|font-family):\s*([^;]+);/g)];
    expect(stacks.length).toBeGreaterThanOrEqual(3);
    for (const [, name, value] of stacks) {
      const first = (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (first.startsWith("var(")) continue; // an alias onto another declared stack
      expect(banned, `${name} leads with "${first}"`).not.toContain(first);
    }
  });

  it("gives every declared family a real fallback stack ending in a generic", () => {
    for (const role of ["display", "sans", "mono"]) {
      const m = CSS.match(new RegExp(`--font-${role}:\\s*([^;]+);`));
      expect(m, `missing --font-${role}`).not.toBeNull();
      const entries = (m?.[1] ?? "").split(",").map((e) => e.trim());
      expect(entries.length, `--font-${role} needs fallbacks`).toBeGreaterThanOrEqual(3);
      const last = (entries[entries.length - 1] ?? "").toLowerCase();
      expect(["serif", "sans-serif", "monospace", "system-ui"]).toContain(last);
    }
  });
});

describe("component token usage", () => {
  for (const { rel, src } of COMPONENTS) {
    it(`${rel} references only declared tokens`, () => {
      expect(undeclaredTokenUsages(src)).toEqual([]);
    });

    it(`${rel} resolves every var() it reads`, () => {
      const unresolved: string[] = [];
      for (const m of src.matchAll(/var\((--[A-Za-z0-9-]+)/g)) {
        if (!PROPS.has(m[1])) unresolved.push(m[1]);
      }
      expect([...new Set(unresolved)].sort()).toEqual([]);
    });

    it(`${rel} assigns only custom properties globals.css knows about`, () => {
      const unknown: string[] = [];
      for (const m of src.matchAll(/["'](--[A-Za-z0-9-]+)["']\s*:/g)) {
        if (!PROPS.has(m[1])) unknown.push(m[1]);
      }
      expect([...new Set(unknown)].sort()).toEqual([]);
    });
  }

  it("catches a token that does not exist", () => {
    // Guards the checker itself: a plausible typo must be reported.
    expect(undeclaredTokenUsages('const a = "bg-ink-975 text-paper-350 ease-out";')).toEqual([
      "bg-ink-975",
      "ease-out",
      "text-paper-350",
    ]);
  });
});

describe("motion", () => {
  /** Values of every timing-function slot the stylesheet declares. */
  function timingValues(css: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const m of css.matchAll(/(--animate-[a-z-]+|transition[a-z-]*|animation[a-z-]*)\s*:\s*([^;{}]+)[;}]/g)) {
      out.push([m[1], m[2]]);
    }
    return out;
  }

  const BANNED_CURVES = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]);

  it("never falls back to a default curve in globals.css", () => {
    const offenders: string[] = [];
    for (const [prop, value] of timingValues(CSS)) {
      for (const word of value.split(/[\s,]+/)) {
        if (BANNED_CURVES.has(word.trim())) offenders.push(`${prop}: ${value.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never names a default curve in a component", () => {
    for (const { rel, src } of COMPONENTS) {
      const offenders: string[] = [];
      for (const m of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
        const literal = m[1] ?? m[2] ?? "";
        for (const raw of literal.split(/\s+/)) {
          const token = raw.replace(VARIANT, "");
          if (BANNED_CURVES.has(token) || BANNED_CURVES.has(token.replace(/^ease-/, "ease-"))) {
            if (/^ease-/.test(token) || BANNED_CURVES.has(token)) offenders.push(`${rel}: ${raw}`);
          }
        }
        if (/\bease-in-out\b|\btransition:\s*[^;"']*\blinear\b/.test(literal)) {
          offenders.push(`${rel}: ${literal}`);
        }
      }
      expect(offenders, `${rel} must not use a default easing`).toEqual([]);
    }
  });

  it("declares the ambient, entrance, shimmer, sweep and pulse keyframes", () => {
    const declared = new Set([...CSS.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
    for (const required of ["drift", "fade-up", "shimmer", "sweep", "rec-pulse"]) {
      expect(declared.has(required), `missing @keyframes ${required}`).toBe(true);
    }
  });

  it("has no dead keyframes", () => {
    const declared = [...CSS.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const used = new Set<string>();

    // Referenced by an --animate-* token or a bare animation declaration.
    for (const m of CSS.matchAll(/--animate-[a-z-]+:\s*([A-Za-z0-9_-]+)/g)) used.add(m[1]);
    for (const m of CSS.matchAll(/animation(?:-name)?:\s*([A-Za-z0-9_-]+)/g)) used.add(m[1]);

    // Referenced by a component through the generated animate-* utility.
    const animateTokens = new Set<string>();
    for (const { src } of COMPONENTS) {
      for (const token of classTokens(src)) {
        if (token.startsWith("animate-")) animateTokens.add(token.slice("animate-".length));
      }
    }
    for (const name of animateTokens) {
      const m = CSS.match(new RegExp(`--animate-${name}:\\s*([A-Za-z0-9_-]+)`));
      if (m) used.add(m[1]);
    }

    expect(declared.filter((name) => !used.has(name))).toEqual([]);
  });

  it("stops the ambient and looping animations under reduced motion", () => {
    const block = CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\}/);
    expect(block, "expected a prefers-reduced-motion block").not.toBeNull();
    const body = block?.[0] ?? "";
    expect(body).toMatch(/animation:\s*none/);
    for (const looping of ["film-grain", "ambient-glow", "animate-drift", "animate-shimmer", "animate-sweep"]) {
      expect(body, `${looping} must be quieted under reduced motion`).toContain(looping);
    }
  });

  it("animates only compositor properties in its keyframes", () => {
    for (const m of CSS.matchAll(/@keyframes\s+[A-Za-z0-9_-]+\s*\{([\s\S]*?)\n\}/g)) {
      const props = [...m[1].matchAll(/\n\s{4}([a-z-]+):/g)].map((p) => p[1]);
      for (const prop of props) {
        expect(["transform", "opacity", "filter"]).toContain(prop);
      }
    }
  });
});

describe("component hygiene", () => {
  it("contains no emoji", () => {
    for (const { rel, src } of COMPONENTS) {
      const pictographic = src.match(/\p{Extended_Pictographic}/u);
      expect(pictographic, `${rel} contains an emoji: ${pictographic?.[0] ?? ""}`).toBeNull();
      // Anything outside the BMP arrives as a surrogate pair.
      const astral = src.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
      expect(astral, `${rel} contains an astral character`).toBeNull();
      expect(src.match(/[☀-➿️⬀-⯿]/)).toBeNull();
    }
  });

  it("stays presentational: no data fetching, routes or server-only imports", () => {
    for (const { rel, src } of COMPONENTS) {
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec.startsWith("node:"), `${rel} imports ${spec}`).toBe(false);
        expect(spec.startsWith("next/"), `${rel} imports ${spec}`).toBe(false);
        expect(spec.startsWith("@/lib/db"), `${rel} imports ${spec}`).toBe(false);
        expect(spec.startsWith("@/app"), `${rel} imports ${spec}`).toBe(false);
      }
      expect(src, `${rel} must not fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(src, `${rel} must be a client component`).toMatch(/^"use client";/);
    }
  });

  it("never calls Math.random", () => {
    for (const { rel, src } of COMPONENTS) {
      expect(src, `${rel} must stay deterministic`).not.toContain("Math.random");
    }
  });
});

describe("exports", () => {
  /** Named value exports of a module, in source order. */
  function exportedNames(src: string): Set<string> {
    const out = new Set<string>();
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) out.add(m[1]);
    for (const m of src.matchAll(/export\s+const\s+([A-Za-z0-9_]+)/g)) out.add(m[1]);
    return out;
  }

  it("primitives.tsx exports the whole component set", () => {
    const src = read("src/components/ui/primitives.tsx");
    const names = exportedNames(src);
    const required = [
      "Panel", "Button", "Eyebrow", "Display", "Meta", "Badge", "Progress",
      "Field", "Input", "Textarea", "Toggle", "Segmented", "Spinner", "Icon",
      "Tooltip", "Stat",
    ];
    for (const name of required) {
      expect(names.has(name), `primitives.tsx must export ${name}`).toBe(true);
    }
  });

  it("timeline.tsx and grain.tsx export their surfaces", () => {
    expect([...exportedNames(read("src/components/ui/timeline.tsx"))]).toEqual(
      expect.arrayContaining(["Timeline", "SceneStrip"]),
    );
    expect([...exportedNames(read("src/components/ui/grain.tsx"))]).toEqual(
      expect.arrayContaining(["GrainOverlay", "AmbientGlow"]),
    );
  });

  it("covers every documented icon name", () => {
    const src = read("src/components/ui/primitives.tsx");
    const union = src.match(/export type IconName =([\s\S]*?);/);
    expect(union).not.toBeNull();
    const declared = new Set([...(union?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
    const required = [
      "play", "pause", "upload", "sparkle", "wand", "film", "music", "check",
      "alert", "retry", "download", "chevron", "close", "mic", "scissors",
    ];
    for (const name of required) {
      expect(declared.has(name), `Icon must support "${name}"`).toBe(true);
      // A name in the union without geometry would render an empty <svg>.
      expect(src, `Icon "${name}" needs geometry`).toMatch(new RegExp(`\\n  ${name}: `));
    }
  });

  it("draws icons at one hairline stroke weight from currentColor", () => {
    const src = read("src/components/ui/primitives.tsx");
    expect(src).toContain('stroke="currentColor"');
    const weights = new Set([...src.matchAll(/strokeWidth=\{([\d.]+)\}/g)].map((m) => m[1]));
    for (const w of weights) {
      expect(Number(w), `stroke weight ${w} is not hairline`).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("accessibility", () => {
  /** Every `<button …>…</button>` region in a source file. */
  function buttonRegions(src: string): string[] {
    const regions: string[] = [];
    const opens = [...src.matchAll(/<button\b/g)];
    for (const open of opens) {
      const start = open.index ?? 0;
      const end = src.indexOf("</button>", start);
      regions.push(src.slice(start, end === -1 ? src.length : end));
    }
    return regions;
  }

  it("labels every icon-only control", () => {
    for (const rel of ["src/components/ui/primitives.tsx", "src/components/ui/timeline.tsx"]) {
      const src = read(rel);
      for (const region of buttonRegions(src)) {
        if (!region.includes("<Icon")) continue;
        const hasText = region.includes("{children}");
        if (hasText) continue;
        const labelled =
          region.includes("aria-label") ||
          region.includes("aria-labelledby") ||
          region.includes("{...rest}");
        expect(labelled, `${rel} has an icon-only button with no accessible name`).toBe(true);
      }
    }
  });

  it("marks decorative svg as hidden so a label is never read twice", () => {
    const src = read("src/components/ui/primitives.tsx");
    expect(src).toContain('aria-hidden="true"');
    expect(src).toContain('focusable="false"');
  });

  it("gives every stateful control the right role and state", () => {
    const src = read("src/components/ui/primitives.tsx");
    expect(src).toMatch(/role="switch"[\s\S]{0,120}aria-checked=/);
    expect(src).toMatch(/role="radiogroup"/);
    expect(src).toMatch(/role="radio"[\s\S]{0,80}aria-checked=/);
    expect(src).toMatch(/role="progressbar"/);
    expect(src).toMatch(/aria-valuemin=/);
    expect(src).toMatch(/role="tooltip"/);
    // A tooltip that is not wired as a description is decoration only.
    expect(src).toContain('"aria-describedby"');
  });

  it("makes the timeline a real slider that the keyboard can drive", () => {
    const src = read("src/components/ui/timeline.tsx");
    expect(src).toMatch(/role="slider"/);
    expect(src).toMatch(/tabIndex=\{0\}/);
    for (const attr of ["aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext", "aria-orientation"]) {
      expect(src, `slider needs ${attr}`).toContain(attr);
    }
    for (const key of ["ArrowRight", "ArrowLeft", "PageUp", "PageDown", "Home", "End"]) {
      expect(src, `slider must handle ${key}`).toContain(`"${key}"`);
    }
    expect(src, "scene blocks must report selection").toMatch(/aria-pressed=/);
  });

  it("keeps a visible focus ring on every interactive surface", () => {
    for (const rel of ["src/components/ui/primitives.tsx", "src/components/ui/timeline.tsx"]) {
      const src = read(rel);
      const rings = [...src.matchAll(/focus-visible:outline-2/g)].length;
      expect(rings, `${rel} needs visible focus rings`).toBeGreaterThanOrEqual(3);
    }
    expect(CSS).toMatch(/:focus-visible\s*\{[\s\S]*?outline:/);
  });

  it("pairs every status colour with a word", () => {
    const timeline = read("src/components/ui/timeline.tsx");
    for (const status of ["pending", "running", "done", "fallback", "failed"]) {
      expect(timeline, `timeline must handle the ${status} status`).toContain(`${status}:`);
    }
    // Each status row carries a human word, not just a colour class.
    for (const word of ["Queued", "Rendering", "Ready", "Local", "Failed"]) {
      expect(timeline, `status word ${word} missing`).toContain(`"${word}"`);
    }
  });
});
