# Architecture

How MUSE is put together, and why each decision is the way it is. Written to be
checkable: every claim here corresponds to code you can read and a number you can
reproduce with `scripts/verify-e2e.ts`.

---

## 1. The thesis

Most generative video tools expose the model directly: write a prompt, wait,
receive a clip. Consistency, pacing and musical synchronisation are then fragile,
because nothing in the system holds a view of the film as a whole.

MUSE inverts that. One artefact — the **DirectorSpec** — describes the entire reel
on a shared timeline: narrative beats, musical structure, scene windows, camera
moves, transitions and quality budgets. Everything downstream consumes it.
Generation becomes a way of filling in a plan rather than a way of guessing at one.

Three consequences follow, and they are the whole design:

1. **Models propose, code decides.** A generative music model treats requested
   timestamps as intent, not instruction. So MUSE measures what actually came back
   and moves the cuts onto real accents. The composer owns exact time.
2. **Every stage has a deterministic answer.** A route that cannot be served by a
   model is served by local code instead. There is no failure path that prevents
   an export, which is what makes the system demonstrable.
3. **Spend is a first-class constraint.** A hard ceiling, a per-call estimate, a
   persisted ledger and a content-addressed cache, so the same project re-runs for
   nothing.

---

## 2. Layer map

```
src/lib/
  core/       config, paths, logging, errors, small utilities
  db/         SQLite schema, typed repositories, cost ledger
  spec/       DirectorSpec schema + validation + bounded patches
  models/     Gemini transport, adapters, router, governor, cache
  music/      synthesiser, FFT analysis, planner, reconciliation
  visual/     deterministic render engine
  compose/    manifest planning, filter library, composer, verification
  templates/  four preset bundles and every prompt, versioned
  agent/      tool registry, craft skills, the director loop
  services/   asset, vision, director, visual, music, critic, pipeline
  jobs/       event bus and durable runner
  server/     bootstrap, HTTP helpers, view models
```

Dependencies point inward. `core` imports nothing of MUSE's; `services` compose the
layers below them; `app` only ever talks to `services` and `server`. No module
below `services` knows an HTTP request exists.

---

## 3. The DirectorSpec

`src/lib/spec/directorSpec.ts`

A single versioned object, validated with zod plus structural checks the schema
cannot express. It carries a style bible, a music plan, an event timeline and 5–7
scenes with contiguous windows.

Three details exist so the composer never has to interpret prose:

- **`camera` is an enum**, not free text. Each value maps to a camera move the
  composer can actually execute. Anything else a model wants to say arrives as
  `camera_note` and only influences generative prompts.
- **`transition_in` names a primitive** from a nine-member approved library,
  applied by code, rather than leaving the cut to generated video.
- **`shot_size` is a field, not a description.** It was prose first, and prose is
  unenforceable: the Director asked for an extreme close-up and a panoramic inside
  `setting`, the image model honoured one of them, and four shots in seven came back
  identically framed. A field can be constrained by the schema, guaranteed by
  `normalize`, given its own composition rules by the prompt builder, and checked by
  the critic. The same fact written into prose can be none of those things.

### Coverage

Shot size is only half of framing; the other half is where the subject sits, and that
has to follow the size. A single global placement clause — "the subject in the lower
two-thirds, generous headroom above" — was appended to every keyframe prompt, and
because a model weights the end of a prompt heavily it overrode whatever size came
before it. Wides, fulls and mediums all returned a standing figure in a landscape.

Placement now belongs to the size. A wide puts the subject small and low with the
landscape taking the height; an extreme close-up runs the features across the full
width with the face cropped; an insert has no subject at all, so the subject and
identity lines are dropped from the prompt entirely rather than contradicted.

`normalize` then guarantees the film is covered: never three consecutive shots at one
distance, at least one close enough to read an expression, at least one wide enough to
place the film somewhere. It does this by moving a size — never by reordering scenes
or rewriting what a shot is about, because those belong to the Director.

### Validation and repair

`parseSpec` returns `{ ok, spec, issues }`. Issues are `hard` (blocks rendering) or
`soft` (normalised automatically). `normalize` closes gaps and overlaps, renumbers
ids into playback order, keeps exactly one hero scene, clamps and sorts events, and
pins the final hit near the end.

The Director gets **one repair pass**: its own output plus the precise violations,
which is far more reliable than regenerating blind. If that still fails, the local
director answers. `direct()` cannot return an unrenderable plan.

---

## 4. Model router

`src/lib/models/router.ts`

Every model call in MUSE goes through `route()`, which layers five concerns in a
fixed order:

| Step | Concern | Behaviour |
|---|---|---|
| 1 | **profile** | Is this task configured to use a real model at all? |
| 2 | **cache** | Has this exact request been answered before? Free replay. |
| 3 | **governor** | Does the estimated cost fit under the remaining budget? |
| 4 | **fallback** | Primary model, then the configured chain. |
| 5 | **local** | A deterministic result that always succeeds. |

Because step 5 exists, callers never wrap generation in a try/catch — there is
nothing to catch. A route returns a usable value with no key, no network, no quota
and no budget.

A `permanent` rejection stops the chain immediately, because a malformed request
fails identically on every sibling model. A `transient` failure walks on.

**Deliberate local routing is not a fallback.** When a profile routes a task
locally, the result carries no `fallbackReason` — reporting it as a failure would
make the deterministic engine look like damage every time it is used on purpose.

### Cost governor

`src/lib/models/governor.ts`

Reserve → call → settle. A reservation is checked against `ceiling − spent −
in-flight`, so two concurrent calls cannot both fit the last cent. On settle, the
real usage is billed; if the provider reported nothing, the estimate is billed
rather than silently recording a free call.

Prices are per-unit and verified against Google's published rates: tokens for text,
image tokens for image models (reported separately under
`candidatesTokensDetails`, and about 75% of a 1K image's total — folding them into
the general output count would overstate cost by a third), seconds for video, and a
flat rate per music clip.

Refusal throws a `budget` error, which the router treats as a signal to fall back —
never to retry.

---

## 5. Music: intent versus reality

`src/lib/music/`

This is the part most worth reading, because it is where the product's headline
claim is either true or hand-waving.

### Planned map

`planner.ts` turns the Director's events into a natural-language brief: instrumental
only, target BPM, key, duration, instrumentation, mood arc, and an ordered list of
what happens at which second.

### Actual map

`analyze.ts` decodes whatever came back — via ffmpeg to mono `f32le` — and measures
it properly:

- a hand-written iterative radix-2 FFT (there is no dependency available), tested
  against a known sine
- spectral-flux novelty, half-wave rectified, peak-picked against an adaptive local
  threshold with a 60 ms minimum inter-onset gap
- tempo from novelty autocorrelation, folded into 70–180 BPM
- section boundaries from sustained change in smoothed RMS and spectral centroid
- the loudest sustained window as `peakRegionS`

### Reconciliation

`reconcile.ts` matches each planned event to the best real anchor inside a
tolerance — wider for the drop, which matters most and moves most. An anchor may be
claimed by only one event, and a match that would break monotonic order is
rejected.

**Measured on a real Lyria clip** (`workspace/reference/soundtrack-probe-0.mp3`,
generated from a brief asking for 118 BPM with a drop at 15 s):

| Measurement | Result |
|---|---|
| Estimated tempo | 120.25 BPM (requested 118) |
| Anchors detected | 96 |
| Loudest sustained window | 18.17 – 24.16 s |
| Loudest instant | 21.40 s |

The track was asked for its drop at 15 s and actually peaks at **21.4 s**. That gap
is not a defect in Lyria — it is the correct behaviour of a model told the *kind* of
track to make. It is also precisely why the reconciliation layer exists, and why
assuming the requested time would have produced a reel that felt loose without
anyone being able to say why.

### Local synthesiser

`synth.ts` is a real subtractive/FM synthesiser, not a placeholder: a diatonic
progression in the parsed key, sub bass, pitch-swept kick, band-passed clap,
hats, a detuned saw pad through a state-variable filter, a tempo-synced delayed
arpeggio, an FM bell, a riser, and an impact — arranged against the spec's events
with a density curve, then bus-compressed and soft-limited.

Measured on its 30 s reference render: **−1.00 dBFS true peak, −12.7 LUFS
integrated, DC offset −3×10⁻⁶, zero samples at the rail**, a 25.7 dB drop-out
contrast in the 150 ms before the drop, and harmony verified by Goertzel probe to
land on i–VI–III–VII in A minor. The −1 dBFS ceiling is deliberate headroom for the
AAC stage; a 0 dBFS master would clip after encoding.

---

## 6. Visuals

`src/lib/services/visual.ts`, `src/lib/visual/`

**Every scene becomes a self-contained MP4** — exact duration, 1080×1920, 30 fps, no
audio. Each can be inspected, scored and retried on its own, and the composer's job
reduces to joining clips, placing transitions and mixing audio, with no per-scene
special cases at assembly time.

### Continuity

Continuity is enforced by repetition, not by hope: the same subject reference sheet,
the same immutable traits as literal words, and the previous scene's approved
keyframe passed as a visual reference. Keyframes are therefore generated in scene
order even though the pool would allow parallelism.

When identity or composition is what the critic faulted, the **keyframe** is
regenerated rather than re-animated — animating a drifted face just produces a
moving drifted face.

### Deterministic variety

The local engine intercuts **subject shots** (stylised uploads) with **environment
shots** (procedurally composed frames), rotating through the available uploads by
scene position. Seven treatments of one photograph reads as a slideshow no matter
how good the grade is; alternating between the person and the world reads as an
edited film.

---

## 7. The composer

`src/lib/compose/`

Deliberately boring, deterministic software. It reads a manifest and emits an MP4;
it makes no creative decisions and calls no models. A manifest re-rendered later
produces a comparable result, and a failed render is diagnosable from the manifest
alone.

### Transition arithmetic

A cross-dissolve overlaps two clips, so naively joining *N* clips of their scene
lengths yields a reel shorter than the plan by the sum of every transition — which
would slide every subsequent cut off the beat.

So each clip is rendered at **its window + its incoming transition + snap
headroom**. After the overlap consumes the transition padding, its net contribution
is exactly its window, and the assembled reel lands on the planned duration to the
frame.

### Cut snapping

`snapSceneBoundaries` moves each internal scene boundary onto the nearest
reconciled anchor within tolerance, preserving order, refusing to collapse a scene
below 1.2 s, and pinning the first and last boundaries so the audio still lines up.

This is the difference between the claim being true and being lucky. With the local
director, scene times happened to fall on the synthesiser's bar grid. With a real
language-model Director choosing its own times, they do not:

| | mean cut error | worst |
|---|---|---|
| Before snapping (real Director) | 596 ms | 2000 ms |
| After snapping | **1 ms** | **7 ms** |

Effects and overlays are timed against the *snapped* window, so a beat pulse fires
on the frame the cut really lands on.

### Passes, and how they degrade

| Pass | Work | Fallback if it fails |
|---|---|---|
| Per clip | effect chain → conformed segment | render the clip plain |
| Assembly | xfade chain across segments | demuxer concat, all hard cuts |
| Audio | trim, gain, fades, deterministic accents, limiter | — |
| Finish | grade, grain, bloom, vignette, titles, mux | export ungraded |

Each pass is logged into the outcome. One enormous filtergraph that fails tells you
nothing about which of forty filters broke; four separately verifiable passes tell
you exactly.

Grade, grain and vignette run once over the joined timeline, not per clip — a reel
graded shot by shot looks like several different films.

### Verification

`checkReel` inspects the finished file the way a reviewer would: duration against
plan, exact dimensions, audio present and long enough, `blackdetect` for holes in
the timeline (ignoring the intended fade-out), and `volumedetect` for a silent
master. This is the gate that stops a broken export being reported as a success.

---

## 8. Critic

`src/lib/services/critic.ts`

Two layers, and the boundary between them is deliberate.

**Measurement always runs.** Frames are sampled as raw RGB and measured for
duration accuracy, frame-to-frame motion, brightness, black fraction, a
high-frequency sharpness proxy, and how much visual weight sits inside the vertical
safe region. Free, deterministic, and it catches the failure modes that actually
ruin a reel.

Motion uses a square-root curve: raw inter-frame difference for a deliberate slow
push measures ~0.01 and a frozen clip ~0.0005, and a linear scale compressed every
real camera move into the bottom third — making the critic reject shots that were
moving exactly as intended.

**The model is consulted on what measurement cannot see** — identity drift,
continuity, prompt adherence — and a model verdict that contradicts a hard
measurement is overridden, because a measurement is not an opinion. The
worst-dimension rule deliberately excludes motion: a calm shot is a valid shot.

**Deterministic output is judged by measurement alone.** The multimodal critic
exists to catch generative failure modes; the local engine does not treat the
prompt as an instruction at all, so asking a model whether it rendered the vintage
convertible the plan described scores near zero on adherence every time —
truthfully and uselessly, since no retry can act on it. Measured directly, this cost
a run 22 retries and produced no usable signal.

---

## 9. Agent harness

`src/lib/agent/`

The director agent is not a second implementation. It drives **the same services**
through a tool registry, so anything it produces is byte-identical to what the
pipeline would produce — it only decides what to do and in what order.

- **`registry.ts`** — a tool declares a Gemini function schema, a zod validator so
  a hallucinated argument set is rejected before work starts, and an effect class
  (`read` / `write` / `spend`) the loop uses to gate money.
- **`skills.ts`** — five versioned craft guides (directing, music, visual, editing,
  operating) as prose, because that is what a language model reads best and because
  a change to the agent's judgement should be a reviewable diff. Two are always
  loaded; the rest are fetched on demand via `read_skill`.
- **`tools.ts`** — ten tools: `get_project`, `get_timeline`, `inspect_scene`,
  `inspect_reel`, `read_skill`, `plan_film`, `patch_plan`, `render_scene`,
  `make_score`, `compose_reel`, `finish`.
- **`loop.ts`** — two policies over one registry. `GeminiPolicy` is a real
  function-calling conversation (model turns are echoed back verbatim, because
  Gemini 3 attaches an opaque `thoughtSignature` that must survive the round trip).
  `LocalPolicy` walks the canonical order deterministically.

That symmetry is the point: the console shows the same stream of tool calls and
results either way, so the system demonstrates with no credentials, and adding a key
changes *who is deciding* rather than *what is possible*.

Every run is bounded three ways — turns, tool calls and spend — because an
unbounded agent pointed at paid generation is a way to lose a budget. If a model
turn fails, the run continues under the local policy. If a run ends without a reel,
a salvage step composes whatever exists.

Because an agent legitimately drives stages out of the pipeline's linear order,
`Projects.advanceTo` walks the shortest legal path through the state machine rather
than loosening it. Strictness is what makes an impossible state impossible.

---

## 10. Orchestration

`src/lib/services/pipeline.ts`, `src/lib/jobs/`

Two shapes matter.

**Music and visuals run concurrently** from the moment the plan exists, because
they share only the timeline. This is the honest version of the architecture claim:
the branches are genuinely independent, not interleaved for show.

**Quality control runs per scene** as each clip lands, not as a phase afterwards, so
a bad scene is being repaired while its neighbours are still rendering. The hero
scene is ordered first: it carries the largest retry budget and matters most, so it
should not be queued behind cheaper shots if the deadline bites.

### Durability

Route handlers hand work to the runner and return immediately; the browser follows
an SSE stream. Job state is persisted before and after each step, so a project
interrupted by a restart is resumable rather than lost. Anything left `running` at
boot cannot still be running in this process and is flagged.

Idempotency keys are content hashes of the full request, so a repeated call returns
the prior result instead of re-spending.

The whole-project deadline is a **safety net, not an operating limit**. Set too low
it fires mid-run and silently disables whatever happens to be last — in practice the
critic, which then never scores anything. Measured: a full local render is under a
minute; the default ceiling is 15 minutes.

### Event bus

Each project keeps a bounded replay buffer, so a browser that connects late — or
reconnects after a refresh — receives everything that already happened. During a
live demo the render is often already running before anyone looks at the screen.

---

## 11. Live direction

`src/lib/spec/patch.ts`

An utterance becomes a **bounded patch**: one of fifteen named operations, each
declaring exactly which scenes it invalidates. There is no operation that can
rewrite the plan wholesale.

### Two dialects, and the seam between them

The Director is asked for one flat operation shape with named slots —
`set_scene_setting` with a free `value` — because that is what a model fills in
reliably. The spec module takes a discriminated union where each operation carries
only its own fields, because that is what makes an illegal patch unrepresentable.
Both shapes are right for their own job and they cannot agree with each other, so the
seam between them is a real component and not a rename.

It was missing. A reply in the wire dialect was parsed straight against the internal
one, which no reply could ever satisfy, so with a key present every model-produced
note was refused as "could not turn that into a change I can make" and only the local
keyword interpreter ever applied anything. The failure was invisible because the
fallback was a working feature.

Decoding also has to consult the spec rather than map field to field: the wire carries
an intensity *nudge* where the spec stores a *level*, and resolving one against the
other needs to know what the level currently is. Anything unrecognised is dropped
rather than guessed at, and a patch left empty reports the model's own reason for not
being able to express the note.

Invalidation is proportionate. A setting change bleeds into the *next* shot through
continuity, because each scene's prompt carries the previous scene's keyframe — that
dependency is one step deep, so invalidation stops there. Cascading to the end of
the reel would spend the whole budget to fix one scene, and would make every
targeted instruction get refused as too broad.

Naming a scene means that scene. An instruction that touches more than 80% of the
scenes is refused with an explanation rather than silently re-spending.

| Instruction | Operations | Re-renders |
|---|---|---|
| "make the drop more magical" | `event_intensity`, `music_energy`, `add_motif` | 1 scene + score |
| "make scene 3 nighttime" | `scene_setting` | 2 scenes |
| "make it all nighttime" | `style_lighting` | refused: needs confirmation |

Every version is retained, so undo is a revert rather than a mutation.

---

## 12. Safety

- Uploads are validated against **real file signatures**, never the declared MIME
  type, which is attacker-controlled. A text file named `.jpg` is rejected before
  anything is written.
- Consent is required before any generation runs, enforced server-side.
- Assets are served through a handler that refuses any path escaping the asset
  root, with range support for seeking.
- Logs redact data URIs, base64 blobs and anything key-shaped; API keys are
  server-side only and scrubbed from every error message.
- Output is labelled AI-generated in the UI and in the MP4 metadata.
- Deleting a project removes its source and generated files.

---

## 13. What is measured, not asserted

Reproduce with `npx tsx scripts/verify-e2e.ts`:

- 5–7 scenes, contiguous from 0 to the planned duration, exactly one hero
- every scene has a keyframe and a clip at 1080×1920 with no audio track
- reel duration within 0.4 s of plan; audio covers the picture
- no black runs; master not silent
- manifest self-consistent; clip sources long enough for their windows
- **cuts within 250 ms of a measured accent** (currently 1 ms mean, 7 ms worst)
- the local profile spends exactly $0.00

249 unit and integration tests cover the FFT against a known sine, onset detection
against a synthetic click track, every ffmpeg filter and transition by actually
rendering them, WAV container and level correctness, spec validation and repair,
and design-token integrity.
