"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { MemoryView } from "@/lib/memory/types";
import { Badge, Button, Input, Textarea } from "@/components/ui/primitives";

export default function MemoryGallery({ initial }: { initial: MemoryView[] }) {
  const [memories, setMemories] = useState(initial);
  const [query, setQuery] = useState("");
  const [context, setContext] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<MemoryView | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memories;
    const words = q.split(/\s+/).filter(Boolean);
    return memories.filter((m) => words.every((w) => m.searchText.toLowerCase().includes(w)));
  }, [memories, query]);

  function openMemory(memory: MemoryView) {
    setSelected(memory);
    setNoteDraft(memory.userNote ?? "");
    setError("");
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      for (const file of Array.from(files).slice(0, 12)) form.append("images", file);
      form.append("context", context);
      const res = await fetch("/api/memories", { method: "POST", body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "could not import memories");
      const added = Array.isArray(json?.memories) ? (json.memories as MemoryView[]) : [];
      const duplicateCount = Array.isArray(json?.duplicates) ? json.duplicates.length : 0;
      const rejectedCount = Array.isArray(json?.rejected) ? json.rejected.length : 0;
      if (added.length > 0) {
        setMemories((old) => [...added, ...old.filter((m) => !added.some((a) => a.id === m.id))]);
      }
      const parts = [
        added.length ? `${added.length} remembered` : "",
        duplicateCount ? `${duplicateCount} already in your library` : "",
        rejectedCount ? `${rejectedCount} could not be imported` : "",
      ].filter(Boolean);
      setNotice(parts.join(" · "));
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function saveNote() {
    if (!selected) return;
    setSavingNote(true);
    setError("");
    try {
      const res = await fetch(`/api/memories/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userNote: noteDraft.slice(0, 700) }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "could not save this memory");
      const updated = json.memory as MemoryView;
      setMemories((old) => old.map((m) => (m.id === updated.id ? updated : m)));
      setSelected(updated);
      setNoteDraft(updated.userNote ?? "");
      setNotice("Memory updated. MUSE will use this note when choosing and directing future films.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNote(false);
    }
  }

  async function remove(memory: MemoryView) {
    if (!confirm(`Remove “${memory.title}” from MUSE memories?`)) return;
    setError("");
    const res = await fetch(`/api/memories/${memory.id}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setError(json?.error ?? "could not remove this memory");
      return;
    }
    setMemories((old) => old.filter((m) => m.id !== memory.id));
    setSelected(null);
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 rounded-shell border border-hairline bg-ink-900/50 p-4 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <label className="font-mono text-[11px] uppercase tracking-[0.16em] text-paper-500">Search your memories</label>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="mountains, the three of us, the last morning…"
            className="mt-2"
          />
        </div>
        <Link
          href={`/ask${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`}
          className="rounded-pill border border-hairline-ember bg-ember-500/10 px-5 py-3 text-center font-sans text-[13px] text-ember-200 hover:bg-ember-500/15"
        >
          Ask MUSE →
        </Link>
      </div>

      <div className="rounded-shell border border-dashed border-hairline bg-ink-950/50 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-end">
          <div className="min-w-0 flex-1">
            <p className="font-display text-xl text-paper-100">Add memories</p>
            <p className="mt-1 max-w-2xl font-sans text-[13px] leading-relaxed text-paper-500">
              Give MUSE a little context once. Gemini turns each photograph into agent-readable memory metadata stored locally beside the image.
            </p>
            <Input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Winter family trip to Gangtok, Sikkim…"
              className="mt-3"
            />
          </div>
          <div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
              className="hidden"
              onChange={(e) => void upload(e.target.files)}
            />
            <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
              {uploading ? "Remembering…" : "Import photos"}
            </Button>
          </div>
        </div>
        {error ? <p className="mt-4 font-sans text-[12px] text-signal-fail">{error}</p> : null}
        {notice ? <p className="mt-4 font-sans text-[12px] text-paper-400">{notice}</p> : null}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-shell border border-hairline bg-ink-900/30 px-6 py-16 text-center">
          <p className="font-display text-2xl text-paper-200">No memories here yet.</p>
          <p className="mt-2 font-sans text-[13px] text-paper-500">Import a few photographs and tell MUSE what they belong to.</p>
        </div>
      ) : (
        <ul className="grid list-none gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((memory) => (
            <li key={memory.id}>
              <button
                type="button"
                onClick={() => openMemory(memory)}
                className="group block w-full overflow-hidden rounded-shell border border-hairline bg-ink-900/50 p-1.5 text-left transition-colors hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
              >
                <div className="overflow-hidden rounded-core bg-ink-1000">
                  <div className="aspect-[4/5] overflow-hidden">
                    <img
                      src={`${memory.imageUrl}?w=320`}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.035]"
                    />
                  </div>
                  <div className="p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="line-clamp-1 font-display text-xl text-paper-50">{memory.title}</h2>
                      {memory.provenance.observedBy === "gemini" ? <Badge tone="ok">understood</Badge> : null}
                    </div>
                    <p className="mt-1 line-clamp-2 font-sans text-[12px] leading-relaxed text-paper-400">{memory.userNote || memory.description}</p>
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-paper-600">
                      {[memory.location, memory.event, ...memory.mood.slice(0, 1)].filter(Boolean).join(" · ") || "Personal memory"}
                    </p>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-1000/75 p-3 backdrop-blur-sm md:items-center" onClick={() => setSelected(null)}>
          <div className="grid max-h-[92vh] w-full max-w-4xl overflow-auto rounded-shell border border-hairline bg-ink-950 p-2 md:grid-cols-[minmax(260px,0.8fr)_1.2fr]" onClick={(e) => e.stopPropagation()}>
            <div className="overflow-hidden rounded-core bg-ink-1000">
              <img
                src={`${selected.imageUrl}?w=1024`}
                alt=""
                decoding="async"
                className="h-full max-h-[70vh] w-full object-cover"
              />
            </div>
            <div className="flex flex-col p-5 md:p-7">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ember-300">Memory</p>
              <h2 className="mt-2 font-display text-3xl text-paper-50">{selected.title}</h2>
              <p className="mt-4 font-sans text-[14px] leading-7 text-paper-300">{selected.description}</p>

              <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-hairline pt-5 text-[12px]">
                <div><dt className="font-mono uppercase tracking-wider text-paper-600">Place</dt><dd className="mt-1 text-paper-200">{selected.location || selected.setting || "Unknown"}</dd></div>
                <div><dt className="font-mono uppercase tracking-wider text-paper-600">Moment</dt><dd className="mt-1 text-paper-200">{selected.event || "Personal memory"}</dd></div>
                <div><dt className="font-mono uppercase tracking-wider text-paper-600">People</dt><dd className="mt-1 text-paper-200">{selected.people.join(" · ") || "Not named"}</dd></div>
                <div><dt className="font-mono uppercase tracking-wider text-paper-600">Mood</dt><dd className="mt-1 text-paper-200">{selected.mood.join(" · ") || "—"}</dd></div>
              </dl>

              <div className="mt-6 rounded-core border border-hairline-ember bg-ember-500/5 p-4">
                <label className="font-mono text-[10px] uppercase tracking-[0.14em] text-ember-300">What you remember</label>
                <Textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  rows={4}
                  maxLength={700}
                  placeholder="We had been waiting three days for this."
                  className="mt-2"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="font-sans text-[11px] leading-relaxed text-paper-600">Owner-written notes are treated as ground truth when MUSE makes future films.</p>
                  <Button size="sm" onClick={() => void saveNote()} disabled={savingNote || noteDraft === selected.userNote}>
                    {savingNote ? "Saving…" : "Save memory"}
                  </Button>
                </div>
              </div>

              {error ? <p className="mt-4 font-sans text-[12px] text-signal-fail">{error}</p> : null}

              <div className="mt-auto flex flex-wrap gap-2 pt-7">
                <Link href={`/ask?q=${encodeURIComponent(`Make a film around ${selected.title}${selected.event ? ` from ${selected.event}` : ""}`)}`} className="rounded-pill border border-hairline-ember bg-ember-500/10 px-4 py-2 font-sans text-[12px] text-ember-200">Make a film</Link>
                <Button variant="danger" size="sm" onClick={() => void remove(selected)}>
                  Remove
                </Button>
                <Button variant="quiet" size="sm" className="ml-auto" onClick={() => setSelected(null)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
