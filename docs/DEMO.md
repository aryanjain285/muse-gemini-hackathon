# Demo runbook

Everything needed to run MUSE in front of judges, plus what to do when something
goes wrong. Read the failure drills once before the day; they are the part that
matters.

---

## The pitch, in under 30 seconds

> Most AI video tools generate clips. MUSE directs a film.
>
> Gemini writes one timeline for story, music and picture. Lyria composes around
> that timeline, Gemini generates and then critiques every shot, and a deterministic
> editor lands every cut on the music — not where the plan hoped the beat would be,
> but where we measured it actually is.
>
> Five photos and one sentence, and it makes a complete thirty second reel.

If you only get one extra sentence, use this one:

> We asked Lyria for a drop at fifteen seconds. It gave us one at twenty-one. Every
> tool that assumes the timestamp is obeyed produces a reel that feels slightly
> wrong and nobody can say why. We measure the waveform and move the cuts.

---

## Before the day

```bash
npm install
npx tsx scripts/doctor.ts          # must print READY — 0 failure(s)
npx tsx scripts/verify-e2e.ts      # must print PASS — 39/39, costs $0.00
npm test                           # 249 tests
npm run build                       # catches anything tsc cannot
```

Then decide your profile and set it in `.env.local`:

| Profile | Use it when | Cost |
|---|---|---|
| `local` | The wifi is hostile, or you want a guaranteed run | $0.00 |
| `standard` | **Recommended for the live demo.** Real keyframes, real Lyria score | ~$0.42 |
| `hero` | You have budget and want one real Veo shot at the drop | ~$0.72 |

Warm the cache before you present:

```bash
MUSE_PROFILE=standard npx tsx scripts/verify-e2e.ts --profile standard --keep
```

That run pays for the generation once and takes about nine minutes, most of it
waiting on seven real keyframes. Because every response is cached by request hash,
re-running the same project on stage costs **$0.00** and returns instantly — and it is
the same code path, not a recording.

Do not attempt a cold `standard` run in front of an audience. Either warm it first, or
present in `local`, which completes in under a minute with no network at all.

Finally, freeze the template. Do not edit a prompt in `src/lib/templates/` after
this point: a prompt change bumps the bundle version and retires the cache you just
paid for.

---

## The five-minute demo

**1. Open the landing page.** `npm run dev` → `http://localhost:3939`

Point at the seven-beat strip. "This is the shape of every reel — recognition, the
world opening, motion, build, the drop at fifteen seconds, a variation, resolution."

**2. Begin.** Pick **Dreamy Animated Memories**, mode **Make everything**.

**3. Upload three photos.** Real photos of one person work best. Say: "MUSE builds a
subject reference sheet from these, and passes the same sheet into every scene
prompt. That is what stops the face drifting."

**4. Type one sentence.** Something with a feeling in it, not a description:

> the summer we drove to the coast and everything felt endless

**5. Confirm the rights.** Tick consent — it is about the photographs, not the
spend. "Nothing renders until this is on."

Step 4 is worth a sentence if anyone asks how models get chosen: "MUSE picks its own.
Which model runs is an operator decision made against the remaining ceiling, not a
question to hand somebody who wants a film."

**6. Press Direct this film**, and talk over the console while it runs:

- The **plan appears first** — a title, a logline, seven scenes, an event timeline.
  "Gemini wrote this. Everything downstream just fills it in."
- **Read the shot sizes down the list.** Close, wide, medium, extreme close-up, full,
  insert, wide. "That is coverage — it is what a director does that a generator does
  not. It is a field in the plan, so it can be guaranteed: never three shots running
  at the same distance, always one close enough to read a face."
- **Music and visuals go at once.** Point at both channels moving in the Signal log.
  "These are genuinely parallel. They only share the timeline."
- **The critic scores each shot as it lands.** "It looks at real frames. And where a
  measurement can see the truth, the measurement overrules the model."
- **The composer runs last** and reports its passes.

**7. Play the reel** full screen in the preview rail.

**8. Open Diagnostics → Music map.** This is the moment. Show the two-lane graphic:
planned beats above, measured accents below, connectors where a cut moved.

> "We asked for a drop at fifteen seconds. Here is where the music actually put its
> accents. And here is every cut sitting on one of them — a mean of one millisecond
> off. That is not the model being obedient. That is us measuring and adjusting."

**9. Live direction.** Type `make the drop more magical` and press Preview.

> "It does not just do it. It tells you it will regenerate one scene and the
> soundtrack, and nothing else. Then you decide."

Apply and re-render. Show that only the named scene changes.

**10. Re-cut it, and let them hear the difference.** In the edit bay, switch to
**hard cuts** and then to **off the beat**. Both players stay loaded, so the playhead
does not move when you swap.

> "Nothing regenerated. The shots and the score are already paid for, and cutting is
> just deterministic code over them — so a different film costs nothing. 'Off the
> beat' is the argument: it puts the cuts exactly where the plan asked. The plan said
> the drop was at a round fifteen seconds. The music put it at 14.83. You can hear
> which one is right."

**11. Show the spend.** Diagnostics → Spend. Point at the `CACHED` rows at $0.00, and
at the spend being unchanged after four re-cuts.

> "Anything we have asked before is free. That is why I can run this again right now
> without spending anything."

---

## Failure drills

Rehearse these. Each one is a real capability, so a failure becomes a talking point
rather than a scramble.

### The wifi dies

Nothing to do. Every stage falls back to the local engine and the run completes.
Say it out loud:

> "We just lost the network. It is still going — every stage has a deterministic
> implementation, so there is no failure that stops an export. Watch the routes
> switch to local in the console."

To force this deliberately: set `MUSE_PROFILE=local` and restart, or rename
`.env.local`.

### A model is slow or the quota is gone

The router walks its fallback chain and then goes local. Already happened in
testing: `gemini-3.6-flash` timed out on a Director call and `gemini-3.7-flash`
answered — the reel was unaffected. Point at the `fallback` line in Signal.

### The budget runs out mid-demo

The governor refuses the call and the local engine answers. The reel still completes.
If you need headroom back:

```bash
# Raise the ceiling
MUSE_BUDGET_USD=10 npm run dev
```

### The reel has a visible flaw

Say what it is. The Diagnostics panel already shows the critic's verdicts and any
reel-check warnings, and a system that surfaces its own faults reads as stronger than
one that hides them. Then regenerate that single scene from the storyboard.

### Something hangs

Press **Stop**, then **Reload from server**. Job state is persisted, so nothing is
lost. If the process died entirely, restart `npm run dev` — interrupted jobs are
reconciled at boot and the project is resumable.

### You need a guaranteed clean run, right now

```bash
npx tsx scripts/verify-e2e.ts --keep
```

Sixty seconds, no network, prints 39 measured checks, and leaves a finished reel in
the studio at the URL it prints. This is also the strongest thing you can show a
technical judge.

---

## Questions judges ask

**"Is the music actually generated, or is it a library track?"**
Generated by Lyria 3 from a brief the Director wrote. Diagnostics shows the brief,
the model route, and the measured tempo. In `local` profile it is synthesised on
this machine by real DSP — show `src/lib/music/synth.ts`.

**"How do you keep the face consistent?"**
One subject reference sheet built up front, passed into every scene prompt, plus the
immutable traits repeated as literal words and the previous scene's approved keyframe
as a second reference. And when the critic faults identity, the keyframe is
regenerated rather than re-animated — animating a drifted face just gives you a
moving drifted face.

**"What happens if a model returns something unusable?"**
Show the failure matrix in `ARCHITECTURE.md`. Every stage has a fallback and the
critic decides between retry and fallback from measured evidence.

**"Did you just hardcode the demo?"**
Change the sentence, change the preset, upload different photos. The plan changes,
the score changes, the cuts move. Or run `verify-e2e` in front of them — it creates a
fresh project and measures the output.

**"How much does one reel cost?"**
Between nothing and about two dollars, depending on how much you want to be real.
Diagnostics shows the per-call ledger. Repeats are free.

**"Why only thirty seconds?"**
It concentrates quality, it fits how people actually watch vertical video, and it
keeps the whole creative loop demonstrable. Also honest: generation cost and failure
surface both scale with length.

---

## Numbers worth knowing by heart

| | |
|---|---|
| Output | 1080×1920, 30 fps, H.264 + AAC, exactly 30.00 s |
| Scenes | 5–7, contiguous, exactly one hero at the drop |
| Cut accuracy | 1 ms mean, 7 ms worst, against measured accents |
| Coverage | 5 distinct shot sizes across 7 shots, no adjacent repeat |
| Re-cut | free and instant; 4 re-cuts left spend at `$0.393137` |
| Local run time | under a minute, no network |
| Standard run time | ~9 min cold, instant cached |
| Hero run time | ~24 min cold (7 stills at 1K), instant cached |
| Tests | 397 |
| Cost, standard profile | ~$0.42 first run, $0.00 cached |
| Cost, hero profile | $0.55 measured, $0.00 cached |
| Models | `gemini-3.6-flash`, `gemini-3.1-flash-image`, `lyria-3-clip`, `veo-3.1-lite` |

---

## Do not

- Present a cached reel as freshly generated. Say "this is cached, and here is the
  same path running live" — the caching is a feature worth claiming honestly.
- Edit a prompt during the demo. It invalidates the cache you paid for.
- Promise frame-perfect lip sync, arbitrary length, or unrestricted prompting. None
  of those are what this is.
- Hide a warning the UI is already showing you.
