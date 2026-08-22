/**
 * Repositories. Thin, typed, synchronous (better-sqlite3 is sync by design).
 * Nothing above this layer writes SQL.
 */
import path from "node:path";

import { db, nowIso, j, s, tx } from "./client";
import { WORKSPACE } from "@/lib/core/paths";
import { id, hashJson, sha256 } from "@/lib/core/util";
import type {
  AgentStepRow,
  AssetRow,
  AssetType,
  AuditRow,
  JobStatus,
  LedgerRow,
  MusicJobRow,
  ProjectMode,
  ProjectRow,
  ProjectStatus,
  QcRow,
  RenderRow,
  SceneJobRow,
  SpecVersionRow,
} from "./types";
import { TRANSITIONS } from "./types";
import type { DirectorSpec } from "@/lib/spec/directorSpec";

// ── projects ─────────────────────────────────────────────────────────────────

export const Projects = {
  create(input: {
    mode: ProjectMode;
    preset: string;
    profile: string;
    brief?: string;
    title?: string;
  }): ProjectRow {
    const row: ProjectRow = {
      id: id("prj"),
      user_id: "local",
      title: input.title ?? "Untitled reel",
      mode: input.mode,
      status: "DRAFT",
      preset: input.preset,
      profile: input.profile,
      brief: input.brief ?? "",
      consent: 0,
      active_spec_version: null,
      error: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db()
      .prepare(
        `INSERT INTO projects (id,user_id,title,mode,status,preset,profile,brief,consent,active_spec_version,error,created_at,updated_at)
         VALUES (@id,@user_id,@title,@mode,@status,@preset,@profile,@brief,@consent,@active_spec_version,@error,@created_at,@updated_at)`,
      )
      .run(row);
    return row;
  },

  get(projectId: string): ProjectRow | undefined {
    return db().prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as
      | ProjectRow
      | undefined;
  },

  require(projectId: string): ProjectRow {
    const p = Projects.get(projectId);
    if (!p) throw new Error(`project ${projectId} not found`);
    return p;
  },

  list(limit = 40): ProjectRow[] {
    return db()
      .prepare(`SELECT * FROM projects ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ProjectRow[];
  },

  patch(projectId: string, fields: Partial<ProjectRow>): ProjectRow {
    const allowed = [
      "title",
      "mode",
      "preset",
      "profile",
      "brief",
      "consent",
      "active_spec_version",
      "error",
    ] as const;
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: projectId, updated_at: nowIso() };
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = @${k}`);
        params[k] = fields[k];
      }
    }
    if (sets.length > 0) {
      db()
        .prepare(`UPDATE projects SET ${sets.join(", ")}, updated_at = @updated_at WHERE id = @id`)
        .run(params);
    }
    return Projects.require(projectId);
  },

  /**
   * Advance the state machine. Rejects illegal jumps so a bug cannot land a
   * project in COMPOSING without ever having rendered.
   */
  setStatus(projectId: string, next: ProjectStatus, error?: string | null): ProjectRow {
    const cur = Projects.require(projectId);
    if (cur.status !== next && !TRANSITIONS[cur.status].includes(next)) {
      throw new Error(`illegal transition ${cur.status} -> ${next} for ${projectId}`);
    }
    db()
      .prepare(`UPDATE projects SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(next, error ?? null, nowIso(), projectId);
    return Projects.require(projectId);
  },

  /**
   * Move a project to `target` along a legal path, applying each intermediate
   * transition in turn.
   *
   * The agent drives stages in whatever order it judges best — it may score the
   * music before any scene exists, or render one scene from a standing start — so
   * a caller cannot know which state the project is in. Rather than loosening the
   * state machine (which is what makes an impossible state impossible), this walks
   * the shortest sequence of legal transitions to get there.
   */
  advanceTo(projectId: string, target: ProjectStatus): ProjectRow {
    const cur = Projects.require(projectId);
    if (cur.status === target) return cur;

    // Breadth-first over the transition graph: shortest legal route wins.
    const queue: ProjectStatus[][] = [[cur.status]];
    const seen = new Set<ProjectStatus>([cur.status]);
    let path: ProjectStatus[] | null = null;
    while (queue.length > 0 && !path) {
      const route = queue.shift() as ProjectStatus[];
      for (const next of TRANSITIONS[route[route.length - 1]]) {
        if (seen.has(next)) continue;
        const extended = [...route, next];
        if (next === target) {
          path = extended;
          break;
        }
        seen.add(next);
        queue.push(extended);
      }
    }

    if (!path) {
      throw new Error(`no legal path from ${cur.status} to ${target} for ${projectId}`);
    }
    for (const step of path.slice(1)) Projects.setStatus(projectId, step);
    return Projects.require(projectId);
  },

  delete(projectId: string): void {
    db().prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
  },
};

// ── assets ───────────────────────────────────────────────────────────────────

/**
 * Asset paths are stored relative to the workspace and made absolute on the way out.
 *
 * They used to be stored absolute. That made the database unusable anywhere but the exact
 * directory that wrote it: every row pointed at `C:/Users/<someone>/muse/workspace/...`, so
 * cloning the repository to a different path — or a different machine — left all of them
 * pointing at files that are not there. Committing a finished film for somebody else to
 * watch could not work while that was true, which is the opposite of the point.
 *
 * Normalising in this layer rather than at the forty-odd places that read `row.uri` means
 * every caller keeps working unchanged, and a row written by an older build still resolves.
 */
function storeUri(uri: string): string {
  const abs = path.resolve(uri);
  const root = path.resolve(WORKSPACE);
  if (abs === root || abs.startsWith(root + path.sep)) {
    return path.relative(root, abs).split(path.sep).join("/");
  }
  // Outside the workspace entirely. Nothing should write there, so it is kept verbatim
  // rather than silently re-rooted into somewhere it does not belong.
  return uri;
}

function readUri(uri: string): string {
  if (!path.isAbsolute(uri)) return path.join(WORKSPACE, uri);
  // Written by a build that stored absolute paths. Re-root it onto this workspace so a
  // database that has moved still finds its files.
  const slashed = uri.replace(/\\/g, "/");
  const at = slashed.lastIndexOf("/workspace/");
  return at >= 0 ? path.join(WORKSPACE, slashed.slice(at + "/workspace/".length)) : uri;
}

/** Apply `readUri` to a row, or to nothing. */
function resolved<T extends { uri: string } | undefined>(row: T): T {
  return row ? ({ ...row, uri: readUri(row.uri) } as T) : row;
}

export const Assets = {
  create(input: {
    projectId: string;
    type: AssetType;
    role?: string | null;
    uri: string;
    mime: string;
    bytes: number;
    sha256: string;
    metadata?: Record<string, unknown>;
  }): AssetRow {
    const row: AssetRow = {
      id: id("ast"),
      project_id: input.projectId,
      type: input.type,
      role: input.role ?? null,
      uri: storeUri(input.uri),
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      metadata_json: s(input.metadata ?? {}),
      created_at: nowIso(),
    };
    db()
      .prepare(
        `INSERT INTO assets (id,project_id,type,role,uri,mime,bytes,sha256,metadata_json,created_at)
         VALUES (@id,@project_id,@type,@role,@uri,@mime,@bytes,@sha256,@metadata_json,@created_at)`,
      )
      .run(row);
    // Callers get a usable absolute path; the stored one stays portable.
    return resolved(row);
  },

  get(assetId: string): AssetRow | undefined {
    return resolved(
      db().prepare(`SELECT * FROM assets WHERE id = ?`).get(assetId) as AssetRow | undefined,
    );
  },

  byProject(projectId: string, type?: AssetType): AssetRow[] {
    return type
      ? (db()
          .prepare(`SELECT * FROM assets WHERE project_id = ? AND type = ? ORDER BY created_at`)
          .all(projectId, type) as AssetRow[]).map((r) => resolved(r))
      : (db()
          .prepare(`SELECT * FROM assets WHERE project_id = ? ORDER BY created_at`)
          .all(projectId) as AssetRow[]).map((r) => resolved(r));
  },

  byRole(projectId: string, role: string, type?: AssetType): AssetRow | undefined {
    return resolved((
      type
        ? db()
            .prepare(
              `SELECT * FROM assets WHERE project_id = ? AND role = ? AND type = ?
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(projectId, role, type)
        : db()
            .prepare(
              `SELECT * FROM assets WHERE project_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1`,
            )
            .get(projectId, role)
    ) as AssetRow | undefined);
  },

  meta<T = Record<string, unknown>>(a: AssetRow): T {
    return j<T>(a.metadata_json, {} as T);
  },

  setMeta(assetId: string, meta: Record<string, unknown>): void {
    db().prepare(`UPDATE assets SET metadata_json = ? WHERE id = ?`).run(s(meta), assetId);
  },
};

// ── spec versions ────────────────────────────────────────────────────────────

export const Specs = {
  /** Append a new version and make it active. Versions are never mutated. */
  push(input: {
    projectId: string;
    spec: DirectorSpec;
    origin: SpecVersionRow["origin"];
    note?: string;
  }): SpecVersionRow {
    return tx(() => {
      const prev = db()
        .prepare(`SELECT MAX(version) AS v FROM spec_versions WHERE project_id = ?`)
        .get(input.projectId) as { v: number | null };
      const version = (prev?.v ?? 0) + 1;
      const row: SpecVersionRow = {
        id: id("spv"),
        project_id: input.projectId,
        version,
        spec_json: s(input.spec),
        parent_version: prev?.v ?? null,
        origin: input.origin,
        note: input.note ?? "",
        created_at: nowIso(),
      };
      db()
        .prepare(
          `INSERT INTO spec_versions (id,project_id,version,spec_json,parent_version,origin,note,created_at)
           VALUES (@id,@project_id,@version,@spec_json,@parent_version,@origin,@note,@created_at)`,
        )
        .run(row);
      db()
        .prepare(`UPDATE projects SET active_spec_version = ?, updated_at = ? WHERE id = ?`)
        .run(version, nowIso(), input.projectId);
      return row;
    });
  },

  at(projectId: string, version: number): DirectorSpec | undefined {
    const row = db()
      .prepare(`SELECT spec_json FROM spec_versions WHERE project_id = ? AND version = ?`)
      .get(projectId, version) as { spec_json: string } | undefined;
    return row ? (JSON.parse(row.spec_json) as DirectorSpec) : undefined;
  },

  active(projectId: string): { version: number; spec: DirectorSpec } | undefined {
    const p = Projects.get(projectId);
    if (!p?.active_spec_version) return undefined;
    const spec = Specs.at(projectId, p.active_spec_version);
    return spec ? { version: p.active_spec_version, spec } : undefined;
  },

  requireActive(projectId: string): { version: number; spec: DirectorSpec } {
    const a = Specs.active(projectId);
    if (!a) throw new Error(`project ${projectId} has no active DirectorSpec`);
    return a;
  },

  history(projectId: string): SpecVersionRow[] {
    return db()
      .prepare(`SELECT * FROM spec_versions WHERE project_id = ? ORDER BY version`)
      .all(projectId) as SpecVersionRow[];
  },

  /** Restore an earlier version by appending it again. Undo without losing history. */
  revert(projectId: string, toVersion: number): SpecVersionRow {
    const spec = Specs.at(projectId, toVersion);
    if (!spec) throw new Error(`version ${toVersion} not found for ${projectId}`);
    return Specs.push({ projectId, spec, origin: "patch", note: `revert to v${toVersion}` });
  },
};

// ── scene jobs ───────────────────────────────────────────────────────────────

export const SceneJobs = {
  /**
   * Idempotent claim: the same request hash returns the existing row instead of
   * queuing duplicate generation. Every model job carries an idempotency key.
   */
  claim(input: {
    projectId: string;
    sceneId: string;
    specVersion: number;
    stage: "keyframe" | "motion";
    modelRoute: string;
    requestHash: string;
  }): { job: SceneJobRow; fresh: boolean } {
    const existing = db()
      .prepare(`SELECT * FROM scene_jobs WHERE request_hash = ?`)
      .get(input.requestHash) as SceneJobRow | undefined;
    if (existing) return { job: existing, fresh: false };

    const row: SceneJobRow = {
      id: id("sjb"),
      project_id: input.projectId,
      scene_id: input.sceneId,
      spec_version: input.specVersion,
      stage: input.stage,
      model_route: input.modelRoute,
      status: "queued",
      attempt: 0,
      request_hash: input.requestHash,
      output_asset_id: null,
      fallback_reason: null,
      error: null,
      started_at: null,
      finished_at: null,
      created_at: nowIso(),
    };
    db()
      .prepare(
        `INSERT INTO scene_jobs (id,project_id,scene_id,spec_version,stage,model_route,status,attempt,
                                 request_hash,output_asset_id,fallback_reason,error,started_at,finished_at,created_at)
         VALUES (@id,@project_id,@scene_id,@spec_version,@stage,@model_route,@status,@attempt,
                 @request_hash,@output_asset_id,@fallback_reason,@error,@started_at,@finished_at,@created_at)`,
      )
      .run(row);
    return { job: row, fresh: true };
  },

  update(jobId: string, fields: Partial<SceneJobRow>): void {
    const allowed = [
      "status",
      "attempt",
      "model_route",
      "output_asset_id",
      "fallback_reason",
      "error",
      "started_at",
      "finished_at",
    ] as const;
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: jobId };
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = @${k}`);
        params[k] = fields[k];
      }
    }
    if (sets.length === 0) return;
    db().prepare(`UPDATE scene_jobs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  },

  byProject(projectId: string, specVersion?: number): SceneJobRow[] {
    return specVersion === undefined
      ? (db()
          .prepare(`SELECT * FROM scene_jobs WHERE project_id = ? ORDER BY created_at`)
          .all(projectId) as SceneJobRow[])
      : (db()
          .prepare(
            `SELECT * FROM scene_jobs WHERE project_id = ? AND spec_version = ? ORDER BY created_at`,
          )
          .all(projectId, specVersion) as SceneJobRow[]);
  },

  /** Latest job for a scene stage, whatever its status. */
  latest(
    projectId: string,
    sceneId: string,
    stage: "keyframe" | "motion",
  ): SceneJobRow | undefined {
    return db()
      .prepare(
        `SELECT * FROM scene_jobs WHERE project_id = ? AND scene_id = ? AND stage = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, sceneId, stage) as SceneJobRow | undefined;
  },
};

// ── music jobs ───────────────────────────────────────────────────────────────

export const MusicJobs = {
  claim(input: {
    projectId: string;
    specVersion: number;
    modelRoute: string;
    requestHash: string;
    plannedMap: unknown;
  }): { job: MusicJobRow; fresh: boolean } {
    const existing = db()
      .prepare(`SELECT * FROM music_jobs WHERE project_id = ? AND request_hash = ?`)
      .get(input.projectId, input.requestHash) as MusicJobRow | undefined;
    if (existing) return { job: existing, fresh: false };

    const row: MusicJobRow = {
      id: id("mjb"),
      project_id: input.projectId,
      spec_version: input.specVersion,
      model_route: input.modelRoute,
      status: "queued",
      attempt: 0,
      request_hash: input.requestHash,
      planned_map: s(input.plannedMap),
      actual_map: "{}",
      output_asset_id: null,
      fallback_reason: null,
      error: null,
      created_at: nowIso(),
      finished_at: null,
    };
    db()
      .prepare(
        `INSERT INTO music_jobs (id,project_id,spec_version,model_route,status,attempt,request_hash,
                                 planned_map,actual_map,output_asset_id,fallback_reason,error,created_at,finished_at)
         VALUES (@id,@project_id,@spec_version,@model_route,@status,@attempt,@request_hash,
                 @planned_map,@actual_map,@output_asset_id,@fallback_reason,@error,@created_at,@finished_at)`,
      )
      .run(row);
    return { job: row, fresh: true };
  },

  update(jobId: string, fields: Partial<MusicJobRow>): void {
    const allowed = [
      "status",
      "attempt",
      "model_route",
      "actual_map",
      "output_asset_id",
      "fallback_reason",
      "error",
      "finished_at",
    ] as const;
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: jobId };
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = @${k}`);
        params[k] = fields[k];
      }
    }
    if (sets.length === 0) return;
    db().prepare(`UPDATE music_jobs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  },

  latest(projectId: string): MusicJobRow | undefined {
    return db()
      .prepare(`SELECT * FROM music_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(projectId) as MusicJobRow | undefined;
  },
};

// ── qc ───────────────────────────────────────────────────────────────────────

export const Qc = {
  record(input: {
    projectId: string;
    assetId: string;
    sceneId: string;
    criticVersion: string;
    scores: Record<string, number>;
    decision: QcRow["decision"];
    repairInstruction?: string;
    source: QcRow["source"];
  }): QcRow {
    const row: QcRow = {
      id: id("qcr"),
      project_id: input.projectId,
      asset_id: input.assetId,
      scene_id: input.sceneId,
      critic_version: input.criticVersion,
      scores_json: s(input.scores),
      decision: input.decision,
      repair_instruction: input.repairInstruction ?? "",
      source: input.source,
      created_at: nowIso(),
    };
    db()
      .prepare(
        `INSERT INTO qc_results (id,project_id,asset_id,scene_id,critic_version,scores_json,decision,repair_instruction,source,created_at)
         VALUES (@id,@project_id,@asset_id,@scene_id,@critic_version,@scores_json,@decision,@repair_instruction,@source,@created_at)`,
      )
      .run(row);
    return row;
  },

  byProject(projectId: string): QcRow[] {
    return db()
      .prepare(`SELECT * FROM qc_results WHERE project_id = ? ORDER BY created_at`)
      .all(projectId) as QcRow[];
  },

  latestForScene(projectId: string, sceneId: string): QcRow | undefined {
    return db()
      .prepare(
        `SELECT * FROM qc_results WHERE project_id = ? AND scene_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, sceneId) as QcRow | undefined;
  },
};

// ── renders ──────────────────────────────────────────────────────────────────

export const Renders = {
  start(input: { projectId: string; specVersion: number; manifest: unknown }): RenderRow {
    const row: RenderRow = {
      id: id("rnd"),
      project_id: input.projectId,
      spec_version: input.specVersion,
      manifest_json: s(input.manifest),
      output_asset_id: null,
      status: "running",
      duration_s: null,
      output_sha256: null,
      error: null,
      created_at: nowIso(),
      finished_at: null,
    };
    db()
      .prepare(
        `INSERT INTO renders (id,project_id,spec_version,manifest_json,output_asset_id,status,duration_s,output_sha256,error,created_at,finished_at)
         VALUES (@id,@project_id,@spec_version,@manifest_json,@output_asset_id,@status,@duration_s,@output_sha256,@error,@created_at,@finished_at)`,
      )
      .run(row);
    return row;
  },

  finish(
    renderId: string,
    fields: {
      status: RenderRow["status"];
      outputAssetId?: string | null;
      durationS?: number | null;
      outputSha256?: string | null;
      error?: string | null;
      manifest?: unknown;
    },
  ): void {
    db()
      .prepare(
        `UPDATE renders SET status = ?, output_asset_id = ?, duration_s = ?, output_sha256 = ?,
                            error = ?, finished_at = ?,
                            manifest_json = COALESCE(?, manifest_json)
         WHERE id = ?`,
      )
      .run(
        fields.status,
        fields.outputAssetId ?? null,
        fields.durationS ?? null,
        fields.outputSha256 ?? null,
        fields.error ?? null,
        nowIso(),
        fields.manifest === undefined ? null : s(fields.manifest),
        renderId,
      );
  },

  latest(projectId: string): RenderRow | undefined {
    return db()
      .prepare(`SELECT * FROM renders WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(projectId) as RenderRow | undefined;
  },

  latestDone(projectId: string): RenderRow | undefined {
    return db()
      .prepare(
        `SELECT * FROM renders WHERE project_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as RenderRow | undefined;
  },
};

// ── ledger ───────────────────────────────────────────────────────────────────

export const Ledger = {
  record(input: {
    projectId?: string | null;
    task: string;
    model: string;
    unit: string;
    quantity: number;
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    usd: number;
    estimated?: boolean;
    cacheHit?: boolean;
    requestHash: string;
  }): LedgerRow {
    const row: LedgerRow = {
      id: id("led"),
      project_id: input.projectId ?? null,
      task: input.task,
      model: input.model,
      unit: input.unit,
      quantity: input.quantity,
      input_tokens: input.inputTokens ?? 0,
      output_tokens: input.outputTokens ?? 0,
      thought_tokens: input.thoughtTokens ?? 0,
      usd: input.usd,
      estimated: input.estimated ? 1 : 0,
      cache_hit: input.cacheHit ? 1 : 0,
      request_hash: input.requestHash,
      created_at: nowIso(),
    };
    db()
      .prepare(
        `INSERT INTO ledger (id,project_id,task,model,unit,quantity,input_tokens,output_tokens,
                             thought_tokens,usd,estimated,cache_hit,request_hash,created_at)
         VALUES (@id,@project_id,@task,@model,@unit,@quantity,@input_tokens,@output_tokens,
                 @thought_tokens,@usd,@estimated,@cache_hit,@request_hash,@created_at)`,
      )
      .run(row);
    return row;
  },

  /** Lifetime spend across every project. The governor's ceiling checks this. */
  totalUsd(): number {
    const r = db().prepare(`SELECT COALESCE(SUM(usd),0) AS t FROM ledger`).get() as { t: number };
    return r.t;
  },

  projectUsd(projectId: string): number {
    const r = db()
      .prepare(`SELECT COALESCE(SUM(usd),0) AS t FROM ledger WHERE project_id = ?`)
      .get(projectId) as { t: number };
    return r.t;
  },

  byProject(projectId: string): LedgerRow[] {
    return db()
      .prepare(`SELECT * FROM ledger WHERE project_id = ? ORDER BY created_at`)
      .all(projectId) as LedgerRow[];
  },

  /** Spend grouped by model, for the budget panel. */
  byModel(): { model: string; task: string; calls: number; usd: number }[] {
    return db()
      .prepare(
        `SELECT model, task, COUNT(*) AS calls, SUM(usd) AS usd
         FROM ledger GROUP BY model, task ORDER BY usd DESC`,
      )
      .all() as { model: string; task: string; calls: number; usd: number }[];
  },

  recent(limit = 50): LedgerRow[] {
    return db()
      .prepare(`SELECT * FROM ledger ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as LedgerRow[];
  },
};

// ── audit ────────────────────────────────────────────────────────────────────

export const Audit = {
  record(input: {
    projectId?: string | null;
    traceId?: string | null;
    actor: string;
    action: string;
    payload?: unknown;
  }): AuditRow {
    const payload = input.payload ?? {};
    const row: AuditRow = {
      id: id("aud"),
      project_id: input.projectId ?? null,
      trace_id: input.traceId ?? null,
      actor: input.actor,
      action: input.action,
      payload_hash: hashJson(payload),
      payload_json: s(payload),
      created_at: nowIso(),
    };
    db()
      .prepare(
        `INSERT INTO audit_events (id,project_id,trace_id,actor,action,payload_hash,payload_json,created_at)
         VALUES (@id,@project_id,@trace_id,@actor,@action,@payload_hash,@payload_json,@created_at)`,
      )
      .run(row);
    return row;
  },

  byProject(projectId: string, limit = 300): AuditRow[] {
    return db()
      .prepare(`SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at LIMIT ?`)
      .all(projectId, limit) as AuditRow[];
  },
};

// ── agent transcript ─────────────────────────────────────────────────────────

export const AgentSteps = {
  append(input: {
    projectId: string;
    runId: string;
    kind: AgentStepRow["kind"];
    name?: string;
    payload?: unknown;
    usd?: number;
  }): AgentStepRow {
    return tx(() => {
      const prev = db()
        .prepare(`SELECT COALESCE(MAX(seq),0) AS n FROM agent_steps WHERE project_id = ? AND run_id = ?`)
        .get(input.projectId, input.runId) as { n: number };
      const row: AgentStepRow = {
        id: id("stp"),
        project_id: input.projectId,
        run_id: input.runId,
        seq: prev.n + 1,
        kind: input.kind,
        name: input.name ?? "",
        payload_json: s(input.payload ?? {}),
        usd: input.usd ?? 0,
        created_at: nowIso(),
      };
      db()
        .prepare(
          `INSERT INTO agent_steps (id,project_id,run_id,seq,kind,name,payload_json,usd,created_at)
           VALUES (@id,@project_id,@run_id,@seq,@kind,@name,@payload_json,@usd,@created_at)`,
        )
        .run(row);
      return row;
    });
  },

  byRun(projectId: string, runId: string): AgentStepRow[] {
    return db()
      .prepare(`SELECT * FROM agent_steps WHERE project_id = ? AND run_id = ? ORDER BY seq`)
      .all(projectId, runId) as AgentStepRow[];
  },

  latestRun(projectId: string): string | undefined {
    const r = db()
      .prepare(
        `SELECT run_id FROM agent_steps WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as { run_id: string } | undefined;
    return r?.run_id;
  },

  byProject(projectId: string): AgentStepRow[] {
    return db()
      .prepare(`SELECT * FROM agent_steps WHERE project_id = ? ORDER BY created_at`)
      .all(projectId) as AgentStepRow[];
  },
};

// ── durable jobs ─────────────────────────────────────────────────────────────

export const Jobs = {
  claim(input: {
    projectId: string;
    kind: string;
    payload?: unknown;
    idempotency: string;
  }): { row: JobRow; fresh: boolean } {
    const existing = db()
      .prepare(`SELECT * FROM jobs WHERE idempotency = ?`)
      .get(input.idempotency) as JobRow | undefined;
    if (existing) return { row: existing, fresh: false };
    const row: JobRow = {
      id: id("job"),
      project_id: input.projectId,
      kind: input.kind,
      payload_json: s(input.payload ?? {}),
      status: "queued",
      attempt: 0,
      idempotency: input.idempotency,
      result_json: null,
      error: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db()
      .prepare(
        `INSERT INTO jobs (id,project_id,kind,payload_json,status,attempt,idempotency,result_json,error,created_at,updated_at)
         VALUES (@id,@project_id,@kind,@payload_json,@status,@attempt,@idempotency,@result_json,@error,@created_at,@updated_at)`,
      )
      .run(row);
    return { row, fresh: true };
  },

  update(jobId: string, fields: Partial<JobRow>): void {
    const allowed = ["status", "attempt", "result_json", "error"] as const;
    const sets: string[] = ["updated_at = @updated_at"];
    const params: Record<string, unknown> = { id: jobId, updated_at: nowIso() };
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = @${k}`);
        params[k] = fields[k];
      }
    }
    db().prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  },

  byProject(projectId: string): JobRow[] {
    return db()
      .prepare(`SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at`)
      .all(projectId) as JobRow[];
  },

  /** Jobs left mid-flight by a crash. The runner re-queues these on boot. */
  orphans(): JobRow[] {
    return db()
      .prepare(`SELECT * FROM jobs WHERE status = 'running' ORDER BY created_at`)
      .all() as JobRow[];
  },
};

export interface JobRow {
  id: string;
  project_id: string;
  kind: string;
  payload_json: string;
  status: JobStatus;
  attempt: number;
  idempotency: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Re-exported so callers get one import for hashing content-addressed assets. */
export { sha256 };
