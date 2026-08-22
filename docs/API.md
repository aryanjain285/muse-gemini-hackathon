# HTTP API

Every route returns JSON unless noted. Errors are `{ "error": string, "kind"?: string }`
with a status derived from the failure class: `400` malformed or rejected, `402`
budget exhausted, `404` not found, `409` busy or out of sequence, `422` uninterpretable
instruction, `499` cancelled, `503` transient, `504` timeout.

Long work returns `202` as soon as it is scheduled; progress arrives on the status
stream rather than by polling.

---

## Inspection

### `GET /api/health`

Liveness plus a summary of what the server can currently do.

```json
{ "ok": true, "hasApiKey": true, "profile": "local",
  "budget": { "ceilingUsd": 5, "spentUsd": 0.55, "remainingUsd": 4.45 },
  "runner": { "active": [], "handlers": ["pipeline", "scene_revision", "patch_render", "recompose", "agent"] } }
```

### `GET /api/capabilities`

Which tasks route to a real model, what a full reel costs under each profile, the
available presets, and lifetime spend by model. The studio reads this before offering
to spend anything.

### `GET /api/budget?limit=50`

The ledger: the ceiling, spend grouped by model, and recent calls with `cacheHit` and
`estimated` flags.

---

## Projects

### `POST /api/projects`

```json
{ "mode": "generated", "preset": "dreamy_animated_memories",
  "brief": "the summer we drove to the coast", "profile": "standard" }
```

`mode` is `generated` (MUSE composes the score) or `uploaded` (cut to your track).
An unknown `preset` resolves to the default rather than failing. Returns `201` with
the full project view.

### `GET /api/projects`

Recent projects with poster and reel URLs.

### `GET /api/projects/{id}`

The complete project view: plan, scenes with per-scene status and critic scores,
uploads, music map, reel, spend, and version history. This is the same object the
status stream sends as its opening snapshot.

### `PATCH /api/projects/{id}`

Update `brief`, `preset`, `profile`, `consent`, `title` or `mode`. Refused with `409`
while the project is running.

### `DELETE /api/projects/{id}`

Cancels any running work, removes every stored file, then deletes the rows.

---

## Assets

### `POST /api/projects/{id}/assets`

`multipart/form-data` with `images` (repeatable, up to 5) and optional `audio`.

Files are validated against **real file signatures**, not the declared MIME type. A
text file named `.jpg` is rejected before anything is written. Uploading audio also
switches the project to `uploaded` mode.

```json
{ "accepted": ["ast_..."], "rejected": [{ "name": "fake.jpg", "reason": "unrecognised file format" }],
  "project": { } }
```

Returns `400` only when nothing was accepted; a partially rejected batch still
succeeds and reports what was skipped.

### `GET /api/assets/{path}`

Serves a stored asset. Refuses any path escaping the asset root. Supports `Range`, so
the preview player seeks without downloading the whole reel.

---

## Running

### `POST /api/projects/{id}/direct`

Start the full run: preflight, plan, then music and visuals concurrently, quality
control, composition.

```json
{ "consent": true, "profile": "standard", "useAgent": false }
```

`consent` must be true or the request is refused — enforced server-side, not just in
the UI. `useAgent: true` hands the run to the director agent instead of the fixed
pipeline. Returns `202` with a `jobId`.

### `GET /api/projects/{id}/status`

**Server-sent events.** Accepts `?since=<lastEventId>` so a reconnecting client
receives everything it missed with nothing replayed twice.

- `event: snapshot` — the whole project, sent first. One request is enough to render
  a correct screen.
- `event: progress` — one of: `status`, `stage`, `scene`, `music`, `qc`, `spec`,
  `agent`, `cost`, `render`, `log`, `done`, `error`.

A comment frame every 15 s keeps idle proxies from dropping the connection.

### `POST /api/projects/{id}/cancel`

Aborts the active job. Queued work is dropped, not paused. Persisted state is intact,
so the project can be resumed.

---

## Storyboard and revision

### `GET /api/projects/{id}/storyboard`

The plan plus every scene's window, render mode, route, asset URLs and critic verdict.

### `POST /api/projects/{id}/storyboard/{scene}/regenerate`

Re-render one scene and recompose, leaving every other scene untouched. The attempt
is part of the idempotency key, so asking twice genuinely re-renders.

### `POST /api/projects/{id}/render`

```json
{ "scenes": ["s03", "s04"], "regenerateMusic": false }
```

With no `scenes`, re-renders whatever the last patch invalidated. With nothing
invalidated, recomposes instead — the correct and cheapest answer.

### `POST /api/projects/{id}/compose`

Recompose from existing assets. No generation. Refused with `409` if no scene has
been rendered.

### `GET /api/projects/{id}/output`

Metadata for the finished reel: URL, duration, size, sha256, check results, and the
render manifest. Add `?download=1` to receive the MP4 itself with a filename.

---

## Live direction

### `POST /api/projects/{id}/patch-director`

```json
{ "utterance": "make the drop more magical", "apply": false, "render": false, "force": false }
```

With `apply: false` the instruction is interpreted and its blast radius reported
without committing anything. This is the honest path and the UI always takes it
first:

```json
{ "applied": false,
  "summary": "make the drop more magical",
  "impact": "regenerates 1 scene (s05) and the soundtrack",
  "invalidatedScenes": ["s05"],
  "ops": [
    { "op": "event_intensity", "kind": "drop", "intensity": 1 },
    { "op": "music_energy", "delta": 0.5 },
    { "op": "add_motif", "scene_ids": ["s05"], "motif": "a burst of light and swirling particles" }
  ],
  "route": "gemini:gemini-3.6-flash", "usd": 0.0021 }
```

With `apply: true` the patch is committed as a new spec version. `render: true` also
starts re-rendering the invalidated scenes.

An instruction touching more than 80% of the scenes returns `409` with
`needsForce: true` and an explanation; pass `force: true` to override deliberately.
An instruction that cannot be expressed as a bounded operation returns `422` rather
than guessing.

There are fourteen operations, and none of them can rewrite the plan wholesale:
`scene_action`, `scene_setting`, `scene_camera`, `scene_transition`,
`scene_render_mode`, `scene_title`, `style_palette`, `style_lighting`, `style_medium`,
`style_grain`, `add_motif`, `event_intensity`, `music_energy`, `attach_secondary`.

---

## Agent

### `POST /api/projects/{id}/agent`

```json
{ "goal": "Direct this project end to end and export a finished reel.",
  "policy": "auto", "maxUsd": 0.5 }
```

`policy` is `auto` (Gemini when a key and profile allow it, otherwise local),
`gemini`, or `local`. Bounded by turns, tool calls and spend.

### `GET /api/projects/{id}/agent?run={runId}`

The transcript: every thought, tool call, tool result and error in order, with the
spend attributed to each step. Omit `run` for the most recent.

```json
{ "runId": "run_...", "policyAvailable": "gemini",
  "steps": [
    { "seq": 3, "kind": "tool_call", "name": "get_project", "summary": "no arguments", "usd": 0 },
    { "seq": 4, "kind": "tool_result", "name": "get_project", "summary": "DRAFT, 3 upload(s), plan not yet written", "usd": 0 }
  ] }
```

---

## A complete run with curl

```bash
B=http://localhost:3939

PID=$(curl -s -X POST $B/api/projects -H 'Content-Type: application/json' \
  -d '{"mode":"generated","preset":"dreamy_animated_memories","brief":"the summer we drove to the coast"}' \
  | jq -r .project.id)

curl -s -X POST $B/api/projects/$PID/assets \
  -F "images=@a.jpg" -F "images=@b.jpg" -F "images=@c.jpg" > /dev/null

curl -s -X POST $B/api/projects/$PID/direct \
  -H 'Content-Type: application/json' -d '{"consent":true}'

# Follow progress
curl -N $B/api/projects/$PID/status

# Collect the result
curl -s $B/api/projects/$PID/output | jq '{durationS, checkOk, issues}'
curl -sL "$B/api/projects/$PID/output?download=1" -o reel.mp4
```
