"use client";

/**
 * The studio's front door: the only surface where a director configures a run.
 *
 * The whole panel is one ordered list - references, style, direction, engine,
 * consent, action - so the sequence is legible at a glance and there is never a
 * question about what to do next. The step number is a real list position
 * rather than decoration, which keeps that reading order true for a screen
 * reader as well as for the projector.
 *
 * Nothing here talks to the network. Every value arrives on props and every
 * action leaves through one, so the shell stays the single owner of state.
 */

import * as React from "react";

import type { Capabilities, SetupPanelProps } from "@/components/studio/types";
import { formatBytes } from "@/components/studio/useProjectStream";
import type { SegmentedOption } from "@/components/ui/primitives";
import {
  Badge,
  Button,
  Display,
  Eyebrow,
  Field,
  Icon,
  Panel,
  Segmented,
  Spinner,
  Textarea,
  Toggle,
  Tooltip,
  cx,
  useDomId,
} from "@/components/ui/primitives";

/** The composer draws from at most five references; beyond that it repeats. */
const MAX_IMAGES = 5;
const BRIEF_MAX = 600;
/** Warn while there is still room to finish a sentence, not once it is gone. */
const BRIEF_WARN_AT = 540;
const BRIEF_PLACEHOLDER = "the summer we drove to the coast and everything felt endless";
/** Long enough that a whole sentence lands in one PATCH, short enough to feel live. */
const BRIEF_PATCH_MS = 600;
/**
 * What the picker offers.
 *
 * HEIC is here because it is what an iPhone writes, and the server converts it on
 * ingest. Leaving it out of `accept` meant a camera roll appeared empty in the file
 * dialog even though the upload endpoint would have taken every one of those photos —
 * the backend supported the commonest case and the browser hid it. The extensions are
 * listed alongside the types because some browsers report an empty or wrong `type` for
 * HEIC and match on suffix instead.
 */
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";

/** Drag and drop bypasses the accept attribute, so the list is checked twice. */
const IMAGE_MIMES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

/** A dropped HEIC often arrives with an empty type, so the name is the only signal. */
function isUsableImage(file: File): boolean {
  if (IMAGE_MIMES.includes(file.type)) return true;
  return /\.(heic|heif)$/i.test(file.name);
}

const MODE_OPTIONS: SegmentedOption<"generated" | "uploaded">[] = [
  { value: "generated", label: "Make everything" },
  { value: "uploaded", label: "Bring your song" },
];

// ── step scaffold ────────────────────────────────────────────────────────────

interface StepProps {
  n: number;
  eyebrow: string;
  title: string;
  /** Status shown beside the eyebrow: a count, a badge, a warning. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}

function Step({ n, eyebrow, title, aside, children }: StepProps) {
  return (
    <li className="flex gap-4 border-t border-hairline pt-7 first:border-t-0 first:pt-0 sm:gap-6">
      <span
        aria-hidden="true"
        className={cx(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-pill border border-hairline",
          "tabular bg-ink-900 font-mono text-meta text-paper-300 sm:size-10",
        )}
      >
        {String(n).padStart(2, "0")}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Eyebrow>{eyebrow}</Eyebrow>
          {aside}
        </div>
        <h3 className="text-lede text-paper-100">
          <span className="sr-only">{`Step ${n}. `}</span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  );
}

/** A quiet nested well, for anything that is a readout rather than a control. */
function Well({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-core-sm border border-hairline bg-ink-900 p-4", className)}>
      {children}
    </div>
  );
}

/** Label for the chosen preset, or null when the id is not one we were given. */
function presetLabel(presets: Capabilities["presets"], id: string): string | null {
  const found = presets.find((p) => p.id === id);
  return found === undefined ? null : found.label;
}

// ── style presets ────────────────────────────────────────────────────────────

interface PresetCardsProps {
  presets: Capabilities["presets"];
  value: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}

/**
 * Radio semantics over cards: one tab stop for the group, arrow keys between
 * options, and focus follows the selection so a screen reader hears the card it
 * just landed on rather than the one it left.
 */
function PresetCards({ presets, value, disabled, onSelect }: PresetCardsProps) {
  const cards = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const activeIndex = Math.max(
    0,
    presets.findIndex((p) => p.id === value),
  );

  const go = (index: number) => {
    const n = presets.length;
    if (n === 0) return;
    const next = presets[((index % n) + n) % n];
    onSelect(next.id);
    cards.current[next.id]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      go(activeIndex + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      go(activeIndex - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(presets.length - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Visual style preset"
      onKeyDown={onKeyDown}
      className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4"
    >
      {presets.map((preset) => {
        const selected = preset.id === value;
        return (
          <button
            key={preset.id}
            ref={(el) => {
              cards.current[preset.id] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onSelect(preset.id)}
            className={cx(
              "flex flex-col gap-3 rounded-shell-sm border p-4 text-left",
              "transition-[background-color,border-color,box-shadow] duration-200 ease-settle",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-300",
              "disabled:pointer-events-none disabled:opacity-45",
              selected
                ? "border-hairline-ember bg-ink-800 shadow-ember"
                : "border-hairline bg-ink-900 hover:border-hairline-strong hover:bg-ink-850",
            )}
          >
            <span className="flex items-start justify-between gap-3">
              <span
                className={cx(
                  "font-mono text-label uppercase tracking-console",
                  selected ? "text-ember-200" : "text-paper-200",
                )}
              >
                {preset.label}
              </span>
              {selected ? (
                <span
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center rounded-pill bg-ember-400 text-ink-1000"
                >
                  <Icon name="check" size={12} />
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className="size-5 shrink-0 rounded-pill border border-hairline-strong"
                />
              )}
            </span>
            <span className="text-meta text-paper-400">{preset.blurb}</span>
            {/* The one inline colour in this panel: the values are data. */}
            <span aria-hidden="true" className="mt-auto flex gap-1 pt-1">
              {preset.swatches.map((swatch, i) => (
                <span
                  key={`${preset.id}-${swatch}-${i}`}
                  style={{ backgroundColor: swatch }}
                  className="h-4 flex-1 rounded-chip border border-hairline"
                />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── panel ────────────────────────────────────────────────────────────────────

export default function SetupPanel({
  project,
  capabilities,
  action,
  onUpload,
  onRemoveUploads,
  onChange,
  onStart,
  onCancel,
}: SetupPanelProps) {
  const headingId = useDomId("setup");
  const briefHelpId = useDomId("brief-help");
  const startHelpId = useDomId("start-help");

  const [dragging, setDragging] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const uploads = project.uploads;
  const slotsLeft = Math.max(0, MAX_IMAGES - uploads.length);
  const hasUploads = uploads.length > 0 || project.uploadedAudio !== null;
  /** A run in flight cannot absorb configuration changes, so they freeze. */
  const configLocked = project.running;

  // The textarea keeps its own draft while focused. The shell may echo a patch
  // back a keystroke or two late, and adopting that echo mid-sentence would
  // rewind the caret; once focus leaves, the project is authoritative again.
  const [focusedBrief, setFocusedBrief] = React.useState(false);
  const [draft, setDraft] = React.useState(project.brief);
  const [seenBrief, setSeenBrief] = React.useState(project.brief);
  if (!focusedBrief && project.brief !== seenBrief) {
    setSeenBrief(project.brief);
    setDraft(project.brief);
  }

  // Patching on every keystroke put a request permanently in flight while
  // somebody typed, and a request in flight disables the primary action, so
  // "Direct this film" flickered off and on mid-sentence. The draft above still
  // moves with the keyboard; the shell only hears the value once typing settles,
  // and immediately on blur so a sentence is never lost to a quick click away.
  const briefTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBrief = React.useRef<string | null>(null);

  const sendBrief = () => {
    if (briefTimer.current !== null) {
      clearTimeout(briefTimer.current);
      briefTimer.current = null;
    }
    const brief = pendingBrief.current;
    // Nothing pending means the field was only visited, not edited, and a blur
    // on its own is not worth a request.
    if (brief === null) return;
    pendingBrief.current = null;
    onChange({ brief });
  };

  const queueBrief = (next: string) => {
    pendingBrief.current = next;
    if (briefTimer.current !== null) clearTimeout(briefTimer.current);
    briefTimer.current = setTimeout(sendBrief, BRIEF_PATCH_MS);
  };

  // A timer that outlived the panel would patch a project nobody is watching.
  React.useEffect(() => {
    return () => {
      if (briefTimer.current !== null) clearTimeout(briefTimer.current);
    };
  }, []);

  const mode: "generated" | "uploaded" = project.mode === "uploaded" ? "uploaded" : "generated";
  const presets = capabilities?.presets ?? [];
  const profiles = capabilities?.profiles ?? [];
  const selectedProfile =
    profiles.length > 0 ? (profiles.find((p) => p.name === project.profile) ?? profiles[0]) : null;
  const chosenPreset = presetLabel(presets, project.preset);


  const missingSong = mode === "uploaded" && project.uploadedAudio === null;
  const startBlocked = action.busy || project.running || !project.consent;
  const blockReason = !project.consent
    ? "Confirm the rights in step 05 before a run can start."
    : action.busy
      ? "Waiting on the last request to come back."
      : null;

  // ── uploads ────────────────────────────────────────────────────────────────

  const takeImages = (list: FileList | null) => {
    const chosen = list === null ? [] : Array.from(list);
    if (chosen.length === 0) return;

    const usable = chosen.filter(isUsableImage);
    const fitting = usable.slice(0, slotsLeft);
    const parts: string[] = [];

    if (fitting.length > 0) {
      onUpload({ images: fitting, audio: null });
      parts.push(`${fitting.length} photograph${fitting.length === 1 ? "" : "s"} added`);
    }
    const wrongType = chosen.length - usable.length;
    if (wrongType > 0) parts.push(`${wrongType} ignored, not a JPEG, PNG or WebP`);
    const overflow = usable.length - fitting.length;
    if (overflow > 0) parts.push(`${overflow} ignored, the set holds ${MAX_IMAGES}`);

    setNotice(`${parts.join(". ")}.`);
  };

  const onPickImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    takeImages(e.target.files);
    // Clearing lets the same file be chosen again after a removal.
    e.target.value = "";
  };

  const onPickAudio = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files === null ? null : e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setNotice("That file is not audio, so it was ignored.");
      return;
    }
    onUpload({ images: [], audio: file });
    setNotice(`Song attached, ${formatBytes(file.size)}.`);
  };

  const onDropImages = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    if (configLocked) return;
    takeImages(e.dataTransfer.files);
  };

  // ── header status ──────────────────────────────────────────────────────────

  const runFailed = project.status === "FAILED" || project.error !== null;
  const statusBadge = project.running ? (
    <Badge tone="live">{project.runningKind ?? "running"}</Badge>
  ) : project.reel !== null ? (
    <Badge tone="ok">reel ready</Badge>
  ) : runFailed ? (
    <Badge tone="fail">run failed</Badge>
  ) : (
    <Badge tone="neutral">{project.status === "" ? "draft" : project.status}</Badge>
  );

  return (
    <Panel tone="raised" padding="lg" enter>
      <section aria-labelledby={headingId} className="flex flex-col gap-8">
        <header className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Eyebrow tone="ember">the setup</Eyebrow>
            <div aria-live="polite" className="flex flex-wrap items-center gap-2">
              {statusBadge}
              {capabilities === null ? <Badge tone="neutral">reading engine</Badge> : null}
            </div>
          </div>
          <Display id={headingId} level={2}>
            Six steps to a finished reel.
          </Display>
          <p className="max-w-prose text-lede text-paper-300">
            Your photographs go in. Thirty vertical seconds come out, scored and cut
            to the beat, out.
          </p>
        </header>

        <ol className="flex flex-col gap-7">
          {/* ── 01 references ──────────────────────────────────────────────── */}
          <Step
            n={1}
            eyebrow="references"
            title="Give MUSE the photographs it should draw from."
            aside={
              <span className="tabular font-mono text-meta text-paper-400">
                {uploads.length} of {MAX_IMAGES}
              </span>
            }
          >
            <label
              onDragOver={(e) => {
                e.preventDefault();
                if (!configLocked && slotsLeft > 0) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDropImages}
              className={cx(
                "flex flex-col items-center justify-center gap-3 rounded-shell-sm border border-dashed",
                "px-5 py-8 text-center transition-[background-color,border-color] duration-200",
                "ease-settle has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
                "has-[:focus-visible]:outline-ember-300",
                dragging
                  ? "border-ember-400 bg-ember-900"
                  : "border-ink-600 bg-ink-900 hover:border-hairline-strong hover:bg-ink-850",
                configLocked || slotsLeft === 0 ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              )}
            >
              <input
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                disabled={configLocked || slotsLeft === 0}
                onChange={onPickImages}
                className="sr-only"
              />
              <span className="grid size-11 place-items-center rounded-pill border border-hairline bg-ink-850 text-ember-300">
                <Icon name="upload" size={18} />
              </span>
              <span className="font-mono text-label uppercase tracking-console text-paper-100">
                {slotsLeft === 0
                  ? "Reference set is full"
                  : dragging
                    ? "Release to add them"
                    : "Drop photographs, or browse"}
              </span>
              <span className="font-mono text-meta text-paper-400">
                JPEG, PNG or WebP. Up to {MAX_IMAGES}.
              </span>
            </label>

            <p aria-live="polite" className="min-h-5 font-mono text-meta text-paper-400">
              {notice}
            </p>

            {uploads.length > 0 ? (
              <ul className="flex flex-wrap gap-3">
                {uploads.map((upload, i) => (
                  <li key={upload.id} className="flex flex-col items-center gap-1.5">
                    <span className="block size-16 overflow-hidden rounded-core-sm border border-hairline bg-ink-950 sm:size-20">
                      {/* Uploads are local blobs served by a route, so no optimiser applies. */}
                      <img
                        src={upload.url}
                        alt={`Reference photograph ${i + 1}`}
                        loading="lazy"
                        decoding="async"
                        className="size-full object-cover"
                      />
                    </span>
                    <span className="tabular font-mono text-meta text-paper-400">
                      {formatBytes(upload.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Well className="flex items-start gap-3">
                <span className="mt-0.5 text-ember-300">
                  <Icon name="sparkle" size={15} />
                </span>
                <p className="text-meta text-paper-300">
                  No photographs yet, and that is a supported path. MUSE will compose the imagery
                  from the preset instead, so the reel still gets a full shot list.
                </p>
              </Well>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <label
                className={cx(
                  "inline-flex items-center gap-2.5 rounded-pill border border-dashed border-ink-600",
                  "bg-ink-900 px-3.5 py-2 font-mono text-micro uppercase tracking-console text-paper-300",
                  "transition-[background-color,border-color,color] duration-200 ease-settle",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
                  "has-[:focus-visible]:outline-ember-300",
                  configLocked
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer hover:border-hairline-strong hover:bg-ink-850 hover:text-paper-100",
                )}
              >
                <input
                  type="file"
                  accept="audio/*"
                  disabled={configLocked}
                  onChange={onPickAudio}
                  className="sr-only"
                />
                <Icon name="music" size={14} />
                {project.uploadedAudio === null ? "Add a song, optional" : "Replace the song"}
              </label>

              {hasUploads ? (
                <Button
                  variant="quiet"
                  size="sm"
                  trailingIcon="close"
                  disabled={configLocked}
                  onClick={onRemoveUploads}
                >
                  Clear uploads
                </Button>
              ) : null}
            </div>

            {project.uploadedAudio !== null ? (
              <Well className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge tone="ok">song attached</Badge>
                  <span className="tabular font-mono text-meta text-paper-400">
                    {formatBytes(project.uploadedAudio.bytes)}
                  </span>
                </div>
                <audio
                  controls
                  preload="metadata"
                  src={project.uploadedAudio.url}
                  aria-label="Uploaded song"
                  className="h-10 w-full max-w-96"
                />
              </Well>
            ) : null}
          </Step>

          {/* ── 02 style ───────────────────────────────────────────────────── */}
          <Step
            n={2}
            eyebrow="style"
            title="Choose the stock the whole reel is graded to."
            aside={
              chosenPreset === null ? null : (
                <span className="font-mono text-meta text-paper-400">{chosenPreset}</span>
              )
            }
          >
            {capabilities === null ? (
              <Well className="flex items-center gap-3">
                <Spinner size={15} />
                <p aria-live="polite" className="font-mono text-meta text-paper-400">
                  Reading the presets this machine can render.
                </p>
              </Well>
            ) : presets.length === 0 ? (
              <Well>
                <p className="text-meta text-paper-300">
                  The engine reported no presets, so MUSE will grade with its built-in look.
                </p>
              </Well>
            ) : (
              <PresetCards
                presets={presets}
                value={project.preset}
                disabled={configLocked}
                onSelect={(preset) => onChange({ preset })}
              />
            )}
          </Step>

          {/* ── 03 direction ───────────────────────────────────────────────── */}
          <Step
            n={3}
            eyebrow="direction"
            title="Say what the film is about, in one sentence."
            aside={draft.length >= BRIEF_WARN_AT ? <Badge tone="warn">near limit</Badge> : null}
          >
            <Field label="Brief">
              <Textarea
                value={draft}
                maxLength={BRIEF_MAX}
                rows={3}
                disabled={configLocked}
                placeholder={BRIEF_PLACEHOLDER}
                aria-describedby={briefHelpId}
                onFocus={() => setFocusedBrief(true)}
                onBlur={() => {
                  sendBrief();
                  setFocusedBrief(false);
                }}
                onChange={(e) => {
                  setDraft(e.target.value);
                  queueBrief(e.target.value);
                }}
              />
            </Field>

            <div
              id={briefHelpId}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
            >
              <p className="max-w-prose text-meta text-paper-400">
                One line is plenty. MUSE reads it for mood, place and time of day, then writes the
                shot list from there.
              </p>
              <span className="tabular font-mono text-meta text-paper-400">
                {draft.length}/{BRIEF_MAX}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="overflow-x-auto py-1">
                <Segmented
                  options={MODE_OPTIONS}
                  value={mode}
                  label="Where the music comes from"
                  onChange={(next) => onChange({ mode: next })}
                />
              </div>
              {missingSong ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone="warn">no song yet</Badge>
                  <span className="text-meta text-paper-300">
                    Add one in step 01, or switch back to Make everything.
                  </span>
                </span>
              ) : mode === "generated" && project.uploadedAudio !== null ? (
                <span className="text-meta text-paper-400">
                  A song is attached but unused. Switch to Bring your song to cut to it.
                </span>
              ) : null}
            </div>
          </Step>

          {/* ── 04 engine ──────────────────────────────────────────────────── */}
          {/*
            MUSE chooses its own routes. How much of a reel is generated by a model
            rather than computed locally is an operator decision, made from the
            remaining ceiling on the server — not something to hand a person who
            wants a film. Presenting it as a choice invited exactly the wrong
            question: "how much should I spend?" instead of "what should it look
            like?". What was spent, and on what, is still shown afterwards in
            Diagnostics, where it belongs.
          */}
          <Step
            n={4}
            eyebrow="engine"
            title="MUSE picks its own models."
            aside={
              capabilities !== null && !capabilities.hasApiKey ? (
                <Badge tone="local">local engine</Badge>
              ) : selectedProfile !== null ? (
                <Badge tone="live">{selectedProfile.label}</Badge>
              ) : null
            }
          >
            {capabilities === null ? (
              <Well className="flex items-center gap-3">
                <Spinner size={15} />
                <p aria-live="polite" className="font-mono text-meta text-paper-400">
                  Reading routes and capabilities.
                </p>
              </Well>
            ) : !capabilities.hasApiKey ? (
              <Well className="flex flex-col gap-2">
                <Badge tone="local">local engine</Badge>
                <p className="max-w-prose text-meta text-paper-200">
                  No API key is present, so every step runs deterministically on this machine
                  with no network calls: the same reel, at the same timings, every time.
                </p>
              </Well>
            ) : (
              <Well className="flex flex-col gap-2">
                <p className="max-w-prose text-meta text-paper-200">
                  {selectedProfile === null
                    ? "MUSE will run its deterministic local path."
                    : selectedProfile.blurb}
                </p>
                <p className="max-w-prose text-meta text-paper-400">
                  Anything a model cannot deliver is computed locally instead, so the reel
                  always finishes.
                </p>
              </Well>
            )}
          </Step>

          {/* ── 05 consent ─────────────────────────────────────────────────── */}
          <Step
            n={5}
            eyebrow="consent"
            title="Confirm these images are yours to use."
            aside={
              project.consent ? <Badge tone="ok">confirmed</Badge> : <Badge tone="warn">required</Badge>
            }
          >
            <Well className="flex flex-col gap-3">
              <Toggle
                checked={project.consent}
                disabled={configLocked}
                onChange={(consent) => onChange({ consent })}
                className="text-left"
              >
                <span className="text-meta normal-case tracking-normal text-paper-100">
                  I have the rights to these images and permission to portray anyone in them.
                </span>
              </Toggle>
              <p className="text-meta text-paper-400">
                Nothing renders until this is on. MUSE never starts a run without it.
              </p>
            </Well>
          </Step>

          {/* ── 06 action ──────────────────────────────────────────────────── */}
          <Step
            n={6}
            eyebrow="action"
            title="Roll camera."
            aside={
              project.running ? (
                <span className="flex items-center gap-2 font-mono text-meta uppercase tracking-console text-ember-300">
                  <Spinner size={13} />
                  {project.runningKind ?? "working"}
                </span>
              ) : null
            }
          >
            {project.running ? (
              <div className="flex flex-wrap items-center gap-4">
                <Button variant="danger" size="lg" trailingIcon="close" onClick={onCancel}>
                  Stop
                </Button>
                <p aria-live="polite" className="font-mono text-meta text-paper-300">
                  {`Running ${project.runningKind ?? "the film"}. Progress is narrated in the console.`}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    size="lg"
                    trailingIcon="film"
                    loading={action.busy}
                    disabled={startBlocked}
                    aria-describedby={blockReason === null ? undefined : startHelpId}
                    onClick={() => onStart({ useAgent: false })}
                  >
                    Direct this film
                  </Button>
                  <Tooltip
                    side="top"
                    label="The director agent decides the order of work itself. Watch it think in the console."
                  >
                    <Button
                      variant="ghost"
                      size="lg"
                      trailingIcon="wand"
                      disabled={startBlocked}
                      aria-describedby={blockReason === null ? undefined : startHelpId}
                      onClick={() => onStart({ useAgent: true })}
                    >
                      Direct with the agent
                    </Button>
                  </Tooltip>
                </div>
                {blockReason === null ? null : (
                  <p
                    id={startHelpId}
                    className="flex items-center gap-2 font-mono text-meta text-signal-warn"
                  >
                    <Icon name="alert" size={13} />
                    {blockReason}
                  </p>
                )}
              </div>
            )}

            {action.error === null ? null : (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-core-sm border border-signal-fail/50 bg-signal-fail/10 p-4"
              >
                <Badge tone="fail">request failed</Badge>
                <p className="text-meta text-paper-100">{action.error}</p>
              </div>
            )}

            {project.error === null ? null : (
              <div className="flex flex-col gap-2 rounded-core-sm border border-signal-fail/50 bg-signal-fail/10 p-4">
                <Badge tone="fail">last run failed</Badge>
                <p className="text-meta text-paper-100">{project.error}</p>
              </div>
            )}

            {!project.running && project.reel !== null ? (
              <p className="flex items-center gap-2 font-mono text-meta text-signal-ok">
                <Icon name="check" size={13} />
                A reel is already cut. Directing again replaces it.
              </p>
            ) : null}
          </Step>
        </ol>
      </section>
    </Panel>
  );
}
