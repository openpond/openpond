import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppPreferences,
  ChatModelRef,
  ChatProvider,
  CodexReasoningEffort,
  ProviderSettings,
  Session,
  TaskCandidate,
  TaskCreationSnapshot,
  TaskMinerConfig,
  TaskMinerRun,
  TrainingChatSearchEntry,
  TrainingSourceRef,
} from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import type { CrossSystemFrontierBaselineResult } from "../../hooks/useTraining";
import { normalizeChatModel } from "../../lib/app-models";
import { ArrowLeft, Loader2, X } from "../icons";
import { trainingAuthoringModel } from "./training-flow";
import { TrainingAutomaticCandidatesStep } from "./TrainingAutomaticCandidatesStep";
import { TrainingAutomaticScopeStep } from "./TrainingAutomaticScopeStep";
import { TrainingManualGoalStep } from "./TrainingManualGoalStep";
import { TrainingRunReviewStep } from "./TrainingRunReviewStep";
import { TrainingSourceStep } from "./TrainingSourceStep";
import { TrainingStartModeStep } from "./TrainingStartModeStep";

type TrainingController = ReturnType<typeof useTraining>;
type NewModelMode = "automated" | "manual";
type NewModelStep =
  | "start"
  | "automatic_scope"
  | "automatic_candidates"
  | "manual_goal"
  | "evidence"
  | "recommendation";

const CHAT_SEARCH_PAGE_SIZE = 20;

export function TrainingRunDialog({
  defaultModel,
  initialObjective,
  initialSessionIds = [],
  onClose,
  onTasksetCreated,
  preferences,
  providerSettings,
  reasoningEffort,
  sessions,
  sources,
  training,
}: {
  defaultModel: ChatModelRef;
  initialObjective: string | null;
  initialSessionIds?: string[];
  onClose: () => void;
  onTasksetCreated: (creation: TaskCreationSnapshot) => void;
  preferences: AppPreferences["training"];
  providerSettings: ProviderSettings | null;
  reasoningEffort: CodexReasoningEffort;
  sessions: Session[];
  sources: TrainingSourceRef[];
  training: TrainingController;
}) {
  const initialAuthoringModel = trainingAuthoringModel(preferences, defaultModel);
  const [step, setStep] = useState<NewModelStep>("start");
  const [mode, setMode] = useState<NewModelMode | null>(null);
  const [objective, setObjective] = useState(initialObjective ?? "");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [authoringProvider, setAuthoringProvider] = useState<ChatProvider>(initialAuthoringModel.providerId);
  const [authoringModel, setAuthoringModel] = useState(initialAuthoringModel.modelId);
  const [authoringReasoningEffort, setAuthoringReasoningEffort] = useState(reasoningEffort);
  const [search, setSearch] = useState("");
  const [searchEntries, setSearchEntries] = useState<TrainingChatSearchEntry[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchIndexing, setSearchIndexing] = useState(false);
  const [indexedChats, setIndexedChats] = useState(0);
  const [totalIndexChats, setTotalIndexChats] = useState(0);
  const [searchRefreshNonce, setSearchRefreshNonce] = useState(0);
  const searchRequestRef = useRef(0);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set(initialSessionIds));
  const [estimatesBySessionId, setEstimatesBySessionId] = useState<Record<string, { messageCount: number; estimatedTokens: number }>>({});
  const [creation, setCreation] = useState<TaskCreationSnapshot | null>(null);
  const [evidenceChanged, setEvidenceChanged] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [preparingScan, setPreparingScan] = useState(false);
  const [frontierBaseline, setFrontierBaseline] = useState<CrossSystemFrontierBaselineResult | null>(null);
  const [frontierBaselineRunning, setFrontierBaselineRunning] = useState(false);
  const [activeMinerRunId, setActiveMinerRunId] = useState<string | null>(null);
  const [scanCandidates, setScanCandidates] = useState<TaskCandidate[]>([]);
  const [minerConfig, setMinerConfig] = useState<TaskMinerConfig>(() => training.payload?.minerConfig ?? defaultMinerConfig());
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const eligibleSessions = useMemo(() => sessions.filter((session) => !session.systemKind && !session.hiddenFromDefaultSidebar && session.status !== "active"), [sessions]);
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const sourceBySession = useMemo(() => new Map(sources.map((source) => [source.sessionId, source])), [sources]);
  const chatSearchCandidates = useMemo(() => eligibleSessions.slice(0, 500).map((session) => ({ sessionId: session.id, title: session.title, updatedAt: session.updatedAt })), [eligibleSessions]);
  const selectedEntries = useMemo(() => [...selectedSessionIds].flatMap((sessionId) => {
    const current = searchEntries.find((entry) => entry.sessionId === sessionId);
    if (current) return [current];
    const session = sessionById.get(sessionId);
    if (session) return [{ sessionId, title: session.title, updatedAt: session.updatedAt, snippet: null }];
    const source = sourceBySession.get(sessionId);
    return source ? [{ sessionId, title: source.title, updatedAt: source.occurredAt, snippet: null }] : [];
  }), [searchEntries, selectedSessionIds, sessionById, sourceBySession]);
  const visibleSessionKey = useMemo(
    () => [...new Set([...selectedEntries, ...searchEntries].map((entry) => entry.sessionId))]
      .filter((sessionId) => !estimatesBySessionId[sessionId])
      .join("\n"),
    [estimatesBySessionId, searchEntries, selectedEntries],
  );
  const activeMinerRun = useMemo(() => training.payload?.minerRuns.find((run) => run.id === activeMinerRunId) ?? null, [activeMinerRunId, training.payload?.minerRuns]);
  const scanning = preparingScan || Boolean(activeMinerRun && ["queued", "running", "cancelling"].includes(activeMinerRun.status));
  const busy = analyzing || preparingScan || frontierBaselineRunning || Boolean(training.busyAction);

  useEffect(() => setObjective(initialObjective ?? ""), [initialObjective]);

  useEffect(() => {
    if (step !== "automatic_scope" || activeMinerRunId) return;
    const persisted = training.payload?.minerRuns.find((run) => ["queued", "running", "cancelling"].includes(run.status));
    if (persisted) setActiveMinerRunId(persisted.id);
  }, [activeMinerRunId, step, training.payload?.minerRuns]);

  useEffect(() => {
    if (!activeMinerRun || activeMinerRun.status !== "succeeded") return;
    const candidateIds = new Set(activeMinerRun.candidateIds);
    setScanCandidates(training.payload?.candidates.filter((candidate) => candidateIds.has(candidate.id)) ?? []);
    setStep("automatic_candidates");
  }, [activeMinerRun, training.payload?.candidates]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus], [aria-label^='Back']");
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step]);

  useEffect(() => {
    if (step !== "evidence") return;
    setSearchEntries([]);
    setSearchTotal(0);
    setSearchHasMore(false);
    setSearchError(null);
  }, [search, step]);

  useEffect(() => {
    if (step !== "evidence") return undefined;
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setSearchLoading(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void training.actions.searchChats(search, chatSearchCandidates, 0, CHAT_SEARCH_PAGE_SIZE).then((result) => {
        if (searchRequestRef.current !== requestId) return;
        setSearchEntries(result.entries);
        setSearchTotal(result.total);
        setSearchHasMore(result.hasMore);
        setSearchIndexing(result.indexing);
        setIndexedChats(result.indexedChats);
        setTotalIndexChats(result.totalChats);
      }).catch((error) => {
        if (searchRequestRef.current !== requestId) return;
        setSearchEntries([]);
        setSearchTotal(0);
        setSearchHasMore(false);
        setSearchIndexing(false);
        setSearchError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (searchRequestRef.current === requestId) setSearchLoading(false);
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [chatSearchCandidates, search, searchRefreshNonce, step, training.actions]);

  useEffect(() => {
    if (step !== "evidence" || !search.trim() || !searchIndexing) return undefined;
    const timer = window.setTimeout(() => setSearchRefreshNonce((current) => current + 1), 1_500);
    return () => window.clearTimeout(timer);
  }, [search, searchIndexing, step]);

  const loadMoreChats = useCallback(async () => {
    if (searchLoading || !searchHasMore) return;
    const requestId = searchRequestRef.current;
    const offset = searchEntries.length;
    setSearchLoading(true);
    try {
      const result = await training.actions.searchChats(search, chatSearchCandidates, offset, CHAT_SEARCH_PAGE_SIZE);
      if (searchRequestRef.current !== requestId) return;
      setSearchEntries((current) => {
        const seen = new Set(current.map((entry) => entry.sessionId));
        return [...current, ...result.entries.filter((entry) => !seen.has(entry.sessionId))];
      });
      setSearchTotal(result.total);
      setSearchHasMore(result.hasMore);
      setSearchIndexing(result.indexing);
      setIndexedChats(result.indexedChats);
      setTotalIndexChats(result.totalChats);
    } catch (error) {
      if (searchRequestRef.current === requestId) setSearchError(error instanceof Error ? error.message : String(error));
    } finally {
      if (searchRequestRef.current === requestId) setSearchLoading(false);
    }
  }, [chatSearchCandidates, search, searchEntries.length, searchHasMore, searchLoading, training.actions]);

  useEffect(() => {
    const known = Object.fromEntries(sources.flatMap((source) => {
      const messageCount = typeof source.metadata.messageCount === "number" ? source.metadata.messageCount : null;
      const estimatedTokens = typeof source.metadata.estimatedTokens === "number" ? source.metadata.estimatedTokens : null;
      return messageCount === null || estimatedTokens === null ? [] : [[source.sessionId, { messageCount, estimatedTokens }]];
    }));
    if (Object.keys(known).length) setEstimatesBySessionId((current) => ({ ...known, ...current }));
  }, [sources]);

  useEffect(() => {
    if (step !== "evidence" || !visibleSessionKey) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void training.actions.estimateSources(visibleSessionKey.split("\n")).then((estimates) => {
        if (cancelled) return;
        setEstimatesBySessionId((current) => ({
          ...current,
          ...Object.fromEntries(estimates.map((estimate) => [estimate.sessionId, { messageCount: estimate.messageCount, estimatedTokens: estimate.estimatedTokens }])),
        }));
      }).catch(() => undefined);
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [step, training.actions, visibleSessionKey]);

  useEffect(() => {
    if (step !== "automatic_scope" || !eligibleSessions.length) return undefined;
    const missing = eligibleSessions.map((session) => session.id).filter((sessionId) => !estimatesBySessionId[sessionId]);
    if (!missing.length) return undefined;
    let cancelled = false;
    void training.actions.estimateSources(missing).then((estimates) => {
      if (cancelled) return;
      setEstimatesBySessionId((current) => ({
        ...current,
        ...Object.fromEntries(estimates.map((estimate) => [estimate.sessionId, { messageCount: estimate.messageCount, estimatedTokens: estimate.estimatedTokens }])),
      }));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [eligibleSessions, estimatesBySessionId, step, training.actions]);

  const selectedEstimate = useMemo(() => aggregateEstimate([...selectedSessionIds], estimatesBySessionId), [estimatesBySessionId, selectedSessionIds]);
  const scanEstimate = useMemo(() => aggregateEstimate(eligibleSessions.map((session) => session.id), estimatesBySessionId), [eligibleSessions, estimatesBySessionId]);

  function selectMode(nextMode: NewModelMode) {
    if (nextMode !== mode && mode !== null) setEvidenceChanged(true);
    setMode(nextMode);
  }

  function continueFromStart() {
    if (mode === "automated") setStep("automatic_scope");
    if (mode === "manual") setStep("manual_goal");
  }

  function changeObjective(value: string) {
    if (value !== objective) setEvidenceChanged(true);
    setObjective(value);
  }

  function changeAuthoringProvider(provider: ChatProvider) {
    setEvidenceChanged(true);
    setAuthoringProvider(provider);
    setAuthoringModel((current) => normalizeChatModel(provider, current, providerSettings));
  }

  function changeAuthoringModel(model: string) {
    setEvidenceChanged(true);
    setAuthoringModel(model);
  }

  function changeReasoningEffort(value: CodexReasoningEffort) {
    setEvidenceChanged(true);
    setAuthoringReasoningEffort(value);
  }

  function toggleVisible() {
    setEvidenceChanged(true);
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      const everyVisibleSelected = searchEntries.length > 0 && searchEntries.every((entry) => next.has(entry.sessionId));
      for (const entry of searchEntries) everyVisibleSelected ? next.delete(entry.sessionId) : next.add(entry.sessionId);
      return next;
    });
  }

  function toggleSession(sessionId: string, selected: boolean) {
    setEvidenceChanged(true);
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      selected ? next.add(sessionId) : next.delete(sessionId);
      return next;
    });
  }

  async function ensureSelectedSources(): Promise<TrainingSourceRef[]> {
    const selected: TrainingSourceRef[] = [];
    const missingSessionIds: string[] = [];
    for (const sessionId of selectedSessionIds) {
      const existing = sourceBySession.get(sessionId);
      existing ? selected.push(existing) : missingSessionIds.push(sessionId);
    }
    if (missingSessionIds.length) selected.push(...await training.actions.addSources(missingSessionIds) ?? []);
    return selected;
  }

  async function scanForCandidates() {
    setPreparingScan(true);
    try {
      const scopedSources = await training.actions.addSources(eligibleSessions.map((session) => session.id)) ?? [];
      const sourceIds = [...new Set([...sources, ...scopedSources].map((source) => source.id))];
      const nextConfig = { ...minerConfig, enabled: true };
      await training.actions.configureMiner(nextConfig);
      const runRecord: TaskMinerRun | null = await training.actions.runMiner(sourceIds);
      if (runRecord) setActiveMinerRunId(runRecord.id);
    } finally {
      setPreparingScan(false);
    }
  }

  async function runFrontierBaseline() {
    setFrontierBaselineRunning(true);
    try {
      const result = await training.actions.runCrossSystemFrontierBaseline(
        { providerId: authoringProvider, modelId: authoringModel },
        authoringReasoningEffort,
      );
      if (result) setFrontierBaseline(result);
    } finally {
      setFrontierBaselineRunning(false);
    }
  }

  async function cancelScan() {
    if (!activeMinerRunId) return;
    await training.actions.cancelMinerRun(activeMinerRunId);
  }

  function selectCandidate(candidate: TaskCandidate) {
    const sourceIds = new Set(candidate.evidence.flatMap((evidence) => evidence.sourceRefIds));
    const sessionIds = sources.filter((source) => sourceIds.has(source.id)).map((source) => source.sessionId);
    setSelectedSessionIds(new Set(sessionIds));
    setSelectedCandidateId(candidate.id);
    setObjective(candidate.title);
    setEvidenceChanged(true);
    setStep("evidence");
  }

  async function analyze() {
    setAnalyzing(true);
    try {
      const selectedSources = await ensureSelectedSources();
      if (creation && evidenceChanged && !["cancelled", "failed", "ready"].includes(creation.state)) {
        const staleCreation = creation;
        await training.actions.cancelCreation(staleCreation.id);
      }
      const next = await training.actions.startCreation(selectedSources.map((source) => source.id), {
        surface: mode === "automated" ? "task_candidate" : "training_page",
        mode: "defaults",
        entryMode: mode ?? "manual",
        objective: objective.trim() || undefined,
        methodHint: null,
        candidateId: selectedCandidateId,
        analysisModel: { providerId: authoringProvider, modelId: authoringModel },
        analysisReasoningEffort: authoringReasoningEffort,
      });
      if (!next) return;
      setCreation(next);
      setEvidenceChanged(false);
      if (next.state !== "awaiting_disclosure_approval") setStep("recommendation");
    } finally {
      setAnalyzing(false);
    }
  }

  async function approveDisclosure() {
    if (!creation || creation.state !== "awaiting_disclosure_approval") return;
    setAnalyzing(true);
    try {
      const next = await training.actions.approveDisclosure(creation.id, true);
      if (!next) return;
      setCreation(next);
      setStep("recommendation");
    } finally {
      setAnalyzing(false);
    }
  }

  async function declineDisclosure() {
    if (creation?.state === "awaiting_disclosure_approval") await training.actions.approveDisclosure(creation.id, false);
    setCreation(null);
    setEvidenceChanged(true);
  }

  function goBack() {
    if (step === "automatic_scope") setStep("start");
    else if (step === "automatic_candidates") setStep("automatic_scope");
    else if (step === "manual_goal") setStep("start");
    else if (step === "evidence") {
      if (creation?.state === "awaiting_disclosure_approval") void declineDisclosure();
      setStep(mode === "automated" ? "automatic_candidates" : "manual_goal");
    } else if (step === "recommendation") setStep("evidence");
  }

  async function closeDialog() {
    const activeCreation = creation;
    const hasMaterialChanges = step !== "start" || Boolean(objective.trim()) || selectedSessionIds.size > 0 || Boolean(activeCreation);
    if (hasMaterialChanges && !window.confirm("Close New model? The current selections will be discarded and any active authoring operation will be cancelled.")) return;
    if (activeCreation && !["cancelled", "failed", "ready"].includes(activeCreation.state)) await training.actions.cancelCreation(activeCreation.id);
    onClose();
  }

  async function createTaskset() {
    if (!creation || creation.state !== "awaiting_materialization_approval") return;
    const next = await training.actions.materialize(creation.id, true);
    if (!next) return;
    setCreation(next);
    if (next.state === "ready") onTasksetCreated(next);
  }

  return (
    <div className="training-dialog-backdrop" role="presentation" onMouseDown={() => void closeDialog()}>
      <section
        ref={dialogRef}
        className={`training-dialog training-run-dialog ${step === "start" ? "training-run-start-step" : "training-run-workflow-step"}`}
        role="dialog"
        aria-modal="true"
        aria-label="New model"
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); void closeDialog(); } }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="training-dialog-header">
          <div className="training-run-dialog-title">
            {step !== "start" ? <button data-autofocus type="button" aria-label={backLabel(step)} onClick={goBack}><ArrowLeft size={16} /></button> : null}
            <h2>{step === "recommendation" ? "Recommendation" : "New model"}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={() => void closeDialog()}><X size={16} /></button>
        </div>

        {step === "start" ? (
          <TrainingStartModeStep mode={mode} onChange={selectMode} onContinue={continueFromStart} />
        ) : step === "automatic_scope" ? (
          <TrainingAutomaticScopeStep
            chatCount={eligibleSessions.length}
            config={minerConfig}
            estimate={scanEstimate}
            frontierBaseline={frontierBaseline}
            frontierBaselineModel={`${authoringProvider} · ${authoringModel}`}
            frontierBaselineRunning={frontierBaselineRunning}
            onCancel={() => void cancelScan()}
            onConfigChange={setMinerConfig}
            onRunFrontierBaseline={() => void runFrontierBaseline()}
            onScan={() => void scanForCandidates()}
            run={activeMinerRun}
            scanning={scanning}
          />
        ) : step === "automatic_candidates" ? (
          <TrainingAutomaticCandidatesStep candidates={scanCandidates} onRescan={() => setStep("automatic_scope")} onSelect={selectCandidate} />
        ) : step === "manual_goal" ? (
          <TrainingManualGoalStep objective={objective} onChange={changeObjective} onContinue={() => setStep("evidence")} />
        ) : step === "evidence" && mode ? (
          <TrainingSourceStep
            authoringModel={authoringModel}
            authoringProvider={authoringProvider}
            authoringReasoningEffort={authoringReasoningEffort}
            busy={busy}
            disclosurePending={creation?.state === "awaiting_disclosure_approval"}
            estimatesBySessionId={estimatesBySessionId}
            matchingSessionCount={searchTotal}
            mode={mode}
            objective={objective}
            onAnalyze={() => void analyze()}
            onApproveDisclosure={() => void approveDisclosure()}
            onAuthoringModelChange={changeAuthoringModel}
            onAuthoringProviderChange={changeAuthoringProvider}
            onAuthoringReasoningEffortChange={changeReasoningEffort}
            onDeclineDisclosure={() => void declineDisclosure()}
            onSearchChange={setSearch}
            onLoadMore={() => void loadMoreChats()}
            onReturnToRecommendation={() => setStep("recommendation")}
            onToggleSession={toggleSession}
            onToggleVisible={toggleVisible}
            providerSettings={providerSettings}
            recommendationAvailable={Boolean(creation?.proposal) && !evidenceChanged}
            search={search}
            searchError={searchError}
            searchHasMore={searchHasMore}
            searchIndexedChats={indexedChats}
            searchIndexing={searchIndexing}
            searchLoading={searchLoading}
            searchTotalChats={totalIndexChats}
            selectedEntries={selectedEntries}
            selectedEstimate={selectedEstimate}
            selectedSessionIds={selectedSessionIds}
            visibleSessions={searchEntries}
          />
        ) : step === "recommendation" && creation?.proposal ? (
          <TrainingRunReviewStep
            busy={busy}
            creation={creation}
            onAddChats={() => setStep("evidence")}
            onClose={() => void closeDialog()}
            onCreateTaskset={() => void createTaskset()}
            onCreationChange={setCreation}
            sources={sources}
            training={training}
          />
        ) : step === "recommendation" && creation?.state === "awaiting_questions" ? (
          <div className="training-evidence-required">
            <div className="training-dialog-scroll-body"><div className="training-run-step-heading"><h3>More evidence is needed</h3><p>{creation.blockingQuestions[0]?.prompt ?? creation.blockedReason ?? "Add supporting evidence before authoring continues."}</p></div></div>
            <div className="training-dialog-actions"><button className="training-button" type="button" onClick={() => setStep("evidence")}>Add chats</button></div>
          </div>
        ) : (
          <div className="training-recommendation-loading">
            {creation?.state === "failed" ? <><h3>Analysis failed</h3><p>{creation.blockedReason}</p></> : <><Loader2 className="spin" size={18} /><p>Preparing the recommendation…</p></>}
          </div>
        )}
      </section>
    </div>
  );
}

function aggregateEstimate(sessionIds: string[], estimates: Record<string, { messageCount: number; estimatedTokens: number }>) {
  let messageCount = 0;
  let estimatedTokens = 0;
  let measuredChats = 0;
  for (const sessionId of sessionIds) {
    const estimate = estimates[sessionId];
    if (!estimate) continue;
    measuredChats += 1;
    messageCount += estimate.messageCount;
    estimatedTokens += estimate.estimatedTokens;
  }
  return { messageCount, estimatedTokens, measuredChats };
}

function backLabel(step: NewModelStep): string {
  if (step === "automatic_scope") return "Back to start mode";
  if (step === "automatic_candidates") return "Back to scan scope";
  if (step === "manual_goal") return "Back to start mode";
  if (step === "evidence") return "Back to capability";
  return "Back to evidence";
}

function defaultMinerConfig(): TaskMinerConfig {
  return {
    schemaVersion: "openpond.taskMinerConfig.v1",
    enabled: false,
    localOnly: true,
    observationWindowDays: 30,
    minimumRecurrence: 3,
    clustering: "hybrid_deterministic_first",
    consentRequired: true,
  };
}
