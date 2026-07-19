import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppPreferences,
  BaseModelCandidate,
  BaseModelPreference,
  ChatModelRef,
  ChatProvider,
  CodexReasoningEffort,
  CreateImproveRun,
  LocalProject,
  ProviderSettings,
  Session,
  TaskCandidate,
  TaskCreationSnapshot,
  TaskMinerConfig,
  TaskMinerRun,
  Taskset,
  TrainingChatSearchEntry,
  TrainingSourceRef,
} from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import { normalizeChatModel } from "../../lib/app-models";
import { ArrowLeft, Loader2, X } from "../icons";
import { shouldRevealMinerCandidates, trainingAuthoringModel, type NewModelStep } from "../training/training-flow";
import { TrainingAutomaticCandidatesStep } from "../training/TrainingAutomaticCandidatesStep";
import { TrainingAutomaticScopeStep } from "../training/TrainingAutomaticScopeStep";
import { TrainingBaseModelStep } from "../training/TrainingBaseModelStep";
import { TrainingDatasetStep } from "../training/TrainingDatasetStep";
import { TrainingRunReviewStep } from "../training/TrainingRunReviewStep";
import { TrainingSourceStep } from "../training/TrainingSourceStep";
import {
  TrainingStartModeStep,
  type NewModelMode,
  type NewModelSetup,
} from "../training/TrainingStartModeStep";

type TrainingController = ReturnType<typeof useTraining>;
const CHAT_SEARCH_PAGE_SIZE = 20;
const TrainingComputeDialog = lazy(() =>
  import("../training/TrainingComputeDialog").then((module) => ({
    default: module.TrainingComputeDialog,
  })));

export type CreateImproveAuthoringTarget = TaskCreationSnapshot["request"]["targetIntent"];

export function CreateImproveAuthoringDialog({
  defaultModel,
  initialCreation = null,
  initialObjective,
  initialSessionIds = [],
  onClose,
  onModelCreatedFromTaskset,
  onTasksetCreated,
  preferences,
  providerSettings,
  reasoningEffort,
  resourceIntent = "workproduct",
  sessions,
  sources,
  training,
  targetIntent = { kind: "model", id: null, displayName: null, operation: "create" },
}: {
  defaultModel: ChatModelRef;
  initialCreation?: TaskCreationSnapshot | null;
  initialObjective: string | null;
  initialSessionIds?: string[];
  onClose: () => void;
  onModelCreatedFromTaskset?: (
    taskset: Taskset,
    run: CreateImproveRun,
  ) => void | Promise<void>;
  onTasksetCreated: (creation: TaskCreationSnapshot) => void | Promise<void>;
  preferences: AppPreferences["training"];
  providerSettings: ProviderSettings | null;
  reasoningEffort: CodexReasoningEffort;
  resourceIntent?: TaskCreationSnapshot["request"]["resourceIntent"];
  localProjects?: LocalProject[];
  sessions: Session[];
  sources: TrainingSourceRef[];
  training: TrainingController;
  targetIntent?: CreateImproveAuthoringTarget;
}) {
  const initialAuthoringModel = trainingAuthoringModel(preferences, defaultModel);
  const baseModelCandidates = training.payload?.baseModelCandidates ?? [];
  const restoredSessionIds = sources
    .filter((source) => initialCreation?.request.sourceIds.includes(source.id))
    .map((source) => source.sessionId);
  const [step, setStep] = useState<NewModelStep>(() => initialCreationStep(initialCreation));
  const [setup, setSetup] = useState<NewModelSetup | null>(
    initialCreation?.request.entryMode ?? null,
  );
  const mode: NewModelMode | null =
    setup === "automated" || setup === "manual" ? setup : null;
  const [objective, setObjective] = useState(initialCreation?.request.objective ?? initialObjective ?? "");
  const [preferredBaseModelKey, setPreferredBaseModelKey] = useState<string | null>(
    () => candidateForPreference(
      baseModelCandidates,
      initialCreation?.request.preferredBaseModel ?? null,
      initialCreation?.request.preferredBaseModelId ?? null,
    )?.selectionKey ?? null,
  );
  const [selectedExistingTasksetId, setSelectedExistingTasksetId] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(initialCreation?.request.candidateId ?? null);
  const [authoringProvider, setAuthoringProvider] = useState<ChatProvider>(
    initialCreation?.request.analysisModel?.providerId ?? initialAuthoringModel.providerId,
  );
  const [authoringModel, setAuthoringModel] = useState(
    initialCreation?.request.analysisModel?.modelId ?? initialAuthoringModel.modelId,
  );
  const [authoringReasoningEffort, setAuthoringReasoningEffort] = useState(
    initialCreation?.request.analysisReasoningEffort ?? reasoningEffort,
  );
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
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set([...initialSessionIds, ...restoredSessionIds]),
  );
  const [estimatesBySessionId, setEstimatesBySessionId] = useState<Record<string, { messageCount: number; estimatedTokens: number }>>({});
  const [creation, setCreation] = useState<TaskCreationSnapshot | null>(initialCreation);
  const [evidenceChanged, setEvidenceChanged] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [authoringError, setAuthoringError] = useState<string | null>(null);
  const [preparingScan, setPreparingScan] = useState(false);
  const [computeOpen, setComputeOpen] = useState(false);
  const [activeMinerRunId, setActiveMinerRunId] = useState<string | null>(null);
  const [scanCandidates, setScanCandidates] = useState<TaskCandidate[]>([]);
  const [minerConfig, setMinerConfig] = useState<TaskMinerConfig>(() => training.payload?.minerConfig ?? defaultMinerConfig());
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const generatedBaselineSessionIds = useMemo(
    () => new Set(
      sources
        .filter(
          (source) => {
            const workflowSignature = source.metadata.workflowSignature;
            return (
              source.metadata.frontierBaseline === true
              || workflowSignature === "cross-system-operations"
              || (
                typeof workflowSignature === "string"
                && workflowSignature.startsWith("baseline:")
              )
              || Boolean(source.metadata.crossSystemOperations)
            );
          },
        )
        .map((source) => source.sessionId),
    ),
    [sources],
  );
  const eligibleSessions = useMemo(
    () => sessions.filter(
      (session) =>
        !session.systemKind
        && !session.hiddenFromDefaultSidebar
        && session.status !== "active"
        && !generatedBaselineSessionIds.has(session.id),
    ),
    [generatedBaselineSessionIds, sessions],
  );
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
  const busy = analyzing || preparingScan || Boolean(training.busyAction);
  const usesBaseModelStep = resourceIntent === "workproduct" && targetIntent.kind === "model";
  const preferredBaseModelCandidate = useMemo(
    () => baseModelCandidates.find(
      (candidate) => candidate.selectionKey === preferredBaseModelKey,
    ) ?? null,
    [baseModelCandidates, preferredBaseModelKey],
  );
  const preferredBaseModel = preferredBaseModelCandidate?.preference ?? null;

  useEffect(
    () => setObjective(initialCreation?.request.objective ?? initialObjective ?? ""),
    [initialCreation?.id, initialObjective],
  );

  useEffect(() => {
    if (preferredBaseModelKey || !initialCreation) return;
    const restored = candidateForPreference(
      baseModelCandidates,
      initialCreation.request.preferredBaseModel,
      initialCreation.request.preferredBaseModelId,
    );
    if (restored) setPreferredBaseModelKey(restored.selectionKey);
  }, [baseModelCandidates, initialCreation, preferredBaseModelKey]);

  useEffect(() => {
    if (step !== "automatic_scope" || activeMinerRunId) return;
    const persisted = training.payload?.minerRuns.find((run) => ["queued", "running", "cancelling"].includes(run.status));
    if (persisted) setActiveMinerRunId(persisted.id);
  }, [activeMinerRunId, step, training.payload?.minerRuns]);

  useEffect(() => {
    if (!shouldRevealMinerCandidates(step, activeMinerRun)) return;
    const candidateIds = new Set(activeMinerRun.candidateIds);
    setScanCandidates(training.payload?.candidates.filter((candidate) => candidateIds.has(candidate.id)) ?? []);
    setStep("automatic_candidates");
  }, [activeMinerRun, step, training.payload?.candidates]);

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

  function selectMode(nextMode: NewModelSetup) {
    if (nextMode !== setup && setup !== null) setEvidenceChanged(true);
    setSetup(nextMode);
  }

  function continueFromStart() {
    if (usesBaseModelStep) {
      setStep("base_model");
      return;
    }
    continueFromBaseModel();
  }

  function continueFromBaseModel() {
    if (usesBaseModelStep && !preferredBaseModelCandidate?.available) return;
    if (setup === "existing_dataset") {
      setStep("existing_dataset");
      return;
    }
    if (mode === "automated") setStep("automatic_scope");
    if (mode === "manual") setStep("evidence");
  }

  async function createModelFromExistingTaskset() {
    if (!selectedExistingTasksetId || !onModelCreatedFromTaskset || !preferredBaseModel) return;
    setAnalyzing(true);
    setAuthoringError(null);
    try {
      const run = await training.actions.createModelFromTaskset(
        selectedExistingTasksetId,
        preferredBaseModel,
      );
      if (!run) {
        throw new Error(
          training.error ?? "OpenPond could not create the Model from this Dataset.",
        );
      }
      const taskset = training.payload?.tasksets.find(
        (candidate) => candidate.id === selectedExistingTasksetId,
      );
      if (!taskset) {
        throw new Error("The selected Dataset could not be reloaded.");
      }
      await onModelCreatedFromTaskset(taskset, run);
    } catch (error) {
      setAuthoringError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalyzing(false);
    }
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
    if (missingSessionIds.length) {
      const added = await training.actions.addSources(missingSessionIds);
      if (!added) throw new Error("OpenPond could not attach the selected evidence. Review the training error and try again.");
      selected.push(...added);
    }
    if (selected.length !== selectedSessionIds.size) {
      throw new Error("Some selected evidence could not be resolved. Reselect the chats before continuing.");
    }
    return selected;
  }

  async function scanForCandidates() {
    setPreparingScan(true);
    try {
      const nextConfig = { ...minerConfig, enabled: true };
      const runRecord: TaskMinerRun | null = await training.actions.runMiner(
        [],
        eligibleSessions.map((session) => session.id),
        nextConfig,
      );
      if (runRecord) setActiveMinerRunId(runRecord.id);
    } finally {
      setPreparingScan(false);
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
    setAuthoringError(null);
    try {
      const selectedSources = await ensureSelectedSources();
      const reusableDraftRunId = creation?.request.sourceIds.length === 0
        ? creation.request.createImproveRunId
        : null;
      if (
        creation
        && !reusableDraftRunId
        && evidenceChanged
        && !["cancelled", "failed", "ready"].includes(creation.state)
      ) {
        const staleCreation = creation;
        await training.actions.cancelCreation(staleCreation.id);
      }
      const next = await training.actions.startCreation(selectedSources.map((source) => source.id), {
        surface: mode === "automated" ? "task_candidate" : "training_page",
        mode: "defaults",
        entryMode: mode ?? "manual",
        resourceIntent,
        objective: objective.trim() || undefined,
        methodHint: null,
        preferredBaseModel: usesBaseModelStep ? preferredBaseModel : null,
        candidateId: selectedCandidateId,
        analysisModel: { providerId: authoringProvider, modelId: authoringModel },
        analysisReasoningEffort: authoringReasoningEffort,
        createImproveRunId: reusableDraftRunId,
        targetIntent,
      });
      if (!next) throw new Error("OpenPond could not start Taskset authoring.");
      setCreation(next);
      setEvidenceChanged(false);
      if (next.state !== "awaiting_disclosure_approval") setStep("recommendation");
    } catch (error) {
      setAuthoringError(error instanceof Error ? error.message : String(error));
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

  async function retryAuthoring() {
    if (!creation || creation.state !== "failed") return;
    setAnalyzing(true);
    setAuthoringError(null);
    try {
      const next = await training.actions.retryCreation(creation.id);
      if (!next) {
        throw new Error(training.error ?? "OpenPond could not retry Taskset authoring.");
      }
      setCreation(next);
      setStep("recommendation");
    } catch (error) {
      setAuthoringError(error instanceof Error ? error.message : String(error));
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
    if (step === "base_model") setStep("start");
    else if (step === "existing_dataset") setStep("base_model");
    else if (step === "automatic_scope") setStep(usesBaseModelStep ? "base_model" : "start");
    else if (step === "automatic_candidates") setStep("automatic_scope");
    else if (step === "evidence") {
      if (creation?.state === "awaiting_disclosure_approval") void declineDisclosure();
      setStep(mode === "automated"
        ? "automatic_candidates"
        : usesBaseModelStep ? "base_model" : "start");
    } else if (step === "recommendation") setStep("evidence");
  }

  async function closeDialog() {
    const activeCreation = creation;
    if (activeCreation && !["cancelled", "failed", "ready"].includes(activeCreation.state)) await training.actions.cancelCreation(activeCreation.id);
    onClose();
  }

  async function createTaskset() {
    if (!creation || creation.state !== "awaiting_materialization_approval") return;
    setAuthoringError(null);
    try {
      const next = await training.actions.materialize(creation.id, true);
      if (!next) throw new Error("OpenPond could not materialize the approved Taskset.");
      setCreation(next);
      if (next.state === "ready") await onTasksetCreated(next);
    } catch (error) {
      setAuthoringError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="training-dialog-backdrop" role="presentation" onMouseDown={() => void closeDialog()}>
      <section
        ref={dialogRef}
        className={`training-dialog training-run-dialog ${step === "start" ? "training-run-start-step" : "training-run-workflow-step"}`}
        role="dialog"
        aria-modal="true"
        aria-label={dialogTitle(targetIntent, resourceIntent)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); void closeDialog(); } }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="training-dialog-header">
          <div className="training-run-dialog-title">
            {step !== "start" ? (
              <button
                className="training-icon-button"
                data-autofocus
                type="button"
                aria-label={backLabel(step, usesBaseModelStep, mode)}
                onClick={goBack}
              >
                <ArrowLeft size={16} />
              </button>
            ) : null}
            <h2>{step === "recommendation" ? reviewTitle(targetIntent, resourceIntent) : dialogTitle(targetIntent, resourceIntent)}</h2>
          </div>
          <button className="training-icon-button" type="button" aria-label="Close" onClick={() => void closeDialog()}><X size={16} /></button>
        </div>

        {step === "start" ? (
          <TrainingStartModeStep
            allowExistingDataset={usesBaseModelStep && Boolean(onModelCreatedFromTaskset)}
            mode={setup}
            targetLabel={targetLabel(targetIntent, resourceIntent)}
            onChange={selectMode}
            onContinue={continueFromStart}
          />
        ) : step === "base_model" ? (
          <TrainingBaseModelStep
            busy={training.busyAction === "scan-base-models"}
            candidates={baseModelCandidates}
            value={preferredBaseModelKey}
            onChange={setPreferredBaseModelKey}
            onContinue={continueFromBaseModel}
            onManage={() => setComputeOpen(true)}
            onScan={() => void training.actions.scanBaseModels()}
          />
        ) : step === "existing_dataset" ? (
          <TrainingDatasetStep
            busy={busy}
            selectedTasksetId={selectedExistingTasksetId}
            state={training.payload}
            onChange={setSelectedExistingTasksetId}
            onCreate={() => void createModelFromExistingTaskset()}
          />
        ) : step === "automatic_scope" ? (
          <TrainingAutomaticScopeStep
            chatPreview={eligibleSessions.slice(0, 6).map((session) => ({
              id: session.id,
              title: session.title,
              updatedAt: session.updatedAt,
            }))}
            chatCount={eligibleSessions.length}
            config={minerConfig}
            estimate={scanEstimate}
            onCancel={() => void cancelScan()}
            onConfigChange={setMinerConfig}
            onScan={() => void scanForCandidates()}
            run={activeMinerRun}
            scanning={scanning}
          />
        ) : step === "automatic_candidates" ? (
          <TrainingAutomaticCandidatesStep candidates={scanCandidates} onRescan={() => { setActiveMinerRunId(null); setStep("automatic_scope"); }} onSelect={selectCandidate} />
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
            onObjectiveChange={changeObjective}
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
            targetLabel={targetLabel(targetIntent, resourceIntent)}
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
            createLabel={resourceIntent === "dataset"
              ? "Create Dataset"
              : targetIntent.kind === "model" ? "Create model" : undefined}
            editDataLabel={resourceIntent === "dataset"
              ? "Edit sources"
              : targetIntent.kind === "model" ? "Edit Dataset" : undefined}
            resourceIntent={resourceIntent}
          />
        ) : step === "recommendation" && creation?.state === "awaiting_questions" ? (
          <div className="training-evidence-required">
            <div className="training-dialog-scroll-body"><div className="training-run-step-heading"><h3>More evidence is needed</h3><p>{creation.blockingQuestions[0]?.prompt ?? creation.blockedReason ?? "Add supporting evidence before authoring continues."}</p></div></div>
            <div className="training-dialog-actions">
              <button className="training-button" type="button" onClick={() => setStep("evidence")}>
                {resourceIntent === "dataset"
                  ? "Edit sources"
                  : targetIntent.kind === "model" ? "Edit Dataset" : "Add chats"}
              </button>
            </div>
          </div>
        ) : step === "recommendation" && creation?.state === "failed" ? (
          <div className="training-evidence-required">
            <div className="training-dialog-scroll-body">
              <div className="training-run-step-heading">
                <h3>Analysis failed</h3>
                <p>{authoringFailureCopy(creation.blockedReason)}</p>
              </div>
              {objective ? (
                <div className="training-evidence-objective">
                  <span>Capability</span>
                  <strong>{objective}</strong>
                </div>
              ) : null}
              <p className="training-empty">
                Retry keeps the exact approved evidence, model, and disclosure receipt. Change evidence starts a new review if the selection is too large or no longer representative.
              </p>
            </div>
            <div className="training-dialog-actions">
              <button className="training-button secondary" type="button" disabled={busy} onClick={() => setStep("evidence")}>Change evidence</button>
              <button className="training-button" type="button" disabled={busy} onClick={() => void retryAuthoring()}>
                {analyzing ? <Loader2 className="spin" size={14} /> : null}
                Retry approved evidence
              </button>
            </div>
          </div>
        ) : (
          <div className="training-recommendation-loading">
            {creation?.state === "failed" ? <><h3>Analysis failed</h3><p>{creation.blockedReason}</p></> : <><Loader2 className="spin" size={18} /><p>Preparing the recommendation…</p></>}
          </div>
        )}
        {authoringError ? <div className="training-banner error" role="alert">{authoringError}</div> : null}
      </section>
      {computeOpen ? (
        <Suspense fallback={(
          <div className="training-dialog-backdrop training-compute-dialog-backdrop">
            <section
              aria-label="Loading local model manager"
              aria-modal="true"
              className="training-dialog"
              role="dialog"
            >
              <div className="training-dialog-header">
                <div>
                  <h2>Manage local models</h2>
                  <p>Loading compute inventory…</p>
                </div>
                <Loader2 className="spin" size={16} />
              </div>
            </section>
          </div>
        )}>
          <TrainingComputeDialog
            connection={training.connection}
            onCandidatesChanged={training.refresh}
            onClose={() => setComputeOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function initialCreationStep(creation: TaskCreationSnapshot | null): NewModelStep {
  if (!creation) return "start";
  if (creation.state === "awaiting_disclosure_approval") return "evidence";
  return "recommendation";
}

function candidateForPreference(
  candidates: BaseModelCandidate[],
  preference: BaseModelPreference | null,
  legacyModelId: string | null,
): BaseModelCandidate | null {
  if (preference) {
    const exact = candidates.find((candidate) =>
      candidate.preference.modelId === preference.modelId
      && candidate.preference.source === preference.source
      && candidate.preference.revision === preference.revision
      && candidate.preference.modelAssetId === preference.modelAssetId);
    if (exact) return exact;
  }
  const modelId = preference?.modelId ?? legacyModelId;
  return modelId
    ? candidates.find((candidate) => candidate.preference.modelId === modelId) ?? null
    : null;
}

function authoringFailureCopy(reason: string | null): string {
  if (!reason) return "The authoring model did not return a proposal.";
  if (reason.trim().toLowerCase() === "terminated") {
    return "OpenPond Chat closed the Taskset authoring stream before a proposal was returned. No Taskset was created.";
  }
  return reason;
}

function dialogTitle(
  target: CreateImproveAuthoringTarget,
  resourceIntent: TaskCreationSnapshot["request"]["resourceIntent"],
): string {
  if (resourceIntent === "dataset") return "New Dataset";
  if (target.kind === "agent") {
    return target.operation === "improve"
      ? `Improve ${target.displayName ?? "agent"}`
      : "New agent";
  }
  if (target.kind === "model") return "New model";
  return "New change";
}

function targetLabel(
  target: CreateImproveAuthoringTarget,
  resourceIntent: TaskCreationSnapshot["request"]["resourceIntent"],
): string {
  if (resourceIntent === "dataset") return "dataset";
  if (target.kind === "agent") return "agent";
  if (target.kind === "model") return "model";
  return "workproduct";
}

function reviewTitle(
  target: CreateImproveAuthoringTarget,
  resourceIntent: TaskCreationSnapshot["request"]["resourceIntent"],
): string {
  if (resourceIntent === "dataset") return "Review Dataset";
  if (target.kind === "model") return "Review model";
  if (target.kind === "agent") return target.operation === "improve" ? "Review agent change" : "Review agent";
  return "Review change";
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

function backLabel(
  step: NewModelStep,
  usesBaseModelStep: boolean,
  mode: NewModelMode | null,
): string {
  if (step === "base_model") return "Back to setup";
  if (step === "existing_dataset") return "Back to base model";
  if (step === "automatic_scope") return usesBaseModelStep ? "Back to base model" : "Back to setup";
  if (step === "automatic_candidates") return "Back to scan scope";
  if (step === "evidence") {
    if (mode === "automated") return "Back to repeated workflows";
    return usesBaseModelStep ? "Back to base model" : "Back to setup";
  }
  return "Back to Dataset";
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
