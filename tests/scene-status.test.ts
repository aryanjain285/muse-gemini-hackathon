/**
 * Which state a scene is shown in.
 *
 * This had no test, and that is why a "failed" path shipped twice without working. The
 * type declared "failed" and two components rendered it while no code path produced it, so
 * a dead scene read as running for ever. The first fix then tested two signals that are
 * never written — scene_jobs has no writer, and a QC row is always created alongside its
 * asset, so "a rejected verdict with no clip" cannot occur — leaving the branch unreachable
 * a second time. An executable check is the only thing that catches an unreachable branch.
 */
import { describe, expect, it } from "vitest";
import { sceneStatus } from "@/lib/server/views";

const base = {
  hasKeyframe: false,
  hasClip: false,
  running: false,
  decision: null as string | null,
  fallback: false,
  runFailed: false,
};

describe("sceneStatus", () => {
  it("reports failed when the run died and the scene has no clip", () => {
    expect(sceneStatus({ ...base, runFailed: true })).toBe("failed");
    expect(sceneStatus({ ...base, runFailed: true, hasKeyframe: true })).toBe("failed");
  });

  it("does not report failed while a run is still going", () => {
    // A run in flight may still reach the scene, so a stale failure must not pre-empt it.
    expect(sceneStatus({ ...base, runFailed: true, running: true })).toBe("running");
  });

  it("does not report failed when the scene actually produced a clip", () => {
    // A failed run that got this far still made something watchable.
    expect(sceneStatus({ ...base, runFailed: true, hasClip: true })).toBe("done");
  });

  it("still distinguishes fallback from done", () => {
    expect(sceneStatus({ ...base, hasClip: true, decision: "FALLBACK" })).toBe("fallback");
    expect(sceneStatus({ ...base, hasClip: true, fallback: true })).toBe("fallback");
    expect(sceneStatus({ ...base, hasClip: true })).toBe("done");
  });

  it("reads an untouched scene as pending and a started one as running", () => {
    expect(sceneStatus({ ...base })).toBe("pending");
    expect(sceneStatus({ ...base, hasKeyframe: true })).toBe("running");
    expect(sceneStatus({ ...base, running: true })).toBe("running");
  });

  it("can reach every state it declares", () => {
    const reached = new Set([
      sceneStatus({ ...base }),
      sceneStatus({ ...base, hasKeyframe: true }),
      sceneStatus({ ...base, hasClip: true }),
      sceneStatus({ ...base, hasClip: true, fallback: true }),
      sceneStatus({ ...base, runFailed: true }),
    ]);
    expect([...reached].sort()).toEqual(["done", "failed", "fallback", "pending", "running"]);
  });
});
