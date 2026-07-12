import { useEffect, useMemo, useState } from "react";
import type {
  AppPreferences,
  ChatModelRef,
  ChatProvider,
  CodexReasoningEffort,
  ProviderSettings,
  Session,
  TaskMinerConfig,
  TrainingSourceRef,
} from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import { Search, X } from "../icons";
import { DropdownSelect } from "../DropdownSelect";
import { CodexModelReasoningMenu } from "../chat/ComposerControls";
import {
  modelOptionsForProvider,
  normalizeChatModel,
  providerModelSupportsReasoning,
  providerOptionsFromSettings,
} from "../../lib/app-models";
import { startConfiguredTaskCreation, trainingAuthoringModel } from "./training-flow";

type TrainingController = ReturnType<typeof useTraining>;
type RunMode = "manual" | "automated";
const MAX_VISIBLE_CHAT_OPTIONS = 100;

export function TrainingRunDialog({
  defaultModel,
  initialObjective,
  minerConfig,
  onClose,
  onManualStarted,
  onMiningStarted,
  preferences,
  providerSettings,
  reasoningEffort,
  sessions,
  sources,
  training,
}: {
  defaultModel: ChatModelRef;
  initialObjective: string | null;
  minerConfig: TaskMinerConfig;
  onClose: () => void;
  onManualStarted: () => void;
  onMiningStarted: () => void;
  preferences: AppPreferences["training"];
  providerSettings: ProviderSettings | null;
  reasoningEffort: CodexReasoningEffort;
  sessions: Session[];
  sources: TrainingSourceRef[];
  training: TrainingController;
}) {
  const initialAuthoringModel = trainingAuthoringModel(preferences, defaultModel);
  const [mode, setMode] = useState<RunMode>("automated");
  const [objective, setObjective] = useState(initialObjective ?? "");
  const [authoringProvider, setAuthoringProvider] = useState<ChatProvider>(initialAuthoringModel.providerId);
  const [authoringModel, setAuthoringModel] = useState(initialAuthoringModel.modelId);
  const [authoringReasoningEffort, setAuthoringReasoningEffort] = useState(reasoningEffort);
  const [observationWindowDays, setObservationWindowDays] = useState(minerConfig.observationWindowDays);
  const [minimumRecurrence, setMinimumRecurrence] = useState(minerConfig.minimumRecurrence);
  const [search, setSearch] = useState("");
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [estimatesBySessionId, setEstimatesBySessionId] = useState<Record<string, { messageCount: number; estimatedTokens: number }>>({});
  const eligibleSessions = useMemo(
    () => sessions.filter((session) => !session.systemKind && !session.hiddenFromDefaultSidebar && session.status !== "active"),
    [sessions],
  );
  const matchingSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? eligibleSessions.filter((session) => session.title.toLowerCase().includes(query))
      : eligibleSessions;
  }, [eligibleSessions, search]);
  const visibleSessions = matchingSessions.slice(0, MAX_VISIBLE_CHAT_OPTIONS);
  const visibleSessionKey = visibleSessions.map((session) => session.id).join("\n");
  const selectedCount = selectedSessionIds.size;
  const busy = Boolean(training.busyAction);
  const providerOptions = useMemo(
    () => providerOptionsFromSettings(providerSettings, { enabledOnly: true }),
    [providerSettings],
  );
  const modelOptions = useMemo(
    () => modelOptionsForProvider(authoringProvider, providerSettings),
    [authoringProvider, providerSettings],
  );
  const showReasoning = providerModelSupportsReasoning(authoringProvider, authoringModel, providerSettings);

  useEffect(() => {
    setObjective(initialObjective ?? "");
  }, [initialObjective]);

  useEffect(() => {
    const known = Object.fromEntries(sources.flatMap((source) => {
      const messageCount = typeof source.metadata.messageCount === "number" ? source.metadata.messageCount : null;
      const estimatedTokens = typeof source.metadata.estimatedTokens === "number" ? source.metadata.estimatedTokens : null;
      return messageCount === null || estimatedTokens === null ? [] : [[source.sessionId, { messageCount, estimatedTokens }]];
    }));
    if (Object.keys(known).length) setEstimatesBySessionId((current) => ({ ...known, ...current }));
  }, [sources]);

  useEffect(() => {
    if (!visibleSessionKey) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void training.actions.estimateSources(visibleSessionKey.split("\n")).then((estimates) => {
        if (cancelled) return;
        setEstimatesBySessionId((current) => ({
          ...current,
          ...Object.fromEntries(estimates.map((estimate) => [estimate.sessionId, {
            messageCount: estimate.messageCount,
            estimatedTokens: estimate.estimatedTokens,
          }])),
        }));
      }).catch(() => undefined);
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [training.actions, visibleSessionKey]);

  const selectedEstimate = useMemo(() => {
    let messageCount = 0;
    let estimatedTokens = 0;
    let measuredChats = 0;
    for (const sessionId of selectedSessionIds) {
      const estimate = estimatesBySessionId[sessionId];
      if (!estimate) continue;
      measuredChats += 1;
      messageCount += estimate.messageCount;
      estimatedTokens += estimate.estimatedTokens;
    }
    return { messageCount, estimatedTokens, measuredChats };
  }, [estimatesBySessionId, selectedSessionIds]);

  function changeAuthoringProvider(provider: ChatProvider) {
    setAuthoringProvider(provider);
    setAuthoringModel((current) => normalizeChatModel(provider, current, providerSettings));
  }

  function toggleVisible() {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      const everyVisibleSelected = visibleSessions.length > 0 && visibleSessions.every((session) => next.has(session.id));
      for (const session of visibleSessions) everyVisibleSelected ? next.delete(session.id) : next.add(session.id);
      return next;
    });
  }

  async function ensureSelectedSources(): Promise<TrainingSourceRef[]> {
    const sourceBySession = new Map(sources.map((source) => [source.sessionId, source]));
    const selected: TrainingSourceRef[] = [];
    const missingSessionIds: string[] = [];
    for (const sessionId of selectedSessionIds) {
      const existing = sourceBySession.get(sessionId);
      if (existing) {
        selected.push(existing);
        continue;
      }
      missingSessionIds.push(sessionId);
    }
    if (missingSessionIds.length) selected.push(...await training.actions.addSources(missingSessionIds) ?? []);
    return selected;
  }

  async function submit() {
    const selectedSources = await ensureSelectedSources();
    if (!selectedSources.length) return;
    if (mode === "automated") {
      const nextConfig = {
        ...minerConfig,
        enabled: true,
        observationWindowDays,
        minimumRecurrence,
      };
      if (
        !minerConfig.enabled ||
        observationWindowDays !== minerConfig.observationWindowDays ||
        minimumRecurrence !== minerConfig.minimumRecurrence
      ) await training.actions.configureMiner(nextConfig);
      await training.actions.runMiner(selectedSources.map((source) => source.id));
      onMiningStarted();
      return;
    }
    const creation = await startConfiguredTaskCreation({
      training,
      sourceIds: selectedSources.map((source) => source.id),
      objective,
      surface: "training_page",
      preferences,
      fallbackModel: defaultModel,
      analysisModel: { providerId: authoringProvider, modelId: authoringModel },
      reasoningEffort: authoringReasoningEffort,
    });
    if (creation) onManualStarted();
  }

  return (
    <div className="training-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="training-dialog training-run-dialog" role="dialog" aria-modal="true" aria-label="Start training run" onMouseDown={(event) => event.stopPropagation()}>
        <div className="training-dialog-header">
          <div>
            <h2>New model</h2>
          </div>
          <button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="training-tabs training-dialog-mode-tabs" role="tablist" aria-label="Run setup mode">
          <button type="button" role="tab" aria-selected={mode === "automated"} className={mode === "automated" ? "active" : ""} onClick={() => setMode("automated")}>Automated</button>
          <button type="button" role="tab" aria-selected={mode === "manual"} className={mode === "manual" ? "active" : ""} onClick={() => setMode("manual")}>Manual</button>
        </div>

        {mode === "manual" ? (
          <div className="training-manual-setup">
            <label className="training-objective-field">
              <span>What should the model learn?</span>
              <textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Describe the repeatable capability. You can leave this blank and answer in the guided plan." />
            </label>
            <div className="training-authoring-controls" aria-label="Authoring model">
              <DropdownSelect compact placement="bottom" label="Provider" value={authoringProvider} options={providerOptions} disabled={busy} onChange={(value) => changeAuthoringProvider(value as ChatProvider)} />
              {showReasoning ? (
                <CodexModelReasoningMenu disabled={busy} model={authoringModel} modelOptions={modelOptions} placement="bottom" reasoningEffort={authoringReasoningEffort} onModelChange={setAuthoringModel} onReasoningEffortChange={setAuthoringReasoningEffort} />
              ) : (
                <DropdownSelect compact placement="bottom" label="Model" value={authoringModel} options={modelOptions} disabled={busy} onChange={setAuthoringModel} />
              )}
            </div>
          </div>
        ) : (
          <div className="training-automated-setup" aria-label="Automated search options">
            <label><span>Lookback window</span><select aria-label="Lookback window" value={observationWindowDays} onChange={(event) => setObservationWindowDays(Number(event.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>1 year</option></select></label>
            <label><span>Minimum recurrence</span><select aria-label="Minimum recurrence" value={minimumRecurrence} onChange={(event) => setMinimumRecurrence(Number(event.target.value))}><option value={2}>2 similar chats</option><option value={3}>3 similar chats</option><option value={5}>5 similar chats</option><option value={10}>10 similar chats</option></select></label>
          </div>
        )}

        <div className="training-source-toolbar">
          <label className="training-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats" /></label>
          <button className="training-text-button" type="button" disabled={!visibleSessions.length} onClick={toggleVisible}>
            {visibleSessions.length > 0 && visibleSessions.every((session) => selectedSessionIds.has(session.id)) ? "Clear visible" : "Select visible"}
          </button>
        </div>
        <div className="training-source-result-count">
          Showing {visibleSessions.length} of {matchingSessions.length} matching chats
        </div>
        <div className="training-source-options">
          {visibleSessions.map((session) => (
            <label key={session.id}>
              <input
                className="training-chat-checkbox"
                type="checkbox"
                checked={selectedSessionIds.has(session.id)}
                onChange={(event) => setSelectedSessionIds((current) => {
                  const next = new Set(current);
                  event.target.checked ? next.add(session.id) : next.delete(session.id);
                  return next;
                })}
              />
              <span><strong>{session.title}</strong><small>{new Date(session.updatedAt).toLocaleString()}<ChatEstimate estimate={estimatesBySessionId[session.id]} /></small></span>
            </label>
          ))}
          {!visibleSessions.length ? <p className="training-empty">No completed chats match this search.</p> : null}
        </div>

        <div className="training-dialog-actions">
          <span className="training-selection-count">
            {selectedCount === 0
              ? "Select chats to estimate scan size"
              : selectedEstimate.measuredChats === selectedCount
                ? <><span>{selectedCount} chat{selectedCount === 1 ? "" : "s"}</span><span>{selectedEstimate.messageCount} messages</span><span>About {formatTokens(selectedEstimate.estimatedTokens)} tokens</span></>
                : <><span>{selectedCount} chat{selectedCount === 1 ? "" : "s"}</span><span>Estimating scan size…</span></>}
          </span>
          <button className="training-button secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="training-button" type="button" disabled={!selectedCount || busy} onClick={() => void submit()}>
            {mode === "automated" ? "Search selected chats" : "Create training plan"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ChatEstimate({ estimate }: { estimate?: { messageCount: number; estimatedTokens: number } }) {
  if (!estimate) return <span className="training-chat-estimate"><span>Estimating…</span></span>;
  return <span className="training-chat-estimate"><span>{estimate.messageCount} messages</span><span>About {formatTokens(estimate.estimatedTokens)} tokens</span></span>;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
}
