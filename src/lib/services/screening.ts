/**
 * The screening room: the Director watches the film it planned.
 *
 * Every other review in MUSE looks at one shot on its own. Editing faults do not live
 * in one shot — a reel can be seven good shots and still drag, repeat itself, or pay
 * off in the wrong place. This pass takes the finished reel, sampled across its whole
 * length, together with what the plan asked for and what the music actually did, and
 * asks for notes on the edit rather than on the pictures.
 *
 * A note is only worth showing if something can be done about it, so every note must
 * name a change MUSE can already make: one of the offered re-cuts, or one reframe.
 * Anything outside that vocabulary is dropped rather than shown as advice nobody can
 * act on.
 */
import fs from "node:fs";
import path from "node:path";

import { LIMITS, type Profile } from "@/lib/core/config";
import { tmpDir } from "@/lib/core/paths";
import { round } from "@/lib/core/util";
import { logger, type Logger } from "@/lib/core/logger";
import { SHOT_SIZES, sceneDuration, shotSize, type DirectorSpec } from "@/lib/spec/directorSpec";
import { generateJson, inlinePart } from "@/lib/models/adapters";
import { jsonCodec, route } from "@/lib/models/router";
import { SCREENING_SCHEMA, screeningPrompt } from "@/lib/templates/prompts";
import { ffmpeg, probeMedia } from "@/lib/compose/ffmpeg";
import { OFFERED_STYLES, type EditStyleId } from "@/lib/compose/edit";
import { Audit } from "@/lib/db/repo";
import type { AssetRow } from "@/lib/db/types";

export const SCREENING_VERSION = "screening-1.0";

/** How many frames the model sees. Enough to read pacing, few enough to stay cheap. */
const SAMPLES = 14;

export interface ScreeningFix {
  /** `recut` re-reads the footage already paid for; `reframe` moves one shot's distance. */
  kind: "recut" | "reframe" | "none";
  edit?: EditStyleId;
  sceneId?: string;
  shotSize?: string;
  /** What pressing the button will do, in the product's own words. */
  label: string;
}

export interface ScreeningNote {
  /** pacing | coverage | continuity | payoff | sound */
  topic: string;
  note: string;
  /** Scene ids the note concerns, so the storyboard can highlight them. */
  sceneIds: string[];
  fix: ScreeningFix;
}

export interface ScreeningResult {
  version: string;
  route: string;
  /** One line on what the film is doing well; a screening that only complains is useless. */
  working: string;
  notes: ScreeningNote[];
  createdAt: string;
}

/** Sample frames evenly across the reel. */
async function sampleReel(
  reel: AssetRow,
  projectId: string,
): Promise<{ bytes: Buffer; mime: string }[]> {
  const info = await probeMedia(reel.uri).catch(() => null);
  const durationS = info?.durationS && info.durationS > 0 ? info.durationS : 30;
  const dir = tmpDir(projectId, "screening");
  const out: { bytes: Buffer; mime: string }[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    const at = round(((i + 0.5) / SAMPLES) * durationS, 3);
    const file = path.join(dir, `screen-f${i}.jpg`);
    try {
      await ffmpeg(
        [
          "-y",
          "-ss",
          String(at),
          "-i",
          reel.uri,
          "-frames:v",
          "1",
          "-vf",
          "scale=480:-2",
          "-q:v",
          "5",
          file,
        ],
        { timeoutMs: 45_000 },
      );
      if (fs.existsSync(file)) out.push({ bytes: fs.readFileSync(file), mime: "image/jpeg" });
    } catch {
      /* a missing sample means one fewer frame, not a failed screening */
    }
  }
  return out;
}

/**
 * The notes a measurement can prove on its own.
 *
 * Deliberately the dull ones — repetition, weight in the wrong place, cuts that were
 * placed rather than found — so a screening still happens with no key, no network and
 * no budget, like everything else here.
 */
export function localScreening(input: {
  spec: DirectorSpec;
  cutsS: number[];
  anchorsS: number[];
}): { working: string; notes: ScreeningNote[] } {
  const { spec, cutsS, anchorsS } = input;
  const notes: ScreeningNote[] = [];

  // Two shots running at one distance: the cut between them reads as a jump.
  const runs: { size: string; ids: string[] }[] = [];
  for (const scene of spec.scenes) {
    const size = shotSize(scene);
    const last = runs[runs.length - 1];
    if (last && last.size === size) last.ids.push(scene.id);
    else runs.push({ size, ids: [scene.id] });
  }
  const repeated = runs.find((r) => r.ids.length >= 2);
  if (repeated) {
    const target = repeated.ids[repeated.ids.length - 1];
    const away = repeated.size === "wide" || repeated.size === "full" ? "close" : "wide";
    notes.push({
      topic: "coverage",
      note: `${repeated.ids.join(" and ")} sit at the same distance, so the cut between them reads as a jump rather than a change of view.`,
      sceneIds: repeated.ids,
      fix: { kind: "reframe", sceneId: target, shotSize: away, label: `Reframe ${target} as a ${away}` },
    });
  }

  // The film should be longest where the music pays off.
  const hero = spec.scenes.find((s) => s.purpose === "hero_drop");
  const longest = spec.scenes.reduce((a, b) => (sceneDuration(b) > sceneDuration(a) ? b : a));
  if (hero && longest.id !== hero.id) {
    notes.push({
      topic: "payoff",
      note: `${longest.id} is the longest shot but ${hero.id} is where the music pays off, so the weight sits in the wrong place.`,
      sceneIds: [hero.id, longest.id],
      fix: { kind: "none", label: "" },
    });
  }

  // Cuts that never found an accent.
  if (cutsS.length > 0 && anchorsS.length > 0) {
    const worst = Math.max(...cutsS.map((t) => Math.min(...anchorsS.map((a) => Math.abs(a - t)))));
    if (worst > 0.05) {
      notes.push({
        topic: "sound",
        note: `The widest gap between a cut and the nearest accent is ${Math.round(worst * 1000)}ms, which is enough to feel late.`,
        sceneIds: [],
        fix: { kind: "recut", edit: "hard_cuts", label: "Re-cut on strong beats only" },
      });
    }
  }

  return {
    working: `${spec.scenes.length} shots over ${round(spec.duration_s, 1)}s, cut against a measured beat map.`,
    notes: notes.slice(0, 3),
  };
}

export async function screenReel(input: {
  projectId: string;
  spec: DirectorSpec;
  reel: AssetRow;
  cutsS: number[];
  anchorsS: number[];
  profile?: Profile;
  deadlineAt?: number;
  log?: Logger;
}): Promise<ScreeningResult> {
  const log = (input.log ?? logger({ project_id: input.projectId })).child({});
  const frames = await sampleReel(input.reel, input.projectId);
  const { system, user } = screeningPrompt({
    spec: input.spec,
    cutsS: input.cutsS,
    anchorsS: input.anchorsS,
    offered: OFFERED_STYLES.filter((s) => s !== "as_cut"),
  });

  type Raw = { working?: unknown; notes?: unknown };
  const result = await route<Raw>({
    task: "critic",
    projectId: input.projectId,
    // Keyed on the reel's own hash, so screening a re-cut is a fresh look while
    // screening the same file twice replays for nothing.
    identity: { screening: SCREENING_VERSION, reel: input.reel.sha256, frames: frames.length },
    hint: { inputTokens: 400 + frames.length * 780, outputTokens: 520, thoughtTokens: 320 },
    codec: jsonCodec<Raw>(),
    profile: input.profile,
    deadlineAt: input.deadlineAt,
    logger: log,
    real: async (model) => {
      const out = await generateJson<Raw>({
        model,
        system,
        parts: [...frames.map((f) => inlinePart(f.bytes, f.mime)), { text: user }],
        schema: SCREENING_SCHEMA,
        thinking: "low",
        maxOutputTokens: 1500,
        temperature: 0.3,
        timeoutMs: LIMITS.timeoutMs.critic,
      });
      return { value: out.value, usage: out.usage, modelVersion: out.modelVersion };
    },
    local: async () =>
      localScreening({ spec: input.spec, cutsS: input.cutsS, anchorsS: input.anchorsS }),
  });

  const screening: ScreeningResult = {
    version: SCREENING_VERSION,
    route: result.route,
    working: typeof result.value.working === "string" ? result.value.working.slice(0, 220) : "",
    notes: sanitise(result.value.notes, input.spec),
    createdAt: new Date().toISOString(),
  };

  Audit.record({
    projectId: input.projectId,
    actor: "critic",
    action: "screening",
    payload: screening,
  });
  return screening;
}

/**
 * Keep only notes whose fix MUSE can carry out.
 *
 * A change outside the vocabulary is not a note, it is a wish, and rendering it as a
 * button that cannot work is worse than leaving it out.
 */
function sanitise(raw: unknown, spec: DirectorSpec): ScreeningNote[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(spec.scenes.map((s) => s.id));
  const offered = OFFERED_STYLES.filter((s) => s !== "as_cut");
  const out: ScreeningNote[] = [];

  for (const entry of raw.slice(0, 4)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const note = typeof e.note === "string" ? e.note.trim() : "";
    if (!note) continue;

    const sceneIds = Array.isArray(e.sceneIds)
      ? e.sceneIds.filter((x): x is string => typeof x === "string" && ids.has(x)).slice(0, 3)
      : [];

    const rawFix = (
      typeof e.fix === "object" && e.fix !== null ? e.fix : {}
    ) as Record<string, unknown>;
    let fix: ScreeningFix = { kind: "none", label: "" };

    if (rawFix.kind === "recut") {
      const edit = offered.find((s) => s === rawFix.edit);
      if (edit) {
        fix = {
          kind: "recut",
          edit,
          label: edit === "hard_cuts" ? "Re-cut on strong beats only" : "Re-cut with long dissolves",
        };
      }
    } else if (rawFix.kind === "reframe") {
      const sceneId =
        typeof rawFix.sceneId === "string" && ids.has(rawFix.sceneId) ? rawFix.sceneId : sceneIds[0];
      const size = SHOT_SIZES.find((s) => s === rawFix.shotSize);
      if (sceneId && size) {
        fix = {
          kind: "reframe",
          sceneId,
          shotSize: size,
          label: `Reframe ${sceneId} as a ${size.replace(/_/g, " ")}`,
        };
      }
    }

    out.push({
      topic: typeof e.topic === "string" ? e.topic.slice(0, 24) : "note",
      note: note.slice(0, 260),
      sceneIds,
      fix,
    });
  }
  return out;
}

/** The most recent screening for a project, if one has been run. */
export function lastScreening(projectId: string): ScreeningResult | null {
  const rows = Audit.byProject(projectId).filter((r) => r.action === "screening");
  const last = rows[rows.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last.payload_json) as ScreeningResult;
  } catch {
    return null;
  }
}
