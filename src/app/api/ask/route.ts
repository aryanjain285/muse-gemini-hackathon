/**
 * Talk to MUSE about the memories it holds.
 *
 * A single request that made a film was the whole of Ask MUSE, which meant the only way to find
 * out what MUSE thought of your library was to commit to a thirty second render. This is the
 * conversation instead: it can be asked what is in there, what would cut together, what is
 * missing, and it answers from the actual records rather than from a general impression.
 *
 * Grounded on purpose. The library is passed in compactly on every turn and the instruction
 * forbids inventing a memory, because a assistant that confidently recalls a photograph you
 * never took is worse than one that says it cannot find it.
 */
import { z } from "zod";
import { bootstrap } from "@/lib/server/bootstrap";
import { body, handler, ok } from "@/lib/server/http";
import { Memories } from "@/lib/memory/store";
import { Assets, Projects } from "@/lib/db/repo";
import { route } from "@/lib/models/router";
import { generateContent, textOf, usageOf } from "@/lib/models/gemini";
import { profileFor } from "@/lib/core/config";
import { autoProfile } from "@/lib/server/views";
import { truncate } from "@/lib/core/util";

export const dynamic = "force-dynamic";

const TURN_LIMIT = 12;

const AskSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "muse"]),
        content: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(TURN_LIMIT),
});

/** What MUSE is allowed to know, small enough to send every turn. */
function libraryDigest(): string {
  const lines = Memories.list().map((m, i) => {
    const where = [m.event, m.location].filter(Boolean).join(", ");
    const who = m.people.length > 0 ? `${m.people.length} people` : "no people";
    return [
      `${i + 1}. "${m.title}"`,
      where ? `(${where})` : "",
      `— ${truncate(m.description, 150)}`,
      `[${who}; mood: ${m.mood.slice(0, 3).join("/") || "unstated"}]`,
      m.userNote ? `Owner's note: "${truncate(m.userNote, 120)}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
  });
  return lines.length > 0 ? lines.join("\n") : "(the library is empty)";
}

/** Films that already exist, so it does not offer to make one that is sitting there. */
function filmsDigest(): string {
  const made = Projects.list(12)
    .filter((p) => Assets.byRole(p.id, "final", "reel"))
    .map((p) => `- "${p.title}" (${p.status.toLowerCase()})`);
  return made.length > 0 ? made.join("\n") : "(no finished films yet)";
}

const SYSTEM = [
  "You are MUSE: a director who keeps somebody's photographs and turns them into short films.",
  "You are talking to the person those photographs belong to. Be warm, brief and concrete.",
  "",
  "Rules:",
  "1. Only ever refer to memories in the library below. Never invent one, never imply you have seen a photograph that is not listed. If they ask about something that is not there, say so and name what is.",
  "2. Quote the owner's own notes back to them when relevant — those are the truest thing you have.",
  "3. Keep replies to about sixty words unless asked for more. This is a conversation, not an essay.",
  "4. When they seem ready to make something, say which memories you would use and why, in one sentence each. Do not claim to have started it — the button does that.",
  "5. Never mention model names, token counts, budgets or internal machinery. Talk about photographs and films.",
].join("\n");

export const POST = handler("ask.chat", async (req: Request) => {
  bootstrap();
  const input = await body(req, AskSchema);
  const profile = profileFor(autoProfile());

  const transcript = input.messages
    .map((m) => `${m.role === "user" ? "Them" : "You"}: ${m.content.trim()}`)
    .join("\n");

  const user = [
    "The library:",
    libraryDigest(),
    "",
    "Films already made:",
    filmsDigest(),
    "",
    "The conversation so far:",
    transcript,
    "",
    "Reply as MUSE, to the last thing they said.",
  ].join("\n");

  const result = await route<string>({
    task: "director",
    projectId: null,
    identity: { kind: "ask-chat-v1", transcript, library: libraryDigest() },
    hint: { inputTokens: 900, outputTokens: 220, thoughtTokens: 80 },
    profile,
    logger: undefined,
    // With no key or no budget there is still something useful to say, and it is drawn from the
    // same records rather than made up: what is in the library, and what it would suggest.
    local: async () => {
      const count = Memories.list().length;
      if (count === 0) {
        return "There is nothing in your library yet. Import a few photographs and I will tell you what I can see in them.";
      }
      const titles = Memories.list()
        .slice(0, 4)
        .map((m) => `"${m.title}"`)
        .join(", ");
      return `I am holding ${count} ${count === 1 ? "memory" : "memories"} — ${titles}. Ask me which of them belong in the same film, or press the button and I will cut one.`;
    },
    real: async (model) => {
      const res = await generateContent(
        model,
        {
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.7,
            // Generous, because thinking tokens are drawn from the same allowance: at 400 the
            // model spent them reasoning and the reply arrived cut off mid-sentence — "they
            // capture the quiet rhythm of the entire trip, from". A chat that stops talking
            // half way through a clause looks broken in a way a slow one does not.
            maxOutputTokens: 1200,
            thinkingConfig: { thinkingLevel: "low" },
          },
        },
        { timeoutMs: 45_000, attempts: 2 },
      );
      const said = textOf(res).trim();
      if (!said) throw new Error("empty reply");
      return { value: said, usage: usageOf(res), modelVersion: res.modelVersion };
    },
  });

  return ok({
    reply: result.value,
    route: result.route,
    memories: Memories.views().length,
  });
});
