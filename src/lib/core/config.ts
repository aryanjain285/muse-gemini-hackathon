/**
 * Central configuration: model routes, prices, generation profiles, limits.
 *
 * Model names and availability belong in configuration, never in business
 * logic. Nothing outside this file may hardcode a model id, a price, or a
 * timeout.
 */

// ── task taxonomy ────────────────────────────────────────────────────────────

/** Every distinct capability MUSE routes to a model. */
export type Task =
  | "director" // narrative + DirectorSpec, structured output
  | "vision" // understand uploaded photos, extract identity/style facts
  | "keyframe" // storyboard still generation
  | "video" // short generated motion
  | "music" // soundtrack generation
  | "critic" // multimodal QC of a rendered asset
  | "patch"; // live direction utterance -> DirectorSpec patch

export const ALL_TASKS: Task[] = [
  "director",
  "vision",
  "keyframe",
  "video",
  "music",
  "critic",
  "patch",
];

/** How a task is fulfilled. `local` means the deterministic engine, zero cost. */
export type RouteTarget = { kind: "gemini"; model: string } | { kind: "local" };

// ── pricing ──────────────────────────────────────────────────────────────────

/**
 * Billing shapes, verified against ai.google.dev/gemini-api/docs/pricing
 * on 2026-08-18. Text/image prices are USD per 1M tokens; video is per second
 * of output; music is per clip.
 */
export type Price =
  | { unit: "tokens"; inputPerM: number; outputPerM: number }
  | {
      unit: "image";
      inputPerM: number;
      outputPerM: number;
      /** Output tokens billed per generated image at the configured resolution. */
      tokensPerImage: number;
    }
  | { unit: "second"; perSecond: number }
  | { unit: "clip"; perClip: number };

export const PRICES: Record<string, Price> = {
  // Text / reasoning. $0.75 in, $3.75 out per 1M through 2026-12-31.
  "gemini-3.6-flash": { unit: "tokens", inputPerM: 0.75, outputPerM: 3.75 },
  "gemini-3.7-flash": { unit: "tokens", inputPerM: 0.75, outputPerM: 3.75 },
  "gemini-3.5-flash": { unit: "tokens", inputPerM: 1.5, outputPerM: 9.0 },
  "gemini-3.1-flash-lite": { unit: "tokens", inputPerM: 0.3, outputPerM: 1.2 },

  // Image generation. Nano Banana 2 bills 0.5K images at ~$0.045.
  "gemini-3.1-flash-image": {
    unit: "image",
    inputPerM: 0.5,
    outputPerM: 60,
    tokensPerImage: 750, // 0.5K tier => 750 * $60/M = $0.045
  },
  "gemini-3-pro-image": {
    unit: "image",
    inputPerM: 2.0,
    outputPerM: 120,
    tokensPerImage: 1120, // 1K/2K tier => ~$0.134
  },
  "nano-banana-pro-preview": {
    unit: "image",
    inputPerM: 2.0,
    outputPerM: 120,
    tokensPerImage: 1120,
  },
  // The keyframe fallback. Cheaper than the flash image model it backs up:
  // $0.0336 per 1K image against $0.067.
  "gemini-3.1-flash-lite-image": {
    unit: "image",
    inputPerM: 0.25,
    outputPerM: 30,
    tokensPerImage: 1120,
  },

  // Video. Per second of generated output.
  "veo-3.1-lite-generate-preview": { unit: "second", perSecond: 0.05 }, // 720p
  "veo-3.1-fast-generate-preview": { unit: "second", perSecond: 0.12 }, // 1080p
  "veo-3.1-generate-preview": { unit: "second", perSecond: 0.4 }, // 720p/1080p
  // omni-flash bills video output per token; approximated per second of 9:16
  // output measured during the wiring probe and recorded in the ledger.
  "gemini-omni-flash-preview": { unit: "second", perSecond: 0.18 },

  // Music. Flat per clip.
  "lyria-3-clip-preview": { unit: "clip", perClip: 0.04 },
  "lyria-3-pro-preview": { unit: "clip", perClip: 0.08 },
};

// ── generation profiles ──────────────────────────────────────────────────────

/**
 * Image resolutions the API accepts. Verified against the live endpoint, which
 * rejects anything else with a 400 listing exactly these.
 */
/**
 * Durations a video model will accept, in seconds.
 *
 * Not a range. Asking for 5 returns `400: durationSeconds is out of bound. Please
 * provide a value between 4 and 8, inclusive`, which reads like a range and is not
 * one — the value has to be one of these. Clamping to [4,8] therefore passed a
 * plausible number that was still rejected, and every generated shot fell back to
 * the deterministic engine.
 */
export const VIDEO_DURATIONS = [4, 6, 8] as const;

/** Smallest accepted duration that covers `seconds`, or the longest on offer. */
export function videoDurationFor(seconds: number): number {
  if (!Number.isFinite(seconds)) return VIDEO_DURATIONS[0];
  return VIDEO_DURATIONS.find((d) => d >= seconds - 1e-6) ?? VIDEO_DURATIONS[VIDEO_DURATIONS.length - 1];
}

/**
 * A representative generated clip, for estimating before scene lengths are known.
 *
 * Estimates used `videoSecondsBudget` here, which is the total for a whole reel, so a
 * single call was priced as if it were the entire video allowance and a profile that
 * animates seven shots was quoted at seven times that. Reserving against an estimate
 * several times the true cost makes the governor refuse work it can afford.
 */
export function typicalVideoSeconds(): number {
  return videoDurationFor(OUTPUT.durationS / 6);
}

export const IMAGE_SIZES = ["512", "512P", "512PX", "1K", "2K", "4K"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export type ProfileName = "local" | "wiring" | "standard" | "hero" | "max";

export const PROFILE_NAMES: ProfileName[] = [
  "local",
  "wiring",
  "standard",
  "hero",
  "max",
];

export interface Profile {
  name: ProfileName;
  label: string;
  /** One line the UI shows under the profile name. */
  blurb: string;
  routes: Record<Task, RouteTarget>;
  /** Seconds of real generated video this profile permits per project. 0 disables. */
  videoSecondsBudget: number;
  /**
   * Resolution passed to the image model. Anything below 1K has to be upscaled to
   * fill a 1080x1920 frame, and the softness is visible in the finished reel. These are the API's accepted values, not
   * the labels the pricing table uses: the price list calls the cheapest tier
   * "0.5K" but the API rejects that string and wants "512".
   */
  imageSize: ImageSize;
  /** Cap on real generated-motion scenes. */
  maxGeneratedVideoScenes: number;
}

const LOCAL_ROUTES: Record<Task, RouteTarget> = {
  director: { kind: "local" },
  vision: { kind: "local" },
  keyframe: { kind: "local" },
  video: { kind: "local" },
  music: { kind: "local" },
  critic: { kind: "local" },
  patch: { kind: "local" },
};

const TEXT_MODEL = "gemini-3.6-flash";

export const PROFILES: Record<ProfileName, Profile> = {
  local: {
    name: "local",
    label: "Local Engine",
    blurb: "No network. Deterministic director, synthesised score, filter-based visuals.",
    routes: { ...LOCAL_ROUTES },
    videoSecondsBudget: 0,
    imageSize: "512",
    maxGeneratedVideoScenes: 0,
  },
  wiring: {
    name: "wiring",
    label: "Wiring Check",
    blurb: "Real Gemini director and critic. Media stays local. Pennies.",
    routes: {
      ...LOCAL_ROUTES,
      director: { kind: "gemini", model: TEXT_MODEL },
      vision: { kind: "gemini", model: TEXT_MODEL },
      critic: { kind: "gemini", model: TEXT_MODEL },
      patch: { kind: "gemini", model: TEXT_MODEL },
    },
    videoSecondsBudget: 0,
    imageSize: "512",
    maxGeneratedVideoScenes: 0,
  },
  standard: {
    name: "standard",
    label: "Standard",
    blurb: "Real keyframes and a real Lyria score. Motion stays deterministic.",
    routes: {
      director: { kind: "gemini", model: TEXT_MODEL },
      vision: { kind: "gemini", model: TEXT_MODEL },
      keyframe: { kind: "gemini", model: "gemini-3.1-flash-image" },
      video: { kind: "local" },
      music: { kind: "gemini", model: "lyria-3-clip-preview" },
      critic: { kind: "gemini", model: TEXT_MODEL },
      patch: { kind: "gemini", model: TEXT_MODEL },
    },
    videoSecondsBudget: 0,
    imageSize: "1K",
    maxGeneratedVideoScenes: 0,
  },
  hero: {
    name: "hero",
    label: "Hero Shot",
    blurb: "Everything real, and every shot actually animated.",
    routes: {
      director: { kind: "gemini", model: TEXT_MODEL },
      vision: { kind: "gemini", model: TEXT_MODEL },
      keyframe: { kind: "gemini", model: "gemini-3.1-flash-image" },
      video: { kind: "gemini", model: "veo-3.1-lite-generate-preview" },
      music: { kind: "gemini", model: "lyria-3-clip-preview" },
      critic: { kind: "gemini", model: TEXT_MODEL },
      patch: { kind: "gemini", model: TEXT_MODEL },
    },
    // Sized so the shots that carry movement get it: the hero, the widest travelling
    // shot, and the closes where hair and cloth move. Inserts and the short punch on
    // the build read correctly as held frames, so they stay deterministic.
    // Sized to what the ceiling actually leaves after the stills, the score and the
    // reviews are paid for. Allotting more than that does not buy more motion — it buys a
    // refused call partway through and a reel that is half animated.
    videoSecondsBudget: 34,
    imageSize: "1K",
    maxGeneratedVideoScenes: 7,
  },
  max: {
    name: "max",
    label: "Maximum",
    blurb: "Nano Banana Pro keyframes, Veo Fast 1080p hero. Highest spend.",
    routes: {
      director: { kind: "gemini", model: TEXT_MODEL },
      vision: { kind: "gemini", model: TEXT_MODEL },
      keyframe: { kind: "gemini", model: "gemini-3-pro-image" },
      video: { kind: "gemini", model: "veo-3.1-fast-generate-preview" },
      music: { kind: "gemini", model: "lyria-3-pro-preview" },
      critic: { kind: "gemini", model: TEXT_MODEL },
      patch: { kind: "gemini", model: TEXT_MODEL },
    },
    // Every shot animated, whatever it costs. That is what this profile is for.
    videoSecondsBudget: 48,
    imageSize: "1K",
    maxGeneratedVideoScenes: 9,
  },
};

// ── fallback chains ──────────────────────────────────────────────────────────

/**
 * When a route fails, try these in order, then fall to `local`. Every chain
 * terminates at the deterministic engine, so no external failure can prevent
 * an export.
 */
export const FALLBACKS: Record<Task, string[]> = {
  // Every entry is verified callable on a current key. A chain whose last resort
  // has been retired is worse than a shorter chain: a 503 on the preferred model
  // then walks all the way to a 404, which reads as a hard failure when the real
  // answer was "try again in a moment".
  director: ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
  vision: ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
  keyframe: ["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image"],
  // gemini-omni-flash-preview used to sit second here and answered every call with
  // "400: This model only supports Interactions API", so the chain had no working
  // fallback at all — a Veo failure went straight to the deterministic engine.
  video: ["veo-3.1-lite-generate-preview", "veo-3.1-fast-generate-preview"],
  music: ["lyria-3-clip-preview"],
  critic: ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
  patch: ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
};

// ── output format ────────────────────────────────────────────────────────────

export const OUTPUT = {
  width: 1080,
  height: 1920,
  fps: 30,
  /** Target reel length in seconds. */
  durationS: 30,
  videoCodec: "libx264",
  audioCodec: "aac",
  audioSampleRate: 44100,
  audioChannels: 2,
  crf: 19,
  preset: "medium",
  /** Vertical safe region for subject framing, as a fraction of height. */
  safeTop: 0.12,
  safeBottom: 0.14,
} as const;

// ── limits and deadlines ─────────────────────────────────────────────────────

function num(v: string | undefined, dflt: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}


export const LIMITS = {
  /**
   * Max uploaded reference images.
   *
   * Five was the number the reference renders were tuned against, and it became a rule: the
   * upload endpoint refused a sixth photograph and preflight blocked the run. Nothing downstream
   * actually needs the cap — the director picks what to shoot, the subject sheet ranks and takes
   * the best few, and vision reads them all — so the limit was rejecting work the pipeline could
   * do. Twelve is a bound rather than a rule: enough that nobody meets it by accident, low enough
   * that one request cannot ask for fifty vision reads.
   */
  maxUploads: 12,
  maxUploadBytes: 12 * 1024 * 1024,
  maxAudioBytes: 20 * 1024 * 1024,
  /** Accepted upload MIME types, checked against real file signatures. */
  imageMime: ["image/jpeg", "image/png", "image/webp", "image/heic"],
  audioMime: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/ogg"],

  /** Scene count band. */
  minScenes: 5,
  maxScenes: 7,

  /** Per-job wall clock ceilings, ms. No scene blocks a project indefinitely. */
  timeoutMs: {
    // The Director is a large structured-output call made with high thinking, and
    // measured at over 90s on Flash. A tighter ceiling here does not fail safely:
    // it burns the full timeout and then pays for a second model in the chain.
    director: 180_000,
    // Reading several photographs at once measured past 60s on a busy endpoint.
    vision: 120_000,
    /**
     * A 1K frame takes materially longer than a 512 one and was timing out at 120s,
     * which spent the full wait and then paid a second model in the chain. 240s fixed
     * that and introduced a different cost: measured across three runs a successful
     * frame returns in 39 to 120 seconds, while a stuck one burns the whole ceiling
     * twice before a retry lands — 537s, 354s and 570s on those runs, most of the wall
     * clock of a thirty second film.
     *
     * 180s sits above every success actually observed and well under the waste. It is a
     * genuine trade: a frame that would have returned at 200s is now killed and retried.
     * The alternative is hedging — fire a second request at ~140s and take whichever
     * lands — which never kills a slow success but bills for the loser, and the abandoned
     * request would not be recorded in the ledger, so the ceiling would quietly
     * under-report. A budget guard that lies is worse than a frame that occasionally
     * retries.
     */
    keyframe: 180_000,
    video: 420_000,
    music: 240_000,
    critic: 60_000,
    patch: 45_000,
    compose: 300_000,
  } satisfies Record<Task | "compose", number>,

  /** Concurrency caps so a burst cannot trip provider quota. */
  /**
   * How many scenes are produced at once.
   *
   * One number, because a scene is produced end to end by one worker: its still, then
   * its motion, then its review. There used to be four more here — video, music, critic,
   * total — and none of them was read anywhere. Dead limits are worse than no limits,
   * because they read as decisions: "video: 1" looks like a deliberate choice to
   * generate clips one at a time, and it was not enforcing anything.
   *
   * Measured on a seven-scene reel, a 1K still comes back in 40 to 120 seconds, so this
   * is what decides whether that is two waves or three.
   */
  concurrency: {
    scenes: 5,
    /**
     * Video calls in flight at once, across all scenes.
     *
     * This is not the same thing as scene concurrency and cannot be folded into it.
     * Raising scenes to five put five Veo requests in the air together and the provider
     * answered `429: you exceeded your current quota` on every one, so a run that got
     * faster produced a reel with no generated motion in it at all.
     *
     * A limit by this name existed before and nothing read it; deleting it as dead was
     * half right. The value was a correct decision, the enforcement was missing, and the
     * gap only showed once scenes ran wide enough to reach the quota.
     */
    video: 2,
  },

  /**
   * Minimum gap between the starts of two video generations, ms.
   *
   * Veo is limited per minute, not by how many calls are open at once. Capping concurrency
   * at two still issues requests as fast as they complete, and every one came back
   * `429: you exceeded your current quota`; the transport retries then paced the run by
   * accident, which worked but wasted a failed request before each success. Spacing the
   * starts is what actually respects the allowance.
   */
  videoStartIntervalMs: num(process.env.MUSE_VIDEO_INTERVAL_MS, 12_000),

  /** Semantic retries are budgeted separately from transport retries. */
  semanticRetries: { default: 1, hero: 2 },
  transportRetries: 2,

  /** Agent harness guardrails. */
  agent: { maxTurns: 14, maxToolCalls: 40, maxUsdPerRun: 1.5 },

  /**
   * Whole-project deadline. Past it, optional work is abandoned and the composer
   * runs with the best assets that already exist.
   *
   * This is a safety net for a live demo, not a normal operating limit. Set too
   * low it fires mid-run and silently disables whatever happens to be last, which
   * is how a paid score once got replaced by a synthesised one after the music
   * branch timed out.
   *
   * Measured: a full local render is under a minute; a standard-profile run with
   * seven real keyframes took 1048s. The ceiling is set well above the latter.
   */
  demoDeadlineMs: num(process.env.MUSE_DEADLINE_MS, 1_800_000),
} as const;

// ── environment ──────────────────────────────────────────────────────────────

export interface Env {
  apiKey: string | null;
  budgetUsd: number;
  profile: ProfileName;
  /**
   * True when MUSE_PROFILE was set explicitly. An operator override is honoured;
   * otherwise the server picks the richest profile the ceiling affords, because
   * how much of a reel is generated is not a question to put to someone who just
   * wants a film.
   */
  profileExplicit: boolean;
  cacheEnabled: boolean;
}

export function readEnv(): Env {
  const set = (process.env.MUSE_PROFILE ?? "").trim();
  const raw = set as ProfileName;
  const explicit = set.length > 0 && PROFILE_NAMES.includes(raw);
  const key = (process.env.GEMINI_API_KEY || "").trim();
  return {
    apiKey: key.length > 0 ? key : null,
    budgetUsd: num(process.env.MUSE_BUDGET_USD, 5),
    profile: explicit ? raw : "local",
    profileExplicit: explicit,
    cacheEnabled: (process.env.MUSE_CACHE ?? "1") !== "0",
  };
}

export function profileFor(name: ProfileName | undefined): Profile {
  return PROFILES[name && PROFILES[name] ? name : readEnv().profile];
}

/** API base for the Gemini REST surface. */
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
