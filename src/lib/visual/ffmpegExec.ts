/**
 * ffmpeg/ffprobe process plumbing for the local visual engine.
 *
 * Every child process the engine starts goes through here for one reason: a bad
 * render has to be diagnosable. The exit code alone never says what went wrong,
 * so the stderr tail travels with the error, and failures are classified as
 * transient (the machine was busy) or permanent (our arguments were wrong) so the
 * caller can decide whether a retry could possibly help.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MuseError } from "@/lib/core/util";

// ── process plumbing ─────────────────────────────────────────────────────────

/** Failure text that points at the machine rather than at our arguments. */
const TRANSIENT_STDERR =
  /(resource temporarily unavailable|device or resource busy|input\/output error|no space left|cannot allocate memory|broken pipe)/i;

export interface ProcResult {
  stdout: Buffer;
  stderr: string;
}

/**
 * Run ffmpeg/ffprobe with an argument array — never a shell string, so Windows
 * paths with spaces survive — and surface the stderr tail on failure.
 */
export async function exec(bin: "ffmpeg" | "ffprobe", args: string[], stdin?: Buffer): Promise<ProcResult> {
  return new Promise<ProcResult>((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
      if (err.length > 12_000) err = err.slice(-12_000);
    });
    child.on("error", (e: Error) =>
      reject(new MuseError("permanent", `${bin} could not be started: ${e.message}`, { bin })),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(chunks), stderr: err });
        return;
      }
      const tail = err.trim().split(/\r?\n/).slice(-6).join(" | ");
      reject(
        new MuseError(
          TRANSIENT_STDERR.test(err) ? "transient" : "permanent",
          `${bin} exited ${code}: ${tail}`,
          { bin, args },
        ),
      );
    });
    // A filter graph can close its input early; that is not an error we act on.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? Buffer.alloc(0));
  });
}

export interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

/** ffprobe's JSON view of a file, narrowed to the fields we read. */
export async function probeStreams(filePath: string): Promise<{ streams: ProbeStream[]; durationS: number }> {
  if (!fs.existsSync(filePath)) {
    throw new MuseError("permanent", `probe target does not exist: ${filePath}`, { filePath });
  }
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw new MuseError("permanent", `ffprobe returned unparseable JSON for ${filePath}`, { filePath });
  }
  const obj = (parsed ?? {}) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const duration = Number(obj.format?.duration ?? NaN);
  return { streams: obj.streams ?? [], durationS: Number.isFinite(duration) ? duration : 0 };
}

/** Pull one downscaled raw plane out of an image so it can be measured in TS. */
export async function rawSample(
  filePath: string,
  w: number,
  h: number,
  pixFmt: "rgb24" | "gray",
  flags: "area" | "bicubic",
): Promise<Buffer> {
  const stride = pixFmt === "rgb24" ? 3 : 1;
  const { stdout } = await exec("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-i",
    filePath,
    "-vf",
    `scale=${w}:${h}:flags=${flags},format=${pixFmt}`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
  const want = w * h * stride;
  if (stdout.length < want) {
    throw new MuseError("permanent", `sampled ${stdout.length} of ${want} bytes from ${filePath}`, { filePath });
  }
  return stdout.subarray(0, want);
}

/** Encoder arguments implied by the output extension. */
export function stillEncoderArgs(outPath: string): string[] {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === ".png") return ["-c:v", "png", "-pred", "mixed"];
  if (ext === ".jpg" || ext === ".jpeg") return ["-c:v", "mjpeg", "-q:v", "2"];
  if (ext === ".webp") return ["-c:v", "libwebp", "-quality", "92"];
  throw new MuseError("permanent", `unsupported still extension ${ext || "(none)"}`, { outPath });
}
