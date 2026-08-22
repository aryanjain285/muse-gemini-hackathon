/**
 * Panel contracts for the studio.
 *
 * The shell owns all state and all network calls; panels are presentational and
 * receive everything through these props. Declaring the boundary in one file is
 * what keeps a panel replaceable without touching the shell.
 */
import type { ConsoleLine, ProjectView, SceneView } from "./useProjectStream";

export type { ConsoleLine, ProjectView, SceneView };

/** What the server says is currently possible and what it would cost. */
export interface Capabilities {
  hasApiKey: boolean;
  activeProfile: string;
  cacheEnabled: boolean;
  cache: { entries: number; bytes: number };
  budget: { ceilingUsd: number; spentUsd: number; remainingUsd: number };
  profiles: {
    name: string;
    label: string;
    blurb: string;
    estimateUsd: number;
    routes: { task: string; route: string; model: string | null; estimateUsd: number }[];
    videoSecondsBudget: number;
    imageSize: string;
  }[];
  presets: { id: string; label: string; blurb: string; swatches: string[] }[];
  skills: string[];
}

/** A pending or failed async action the panel should reflect. */
export interface ActionState {
  busy: boolean;
  error: string | null;
}

export const IDLE: ActionState = { busy: false, error: null };

// ── setup ────────────────────────────────────────────────────────────────────

export interface SetupPanelProps {
  project: ProjectView;
  capabilities: Capabilities | null;
  action: ActionState;
  /** Upload photographs and, optionally, a song. */
  onUpload: (files: { images: File[]; audio: File | null }) => void;
  onRemoveUploads: () => void;
  onChange: (patch: {
    brief?: string;
    preset?: string;
    profile?: string;
    consent?: boolean;
    mode?: "generated" | "uploaded";
  }) => void;
  /** Begin the run. `useAgent` drives it with the director agent. */
  onStart: (opts: { useAgent: boolean }) => void;
  onCancel: () => void;
}

// ── console ──────────────────────────────────────────────────────────────────

export interface AgentStep {
  seq: number;
  kind: string;
  name: string;
  summary: string;
  usd: number;
  at: string;
  payload: unknown;
}

export interface ConsolePanelProps {
  lines: ConsoleLine[];
  agentSteps: AgentStep[];
  project: ProjectView;
  progress: { fraction: number; label: string } | null;
  connected: boolean;
  onClear: () => void;
}

// ── scenes ───────────────────────────────────────────────────────────────────

export interface ScenePanelProps {
  project: ProjectView;
  selectedSceneId: string | null;
  onSelectScene: (id: string) => void;
  onRegenerate: (sceneId: string) => void;
  action: ActionState;
  /** Scene currently being regenerated, if any. */
  busySceneId: string | null;
}

// ── live direction ───────────────────────────────────────────────────────────

export interface DirectionPreview {
  summary: string;
  impact: string;
  invalidatedScenes: string[];
  rejected: string[];
  ops: { op: string; [key: string]: unknown }[];
  route: string;
  usd: number;
  needsForce?: boolean;
}

export interface DirectPanelProps {
  project: ProjectView;
  action: ActionState;
  preview: DirectionPreview | null;
  /** Interpret without committing. */
  onPreview: (utterance: string) => void;
  /** Commit, optionally re-rendering the invalidated scenes immediately. */
  onApply: (utterance: string, opts: { render: boolean; force: boolean }) => void;
  onDismiss: () => void;
  /** Example instructions, offered as one-tap chips. */
  suggestions: string[];
}

// ── preview ──────────────────────────────────────────────────────────────────


// ── diagnostics ──────────────────────────────────────────────────────────────

export interface LedgerEntry {
  id: string;
  projectId: string | null;
  task: string;
  model: string;
  unit: string;
  quantity: number;
  usd: number;
  cacheHit: boolean;
  estimated: boolean;
  at: string;
}

export interface DiagnosticsPanelProps {
  project: ProjectView;
  capabilities: Capabilities | null;
  ledger: LedgerEntry[];
  manifest: unknown;
  onRefresh: () => void;
}
