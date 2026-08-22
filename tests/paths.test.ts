/**
 * Media URLs and the guard that serves them.
 *
 * Every finished reel 404'd for the life of the project. Renders are written to a
 * sibling of the asset root, the URL builder emitted a path relative to the asset
 * root alone, and so a reel's URL began with `..` — which the traversal guard then
 * correctly refused. The output the product exists to produce was unreachable in the
 * product, and it went unnoticed because the files were verified on disk.
 *
 * A round trip is the check that would have caught it: a URL built from a real
 * location must resolve back to that exact file.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { PATHS, assetUrl, resolveAssetPath } from "@/lib/core/paths";
import { sniff, validateUpload } from "@/lib/services/assets";

/** Strip the route prefix, which is what the handler receives as segments. */
function requestPath(url: string): string {
  return url.replace(/^\/api\/assets\//, "");
}

describe("media urls", () => {
  it("round-trips a file in every served root", () => {
    const cases = [
      path.join(PATHS.assets, "prj_abc", "keyframe-s01-v1-a0.png"),
      path.join(PATHS.renders, "a-film-prj_abc-v1.mp4"),
      path.join(PATHS.renders, "a-film-prj_abc-v1-hard_cuts.mp4"),
    ];
    for (const abs of cases) {
      const resolved = resolveAssetPath(requestPath(assetUrl(abs)));
      expect(resolved).toBe(path.resolve(abs));
    }
  });

  it("names the root in the url rather than reaching out of one", () => {
    expect(assetUrl(path.join(PATHS.renders, "reel.mp4"))).toBe("/api/assets/renders/reel.mp4");
    expect(assetUrl(path.join(PATHS.assets, "p", "poster.jpg"))).toBe("/api/assets/assets/p/poster.jpg");
    // The symptom of the bug: no reel URL may contain a parent-directory hop.
    expect(assetUrl(path.join(PATHS.renders, "reel.mp4"))).not.toContain("..");
  });

  it("refuses anything that escapes its root", () => {
    expect(resolveAssetPath("assets/../renders/reel.mp4")).toBeNull();
    expect(resolveAssetPath("renders/../../muse.db")).toBeNull();
    expect(resolveAssetPath("assets/../../../etc/passwd")).toBeNull();
  });

  it("refuses roots it does not serve, including the ones that exist on disk", () => {
    for (const rel of ["cache/x.bin", "logs/muse.jsonl", "tmp/a/b.png", "muse.db", "unserved/reel.mp4"]) {
      expect(resolveAssetPath(rel)).toBeNull();
    }
  });

  it("refuses a root with no file after it", () => {
    expect(resolveAssetPath("")).toBeNull();
    expect(resolveAssetPath("assets")).toBeNull();
    expect(resolveAssetPath("renders/")).toBeNull();
  });
});

// -- uploads -----------------------------------------------------------------

/**
 * HEIC is what a phone produces, and it shares the ISO container with MP4. Without
 * naming its brands the sniffer answers "video/mp4" and a photo library is rejected for
 * not being an image, which is the wrong answer to the commonest upload there is.
 */
describe("sniff", () => {
  /** An ISO container header with the given brand at offset 8. */
  const iso = (brand: string) => {
    const b = Buffer.alloc(16);
    b.write("ftyp", 4, "latin1");
    b.write(brand, 8, "latin1");
    return b;
  };

  it("recognises the brands a phone writes", () => {
    for (const brand of ["heic", "heix", "mif1", "msf1", "avif"]) {
      expect(sniff(iso(brand))).toBe("image/heic");
    }
  });

  it("still tells video and audio apart in the same container", () => {
    expect(sniff(iso("isom"))).toBe("video/mp4");
    expect(sniff(iso("mp42"))).toBe("video/mp4");
    expect(sniff(iso("M4A "))).toBe("audio/mp4");
  });

  it("accepts a phone photograph as an image", () => {
    const heic = Buffer.concat([iso("heic"), Buffer.alloc(64)]);
    const check = validateUpload(heic, "image");
    expect(check.ok).toBe(true);
  });

  it("does not mistake a real jpeg or png", () => {
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });
});

// -- byte ranges -------------------------------------------------------------

/**
 * `bytes=-N` asks for the LAST N bytes. Reading an absent first group as 0 answered it
 * with the head of the file — a well-formed 206 carrying the wrong bytes. Players use
 * suffix ranges to find the moov atom at the end of an MP4, so this is how seeking
 * misbehaves without anything appearing to fail.
 */
describe("range parsing", () => {
  /** The same arithmetic the asset route performs on a Range header. */
  function resolve(header: string, size: number): { start: number; end: number } | null {
    const match = /bytes=(\d*)-(\d*)/.exec(header);
    if (!match) return null;
    const suffix = !match[1] && Boolean(match[2]);
    const start = suffix
      ? Math.max(0, size - Number(match[2]))
      : match[1]
        ? Number(match[1])
        : 0;
    const end = suffix ? size - 1 : match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    return { start, end };
  }

  it("reads a suffix range from the end of the file", () => {
    expect(resolve("bytes=-500", 10_000)).toEqual({ start: 9_500, end: 9_999 });
  });

  it("does not let a suffix longer than the file run negative", () => {
    expect(resolve("bytes=-50000", 10_000)).toEqual({ start: 0, end: 9_999 });
  });

  it("still reads an ordinary closed range", () => {
    expect(resolve("bytes=0-1023", 10_000)).toEqual({ start: 0, end: 1_023 });
    expect(resolve("bytes=2048-4095", 10_000)).toEqual({ start: 2_048, end: 4_095 });
  });

  it("reads an open range to the end", () => {
    expect(resolve("bytes=9000-", 10_000)).toEqual({ start: 9_000, end: 9_999 });
  });

  it("clamps an end past the file", () => {
    expect(resolve("bytes=0-99999", 10_000)).toEqual({ start: 0, end: 9_999 });
  });
});
