/**
 * The gain envelope that gives a flat score an arc.
 *
 * This existed for two runs without ever executing: Lyria happened to deliver dynamics both
 * times it mattered, so the compensation correctly did nothing and stayed unproven. A safety
 * net nobody has seen fire is not known to work, and this one is the answer to the loudest
 * complaint the product had — a reel whose cuts land on the beat and still feels slow.
 *
 * So it is exercised against real audio through real ffmpeg: a tone at a constant level in,
 * and the measured level of the opening compared with the measured level of the payoff.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audioArc, bedTrimDb } from "@/lib/compose/plan";
import { normalize, type DirectorSpec } from "@/lib/spec/directorSpec";

let dir = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-arc-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Mean level of one window of a file, in dB, as ffmpeg measures it. */
function meanDb(file: string, fromS: number, toS: number): number {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-i", file,
      "-af", `atrim=start=${fromS}:end=${toS},volumedetect`,
      "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null",
    ],
    { encoding: "utf8" },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  expect(m, `no level measured in ${file}:\n${r.stderr}`).not.toBeNull();
  return Number(m?.[1]);
}

/** The filter the composer builds, kept in step with ffmpeg.ts by construction. */
function arcFilter(arc: { quietGain: number; liftFromS: number; liftToS: number }): string {
  const span = Math.max(0.25, arc.liftToS - arc.liftFromS);
  return `volume=eval=frame:volume='${arc.quietGain}+${1 - arc.quietGain}*clip((t-${arc.liftFromS})/${span},0,1)'`;
}

describe("the audio arc, through real ffmpeg", () => {
  it("lifts a constant-level tone into its payoff", () => {
    const arc = { quietGain: 0.55, liftFromS: 11, liftToS: 15 };
    const out = path.join(dir, "arced.wav");
    // A 30s tone at one unchanging level: exactly the score that prompted this.
    const r = spawnSync(
      "ffmpeg",
      [
        "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=220:duration=30:sample_rate=44100",
        "-af", arcFilter(arc),
        out,
      ],
      { encoding: "utf8" },
    );
    expect(r.status, `ffmpeg rejected the arc filter:\n${r.stderr}`).toBe(0);

    const opening = meanDb(out, 0, 5);
    const payoff = meanDb(out, 16, 21);
    // 0.55 to 1.0 is about 5.2 dB. Anything close to zero would mean the expression
    // parsed but never varied, which is how a per-frame filter fails silently.
    expect(payoff - opening).toBeGreaterThan(4);
    expect(payoff - opening).toBeLessThan(7);
  });

  it("leaves the payoff at full level, not merely louder than the start", () => {
    const arc = { quietGain: 0.55, liftFromS: 11, liftToS: 15 };
    const plain = path.join(dir, "plain.wav");
    const arced = path.join(dir, "arced2.wav");
    for (const [file, af] of [
      [plain, "anull"],
      [arced, arcFilter(arc)],
    ] as const) {
      const r = spawnSync(
        "ffmpeg",
        [
          "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", "sine=frequency=220:duration=30:sample_rate=44100",
          "-af", af, file,
        ],
        { encoding: "utf8" },
      );
      expect(r.status, r.stderr).toBe(0);
    }
    // After the lift completes the arc must be transparent: quieting the payoff to make
    // the opening look quiet would be a worse fault than no arc at all.
    expect(Math.abs(meanDb(arced, 20, 25) - meanDb(plain, 20, 25))).toBeLessThan(0.4);
  });

  it("is only asked for when the score has no arc of its own", () => {
    const flat = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.5, v: 0.5 }));
    const rising = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.5, v: i * 0.5 < 11 ? 0.25 : 0.85 }));
    expect(audioArc(spec(), flat)).not.toBeNull();
    expect(audioArc(spec(), rising)).toBeNull();
  });
});

function spec(): DirectorSpec {
  return normalize({
    spec_version: "1.0",
    title: "Arc",
    logline: "A reel for testing the arc.",
    duration_s: 30,
    aspect_ratio: "9:16",
    style_bible: {
      preset: "dreamy_animated_memories",
      palette: ["warm", "cool"],
      character_rules: ["one protagonist"],
      negative_rules: ["no text"],
      lighting: "golden",
      medium: "gouache",
      grain: 0.3,
    },
    music: { mode: "generated", bpm_target: 118, mood: "nostalgic", instrumentation: [], key: "A minor" },
    events: [
      { t: 0, kind: "intro", visual: "open", intensity: 0.2 },
      { t: 11, kind: "build", visual: "rise", intensity: 0.7 },
      { t: 15, kind: "drop", visual: "hero", intensity: 1 },
      { t: 25, kind: "resolve", visual: "settle", intensity: 0.5 },
      { t: 29, kind: "final_hit", visual: "title", intensity: 0.9 },
    ],
    scenes: [
      { id: "s01", start_s: 0, end_s: 11, purpose: "recognition", render_mode: "stylized_keyframe", reference_asset_ids: [], camera: "push_in", camera_note: "", action: "a", setting: "b", transition_in: "cut", retry_budget: 1 },
      { id: "s02", start_s: 11, end_s: 15, purpose: "build", render_mode: "stylized_keyframe", reference_asset_ids: [], camera: "push_in", camera_note: "", action: "a", setting: "b", transition_in: "cut", retry_budget: 1 },
      { id: "s03", start_s: 15, end_s: 25, purpose: "hero_drop", render_mode: "stylized_keyframe", reference_asset_ids: [], camera: "pull_out", camera_note: "", action: "a", setting: "b", transition_in: "flash", retry_budget: 2 },
      { id: "s04", start_s: 25, end_s: 30, purpose: "resolution", render_mode: "stylized_keyframe", reference_asset_ids: [], camera: "dolly_out", camera_note: "", action: "a", setting: "b", transition_in: "crossfade", retry_budget: 1 },
    ],
  } as DirectorSpec);
}

describe("bedTrimDb", () => {
  it("pulls a clipped score down to headroom", () => {
    // What Lyria actually delivered: peak at full scale, 5,621 samples pinned there.
    expect(bedTrimDb(1.0)).toBeCloseTo(-1.5, 2);
  });

  it("leaves a score that already has headroom alone", () => {
    // -3 dBFS is quieter than the target, and pushing it up is the one failure a limiter
    // cannot undo.
    expect(bedTrimDb(0.7)).toBe(0);
    expect(bedTrimDb(0.5)).toBe(0);
  });

  it("treats an unknown or nonsense peak as nothing to do", () => {
    expect(bedTrimDb(undefined)).toBe(0);
    expect(bedTrimDb(0)).toBe(0);
    expect(bedTrimDb(Number.NaN)).toBe(0);
  });

  it("never amplifies, whatever the peak", () => {
    for (let p = 0.01; p <= 1; p += 0.01) expect(bedTrimDb(p)).toBeLessThanOrEqual(0);
  });
});
