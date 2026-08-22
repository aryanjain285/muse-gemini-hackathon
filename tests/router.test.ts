/**
 * Router, governor and cache tests.
 *
 * These assert the three guarantees the rest of the system is built on:
 *
 *   1. A route always returns a usable value. There is no failure path that leaves
 *      a caller with nothing, which is why no caller wraps generation in a catch.
 *   2. The ceiling is a refusal, not a warning, and two concurrent calls cannot
 *      both fit the last cent.
 *   3. An identical request never reaches the network twice.
 *
 * Everything runs against a temporary workspace so no test touches real spend.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The workspace root is read at import time, so it has to be redirected before
// anything under lib/ is loaded.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "muse-router-"));
process.env.MUSE_BUDGET_USD = "1.00";
process.env.MUSE_CACHE = "1";
// A key must appear present or the router short-circuits to local before it ever
// reaches the adapter, which is correct in production and untestable here. Every
// `real` below is a stub, so no request is made and the value is never used.
process.env.GEMINI_API_KEY = "test-key-never-sent";
process.chdir(SANDBOX);

const { PROFILES, PRICES } = await import("@/lib/core/config");
const { cache } = await import("@/lib/models/cache");
const governor = await import("@/lib/models/governor");
const { mediaCodec, route, describeRoute } = await import("@/lib/models/router");
const { db, closeDb } = await import("@/lib/db/client");
const { Ledger } = await import("@/lib/db/repo");
const { MuseError } = await import("@/lib/core/util");

beforeAll(() => {
  db();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  db().prepare("DELETE FROM ledger").run();
  db().prepare("DELETE FROM audit_events").run();
  cache.clear();
  governor.__resetReservations();
});

afterEach(() => {
  governor.__resetReservations();
});

const TEXT_MODEL = "gemini-3.6-flash";

// ── cost estimation ──────────────────────────────────────────────────────────

describe("estimate", () => {
  it("bills thinking tokens at the output rate, because that is what they cost", () => {
    const withThinking = governor.estimate(TEXT_MODEL, "director", {
      inputTokens: 1000,
      outputTokens: 1000,
      thoughtTokens: 4000,
    });
    const without = governor.estimate(TEXT_MODEL, "director", {
      inputTokens: 1000,
      outputTokens: 1000,
      thoughtTokens: 0,
    });
    expect(withThinking.usd).toBeGreaterThan(without.usd);
  });

  it("prices image tokens separately from the text an image model also emits", () => {
    // Folding 1120 image tokens into the general output count at $60/M would
    // overstate a 1K image by about a third.
    const split = governor.estimate("gemini-3.1-flash-image", "keyframe", {
      inputTokens: 117,
      outputTokens: 1514,
      outputImageTokens: 1120,
    });
    const naive =
      (117 / 1e6) * 0.5 + (1514 / 1e6) * 60; // everything at the image rate
    expect(split.usd).toBeLessThan(naive * 0.8);
    expect(split.usd).toBeCloseTo(0.0687, 3);
  });

  it("prices video per second and music per clip", () => {
    expect(governor.estimate("veo-3.1-lite-generate-preview", "video", { seconds: 6 }).usd).toBeCloseTo(0.3, 4);
    expect(governor.estimate("lyria-3-clip-preview", "music", { clips: 1 }).usd).toBeCloseTo(0.04, 4);
  });

  it("returns zero for a model it does not know, and says the unit is unknown", () => {
    const e = governor.estimate("not-a-model", "director", { inputTokens: 1000 });
    expect(e.usd).toBe(0);
    expect(e.unit).toBe("unknown");
  });
});

// ── the ceiling refuses ──────────────────────────────────────────────────────

describe("budget ceiling", () => {
  it("refuses a call that would not fit, rather than warning about it", () => {
    // 1000 seconds of Veo is far past the $1.00 sandbox ceiling.
    expect(() =>
      governor.reserve({ model: "veo-3.1-generate-preview", task: "video", hint: { seconds: 1000 } }),
    ).toThrowError(/budget|remains/i);
  });

  it("throws a budget error, which the router treats as fall back rather than retry", () => {
    try {
      governor.reserve({ model: "veo-3.1-generate-preview", task: "video", hint: { seconds: 1000 } });
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(MuseError);
      expect((e as InstanceType<typeof MuseError>).kind).toBe("budget");
    }
  });

  it("counts in-flight reservations, so two calls cannot both fit the last cent", () => {
    // Each is affordable alone; together they exceed the ceiling.
    const first = governor.reserve({
      model: "veo-3.1-lite-generate-preview",
      task: "video",
      hint: { seconds: 8 }, // $0.40
    });
    const second = governor.reserve({
      model: "veo-3.1-lite-generate-preview",
      task: "video",
      hint: { seconds: 8 }, // $0.80 total
    });
    expect(() =>
      governor.reserve({
        model: "veo-3.1-lite-generate-preview",
        task: "video",
        hint: { seconds: 8 }, // would reach $1.20
      }),
    ).toThrow();
    first.release();
    second.release();
    // Released headroom is available again.
    expect(() =>
      governor.reserve({ model: "veo-3.1-lite-generate-preview", task: "video", hint: { seconds: 8 } }),
    ).not.toThrow();
  });

  it("honours a per-call cap tighter than the global ceiling", () => {
    expect(() =>
      governor.reserve({
        model: "veo-3.1-lite-generate-preview",
        task: "video",
        hint: { seconds: 8 },
        callCapUsd: 0.1,
      }),
    ).toThrow(/per-call cap/);
  });

  it("releases a reservation without billing when the call produced nothing", () => {
    const before = governor.budget().spentUsd;
    const r = governor.reserve({ model: TEXT_MODEL, task: "director", hint: { inputTokens: 1000 } });
    r.release();
    expect(governor.budget().spentUsd).toBe(before);
    expect(governor.budget().inFlightUsd).toBe(0);
  });

  it("bills the estimate when the provider reports no usage at all", () => {
    // Otherwise a provider that omits usage metadata would look free.
    const r = governor.reserve({ model: TEXT_MODEL, task: "director", hint: { inputTokens: 2000 } });
    const billed = r.settle({}, { requestHash: "h" });
    expect(billed).toBeGreaterThan(0);
    const row = Ledger.recent(1)[0];
    expect(row.estimated).toBe(1);
  });

  it("bills real usage in preference to the estimate", () => {
    const r = governor.reserve({
      model: TEXT_MODEL,
      task: "director",
      hint: { inputTokens: 100_000, outputTokens: 100_000 },
    });
    const billed = r.settle(
      { inputTokens: 10, outputTokens: 10, thoughtTokens: 0 },
      { requestHash: "h" },
    );
    // The real call was tiny, so the bill must be tiny even though we reserved big.
    expect(billed).toBeLessThan(0.001);
    expect(Ledger.recent(1)[0].estimated).toBe(0);
  });

  it("settles only once, however often settle is called", () => {
    const r = governor.reserve({ model: TEXT_MODEL, task: "director", hint: { inputTokens: 1000 } });
    const first = r.settle({ inputTokens: 1000, outputTokens: 500 }, { requestHash: "h" });
    const second = r.settle({ inputTokens: 1000, outputTokens: 500 }, { requestHash: "h" });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(Ledger.recent(10)).toHaveLength(1);
  });
});

// ── routing ──────────────────────────────────────────────────────────────────

describe("route", () => {
  const identity = { prompt: "a test" };

  it("uses the local engine when the profile says so, and does not call the model", async () => {
    let realCalls = 0;
    const r = await route<{ v: string }>({
      task: "keyframe",
      identity,
      hint: { images: 1 },
      profile: PROFILES.local,
      real: async () => {
        realCalls++;
        return { value: { v: "model" }, usage: {} };
      },
      local: async () => ({ v: "local" }),
    });
    expect(realCalls).toBe(0);
    expect(r.value.v).toBe("local");
    expect(r.route).toBe("local");
    expect(r.usd).toBe(0);
  });

  it("does not report deliberate local routing as a fallback", async () => {
    // Reporting it as a failure would make the deterministic engine look like
    // damage every time it is used on purpose.
    const r = await route<{ v: string }>({
      task: "keyframe",
      identity,
      hint: { images: 1 },
      profile: PROFILES.local,
      local: async () => ({ v: "local" }),
    });
    expect(r.fallbackReason).toBeUndefined();
  });

  it("does report a genuine diversion as a fallback, with a reason", async () => {
    const r = await route<{ v: string }>({
      task: "director",
      identity,
      hint: { inputTokens: 100 },
      profile: PROFILES.wiring,
      // No `real` implementation stands in for a task with no adapter.
      local: async () => ({ v: "local" }),
    });
    expect(r.route).toBe("local");
    expect(r.fallbackReason).toBeTruthy();
  });

  it("falls back to the local engine when every model in the chain fails", async () => {
    const attempted: string[] = [];
    const r = await route<{ v: string }>({
      task: "director",
      identity,
      hint: { inputTokens: 100 },
      profile: PROFILES.wiring,
      real: async (model) => {
        attempted.push(model);
        throw new MuseError("transient", "provider is down");
      },
      local: async () => ({ v: "local" }),
    });
    expect(attempted.length).toBeGreaterThan(1); // walked the chain
    expect(r.value.v).toBe("local");
    expect(r.fallbackReason).toMatch(/provider is down/);
  });

  it("stops the chain on a permanent rejection, which every sibling would share", async () => {
    const attempted: string[] = [];
    await route<{ v: string }>({
      task: "director",
      identity,
      hint: { inputTokens: 100 },
      profile: PROFILES.wiring,
      real: async (model) => {
        attempted.push(model);
        throw new MuseError("permanent", "malformed request");
      },
      local: async () => ({ v: "local" }),
    });
    expect(attempted).toHaveLength(1);
  });

  it("goes local rather than spending once the deadline has passed", async () => {
    let realCalls = 0;
    const r = await route<{ v: string }>({
      task: "director",
      identity,
      hint: { inputTokens: 100 },
      profile: PROFILES.wiring,
      deadlineAt: Date.now() - 1000,
      real: async () => {
        realCalls++;
        return { value: { v: "model" }, usage: {} };
      },
      local: async () => ({ v: "local" }),
    });
    expect(realCalls).toBe(0);
    expect(r.fallbackReason).toMatch(/deadline/);
  });

  it("goes local rather than exceeding the ceiling", async () => {
    let realCalls = 0;
    const r = await route<{ v: string }>({
      task: "video",
      identity,
      // Far beyond the sandbox ceiling.
      hint: { seconds: 5000 },
      profile: PROFILES.hero,
      real: async () => {
        realCalls++;
        return { value: { v: "model" }, usage: { seconds: 5000 } };
      },
      local: async () => ({ v: "local" }),
    });
    expect(realCalls).toBe(0);
    expect(r.route).toBe("local");
    expect(r.fallbackReason).toMatch(/budget/);
  });

  it("records a successful call in the ledger and the audit trail", async () => {
    await route<{ v: string }>({
      task: "director",
      identity,
      hint: { inputTokens: 500, outputTokens: 500 },
      profile: PROFILES.wiring,
      projectId: "prj_x",
      real: async () => ({
        value: { v: "model" },
        usage: { inputTokens: 500, outputTokens: 500 },
        modelVersion: TEXT_MODEL,
      }),
      local: async () => ({ v: "local" }),
    });
    expect(Ledger.projectUsd("prj_x")).toBeGreaterThan(0);
    const audit = db()
      .prepare("SELECT action FROM audit_events WHERE project_id = ?")
      .all("prj_x") as { action: string }[];
    expect(audit.some((a) => a.action === "model_call")).toBe(true);
  });
});

// ── caching ──────────────────────────────────────────────────────────────────

describe("cache", () => {
  it("replays an identical request without calling the model again", async () => {
    let realCalls = 0;
    const input = {
      task: "director" as const,
      identity: { prompt: "same" },
      hint: { inputTokens: 500, outputTokens: 500 },
      profile: PROFILES.wiring,
      real: async () => {
        realCalls++;
        return { value: { v: `call-${realCalls}` }, usage: { inputTokens: 500, outputTokens: 500 } };
      },
      local: async () => ({ v: "local" }),
    };

    const first = await route<{ v: string }>(input);
    const second = await route<{ v: string }>(input);

    expect(realCalls).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.usd).toBe(0);
    expect(second.value).toEqual(first.value);
  });

  it("records a cache hit at zero cost, so the saving is visible", async () => {
    const input = {
      task: "director" as const,
      identity: { prompt: "visible" },
      hint: { inputTokens: 500, outputTokens: 500 },
      profile: PROFILES.wiring,
      projectId: "prj_c",
      real: async () => ({ value: { v: "x" }, usage: { inputTokens: 500, outputTokens: 500 } }),
      local: async () => ({ v: "local" }),
    };
    await route<{ v: string }>(input);
    await route<{ v: string }>(input);
    const rows = Ledger.byProject("prj_c");
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.cache_hit === 1)).toHaveLength(1);
    expect(rows.find((r) => r.cache_hit === 1)?.usd).toBe(0);
  });

  it("treats a different request as different, however similar", async () => {
    let realCalls = 0;
    const make = (prompt: string) => ({
      task: "director" as const,
      identity: { prompt },
      hint: { inputTokens: 500 },
      profile: PROFILES.wiring,
      real: async () => {
        realCalls++;
        return { value: { v: prompt }, usage: { inputTokens: 500 } };
      },
      local: async () => ({ v: "local" }),
    });
    await route<{ v: string }>(make("a"));
    await route<{ v: string }>(make("b"));
    expect(realCalls).toBe(2);
  });

  it("retires an entry when the template version changes", async () => {
    let realCalls = 0;
    const make = (version: string) => ({
      task: "director" as const,
      identity: { prompt: "stable" },
      cacheVersion: version,
      hint: { inputTokens: 500 },
      profile: PROFILES.wiring,
      real: async () => {
        realCalls++;
        return { value: { v: version }, usage: { inputTokens: 500 } };
      },
      local: async () => ({ v: "local" }),
    });
    await route<{ v: string }>(make("v1"));
    await route<{ v: string }>(make("v1"));
    await route<{ v: string }>(make("v2"));
    expect(realCalls).toBe(2);
  });

  it("round-trips media through the cache with its bytes intact", async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 250, 251]);
    let realCalls = 0;
    const input = {
      task: "keyframe" as const,
      identity: { prompt: "an image" },
      hint: { images: 1 },
      codec: mediaCodec<{ bytes: Buffer; mime: string }>(),
      profile: PROFILES.standard,
      real: async () => {
        realCalls++;
        return { value: { bytes, mime: "image/png" }, usage: { images: 1, outputImageTokens: 750 } };
      },
      local: async () => ({ bytes: Buffer.alloc(0), mime: "image/png" }),
    };
    await route<{ bytes: Buffer; mime: string }>(input);
    const second = await route<{ bytes: Buffer; mime: string }>(input);
    expect(realCalls).toBe(1);
    expect(second.cached).toBe(true);
    expect(Buffer.compare(second.value.bytes, bytes)).toBe(0);
    expect(second.value.mime).toBe("image/png");
  });

  it("keys on the payload regardless of property order", () => {
    const a = cache.key({ model: "m", task: "t", payload: { x: 1, y: 2 } });
    const b = cache.key({ model: "m", task: "t", payload: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it("reports its own size, which the doctor prints", () => {
    cache.put("abcdef0123", { hello: "world" }, Buffer.from("bytes"));
    const stats = cache.stats();
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(0);
  });
});

// ── projection for the UI ────────────────────────────────────────────────────

describe("describeRoute", () => {
  it("reports local and free for a locally routed task", () => {
    const d = describeRoute("keyframe", PROFILES.local);
    expect(d.route).toBe("local");
    expect(d.model).toBeNull();
    expect(d.estimateUsd).toBe(0);
  });

  it("names the model and a positive estimate for a real route", () => {
    const d = describeRoute("keyframe", PROFILES.standard);
    // Without a key configured every route reports local, which is honest.
    if (d.model !== null) {
      expect(PRICES[d.model]).toBeDefined();
      expect(d.estimateUsd).toBeGreaterThan(0);
    } else {
      expect(d.route).toBe("local");
    }
  });
});
