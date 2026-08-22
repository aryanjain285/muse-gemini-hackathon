/**
 * Vision service: reads the user's uploads and extracts the facts the rest of the
 * pipeline needs — who the subject is, which traits must not drift, and whether
 * the photographs are usable at all.
 *
 * This runs before the Director so the plan is written about the actual photos
 * rather than about a generic person, and before generation so an unusable upload
 * is caught at preflight instead of after money has been spent.
 */
import { LIMITS } from "@/lib/core/config";
import type { Profile } from "@/lib/core/config";
import { clamp, truncate } from "@/lib/core/util";
import { logger } from "@/lib/core/logger";
import { generateJson, inlinePart } from "@/lib/models/adapters";
import { jsonCodec, route } from "@/lib/models/router";
import { visionPrompt } from "@/lib/templates/prompts";
import { probeImage } from "@/lib/visual/localRender";
import { sha256 } from "@/lib/core/util";

export interface SubjectRead {
  role: "subject_primary" | "subject_secondary";
  /** One sentence a prompt can use verbatim. */
  description: string;
  /** Traits that must survive every scene: hair silhouette, glasses, and so on. */
  immutable_traits: string[];
  wardrobe: string;
  /** 0..1 confidence that this image works as an identity reference. */
  suitability: number;
  /** Which upload index this subject came from. */
  source_index: number;
  /**
   * How many people are visible in that photograph.
   *
   * A group entry describes several people in one sentence, so the description alone cannot
   * say how many there are — and a model asked for "him with his parents" produced four
   * figures. The count is what stops it inventing one.
   */
  people_visible: number;
}

export interface VisionRead {
  subjects: SubjectRead[];
  /** Setting ideas the photographs suggest, fed to the Director. */
  scene_hints: string[];
  /** Colour terms observed in the uploads, used to bias the style bible. */
  palette_hint: string[];
  usable: boolean;
  /** Anything the user should know before spending on generation. */
  issues: string[];
}

/**
 * Response schema for the vision pass. Declared here rather than in the template
 * bundle because it is a system contract, not creative direction.
 */
const VISION_SCHEMA = {
  type: "OBJECT",
  required: ["subjects", "scene_hints", "palette_hint", "usable", "issues"],
  propertyOrdering: ["subjects", "scene_hints", "palette_hint", "usable", "issues"],
  properties: {
    subjects: {
      type: "ARRAY",
      maxItems: 2,
      items: {
        type: "OBJECT",
        required: [
          "role",
          "description",
          "immutable_traits",
          "wardrobe",
          "suitability",
          "source_index",
          "people_visible",
        ],
        propertyOrdering: [
          "role",
          "description",
          "immutable_traits",
          "wardrobe",
          "suitability",
          "source_index",
          "people_visible",
        ],
        properties: {
          role: { type: "STRING", enum: ["subject_primary", "subject_secondary"] },
          description: {
            type: "STRING",
            description: "One sentence describing the person or subject, usable inside an image prompt.",
          },
          immutable_traits: {
            type: "ARRAY",
            maxItems: 8,
            items: { type: "STRING" },
            description: "Traits that must not change between scenes.",
          },
          wardrobe: { type: "STRING" },
          suitability: { type: "NUMBER", description: "0 to 1." },
          source_index: { type: "INTEGER", description: "Index of the upload this came from." },
          people_visible: {
            type: "INTEGER",
            description:
              "How many people are visible in that photograph. Count them; do not estimate.",
          },
        },
      },
    },
    scene_hints: { type: "ARRAY", maxItems: 6, items: { type: "STRING" } },
    palette_hint: { type: "ARRAY", maxItems: 6, items: { type: "STRING" } },
    usable: { type: "BOOLEAN" },
    issues: { type: "ARRAY", maxItems: 6, items: { type: "STRING" } },
  },
} as const;

export interface VisionInput {
  projectId: string;
  uploads: { path: string; mime: string; bytes: Buffer }[];
  profile?: Profile;
  deadlineAt?: number;
}

export interface VisionOutcome extends VisionRead {
  route: string;
  usd: number;
  cached: boolean;
  fallbackReason?: string;
  /** Per-upload measurements, always produced locally. */
  measurements: {
    index: number;
    width: number;
    height: number;
    sharpness: number;
    brightness: number;
    palette: string[];
  }[];
}

/**
 * Local read: real measurements plus a conservative description. Enough for the
 * pipeline to proceed and for preflight to reject genuinely bad uploads, without
 * pretending to recognise anyone.
 */
async function localRead(input: VisionInput): Promise<VisionRead> {
  const measured = await Promise.all(
    input.uploads.map(async (u, i) => ({ i, probe: await probeImage(u.path).catch(() => null) })),
  );
  const usableShots = measured.filter((m) => m.probe && m.probe.sharpness > 0);
  const palette = new Set<string>();
  for (const m of usableShots) for (const c of m.probe?.palette ?? []) palette.add(c);

  const issues: string[] = [];
  for (const m of measured) {
    if (!m.probe) {
      issues.push(`upload ${m.i + 1} could not be read`);
      continue;
    }
    if (m.probe.width < 512 || m.probe.height < 512) {
      issues.push(`upload ${m.i + 1} is small (${m.probe.width}x${m.probe.height})`);
    }
    if (m.probe.brightness < 0.08) issues.push(`upload ${m.i + 1} is very dark`);
    if (m.probe.clipping > 0.35) issues.push(`upload ${m.i + 1} is heavily blown out`);
  }

  const best = [...usableShots].sort(
    (a, b) => (b.probe?.sharpness ?? 0) - (a.probe?.sharpness ?? 0),
  );

  const subjects: SubjectRead[] = [];
  if (best[0]) {
    subjects.push({
      role: "subject_primary",
      description: "the person shown in the reference photograph",
      immutable_traits: ["hair silhouette", "face shape", "overall build"],
      wardrobe: "the clothing visible in the reference photograph",
      suitability: clamp((best[0].probe?.sharpness ?? 0) / 40, 0.2, 0.9),
      source_index: best[0].i,
      // A local probe measures sharpness and colour; it cannot count faces. One is what it
      // can honestly claim, and claiming more would put invented people in frame.
      people_visible: 1,
    });
  }
  if (best[1]) {
    subjects.push({
      role: "subject_secondary",
      description: "the second person shown in the reference photographs",
      immutable_traits: ["hair silhouette", "face shape"],
      wardrobe: "the clothing visible in the second reference photograph",
      suitability: clamp((best[1].probe?.sharpness ?? 0) / 40, 0.2, 0.85),
      source_index: best[1].i,
      people_visible: 1,
    });
  }

  return {
    subjects,
    scene_hints: [],
    palette_hint: [...palette].slice(0, 6),
    usable: subjects.length > 0 || input.uploads.length === 0,
    issues,
  };
}

/** Read the uploads. Never throws; a failed model call degrades to measurement. */
export async function readUploads(input: VisionInput): Promise<VisionOutcome> {
  const log = logger({ project_id: input.projectId });

  const measurements = (
    await Promise.all(
      input.uploads.map(async (u, index) => {
        const probe = await probeImage(u.path).catch(() => null);
        return probe
          ? {
              index,
              width: probe.width,
              height: probe.height,
              sharpness: probe.sharpness,
              brightness: probe.brightness,
              palette: probe.palette,
            }
          : null;
      }),
    )
  ).filter((m): m is NonNullable<typeof m> => m !== null);

  if (input.uploads.length === 0) {
    const local = await localRead(input);
    return { ...local, route: "local", usd: 0, cached: false, measurements };
  }

  const { system, user } = visionPrompt(input.uploads.length);

  const result = await route<VisionRead>({
    task: "vision",
    projectId: input.projectId,
    // Hash the actual bytes so re-reading identical uploads is free.
    identity: { system, user, images: input.uploads.map((u) => sha256(u.bytes)) },
    hint: {
      inputTokens: 400 + input.uploads.length * 1100,
      outputTokens: 700,
      thoughtTokens: 200,
    },
    codec: jsonCodec<VisionRead>(),
    profile: input.profile,
    deadlineAt: input.deadlineAt,
    logger: log,
    real: async (model) => {
      const out = await generateJson<VisionRead>({
        model,
        system,
        parts: [
          ...input.uploads.map((u) => inlinePart(u.bytes, u.mime)),
          { text: user },
        ],
        schema: VISION_SCHEMA,
        thinking: "low",
        maxOutputTokens: 2048,
        temperature: 0.3,
        timeoutMs: LIMITS.timeoutMs.vision,
      });
      return { value: sanitize(out.value, input.uploads.length), usage: out.usage, modelVersion: out.modelVersion };
    },
    local: async () => localRead(input),
  });

  return {
    ...result.value,
    route: result.route,
    usd: result.usd,
    cached: result.cached,
    fallbackReason: result.fallbackReason,
    measurements,
  };
}

/** Clamp a model read into the shape the pipeline relies on. */
function sanitize(read: VisionRead, uploadCount: number): VisionRead {
  // The person in the first photograph is the primary, whoever the model happened to
  // mention first.
  //
  // This used to take the model's own ordering, and with a family album in the set it
  // named somebody else first — so a film made from a man's photographs came back about "a
  // young South Asian woman", and the deliberately chosen first upload was ignored. That
  // upload is not arbitrary: it is also the photograph the opening transformation starts
  // on, so it is the one the person picked to be recognised by.
  //
  // Sorting happens before the cap, or the subject from the first photograph can be sliced
  // away before being considered at all.
  const subjects = (read.subjects ?? [])
    .filter((s) => s && typeof s.description === "string" && s.description.trim().length > 0)
    .map((s, i) => ({
      description: truncate(s.description.trim(), 220),
      immutable_traits: (s.immutable_traits ?? []).map((t) => truncate(String(t), 60)).slice(0, 8),
      wardrobe: truncate(String(s.wardrobe ?? ""), 160),
      suitability: clamp(Number(s.suitability ?? 0.5), 0, 1),
      source_index: clamp(Math.round(Number(s.source_index ?? i)), 0, Math.max(0, uploadCount - 1)),
      // Clamped to something a frame can hold. Zero would mean a photograph of nobody, which
      // contradicts having found a subject in it.
      people_visible: clamp(Math.round(Number(s.people_visible ?? 1)), 1, 8),
    }))
    .sort((a, b) => a.source_index - b.source_index)
    .slice(0, 2)
    .map((s, i) => ({
      role: i === 0 ? ("subject_primary" as const) : ("subject_secondary" as const),
      ...s,
    }));

  return {
    subjects,
    scene_hints: (read.scene_hints ?? []).map((h) => truncate(String(h), 160)).slice(0, 6),
    palette_hint: (read.palette_hint ?? []).map((h) => truncate(String(h), 40)).slice(0, 6),
    usable: read.usable !== false && subjects.length > 0,
    issues: (read.issues ?? []).map((h) => truncate(String(h), 160)).slice(0, 6),
  };
}

/** Preflight gate: is this project safe to spend money on? */
export function preflightVerdict(
  read: VisionOutcome,
  uploadCount: number,
): { ok: boolean; blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (uploadCount > LIMITS.maxUploads) {
    blocking.push(`${uploadCount} uploads; the limit is ${LIMITS.maxUploads}`);
  }
  if (uploadCount > 0 && read.measurements.length === 0) {
    blocking.push("none of the uploads could be decoded");
  }
  if (uploadCount > 0 && read.subjects.length === 0) {
    warnings.push("no clear subject was found; scenes will lean on the environment");
  }
  for (const issue of read.issues) warnings.push(issue);

  const weak = read.measurements.filter((m) => m.width < 512 || m.height < 512);
  if (weak.length === read.measurements.length && read.measurements.length > 0) {
    warnings.push("every upload is low resolution; expect softer keyframes");
  }

  return { ok: blocking.length === 0, blocking, warnings };
}
