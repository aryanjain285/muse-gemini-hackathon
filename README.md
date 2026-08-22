<div align="center">

<img src="src/app/icon.svg" width="76" height="76" alt="MUSE">

# MUSE

**AI Music Video Director**

Five photos and one sentence become a 30-second vertical film, with a score composed
around its story and every cut landed on the music.

`Gemini 3.6 Flash` · `Nano Banana 2` · `Lyria 3` · `Veo 3.1` · `FFmpeg`

</div>

---

Most generative video tools expose the model: write a prompt, wait, receive a clip.
Consistency, pacing and musical synchronisation are then fragile, because nothing in
the system holds a view of the film as a whole.

MUSE inverts that. Gemini writes one **timestamped plan** governing narrative, music,
imagery, motion and editing. Music and visuals generate **concurrently from that same
plan**, a multimodal critic scores every shot, and a **deterministic composer**
assembles the reel.

## The idea

A generative music model treats requested timestamps as *intent*, not instruction.

We asked Lyria for a drop at 15 seconds. Here is what it actually returned, measured:

| | |
|---|---|
| Requested drop | 15.0 s |
| **Loudest instant in the returned audio** | **21.4 s** |
| Loudest sustained window | 18.2 – 24.2 s |
| Requested tempo / measured tempo | 118 / 120.25 BPM |

That gap is not a defect — it is the correct behaviour of a model told the *kind* of
track to make. But any tool that assumes the timestamp was obeyed produces a reel
that feels subtly wrong and nobody can say why.

So MUSE never assumes. It decodes whatever comes back, measures where the accents
actually are, and moves the cuts onto them:

| Scene boundaries snapped to measured accents | mean error | worst |
|---|---|---|
| Before | 596 ms | 2000 ms |
| **After** | **10 ms** | **16 ms** |

Measured on a `standard` run with a real Gemini Director and a real Lyria score: all
six cuts found a beat and moved onto it, the largest correction being 200 ms.

Models propose. Code decides where the cut lands.

## Robustness

**Every stage has a deterministic fallback, so no model failure can prevent an export.**

| Stage | Real route | Fallback |
|---|---|---|
| Director | `gemini-3.6-flash` structured output | beat-sheet director from the template |
| Photo understanding | `gemini-3.6-flash` vision | real pixel measurement |
| Keyframes | `gemini-3.1-flash-image` | stylise the user's photo, or compose procedurally |
| Motion | `veo-3.1-lite` image-to-video | deterministic camera work + 2.5D parallax |
| Score | `lyria-3-clip` | a real subtractive/FM synthesiser |
| Critic | `gemini-3.6-flash` multimodal | measured frames: motion, black, sharpness, framing |
| Transitions | — | always deterministic; degrades to hard cuts |

Run it with no API key, no network and no budget and it still produces a finished,
watchable, correctly-timed reel. That is not a degraded mode bolted on afterwards —
it is what makes the system demonstrable.

## Cost control

Generation is metered against a **hard ceiling** the governor refuses to cross, and
every response is **cached by request hash**, so an identical re-run costs **$0.00**.

| Profile | What's real | Est. | Measured | Wall clock |
|---|---|---|---|---|
| `local` | nothing — full deterministic engine | $0.00 | **$0.00** | ~50 s |
| `wiring` | director, vision, critic, patch | $0.099 | **$0.024** | ~2 min |
| `standard` | + keyframes + Lyria score | $0.422 | **$0.393** | ~9 min |
| `hero` | + one Veo hero shot | $0.722 | | |
| `max` | Nano Banana Pro + Veo Fast 1080p | $1.971 | | |

A first `standard` run takes about nine minutes, most of it waiting on seven real
keyframes. Re-running the same project is instant and free, which is why the demo
runbook warms the cache first.

The UI shows the estimate *before* you commit and a live spend meter after. See
[docs/COSTS.md](docs/COSTS.md).

---

## Quick start

```bash
npm install
npm run setup                     # put the committed films and memories where the app expects them
npm run dev                       # http://localhost:3939
```

After a `git pull`, run `npm run sync` instead of `setup`. The database is both committed and
written to by the running app, so git will not overwrite your copy and the new films never arrive —
sixteen where the repository says seventeen, with nothing on screen to explain it. `sync` resets the
committed data files to the current commit, removes the write-ahead log that belonged to the
database it replaced, and restores the media. Stop `npm run dev` first.

That is the whole first run, on any machine. Everything the demo shows is committed: the
finished film, the shots it was cut from, the memory library with its photographs and metadata,
and the model-response cache — so the gallery is full, the sketch studio answers in under a
second, and asking MUSE for a film about those photographs returns the one it already made.
None of it needs a key, a network or a budget, and re-generating the same film costs nothing
because every response it would ask for is already in `workspace/cache/`.

Sixteen finished films travel with the repository — every one of their reels and posters is
committed, and the featured film brings its whole shot set so the studio page opens. That is about
350 MB of video, which makes the clone large and the demo complete; the alternative was a gallery
of broken thumbnails on any machine but the one that made them.

Verified by cloning to an empty directory and booting it: all six pages answering, every film
playing, and the ledger unchanged afterwards — nothing was spent to show any of it.

To make your own:

```bash
cp .env.example .env.local        # optional: add GEMINI_API_KEY
npx tsx scripts/doctor.ts         # check the machine
npx tsx scripts/verify-e2e.ts     # full pipeline, $0.00, no network
```

The model response cache is committed too, so regenerating the demo film replays every
director, keyframe, score and video call for nothing instead of about $2.20. Asset paths
are stored relative to `workspace/`, so a clone at any path resolves its own files; run
`npm run portable` if you are bringing a database from an older build.

`ffmpeg` and `ffprobe` must be on `PATH`, version 9 or later. (Note `-vsync` was
removed in ffmpeg 9; this codebase uses `-fps_mode`.)

Without a key everything runs on the local engine. With a key, `MUSE_PROFILE` chooses
how much is real and `MUSE_BUDGET_USD` caps lifetime spend.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | studio at `localhost:3939` |
| `npm test` | 450 tests |
| `npm run build` | production build |
| `npm run demo:restore` | put the committed demo film back where the database expects it |
| `npm run demo:bundle <id>` | assemble a different project as the committed demo |
| `npm run portable` | rewrite absolute asset paths in an older database |
| `npx tsx scripts/doctor.ts` | toolchain, schema, fonts, models, budget |
| `npx tsx scripts/verify-e2e.ts` | drive a real project and measure the MP4 |
| `… --profile wiring --keep` | same, with the real Director and critic |
| `… --agent` | same, driven by the director agent |

---

## What it does

**Directs, rather than generates.** One `DirectorSpec` — validated, versioned,
repairable — describes the whole reel: a style bible, a music plan, an event timeline
and 5–7 contiguous scenes. Everything downstream fills it in.

**Opens on your photograph, and turns it into the film.** The first shot starts on the
picture you actually uploaded, holds it long enough to be read as a photograph, then
becomes the stylised world — in one continuous shot rather than across a cut. The merge
is driven by the brightness of the original, so the paint arrives where the light already
was and spreads into the shadows. No model call: two inputs and a per-plane blend.

**Watches what it made.** Every other review judges one shot. A screening samples the
finished reel and asks for notes on the *edit* — pacing, coverage, whether the payoff
lands. Each note must name a change MUSE can already make, so it arrives with the button
that answers it. A note you cannot act on is advice, and a button that cannot work is
worse than no button.

**Takes the photos you have.** An iPhone writes HEIC, which shares a container with MP4;
unhandled, a camera roll is rejected for not being images. HEIC is converted once at
ingest so nothing downstream needs to know.

**Covers the film.** A director thinks in coverage, not just in content, so shot size
is a field the Director fills in and not prose buried in a description. Placement
belongs to the size: a wide puts the subject small and low, an extreme close-up runs
the features across the full width, an insert has nobody in it at all. Before this was
enforceable, four shots in seven came back as the same standing figure in the same
landscape — the Director had asked for a close-up and a panoramic in prose, and the
image model honoured it once.

```
before   close  wide  wide    close   wide  wide    wide
after    close  wide  medium  xclose  full  detail  wide
```

Never three shots running at one distance, always one close enough to read a face and
one wide enough to say where we are. Coverage is fixed by moving a size, never by
reordering or rewriting a shot.

**Re-cuts for nothing.** Generation is the slow, expensive, uncertain part;
composition is deterministic code over assets that already exist. Because MUSE keeps
those apart, a finished film can be read again as often as you like — hard cuts on
strong beats only, long dissolves with heavier grain — at no cost. Measured across
four re-cuts of one film: spend before `$0.393137`, spend after `$0.393137`.

**Runs music and visuals in parallel.** They share only the timeline, so they are
genuinely independent branches rather than interleaved for show.

**Scores every shot, and overrules the model where measurement can see the truth.**
Frames are sampled and measured for duration, motion, exposure, sharpness and framing;
the model is consulted on identity, continuity and adherence — the things measurement
cannot see. A model verdict that contradicts a hard measurement loses.

**Takes direction, bounded.** An instruction becomes one of fifteen named
operations, and the UI tells you the blast radius before you commit:

```
"make the drop more magical"  →  event_intensity(drop, 1.0)
                                 music_energy(+0.5)
                                 add_motif(s05, "burst of light and swirling particles")
                              →  regenerates 1 scene and the soundtrack

"make it all nighttime"       →  touches 6 of 6 scenes — refused, needs confirmation
```

Every version is retained, so undo is a revert.

**Has a real agent harness.** A tool registry with typed schemas and zod validation,
five versioned craft guides, and *two policies over one registry* — a real Gemini
function-calling loop, and a deterministic local walk. The console shows the same
stream of tool calls either way, so adding a key changes who is deciding rather than
what is possible. Bounded by turns, tool calls and spend.

---

## Architecture

```
                    ┌──────────────────┐
                    │  Studio (Next.js)│  SSE progress, 9:16 preview
                    └────────┬─────────┘
                    ┌────────▼─────────┐
                    │  Route handlers  │  validated, idempotent
                    └────────┬─────────┘
                    ┌────────▼─────────┐
                    │  Durable runner  │  resumable, cancellable, deadline-aware
                    └────────┬─────────┘
                    ┌────────▼─────────┐
                    │ Gemini Director  │  → DirectorSpec (validated, versioned)
                    └────────┬─────────┘
          ┌──────────────────▼──────────────────┐
          │            Model Router             │  cache → governor → fallback → local
          └───┬──────────────┬──────────────┬───┘
              ▼              ▼              ▼
          Lyria          Image models   Video models      ← concurrent
              └──────────────┼──────────────┘
                    ┌────────▼─────────┐
                    │  Gemini Critic   │  scores + one repair instruction
                    └────────┬─────────┘
                    ┌────────▼─────────┐
                    │ FFmpeg Composer  │  cuts on measured accents
                    └────────┬─────────┘
                             ▼
                     1080×1920 H.264 MP4
```

```
src/lib/
  core/       config (models, prices, profiles, limits), paths, logging, errors
  db/         SQLite schema, typed repositories, cost ledger
  spec/       DirectorSpec schema, validation, repair, bounded patches
  models/     Gemini transport, adapters, router, cost governor, response cache
  music/      synthesiser, FFT analysis, planner, reconciliation
  visual/     deterministic render engine
  compose/    manifest planning, filter library, composer, verification
  templates/  four versioned preset bundles and every prompt
  agent/      tool registry, craft skills, director loop
  services/   asset, vision, director, visual, music, critic, pipeline
  jobs/       event bus, durable runner
  server/     bootstrap, HTTP helpers, view models
```

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it works and why, with the
measurements behind each claim
**[docs/DEMO.md](docs/DEMO.md)** — the runbook, including failure drills
**[docs/COSTS.md](docs/COSTS.md)** — unit prices, profiles, how spend is bounded
**[docs/API.md](docs/API.md)** — every route

---

## Verified, not asserted

`npx tsx scripts/verify-e2e.ts` drives a real project and then measures the file:

```
[  ok  ] scene count in band            7 scenes (5-7)
[  ok  ] exactly one hero scene         s05
[  ok  ] scenes contiguous, no gaps     0 to 30s
[  ok  ] every scene has a clip         7/7
[  ok  ] score covers the reel          30.00s via local at 118 BPM
[  ok  ] beats reconciled               8 snapped, none missing
[  ok  ] verdicts                       PASS=7
[  ok  ] duration matches the plan      30.00s vs planned 30.00s
[  ok  ] no black holes in the timeline clean
[  ok  ] cuts land on musical anchors   mean 1ms, worst 7ms off across 6 cuts
[  ok  ] local profile spent nothing    $0.000000

PASS — 39/39 checks passed
```

A run against a real key, on the brief `the summer we drove to the coast and
everything felt endless`:

```
READY in 1448s                7 stills at 1K, all on the primary model, no fallbacks
score                         lyria-3-clip at 117.75 BPM, 8 beats matched
reel                          1080x1920, 30.00s, audio yes, clean
cuts                          6/6 on the beat, worst 17ms, one at 0ms
coverage                      close, wide, insert, medium, full, close, wide
review                        PASS=7
spend                         $0.5527
```

The insert is the shot to look at: a folded paper map on a dashboard with nobody in
frame. It exists because the Director had to commit to a shot size, and choosing one
changed what the shot is *of*.

397 tests cover the FFT against a known sine, onset detection against a synthetic
click track, every ffmpeg filter and transition by actually rendering them, WAV
container and level correctness, spec validation and repair, and design-token
integrity.

---

## Safety and privacy

- Uploads validated against **real file signatures**, never the declared MIME type
- Consent required before any generation, enforced server-side
- Assets served through a handler that refuses paths escaping the asset root
- Logs redact data URIs, base64 and anything key-shaped; keys never leave the server
- Output labelled AI-generated in the UI and in MP4 metadata
- Nothing used for training; deleting a project removes its files

## Non-goals

Full-length videos. Frame-perfect lip sync. Unrestricted prompting. A general NLE.
The 30-second constraint is deliberate: it concentrates quality, reduces failure
surface, fits how vertical video is actually watched, and keeps the whole creative
loop demonstrable.

---

<div align="center">

Built for **Build with Gemini × Lorong AI** — Most Creative Gemini Hack

</div>
