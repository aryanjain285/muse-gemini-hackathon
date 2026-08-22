"use client";

/**
 * The single entry point into the studio. Creating a project is one click, with
 * the preset and mode chosen here so the studio opens already pointed at the
 * right template rather than presenting an empty form.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Eyebrow, Icon, Segmented, cx } from "@/components/ui/primitives";

export interface PresetOption {
  id: string;
  label: string;
  blurb: string;
  swatches: string[];
}

export interface BeginFormProps {
  presets: PresetOption[];
  hasApiKey: boolean;
}

type Mode = "generated" | "uploaded";

export default function BeginForm({ presets, hasApiKey }: BeginFormProps) {
  const router = useRouter();
  const [preset, setPreset] = useState(presets[0]?.id ?? "dreamy_animated_memories");
  const [mode, setMode] = useState<Mode>("generated");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, preset, brief: "" }),
      });
      const data = (await res.json()) as { project?: { id: string }; error?: string };
      if (!res.ok || !data.project) throw new Error(data.error ?? "could not create the project");
      router.push(`/studio/${data.project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-8">
      {/* Mode is the first real decision, so it sits above the style choice. */}
      <div className="w-full max-w-md">
        <Segmented
          label="How the soundtrack is made"
          value={mode}
          onChange={setMode}
          options={[
            { value: "generated", label: "Make everything", detail: "score composed for the story" },
            { value: "uploaded", label: "Bring your song", detail: "cut to your track" },
          ]}
        />
      </div>

      <fieldset className="w-full">
        <legend className="sr-only">Choose a visual style</legend>
        <div className="mb-3 flex items-center justify-center">
          <Eyebrow tone="dim">Style</Eyebrow>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {presets.map((p) => {
            const selected = p.id === preset;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setPreset(p.id)}
                className={cx(
                  "group rounded-shell border p-1.5 text-left transition-all duration-500",
                  "ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ember-500/60",
                  selected
                    ? "border-hairline-ember bg-ember-500/5"
                    : "border-hairline bg-ink-900/60 hover:border-hairline-strong",
                )}
              >
                <span className="block rounded-core bg-ink-950/80 p-4">
                  <span className="mb-3 flex gap-1" aria-hidden="true">
                    {p.swatches.slice(0, 5).map((hex, i) => (
                      <span
                        key={`${p.id}-${i}`}
                        className="h-1.5 flex-1 rounded-pill"
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                  </span>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-sans text-sm font-medium text-paper-100">{p.label}</span>
                    {selected ? (
                      <Icon name="check" size={13} className="shrink-0 text-ember-400" />
                    ) : null}
                  </span>
                  <span className="mt-1 block font-sans text-[11px] leading-relaxed text-paper-400">
                    {p.blurb}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col items-center gap-4">
        <Button
          size="lg"
          variant="primary"
          onClick={begin}
          loading={busy}
          disabled={busy}
          trailingIcon="chevron"
        >
          {busy ? "Opening the studio" : "Begin"}
        </Button>

        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-mono text-[11px] text-paper-500">
          {hasApiKey ? (
            <Badge tone="live">gemini live</Badge>
          ) : (
            <Badge tone="local">local engine</Badge>
          )}
          <span aria-hidden="true">·</span>
          <span>9:16 · 1080&times;1920 · 30s</span>
        </div>

        {error ? (
          <p role="alert" className="font-sans text-xs text-signal-fail">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
