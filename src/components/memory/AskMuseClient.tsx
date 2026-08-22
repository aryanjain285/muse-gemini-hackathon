"use client";

/**
 * Ask MUSE: a conversation about the photographs it keeps, and a film at the end of it.
 *
 * It used to be one box and one button — the only way to learn what MUSE made of your library
 * was to commit to a render. Now you can talk to it first, and make the film when the
 * conversation has decided what the film is.
 *
 * Built on the shared primitives. This screen originally carried its own buttons, its own pill
 * group and its own textarea — the same shapes the studio already had, drawn slightly
 * differently, so moving between the two felt like moving between two products.
 */
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Eyebrow, Panel, Segmented, Spinner, Textarea } from "@/components/ui/primitives";

const THEMES = [
  { value: "dreamy_animated_memories", label: "Dreamy" },
  { value: "neon_anime", label: "Neon anime" },
  { value: "retro_90s", label: "Retro 90s" },
  { value: "paper_collage", label: "Paper collage" },
] as const;

type Theme = (typeof THEMES)[number]["value"];

interface Turn {
  role: "user" | "muse";
  content: string;
}

interface Result {
  projectId: string;
  studioUrl: string;
  started: boolean;
  selectionSummary?: string;
  storyAngle?: string;
  existing?: boolean;
  reelUrl?: string;
  memories: {
    id: string;
    title: string;
    description: string;
    imageUrl: string;
    location: string | null;
    event: string | null;
  }[];
  story: string;
}

const OPENERS = [
  "What do you have of mine?",
  "Which of them belong in the same film?",
  "What is missing from this trip?",
];

/**
 * The model writes **bold** and *italics*, and rendering the asterisks raw looks like a bug.
 * Emphasis is the only markup worth honouring in a chat bubble, so it is the only one handled.
 */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold text-paper-50">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("*") && part.endsWith("*")) {
          return (
            <em key={i} className="italic text-paper-150">
              {part.slice(1, -1)}
            </em>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export default function AskMuseClient({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState(initialQuery);
  const [thinking, setThinking] = useState(false);
  const [preset, setPreset] = useState<Theme>("dreamy_animated_memories");
  const [making, setMaking] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, thinking]);

  const say = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || thinking) return;
      const next: Turn[] = [...turns, { role: "user", content: question }];
      setTurns(next);
      setDraft("");
      setThinking(true);
      setError("");
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The last dozen turns are enough context and keep the request small.
          body: JSON.stringify({ messages: next.slice(-12) }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? "MUSE could not answer that");
        setTurns([...next, { role: "muse", content: String(json.reply) }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setThinking(false);
      }
    },
    [turns, thinking],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void say(draft);
  };

  /** The brief is the conversation: whatever was actually asked for, in their words. */
  const makeFilm = useCallback(async () => {
    const asked = turns.filter((t) => t.role === "user").map((t) => t.content);
    const query = asked.join(" ") || draft.trim();
    if (!query) return;
    setMaking(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/memories/film", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, preset, autoStart: true, useAgent: true }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "MUSE could not start that film");
      setResult(json as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMaking(false);
    }
  }, [turns, draft, preset]);

  const canMake = turns.some((t) => t.role === "user") || draft.trim().length > 0;

  return (
    <div className="flex w-full max-w-3xl flex-col gap-7">
      <div>
        <Eyebrow tone="ember">Memory agent</Eyebrow>
        <h1 className="mt-3 font-display text-[clamp(2.2rem,5.5vw,3.8rem)] leading-[1] tracking-[-0.03em] text-paper-50">
          Ask MUSE to remember with you.
        </h1>
        <p className="mt-3 max-w-xl font-sans text-[14px] leading-7 text-paper-400">
          It knows what is in your library and nothing else. Talk to it, and when the
          conversation has found the film, it will cut one.
        </p>
      </div>

      {/* ── the conversation ──────────────────────────────────────────────────── */}
      <Panel tone="raised" padding="lg">
        {turns.length === 0 ? (
          <div className="flex flex-col gap-3">
            <Eyebrow>Try asking</Eyebrow>
            <ul className="flex list-none flex-wrap gap-2">
              {OPENERS.map((o) => (
                <li key={o}>
                  <Button variant="quiet" size="sm" onClick={() => void say(o)}>
                    {o}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="flex list-none flex-col gap-4">
            {turns.map((t, i) => (
              <li
                key={i}
                className={t.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                <div
                  className={`max-w-[85%] rounded-core px-4 py-3 font-sans text-[14px] leading-relaxed ${
                    t.role === "user"
                      ? "border border-hairline-ember bg-ember-500/10 text-paper-100"
                      : "border border-hairline bg-ink-1000 text-paper-200"
                  }`}
                >
                  {t.role === "muse" ? (
                    <span className="mb-1.5 block">
                      <Eyebrow tone="ember">MUSE</Eyebrow>
                    </span>
                  ) : null}
                  <p className="whitespace-pre-wrap">
                    <Rich text={t.content} />
                  </p>
                </div>
              </li>
            ))}
            {thinking ? (
              <li className="flex justify-start">
                <div className="flex items-center gap-3 rounded-core border border-hairline bg-ink-1000 px-4 py-3">
                  <Spinner size={13} />
                  <Eyebrow>thinking</Eyebrow>
                </div>
              </li>
            ) : null}
          </ol>
        )}
        <div ref={endRef} />

        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, shift+enter breaks the line: what every chat does.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void say(draft);
              }
            }}
            rows={2}
            placeholder="Ask about your memories…"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={thinking} disabled={!draft.trim()} size="sm">
              Send
            </Button>
            <span className="font-mono text-[10px] text-paper-700">
              enter sends · shift + enter for a new line
            </span>
          </div>
        </form>
      </Panel>

      {/* ── and then the film ─────────────────────────────────────────────────── */}
      <Panel tone="ink" padding="lg">
        <Eyebrow tone="ember">Make it a film</Eyebrow>
        <p className="mt-2 max-w-xl font-sans text-[13px] leading-relaxed text-paper-400">
          MUSE will choose the memories, write the story, compose a score and cut to it.
        </p>
        <div className="mt-5 flex flex-col gap-4">
          <Segmented
            label="Film style"
            options={THEMES.map((t) => ({ value: t.value, label: t.label }))}
            value={preset}
            onChange={setPreset}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={makeFilm} loading={making} disabled={!canMake} trailingIcon="wand">
              {making ? "Working" : "Make the film"}
            </Button>
            {!canMake ? (
              <span className="font-sans text-[12px] text-paper-600">
                Say something first, and it will use that.
              </span>
            ) : null}
          </div>
        </div>
      </Panel>

      {error ? <p className="font-sans text-[13px] text-signal-fail">{error}</p> : null}

      {result ? (
        <Panel tone="raised" padding="lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Eyebrow tone="ember">MUSE remembered</Eyebrow>
              <h2 className="mt-2 font-display text-3xl text-paper-50">
                {result.memories.length} memories make this film.
              </h2>
              <p className="mt-2 max-w-xl font-sans text-[13px] leading-relaxed text-paper-400">
                {result.selectionSummary || "These are the moments MUSE selected."}{" "}
                {result.existing
                  ? "It had already cut a film from exactly these photographs, so here it is."
                  : "The film is being directed in the background."}
              </p>
            </div>
            <Button variant="quiet" onClick={() => router.push(result.studioUrl)} trailingIcon="film">
              {result.existing ? "Open in the studio" : "Watch it being made"}
            </Button>
          </div>

          {result.existing && result.reelUrl ? (
            <figure className="mt-7">
              {/* Muted so the browser allows autoplay; the film carries its own score, so the
                  controls are on and a demo unmutes in one click. */}
              <video
                src={result.reelUrl}
                controls
                autoPlay
                muted
                loop
                playsInline
                className="mx-auto aspect-[9/16] w-full max-w-sm rounded-core border border-hairline bg-ink-1000 object-cover"
              />
              <figcaption className="mt-3 text-center">
                <Eyebrow>The film MUSE cut from these memories</Eyebrow>
              </figcaption>
            </figure>
          ) : null}

          <ul className="mt-7 grid list-none gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {result.memories.map((memory, index) => (
              <li
                key={memory.id}
                className="overflow-hidden rounded-core border border-hairline bg-ink-1000"
              >
                <div className="relative aspect-[4/5] overflow-hidden">
                  <img
                    src={`${memory.imageUrl}?w=320`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute left-2 top-2">
                    <Badge tone="neutral">{String(index + 1).padStart(2, "0")}</Badge>
                  </span>
                </div>
                <div className="p-3">
                  <p className="line-clamp-1 font-display text-lg text-paper-100">{memory.title}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
