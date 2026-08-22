/**
 * Make the gallery a set of films that all play, anywhere.
 *
 * Three faults conspired to put fifteen dead entries in a cloned gallery.
 *
 * The films' media lives in `workspace/assets` and `workspace/renders`, which are ignored because
 * they hold every attempt ever made — so a committed row resolved on the machine that produced it
 * and nowhere else. Pruning to the one bundled film fixed that and left a gallery of one, which
 * is not a showcase.
 *
 * And the database was committed from a stale snapshot: SQLite runs in WAL mode here, the `-wal`
 * sidecar is ignored, and `git add workspace/muse.db` therefore committed the main file without
 * the pending pages. The remote said sixteen films, then five, while this machine said one. That
 * is the root cause, and `--checkpoint` is the fix: fold the log back into the file before it is
 * committed.
 *
 * What this does:
 *   - keeps the named projects and deletes the rest, files included
 *   - regenerates a poster for any film missing one, from a frame of its own reel
 *   - drops asset rows whose files are gone, so nothing can 404
 *   - checkpoints the write-ahead log, so the committed file is the file
 *
 *   npx tsx scripts/curate-gallery.ts --keep prj_a,prj_b --checkpoint
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { db } from "../src/lib/db/client";
import { Assets, Projects } from "../src/lib/db/repo";
import { PATHS } from "../src/lib/core/paths";
import { purgeProjectAssets } from "../src/lib/services/assets";
import { exec as runFfmpeg } from "../src/lib/visual/ffmpegExec";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const doCheckpoint = argv.includes("--checkpoint");
const keepArg = argv.find((a) => a.startsWith("--keep="));
const KEEP = new Set((keepArg ? keepArg.split("=")[1] : "").split(",").filter(Boolean));

/** Children before parents: renders, scene_jobs and music_jobs all point into assets. */
const CHILDREN_FIRST = [
  "agent_steps",
  "audit_events",
  "ledger",
  "jobs",
  "qc_results",
  "renders",
  "scene_jobs",
  "music_jobs",
  "spec_versions",
  "assets",
] as const;

function columnsOf(table: string): Set<string> {
  const rows = db().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function removeProject(id: string): void {
  purgeProjectAssets(id);
  const tx = db().transaction(() => {
    for (const table of CHILDREN_FIRST) {
      if (!columnsOf(table).has("project_id")) continue;
      db().prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
    }
    Projects.delete(id);
  });
  tx();
}

async function main(): Promise<void> {
  if (KEEP.size > 0) {
    const all = Projects.list(200);
    const drop = all.filter((p) => !KEEP.has(p.id));
    console.log(`  keeping ${KEEP.size}, removing ${drop.length}`);
    for (const p of drop) {
      console.log(`    - ${p.id}  ${p.title}`);
      if (!dry) removeProject(p.id);
    }
  }

  // ── a poster for every film ───────────────────────────────────────────────
  //
  // Posters were collateral of an earlier prune: they live under the project's asset directory,
  // which was deleted wholesale. A frame of the film is a truthful poster for it, and costs
  // nothing, so the gallery does not have to show a placeholder where a picture belongs.
  for (const project of Projects.list(200)) {
    const reel = Assets.byRole(project.id, "final", "reel");
    if (!reel || !fs.existsSync(reel.uri)) continue;
    const poster = Assets.byRole(project.id, "final", "poster");
    if (poster && fs.existsSync(poster.uri)) continue;

    const dir = path.join(PATHS.assets, project.id);
    const out = path.join(dir, "poster-recovered.jpg");
    console.log(`  poster for ${project.title}: from its own reel`);
    if (dry) continue;
    fs.mkdirSync(dir, { recursive: true });
    // Two seconds in: past any opening fade, before the first cut on most films.
    await runFfmpeg("ffmpeg", ["-y", "-ss", "2", "-i", reel.uri, "-frames:v", "1", "-q:v", "3", out]);
    if (!fs.existsSync(out)) continue;
    const bytes = fs.readFileSync(out);
    Assets.create({
      projectId: project.id,
      type: "poster",
      role: "final",
      uri: out,
      mime: "image/jpeg",
      bytes: bytes.length,
      sha256: (await import("../src/lib/core/util")).sha256(bytes),
      metadata: { recoveredFrom: path.basename(reel.uri), atS: 2 },
    });
  }

  // ── one reel and one poster per role, the newest ──────────────────────────
  //
  // A film re-cut five times keeps five reel rows and five poster rows. Only the newest is ever
  // resolved, and bundling the rest would mean committing a quarter of a gigabyte of superseded
  // video to satisfy rows nothing reads. The older ones are dropped so the database promises
  // exactly what the bundle carries — the files stay on disk, they are simply no longer claimed.
  let stale = 0;
  for (const project of Projects.list(200)) {
    for (const type of ["reel", "poster"] as const) {
      const rows = Assets.byProject(project.id, type);
      const newestByRole = new Map<string, string>();
      for (const row of rows) newestByRole.set(row.role ?? "", row.id); // byProject is oldest-first
      for (const row of rows) {
        if (newestByRole.get(row.role ?? "") === row.id) continue;
        stale++;
        if (dry) continue;
        const tx = db().transaction(() => {
          for (const table of ["renders", "scene_jobs", "music_jobs"] as const) {
            if (!columnsOf(table).has("output_asset_id")) continue;
            db().prepare(`UPDATE ${table} SET output_asset_id = NULL WHERE output_asset_id = ?`).run(row.id);
          }
          db().prepare(`DELETE FROM qc_results WHERE asset_id = ?`).run(row.id);
          db().prepare(`DELETE FROM assets WHERE id = ?`).run(row.id);
        });
        tx();
      }
    }
  }
  console.log(`  dropped ${stale} superseded reel/poster row(s)`);

  // ── nothing may point at a file that is not there ─────────────────────────
  let dropped = 0;
  for (const project of Projects.list(200)) {
    for (const asset of Assets.byProject(project.id)) {
      if (fs.existsSync(asset.uri)) continue;
      dropped++;
      if (dry) continue;
      const tx = db().transaction(() => {
        for (const table of ["renders", "scene_jobs", "music_jobs"] as const) {
          if (!columnsOf(table).has("output_asset_id")) continue;
          db()
            .prepare(`UPDATE ${table} SET output_asset_id = NULL WHERE output_asset_id = ?`)
            .run(asset.id);
        }
        db().prepare(`DELETE FROM qc_results WHERE asset_id = ?`).run(asset.id);
        db().prepare(`DELETE FROM assets WHERE id = ?`).run(asset.id);
      });
      tx();
    }
  }
  console.log(`  dropped ${dropped} asset row(s) whose file is missing`);

  if (doCheckpoint && !dry) {
    // The whole reason the committed database disagreed with this one.
    const before = fs.existsSync(`${PATHS.db}-wal`) ? fs.statSync(`${PATHS.db}-wal`).size : 0;
    db().pragma("wal_checkpoint(TRUNCATE)");
    const after = fs.existsSync(`${PATHS.db}-wal`) ? fs.statSync(`${PATHS.db}-wal`).size : 0;
    console.log(
      `  write-ahead log folded into the database: ${(before / 1048576).toFixed(2)} MB -> ${(
        after / 1048576
      ).toFixed(2)} MB`,
    );
  }

  const left = Projects.list(200);
  console.log(`\n  ${left.length} film(s):`);
  for (const p of left) {
    const reel = Assets.byRole(p.id, "final", "reel");
    const poster = Assets.byRole(p.id, "final", "poster");
    console.log(
      `    ${p.title.padEnd(26)} reel ${reel && fs.existsSync(reel.uri) ? "ok " : "NO "} poster ${
        poster && fs.existsSync(poster.uri) ? "ok" : "NO"
      }`,
    );
  }
  console.log(dry ? "  dry run, nothing written" : "  done");
}

void main();
