/**
 * Server-sent progress stream. A late or reconnecting client replays everything
 * it missed from the project's buffer before receiving anything new, so the UI is
 * correct even when the render started before the page was opened.
 */
import { bootstrap } from "@/lib/server/bootstrap";
import { fail, handler, num } from "@/lib/server/http";
import { Projects } from "@/lib/db/repo";
import { subscribe, type Envelope } from "@/lib/jobs/bus";
import { isRunning } from "@/lib/jobs/runner";
import { projectView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler("project.status", async (req: Request, ctx: Ctx) => {
  bootstrap();
  const { id } = await ctx.params;
  if (!Projects.get(id)) return fail("project not found", 404);

  const since = num(req, "since", 0);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      // The first frame is the whole project, so a client needs exactly one
      // request to render a correct screen.
      send("snapshot", { project: projectView(id), running: isRunning(id) });

      unsubscribe = subscribe(
        id,
        (env: Envelope) => send("progress", { id: env.id, at: env.at, ...env.event }),
        since,
      );

      // Proxies drop idle connections; a comment frame keeps it warm without
      // producing an event the client has to handle.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
