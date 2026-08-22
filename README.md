<div align="center">

<img src="src/app/icon.svg" width="76" height="76" alt="MUSE">

# MUSE

### Nobody remembers in stills.

Hand MUSE the photographs you already have. It casts the faces, writes the story,
composes a score for it, and lands every cut on the beat.

`Gemini 3.7 Flash` · `Gemini 3.1 Flash Image` · `Lyria 3` · `Veo 3.1` · `FFmpeg`

</div>

---

## Two films from the same five photographs

One winter trip. Five phone photographs. Nothing changed between these but the theme —
same faces, same mountain, same story, and nothing about one reads like the other.

<div align="center">

<table>
<tr>
<td width="50%" align="center">
<img src="docs/preview/gangtok-pink-dawn-prj_v0b74ybbt2ki-v5.gif" width="300" alt="Gangtok Pink Dawn — the family under a rose-pink Kanchenjunga, in gouache">
<br><b>Gangtok Pink Dawn</b><br>
<sub>gouache · 124 BPM · <a href="workspace/demo/gangtok-pink-dawn-prj_v0b74ybbt2ki-v5.mp4">the full film, with sound</a></sub>
</td>
<td width="50%" align="center">
<img src="docs/preview/pink-dawn-over-gangtok-prj_qwa5biy5b46y-v1.gif" width="300" alt="Pink Dawn Over Gangtok — the same family, cel-shaded in magenta and cyan">
<br><b>Pink Dawn Over Gangtok</b><br>
<sub>neon anime · 152 BPM · <a href="workspace/demo/files/renders/pink-dawn-over-gangtok-prj_qwa5biy5b46y-v1.mp4">the full film, with sound</a></sub>
</td>
</tr>
</table>

<sub>Both loops are the same moment of the same trip. The previews are silent; the films are not.</sub>

</div>

| | **Gangtok Pink Dawn** | **Pink Dawn Over Gangtok** |
|---|---|---|
| look | loose gouache, visible brush strokes | cel-shaded anime, hard ink outlines, speed lines |
| palette | warm rose, cold valley blue | saturated magenta, electric cyan, indigo ground |
| score | 124 BPM, written for it | 152 BPM, distorted saw lead and gated drums |
| shots | 7, three with generated motion | 6, four with generated motion |
| cuts | 6, landed on measured onsets | 5, landed on measured onsets |
| master | −1.2 dBFS, no clipping | −1.1 dBFS, no clipping |

Both are committed. `npm run setup && npm run dev` and they play — no key, no network,
no budget.

## The vision

Everyone is carrying thousands of photographs of the best days of their life, and doing nothing
with them. They sit in a roll nobody scrolls back through, sorted by date, described by nothing.
The moment is in there — the cold, the waiting, the light finally arriving — and a still frame is
the one thing that cannot carry it.

The tools that promise to help ask you to become a director. Write a prompt, pick a model, wait,
receive a clip, try again. What comes back is generically beautiful and about nobody: the faces
drift between shots, the pacing has no relationship to the music, and the people in it are not
your people.

**MUSE takes the other side of that.** You bring what you already have and say one true sentence
about it. It decides what the film is: which moments carry it, in what order, how long each is
held, what it should sound like, and where every cut falls. Then it makes that film, watches it
back, and fixes what it got wrong — and if a shot comes back beautiful but wrong about who is in
it, it throws the beautiful one away.

The bet is that the interesting part of this technology is not generation. Generation is a
commodity and getting cheaper every month. The interesting part is **judgement**: a system that
holds a view of the whole film, knows what it was trying to do, and can tell when it has failed.

That is what a director is. Not a model — a decision-maker with taste and a deadline.

## Where it goes

A film today. A film in any voice you like. And then the same engine pointed at the rest of it:
a year of photographs instead of five, a wedding, a child growing up, a trip somebody is not
coming back from. The plan is a document, so it can be edited by asking. The score is composed
per film, so it can be re-composed. The theme is a variable, so the same memory can be a
watercolour for your mother and neon for your friends.

The photographs are already taken. Nobody has to become a director.

## Every modality, on the same plan

This is not one model behind a prompt box. It is four, coordinated by a document.

| | model | what it actually does |
|---|---|---|
| **see** | Gemini 3.7 Flash | reads the photographs — who is in them, what must not drift between shots, how many faces are in frame |
| **think** | Gemini 3.7 Flash | writes one timestamped plan: shots, shot sizes, camera, transitions, musical events |
| **draw** | Gemini 3.1 Flash Image | a keyframe for every shot, from the photographs and the plan |
| **hear** | Lyria 3 | an original score composed for *this* plan, not a library track |
| **move** | Veo 3.1 | animates the approved keyframe, never a bare prompt |
| **judge** | Gemini 3.7 Flash | scores every finished shot against the photographs it came from |
| **talk** | Gemini 3.7 Flash | Ask MUSE, grounded so it cannot invent a memory you do not have |

Text in, images in, images out, audio out, video out, and structured JSON at every
boundary so the pieces can be checked rather than hoped about.

## What you can do with it

**A memory library.** Photographs with metadata a model can search — who, where, the mood,
and the note you wrote yourself. That note is treated as the truest sentence available and
is quoted back to you.

**Ask MUSE.** A conversation about your own photographs. Grounded on the records, and
instructed never to invent one: asked for beach photographs of a mountain trip, it names
the five mountain ones instead of inventing a beach. When it recognises a film it has
already cut from exactly those photographs, it hands you the film instead of making
another.

**The film pipeline.** Vision → director → score → keyframes → motion → quality control →
compose. Four presets, five render modes, four edit styles, and a screening room where
MUSE watches the film it just made and says what it would change.

**Any voice you like.** Four presets, and the theme is a variable rather than a label: the same
five photographs came back as loose gouache at 124 BPM and as cel-shaded neon anime at 152, each
with its own palette, camera grammar and score, and the same faces in both.

## Judgement, not just generation

Quality control is not a rubber stamp. The critic is sent the original photographs and
counts the people in frame; a wrong face or an invented figure caps its identity score
below the pass mark and spends the retry budget on the defect.

It earned that on this film. The hero shot came back from Veo as a wide landscape with the
family reduced to three anonymous specks. The critic scored it **0.3 on identity** and
asked for them to be visible. The pipeline dropped the take and shipped the still that
shows their faces.

**Motion is worth less than the film being about the right people.** That is a judgement
the system makes on its own, and it is the difference between a demo and a product.

## Models propose, code decides

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
| `max` | Gemini 3 Pro Image + Veo Fast 1080p | $1.971 | | |

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
and the model-response cache — so the gallery is full and asking MUSE for a film about those
photographs returns the one it already made.
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

**Remembers, and can be asked about it.** A local memory library — photographs with
metadata a model can search, and the note you wrote yourself, which outranks anything the
model inferred. Ask MUSE talks about the library and only the library: it is instructed
never to invent a memory, and when it recognises a film already cut from exactly those
photographs it returns the film rather than making another.

**Changes theme without changing the story.** Four presets. The same five photographs cut
as loose gouache at 124 BPM and as cel-shaded neon anime at 152, each with its own score,
palette and camera grammar, and the same faces in both.

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

Three end-to-end drivers, each running a real project and then measuring the file it
produced. All of them run against the deterministic engine, so they cost nothing:

```
npm run verify         39/39   the pipeline, with a generated score
npm run verify:agent   39/39   the agent plans, renders, composes and inspects its own reel
npm run verify:track   42/42   a film cut against a supplied mp3
```

Plus **502 unit tests** across 19 files, and `npm run doctor` for the machine. The pipeline
driver measures the file rather than trusting the run:

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
