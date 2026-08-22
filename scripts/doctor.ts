/**
 * Pre-flight for the machine, not for a project.
 *
 * Run this before a demo. It checks the toolchain, the database, the fonts the
 * composer draws titles with, the cache, and — without spending anything — whether
 * the configured models are actually reachable on this key.
 *
 *   npx tsx scripts/doctor.ts
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "./load-env";

loadEnv();

import { FALLBACKS, PROFILES, PROFILE_NAMES, readEnv, PRICES } from "../src/lib/core/config";
import { PATHS, ensureDirs } from "../src/lib/core/paths";
import { db } from "../src/lib/db/client";
import { Ledger } from "../src/lib/db/repo";
import { cache } from "../src/lib/models/cache";
import { budget } from "../src/lib/models/governor";
import { hasApiKey, listModels } from "../src/lib/models/gemini";
import { ffmpegVersion, probeMedia } from "../src/lib/compose/ffmpeg";
import { estimateProfile } from "../src/lib/server/views";
import { listBundles } from "../src/lib/templates/bundles";
import { skillNames } from "../src/lib/agent/skills";

const OK = "  ok  ";
const WARN = " warn ";
const FAIL = " fail ";

let failures = 0;
let warnings = 0;

function line(state: string, label: string, detail = ""): void {
  if (state === FAIL) failures++;
  if (state === WARN) warnings++;
  console.log(`[${state}] ${label.padEnd(30)} ${detail}`);
}

function section(name: string): void {
  console.log(`\n${name}\n${"─".repeat(name.length)}`);
}

async function main(): Promise<void> {
  console.log("MUSE doctor\n===========");

  // ── toolchain ──────────────────────────────────────────────────────────────
  section("toolchain");
  line(OK, "node", process.version);

  try {
    const v = await ffmpegVersion();
    line(OK, "ffmpeg", v.ffmpeg.slice(0, 60));
    line(OK, "ffprobe", v.ffprobe.slice(0, 60));
    // -vsync was removed in ffmpeg 9; the composer relies on -fps_mode instead.
    line(v.hasFpsMode ? OK : FAIL, "-fps_mode support", v.hasFpsMode ? "present" : "missing");
  } catch (e) {
    line(FAIL, "ffmpeg", e instanceof Error ? e.message : String(e));
  }

  // The composer draws every title with drawtext, which needs a real font file.
  section("fonts");
  const candidates = [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/consola.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
  ];
  const found = candidates.filter((f) => fs.existsSync(f));
  line(
    found.length > 0 ? OK : FAIL,
    "title font",
    found.length > 0 ? found[0] : "no usable font found; titles will not draw",
  );

  // ── storage ────────────────────────────────────────────────────────────────
  section("storage");
  ensureDirs();
  for (const [name, p] of Object.entries(PATHS)) {
    if (p.endsWith(".db")) continue;
    line(fs.existsSync(p) ? OK : FAIL, name, p);
  }
  try {
    const handle = db();
    const tables = handle
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    line(OK, "database", `${tables.length} tables at ${path.basename(PATHS.db)}`);
    const expected = [
      "agent_steps",
      "assets",
      "audit_events",
      "jobs",
      "ledger",
      "music_jobs",
      "projects",
      "qc_results",
      "renders",
      "scene_jobs",
      "spec_versions",
    ];
    const missing = expected.filter((t) => !tables.some((r) => r.name === t));
    line(missing.length === 0 ? OK : FAIL, "schema", missing.length === 0 ? "complete" : `missing ${missing.join(", ")}`);
  } catch (e) {
    line(FAIL, "database", e instanceof Error ? e.message : String(e));
  }

  const stats = cache.stats();
  line(
    OK,
    "response cache",
    `${stats.entries} entries, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB, ${readEnv().cacheEnabled ? "enabled" : "disabled"}`,
  );

  // ── templates and skills ───────────────────────────────────────────────────
  section("content");
  const bundles = listBundles();
  line(bundles.length >= 4 ? OK : WARN, "presets", bundles.map((b) => b.id).join(", "));
  for (const b of bundles) {
    const covered = b.beats.reduce((acc, x) => acc + (x.endS - x.atS), 0);
    const heroes = b.beats.filter((x) => x.purpose === "hero_drop").length;
    const contiguous = b.beats.every((x, i) => i === 0 || Math.abs(x.atS - b.beats[i - 1].endS) < 0.001);
    const good = heroes === 1 && contiguous && b.beats.length >= 5 && b.beats.length <= 7;
    line(good ? OK : FAIL, `  ${b.id}`, `${b.beats.length} beats, ${covered.toFixed(1)}s, ${heroes} hero`);
  }
  line(OK, "agent skills", skillNames().join(", "));

  // ── budget ─────────────────────────────────────────────────────────────────
  section("budget");
  const b = budget();
  line(
    b.remainingUsd > 0 ? OK : WARN,
    "ceiling",
    `$${b.spentUsd.toFixed(4)} spent of $${b.ceilingUsd.toFixed(2)}, $${b.remainingUsd.toFixed(4)} left`,
  );
  const byModel = Ledger.byModel();
  if (byModel.length > 0) {
    for (const r of byModel.slice(0, 8)) {
      line(OK, `  ${r.model}`, `${r.task} · ${r.calls} calls · $${r.usd.toFixed(4)}`);
    }
  } else {
    line(OK, "  ledger", "no spend recorded yet");
  }

  section("profiles");
  for (const name of PROFILE_NAMES) {
    const est = estimateProfile(name);
    const real = Object.entries(PROFILES[name].routes).filter(([, t]) => t.kind === "gemini").length;
    line(
      est.totalUsd <= b.remainingUsd || est.totalUsd === 0 ? OK : WARN,
      `  ${name}`,
      `$${est.totalUsd.toFixed(4)} per reel · ${real}/7 tasks on a real model`,
    );
  }

  // ── models ─────────────────────────────────────────────────────────────────
  section("models");
  if (!hasApiKey()) {
    line(
      WARN,
      "GEMINI_API_KEY",
      "not set; every stage runs on the local engine (this is a supported path)",
    );
  } else {
    line(OK, "GEMINI_API_KEY", "present");
    try {
      // Listing models is free and proves both the key and the network.
      const models = await listModels();
      line(OK, "api reachable", `${models.length} models visible`);
      // Both the configured routes and every fallback chain: a retired model in a
      // chain is invisible until the preferred model has a bad minute.
      const needed = new Set<string>();
      for (const name of PROFILE_NAMES) {
        for (const target of Object.values(PROFILES[name].routes)) {
          if (target.kind === "gemini") needed.add(target.model);
        }
      }
      for (const chain of Object.values(FALLBACKS)) {
        for (const model of chain) needed.add(model);
      }
      for (const m of [...needed].sort()) {
        const present = models.some((x) => x.name === m);
        const priced = Boolean(PRICES[m]);
        line(
          present && priced ? OK : present ? WARN : FAIL,
          `  ${m}`,
          present ? (priced ? "available and priced" : "available but has no price entry") : "NOT available on this key",
        );
      }
    } catch (e) {
      line(FAIL, "api reachable", e instanceof Error ? e.message : String(e));
    }
  }

  // ── recovery material ──────────────────────────────────────────────────────
  section("recovery material");
  const ref = path.join(PATHS.workspace, "reference");
  const wanted = [
    { file: "keyframe-probe-0.jpg", what: "reference keyframe" },
    { file: "soundtrack-probe-0.mp3", what: "reference score" },
    { file: "hero-probe-uri-0.mp4", what: "reference hero shot" },
  ];
  for (const w of wanted) {
    const p = path.join(ref, w.file);
    if (!fs.existsSync(p)) {
      line(WARN, `  ${w.what}`, "absent (optional)");
      continue;
    }
    try {
      const info = await probeMedia(p);
      line(
        OK,
        `  ${w.what}`,
        `${info.width}x${info.height}${info.durationS ? ` · ${info.durationS.toFixed(2)}s` : ""}`,
      );
    } catch {
      line(WARN, `  ${w.what}`, "present but unreadable");
    }
  }

  console.log(
    `\n${failures === 0 ? "READY" : "NOT READY"} — ${failures} failure(s), ${warnings} warning(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("doctor crashed:", e);
  process.exit(1);
});
