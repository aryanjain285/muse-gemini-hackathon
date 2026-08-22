/**
 * The composer. Deliberately boring, deterministic software: it reads a manifest
 * and emits an MP4, making no creative decisions and calling no models.
 *
 * Rendering runs as a short sequence of separately verifiable passes rather than
 * one enormous filtergraph, because a single graph that fails tells you nothing
 * about which of forty filters broke. Each pass is logged into the outcome, and
 * each has a conservative fallback: if a clip's effect chain fails it is rendered
 * plain, and if the transition chain fails the reel is assembled on hard cuts.
 * An export therefore degrades in quality under failure but does not stop.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { OUTPUT } from "@/lib/core/config";
import { tmpDir } from "@/lib/core/paths";
import { MuseError, round, sha256, truncate } from "@/lib/core/util";
import { logger, type Logger } from "@/lib/core/logger";
import { bloom, clipChain, fitVertical, grade, grain, overlayText, vignette } from "./filters";
import type { Transition } from "@/lib/spec/directorSpec";
import { getBundle } from "@/lib/templates/bundles";
import { encodeWav, renderAccent } from "@/lib/music/synth";
import type { ManifestClip, RenderManifest, RenderOutcome, ReelCheck, RevealMethod } from "./types";

// ── process helpers ──────────────────────────────────────────────────────────

const FFMPEG = process.env.MUSE_FFMPEG || "ffmpeg";
const FFPROBE = process.env.MUSE_FFPROBE || "ffprobe";

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  command: string;
}

/**
 * Run a child process with an argument array. Never a shell string: Windows paths
 * contain spaces and drive colons, and a shell would mangle filtergraphs.
 */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; captureStdout?: boolean } = {},
): Promise<RunResult> {
  const command = `${path.basename(bin)} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;

    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new MuseError("timeout", `${path.basename(bin)} exceeded ${opts.timeoutMs}ms`, { command: truncate(command, 400) }));
      },
      opts.timeoutMs ?? 300_000,
    );

    child.stdout?.on("data", (d: Buffer) => {
      if (opts.captureStdout) out.push(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString("utf8");
      // ffmpeg is chatty; keep only the tail, which is where failures appear.
      if (err.length > 24_000) err = err.slice(-16_000);
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new MuseError("permanent", `could not start ${path.basename(bin)}: ${e.message}`, {
          hint: "is ffmpeg on PATH?",
        }),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out), stderr: err, command });
        return;
      }
      const tail = err.split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
      reject(
        new MuseError("permanent", `${path.basename(bin)} exited ${code}: ${tail}`, {
          command: truncate(command, 600),
        }),
      );
    });
  });
}

export const ffmpeg = (args: string[], opts?: { timeoutMs?: number; captureStdout?: boolean }) =>
  run(FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], opts);

// ── probing ──────────────────────────────────────────────────────────────────

export interface MediaInfo {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioDurationS: number;
  bytes: number;
}

/**
 * Master limiter for the finished mix.
 *
 * The ceiling sits well under full scale because the limiter is not the last thing to
 * touch the signal: the AAC encoder reconstructs peaks between samples and overshoots it.
 * Measured on a finished reel, limiting to 0.94 came back at -0.1 dBFS with 7669 samples
 * pinned at full scale, which is where a phone speaker starts to distort. 0.89 measured
 * -0.4 dBFS and 554; 0.85 clears a -1 dBTP master. Mean level is unchanged throughout, so
 * the headroom costs loudness only where the mix was clipping anyway.
 */
/**
 * The gain envelope that gives a flat score an arc.
 *
 * A single ramp evaluated per frame: held at `quietGain` through the opening, released
 * linearly to unity across the build, full from there on. It is deliberately gain rather
 * than filtering — a music model that ignored a request for rising density has produced
 * one texture, and pretending otherwise with EQ sounds worse than simply letting the
 * payoff be the loud part.
 *
 * Returns an empty string when the score already has dynamics of its own, so the filter
 * chain is untouched in the ordinary case.
 */
function arcFilter(arc: RenderManifest["audio"]["arc"]): string {
  if (!arc) return "";
  const q = round(arc.quietGain, 3);
  const from = round(arc.liftFromS, 3);
  const span = round(Math.max(0.25, arc.liftToS - arc.liftFromS), 3);
  return `volume=eval=frame:volume='${q}+${round(1 - q, 3)}*clip((t-${from})/${span},0,1)',`;
}

const LIMITER = "level_in=1:level_out=0.85:limit=0.85:attack=4:release=90";

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  if (!fs.existsSync(filePath)) {
    throw new MuseError("permanent", `cannot probe missing file ${filePath}`);
  }
  const res = await run(
    FFPROBE,
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { timeoutMs: 30_000, captureStdout: true },
  );
  const parsed = JSON.parse(res.stdout.toString("utf8")) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      duration?: string;
    }[];
  };
  const streams = parsed.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const rate = v?.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v?.r_frame_rate;
  const [num, den] = (rate ?? "0/1").split("/").map(Number);

  return {
    durationS: round(Number(parsed.format?.duration ?? v?.duration ?? a?.duration ?? 0), 4),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: den ? round(num / den, 3) : 0,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    audioDurationS: round(Number(a?.duration ?? 0), 4),
    bytes: fs.statSync(filePath).size,
  };
}

// ── clip conforming ──────────────────────────────────────────────────────────

const ENC_INTERMEDIATE = [
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "13",
  "-pix_fmt", "yuv420p",
];

/**
 * Force any input to exact duration, size, frame rate and pixel format, with no
 * audio. Generated video arrives at the model's own duration and often carries a
 * silent track, so nothing downstream should ever see an unconformed clip.
 *
 * A clip shorter than requested is extended by holding its last frame rather than
 * looping, because a loop reads as a glitch while a held frame reads as a beat.
 */
export async function conformClip(input: {
  inputPath: string;
  outPath: string;
  durationS: number;
  fps?: number;
  width?: number;
  height?: number;
  /** Where in the source to start. */
  trimStartS?: number;
}): Promise<{ path: string; durationS: number }> {
  const fps = input.fps ?? OUTPUT.fps;
  const width = input.width ?? OUTPUT.width;
  const height = input.height ?? OUTPUT.height;
  const target = round(input.durationS, 4);

  const info = await probeMedia(input.inputPath);
  const available = Math.max(0, info.durationS - (input.trimStartS ?? 0));
  const needsHold = available + 0.02 < target;

  const chain = [
    fitVertical(),
    `fps=${fps}`,
    // tpad holds the final frame; harmless when the clip is already long enough.
    ...(needsHold ? [`tpad=stop_mode=clone:stop_duration=${round(target - available + 0.2, 3)}`] : []),
    `trim=duration=${target}`,
    "setpts=PTS-STARTPTS",
    `scale=${width}:${height}:flags=lanczos`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");

  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  await ffmpeg(
    [
      "-y",
      ...(input.trimStartS ? ["-ss", String(round(input.trimStartS, 3))] : []),
      "-i", input.inputPath,
      "-an",
      "-vf", chain,
      "-fps_mode", "cfr",
      "-r", String(fps),
      ...ENC_INTERMEDIATE,
      "-movflags", "+faststart",
      input.outPath,
    ],
    { timeoutMs: 180_000 },
  );

  const out = await probeMedia(input.outPath);
  return { path: input.outPath, durationS: out.durationS };
}

// ── audio bed ────────────────────────────────────────────────────────────────

/**
 * Build the final audio track: the score trimmed to length with fades, plus any
 * deterministic accents the reconciliation step asked for where the music lacked
 * a beat the plan needed.
 */
async function buildAudio(
  m: RenderManifest,
  work: string,
  commands: string[],
  log: Logger,
): Promise<string> {
  const outPath = path.join(work, "audio.m4a");
  const accentFiles: string[] = [];

  for (const [i, accent] of m.audio.accents.entries()) {
    try {
      const durationS = accent.kind === "riser" ? 1.8 : accent.kind === "sweep" ? 0.9 : 1.6;
      const mono = renderAccent(accent.kind, durationS);
      const wav = encodeWav(mono, mono, 44100);
      const file = path.join(work, `accent-${i}-${accent.kind}.wav`);
      fs.writeFileSync(file, wav);
      accentFiles.push(file);
    } catch (e) {
      log.warn("accent synthesis failed; skipping it", { kind: accent.kind, error: String(e) });
    }
  }

  const inputs: string[] = [
    ...(m.audio.trimStartS ? ["-ss", String(round(m.audio.trimStartS, 3))] : []),
    "-i", m.audio.path,
  ];
  for (const f of accentFiles) inputs.push("-i", f);

  const parts: string[] = [];
  const fadeOutStart = round(Math.max(0, m.durationS - m.audio.fadeOutS), 3);
  parts.push(
    `[0:a]atrim=duration=${round(m.durationS, 3)},asetpts=N/SR/TB,` +
      `aformat=sample_fmts=fltp:sample_rates=${OUTPUT.audioSampleRate}:channel_layouts=stereo,` +
      `volume=${round(Math.pow(10, m.audio.gainDb / 20), 4)},` +
      arcFilter(m.audio.arc) +
      `afade=t=in:st=0:d=${round(m.audio.fadeInS, 3)},` +
      `afade=t=out:st=${fadeOutStart}:d=${round(m.audio.fadeOutS, 3)}[bed]`,
  );

  const mixLabels = ["[bed]"];
  for (const [i, accent] of m.audio.accents.entries()) {
    if (i >= accentFiles.length) break;
    const delayMs = Math.max(0, Math.round(accent.atS * 1000));
    const gain = round(Math.pow(10, accent.gainDb / 20), 4);
    parts.push(
      `[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=${OUTPUT.audioSampleRate}:channel_layouts=stereo,` +
        `volume=${gain},adelay=${delayMs}|${delayMs}[acc${i}]`,
    );
    mixLabels.push(`[acc${i}]`);
  }

  if (mixLabels.length > 1) {
    parts.push(
      `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0[mixed]`,
    );
    // amix can nudge peaks over unity; a limiter keeps the master clean.
    parts.push(`[mixed]alimiter=${LIMITER}[out]`);
  } else {
    parts.push(`[bed]alimiter=${LIMITER}[out]`);
  }

  const args = [
    "-y",
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", "[out]",
    "-c:a", OUTPUT.audioCodec,
    "-b:a", "192k",
    "-ar", String(OUTPUT.audioSampleRate),
    "-ac", String(OUTPUT.audioChannels),
    "-t", String(round(m.durationS, 3)),
    outPath,
  ];
  const res = await ffmpeg(args, { timeoutMs: 120_000 });
  commands.push(res.command);
  return outPath;
}

// ── per-clip effects ─────────────────────────────────────────────────────────

/** Render one clip's effect chain. Falls back to a plain conform on failure. */
/**
 * The filter graph that turns a photograph into the film.
 *
 * A dissolve between the two would say "here is a photo, and here is a painting".
 * These say the photograph itself changed, and they do it without a model call: the
 * merge is driven by the brightness of the original, so the paint appears where the
 * light already was and spreads into the shadows as the shot runs. In a golden-hour
 * preset that means the sun turns the frame, which is the right causality.
 *
 * Luma drives the Y plane only. Chroma cannot be thresholded on its own value without
 * tearing colour apart, so it crosses over on a plain ramp a little behind the luma —
 * close enough to read as one change, late enough that colour arrives with the paint
 * rather than before it.
 */
function revealGraph(input: {
  width: number;
  height: number;
  fps: number;
  method: RevealMethod;
  startS: number;
  durationS: number;
}): string {
  const { width, height, fps, method, startS } = input;
  const dur = Math.max(0.2, input.durationS);
  const fit = `${fitVertical()},fps=${fps},scale=${width}:${height}:flags=lanczos,setsar=1,format=yuv420p`;

  // Progress through the change, 0 before it starts and 1 once it is done.
  const P = `clip((T-${round(startS, 3)})/${round(dur, 3)},0,1)`;

  // How far ahead of the ramp a pixel converts, by how bright it is. A wider spread
  // means the highlights lead by more; edge_dissolve leads by least and so reads as
  // the whole frame changing at once.
  const spread = method === "edge_dissolve" ? 0.5 : method === "bloom_transform" ? 1.4 : 1.9;
  // The multiplier is the hardness of the wavefront. Low values leave a wide band where
  // both pictures are half present, which the eye reads as a dissolve; a harder edge
  // reads as a boundary travelling across the frame, which is what paint does.
  const luma = `clip((A/255 + ${spread}*${P} - ${round(spread / 2, 3)})*9,0,1)`;
  const chroma = `clip(${P}*1.3-0.18,0,1)`;

  return [
    `[0:v]${fit}[photo]`,
    `[1:v]${fit}[styled]`,
    `[photo][styled]blend=c0_expr='A+(B-A)*${luma}':c1_expr='A+(B-A)*${chroma}':c2_expr='A+(B-A)*${chroma}'[merged]`,
  ].join(";");
}

async function renderClipSegment(
  m: RenderManifest,
  clip: ManifestClip,
  index: number,
  work: string,
  commands: string[],
  warnings: string[],
  log: Logger,
): Promise<{ path: string; durationS: number }> {
  const clipLen = round(clip.endS - clip.startS + clip.transitionDurationS, 4);
  const outPath = path.join(work, `seg-${String(index).padStart(2, "0")}-${clip.sceneId}.mp4`);
  const seed = Number.parseInt(sha256(`${m.projectId}${clip.sceneId}`).slice(0, 8), 16) >>> 0;

  const src = clip.source;
  const inputArgs: string[] =
    src.kind === "color"
      ? [
          "-f", "lavfi",
          "-i", `color=c=${src.hex.replace("#", "0x")}:s=${m.width}x${m.height}:r=${m.fps}:d=${clipLen}`,
        ]
      : src.kind === "image"
        ? ["-loop", "1", "-t", String(clipLen), "-i", src.path]
        : src.kind === "transform"
          ? [
              // The photograph is a still, so it is looped for the whole clip; the
              // stylised side is already a clip of the right length.
              "-loop", "1", "-t", String(clipLen), "-i", src.fromPath,
              "-i", src.toPath,
            ]
          : [
              ...(src.trimStartS ? ["-ss", String(round(src.trimStartS, 3))] : []),
              "-i", src.path,
            ];

  const isStill = src.kind === "image" || src.kind === "color";

  // A transformation is two pictures merged before anything else happens, so the
  // camera move and the grade that follow apply to one image rather than to each
  // layer separately — which is what makes it read as one shot changing.
  const prefix =
    src.kind === "transform"
      ? revealGraph({
          width: m.width,
          height: m.height,
          fps: m.fps,
          method: src.method,
          startS: src.revealStartS,
          durationS: src.revealDurationS,
        })
      : null;
  const chainIn = prefix ? "merged" : "0:v";

  const attempt = async (useEffects: boolean) => {
    const body = useEffects
      ? clipChain({
          inLabel: chainIn,
          outLabel: "vout",
          effects: clip.effects,
          durationS: clipLen,
          fps: m.fps,
          isStill,
          seed,
        })
      : `[${chainIn}]${fitVertical()},fps=${m.fps},scale=${m.width}:${m.height}:flags=lanczos,setsar=1,format=yuv420p[vout]`;
    const graph = prefix ? `${prefix};${body}` : body;

    const res = await ffmpeg(
      [
        "-y",
        ...inputArgs,
        "-an",
        "-filter_complex", graph,
        "-map", "[vout]",
        "-t", String(clipLen),
        "-fps_mode", "cfr",
        "-r", String(m.fps),
        ...ENC_INTERMEDIATE,
        outPath,
      ],
      { timeoutMs: 180_000 },
    );
    commands.push(res.command);
  };

  try {
    await attempt(true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`${clip.sceneId}: effect chain failed, rendered plain (${truncate(msg, 160)})`);
    log.warn("clip effect chain failed; using the conservative path", {
      scene_id: clip.sceneId,
      error: msg,
    });
    await attempt(false);
  }

  // The segment must be exactly the length the transition arithmetic assumes.
  const info = await probeMedia(outPath);
  if (Math.abs(info.durationS - clipLen) > 1 / m.fps) {
    const fixed = path.join(work, `seg-${String(index).padStart(2, "0")}-${clip.sceneId}-fit.mp4`);
    await conformClip({
      inputPath: outPath,
      outPath: fixed,
      durationS: clipLen,
      fps: m.fps,
      width: m.width,
      height: m.height,
    });
    return { path: fixed, durationS: clipLen };
  }
  return { path: outPath, durationS: info.durationS };
}

// ── assembly ─────────────────────────────────────────────────────────────────

/**
 * Approved transition primitives mapped onto xfade modes, verified present in the
 * installed ffmpeg. Assembly owns this mapping rather than importing it, because
 * the offset arithmetic and the mode have to stay consistent, and a mismatch here
 * would silently slide every cut off the beat.
 */
const XFADE_MODE: Record<Exclude<Transition, "cut">, string> = {
  crossfade: "fade",
  dip_to_black: "fadeblack",
  dip_to_white: "fadewhite",
  flash: "fadewhite",
  whip_pan: "slideleft",
  luma_wipe: "smoothleft",
  film_burn: "dissolve",
  match_cut: "fadefast",
};

/**
 * Join segments with their transitions. Offsets are computed from the running
 * assembled length, which is why each segment carries its incoming transition as
 * head padding: the overlap consumes the padding and the timeline stays exact.
 */
async function assemble(
  m: RenderManifest,
  segments: { path: string; durationS: number }[],
  work: string,
  commands: string[],
  warnings: string[],
  log: Logger,
): Promise<string> {
  const outPath = path.join(work, "assembled.mp4");
  if (segments.length === 1) {
    fs.copyFileSync(segments[0].path, outPath);
    return outPath;
  }

  const withXfade = async () => {
    const parts: string[] = [];
    let prev = "0:v";
    let assembled = segments[0].durationS;

    for (let i = 1; i < segments.length; i++) {
      const clip = m.clips[i];
      const tIn = clip.transitionDurationS;
      const outLabel = i === segments.length - 1 ? "vjoin" : `x${i}`;

      if (tIn <= 0 || clip.transitionIn === "cut") {
        // A hard cut still needs a concat node to keep one stream flowing.
        parts.push(`[${prev}][${i}:v]concat=n=2:v=1:a=0[${outLabel}]`);
        assembled = round(assembled + segments[i].durationS, 4);
      } else {
        // xfade's offset is measured on the first input's timeline, which for a
        // chained graph is the running assembled length.
        const offset = round(assembled - tIn, 4);
        const mode = XFADE_MODE[clip.transitionIn] ?? "fade";
        parts.push(
          `[${prev}][${i}:v]xfade=transition=${mode}:duration=${round(tIn, 4)}:offset=${offset}[${outLabel}]`,
        );
        assembled = round(assembled + segments[i].durationS - tIn, 4);
      }
      prev = outLabel;
    }

    const res = await ffmpeg(
      [
        "-y",
        ...segments.flatMap((s) => ["-i", s.path]),
        "-filter_complex", parts.join(";"),
        "-map", "[vjoin]",
        "-fps_mode", "cfr",
        "-r", String(m.fps),
        ...ENC_INTERMEDIATE,
        outPath,
      ],
      { timeoutMs: 300_000 },
    );
    commands.push(res.command);
  };

  const withCuts = async () => {
    // Conservative preset: demuxer concat, every join a hard cut. Loses the
    // dissolves but cannot fail on a filtergraph.
    const listFile = path.join(work, "concat.txt");
    fs.writeFileSync(
      listFile,
      segments.map((s) => `file '${s.path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8",
    );
    const res = await ffmpeg(
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listFile,
        "-fps_mode", "cfr",
        "-r", String(m.fps),
        ...ENC_INTERMEDIATE,
        outPath,
      ],
      { timeoutMs: 300_000 },
    );
    commands.push(res.command);
  };

  try {
    await withXfade();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`transition chain failed, assembled on hard cuts (${truncate(msg, 200)})`);
    log.warn("xfade assembly failed; falling back to hard cuts", { error: msg });
    await withCuts();
  }
  return outPath;
}

// ── finishing ────────────────────────────────────────────────────────────────

/**
 * One global pass for the look and the text. Grading the joined timeline rather
 * than each clip is what makes the reel read as a single graded film instead of
 * seven separately treated shots.
 */
async function finish(
  m: RenderManifest,
  videoPath: string,
  audioPath: string,
  outPath: string,
  commands: string[],
  warnings: string[],
  log: Logger,
): Promise<void> {
  const bundle = getBundle(m.style.preset);
  const seed = Number.parseInt(sha256(m.projectId).slice(0, 8), 16) >>> 0;

  const overlayFilters: string[] = [];
  for (const clip of m.clips) {
    for (const o of clip.overlays) {
      // Overlay times are relative to their clip; shift them onto the master timeline.
      overlayFilters.push(
        overlayText({ ...o, atS: round(clip.startS + o.atS, 3) }, { fps: m.fps }),
      );
    }
  }

  const build = (rich: boolean) => {
    const chain: string[] = [];
    if (rich) {
      // The manifest carries the grade so an edit style can shift it without
      // touching the preset; older manifests fall back to the preset's own.
      chain.push(grade(m.style.grade ?? bundle.grade));
      if (m.style.grain > 0.01) chain.push(grain(m.style.grain, seed));
      chain.push(bloom(0.18));
      chain.push(vignette(0.18));
    }
    chain.push(...overlayFilters);
    chain.push("format=yuv420p");
    return `[0:v]${chain.filter(Boolean).join(",")}[vfin]`;
  };

  const attempt = async (rich: boolean) => {
    const res = await ffmpeg(
      [
        "-y",
        "-i", videoPath,
        "-i", audioPath,
        "-filter_complex", build(rich),
        "-map", "[vfin]",
        "-map", "1:a",
        "-c:v", OUTPUT.videoCodec,
        "-preset", OUTPUT.preset,
        "-crf", String(OUTPUT.crf),
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-level", "4.2",
        "-c:a", "copy",
        "-shortest",
        "-movflags", "+faststart",
        "-metadata", `title=${m.title}`,
        "-metadata", "comment=Generated with MUSE. Contains AI-generated content.",
        "-fps_mode", "cfr",
        "-r", String(m.fps),
        outPath,
      ],
      { timeoutMs: 300_000 },
    );
    commands.push(res.command);
  };

  try {
    await attempt(true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`finishing pass failed, exported ungraded (${truncate(msg, 200)})`);
    log.warn("finishing pass failed; exporting without the grade", { error: msg });
    await attempt(false);
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

export interface RenderOptions {
  outPath: string;
  log?: Logger;
  onProgress?: (fraction: number, label: string) => void;
  /** Keep intermediates for debugging instead of deleting them. */
  keepWork?: boolean;
}

/** Render a manifest to a finished MP4. */
export async function renderReel(
  m: RenderManifest,
  opts: RenderOptions,
): Promise<RenderOutcome> {
  const log = opts.log ?? logger({ project_id: m.projectId });
  const work = tmpDir(m.projectId, `compose-${m.specVersion}`);
  const commands: string[] = [];
  const warnings: string[] = [];
  const total = m.clips.length + 3;
  let step = 0;
  const tick = (label: string) => {
    step++;
    opts.onProgress?.(Math.min(0.99, step / total), label);
  };

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });

  const segments: { path: string; durationS: number }[] = [];
  for (const [i, clip] of m.clips.entries()) {
    segments.push(await renderClipSegment(m, clip, i, work, commands, warnings, log));
    tick(`scene ${clip.sceneId}`);
  }

  const audioPath = await buildAudio(m, work, commands, log);
  tick("audio");

  const assembled = await assemble(m, segments, work, commands, warnings, log);
  tick("assembly");

  await finish(m, assembled, audioPath, opts.outPath, commands, warnings, log);
  tick("finishing");

  const info = await probeMedia(opts.outPath);
  const bytes = fs.readFileSync(opts.outPath);

  if (!opts.keepWork) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* a locked intermediate is not worth failing an otherwise good render */
    }
  }

  opts.onProgress?.(1, "done");

  return {
    outputPath: opts.outPath,
    sha256: sha256(bytes),
    durationS: info.durationS,
    width: info.width,
    height: info.height,
    bytes: bytes.length,
    commands,
    warnings,
  };
}

// ── verification ─────────────────────────────────────────────────────────────

/**
 * Inspect a finished reel the way a reviewer would: right shape, right length,
 * real audio, and no black frames where a scene should be. This is the gate that
 * stops a broken export from being presented as a success.
 */
export async function checkReel(
  filePath: string,
  expected: { durationS: number; width: number; height: number },
): Promise<ReelCheck> {
  const issues: string[] = [];
  const info = await probeMedia(filePath);

  if (Math.abs(info.durationS - expected.durationS) > 0.4) {
    issues.push(
      `duration is ${info.durationS.toFixed(2)}s, expected ${expected.durationS.toFixed(2)}s`,
    );
  }
  if (info.width !== expected.width || info.height !== expected.height) {
    issues.push(`dimensions are ${info.width}x${info.height}, expected ${expected.width}x${expected.height}`);
  }
  if (!info.hasVideo) issues.push("no video stream");
  if (!info.hasAudio) issues.push("no audio stream");
  if (info.hasAudio && info.audioDurationS < expected.durationS - 0.6) {
    issues.push(
      `audio is ${info.audioDurationS.toFixed(2)}s, shorter than the ${expected.durationS.toFixed(2)}s picture`,
    );
  }

  // Sample frames across the reel and count those that decode as effectively
  // black. blackdetect reports runs, which is what actually matters: a single
  // dark frame at a dip-to-black transition is intentional, a 1s run is a hole.
  let blackFrames = 0;
  try {
    const res = await ffmpeg(
      [
        "-i", filePath,
        "-vf", "blackdetect=d=0.5:pic_th=0.98:pix_th=0.06",
        "-an",
        "-f", "null",
        "-",
      ],
      { timeoutMs: 120_000 },
    );
    const runs = [...res.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)];
    for (const r of runs) {
      const start = Number(r[1]);
      const end = Number(r[2]);
      // Ignore a dark run in the last half second: that is the intended fade out.
      if (start > expected.durationS - 0.6) continue;
      blackFrames += Math.round((end - start) * info.fps);
      issues.push(`black run from ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
    }
  } catch {
    issues.push("black-frame detection could not run");
  }

  // A silent master is a real failure mode when a mix goes wrong.
  try {
    const res = await ffmpeg(["-i", filePath, "-af", "volumedetect", "-f", "null", "-"], {
      timeoutMs: 120_000,
    });
    const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(res.stderr);
    if (mean && Number(mean[1]) < -50) issues.push(`audio is effectively silent (${mean[1]} dB)`);
  } catch {
    /* volumedetect is a nicety, not a gate */
  }

  return {
    ok: issues.length === 0,
    durationS: info.durationS,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    audioDurationS: info.audioDurationS,
    blackFrames,
    issues,
  };
}

/** Extract a poster frame for the UI and for share cards. */
export async function extractPoster(
  videoPath: string,
  outPath: string,
  atS: number,
): Promise<string> {
  await ffmpeg(
    [
      "-y",
      "-ss", String(round(Math.max(0, atS), 3)),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "3",
      outPath,
    ],
    { timeoutMs: 60_000 },
  );
  return outPath;
}

/** Confirm the toolchain is present and new enough. Used by the doctor script. */
export async function ffmpegVersion(): Promise<{ ffmpeg: string; ffprobe: string; hasFpsMode: boolean }> {
  const v = await run(FFMPEG, ["-version"], { timeoutMs: 20_000, captureStdout: true });
  const p = await run(FFPROBE, ["-version"], { timeoutMs: 20_000, captureStdout: true });
  const first = (s: string) => s.split(/\r?\n/)[0] ?? "";
  // -vsync was removed in ffmpeg 9; confirm the replacement exists before relying on it.
  const help = await run(FFMPEG, ["-hide_banner", "-h", "full"], {
    timeoutMs: 30_000,
    captureStdout: true,
  }).catch(() => null);
  return {
    ffmpeg: first(v.stdout.toString("utf8")),
    ffprobe: first(p.stdout.toString("utf8")),
    hasFpsMode: help ? help.stdout.toString("utf8").includes("fps_mode") : true,
  };
}
