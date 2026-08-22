/**
 * SQLite schema: one table per entity, plus `ledger` so cost metadata is
 * queryable and the spend ceiling is enforceable, and `jobs` so an interrupted
 * workflow resumes from persisted state after a restart.
 *
 * Kept as a TS string rather than a .sql file so the bundler never has to treat
 * it as an asset.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL DEFAULT 'local',
  title                TEXT NOT NULL DEFAULT 'Untitled reel',
  mode                 TEXT NOT NULL CHECK (mode IN ('generated','uploaded')),
  status               TEXT NOT NULL,
  preset               TEXT NOT NULL,
  profile              TEXT NOT NULL,
  brief                TEXT NOT NULL DEFAULT '',
  consent              INTEGER NOT NULL DEFAULT 0,
  active_spec_version  INTEGER,
  error               TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,          -- upload_image | upload_audio | subject_sheet |
                                        -- keyframe | scene_video | music | reel | poster
  role          TEXT,                   -- subject_primary | subject_secondary | scene id | null
  uri           TEXT NOT NULL,          -- absolute path inside workspace/assets
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, type);
CREATE INDEX IF NOT EXISTS idx_assets_role    ON assets(project_id, role);

CREATE TABLE IF NOT EXISTS spec_versions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  spec_json      TEXT NOT NULL,
  parent_version INTEGER,
  origin         TEXT NOT NULL,          -- director | patch | repair | local
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS scene_jobs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id        TEXT NOT NULL,
  spec_version    INTEGER NOT NULL,
  stage           TEXT NOT NULL,        -- keyframe | motion
  model_route     TEXT NOT NULL,
  status          TEXT NOT NULL,        -- queued | running | done | failed | fallback | cancelled
  attempt         INTEGER NOT NULL DEFAULT 0,
  request_hash    TEXT NOT NULL,
  output_asset_id TEXT REFERENCES assets(id),
  fallback_reason TEXT,
  error           TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scene_jobs_project ON scene_jobs(project_id, scene_id, stage);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_jobs_idem ON scene_jobs(request_hash);

CREATE TABLE IF NOT EXISTS music_jobs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_version    INTEGER NOT NULL,
  model_route     TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 0,
  request_hash    TEXT NOT NULL,
  planned_map     TEXT NOT NULL DEFAULT '{}',
  actual_map      TEXT NOT NULL DEFAULT '{}',
  output_asset_id TEXT REFERENCES assets(id),
  fallback_reason TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_music_jobs_project ON music_jobs(project_id);

CREATE TABLE IF NOT EXISTS qc_results (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id        TEXT NOT NULL,
  scene_id        TEXT NOT NULL,
  critic_version  TEXT NOT NULL,
  scores_json     TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('PASS','RETRY','FALLBACK')),
  repair_instruction TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL,        -- gemini | heuristic
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qc_project ON qc_results(project_id, scene_id);

CREATE TABLE IF NOT EXISTS renders (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_version    INTEGER NOT NULL,
  manifest_json   TEXT NOT NULL,
  output_asset_id TEXT REFERENCES assets(id),
  status          TEXT NOT NULL,
  duration_s      REAL,
  output_sha256   TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_renders_project ON renders(project_id, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  trace_id     TEXT,
  actor        TEXT NOT NULL,           -- user | director | critic | composer | router | system
  action       TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id, created_at);

-- Cost ledger. One row per billable model call, so the governor's ceiling is
-- durable across restarts and the UI can show exactly where the money went.
CREATE TABLE IF NOT EXISTS ledger (
  id             TEXT PRIMARY KEY,
  project_id     TEXT,
  task           TEXT NOT NULL,
  model          TEXT NOT NULL,
  unit           TEXT NOT NULL,         -- tokens | image | second | clip
  quantity       REAL NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  thought_tokens INTEGER NOT NULL DEFAULT 0,
  usd            REAL NOT NULL,
  estimated      INTEGER NOT NULL DEFAULT 0,
  cache_hit      INTEGER NOT NULL DEFAULT 0,
  request_hash   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_project ON ledger(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);

-- Durable job records for the in-process runner, so an interrupted project can
-- be resumed rather than restarted.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL,          -- queued | running | done | failed | cancelled
  attempt       INTEGER NOT NULL DEFAULT 0,
  idempotency   TEXT NOT NULL,
  result_json   TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency);

-- Agent harness transcript: every turn, tool call and result, so the UI can
-- replay the director's reasoning and a run is auditable after the fact.
CREATE TABLE IF NOT EXISTS agent_steps (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,            -- thought | tool_call | tool_result | message | error
  name        TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  usd         REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_run ON agent_steps(project_id, run_id, seq);
`;
