/**
 * Per-project event bus feeding the UI's progress stream.
 *
 * Each project keeps a bounded replay buffer so a browser that connects late — or
 * reconnects after a refresh — receives everything that already happened instead
 * of an empty stream. That matters during a live demo, where the render is often
 * already running before anyone looks at the screen.
 */
import type { ProjectStatus } from "@/lib/db/types";

export type SceneStage = "keyframe" | "motion";
export type StepState = "start" | "done" | "fail" | "fallback" | "skip";

export type MuseEvent =
  | { kind: "status"; status: ProjectStatus }
  | { kind: "stage"; stage: string; state: StepState; detail?: string }
  | {
      kind: "scene";
      sceneId: string;
      stage: SceneStage;
      state: StepState;
      assetUrl?: string;
      route?: string;
      fallbackReason?: string;
      attempt?: number;
    }
  | {
      kind: "music";
      state: StepState;
      assetUrl?: string;
      route?: string;
      bpm?: number;
      anchors?: number[];
      fallbackReason?: string;
    }
  | {
      kind: "qc";
      sceneId: string;
      scores: Record<string, number>;
      decision: "PASS" | "RETRY" | "FALLBACK";
      note?: string;
      source?: string;
    }
  | { kind: "spec"; version: number; title: string; scenes: number; durationS: number }
  | {
      kind: "agent";
      seq: number;
      step: "thought" | "tool_call" | "tool_result" | "message" | "error";
      name: string;
      summary: string;
      usd?: number;
    }
  | { kind: "cost"; spentUsd: number; remainingUsd: number; ceilingUsd: number }
  | { kind: "render"; state: StepState; progress?: number; outputUrl?: string; detail?: string }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string }
  | { kind: "done"; outputUrl: string; durationS: number }
  | { kind: "error"; message: string };

export interface Envelope {
  id: number;
  at: string;
  projectId: string;
  event: MuseEvent;
}

type Listener = (e: Envelope) => void;

const REPLAY_LIMIT = 400;

interface Channel {
  seq: number;
  buffer: Envelope[];
  listeners: Set<Listener>;
}

const channels = new Map<string, Channel>();

function channelFor(projectId: string): Channel {
  let c = channels.get(projectId);
  if (!c) {
    c = { seq: 0, buffer: [], listeners: new Set() };
    channels.set(projectId, c);
  }
  return c;
}

/** Publish an event. Never throws: a broken listener must not break a render. */
export function emit(projectId: string, event: MuseEvent): Envelope {
  const c = channelFor(projectId);
  const env: Envelope = {
    id: ++c.seq,
    at: new Date().toISOString(),
    projectId,
    event,
  };
  c.buffer.push(env);
  if (c.buffer.length > REPLAY_LIMIT) c.buffer.splice(0, c.buffer.length - REPLAY_LIMIT);
  for (const l of c.listeners) {
    try {
      l(env);
    } catch {
      /* a failed listener is dropped silently; the stream is best-effort */
    }
  }
  return env;
}

/**
 * Subscribe to a project. Events already buffered after `sinceId` are delivered
 * synchronously before any new ones, so ordering is preserved across reconnects.
 */
export function subscribe(
  projectId: string,
  listener: Listener,
  sinceId = 0,
): () => void {
  const c = channelFor(projectId);
  for (const env of c.buffer) {
    if (env.id > sinceId) {
      try {
        listener(env);
      } catch {
        /* ignore */
      }
    }
  }
  c.listeners.add(listener);
  return () => {
    c.listeners.delete(listener);
  };
}

export function replay(projectId: string, sinceId = 0): Envelope[] {
  return channelFor(projectId).buffer.filter((e) => e.id > sinceId);
}

export function lastId(projectId: string): number {
  return channelFor(projectId).seq;
}

/** Free a project's channel once its work is finished and nobody is listening. */
export function dispose(projectId: string): void {
  const c = channels.get(projectId);
  if (c && c.listeners.size === 0) channels.delete(projectId);
}

/** Test seam. */
export function __reset(): void {
  channels.clear();
}
