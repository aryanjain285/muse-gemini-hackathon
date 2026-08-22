/**
 * The director agent's tools. Everything the agent can see or do passes through
 * here, which keeps its capabilities auditable and its blast radius bounded.
 *
 * Tools delegate to the same services the deterministic pipeline uses. There is no
 * separate agent code path for generation, so anything the agent produces is
 * exactly what the pipeline would produce — the agent only decides what to do and
 * in what order.
 */
import { z } from "zod";
import { profileFor, type Profile } from "@/lib/core/config";
import { round, truncate } from "@/lib/core/util";
import { Assets, Ledger, Projects, Qc, Renders, Specs } from "@/lib/db/repo";
import { budget } from "@/lib/models/governor";
import { sceneDuration, type DirectorSpec } from "@/lib/spec/directorSpec";
import { PatchRequestSchema } from "@/lib/spec/patch";
import { listBundles } from "@/lib/templates/bundles";
import { checkReel } from "@/lib/compose/ffmpeg";
import { clipDurationFor } from "@/lib/compose/plan";
import { urlFor } from "@/lib/services/assets";
import { direct } from "@/lib/services/director";
import { readUploads, preflightVerdict } from "@/lib/services/vision";
import { assetBytes } from "@/lib/services/assets";
import { produceMusic } from "@/lib/services/music";
import { commitDirection, runRecompose, runSceneRevision } from "@/lib/services/pipeline";
import { ToolRegistry, type ToolContext } from "./registry";
import { getSkill, skillIndex, skillNames } from "./skills";

function profileOf(projectId: string): Profile {
  return profileFor(Projects.require(projectId).profile as never);
}

/** Compact view of a spec, small enough to hand a model every turn. */
function timelineView(spec: DirectorSpec, version: number) {
  return {
    version,
    title: spec.title,
    logline: spec.logline,
    duration_s: spec.duration_s,
    preset: spec.style_bible.preset,
    palette: spec.style_bible.palette,
    music: {
      mode: spec.music.mode,
      bpm: spec.music.bpm_target,
      key: spec.music.key,
      mood: spec.music.mood,
    },
    events: spec.events.map((e) => ({ t: e.t, kind: e.kind, intensity: e.intensity })),
    scenes: spec.scenes.map((s) => ({
      id: s.id,
      start_s: s.start_s,
      end_s: s.end_s,
      purpose: s.purpose,
      render_mode: s.render_mode,
      camera: s.camera,
      transition_in: s.transition_in,
      action: truncate(s.action, 160),
    })),
  };
}

export function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // ── read ───────────────────────────────────────────────────────────────────

  registry.add({
    name: "get_project",
    description:
      "Read the project: mode, chosen preset, the user's brief, how many photographs were " +
      "uploaded, current status, whether a plan exists, and the remaining budget. Call this first.",
    parameters: { type: "OBJECT", properties: {} },
    input: z.object({}).passthrough(),
    effect: "read",
    summarize: (o) => {
      const r = o as { status: string; uploads: number; hasPlan: boolean };
      return `${r.status}, ${r.uploads} upload(s), plan ${r.hasPlan ? "exists" : "not yet written"}`;
    },
    run: async (ctx) => {
      const p = Projects.require(ctx.projectId);
      const active = Specs.active(ctx.projectId);
      const b = budget();
      return {
        projectId: p.id,
        mode: p.mode,
        preset: p.preset,
        profile: p.profile,
        brief: p.brief,
        status: p.status,
        uploads: Assets.byProject(ctx.projectId, "upload_image").length,
        hasUploadedAudio: Assets.byProject(ctx.projectId, "upload_audio").length > 0,
        hasPlan: Boolean(active),
        planVersion: active?.version ?? null,
        availablePresets: listBundles().map((b2) => ({ id: b2.id, label: b2.label, blurb: b2.blurb })),
        budget: {
          runRemainingUsd: round(ctx.remainingUsd, 4),
          projectSpentUsd: round(Ledger.projectUsd(ctx.projectId), 4),
          totalRemainingUsd: b.remainingUsd,
        },
        skills: skillNames(),
      };
    },
  });

  registry.add({
    name: "get_timeline",
    description:
      "Read the current plan: the event timeline and every scene with its window, purpose, " +
      "render mode, camera and transition. Use it before changing anything.",
    parameters: { type: "OBJECT", properties: {} },
    input: z.object({}).passthrough(),
    effect: "read",
    summarize: (o) => {
      const r = o as { scenes?: unknown[]; duration_s?: number } | { error: string };
      if ("error" in r) return r.error;
      return `${r.scenes?.length ?? 0} scenes over ${r.duration_s ?? 0}s`;
    },
    run: async (ctx) => {
      const active = Specs.active(ctx.projectId);
      if (!active) return { error: "no plan yet; call plan_film first" };
      return timelineView(active.spec, active.version);
    },
  });

  registry.add({
    name: "read_skill",
    description:
      `Read one of the craft guides. Available: ${skillIndex().replace(/\n/g, " ")}. ` +
      "Read the guide that matches the decision you are about to make.",
    parameters: {
      type: "OBJECT",
      required: ["name"],
      properties: { name: { type: "STRING", enum: skillNames() } },
    },
    input: z.object({ name: z.string() }),
    effect: "read",
    summarize: (o) => {
      const r = o as { name?: string; body?: string; error?: string };
      return r.error ?? `read ${r.name} (${r.body?.length ?? 0} chars)`;
    },
    run: async (_ctx, input) => {
      const skill = getSkill(input.name);
      if (!skill) return { error: `no skill '${input.name}'. Available: ${skillNames().join(", ")}` };
      return { name: skill.name, version: skill.version, body: skill.body };
    },
  });

  registry.add({
    name: "inspect_scene",
    description:
      "Inspect one scene: whether a keyframe and clip exist, which route produced them, and " +
      "the critic's most recent scores and repair instruction.",
    parameters: {
      type: "OBJECT",
      required: ["scene_id"],
      properties: { scene_id: { type: "STRING", description: "e.g. s04" } },
    },
    input: z.object({ scene_id: z.string() }),
    effect: "read",
    summarize: (o) => {
      const r = o as { scene_id?: string; decision?: string | null; hasClip?: boolean; error?: string };
      return r.error ?? `${r.scene_id}: clip ${r.hasClip ? "present" : "missing"}, critic ${r.decision ?? "not run"}`;
    },
    run: async (ctx, input) => {
      const active = Specs.active(ctx.projectId);
      if (!active) return { error: "no plan yet" };
      const scene = active.spec.scenes.find((s) => s.id === input.scene_id);
      if (!scene) {
        return {
          error: `no scene '${input.scene_id}'. Scenes: ${active.spec.scenes.map((s) => s.id).join(", ")}`,
        };
      }
      const keyframe = Assets.byRole(ctx.projectId, scene.id, "keyframe");
      const clip = Assets.byRole(ctx.projectId, scene.id, "scene_video");
      const qc = Qc.latestForScene(ctx.projectId, scene.id);
      const clipMeta = clip ? Assets.meta<{ route?: string; generated?: boolean; durationS?: number }>(clip) : {};
      return {
        scene_id: scene.id,
        purpose: scene.purpose,
        window: [scene.start_s, scene.end_s],
        expectedClipDurationS: clipDurationFor(active.spec, scene),
        hasKeyframe: Boolean(keyframe),
        hasClip: Boolean(clip),
        clipRoute: clipMeta.route ?? null,
        clipGenerated: Boolean(clipMeta.generated),
        clipDurationS: clipMeta.durationS ?? null,
        decision: qc?.decision ?? null,
        scores: qc ? (JSON.parse(qc.scores_json) as Record<string, number>) : null,
        repairInstruction: qc?.repair_instruction ?? null,
      };
    },
  });

  registry.add({
    name: "inspect_reel",
    description:
      "Probe the most recent exported reel: duration, dimensions, whether it has audio, and any " +
      "black runs or silence detected. Use this to verify your work before finishing.",
    parameters: { type: "OBJECT", properties: {} },
    input: z.object({}).passthrough(),
    effect: "read",
    summarize: (o) => {
      const r = o as { ok?: boolean; durationS?: number; issues?: string[]; error?: string };
      if (r.error) return r.error;
      return r.ok
        ? `reel is clean: ${r.durationS?.toFixed(2)}s`
        : `reel has ${r.issues?.length ?? 0} issue(s): ${(r.issues ?? []).slice(0, 2).join("; ")}`;
    },
    run: async (ctx) => {
      const reel = Assets.byRole(ctx.projectId, "final", "reel");
      if (!reel) return { error: "no reel has been exported yet; call compose_reel first" };
      const active = Specs.active(ctx.projectId);
      const check = await checkReel(reel.uri, {
        durationS: active?.spec.duration_s ?? 30,
        width: 1080,
        height: 1920,
      });
      return { ...check, url: urlFor(reel) };
    },
  });

  // ── plan ───────────────────────────────────────────────────────────────────

  registry.add({
    name: "plan_film",
    description:
      "Write the plan: read the uploaded photographs, then produce the complete timeline and " +
      "scene breakdown. Call this once, before any rendering. Optionally override the preset.",
    parameters: {
      type: "OBJECT",
      properties: {
        preset: {
          type: "STRING",
          description: "Optional preset id to use instead of the one the user chose.",
        },
        note: {
          type: "STRING",
          description: "Optional extra direction to fold into the brief.",
        },
      },
    },
    input: z.object({ preset: z.string().optional(), note: z.string().max(400).optional() }),
    effect: "spend",
    summarize: (o) => {
      const r = o as { scenes?: number; title?: string; route?: string };
      return `planned "${r.title}" in ${r.scenes} scenes via ${r.route}`;
    },
    run: async (ctx, input) => {
      const project = Projects.require(ctx.projectId);
      const profile = profileOf(ctx.projectId);
      const uploads = Assets.byProject(ctx.projectId, "upload_image");

      const vision = await readUploads({
        projectId: ctx.projectId,
        profile,
        deadlineAt: ctx.job.deadlineAt,
        uploads: uploads.map((u) => ({ path: u.uri, mime: u.mime, bytes: assetBytes(u) })),
      });
      ctx.charge(vision.usd);

      const verdict = preflightVerdict(vision, uploads.length);

      const brief = input.note ? `${project.brief} ${input.note}`.trim() : project.brief;
      const outcome = await direct({
        projectId: ctx.projectId,
        bundleId: input.preset ?? project.preset,
        brief,
        mode: project.mode,
        subjects: vision.subjects.map((s) => ({ role: s.role, description: s.description })),
        profile,
        deadlineAt: ctx.job.deadlineAt,
      });
      ctx.charge(outcome.usd);

      const pushed = Specs.push({
        projectId: ctx.projectId,
        spec: outcome.spec,
        origin: outcome.route === "local" ? "local" : "director",
        note: `agent plan_film via ${outcome.route}`,
      });
      Projects.patch(ctx.projectId, {
        title: outcome.spec.title,
        ...(input.preset ? { preset: input.preset } : {}),
      });
      ctx.job.emit({
        kind: "spec",
        version: pushed.version,
        title: outcome.spec.title,
        scenes: outcome.spec.scenes.length,
        durationS: outcome.spec.duration_s,
      });

      return {
        version: pushed.version,
        title: outcome.spec.title,
        scenes: outcome.spec.scenes.length,
        route: outcome.route,
        usd: outcome.usd,
        preflightWarnings: verdict.warnings,
        timeline: timelineView(outcome.spec, pushed.version),
      };
    },
  });

  registry.add({
    name: "patch_plan",
    description:
      "Change the plan with a bounded set of operations. Every operation names what it affects, " +
      "and the result tells you which scenes will need re-rendering. Cannot rewrite the whole plan.",
    parameters: {
      type: "OBJECT",
      required: ["summary", "ops"],
      properties: {
        summary: { type: "STRING", description: "One short sentence naming the change." },
        ops: {
          type: "ARRAY",
          description:
            "Operations. Each needs an 'op' field: scene_action, scene_setting, scene_shot_size, " +
            "scene_camera, scene_transition, scene_render_mode, scene_title, style_palette, " +
            "style_lighting, style_medium, style_grain, add_motif, event_intensity, music_energy, " +
            "attach_secondary.",
          items: { type: "OBJECT", properties: { op: { type: "STRING" } } },
        },
      },
    },
    input: PatchRequestSchema,
    effect: "write",
    summarize: (o) => {
      const r = o as { accepted?: boolean; impact?: string; rejected?: string[] };
      return r.accepted ? `patched: ${r.impact}` : `refused: ${(r.rejected ?? []).join("; ")}`;
    },
    run: async (ctx, input) => {
      const result = commitDirection({ projectId: ctx.projectId, request: input });
      return result;
    },
  });

  // ── produce ────────────────────────────────────────────────────────────────

  registry.add({
    name: "render_scene",
    description:
      "Render one scene end to end: keyframe, motion, and quality control, with the scene's retry " +
      "budget. Returns the critic's verdict. Render scenes one at a time so you can react to each.",
    parameters: {
      type: "OBJECT",
      required: ["scene_id"],
      properties: { scene_id: { type: "STRING" } },
    },
    input: z.object({ scene_id: z.string() }),
    effect: "spend",
    summarize: (o) => {
      const r = o as { scene_id?: string; decision?: string; route?: string; error?: string };
      return r.error ?? `${r.scene_id}: ${r.decision} via ${r.route}`;
    },
    run: async (ctx, input) => {
      const before = Ledger.projectUsd(ctx.projectId);
      // Scene revision already performs keyframe, motion, quality control and a
      // recompose; reusing it keeps agent-driven and pipeline-driven renders
      // byte-identical rather than subtly different.
      const active = Specs.active(ctx.projectId);
      if (!active) return { error: "no plan yet; call plan_film first" };
      const scene = active.spec.scenes.find((s) => s.id === input.scene_id);
      if (!scene) {
        return {
          error: `no scene '${input.scene_id}'. Scenes: ${active.spec.scenes.map((s) => s.id).join(", ")}`,
        };
      }

      await runSceneRevision(ctx.job, { sceneId: scene.id });
      const spent = round(Ledger.projectUsd(ctx.projectId) - before, 6);
      ctx.charge(spent);

      const qc = Qc.latestForScene(ctx.projectId, scene.id);
      const clip = Assets.byRole(ctx.projectId, scene.id, "scene_video");
      const meta = clip ? Assets.meta<{ route?: string }>(clip) : {};
      return {
        scene_id: scene.id,
        decision: qc?.decision ?? "unknown",
        scores: qc ? (JSON.parse(qc.scores_json) as Record<string, number>) : null,
        repairInstruction: qc?.repair_instruction ?? null,
        route: meta.route ?? "unknown",
        usd: spent,
      };
    },
  });

  registry.add({
    name: "make_score",
    description:
      "Produce the soundtrack and reconcile it against the plan. Returns the measured tempo, how " +
      "many planned beats were matched to real accents, and which were not found.",
    parameters: { type: "OBJECT", properties: {} },
    input: z.object({}).passthrough(),
    effect: "spend",
    summarize: (o) => {
      const r = o as { bpm?: number; snapped?: number; unmatched?: string[]; route?: string; error?: string };
      return (
        r.error ??
        `score via ${r.route}: ${r.bpm} BPM, ${r.snapped} beat(s) matched` +
          (r.unmatched?.length ? `, missing ${r.unmatched.join("/")}` : "")
      );
    },
    run: async (ctx) => {
      const active = Specs.active(ctx.projectId);
      if (!active) return { error: "no plan yet; call plan_film first" };
      const outcome = await produceMusic({
        projectId: ctx.projectId,
        spec: active.spec,
        specVersion: active.version,
        profile: profileOf(ctx.projectId),
        uploadedAudio: Assets.byProject(ctx.projectId, "upload_audio")[0] ?? null,
        deadlineAt: ctx.job.deadlineAt,
        log: ctx.log,
      });
      ctx.charge(outcome.usd);
      ctx.job.emit({
        kind: "music",
        state: outcome.fromFallback ? "fallback" : "done",
        assetUrl: urlFor(outcome.asset),
        route: outcome.route,
        bpm: outcome.actual.bpm,
        anchors: outcome.reconciliation.snappedEvents.map((e) => e.t),
      });
      return {
        route: outcome.route,
        bpm: outcome.actual.bpm,
        durationS: outcome.actual.durationS,
        anchors: outcome.actual.anchors.length,
        snapped: outcome.reconciliation.snappedEvents.filter((e) => e.snapped).length,
        unmatched: outcome.reconciliation.unmatched,
        maxDeltaS: outcome.reconciliation.maxDeltaS,
        usd: outcome.usd,
      };
    },
  });

  registry.add({
    name: "compose_reel",
    description:
      "Assemble everything into the final vertical MP4: cuts placed on measured musical accents, " +
      "transitions, colour grade, grain and titles. Costs nothing. Call it after the scenes exist.",
    parameters: { type: "OBJECT", properties: {} },
    input: z.object({}).passthrough(),
    effect: "write",
    summarize: (o) => {
      const r = o as { durationS?: number; checkOk?: boolean; error?: string };
      return r.error ?? `composed ${r.durationS?.toFixed(2)}s reel, checks ${r.checkOk ? "passed" : "flagged issues"}`;
    },
    run: async (ctx) => {
      const active = Specs.active(ctx.projectId);
      if (!active) return { error: "no plan yet" };
      const clips = active.spec.scenes.filter((s) =>
        Boolean(Assets.byRole(ctx.projectId, s.id, "scene_video")),
      );
      if (clips.length === 0) {
        return { error: "no scenes have been rendered yet; call render_scene first" };
      }
      const result = await runRecompose(ctx.job);
      return {
        outputUrl: result.outputUrl,
        durationS: result.durationS,
        scenes: result.scenes,
        checkOk: result.checkOk,
        renderedScenes: clips.length,
        totalScenes: active.spec.scenes.length,
      };
    },
  });

  registry.add({
    name: "finish",
    description:
      "End the run. Give a short, plain summary of what you made and anything the user should know. " +
      "Call this once the reel exists and you have verified it.",
    parameters: {
      type: "OBJECT",
      required: ["summary"],
      properties: {
        summary: { type: "STRING", description: "Two or three sentences, plain language." },
        outstanding: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "Anything left imperfect, honestly stated.",
        },
      },
    },
    input: z.object({
      summary: z.string().min(1).max(1200),
      outstanding: z.array(z.string().max(300)).max(6).optional(),
    }),
    effect: "write",
    summarize: (o) => truncate((o as { summary: string }).summary, 160),
    run: async (_ctx, input) => ({
      summary: input.summary,
      outstanding: input.outstanding ?? [],
      done: true,
    }),
  });

  return registry;
}

/** The order the deterministic policy walks, and the order the model is nudged toward. */
export const CANONICAL_ORDER = [
  "get_project",
  "plan_film",
  "make_score",
  "render_scene",
  "compose_reel",
  "inspect_reel",
  "finish",
] as const;

export { Renders };
