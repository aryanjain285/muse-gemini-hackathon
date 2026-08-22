"use client";

/**
 * Live direction.
 *
 * The whole point of this panel is that a change becomes legible before it
 * becomes real: an utterance is interpreted, and the operations, the scenes that
 * will be thrown away are shown before anything is committed.
 * So the panel never offers a commit it has not already explained, and it
 * remembers the exact utterance a preview came from - the input can be edited
 * afterwards, and applying must send what the user was actually shown rather
 * than whatever the box happens to read at the moment of the click.
 */

import * as React from "react";

import type { DirectPanelProps, DirectionPreview, SceneView } from "@/components/studio/types";
import { formatSeconds } from "@/components/studio/useProjectStream";
import {
  Badge,
  Button,
  Display,
  Eyebrow,
  Field,
  Icon,
  Input,
  Meta,
  Panel,
  Spinner,
  Toggle,
  cx,
  useDomId,
} from "@/components/ui/primitives";

/** Which control fired the in-flight request, so only that one shows the wait. */
type Pending = "preview" | "apply" | "apply-render" | null;

type Op = DirectionPreview["ops"][number];

/**
 * Render an operation's field as a scannable value rather than as JSON. A patch
 * op is shallow in practice, so one level of flattening is enough and keeps the
 * row readable at a size that survives a projector.
 */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "unset";
  if (typeof value === "string") return value.length > 0 ? value : "empty";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Number(value.toFixed(3))) : "NaN";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return value.length === 0 ? "none" : value.map((entry) => formatValue(entry)).join(" ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}:${formatValue(entry)}`)
      .join(" ");
  }
  return String(value);
}

/** Every field on an op except its name, which is displayed on its own. */
function opFields(op: Op): { key: string; value: string }[] {
  return Object.entries(op)
    .filter(([key]) => key !== "op")
    .map(([key, value]) => ({ key, value: formatValue(value) }));
}

function msOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Wall clock in UTC. Formatting is deliberately timezone-independent so the
 * server-rendered pass and the browser agree on the same string, and the Z is
 * shown rather than implied, because a history that quietly misstates its clock
 * is worse than one that reads slightly technical.
 */
function clock(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}Z`;
}

const HISTORY_SHOWN = 6;

export default function DirectPanel({
  project,
  action,
  preview,
  onPreview,
  onApply,
  onDismiss,
  suggestions,
}: DirectPanelProps) {
  const titleId = useDomId("direction");
  const historyTitleId = useDomId("direction-history");
  const proposalTitleId = useDomId("direction-proposal");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const [draft, setDraft] = React.useState("");
  /** The utterance behind the preview on screen; what an apply must send. */
  const [issued, setIssued] = React.useState("");
  const [pending, setPending] = React.useState<Pending>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);

  const busy = action.busy;

  const lockReason =
    project.spec === null
      ? "There is no plan to change yet. Generate the reel first, then direct it."
      : project.running
        ? `A ${project.runningKind ?? "job"} is in flight. Direction is held until it finishes, because a patch cannot land underneath a render.`
        : null;
  const locked = lockReason !== null;

  // A request that ends - by returning a preview, by failing, or by the shell
  // dropping its busy flag - releases the control that fired it.
  React.useEffect(() => {
    if (!action.busy) setPending(null);
  }, [action.busy, action.error, preview]);

  const previewKey = preview
    ? [preview.summary, preview.route, preview.ops.length, preview.invalidatedScenes.join(",")].join(
        "|",
      )
    : "none";

  // A new proposal is a new decision, so an earlier override is not carried over.
  React.useEffect(() => {
    setAcknowledged(false);
  }, [previewKey]);

  const sceneById = React.useMemo(() => {
    const map = new Map<string, SceneView>();
    for (const scene of project.scenes) map.set(scene.id, scene);
    return map;
  }, [project.scenes]);

  const history = React.useMemo(
    () =>
      [...project.history].sort(
        (a, b) => b.version - a.version || msOf(b.createdAt) - msOf(a.createdAt),
      ),
    [project.history],
  );
  const shownHistory = history.slice(0, HISTORY_SHOWN);
  const hiddenHistory = history.length - shownHistory.length;

  const trimmedDraft = draft.trim();
  // Falls back to the box for the case where a preview was restored by the shell
  // rather than issued from here; without either there is nothing to commit.
  const applyUtterance = issued.length > 0 ? issued : trimmedDraft;
  const needsForce = preview?.needsForce === true;
  const forceBlocked = needsForce && !acknowledged;
  const diverged =
    preview !== null && issued.length > 0 && trimmedDraft.length > 0 && trimmedDraft !== issued;

  const fire = (utterance: string) => {
    const text = utterance.trim();
    if (text.length === 0 || locked || busy) return;
    setIssued(text);
    setPending("preview");
    onPreview(text);
  };

  const chooseSuggestion = (utterance: string) => {
    setDraft(utterance);
    fire(utterance);
  };

  const discard = () => {
    setIssued("");
    onDismiss();
    inputRef.current?.focus();
  };

  const commit = (render: boolean) => {
    if (preview === null || locked || busy || applyUtterance.length === 0 || forceBlocked) return;
    setPending(render ? "apply-render" : "apply");
    onApply(applyUtterance, { render, force: Boolean(preview.needsForce) });
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (preview !== null) discard();
    else if (draft.length > 0) setDraft("");
  };

  const invalidated = preview?.invalidatedScenes ?? [];
  const sceneCountLabel =
    invalidated.length === 0
      ? "recompose only"
      : project.scenes.length > 0
        ? `${String(invalidated.length)} of ${String(project.scenes.length)} scenes`
        : `${String(invalidated.length)} ${invalidated.length === 1 ? "scene" : "scenes"}`;
  const nextVersion = project.specVersion === null ? 1 : project.specVersion + 1;

  const commitHint = locked
    ? lockReason
    : forceBlocked
      ? "Turn on the override above to enable both apply buttons."
      : applyUtterance.length === 0
        ? "Type the instruction again to enable both apply buttons."
        : invalidated.length === 0
          ? "Apply edits the plan. Apply and re-render also recomposes the reel."
          : `Apply edits the plan and leaves ${
              invalidated.length === 1 ? "that scene" : `all ${String(invalidated.length)} scenes`
            } stale. Apply and re-render starts them now.`;

  return (
    <Panel tone="ink" padding="lg" className="w-full">
      <section aria-labelledby={titleId} className="flex flex-col gap-7">
        {/* ── header ─────────────────────────────────────────────────────── */}
        <header className="flex flex-col gap-3">
          <h2 id={titleId} className="flex">
            <Eyebrow tone="ember">Live direction</Eyebrow>
          </h2>
          <p className="max-w-prose text-lede text-paper-200">
            An instruction becomes a bounded change to the plan. Only the scenes it actually touches
            are re-rendered.
          </p>
        </header>

        {/* ── composer ───────────────────────────────────────────────────── */}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            fire(draft);
          }}
        >
          <Field
            label="Instruction"
            hint={lockReason ?? "Plain language. Nothing is committed until you apply the preview."}
          >
            <Input
              ref={inputRef}
              name="utterance"
              type="text"
              value={draft}
              maxLength={400}
              autoComplete="off"
              enterKeyHint="send"
              disabled={locked}
              placeholder="make the drop more magical"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <Button
              type="submit"
              variant={preview === null ? "primary" : "ghost"}
              trailingIcon="wand"
              loading={busy && pending === "preview"}
              disabled={locked || busy || trimmedDraft.length === 0}
            >
              Preview change
            </Button>
            <p className="font-mono text-meta text-paper-400">
              <kbd className="rounded-chip border border-hairline bg-ink-900 px-1.5 py-0.5 text-paper-200">
                Enter
              </kbd>{" "}
              previews{" "}
              <span aria-hidden="true" className="text-paper-500">
                /
              </span>{" "}
              <kbd className="rounded-chip border border-hairline bg-ink-900 px-1.5 py-0.5 text-paper-200">
                Esc
              </kbd>{" "}
              discards
            </p>
          </div>

          {suggestions.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <span className="font-mono text-micro uppercase tracking-console text-paper-400">
                Try one
              </span>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <Button
                    key={suggestion}
                    variant="quiet"
                    size="sm"
                    className="max-w-full"
                    disabled={locked || busy}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </form>

        {/* ── failure ────────────────────────────────────────────────────── */}
        <div role="alert">
          {action.error !== null ? (
            <div className="flex items-start gap-3 rounded-core-sm border border-signal-fail/50 bg-signal-fail/10 px-3.5 py-3">
              <span className="mt-0.5 text-signal-fail">
                <Icon name="alert" size={15} />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-mono text-micro uppercase tracking-console text-signal-fail">
                  Direction failed
                </span>
                <p className="text-label break-words text-paper-100">{action.error}</p>
                <p className="font-mono text-meta text-paper-400">
                  The plan is unchanged. Nothing was committed.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {/* ── the proposal, or the reason there is not one ────────────────── */}
        <div aria-live="polite" className="flex flex-col">
          {preview === null ? (
            busy && pending === "preview" ? (
              <div className="shimmer flex items-center gap-3 rounded-core-sm border border-hairline bg-ink-900 px-3.5 py-4">
                <span className="text-ember-300">
                  <Spinner size={15} />
                </span>
                <span className="font-mono text-meta uppercase tracking-console text-paper-200">
                  Interpreting the instruction
                </span>
              </div>
            ) : (
              <p className="max-w-prose rounded-core-sm border border-hairline bg-ink-900 px-3.5 py-4 font-mono text-meta text-paper-400">
                Nothing pending. A preview names the change, lists every operation, marks the scenes
                it invalidates and prices it, before anything is committed.
              </p>
            )
          ) : (
            <Panel key={previewKey} tone="ember" padding="md" enter>
              <article aria-labelledby={proposalTitleId} className="flex flex-col gap-5">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Eyebrow tone="ember">Proposed change</Eyebrow>
                    <Badge tone={invalidated.length === 0 ? "ok" : "warn"}>{sceneCountLabel}</Badge>
                    {needsForce ? <Badge tone="fail">override required</Badge> : null}
                  </div>
                  <Display level={3} id={proposalTitleId} className="max-w-prose">
                    {preview.summary.length > 0 ? preview.summary : "Unnamed change"}
                  </Display>
                  <p className="max-w-prose text-body text-paper-200">
                    {preview.impact.length > 0
                      ? preview.impact
                      : "No consequence was reported for this change."}
                  </p>
                  {applyUtterance.length > 0 ? (
                    <p className="max-w-prose font-mono text-meta text-paper-400">
                      from <span className="text-paper-200">&ldquo;{applyUtterance}&rdquo;</span>
                    </p>
                  ) : (
                    <p className="max-w-prose font-mono text-meta text-signal-warn">
                      The instruction behind this preview is no longer known. Type it again to apply
                      it.
                    </p>
                  )}
                  {diverged ? (
                    <p className="flex max-w-prose items-start gap-2 font-mono text-meta text-signal-warn">
                      <span className="mt-0.5">
                        <Icon name="alert" size={13} />
                      </span>
                      The box now reads differently. Applying commits the quoted instruction, not
                      the edit.
                    </p>
                  ) : null}
                </div>

                {/* what gets thrown away */}
                <div className="flex flex-col gap-2.5 border-t border-hairline pt-4">
                  <span className="font-mono text-micro uppercase tracking-console text-paper-400">
                    Scenes to regenerate
                  </span>
                  {invalidated.length === 0 ? (
                    <p className="flex max-w-prose items-start gap-2 text-label text-paper-200">
                      <span className="mt-0.5 text-signal-ok">
                        <Icon name="check" size={14} />
                      </span>
                      Nothing needs regenerating. Only a recompose will run, so no scene is
                      re-generated and no image or video model is called.
                    </p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {invalidated.map((sceneId) => {
                        const scene = sceneById.get(sceneId);
                        return (
                          <li
                            key={sceneId}
                            className="inline-flex items-center gap-2 rounded-chip border border-hairline-ember bg-ink-900 px-2 py-1"
                          >
                            <span className="tabular font-mono text-label text-paper-50">
                              {sceneId}
                            </span>
                            {scene ? (
                              <>
                                <span aria-hidden="true" className="h-3 w-hair bg-ink-700" />
                                <span className="tabular font-mono text-meta text-paper-400">
                                  {formatSeconds(scene.startS)}
                                </span>
                              </>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {/* the operations themselves */}
                <div className="flex flex-col gap-2.5 border-t border-hairline pt-4">
                  <span className="font-mono text-micro uppercase tracking-console text-paper-400">
                    Operations ({String(preview.ops.length)})
                  </span>
                  {preview.ops.length === 0 ? (
                    <p className="max-w-prose font-mono text-meta text-paper-400">
                      No operations were reported with this proposal.
                    </p>
                  ) : (
                    <ol className="overflow-x-auto rounded-core-sm border border-hairline bg-ink-900">
                      {preview.ops.map((op, index) => (
                        <li
                          key={`${op.op}-${String(index)}`}
                          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hairline px-3 py-2 last:border-b-0"
                        >
                          <span className="tabular font-mono text-meta text-paper-400">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="font-mono text-label uppercase tracking-console text-ember-200">
                            {op.op}
                          </span>
                          {opFields(op).map((field) => (
                            <span
                              key={field.key}
                              className="font-mono text-label break-words text-paper-100"
                            >
                              <span className="text-paper-400">{field.key}</span>
                              <span className="text-paper-400">=</span>
                              <span className="tabular">{field.value}</span>
                            </span>
                          ))}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>

                {/* what the interpreter refused */}
                {preview.rejected.length > 0 ? (
                  <div className="flex flex-col gap-2 rounded-core-sm border border-signal-warn/45 bg-signal-warn/10 px-3.5 py-3">
                    <span className="inline-flex items-center gap-2 font-mono text-micro uppercase tracking-console text-signal-warn">
                      <Icon name="alert" size={13} />
                      Rejected ({String(preview.rejected.length)})
                    </span>
                    <ul className="flex flex-col gap-1.5">
                      {preview.rejected.map((reason, index) => (
                        <li
                          key={`${reason}-${String(index)}`}
                          className="flex items-start gap-2 text-label text-paper-100"
                        >
                          <span
                            aria-hidden="true"
                            className="mt-2 size-1 shrink-0 rounded-pill bg-signal-warn"
                          />
                          <span className="break-words">{reason}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="font-mono text-meta text-paper-400">
                      These parts of the instruction are dropped. The rest still applies.
                    </p>
                  </div>
                ) : null}

                {/* the breadth guard */}
                {needsForce ? (
                  <div className="flex flex-col gap-3 rounded-core-sm border border-signal-warn/45 bg-signal-warn/10 px-3.5 py-3">
                    <span className="inline-flex items-center gap-2 font-mono text-micro uppercase tracking-console text-signal-warn">
                      <Icon name="alert" size={13} />
                      Whole-reel change
                    </span>
                    <p className="max-w-prose text-label text-paper-100">
                      This touches nearly every scene, so applying it will regenerate almost the
                      whole reel and spend again on each one. It stays held back until you override
                      it on purpose.
                    </p>
                    <Toggle
                      checked={acknowledged}
                      onChange={setAcknowledged}
                      disabled={locked || busy}
                    >
                      Override the breadth guard
                    </Toggle>
                  </div>
                ) : null}

                {/* provenance and price */}
                <div className="flex flex-col gap-2 border-t border-hairline pt-4">
                  <Meta
                    label="Interpreted by"
                    value={preview.route.length > 0 ? preview.route : "unknown route"}
                  />
                  <Meta label="Commits as" value={`v${String(nextVersion)}`} />
                </div>

                {/* commit */}
                <div className="flex flex-col gap-2.5 border-t border-hairline pt-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Button
                      variant="ghost"
                      trailingIcon="check"
                      loading={busy && pending === "apply"}
                      disabled={locked || busy || applyUtterance.length === 0 || forceBlocked}
                      onClick={() => commit(false)}
                    >
                      {needsForce ? "Apply anyway" : "Apply"}
                    </Button>
                    <Button
                      variant="primary"
                      trailingIcon="film"
                      loading={busy && pending === "apply-render"}
                      disabled={locked || busy || applyUtterance.length === 0 || forceBlocked}
                      onClick={() => commit(true)}
                    >
                      {needsForce ? "Apply anyway and re-render" : "Apply and re-render"}
                    </Button>
                    <Button variant="quiet" disabled={busy} onClick={discard}>
                      Discard
                    </Button>
                  </div>
                  <p className="max-w-prose font-mono text-meta text-paper-400">{commitHint}</p>
                </div>
              </article>
            </Panel>
          )}
        </div>

        {/* ── plan history ───────────────────────────────────────────────── */}
        <section aria-labelledby={historyTitleId} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <h3 id={historyTitleId} className="flex">
              <Eyebrow>Plan history</Eyebrow>
            </h3>
            <span className="tabular font-mono text-meta text-paper-400">
              {project.specVersion === null
                ? "no version yet"
                : `current v${String(project.specVersion)}`}
            </span>
          </div>

          {shownHistory.length === 0 ? (
            <p className="max-w-prose font-mono text-meta text-paper-400">
              No revisions recorded yet. The first accepted instruction becomes v
              {String(nextVersion)}.
            </p>
          ) : (
            <>
              <ol className="flex flex-col gap-1.5">
                {shownHistory.map((entry) => {
                  const current = entry.version === project.specVersion;
                  return (
                    <li
                      key={`${String(entry.version)}-${entry.createdAt}`}
                      className={cx(
                        "flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-core-sm border px-3 py-2",
                        current ? "border-hairline-ember bg-ink-800" : "border-hairline bg-ink-900",
                      )}
                    >
                      <span className="tabular font-mono text-label text-paper-50">
                        v{String(entry.version)}
                      </span>
                      <span className="font-mono text-micro uppercase tracking-console text-paper-400">
                        {entry.origin.length > 0 ? entry.origin : "unknown"}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-label text-paper-200">
                        {entry.note.length > 0 ? entry.note : "no note recorded"}
                      </span>
                      {current ? <Badge tone="live">current</Badge> : null}
                      <time
                        dateTime={entry.createdAt}
                        className="tabular font-mono text-meta text-paper-400"
                      >
                        {clock(entry.createdAt)}
                      </time>
                    </li>
                  );
                })}
              </ol>
              {hiddenHistory > 0 ? (
                <p className="tabular font-mono text-meta text-paper-400">
                  {String(hiddenHistory)} earlier {hiddenHistory === 1 ? "version" : "versions"} not
                  shown.
                </p>
              ) : null}
            </>
          )}
        </section>
      </section>
    </Panel>
  );
}
