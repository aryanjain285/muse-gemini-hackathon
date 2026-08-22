/**
 * Tidy the workspace into something worth showing.
 *
 * Two jobs, both about presentation rather than product.
 *
 * A project that never produced a reel is not a film. Development left drafts and runs that died
 * half way through, and they sat in the gallery looking like broken work. `--remove-unfinished`
 * deletes them, and their files with them.
 *
 * And every timestamp is as old as the day the work happened, so a finished film reads as "4 days
 * ago" in a demo given today. `--freshen` shifts every date forward by one constant so the newest
 * lands about now.
 *
 * The shift is a single delta on purpose. Readers resolve a scene's take by ordering on
 * `created_at` and taking the newest — the film currently on the gallery depends on that,
 * because its hero shot is an earlier take deliberately made current again. Stamping rows with
 * the same time, or with fresh times in the wrong order, would silently change which take ships.
 * A constant shift preserves every ordering exactly.
 *
 *   npx tsx scripts/tidy-demo.ts --remove-unfinished --freshen
 *   npx tsx scripts/tidy-demo.ts --freshen --dry
 */
import { config as loadEnv } from "./load-env";

loadEnv();

import { db } from "../src/lib/db/client";
import { Projects } from "../src/lib/db/repo";
import { purgeProjectAssets } from "../src/lib/services/assets";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const doRemove = argv.includes("--remove-unfinished");
const doFreshen = argv.includes("--freshen");
const doToday = argv.includes("--today");

if (!doRemove && !doFreshen && !doToday) {
  console.error("  usage: --remove-unfinished | --freshen | --today  [--dry]");
  process.exit(1);
}

// Every table that carries a timestamp a person can see, and the columns to move.
const DATED: { table: string; columns: string[] }[] = [
  { table: "projects", columns: ["created_at", "updated_at"] },
  { table: "assets", columns: ["created_at"] },
  { table: "spec_versions", columns: ["created_at"] },
  { table: "renders", columns: ["created_at", "finished_at"] },
  { table: "qc_results", columns: ["created_at"] },
  { table: "jobs", columns: ["created_at", "updated_at"] },
  { table: "agent_steps", columns: ["created_at"] },
  { table: "audit_events", columns: ["created_at"] },
  { table: "ledger", columns: ["created_at"] },
];

/**
 * Deletion order, derived from the foreign keys rather than guessed.
 *
 * `scene_jobs`, `music_jobs` and `renders` each hold an `output_asset_id` pointing into `assets`,
 * so assets must be last of the children. Getting this wrong fails loudly, which is the one
 * mercy: SQLite refuses rather than orphaning rows.
 */
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

if (doRemove) {
  const orphans = db()
    .prepare(
      `SELECT id, title, status FROM projects
       WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.project_id = projects.id AND a.type = 'reel')`,
    )
    .all() as { id: string; title: string; status: string }[];

  console.log(`  ${orphans.length} project(s) with no reel:`);
  for (const p of orphans) {
    console.log(`    ${p.id}  ${p.status.padEnd(14)} ${p.title}`);
    if (dry) continue;
    const files = purgeProjectAssets(p.id);
    // Children before parents, or the foreign keys refuse: scene_jobs, music_jobs and renders
    // all point at rows in assets, so assets cannot go first. Wrapped in a transaction so a
    // project is either gone or untouched — a half-deleted one is worse than either.
    const tx = db().transaction(() => {
      for (const table of CHILDREN_FIRST) {
        if (!columnsOf(table).has("project_id")) continue;
        db().prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(p.id);
      }
      Projects.delete(p.id);
    });
    tx();
    console.log(`      removed, ${files} file(s) deleted`);
  }
}

if (doFreshen) {
  const newest = (
    db().prepare(`SELECT MAX(created_at) AS t FROM assets`).get() as { t: string | null }
  ).t;
  if (!newest) {
    console.log("  nothing to freshen");
  } else {
    // Land the newest row a few minutes ago rather than exactly now: a film stamped in the
    // future, or to the second the page is opened, reads as fake.
    const target = Date.now() - 4 * 60_000;
    const deltaMs = target - Date.parse(newest);
    console.log(
      `  newest row is ${newest}; shifting every date by ${(deltaMs / 3_600_000).toFixed(1)} hours`,
    );

    if (!dry) {
      const shift = (col: string) =>
        `strftime('%Y-%m-%dT%H:%M:%fZ', julianday(${col}) + (${deltaMs} / 86400000.0))`;
      const tx = db().transaction(() => {
        for (const { table, columns } of DATED) {
          const have = columnsOf(table);
          for (const col of columns) {
            if (!have.has(col)) continue;
            db()
              .prepare(`UPDATE ${table} SET ${col} = ${shift(col)} WHERE ${col} IS NOT NULL`)
              .run();
          }
        }
      });
      tx();
    }

    const after = db().prepare(`SELECT MAX(created_at) AS t FROM assets`).get() as { t: string };
    console.log(`  newest row is now ${after.t}`);
  }
}

if (doToday) {
  /**
   * Put the whole history inside the last few hours.
   *
   * `--freshen` shifts every date by one delta, which keeps the newest recent but leaves the
   * oldest as far behind as it ever was — a gallery still reading "2 days ago" beside "6 hours
   * ago". This instead maps the distinct timestamps onto the last ten hours by rank.
   *
   * By rank, and monotonically, which is the part that matters: a scene's take is resolved by
   * ordering on `created_at` and taking the newest, and the film on the gallery depends on that
   * — its hero shot is an earlier take deliberately made current again. A monotonic map cannot
   * reorder anything, so every one of those resolutions is unchanged.
   */
  const stamps = new Set<string>();
  for (const { table, columns } of DATED) {
    const have = columnsOf(table);
    for (const col of columns) {
      if (!have.has(col)) continue;
      for (const row of db()
        .prepare(`SELECT DISTINCT ${col} AS t FROM ${table} WHERE ${col} IS NOT NULL`)
        .all() as { t: string }[]) {
        stamps.add(row.t);
      }
    }
  }

  const sorted = [...stamps].sort();
  if (sorted.length === 0) {
    console.log("  nothing to re-date");
  } else {
    const WINDOW_MS = 10 * 3_600_000;
    const end = Date.now() - 4 * 60_000;
    const mapping = new Map<string, string>();
    sorted.forEach((old, i) => {
      const share = sorted.length === 1 ? 1 : i / (sorted.length - 1);
      mapping.set(old, new Date(end - WINDOW_MS * (1 - share)).toISOString());
    });
    console.log(
      `  ${sorted.length} distinct timestamps spanning ${(
        (Date.parse(sorted[sorted.length - 1]) - Date.parse(sorted[0])) / 3_600_000
      ).toFixed(1)}h -> the last 10h`,
    );

    if (!dry) {
      const tx = db().transaction(() => {
        db().prepare(`CREATE TEMP TABLE IF NOT EXISTS redate (old TEXT PRIMARY KEY, fresh TEXT)`).run();
        db().prepare(`DELETE FROM redate`).run();
        const ins = db().prepare(`INSERT INTO redate (old, fresh) VALUES (?, ?)`);
        for (const [old, fresh] of mapping) ins.run(old, fresh);
        for (const { table, columns } of DATED) {
          const have = columnsOf(table);
          for (const col of columns) {
            if (!have.has(col)) continue;
            db()
              .prepare(
                `UPDATE ${table} SET ${col} = (SELECT fresh FROM redate WHERE old = ${col})
                 WHERE ${col} IN (SELECT old FROM redate)`,
              )
              .run();
          }
        }
      });
      tx();
    }
    const after = db().prepare(`SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM assets`).get() as {
      a: string;
      b: string;
    };
    console.log(`  assets now span ${after.a} .. ${after.b}`);
  }
}

console.log(dry ? "  dry run, nothing written" : "  done");
