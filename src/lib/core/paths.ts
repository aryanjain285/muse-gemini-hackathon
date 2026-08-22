/**
 * Every runtime artefact lives under `workspace/`, which is gitignored. The
 * layout mirrors what a bucket would hold, so the asset store can be swapped
 * for GCS or S3 without touching callers.
 */
import fs from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();
export const WORKSPACE = path.join(ROOT, "workspace");

export const PATHS = {
  workspace: WORKSPACE,
  db: path.join(WORKSPACE, "muse.db"),
  /** Uploaded and generated assets, addressed by project. */
  assets: path.join(WORKSPACE, "assets"),
  /** Persistent memory records + their original media. Metadata is JSON-only. */
  memories: path.join(WORKSPACE, "memories"),
  /** Model response cache, keyed by request hash. Makes re-runs free. */
  cache: path.join(WORKSPACE, "cache"),
  /** Final MP4s plus their render manifests. */
  renders: path.join(WORKSPACE, "renders"),
  /** Intermediate ffmpeg products for one render; safe to delete. */
  tmp: path.join(WORKSPACE, "tmp"),
  /** Structured JSONL logs. */
  logs: path.join(WORKSPACE, "logs"),
} as const;

export function ensureDirs(): void {
  for (const p of Object.values(PATHS)) {
    if (p.endsWith(".db")) continue;
    fs.mkdirSync(p, { recursive: true });
  }
}

export function projectDir(projectId: string): string {
  const p = path.join(PATHS.assets, projectId);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function tmpDir(projectId: string, tag = "render"): string {
  const p = path.join(PATHS.tmp, `${projectId}-${tag}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * Directories the media route may serve, by the name that appears in the URL.
 * Memory JSON itself is never served; only the media directory sits under this
 * protected route. The records remain server-local files.
 */
const SERVED_ROOTS: Record<string, string> = {
  assets: PATHS.assets,
  renders: PATHS.renders,
  memories: path.join(PATHS.memories, "media"),
};

/** True when `abs` is the root itself or sits inside it. */
function within(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * Turn an absolute workspace path into the URL the browser fetches it from.
 * Media is never served from `public/`; it goes through a route handler, so
 * signed, short-lived access can be layered on later.
 */
export function assetUrl(absPath: string): string {
  const abs = path.resolve(absPath);
  for (const [name, dir] of Object.entries(SERVED_ROOTS)) {
    const root = path.resolve(dir);
    if (within(abs, root)) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      return `/api/assets/${name}/${rel}`;
    }
  }
  return `/api/assets/unserved/${path.basename(abs)}`;
}

/**
 * Resolve a request path to a file, or null. The first segment names the root and
 * the remainder must stay inside it, so neither `..` nor an absolute path escapes.
 */
export function resolveAssetPath(relative: string): string | null {
  const [name, ...rest] = relative.split("/").filter((seg) => seg.length > 0);
  const dir = name ? SERVED_ROOTS[name] : undefined;
  if (!dir || rest.length === 0) return null;
  const root = path.resolve(dir);
  const abs = path.resolve(root, rest.join("/"));
  return within(abs, root) ? abs : null;
}
