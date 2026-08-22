/**
 * Director service: turns uploads plus a one-sentence brief into a validated
 * DirectorSpec, and applies bounded patches to an existing one.
 *
 * Two implementations sit behind one interface. The Gemini path writes the plan
 * with structured output; the local path derives it deterministically from the
 * template's beat sheet. The local path is not a stub — it produces a complete,
 * renderable film — which is why the pipeline can run with no credentials at all.
 */
import { LIMITS, OUTPUT, profileFor, videoDurationFor, type Profile } from "@/lib/core/config";
import { clamp, round, truncate } from "@/lib/core/util";
import { logger } from "@/lib/core/logger";
import {
  DIRECTOR_RESPONSE_SCHEMA,
  normalize,
  parseSpec,
  sceneDuration,
  SHOT_SIZES,
  shotSize,
  type DirectorSpec,
  type Scene,
  type ScenePurpose,
  type TimelineEvent,
} from "@/lib/spec/directorSpec";
import { generateJson } from "@/lib/models/adapters";
import { jsonCodec, route, type RouteResult } from "@/lib/models/router";
import { getBundle, type TemplateBundle } from "@/lib/templates/bundles";
import { bundleVersionString } from "@/lib/templates/types";
import { directorPrompt } from "@/lib/templates/prompts";
import { clipDurationFor } from "@/lib/compose/plan";

export interface SubjectFact {
  role: string;
  description: string;
  /** How many people the photograph this came from contains. */
  peopleVisible?: number;
}

export interface DirectInput {
  projectId: string;
  bundleId: string;
  brief: string;
  mode: "generated" | "uploaded";
  durationS?: number;
  subjects: SubjectFact[];
  /** Present in uploaded-music mode: what analysis measured in the user's track. */
  music?: { bpm: number; durationS: number; sections: { t: number; kind: string }[] };
  profile?: Profile;
  deadlineAt?: number;
}

// ── local director ───────────────────────────────────────────────────────────

/**
 * Build a spec from the bundle's beat sheet. Every field the schema requires is
 * filled from the template plus light derivation off the brief, so the result is
 * a real plan rather than a placeholder.
 */
export function localDirect(input: DirectInput): DirectorSpec {
  const bundle = getBundle(input.bundleId);
  const durationS = round(input.durationS ?? OUTPUT.durationS, 3);
  const scale = durationS / 30;

  const primary = input.subjects.find((s) => s.role === "subject_primary");
  const secondary = input.subjects.find((s) => s.role === "subject_secondary");
  const subjectPhrase = primary
    ? truncate(primary.description, 140)
    : "the subject from the reference photograph";

  const briefWords = input.brief.trim();
  const title = deriveTitle(briefWords, bundle);

  const scenes: Scene[] = bundle.beats.map((beat, i) => {
    const start = round(beat.atS * scale, 3);
    const end = round(beat.endS * scale, 3);
    const isHero = beat.purpose === "hero_drop";
    const useSecondary = beat.purpose === "variation" && Boolean(secondary);
    return {
      id: `s${String(i + 1).padStart(2, "0")}`,
      start_s: start,
      end_s: end,
      purpose: beat.purpose,
      render_mode: beat.renderMode,
      reference_asset_ids: [],
      camera: beat.camera,
      camera_note: beat.intent,
      action: composeAction(beat.intent, subjectPhrase, briefWords, useSecondary, secondary),
      setting: composeSetting(beat.intent, briefWords, bundle),
      transition_in: i === 0 ? "cut" : beat.transitionIn,
      retry_budget: isHero ? LIMITS.semanticRetries.hero : LIMITS.semanticRetries.default,
      ...(beat.purpose === "resolution" ? { title } : {}),
    };
  });

  const events = deriveEvents(scenes, durationS);

  const spec: DirectorSpec = {
    spec_version: "1.0",
    title,
    logline: briefWords
      ? truncate(`${briefWords.replace(/\.$/, "")}, told in ${scenes.length} beats.`, 280)
      : `${bundle.label}: a ${Math.round(durationS)} second reel in ${scenes.length} beats.`,
    duration_s: durationS,
    aspect_ratio: "9:16",
    style_bible: { ...bundle.styleBible, preset: bundle.id },
    music: {
      mode: input.mode,
      bpm_target: input.music?.bpm ?? bundle.music.bpm,
      mood: bundle.music.mood,
      instrumentation: [...bundle.music.instrumentation],
      key: bundle.music.key,
    },
    events,
    scenes,
  };

  return normalize(spec);
}

function deriveTitle(brief: string, bundle: TemplateBundle): string {
  const stop = new Set([
    "a", "an", "the", "of", "and", "with", "in", "on", "at", "to", "for", "my", "our", "we",
    "me", "i", "is", "are", "was", "were", "that", "this", "into", "from", "make", "makes",
    "turn", "turns", "video", "reel", "about",
  ]);
  const words = brief
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  if (words.length === 0) return bundle.label;
  const picked = words.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1));
  return picked.join(" ");
}

function composeAction(
  intent: string,
  subject: string,
  brief: string,
  useSecondary: boolean,
  secondary?: SubjectFact,
): string {
  const who = useSecondary && secondary
    ? `${subject} beside ${truncate(secondary.description, 90)}`
    : subject;
  const motif = brief ? ` Carry the feeling of "${truncate(brief, 90)}".` : "";
  return truncate(`${intent} featuring ${who}.${motif}`, 400);
}

function composeSetting(intent: string, brief: string, bundle: TemplateBundle): string {
  const hint = brief ? truncate(brief, 90) : bundle.music.mood;
  return truncate(`${bundle.styleBible.medium}; ${intent.toLowerCase()}; ${hint}`, 300);
}

/**
 * Derive the event timeline from scene boundaries. Each scene start becomes a
 * beat, the hero scene start becomes the drop, and the reel always ends on a
 * final hit — which is what lets the composer and the score agree on structure.
 */
function deriveEvents(scenes: Scene[], durationS: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const hero = scenes.find((s) => s.purpose === "hero_drop");

  events.push({ t: 0, kind: "intro", visual: "quiet opening frame", intensity: 0.18 });

  for (const s of scenes) {
    if (s.start_s === 0) continue;
    if (hero && s.id === hero.id) {
      events.push({
        t: s.start_s,
        kind: "drop",
        visual: "hero transformation lands on the strongest beat",
        intensity: 1,
      });
      continue;
    }
    const kind =
      s.purpose === "build"
        ? "build"
        : s.purpose === "variation"
          ? "variation"
          : s.purpose === "resolution"
            ? "resolve"
            : "accent";
    const intensity =
      kind === "build" ? 0.72 : kind === "resolve" ? 0.35 : kind === "variation" ? 0.8 : 0.5;
    events.push({
      t: s.start_s,
      kind,
      visual: truncate(s.camera_note || s.action, 90),
      intensity,
    });
  }

  events.push({
    t: round(Math.max(0, durationS - 1), 3),
    kind: "final_hit",
    visual: "title card lands with the last hit",
    intensity: 0.95,
  });

  return events
    .sort((a, b) => a.t - b.t)
    .filter((e, i, arr) => i === 0 || arr[i - 1].t !== e.t || arr[i - 1].kind !== e.kind);
}

// ── routed director ──────────────────────────────────────────────────────────

export interface DirectOutcome {
  spec: DirectorSpec;
  route: string;
  usd: number;
  cached: boolean;
  fallbackReason?: string;
  /** Structural problems that were repaired automatically. */
  repairedIssues: string[];
}

/**
 * Produce a DirectorSpec. The Gemini path is given one repair attempt: if its
 * first response fails validation, the errors are handed back with the original
 * request. If it still fails, the local director answers, so this function cannot
 * fail to return a renderable plan.
 */
export async function direct(input: DirectInput): Promise<DirectOutcome> {
  const bundle = getBundle(input.bundleId);
  const durationS = input.durationS ?? OUTPUT.durationS;
  const log = logger({ project_id: input.projectId, template: bundle.id });
  const repaired: string[] = [];

  const { system, user } = directorPrompt({
    bundle,
    brief: input.brief,
    mode: input.mode,
    durationS,
    subjects: input.subjects,
    music: input.music,
  });

  const result: RouteResult<DirectorSpec> = await route<DirectorSpec>({
    task: "director",
    projectId: input.projectId,
    identity: { system, user, schemaVersion: bundleVersionString(bundle), durationS },
    cacheVersion: bundleVersionString(bundle),
    hint: { inputTokens: 2600, outputTokens: 3200, thoughtTokens: 900 },
    codec: jsonCodec<DirectorSpec>(),
    profile: input.profile,
    deadlineAt: input.deadlineAt,
    logger: log,
    real: async (model) => {
      const first = await generateJson<unknown>({
        model,
        system,
        parts: [{ text: user }],
        schema: DIRECTOR_RESPONSE_SCHEMA,
        thinking: "high",
        maxOutputTokens: 8192,
        temperature: 0.85,
        timeoutMs: LIMITS.timeoutMs.director,
      });

      let parsed = parseSpec(first.value);
      for (const issue of parsed.issues) repaired.push(`${issue.path}: ${issue.message}`);

      if (!parsed.ok) {
        // One targeted repair pass. Handing the model its own output plus the
        // precise violations is far more reliable than regenerating blind.
        const complaints = parsed.issues
          .filter((i) => i.severity === "hard")
          .map((i) => `- ${i.path}: ${i.message}`)
          .join("\n");
        log.warn("director spec failed validation, requesting repair", { complaints });
        const second = await generateJson<unknown>({
          model,
          system,
          parts: [
            { text: user },
            {
              text:
                `Your previous response was rejected by the schema validator.\n` +
                `Fix exactly these problems and return the corrected object:\n${complaints}\n\n` +
                `Previous response:\n${JSON.stringify(first.value).slice(0, 6000)}`,
            },
          ],
          schema: DIRECTOR_RESPONSE_SCHEMA,
          thinking: "high",
          maxOutputTokens: 8192,
          temperature: 0.4,
          timeoutMs: LIMITS.timeoutMs.director,
        });
        parsed = parseSpec(second.value);
        const usage = {
          inputTokens: (first.usage.inputTokens ?? 0) + (second.usage.inputTokens ?? 0),
          outputTokens: (first.usage.outputTokens ?? 0) + (second.usage.outputTokens ?? 0),
          thoughtTokens: (first.usage.thoughtTokens ?? 0) + (second.usage.thoughtTokens ?? 0),
        };
        if (!parsed.ok || !parsed.spec) {
          throw new Error(
            `director spec still invalid after repair: ${parsed.issues.map((i) => i.message).join("; ")}`,
          );
        }
        return {
          value: alignToRequest(parsed.spec, bundle, durationS, input.subjects),
          usage,
          modelVersion: second.modelVersion,
        };
      }

      if (!parsed.spec) throw new Error("director returned no spec");
      return {
        value: alignToRequest(parsed.spec, bundle, durationS, input.subjects),
        usage: first.usage,
        modelVersion: first.modelVersion,
      };
    },
    local: async () => localDirect(input),
  });

  // Align on the way out, not on the way in.
  //
  // This used to run inside the model call, so its guarantees — the requested duration, the
  // preset's transitions, a scene showing the group — were baked into whatever got stored
  // and a cached spec skipped them entirely. A run that hit the cache therefore silently
  // ignored every alignment rule added since that entry was written, which is a fix that
  // does not run: the group-scene enforcement was added, the next run cached, and the film
  // came back with no family in it again.
  //
  // Aligning here means the cached path and the fresh path get identical treatment, and it
  // stays cheap because alignment is pure and local.
  const spec = alignToRequest(result.value, bundle, durationS, input.subjects);

  return {
    spec,
    route: result.route,
    usd: result.usd,
    cached: result.cached,
    fallbackReason: result.fallbackReason,
    repairedIssues: repaired,
  };
}

/**
 * Keep a model-authored spec inside the bounds the rest of the system assumes:
 * the requested duration, the chosen preset, and a render mode set the current
 * profile can actually deliver.
 */
export function alignToRequest(
  spec: DirectorSpec,
  bundle: TemplateBundle,
  durationS: number,
  subjects: SubjectFact[] = [],
): DirectorSpec {
  const out: DirectorSpec = structuredClone(spec);
  out.style_bible.preset = bundle.id;

  // Trust the template's palette and negative rules over the model's, since they
  // are what the reference renders were tuned against.
  if (out.style_bible.palette.length < 2) out.style_bible.palette = [...bundle.styleBible.palette];
  const negatives = new Set([...bundle.styleBible.negative_rules, ...out.style_bible.negative_rules]);
  out.style_bible.negative_rules = [...negatives].slice(0, 14);

  // Rescale the timeline if the model drifted from the requested length.
  if (Math.abs(out.duration_s - durationS) > 0.5 && out.duration_s > 0) {
    const k = durationS / out.duration_s;
    for (const s of out.scenes) {
      s.start_s = round(s.start_s * k, 3);
      s.end_s = round(s.end_s * k, 3);
    }
    for (const e of out.events) e.t = round(e.t * k, 3);
    out.duration_s = round(durationS, 3);
  }

  // Only transitions this preset approves may survive.
  const approved = new Set(bundle.transitions);
  for (const s of out.scenes) {
    if (!approved.has(s.transition_in)) s.transition_in = bundle.transitions[0] ?? "cut";
  }

  for (const e of out.events) e.intensity = clamp(e.intensity, 0, 1);

  // If the photographs show more than one person, one scene has to show them together.
  //
  // This was asked for in the hard rules and simply not done: a film made from a family
  // trip came back as seven solo shots. A rule competing with fifteen others for a model's
  // attention is a hope, not a guarantee, so it is enforced here the same way scene
  // coverage is — by moving one field rather than by asking again.
  //
  // The variation scene is the one to use: it exists to show the same world differently,
  // and it is never the recognition shot that establishes identity or the payoff.
  if (subjects.some((s) => s.role === "subject_secondary")) {
    const shows = (sc: Scene) => sc.reference_asset_ids.includes("subject_secondary");
    const include = (sc: Scene | undefined): void => {
      if (!sc || shows(sc)) return;
      sc.reference_asset_ids = [...sc.reference_asset_ids, "subject_secondary"];
    };

    // Two scenes, not one, and the payoff is one of them.
    //
    // With a single group scene the other people leaked into the wide shots anyway — the
    // model reads an action about a shared afternoon and puts figures in frame whether or
    // not it was given faces to use, and figures it was not given faces for are strangers.
    // Declaring the group where the film is plainly about the group means those scenes get
    // the photograph instead of inventing from a sentence.
    //
    // The payoff earns it on its own merits too: a film built from photographs of several
    // people that resolves on one of them alone has thrown away its own ending.
    const preferred = ["hero_drop", "payoff", "variation", "world_opens"] as const;
    for (const purpose of preferred) {
      if (out.scenes.filter(shows).length >= 2) break;
      include(out.scenes.find((sc) => sc.purpose === purpose));
    }
    // Still short — a preset whose purposes are all something else. Take the widest shots,
    // where several people fit without the frame becoming a crowd.
    for (const sc of [...out.scenes].sort((a, b) => (b.end_s - b.start_s) - (a.end_s - a.start_s))) {
      if (out.scenes.filter(shows).length >= 2) break;
      include(sc);
    }

    // A shot size has to be able to hold the people in it.
    //
    // Shot size and cast size were decided independently, so a scene planned as a close-up
    // and then given three people cropped two of them at the frame edges — the faces were
    // right and half of each was outside the picture. SHOT_SIZES runs widest to tightest, so
    // the constraint is a floor on the index: three or more people need `full` or wider, two
    // need `medium` or wider. A scene already wide enough is left exactly as planned.
    const cast = subjects.find((s) => s.role === "subject_secondary")?.peopleVisible ?? 2;
    const loosest = cast >= 3 ? "full" : "medium";
    const limit = SHOT_SIZES.indexOf(loosest);
    for (const sc of out.scenes) {
      if (!shows(sc)) continue;
      const at = SHOT_SIZES.indexOf(shotSize(sc));
      if (at > limit) sc.shot_size = loosest;
    }
  }

  return normalize(out);
}

/** Number of scenes that will call a video model under the given profile. */
/**
 * What movement is worth, by what the shot is for.
 *
 * The payoff first, then the shots where something is physically happening, then the
 * ones that establish. Recognition and resolution come last on purpose: the opening is
 * carried by the photograph turning into the film, and an ending reads as an ending
 * because it settles. Deliberate stillness is not a saving, it is what makes the moving
 * shots feel expensive.
 */
const ANIMATION_VALUE: Record<ScenePurpose, number> = {
  hero_drop: 1,
  motion_begins: 0.9,
  world_opens: 0.85,
  build: 0.8,
  variation: 0.75,
  recognition: 0.5,
  resolution: 0.3,
};

/**
 * Which shots get real generated motion, and how many seconds each one may spend.
 *
 * The Director chooses `render_mode` without knowing what the run can afford, so it
 * settles for deterministic modes and a reel comes back as stills with camera moves over
 * them however much video budget was available. Whether a shot is animated is a routing
 * decision, like which model answers, and belongs on the server against the remaining
 * ceiling rather than in the plan.
 *
 * The allocation is computed once, before any worker starts, and each worker is handed
 * its own reservation. It used to be a per-scene check against a counter of seconds
 * already spent, which is not an allowance at all when scenes render concurrently: every
 * worker reads the same stale figure and they collectively overshoot. Worse, a retry read
 * the counter after its own first attempt had been paid for, found nothing left, and
 * quietly returned a still — which is how a generated hero shot came back as a zoom.
 * A reservation belongs to the scene, so a retry spends the same allowance again.
 *
 * Ordered by what the audience gets back: the hero first, then the longest shots, since a
 * six second shot carries three times the screen time of a two second one.
 */
export function planAnimation(spec: DirectorSpec, profileName?: string): Map<string, number> {
  const profile = profileFor(profileName as never);
  const plan = new Map<string, number>();
  if (profile.routes.video.kind !== "gemini" || profile.maxGeneratedVideoScenes === 0) return plan;

  const byValue = [...spec.scenes]
    // An insert is a held object. Animating one spends the allowance on the shot least
    // able to use it, and then the critic marks it down for moving.
    .filter((sc) => shotSize(sc) !== "detail")
    .sort((a, b) => {
      const byWeight = ANIMATION_VALUE[b.purpose] - ANIMATION_VALUE[a.purpose];
      // Length only breaks ties. It was the main ordering, which funded whichever shot
      // happened to be longest rather than whichever one movement would do the most for.
      return byWeight !== 0 ? byWeight : sceneDuration(b) - sceneDuration(a);
    });

  let secondsLeft = profile.videoSecondsBudget;
  for (const scene of byValue) {
    if (plan.size >= profile.maxGeneratedVideoScenes) break;
    const seconds = videoDurationFor(clipDurationFor(spec, scene));
    if (seconds > secondsLeft) continue;
    plan.set(scene.id, seconds);
    secondsLeft -= seconds;
  }
  return plan;
}
export function generativeSceneBudget(spec: DirectorSpec, profileName?: string): number {
  const profile = profileFor(profileName as never);
  if (profile.maxGeneratedVideoScenes === 0) return 0;
  return Math.min(profile.maxGeneratedVideoScenes, spec.scenes.length);
}
