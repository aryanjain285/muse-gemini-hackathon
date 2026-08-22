/** Row shapes and the project state machine. */

/**
 * Project lifecycle. RENDERING is a parent state; music and visual progress
 * are tracked per-job rather than on the project, because they run concurrently.
 */
export const PROJECT_STATES = [
  "DRAFT",
  "PREFLIGHT",
  "DIRECTING",
  "STORYBOARDING",
  "RENDERING",
  "QC",
  "REPAIRING",
  "COMPOSING",
  "READY",
  "REVISING",
  "FAILED",
] as const;
export type ProjectStatus = (typeof PROJECT_STATES)[number];

/** Legal transitions. Enforced by Projects.setStatus so no path skips a gate. */
export const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: ["PREFLIGHT", "FAILED"],
  PREFLIGHT: ["DIRECTING", "DRAFT", "FAILED"],
  DIRECTING: ["STORYBOARDING", "FAILED"],
  STORYBOARDING: ["RENDERING", "DIRECTING", "STORYBOARDING", "FAILED"],
  RENDERING: ["QC", "RENDERING", "FAILED"],
  QC: ["REPAIRING", "COMPOSING", "FAILED"],
  REPAIRING: ["QC", "COMPOSING", "FAILED"],
  COMPOSING: ["READY", "FAILED"],
  READY: ["REVISING", "STORYBOARDING", "RENDERING", "COMPOSING", "FAILED"],
  REVISING: ["RENDERING", "COMPOSING", "READY", "FAILED"],
  FAILED: ["DRAFT", "PREFLIGHT", "DIRECTING", "RENDERING", "COMPOSING"],
};

export type ProjectMode = "generated" | "uploaded";

export interface ProjectRow {
  id: string;
  user_id: string;
  title: string;
  mode: ProjectMode;
  status: ProjectStatus;
  preset: string;
  profile: string;
  brief: string;
  consent: number;
  active_spec_version: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type AssetType =
  | "upload_image"
  | "upload_audio"
  | "subject_sheet"
  | "keyframe"
  | "scene_video"
  | "music"
  | "reel"
  | "poster";

export interface AssetRow {
  id: string;
  project_id: string;
  type: AssetType;
  role: string | null;
  uri: string;
  mime: string;
  bytes: number;
  sha256: string;
  metadata_json: string;
  created_at: string;
}

export interface SpecVersionRow {
  id: string;
  project_id: string;
  version: number;
  spec_json: string;
  parent_version: number | null;
  origin: "director" | "patch" | "repair" | "local";
  note: string;
  created_at: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "fallback" | "cancelled";

export interface SceneJobRow {
  id: string;
  project_id: string;
  scene_id: string;
  spec_version: number;
  stage: "keyframe" | "motion";
  model_route: string;
  status: JobStatus;
  attempt: number;
  request_hash: string;
  output_asset_id: string | null;
  fallback_reason: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface MusicJobRow {
  id: string;
  project_id: string;
  spec_version: number;
  model_route: string;
  status: JobStatus;
  attempt: number;
  request_hash: string;
  planned_map: string;
  actual_map: string;
  output_asset_id: string | null;
  fallback_reason: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface QcRow {
  id: string;
  project_id: string;
  asset_id: string;
  scene_id: string;
  critic_version: string;
  scores_json: string;
  decision: "PASS" | "RETRY" | "FALLBACK";
  repair_instruction: string;
  source: "gemini" | "heuristic";
  created_at: string;
}

export interface RenderRow {
  id: string;
  project_id: string;
  spec_version: number;
  manifest_json: string;
  output_asset_id: string | null;
  status: "running" | "done" | "failed";
  duration_s: number | null;
  output_sha256: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface LedgerRow {
  id: string;
  project_id: string | null;
  task: string;
  model: string;
  unit: string;
  quantity: number;
  input_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  usd: number;
  estimated: number;
  cache_hit: number;
  request_hash: string;
  created_at: string;
}

export interface AgentStepRow {
  id: string;
  project_id: string;
  run_id: string;
  seq: number;
  kind: "thought" | "tool_call" | "tool_result" | "message" | "error";
  name: string;
  payload_json: string;
  usd: number;
  created_at: string;
}

export interface AuditRow {
  id: string;
  project_id: string | null;
  trace_id: string | null;
  actor: string;
  action: string;
  payload_hash: string;
  payload_json: string;
  created_at: string;
}
