"use client";

/**
 * The studio shell. Owns every piece of state and every network call; the panels
 * below it are presentational and receive props only.
 *
 * Concentrating the I/O here means there is exactly one place that knows how a
 * mutation maps onto an endpoint, and exactly one event stream. A panel can be
 * rewritten without touching a fetch, and the stream never has two subscribers
 * disagreeing about what the project currently looks like.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, Eyebrow, Icon, Panel, Spinner, cx } from "@/components/ui/primitives";
import { Logo } from "@/components/brand/Logo";
import { filmStatus, presetLabel } from "@/lib/brand";
import { Timeline, type TimelineScene } from "@/components/ui/timeline";
import ConsolePanel from "./ConsolePanel";
import DiagnosticsPanel from "./DiagnosticsPanel";
import DirectPanel from "./DirectPanel";
import EditPanel from "./EditPanel";
import ScreeningPanel, { type ScreeningView } from "./ScreeningPanel";

import ScenePanel from "./ScenePanel";
import SetupPanel from "./SetupPanel";
import {
  post,
  patch as patchJson,
  useProjectStream,
  type ProjectView,
} from "./useProjectStream";
import {
  IDLE,
  type ActionState,
  type AgentStep,
  type Capabilities,
  type DirectionPreview,
  type LedgerEntry,
} from "./types";

/** Live-direction examples. Typing is slow in front of an audience. */
const SUGGESTIONS = [
  "make the drop more magical",
  "make scene four nighttime",
  "more flowers",
  "calmer and softer",
  "heavier film grain",
];

export interface StudioClientProps {
  projectId: string;
  /** Server-rendered first paint, so the studio never opens empty. */
  initialProject: ProjectView;
  initialCapabilities: Capabilities;
}

export default function StudioClient({
  projectId,
  initialProject,
  initialCapabilities,
}: StudioClientProps) {
  const stream = useProjectStream(projectId);
  const project = stream.project ?? initialProject;

  const [capabilities, setCapabilities] = useState<Capabilities>(initialCapabilities);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [manifest, setManifest] = useState<unknown>(null);

  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [playheadS, setPlayheadS] = useState(0);
  const [seekToS, setSeekToS] = useState<number | null>(null);

  const [setupAction, setSetupAction] = useState<ActionState>(IDLE);
  const [sceneAction, setSceneAction] = useState<ActionState>(IDLE);
  const [busySceneId, setBusySceneId] = useState<string | null>(null);
  const [directAction, setDirectAction] = useState<ActionState>(IDLE);
  const [preview, setPreview] = useState<DirectionPreview | null>(null);
  const [busyEdit, setBusyEdit] = useState<string | null>(null);

  // The screening is read on its own rather than folded into the project stream: it is
  // run on demand, it changes only when somebody asks for it, and polling it with
  // everything else would spend a model call a second.
  const [screening, setScreening] = useState<ScreeningView | null>(null);
  const refreshScreening = useCallback(() => {
    void fetch(`/api/projects/${projectId}/screening`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { screening?: ScreeningView | null } | null) => {
        if (body && body.screening) setScreening(body.screening);
      })
      .catch(() => {
        /* the panel simply shows nothing until a screening is run */
      });
  }, [projectId]);
  useEffect(() => {
    refreshScreening();
  }, [refreshScreening]);
  const [editError, setEditError] = useState<string | null>(null);

  // ── derived ────────────────────────────────────────────────────────────────

  const durationS = project.spec?.durationS ?? 30;

  const timelineScenes: TimelineScene[] = useMemo(
    () =>
      project.scenes.map((s) => ({
        id: s.id,
        startS: s.startS,
        endS: s.endS,
        purpose: s.purpose,
        status: s.status,
        label: s.id,
      })),
    [project.scenes],
  );

  const timelineEvents = useMemo(
    () => (project.spec?.events ?? []).map((e) => ({ t: e.t, kind: e.kind, intensity: e.intensity })),
    [project.spec],
  );

  const anchors = useMemo(
    () => project.reel?.anchors ?? project.music?.anchors ?? [],
    [project.reel, project.music],
  );

  // ── side loads ─────────────────────────────────────────────────────────────

  const loadCapabilities = useCallback(async () => {
    try {
      const res = await fetch("/api/capabilities", { cache: "no-store" });
      if (res.ok) setCapabilities((await res.json()) as Capabilities);
    } catch {
      // Capabilities are advisory; the studio stays usable with the last copy.
    }
  }, []);

  const loadAgent = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/agent`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { steps: AgentStep[] };
      setAgentSteps(data.steps ?? []);
    } catch {
      /* transcript is a nicety */
    }
  }, [projectId]);

  const loadLedger = useCallback(async () => {
    try {
      const res = await fetch("/api/budget?limit=60", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { recent: LedgerEntry[] };
      setLedger(data.recent ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadManifest = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/output`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { manifest: unknown };
      setManifest(data.manifest ?? null);
    } catch {
      /* no reel yet */
    }
  }, [projectId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([stream.refresh(), loadCapabilities(), loadLedger(), loadManifest(), loadAgent()]);
  }, [stream, loadCapabilities, loadLedger, loadManifest, loadAgent]);

  // Keep the derived views in step with the stream without polling: react to the
  // event kinds that actually change stored state.
  const lastEventId = stream.lastEventId;
  const sawAgent = stream.console.some((l) => l.channel === "agent");
  const status = project.status;

  useEffect(() => {
    void loadLedger();
  }, [lastEventId, loadLedger]);

  useEffect(() => {
    if (sawAgent || project.runningKind === "agent") void loadAgent();
  }, [sawAgent, project.runningKind, lastEventId, loadAgent]);

  useEffect(() => {
    if (status === "READY") {
      void loadManifest();
      void loadCapabilities();
    }
  }, [status, loadManifest, loadCapabilities]);

  useEffect(() => {
    void loadAgent();
    void loadLedger();
    void loadManifest();
  }, [loadAgent, loadLedger, loadManifest]);

  // Select the hero scene by default: it is the one worth looking at first.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current || project.scenes.length === 0) return;
    autoSelected.current = true;
    const hero = project.scenes.find((s) => s.purpose === "hero_drop");
    setSelectedSceneId(hero?.id ?? project.scenes[0].id);
  }, [project.scenes]);

  // ── handlers ───────────────────────────────────────────────────────────────

  const onUpload = useCallback(
    async (files: { images: File[]; audio: File | null }) => {
      setSetupAction({ busy: true, error: null });
      try {
        const form = new FormData();
        for (const f of files.images) form.append("images", f);
        if (files.audio) form.append("audio", files.audio);
        const res = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
        const data = (await res.json().catch(() => ({}))) as {
          project?: ProjectView;
          rejected?: { name: string; reason: string }[];
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "upload failed");
        if (data.project) stream.setProject(data.project);
        const rejected = data.rejected ?? [];
        setSetupAction({
          busy: false,
          error:
            rejected.length > 0
              ? `skipped ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}`
              : null,
        });
      } catch (e) {
        setSetupAction({ busy: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [projectId, stream],
  );

  const onRemoveUploads = useCallback(async () => {
    setSetupAction({ busy: true, error: null });
    try {
      // Removing references means starting over; recreating the project is
      // cleaner than partially unpicking generated work that referenced them.
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: project.mode, preset: project.preset, brief: project.brief }),
      });
      const data = (await res.json()) as { project?: { id: string }; error?: string };
      if (!res.ok || !data.project) throw new Error(data.error ?? "could not reset");
      // Discard the one being replaced. Without this every reset left a draft behind that
      // the gallery listed for ever with nothing anywhere to remove it, so clearing
      // uploads quietly accumulated abandoned films. Failure here is ignored on purpose:
      // the reset has already succeeded and the person is on their way to the new project.
      await fetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
      window.location.href = `/studio/${data.project.id}`;
    } catch (e) {
      setSetupAction({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [project.mode, project.preset, project.brief, projectId]);

  const onChange = useCallback(
    async (p: {
      brief?: string;
      preset?: string;
      profile?: string;
      consent?: boolean;
      mode?: "generated" | "uploaded";
    }) => {
      setSetupAction({ busy: true, error: null });
      try {
        const data = await patchJson<{ project: ProjectView }>(`/api/projects/${projectId}`, p);
        stream.setProject(data.project);
        setSetupAction(IDLE);
        if (p.profile) void loadCapabilities();
      } catch (e) {
        setSetupAction({ busy: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [projectId, stream, loadCapabilities],
  );

  const onStart = useCallback(
    async (opts: { useAgent: boolean }) => {
      setSetupAction({ busy: true, error: null });
      stream.clearConsole();
      try {
        await post(`/api/projects/${projectId}/direct`, { useAgent: opts.useAgent });
        setSetupAction(IDLE);
        void stream.refresh();
      } catch (e) {
        setSetupAction({ busy: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [projectId, stream],
  );

  const onCancel = useCallback(async () => {
    try {
      await post(`/api/projects/${projectId}/cancel`);
      void stream.refresh();
    } catch (e) {
      setSetupAction({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [projectId, stream]);

  const onRegenerate = useCallback(
    async (sceneId: string) => {
      setSceneAction({ busy: true, error: null });
      setBusySceneId(sceneId);
      try {
        await post(`/api/projects/${projectId}/storyboard/${sceneId}/regenerate`);
        setSceneAction(IDLE);
      } catch (e) {
        setSceneAction({ busy: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusySceneId(null);
      }
    },
    [projectId],
  );

  const onPreviewDirection = useCallback(
    async (utterance: string) => {
      if (!utterance.trim()) return;
      setDirectAction({ busy: true, error: null });
      setPreview(null);
      try {
        const data = await post<DirectionPreview & { applied: boolean }>(
          `/api/projects/${projectId}/patch-director`,
          { utterance, apply: false },
        );
        setPreview(data);
        setDirectAction(IDLE);
      } catch (e) {
        setDirectAction({ busy: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [projectId],
  );

  const onApplyDirection = useCallback(
    async (utterance: string, opts: { render: boolean; force: boolean }) => {
      setDirectAction({ busy: true, error: null });
      try {
        const data = await post<{
          applied: boolean;
          project?: ProjectView;
          needsForce?: boolean;
          impact?: string;
          invalidatedScenes?: string[];
        }>(`/api/projects/${projectId}/patch-director`, {
          utterance,
          apply: true,
          render: opts.render,
          force: opts.force,
        });
        // A refusal for being too broad returns 200 with applied:false and the blast
        // radius attached. Keeping the preview on screen is what makes the override one
        // click away instead of a dead end.
        if (data.applied === false) {
          setPreview((p) => (p ? { ...p, needsForce: data.needsForce === true } : p));
          setDirectAction({
            busy: false,
            error: `${data.impact ?? "that would change too much"} — confirm to go ahead`,
          });
          return;
        }
        if (data.project) stream.setProject(data.project);
        setPreview(null);
        setDirectAction(IDLE);
        void stream.refresh();
      } catch (e) {
        // A refusal for being too broad comes back as an error with the impact
        // still attached; keep the preview visible so the override is one click.
        setDirectAction({ busy: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [projectId, stream],
  );

  /**
   * Re-cutting spends nothing: the shots and the score already exist, so this is
   * deterministic composition over paid-for material.
   */
  const onRecut = useCallback(
    async (editId: string) => {
      setBusyEdit(editId);
      setEditError(null);
      try {
        await post(`/api/projects/${projectId}/recut`, { edit: editId });
      } catch (e) {
        setEditError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyEdit(null);
      }
    },
    [projectId],
  );

  const onScrub = useCallback((s: number) => {
    setPlayheadS(s);
    setSeekToS(s);
  }, []);

  // ── layout ─────────────────────────────────────────────────────────────────

  const hasPlan = Boolean(project.spec);

  return (
    <main className="w-full max-w-full overflow-x-hidden pb-24">
      <header className="mx-auto mt-6 flex w-[min(var(--measure-wide),100%-var(--gutter-page)*2)] flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            href="/"
            aria-label="MUSE home"
            className="text-paper-300 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-paper-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/60"
          >
            <Logo size={20} wordSize={12} />
          </Link>
          <span className="h-4 w-px bg-hairline" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="truncate font-display text-xl leading-tight text-paper-50">
              {project.spec?.title ?? project.title}
            </h1>
            <p className="truncate font-mono text-[11px] text-paper-500">
              {presetLabel(project.preset)}
              {project.spec
                ? ` · ${project.spec.durationS.toFixed(0)}s · ${project.scenes.length} shots`
                : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {project.running ? (
            <span className="flex items-center gap-2 font-mono text-[11px] text-ember-300">
              <Spinner size={12} />
              {project.runningKind ?? "working"}
            </span>
          ) : null}
          <Badge tone={filmStatus(project.status).tone}>{filmStatus(project.status).label}</Badge>
          {!stream.connected ? <Badge tone="warn">reconnecting</Badge> : null}
        </div>
      </header>

      {project.error ? (
        <div
          role="alert"
          className="mx-auto mt-5 w-[min(var(--measure-wide),100%-var(--gutter-page)*2)] rounded-core border border-signal-fail/40 bg-signal-fail/5 px-4 py-3"
        >
          <p className="flex items-start gap-2 font-sans text-[13px] text-signal-fail">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
            <span>{project.error}</span>
          </p>
        </div>
      ) : null}

      {/* The timeline spans the full width because it is the product's central
          object, not a widget inside a column. */}
      {hasPlan ? (
        <section className="mx-auto mt-8 w-[min(var(--measure-wide),100%-var(--gutter-page)*2)]">
          <Panel tone="raised" padding="md">
            <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
              <Eyebrow tone="ember">Timeline</Eyebrow>
              <span className="font-mono text-[11px] text-paper-500">
                {durationS.toFixed(0)}s
                {project.music?.bpm ? ` · ${project.music.bpm} BPM` : ""}
              </span>
            </div>
            <Timeline
              durationS={durationS}
              scenes={timelineScenes}
              events={timelineEvents}
              energy={project.music?.energy}
              playheadS={playheadS}
              anchors={anchors}
              onScrub={onScrub}
              onSelectScene={setSelectedSceneId}
              {...(selectedSceneId ? { selectedSceneId } : {})}
            />
          </Panel>
        </section>
      ) : null}

      {/* Two columns only when there is width for two.
          
          The breakpoint measures the viewport; the navigation rail has already taken part of it.
          At `lg` — a 1024px window — that left the timeline 316 pixels beside a fixed 460 pixel
          inspector, which is not a layout, it is a squeeze. `xl` with the rail collapsed gives the
          timeline something like 750, and below that the two stack, which reads fine. */}
      <div className="mx-auto mt-8 grid w-[min(var(--measure-wide),100%-var(--gutter-page)*2)] grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex min-w-0 flex-col gap-8">
          <SetupPanel
            project={project}
            capabilities={capabilities}
            action={setupAction}
            onUpload={onUpload}
            onRemoveUploads={onRemoveUploads}
            onChange={onChange}
            onStart={onStart}
            onCancel={onCancel}
          />

          <ConsolePanel
            lines={stream.console}
            agentSteps={agentSteps}
            project={project}
            progress={stream.progress}
            connected={stream.connected}
            onClear={stream.clearConsole}
          />

          {hasPlan ? (
            <>
              <ScenePanel
                project={project}
                selectedSceneId={selectedSceneId}
                onSelectScene={setSelectedSceneId}
                onRegenerate={onRegenerate}
                action={sceneAction}
                busySceneId={busySceneId}
              />

              <DirectPanel
                project={project}
                action={directAction}
                preview={preview}
                onPreview={onPreviewDirection}
                onApply={onApplyDirection}
                onDismiss={() => setPreview(null)}
                suggestions={SUGGESTIONS}
              />
            </>
          ) : null}

          {/*
            The workings are real and worth showing, but they are not the product.
            One disclosure keeps them a click away instead of making a person scroll
            past an operator readout to reach their film.
          */}
          <details className="group rounded-shell border border-hairline bg-ink-900/40">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 outline-none focus-visible:ring-1 focus-visible:ring-ember-500/60">
              <span className="flex items-center gap-2.5">
                <Icon
                  name="chevron"
                  size={12}
                  className="shrink-0 text-paper-500 transition-transform duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] group-open:rotate-90"
                />
                <span className="font-sans text-[13px] text-paper-200">Behind the scenes</span>
              </span>
              <span className="font-mono text-[11px] text-paper-500">how this film was made</span>
            </summary>
            <div className="border-t border-hairline p-1.5">
              <DiagnosticsPanel
                project={project}
                capabilities={capabilities}
                ledger={ledger}
                manifest={manifest}
                onRefresh={() => void refreshAll()}
              />
            </div>
          </details>
        </div>

        <div className="min-w-0">
          <ScreeningPanel
            projectId={project.id}
            screening={screening}
            canScreen={Boolean(project.reel?.url)}
            busy={project.running}
            onChanged={refreshScreening}
          />
        </div>

        <div className="min-w-0">
          <EditPanel
            project={project}
            progress={stream.progress}
            onRecut={onRecut}
            busyEdit={busyEdit}
            error={editError}
            playheadS={playheadS}
            onPlayhead={setPlayheadS}
            seekToS={seekToS}
            onSeekHandled={() => setSeekToS(null)}
          />
        </div>
      </div>

      {stream.loading ? (
        <div className="mx-auto mt-8 flex w-[min(var(--measure-wide),100%-var(--gutter-page)*2)] items-center gap-2 font-mono text-[11px] text-paper-500">
          <Spinner size={12} />
          connecting to the project stream
        </div>
      ) : null}

      <div className="mx-auto mt-10 flex w-[min(var(--measure-wide),100%-var(--gutter-page)*2)] justify-end">
        <Button variant="quiet" size="sm" onClick={() => void refreshAll()}>
          Refresh
        </Button>
      </div>
    </main>
  );
}
