import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppPreferences,
  ChatModelRef,
  ChatProvider,
  CodexReasoningEffort,
  CreateImproveRun,
  DatasetBuildSpecification,
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
import { Loader2 } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";
import { shouldRevealMinerCandidates, trainingAuthoringModel, type NewModelStep } from "../training/training-flow";
import { TrainingAutomaticCandidatesStep } from "../training/TrainingAutomaticCandidatesStep";
import { TrainingAutomaticScopeStep } from "../training/TrainingAutomaticScopeStep";
import { TrainingBaseModelStep } from "../training/TrainingBaseModelStep";
import { TrainingDatasetStep } from "../training/TrainingDatasetStep";
import { emptyBuildSpecification } from "../training/TrainingEvidenceEditor";
import { TrainingRunReviewStep } from "../training/TrainingRunReviewStep";
import { TrainingSourceStep } from "../training/TrainingSourceStep";
import {
  TrainingStartModeStep,
  type AgentSourceMode,
  type DatasetEvidenceIntent,
  type NewModelMode,
  type NewModelSetup,
} from "../training/TrainingStartModeStep";
import { shouldCancelCreationOnDialogDismiss } from "./create-improve-authoring-cancellation";
import { CreateImproveAuthoringShell } from "./CreateImproveAuthoringShell";
import {
  aggregateEstimate,
  authoringFailureCopy,
  backLabel,
  candidateForPreference,
  defaultMinerConfig,
  dialogTitle,
  initialCreationStep,
  reviewTitle,
  targetLabel,
  type CreateImproveAuthoringTarget,
} from "./create-improve-authoring-model";

type TrainingController = ReturnType<typeof useTraining>;
const CHAT_SEARCH_PAGE_SIZE = 20;

export type { CreateImproveAuthoringTarget } from "./create-improve-authoring-model";

export function CreateImproveAuthoringDialog({
  datasetBuildMode = false,
  defaultModel,
  datasetBuildBackLabel = "Back to Dataset sources",
  initialCreation = null,
  initialExistingTasksetId = null,
  initialObjective,
  initialSessionIds = [],
  onClose,
  onAgentPromptSubmitted,
  onBackToDatasetSources,
  onOpenComputeSettings,
  onCreateDataset,
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
  presentation = "dialog",
}: {
  datasetBuildMode?: boolean;
  datasetBuildBackLabel?: string;
  defaultModel: ChatModelRef;
  initialCreation?: TaskCreationSnapshot | null;
  initialExistingTasksetId?: string | null;
  initialObjective: string | null;
  initialSessionIds?: string[];
  onClose: () => void;
  onAgentPromptSubmitted?: (input: {
    analysisModel: ChatModelRef;
    objective: string;
  }) => void | Promise<void>;
  onBackToDatasetSources?: () => void;
  onOpenComputeSettings: () => void;
  onCreateDataset?: () => void;
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
  presentation?: "dialog" | "embedded";
}) {
  const initialAuthoringModel = trainingAuthoringModel(preferences, defaultModel);
  const baseModelCandidates = training.payload?.baseModelCandidates ?? [];
  const isAgentAuthoring =
    resourceIntent === "workproduct" && targetIntent.kind === "agent";
  const usesBaseModelStep =
    resourceIntent === "workproduct" && targetIntent.kind === "model";
  const restoredSessionIds = sources
    .filter((source) => initialCreation?.request.sourceIds.includes(source.id))
    .map((source) => source.sessionId);
  const [step, setStep] = useState<NewModelStep>(() =>
    initialCreation
      ? initialCreationStep(initialCreation)
      : datasetBuildMode
        ? "start"
        : usesBaseModelStep
          ? "existing_dataset"
          : "start",
  );
  const [setup, setSetup] = useState<NewModelSetup | null>(() => {
    if (initialCreation && isAgentAuthoring) {
      return initialCreation.request.sourceIds.length > 0
        ? "from_chats"
        : "from_prompt";
    }
    return initialCreation
      ? resourceIntent === "dataset" || targetIntent.kind === "model"
        ? initialCreation.request.buildIntent
        : initialCreation.request.entryMode
      : usesBaseModelStep ? "existing_dataset" : null;
  });
  const buildIntent: DatasetEvidenceIntent | null =
    setup === "demonstrations"
    || setup === "preferences"
    || setup === "verifiable_reward"
    || setup === "rubric"
    || setup === "discovery"
      ? setup
      : null;
  const mode: NewModelMode | null =
    buildIntent === "discovery"
      ? "automated"
      : buildIntent
        ? "manual"
        : null;
  const agentSourceMode: AgentSourceMode | null =
    setup === "from_prompt" || setup === "from_chats" ? setup : null;
  const [objective, setObjective] = useState(initialCreation?.request.objective ?? initialObjective ?? "");
  const [buildSpecification, setBuildSpecification] = useState<DatasetBuildSpecification | null>(
    () => initialCreation?.request.buildSpecification
      ?? (initialCreation?.request.buildIntent && initialCreation.request.buildIntent !== "discovery"
        ? emptyBuildSpecification(initialCreation.request.buildIntent)
        : null),
  );
  const [preferredBaseModelKey, setPreferredBaseModelKey] = useState<string | null>(
    () => candidateForPreference(
      baseModelCandidates,
      initialCreation?.request.preferredBaseModel ?? null,
      initialCreation?.request.preferredBaseModelId ?? null,
    )?.selectionKey ?? null,
  );
  const [selectedExistingTasksetId, setSelectedExistingTasksetId] = useState<string | null>(initialExistingTasksetId);
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
  const dialogDismissedRef = useRef(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set([...initialSessionIds, ...restoredSessionIds]),
  );
  const [estimatesBySessionId, setEstimatesBySessionId] = useState<Record<string, { messageCount: number; estimatedTokens: number }>>({});
  const [creation, setCreation] = useState<TaskCreationSnapshot | null>(initialCreation);
  const [evidenceChanged, setEvidenceChanged] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [authoringError, setAuthoringError] = useState<string | null>(null);
  useErrorToast(searchError, { prefix: "Chat search" });
  useErrorToast(authoringError);
  const [preparingScan, setPreparingScan] = useState(false);
  const [activeMinerRunId, setActiveMinerRunId] = useState<string | null>(null);
  const [scanCandidates, setScanCandidates] = useState<TaskCandidate[]>([]);
  const [minerConfig, setMinerConfig] = useState<TaskMinerConfig>(() => training.payload?.minerConfig ?? defaultMinerConfig());

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
  const selectsChats = step === "automatic_scope"
    || (step === "evidence" && setup !== "from_prompt");
  const preferredBaseModelCandidate = useMemo(
    () => baseModelCandidates.find(
      (candidate) => candidate.selectionKey === preferredBaseModelKey,
    ) ?? null,
    [baseModelCandidates, preferredBaseModelKey],
  );
  const preferredBaseModel = preferredBaseModelCandidate?.preference ?? null;

  useEffect(() => {
    // React Strict Mode probes effects with a setup/cleanup/setup cycle in dev.
    // Reset here so that probe cannot look like a real user dismissal.
    dialogDismissedRef.current = false;
    return () => {
      dialogDismissedRef.current = true;
      searchRequestRef.current += 1;
    };
  }, []);

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
    if (!selectsChats) return;
    setSearchEntries([]);
    setSearchTotal(0);
    setSearchHasMore(false);
    setSearchError(null);
  }, [search, selectsChats]);

  useEffect(() => {
    if (!selectsChats) return undefined;
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
  }, [chatSearchCandidates, search, searchRefreshNonce, selectsChats, training.actions]);

  useEffect(() => {
    if (!selectsChats || !search.trim() || !searchIndexing) return undefined;
    const timer = window.setTimeout(() => setSearchRefreshNonce((current) => current + 1), 1_500);
    return () => window.clearTimeout(timer);
  }, [search, searchIndexing, selectsChats]);

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
    if (!selectsChats || !visibleSessionKey) return undefined;
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
  }, [selectsChats, training.actions, visibleSessionKey]);

  const selectedEstimate = useMemo(() => aggregateEstimate([...selectedSessionIds], estimatesBySessionId), [estimatesBySessionId, selectedSessionIds]);

  function selectMode(nextMode: NewModelSetup) {
    if (nextMode !== setup && setup !== null) setEvidenceChanged(true);
    setSetup(nextMode);
    if (
      nextMode === "demonstrations"
      || nextMode === "preferences"
      || nextMode === "verifiable_reward"
      || nextMode === "rubric"
    ) {
      setBuildSpecification((current) =>
        current?.kind === nextMode ? current : emptyBuildSpecification(nextMode));
    } else if (nextMode === "discovery") {
      setBuildSpecification(null);
    }
  }

  function continueFromStart() {
    if (setup === "existing_dataset") {
      setStep("existing_dataset");
      return;
    }
    if (buildIntent === "discovery") {
      setStep("automatic_scope");
      return;
    }
    if (usesBaseModelStep) {
      setStep("base_model");
      return;
    }
    continueFromBaseModel();
  }

  function continueFromBaseModel() {
    if (usesBaseModelStep && !preferredBaseModelCandidate?.available) return;
    if (setup === "existing_dataset") {
      void createModelFromExistingTaskset();
      return;
    }
    if (agentSourceMode) {
      setStep("evidence");
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
    const sessionIds = [...selectedSessionIds];
    if (!sessionIds.length) return;
    setPreparingScan(true);
    try {
      const nextConfig = { ...minerConfig, enabled: true };
      const runRecord: TaskMinerRun | null = await training.actions.runMiner(
        [],
        sessionIds,
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
    setSetup(candidate.recommendation.tactic === "grpo_rft"
      || candidate.recommendation.tactic === "agentic_rl"
      ? "verifiable_reward"
      : candidate.recommendation.tactic === "preference"
        ? "preferences"
        : "demonstrations");
    const resolvedIntent = candidate.recommendation.tactic === "grpo_rft"
      || candidate.recommendation.tactic === "agentic_rl"
      ? "verifiable_reward"
      : candidate.recommendation.tactic === "preference"
        ? "preferences"
        : "demonstrations";
    const candidateSpecification = emptyBuildSpecification(resolvedIntent);
    setBuildSpecification(candidateSpecification.kind === "demonstrations"
      ? { ...candidateSpecification, behavior: candidate.summary }
      : candidateSpecification.kind === "preferences"
        ? { ...candidateSpecification, preference: candidate.summary }
        : { ...candidateSpecification, task: candidate.summary });
    setEvidenceChanged(true);
    setStep("evidence");
  }

  async function analyze() {
    setAnalyzing(true);
    setAuthoringError(null);
    try {
      if (isAgentAuthoring && agentSourceMode === "from_prompt") {
        if (!onAgentPromptSubmitted) {
          throw new Error("OpenPond could not continue from the Agent purpose.");
        }
        await onAgentPromptSubmitted({
          analysisModel: { providerId: authoringProvider, modelId: authoringModel },
          objective: objective.trim(),
        });
        return;
      }
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
        buildIntent: buildIntent ?? "demonstrations",
        buildSpecification,
        objective: objective.trim() || undefined,
        methodHint: null,
        preferredBaseModel: usesBaseModelStep ? preferredBaseModel : null,
        candidateId: selectedCandidateId,
        analysisModel: { providerId: authoringProvider, modelId: authoringModel },
        analysisReasoningEffort: authoringReasoningEffort,
        createImproveRunId: reusableDraftRunId,
        targetIntent,
      });
      if (!next) throw new Error(isAgentAuthoring
        ? "OpenPond could not prepare the Agent review."
        : "OpenPond could not start Taskset authoring.");
      if (dialogDismissedRef.current) {
        if (shouldCancelCreationOnDialogDismiss(next)) {
          await training.actions.cancelCreation(next.id);
        }
        return;
      }
      setCreation(next);
      setEvidenceChanged(false);
      if (next.state !== "awaiting_disclosure_approval") setStep("recommendation");
    } catch (error) {
      if (!dialogDismissedRef.current) {
        setAuthoringError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!dialogDismissedRef.current) setAnalyzing(false);
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
        throw new Error(training.error ?? (isAgentAuthoring
          ? "OpenPond could not retry the Agent review."
          : "OpenPond could not retry Taskset authoring."));
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

  async function returnToDatasetSources() {
    if (!confirmDiscardEvidence()) return;
    const activeCreation = creation;
    try {
      if (shouldCancelCreationOnDialogDismiss(activeCreation)) {
        await training.actions.cancelCreation(activeCreation.id);
      }
    } finally {
      onBackToDatasetSources?.();
    }
  }

  function goBack() {
    if (step === "base_model") {
      setStep(setup === "existing_dataset" ? "existing_dataset" : "start");
    }
    else if (step === "existing_dataset") setStep("base_model");
    else if (step === "automatic_scope") {
      setStep(datasetBuildMode
        ? "evidence"
        : usesBaseModelStep ? "base_model" : "start");
    }
    else if (step === "automatic_candidates") setStep("automatic_scope");
    else if (step === "evidence") {
      if (datasetBuildMode && onBackToDatasetSources) {
        void returnToDatasetSources();
        return;
      }
      if (creation?.state === "awaiting_disclosure_approval") void declineDisclosure();
      setStep(mode === "automated"
        ? "automatic_candidates"
        : usesBaseModelStep ? "base_model" : "start");
    } else if (step === "recommendation") setStep("evidence");
  }

  async function closeDialog() {
    if (dialogDismissedRef.current) return;
    if (!confirmDiscardEvidence()) return;
    dialogDismissedRef.current = true;
    searchRequestRef.current += 1;
    const activeCreation = creation;
    try {
      if (shouldCancelCreationOnDialogDismiss(activeCreation)) {
        await training.actions.cancelCreation(activeCreation.id);
      }
    } finally {
      onClose();
    }
  }

  function confirmDiscardEvidence(): boolean {
    if (!evidenceChanged || creation?.state === "ready") return true;
    if (typeof window === "undefined") return true;
    return window.confirm("Discard the unsaved Dataset evidence in this builder?");
  }

  async function openComputeSettings() {
    await closeDialog();
    onOpenComputeSettings();
  }

  async function createTaskset() {
    if (!creation || creation.state !== "awaiting_materialization_approval") return;
    setAuthoringError(null);
    try {
      const next = await training.actions.materialize(creation.id, true);
      if (!next) throw new Error(isAgentAuthoring
        ? "OpenPond could not continue from the approved Agent review."
        : "OpenPond could not materialize the approved Taskset.");
      if (next.state === "ready") {
        await onTasksetCreated(next);
        return;
      }
      setCreation(next);
    } catch (error) {
      setAuthoringError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <CreateImproveAuthoringShell
      ariaLabel={dialogTitle(targetIntent, resourceIntent)}
      backAriaLabel={datasetBuildMode && step === "evidence"
        ? datasetBuildBackLabel
        : datasetBuildMode && (step === "automatic_scope" || step === "recommendation")
          ? "Back to Dataset build"
        : backLabel(step, usesBaseModelStep, mode)}
      presentation={presentation}
      showBack={step !== "start" && step !== "existing_dataset"}
      step={step}
      title={step === "recommendation"
        ? reviewTitle(targetIntent, resourceIntent)
        : dialogTitle(targetIntent, resourceIntent)}
      onBack={goBack}
      onClose={() => void closeDialog()}
    >
        {step === "start" ? (
          <TrainingStartModeStep
            allowExistingDataset={usesBaseModelStep && Boolean(onModelCreatedFromTaskset)}
            mode={setup}
            operation={targetIntent.operation}
            targetLabel={targetLabel(targetIntent, resourceIntent)}
            onChange={selectMode}
            onContinue={continueFromStart}
          />
        ) : step === "base_model" ? (
          <TrainingBaseModelStep
            busy={training.busyAction === "scan-base-models"}
            candidates={baseModelCandidates}
            continueLabel={setup === "existing_dataset" ? "Create model" : "Continue"}
            value={preferredBaseModelKey}
            onChange={setPreferredBaseModelKey}
            onContinue={continueFromBaseModel}
            onManage={() => void openComputeSettings()}
            onScan={() => void training.actions.scanBaseModels()}
          />
        ) : step === "existing_dataset" ? (
          <TrainingDatasetStep
            busy={busy}
            selectedTasksetId={selectedExistingTasksetId}
            state={training.payload}
            onChange={setSelectedExistingTasksetId}
            onContinue={() => setStep("base_model")}
            onCreateDataset={onCreateDataset}
          />
        ) : step === "automatic_scope" ? (
          <TrainingAutomaticScopeStep
            config={minerConfig}
            estimatesBySessionId={estimatesBySessionId}
            estimate={selectedEstimate}
            matchingSessionCount={searchTotal}
            onCancel={() => void cancelScan()}
            onConfigChange={setMinerConfig}
            onLoadMore={() => void loadMoreChats()}
            onScan={() => void scanForCandidates()}
            onSearchChange={setSearch}
            onToggleSession={toggleSession}
            onToggleVisible={toggleVisible}
            run={activeMinerRun}
            scanning={scanning}
            search={search}
            searchError={searchError}
            searchHasMore={searchHasMore}
            searchIndexedChats={indexedChats}
            searchIndexing={searchIndexing}
            searchLoading={searchLoading}
            searchTotalChats={totalIndexChats}
            selectedEntries={selectedEntries}
            selectedSessionIds={selectedSessionIds}
            targetLabel={targetLabel(targetIntent, resourceIntent)}
            visibleSessions={searchEntries}
          />
        ) : step === "automatic_candidates" ? (
          <TrainingAutomaticCandidatesStep candidates={scanCandidates} onRescan={() => { setActiveMinerRunId(null); setStep("automatic_scope"); }} onSelect={selectCandidate} />
        ) : step === "evidence" && (mode || agentSourceMode) ? (
          <TrainingSourceStep
            authoringModel={authoringModel}
            authoringProvider={authoringProvider}
            authoringReasoningEffort={authoringReasoningEffort}
            busy={busy}
            disclosurePending={creation?.state === "awaiting_disclosure_approval"}
            buildIntent={buildIntent}
            buildSpecification={buildSpecification}
            estimatesBySessionId={estimatesBySessionId}
            matchingSessionCount={searchTotal}
            mode={agentSourceMode ?? mode!}
            objective={objective}
            onObjectiveChange={changeObjective}
            onBuildSpecificationChange={(next) => {
              setBuildSpecification(next);
              setEvidenceChanged(true);
            }}
            onAnalyze={() => void analyze()}
            onApproveDisclosure={() => void approveDisclosure()}
            onAuthoringModelChange={changeAuthoringModel}
            onAuthoringProviderChange={changeAuthoringProvider}
            onAuthoringReasoningEffortChange={changeReasoningEffort}
            onDeclineDisclosure={() => void declineDisclosure()}
            onDiscoverFromConversations={datasetBuildMode
              ? () => setStep("automatic_scope")
              : undefined}
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
            targetOperation={targetIntent.operation}
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
                  <span>{isAgentAuthoring ? "Agent purpose" : "Capability"}</span>
                  <strong>{objective}</strong>
                </div>
              ) : null}
              <p className="training-empty">
                {isAgentAuthoring
                  ? "Retry uses the same approved chats and model. Change chats starts a new review when the selection is no longer right for this Agent."
                  : "Retry keeps the exact approved evidence, model, and disclosure receipt. Change evidence starts a new review if the selection is too large or no longer representative."}
              </p>
            </div>
            <div className="training-dialog-actions">
              <button className="training-button secondary" type="button" disabled={busy} onClick={() => setStep("evidence")}>{isAgentAuthoring ? "Change chats" : "Change evidence"}</button>
              <button className="training-button" type="button" disabled={busy} onClick={() => void retryAuthoring()}>
                {analyzing ? <Loader2 className="spin" size={14} /> : null}
                Retry approved evidence
              </button>
            </div>
          </div>
        ) : (
          <div className="training-recommendation-loading">
            {creation?.state === "failed" ? <><h3>Analysis failed</h3><p>{creation.blockedReason}</p></> : <><Loader2 className="spin" size={18} /><p>{isAgentAuthoring ? "Preparing the Agent review…" : "Preparing the recommendation…"}</p></>}
          </div>
        )}
    </CreateImproveAuthoringShell>
  );
}
