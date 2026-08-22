# Costs

MUSE is built to be pointed at a real API key with a small balance. This documents
exactly what is spent, how it is bounded, and how to spend as little as possible.

Prices verified against `ai.google.dev/gemini-api/docs/pricing` on 2026-08-18 and
recorded in `src/lib/core/config.ts`. Nothing outside that file may hardcode a price.

---

## Unit prices

| Model | Unit | Price |
|---|---|---|
| `gemini-3.6-flash` / `3.7-flash` | per 1M tokens | $0.75 in, $3.75 out |
| `gemini-3.1-flash-image` | per 1M output tokens | $60.00 (≈$0.045 at 0.5K, $0.067 at 1K) |
| `gemini-3-pro-image` | per 1M output tokens | $120.00 (≈$0.134 at 1K/2K) |
| `veo-3.1-lite` | per second | $0.05 (720p) |
| `veo-3.1-fast` | per second | $0.12 (1080p) |
| `veo-3.1` | per second | $0.40 |
| `lyria-3-clip` | per clip | $0.04 |
| `lyria-3-pro` | per clip | $0.08 |

### Two details that matter

**Image models bill by modality.** A 1K image reports ~1120 IMAGE tokens plus a few
hundred text tokens, and only the image tokens bill at $60/M. Folding them together
overstates cost by about a third, so the governor reads
`candidatesTokensDetails` and prices each modality separately.

**Thinking tokens bill at the output rate.** On Gemini 3 Flash, a trivial prompt
spends about 540 thinking tokens by default and about 50 at `thinkingLevel: "low"`.
That single setting is the largest lever on text cost in the system. Only the
Director runs at `high`, because the quality of the plan governs everything
downstream.

---

## Profiles

A profile decides which of the seven tasks use a real model. Set with
`MUSE_PROFILE`, or per project in the UI.

| Profile | Real tasks | Est. per reel |
|---|---|---|
| `local` | none | **$0.0000** |
| `wiring` | director, vision, critic, patch | **$0.099** |
| `standard` | + keyframe, music | **$0.422** |
| `hero` | + video (one Veo shot) | **$0.722** |
| `max` | Nano Banana Pro, Veo Fast 1080p, Lyria Pro | **$1.971** |

**Measured, not estimated:**

| Profile | Projected | Actual | Wall clock |
|---|---|---|---|
| `wiring` | $0.099 | $0.024 | ~2 min |
| `standard` | $0.422 | $0.393 | ~9 min |

Both come in under projection because the estimate deliberately assumes the worst
case, which is the right direction for a ceiling to err in.

Check any of this yourself:

```bash
npx tsx scripts/doctor.ts        # per-profile projection against your balance
curl localhost:3939/api/budget   # the ledger
```

---

## How spend is bounded

### A hard ceiling

`MUSE_BUDGET_USD` (default `5.00`) is a refusal, not a warning. Every call reserves
its estimate against `ceiling − spent − in-flight` before it runs, so two concurrent
calls cannot both fit the last cent. A refusal throws a `budget` error, which the
router treats as a signal to fall back to the local engine — never to retry.

Spend is persisted in SQLite, so the ceiling survives restarts.

### A per-call cap

The agent harness carries its own `maxUsdPerRun` (default $1.50) on top of the global
ceiling, and a tool marked `spend` is refused outright once that run's budget is
exhausted. An unbounded agent pointed at paid generation is a way to lose a balance.

### A content-addressed cache

Every response is stored under a hash of `{model, task, payload, template version}`.
An identical request never reaches the network again, and the ledger records the hit
at $0.00 so the saving is visible rather than invisible.

This is why re-running a demo is free, and why **you should warm the cache before
presenting**:

```bash
MUSE_PROFILE=standard npx tsx scripts/verify-e2e.ts --profile standard --keep
```

Changing a prompt bumps the template bundle version, which retires the affected cache
entries. Do not edit prompts after warming.

---

## Where the money actually goes

For one `standard` reel:

| Stage | Calls | Share |
|---|---|---|
| Keyframes | 6–7 images | **~75%** |
| Music | 1 clip | ~10% |
| Director | 1–2 text calls | ~7% |
| Critic | 0–7 vision calls | ~6% |
| Vision | 1 call | ~1% |

Keyframes dominate, and `hero` doubles the total for a single 4–6 s clip. Two
consequences shape the design:

- **Deterministic camera work over a strong still is often the better shot anyway.**
  A slow push on a beautiful painting reads as cinema; four seconds of a model
  guessing what happens next is a lottery. Generated motion is spent only on the
  drop.
- **The critic does not run a model on deterministic output.** The local engine does
  not read the prompt, so scoring prompt adherence against it returns near zero every
  time — truthfully and uselessly. Measured directly: 22 retries, no usable signal.
  Deterministic clips are judged by measurement, which is free.

---

## Spending as little as possible

1. **Develop in `local`.** It is the default, it needs no network, and a full run is
   under a minute.
2. **Verify wiring in `wiring`.** ~$0.025 proves the Director, vision, critic and
   patch paths against the live API.
3. **Warm `standard` once**, then demo from cache for free.
4. **Keep `MUSE_CACHE=1`.** Setting it to `0` disables replay and every run pays.
5. **Reuse the project.** Re-running the same project is free; a new project with a
   different sentence pays again, because the request hash changes.
6. **Leave `hero` off** unless the Veo shot is the thing you are showing.

---

## Reference: what the probes cost

The three live API shapes were bought once and recorded in
`workspace/reference/shapes/`, so no future work has to pay to rediscover them:

| Probe | Cost |
|---|---|
| One 1K keyframe | $0.0687 |
| Two Lyria clips | $0.0800 |
| One 4 s Veo-lite clip | $0.2000 |
| Text probes | $0.0053 |
| **Total** | **$0.3540** |

That spend is backfilled into the ledger by `scripts/record-probe-spend.ts`, so the
remaining balance the app reports is honest rather than flattering.
