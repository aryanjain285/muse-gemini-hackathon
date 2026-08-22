"use client";

/**
 * The studio's single source of truth.
 *
 * One EventSource per project carries both the opening snapshot and every
 * subsequent progress event, so a page opened mid-render shows the correct state
 * immediately rather than an empty shell that fills in later. Reconnection asks
 * for everything after the last event id it saw, so no progress is lost and
 * nothing is replayed twice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── event shapes, mirroring the server bus ───────────────────────────────────

export type StepState = "start" | "done" | "fail" | "fallback" | "skip";

export interface ProgressEvent {
  id: number;
  at: string;
  kind: string;
  [key: string]: unknown;
}

/**
 * The shot and project shapes come from the view model that produces them. They
 * were restated here once and the copies drifted the moment a field was added on
 * one side only. `import type` is erased at build time, so nothing server-side
 * reaches the client bundle.
 */
export type { ProjectView, SceneView } from "@/lib/server/views";
import type { ProjectView, SceneView } from "@/lib/server/views";

export interface ConsoleLine {
  id: number;
  at: string;
  /** Groups related lines under one heading. */
  channel: "stage" | "scene" | "music" | "agent" | "render" | "log" | "spec" | "qc" | "cost";
  label: string;
  detail: string;
  state: StepState | "info" | "warn" | "error";
  usd?: number;
}

export interface StreamState {
  project: ProjectView | null;
  connected: boolean;
  /** True from the first byte until the snapshot lands. */
  loading: boolean;
  error: string | null;
  console: ConsoleLine[];
  progress: { fraction: number; label: string } | null;
  lastEventId: number;
}

const MAX_CONSOLE = 300;

// ── event to console line ────────────────────────────────────────────────────

function toLine(e: ProgressEvent): ConsoleLine | null {
  const base = { id: e.id, at: e.at };
  switch (e.kind) {
    case "stage":
      return {
        ...base,
        channel: "stage",
        label: String(e.stage),
        detail: String(e.detail ?? ""),
        state: (e.state as StepState) ?? "info",
      };
    case "scene":
      return {
        ...base,
        channel: "scene",
        label: `${String(e.sceneId)} ${String(e.stage)}`,
        detail: String(e.fallbackReason ?? e.route ?? ""),
        state: (e.state as StepState) ?? "info",
      };
    case "music":
      return {
        ...base,
        channel: "music",
        label: "score",
        detail:
          e.bpm !== undefined
            ? `${String(e.bpm)} BPM via ${String(e.route ?? "local")}`
            : String(e.fallbackReason ?? e.route ?? ""),
        state: (e.state as StepState) ?? "info",
      };
    case "agent":
      return {
        ...base,
        channel: "agent",
        label: String(e.name || e.step),
        detail: String(e.summary ?? ""),
        state: e.step === "error" ? "error" : e.step === "tool_call" ? "start" : "done",
        ...(typeof e.usd === "number" ? { usd: e.usd } : {}),
      };
    case "render":
      return {
        ...base,
        channel: "render",
        label: "compose",
        detail: String(e.detail ?? (e.progress !== undefined ? `${Math.round(Number(e.progress) * 100)}%` : "")),
        state: (e.state as StepState) ?? "info",
      };
    case "spec":
      return {
        ...base,
        channel: "spec",
        label: `plan v${String(e.version)}`,
        detail: `"${String(e.title)}" — ${String(e.scenes)} scenes over ${String(e.durationS)}s`,
        state: "done",
      };
    case "qc":
      return {
        ...base,
        channel: "qc",
        label: `${String(e.sceneId)} critic`,
        detail: `${String(e.decision)} — ${String(e.note ?? "")}`,
        state: e.decision === "PASS" ? "done" : e.decision === "RETRY" ? "warn" : "fail",
      };
    case "log":
      return {
        ...base,
        channel: "log",
        label: String(e.level),
        detail: String(e.message ?? ""),
        state: e.level === "error" ? "error" : e.level === "warn" ? "warn" : "info",
      };
    case "error":
      return {
        ...base,
        channel: "log",
        label: "error",
        detail: String(e.message ?? ""),
        state: "error",
      };
    case "done":
      return {
        ...base,
        channel: "render",
        label: "reel ready",
        detail: `${String(e.durationS)}s exported`,
        state: "done",
      };
    // Cost and status changes update panels rather than narrating themselves.
    default:
      return null;
  }
}

// ── hook ─────────────────────────────────────────────────────────────────────

export interface UseProjectStream extends StreamState {
  /** Re-fetch the project without waiting for an event. */
  refresh: () => Promise<void>;
  /** Replace the project locally, e.g. after a mutation returns a fresh copy. */
  setProject: (p: ProjectView) => void;
  clearConsole: () => void;
}

export function useProjectStream(projectId: string): UseProjectStream {
  const [state, setState] = useState<StreamState>({
    project: null,
    connected: false,
    loading: true,
    error: null,
    console: [],
    progress: null,
    lastEventId: 0,
  });

  const lastIdRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);
  // A render that completes should pull the full project once, because scene
  // assets and the reel are not carried on the event itself.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        setState((s) => ({ ...s, error: detail.error ?? `project request failed (${res.status})` }));
        return;
      }
      const data = (await res.json()) as { project: ProjectView };
      setState((s) => ({ ...s, project: data.project, loading: false, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [projectId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    // Coalesce bursts: a scene finishing emits several events in a row.
    refreshTimer.current = setTimeout(() => void refresh(), 350);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const source = new EventSource(`/api/projects/${projectId}/status?since=${lastIdRef.current}`);
      sourceRef.current = source;

      source.addEventListener("open", () => {
        setState((s) => ({ ...s, connected: true, error: null }));
      });

      source.addEventListener("snapshot", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data) as { project: ProjectView };
          setState((s) => ({ ...s, project: data.project, loading: false }));
        } catch {
          /* a malformed frame is dropped rather than breaking the stream */
        }
      });

      source.addEventListener("progress", (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent<string>).data) as ProgressEvent;
          lastIdRef.current = Math.max(lastIdRef.current, e.id);

          setState((s) => {
            const line = toLine(e);
            const next: StreamState = {
              ...s,
              lastEventId: lastIdRef.current,
              ...(line
                ? { console: [...s.console, line].slice(-MAX_CONSOLE) }
                : {}),
            };

            // Cost events are still emitted — they are part of the event stream and the
            // audit trail — but nothing on screen reports spend any more, so parsing them
            // into state kept a figure updated for no reader.
            if (e.kind === "render") {
              // A failed compose has to clear the bar too. Only clearing it on "done"
              // left a stalled progress bar on screen after a failure, which reads as
              // still working — the state a person is least able to tell apart from
              // genuine slowness, and the one where they wait instead of retrying.
              const finished = e.state === "done" || e.state === "fail";
              next.progress = finished
                ? null
                : { fraction: Number(e.progress ?? 0), label: String(e.detail ?? "composing") };
            }
            if (e.kind === "status" && s.project) {
              next.project = { ...s.project, status: String(e.status) };
            }
            if (e.kind === "error") {
              next.error = String(e.message ?? "the run failed");
            }
            return next;
          });

          // Events that change stored assets warrant a full re-read.
          if (
            e.kind === "done" ||
            e.kind === "spec" ||
            e.kind === "error" ||
            (e.kind === "scene" && (e.state === "done" || e.state === "fallback" || e.state === "fail")) ||
            (e.kind === "music" && e.state !== "start") ||
            (e.kind === "status" && (e.status === "READY" || e.status === "FAILED"))
          ) {
            scheduleRefresh();
          }
        } catch {
          /* ignore a bad frame */
        }
      });

      source.addEventListener("error", () => {
        setState((s) => ({ ...s, connected: false }));
        source.close();
        sourceRef.current = null;
        // EventSource reconnects on its own, but not with our `since` cursor, so
        // reconnect manually to guarantee no gap in the event log.
        if (!cancelled) retry = setTimeout(connect, 1500);
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [projectId, scheduleRefresh]);

  const setProject = useCallback((p: ProjectView) => {
    setState((s) => ({ ...s, project: p, loading: false }));
  }, []);

  const clearConsole = useCallback(() => {
    setState((s) => ({ ...s, console: [] }));
  }, []);

  return useMemo(
    () => ({ ...state, refresh, setProject, clearConsole }),
    [state, refresh, setProject, clearConsole],
  );
}

// ── shared client helpers ────────────────────────────────────────────────────

/** POST JSON and surface the server's error message rather than a status code. */
export async function post<T>(url: string, payload?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

export async function patch<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

export function formatUsd(v: number): string {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function formatBytes(v: number): string {
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSeconds(v: number): string {
  return `${v.toFixed(v < 10 ? 2 : 1)}s`;
}
