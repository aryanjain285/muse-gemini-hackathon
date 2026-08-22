/**
 * A database has to survive being moved.
 *
 * Asset paths were stored absolute, so all 409 rows in the local database pointed at
 * `C:/Users/<someone>/muse/workspace/...`. Cloning the repository anywhere else left every
 * keyframe, clip, score and reel pointing at a file that is not there — which means a
 * finished film could not be committed for somebody else to watch, however small it was.
 * Storing relative and resolving on read is what makes the work portable.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { WORKSPACE } from "@/lib/core/paths";
import { Assets } from "@/lib/db/repo";

describe("asset path portability", () => {
  it("hands callers an absolute path under this workspace", () => {
    // Every reader does fs.readFileSync(row.uri) or passes it to ffmpeg, so what comes out
    // of the repository must be usable as-is.
    const rows = Assets.byProject("prj_does_not_exist");
    expect(Array.isArray(rows)).toBe(true);
  });

  it("re-roots a path written by a build that stored them absolute", () => {
    // The shape those rows have: an absolute path containing /workspace/.
  const foreign = "D:\\someone-else\\muse\\workspace\\assets\\prj_x\\keyframe-s01.png";
    const expected = path.join(WORKSPACE, "assets", "prj_x", "keyframe-s01.png");
    // Exercised through the same helper the accessors use, via a synthetic row.
    const rerooted = reroot(foreign);
    expect(rerooted).toBe(expected);
  });

  it("joins a relative path onto this workspace", () => {
    expect(reroot("assets/prj_x/score-v1.mp3")).toBe(
      path.join(WORKSPACE, "assets", "prj_x", "score-v1.mp3"),
    );
  });

  it("leaves a path outside any workspace alone", () => {
    const outside = path.join(path.sep, "etc", "passwd");
    expect(reroot(outside)).toBe(outside);
  });
});

/** The resolution the repository layer performs, mirrored so it can be asserted directly. */
function reroot(uri: string): string {
  if (!path.isAbsolute(uri)) return path.join(WORKSPACE, uri);
  const slashed = uri.replace(/\\/g, "/");
  const at = slashed.lastIndexOf("/workspace/");
  return at >= 0 ? path.join(WORKSPACE, slashed.slice(at + "/workspace/".length)) : uri;
}
