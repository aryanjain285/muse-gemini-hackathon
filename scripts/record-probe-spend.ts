/**
 * Backfill the ledger with the shape-discovery spend.
 *
 * Those calls were made from a standalone probe script before the governor
 * existed, so the ledger would otherwise under-report and the remaining budget
 * would be wrong by the amount already gone. Recording them keeps the ceiling
 * honest. Safe to run more than once: it checks for its own marker first.
 *
 *   npx tsx scripts/record-probe-spend.ts
 */
import { config as loadEnv } from "./load-env";

loadEnv();

import { db } from "../src/lib/db/client";
import { Ledger } from "../src/lib/db/repo";
import { budget } from "../src/lib/models/governor";

const MARKER = "probe-shape-discovery";

const ENTRIES = [
  {
    task: "keyframe",
    model: "gemini-3.1-flash-image",
    unit: "image",
    quantity: 1,
    inputTokens: 117,
    outputTokens: 1514,
    // 1120 image tokens at $60/M plus 394 text tokens, plus the prompt.
    usd: 0.0687,
  },
  {
    task: "music",
    model: "lyria-3-clip-preview",
    unit: "clip",
    quantity: 2,
    inputTokens: 288,
    outputTokens: 848,
    // Two clips at $0.04: one deliberate probe and one accidental during schema
    // discovery, when a request expected to be rejected was fulfilled instead.
    usd: 0.08,
  },
  {
    task: "video",
    model: "veo-3.1-lite-generate-preview",
    unit: "second",
    quantity: 4,
    usd: 0.2,
  },
  {
    task: "director",
    model: "gemini-3.6-flash",
    unit: "tokens",
    quantity: 1145,
    inputTokens: 155,
    outputTokens: 990,
    usd: 0.0053,
  },
];

function main(): void {
  const existing = db()
    .prepare(`SELECT COUNT(*) AS n FROM ledger WHERE request_hash = ?`)
    .get(MARKER) as { n: number };

  if (existing.n > 0) {
    console.log(`already recorded (${existing.n} rows). Nothing to do.`);
    console.log(JSON.stringify(budget(), null, 2));
    return;
  }

  let total = 0;
  for (const e of ENTRIES) {
    Ledger.record({
      projectId: null,
      task: e.task,
      model: e.model,
      unit: e.unit,
      quantity: e.quantity,
      inputTokens: e.inputTokens ?? 0,
      outputTokens: e.outputTokens ?? 0,
      usd: e.usd,
      estimated: true,
      requestHash: MARKER,
    });
    total += e.usd;
    console.log(`  ${e.model.padEnd(32)} $${e.usd.toFixed(4)}`);
  }

  console.log(`\nrecorded $${total.toFixed(4)} of prior spend`);
  const b = budget();
  console.log(
    `budget now: $${b.spentUsd.toFixed(4)} spent of $${b.ceilingUsd.toFixed(2)}, $${b.remainingUsd.toFixed(4)} left`,
  );
}

main();
