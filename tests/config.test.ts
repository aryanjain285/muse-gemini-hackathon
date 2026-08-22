/**
 * Configuration integrity tests.
 *
 * These guard the class of bug that is invisible until a real API call fails: a
 * value that looks right, type-checks, and is rejected by the provider. One shipped
 * — every profile carried `imageSize: "0.5K"`, which is the label Google's *pricing
 * table* uses for the cheapest tier while the API accepts only "512". Seven keyframe
 * calls failed with a 400 and the fallback quietly covered it, so nothing looked
 * broken except the bill being zero.
 *
 * Anything here that a live endpoint constrains is asserted against the accepted
 * set, and every model a profile can route to must have a price.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_TASKS,
  FALLBACKS,
  IMAGE_SIZES,
  LIMITS,
  OUTPUT,
  PRICES,
  PROFILES,
  PROFILE_NAMES,
  profileFor,
  type Task,
  VIDEO_DURATIONS,
  videoDurationFor,
} from "@/lib/core/config";

// ── values the provider validates ────────────────────────────────────────────

describe("provider-constrained values", () => {
  it("uses an image size the API accepts, not the one the price list prints", () => {
    for (const name of PROFILE_NAMES) {
      expect(IMAGE_SIZES).toContain(PROFILES[name].imageSize);
    }
  });

  /**
   * This asserted `videoSecondsBudget <= 8`, which reads the field as one clip's length.
   * It is a total for the whole reel, and the mistake held only while a single shot was
   * ever animated — capping the budget at one clip is what kept reels at one moving shot.
   * A clip's own length is constrained by `videoDurationFor`, which is tested below.
   */
  it("budgets enough generated video for at least one clip, and counts it as a total", () => {
    for (const name of PROFILE_NAMES) {
      const seconds = PROFILES[name].videoSecondsBudget;
      const scenes = PROFILES[name].maxGeneratedVideoScenes;
      if (seconds === 0) {
        // A profile that generates no video must not claim it animates scenes.
        expect(scenes).toBe(0);
        continue;
      }
      expect(scenes).toBeGreaterThan(0);
      // Too small for a single shortest clip means the budget can never be spent.
      expect(seconds).toBeGreaterThanOrEqual(VIDEO_DURATIONS[0]);
    }
  });

  it("targets a vertical format the image and video models both support", () => {
    // 9:16 is on the accepted aspect-ratio list for both surfaces.
    expect(OUTPUT.width / OUTPUT.height).toBeCloseTo(9 / 16, 4);
    expect(OUTPUT.width).toBe(1080);
    expect(OUTPUT.height).toBe(1920);
  });
});

// ── every route is priced ────────────────────────────────────────────────────

describe("pricing coverage", () => {
  it("prices every model any profile can route to", () => {
    // An unpriced model bills as zero, which would let the governor spend past the
    // ceiling without noticing.
    for (const name of PROFILE_NAMES) {
      for (const [task, target] of Object.entries(PROFILES[name].routes)) {
        if (target.kind !== "gemini") continue;
        expect(PRICES[target.model], `${name}/${task} → ${target.model} has no price`).toBeDefined();
      }
    }
  });

  it("prices every model in every fallback chain", () => {
    for (const [task, chain] of Object.entries(FALLBACKS)) {
      for (const model of chain) {
        expect(PRICES[model], `${task} fallback ${model} has no price`).toBeDefined();
      }
    }
  });

  it("gives each price a positive rate on its own billing unit", () => {
    for (const [model, price] of Object.entries(PRICES)) {
      switch (price.unit) {
        case "tokens":
          expect(price.inputPerM, model).toBeGreaterThan(0);
          expect(price.outputPerM, model).toBeGreaterThan(0);
          break;
        case "image":
          expect(price.outputPerM, model).toBeGreaterThan(0);
          expect(price.tokensPerImage, model).toBeGreaterThan(0);
          break;
        case "second":
          expect(price.perSecond, model).toBeGreaterThan(0);
          break;
        case "clip":
          expect(price.perClip, model).toBeGreaterThan(0);
          break;
      }
    }
  });
});

// ── profiles are coherent ────────────────────────────────────────────────────

describe("profiles", () => {
  it("covers every task, so no route can be undefined at call time", () => {
    for (const name of PROFILE_NAMES) {
      for (const task of ALL_TASKS) {
        expect(PROFILES[name].routes[task], `${name} is missing ${task}`).toBeDefined();
      }
    }
  });

  it("routes nothing to a model in the local profile", () => {
    // This is the guarantee behind "runs with no key at all".
    for (const task of ALL_TASKS) {
      expect(PROFILES.local.routes[task].kind).toBe("local");
    }
    expect(PROFILES.local.videoSecondsBudget).toBe(0);
    expect(PROFILES.local.maxGeneratedVideoScenes).toBe(0);
  });

  it("keeps media local in the wiring profile, which exists to be cheap", () => {
    expect(PROFILES.wiring.routes.keyframe.kind).toBe("local");
    expect(PROFILES.wiring.routes.video.kind).toBe("local");
    expect(PROFILES.wiring.routes.music.kind).toBe("local");
    expect(PROFILES.wiring.routes.director.kind).toBe("gemini");
    expect(PROFILES.wiring.routes.critic.kind).toBe("gemini");
  });

  it("only budgets video seconds where a video route exists, and vice versa", () => {
    for (const name of PROFILE_NAMES) {
      const p = PROFILES[name];
      const generates = p.routes.video.kind === "gemini";
      expect(generates ? p.videoSecondsBudget > 0 : p.videoSecondsBudget === 0).toBe(true);
      expect(generates ? p.maxGeneratedVideoScenes > 0 : p.maxGeneratedVideoScenes === 0).toBe(true);
    }
  });

  it("names each profile consistently with its key", () => {
    for (const name of PROFILE_NAMES) {
      expect(PROFILES[name].name).toBe(name);
      expect(PROFILES[name].label.length).toBeGreaterThan(0);
      expect(PROFILES[name].blurb.length).toBeGreaterThan(0);
    }
  });

  it("falls back to a real profile for an unknown name rather than throwing", () => {
    expect(profileFor(undefined)).toBeDefined();
    expect(profileFor("nonsense" as never)).toBeDefined();
  });
});

// ── fallback chains terminate ────────────────────────────────────────────────

describe("fallback chains", () => {
  it("declares a chain for every task", () => {
    for (const task of ALL_TASKS) {
      expect(FALLBACKS[task as Task]).toBeDefined();
    }
  });

  it("never repeats a model inside one chain", () => {
    for (const [task, chain] of Object.entries(FALLBACKS)) {
      expect(new Set(chain).size, `${task} repeats a model`).toBe(chain.length);
    }
  });

  it("routes video only to models whose surface the adapter can call", () => {
    // The adapter picks the long-running or the conversational surface by model id
    // prefix, so a chain entry it cannot recognise would be called the wrong way.
    for (const model of FALLBACKS.video) {
      expect(model.startsWith("veo-") || model.includes("omni")).toBe(true);
    }
  });
});

// ── limits are sane ──────────────────────────────────────────────────────────

describe("limits", () => {
  it("allows the Director longer than a tight timeout, which cost a fallback", () => {
    // A high-thinking structured call measured over 90s; the old ceiling burned the
    // full timeout and then paid for a second model.
    expect(LIMITS.timeoutMs.director).toBeGreaterThanOrEqual(150_000);
  });

  it("sets the project deadline well above a full local render", () => {
    // Too low and it fires mid-run, silently disabling whatever runs last.
    expect(LIMITS.demoDeadlineMs).toBeGreaterThan(LIMITS.timeoutMs.video);
    expect(LIMITS.demoDeadlineMs).toBeGreaterThanOrEqual(600_000);
  });

  it("gives every stage a positive timeout", () => {
    for (const [stage, ms] of Object.entries(LIMITS.timeoutMs)) {
      expect(ms, stage).toBeGreaterThan(0);
    }
  });

  /**
   * This asserted four limits, three of which no code read — including
   * `concurrency.video` being 1, with a comment explaining that video is expensive and
   * rate-limited. The comment was a belief about behaviour that was never enforced
   * anywhere, and the passing test made it look settled. A limit is only real if
   * something obeys it.
   */
  it("keeps only concurrency limits something enforces", () => {
    expect(Object.keys(LIMITS.concurrency).sort()).toEqual(["scenes", "video"]);
    expect(LIMITS.concurrency.scenes).toBeGreaterThan(0);
    // Video is separately gated because it is rate-limited by the provider, and it must
    // stay below scene concurrency or the gate is decoration again.
    expect(LIMITS.concurrency.video).toBeGreaterThan(0);
    expect(LIMITS.concurrency.video).toBeLessThan(LIMITS.concurrency.scenes);
  });

  it("paces video starts, because the provider limits per minute not per moment", () => {
    // Capping concurrency at two still issues requests as fast as they finish, and every
    // one came back 429. A gap between starts is the only thing that respects a
    // per-minute allowance.
    expect(LIMITS.videoStartIntervalMs).toBeGreaterThan(0);
    // Concurrency and pacing together must not exceed a rate a preview tier tolerates:
    // two in flight, one start every 12s, is at most ten starts a minute.
    const startsPerMinute = 60_000 / LIMITS.videoStartIntervalMs;
    expect(startsPerMinute).toBeLessThanOrEqual(10);
  });
  it("offers a video fallback the API can actually be called with", () => {
    // gemini-omni-flash-preview sat second in this chain and answered every request with
    // "400: This model only supports Interactions API", so a Veo failure had no fallback
    // and dropped straight to the deterministic engine. generateMotion dispatches on a
    // "veo-" prefix, so anything else in this chain reaches the wrong surface.
    for (const model of FALLBACKS.video) {
      expect(model, model).toMatch(/^veo-/);
      expect(PRICES[model], `${model} must be priced`).toBeDefined();
    }
  });

  it("gives the hero scene more semantic retries than an ordinary scene", () => {
    expect(LIMITS.semanticRetries.hero).toBeGreaterThan(LIMITS.semanticRetries.default);
  });

  it("bounds an agent run in turns, tool calls and money", () => {
    expect(LIMITS.agent.maxTurns).toBeGreaterThan(0);
    expect(LIMITS.agent.maxToolCalls).toBeGreaterThan(LIMITS.agent.maxTurns);
    expect(LIMITS.agent.maxUsdPerRun).toBeGreaterThan(0);
  });

  it("keeps the scene band inside what the schema accepts", () => {
    expect(LIMITS.minScenes).toBeGreaterThanOrEqual(3);
    expect(LIMITS.maxScenes).toBeLessThanOrEqual(9);
    expect(LIMITS.minScenes).toBeLessThan(LIMITS.maxScenes);
  });
});

// ── output format ────────────────────────────────────────────────────────────

describe("output format", () => {
  it("encodes to something a phone will play", () => {
    expect(OUTPUT.videoCodec).toBe("libx264");
    expect(OUTPUT.audioCodec).toBe("aac");
    expect(OUTPUT.fps).toBeGreaterThanOrEqual(24);
    expect(OUTPUT.crf).toBeGreaterThan(0);
    expect(OUTPUT.crf).toBeLessThan(30);
  });

  it("leaves a safe region that does not consume the frame", () => {
    expect(OUTPUT.safeTop + OUTPUT.safeBottom).toBeLessThan(0.5);
  });

  it("targets a duration inside the schema's accepted range", () => {
    expect(OUTPUT.durationS).toBeGreaterThanOrEqual(12);
    expect(OUTPUT.durationS).toBeLessThanOrEqual(45);
  });
});

// ── video durations ──────────────────────────────────────────────────────────

/**
 * The API rejects any duration outside a small accepted set with a message that reads
 * like a range: "out of bound. Please provide a value between 4 and 8, inclusive".
 * Clamping to [4,8] therefore produced plausible values that were still refused, and
 * every generated shot in a paid run fell back to the deterministic engine.
 */
describe("videoDurationFor", () => {
  it("only ever returns an accepted duration", () => {
    for (let s = -5; s <= 20; s += 0.25) {
      expect(VIDEO_DURATIONS).toContain(videoDurationFor(s));
    }
  });

  it("rounds up, so a clip is never short of its window", () => {
    expect(videoDurationFor(4)).toBe(4);
    expect(videoDurationFor(4.01)).toBe(6);
    expect(videoDurationFor(5)).toBe(6); // the value the API refused
    expect(videoDurationFor(6)).toBe(6);
    expect(videoDurationFor(6.4)).toBe(8);
    expect(videoDurationFor(8)).toBe(8);
  });

  it("caps at the longest on offer rather than asking for more", () => {
    expect(videoDurationFor(12)).toBe(8);
    expect(videoDurationFor(1000)).toBe(8);
  });

  it("survives a non-finite duration", () => {
    // Math.round(NaN) is NaN and passes straight through min/max, then serialises as
    // null — a second way to send a value the API cannot accept.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(VIDEO_DURATIONS).toContain(videoDurationFor(bad));
    }
  });
});
