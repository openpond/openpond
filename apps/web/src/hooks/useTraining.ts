import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BaseModelPreference,
  ChatModelRef,
  CodexReasoningEffort,
  CreateImproveRun,
  TaskMinerRun,
  TaskCreationRequest,
  TaskCreationSnapshot,
  TaskMinerConfig,
  TrainingBundleManifest,
  TrainingPreparedStart,
  TrainingPreparationPlan,
  TrainingPlan,
  TrainingSourceRef,
  TrainingSourceEstimate,
  TrainingChatSearchResult,
  TrainingStateResponse,
  LocalModelChatConfiguration,
  ModelProject,
  ModelRunDraft,
  CrossSystemExpertBootstrapPreview,
  CrossSystemExpertBootstrapApproval,
  DatasetImportJob,
  DatasetImportMapping,
  DatasetRowPage,
  GradeResult,
  TaskAttemptArtifact,
  TaskAttemptResult,
  Taskset,
  TasksetDraft,
  TasksetOperationalState,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

export type PreferenceComparisonReview = {
  assignment: {
    id: string;
    assignment: {
      presentedCandidateOrder: string[];
    };
  };
  taskPrompt: unknown;
  candidates: Array<{
    label: string;
    attemptId: string;
    output: Record<string, unknown>;
    artifacts: Array<{ id: string; mediaType: string | null; sizeBytes: number }>;
  }>;
};

export type PreferenceCalibrationStatus = {
  release: {
    id: string;
    contentHash: string;
    calibration: { minimumSamples: number };
  } | null;
  assignmentCount: number;
  humanCompleted: number;
  canonicalModelCompleted: number;
  swappedModelCompleted: number;
  minimumSamples: number | null;
  readyToFinalize: boolean;
  latestReport: {
    id: string;
    passed: boolean;
    sampleCount: number;
    orderAgreement: number;
    tieAgreement: number;
    orderSwapAgreement: number;
  } | null;
};

export type PreferenceDatasetReleaseView = {
  id: string;
  contentHash: string;
  authority: "human" | "synthetic_fixture";
  qualificationEligibility: "smoke_only" | "human_heldout";
  groups: Array<{
    id: string;
    partition: "reward_train" | "reward_validation" | "reward_qualification";
    attemptRefs: Array<{ id: string; contentHash: string }>;
  }>;
  derivedPairs: Array<{ groupId: string; relation: "preferred" | "tie" }>;
  createdAt: string;
};

export function useTraining(input: { connection: ClientConnection | null; profileId: string }) {
  const { connection, profileId } = input;
  const [payload, setPayload] = useState<TrainingStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef<Promise<TrainingStateResponse | null> | null>(null);
  const activityRevisionRef = useRef<string | null>(null);

  const refresh = useCallback((): Promise<TrainingStateResponse | null> => {
    if (!connection) return Promise.resolve(null);
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    setLoading(true);
    const request = api.trainingState(connection, profileId)
      .then((next) => {
        activityRevisionRef.current = next.activityRevision ?? null;
        setPayload(next);
        setError(null);
        return next;
      })
      .catch((caught) => {
        setError(message(caught));
        return null;
      })
      .finally(() => {
        if (refreshInFlightRef.current !== request) return;
        refreshInFlightRef.current = null;
        setLoading(false);
      });
    refreshInFlightRef.current = request;
    return request;
  }, [connection, profileId]);

  const mutate = useCallback(async <T,>(key: string, path: string, body: unknown, method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST", options: { silent?: boolean } = {}): Promise<T | null> => {
    if (!connection) return null;
    if (!options.silent) setBusyAction(key);
    try {
      const result = await api.trainingRequest<T>(connection, path, body, method);
      await refresh();
      if (!options.silent) setError(null);
      return result;
    } catch (caught) {
      if (!options.silent) setError(message(caught));
      return null;
    } finally { if (!options.silent) setBusyAction(null); }
  }, [connection, refresh]);

  useEffect(() => {
    activityRevisionRef.current = null;
    if (!connection) { setPayload(null); return; }
    void refresh();
  }, [connection, profileId, refresh]);

  const hasActiveWork = payload
    ? [
        payload.jobs.some((job) => ["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status)),
        payload.creations.some((creation) => ["planning", "materializing", "validating"].includes(creation.state)),
        payload.minerRuns.some((run) => ["queued", "running", "cancelling"].includes(run.status)),
        payload.datasetImports.some((job) => ["inspecting", "materializing", "validating", "cancelling"].includes(job.status)),
      ].some(Boolean)
    : false;
  useEffect(() => {
    if (!connection) return undefined;
    let active = true;
    let timer: number | null = null;
    const initialDelay = hasActiveWork ? 500 : 30_000;
    const poll = async () => {
      let nextDelay = initialDelay;
      try {
        const activity = await api.trainingActivity(connection, profileId);
        nextDelay = activity.active ? 500 : 30_000;
        if (
          activityRevisionRef.current === null
          || activityRevisionRef.current !== activity.revision
        ) {
          await refresh();
        }
      } catch (caught) {
        setError(message(caught));
      }
      if (active) timer = window.setTimeout(() => void poll(), nextDelay);
    };
    timer = window.setTimeout(() => void poll(), initialDelay);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [connection, hasActiveWork, profileId, refresh]);

  const actions = useMemo(() => ({
    saveModelProject: (project: ModelProject) =>
      mutate<ModelProject>(
        "save-model-project",
        "/models",
        project,
        "PUT",
      ),
    saveModelRunDraft: (draft: ModelRunDraft) =>
      mutate<ModelRunDraft>(
        "save-model-run-draft",
        "/model-run-drafts",
        draft,
        "PUT",
      ),
    createTasksetDraft: (name = "") =>
      mutate<TasksetDraft>(
        "create-taskset-draft",
        "/taskset-drafts",
        { profileId, name },
      ),
    saveTasksetDraft: (draft: TasksetDraft) =>
      mutate<TasksetDraft>(
        "save-taskset-draft",
        `/taskset-drafts/${encodeURIComponent(draft.id)}`,
        draft,
        "PUT",
      ),
    tasksetDraftWorkspace: async (draftId: string) => {
      if (!connection) return null;
      try {
        return await api.trainingRequest<{
          draftId: string;
          workspacePath: string;
          packageHash: string;
        }>(
          connection,
          `/taskset-drafts/${encodeURIComponent(draftId)}/workspace`,
          {},
          "GET",
        );
      } catch (caught) {
        setError(message(caught));
        return null;
      }
    },
    publishTasksetDraft: (draftId: string) =>
      mutate<{ draft: TasksetDraft; taskset: Taskset }>(
        "publish-taskset-draft",
        `/taskset-drafts/${encodeURIComponent(draftId)}/publish`,
        {},
      ),
    deleteTasksetDraft: (draftId: string) =>
      mutate<{ deleted: boolean; draftId: string }>(
        "delete-taskset-draft",
        `/taskset-drafts/${encodeURIComponent(draftId)}`,
        {},
        "DELETE",
      ),
    deleteModelRunDraft: (draftId: string) =>
      mutate<{ deleted: boolean; draftId?: string }>(
        "delete-model-run-draft",
        `/model-run-drafts/${encodeURIComponent(draftId)}`,
        {},
        "DELETE",
      ),
    inspectHuggingFaceDataset: (url: string) =>
      mutate<DatasetImportJob>(
        "inspect-huggingface-dataset",
        "/dataset-imports/huggingface/inspect",
        { profileId, url },
      ),
    materializeDatasetImport: (
      importId: string,
      input: {
        name: string;
        objective: string;
        mapping: DatasetImportMapping;
        targetStorageRoot: string | null;
        licenseApproved: boolean;
      },
    ) =>
      mutate<DatasetImportJob>(
        "materialize-dataset-import",
        `/dataset-imports/${encodeURIComponent(importId)}/materialize`,
        input,
      ),
    cancelDatasetImport: (importId: string) =>
      mutate<DatasetImportJob>(
        "cancel-dataset-import",
        `/dataset-imports/${encodeURIComponent(importId)}/cancel`,
        {},
      ),
    datasetRows: (
      tasksetId: string,
      input: {
        split?: "train" | "validation" | "test" | "frozen_eval" | null;
        cursor?: string | null;
        limit?: number;
        columns?: string[];
      } = {},
    ) => {
      if (!connection) return Promise.resolve(null);
      const params = new URLSearchParams();
      if (input.split) params.set("split", input.split);
      if (input.cursor) params.set("cursor", input.cursor);
      params.set("limit", String(input.limit ?? 25));
      for (const column of input.columns ?? []) params.append("column", column);
      return api.trainingRequest<DatasetRowPage>(
        connection,
        `/tasksets/${encodeURIComponent(tasksetId)}/rows?${params}`,
        {},
        "GET",
      );
    },
    addSource: (sessionId: string, turnIds?: string[]) => mutate<TrainingSourceRef>("add-source", "/sources", { profileId, sessionId, turnIds }),
    addSources: (sessionIds: string[]) => mutate<TrainingSourceRef[]>("add-sources", "/sources/batch", { profileId, sessionIds }),
    estimateSources: (sessionIds: string[]) => connection
      ? api.trainingRequest<TrainingSourceEstimate[]>(connection, "/sources/estimate", { sessionIds })
      : Promise.resolve([]),
    searchChats: (query: string, candidates: Array<{ sessionId: string; title: string; updatedAt: string }>, offset = 0, limit = 20) => connection
      ? api.trainingRequest<TrainingChatSearchResult>(connection, "/sources/search", { query, candidates, offset, limit })
      : Promise.resolve({ schemaVersion: "openpond.trainingChatSearchResult.v1" as const, query, offset, limit, total: 0, hasMore: false, indexedChats: 0, totalChats: 0, indexing: false, entries: [] }),
    removeSource: (sourceId: string) => mutate("remove-source", `/sources/${encodeURIComponent(sourceId)}`, {}, "DELETE"),
    deleteTaskset: (tasksetId: string) => mutate<{ deleted: boolean; tasksetId: string }>("delete-model", `/tasksets/${encodeURIComponent(tasksetId)}`, {}, "DELETE"),
    runBenchmark: (
      tasksetId: string,
      phase: "baseline" | "candidate",
      model: ChatModelRef,
      reasoningEffort: CodexReasoningEffort | "none" | null,
    ) => mutate<{
      run: TrainingStateResponse["benchmarkRuns"][number];
      comparison: TrainingStateResponse["benchmarkComparisons"][number] | null;
    }>(
      `run-benchmark-${phase}`,
      `/tasksets/${encodeURIComponent(tasksetId)}/benchmark-runs`,
      {
        phase,
        model,
        reasoningEffort,
        seeds: [17],
        repetitions: 1,
      },
    ),
    startHarnessRefinerBenchmark: (
      modelId: string,
      model: ChatModelRef,
      reasoningEffort: CodexReasoningEffort | "none" | null,
    ) => mutate<TrainingStateResponse["modelRuns"][number]>(
      "run-harness-refiner-benchmark",
      `/models/${encodeURIComponent(modelId)}/harness-refiner-benchmark`,
      {
        profileId,
        model,
        reasoningEffort,
        maximumSpendUsd: 10,
      },
    ),
    acceptHarnessReview: (
      workspaceId: string,
      reviewRef: { id: string; contentHash: string },
      analysisModel: ChatModelRef | null = null,
      analysisReasoningEffort: CodexReasoningEffort | null = null,
    ) => mutate<TaskCreationSnapshot>("accept-harness-review", "/harness-reviews/accept", {
      profileId,
      workspaceId,
      reviewRef,
      analysisModel,
      analysisReasoningEffort,
    }),
    startCreation: (sourceIds: string[], options: { objective?: string; buildIntent?: TaskCreationRequest["buildIntent"]; buildSpecification?: TaskCreationRequest["buildSpecification"]; methodHint?: TaskCreationRequest["methodHint"]; preferredBaseModel?: BaseModelPreference | null; resourceIntent?: TaskCreationRequest["resourceIntent"]; mode?: "defaults" | "customize"; entryMode?: TaskCreationRequest["entryMode"]; surface?: TaskCreationRequest["surface"]; candidateId?: string | null; analysisModel?: ChatModelRef | null; analysisReasoningEffort?: CodexReasoningEffort | null; createImproveRunId?: string | null; targetIntent?: TaskCreationRequest["targetIntent"] } = {}) => mutate<TaskCreationSnapshot>("create-taskset", "/task-creations", { profileId, sourceIds, surface: options.surface ?? "training_page", mode: options.mode ?? "defaults", entryMode: options.entryMode ?? "manual", resourceIntent: options.resourceIntent ?? "workproduct", buildIntent: options.buildIntent ?? "demonstrations", buildSpecification: options.buildSpecification ?? null, objective: options.objective ?? null, methodHint: options.methodHint ?? null, preferredBaseModelId: options.preferredBaseModel?.modelId ?? null, preferredBaseModel: options.preferredBaseModel ?? null, candidateId: options.candidateId ?? null, analysisModel: options.analysisModel ?? null, analysisReasoningEffort: options.analysisReasoningEffort ?? null, createImproveRunId: options.createImproveRunId ?? null, targetIntent: options.targetIntent ?? { kind: "model", id: null, displayName: null, operation: "create" } }),
    createModelFromTaskset: (tasksetId: string, preferredBaseModel: BaseModelPreference) =>
      mutate<CreateImproveRun>("create-model", "/models/from-taskset", {
        profileId,
        tasksetId,
        preferredBaseModelId: preferredBaseModel.modelId,
        preferredBaseModel,
      }),
    scanBaseModels: async () => {
      if (!connection) return null;
      setBusyAction("scan-base-models");
      try {
        const next = await refresh();
        setError(null);
        return next;
      } catch (caught) {
        setError(message(caught));
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    approveDisclosure: (id: string, approved: boolean) => mutate<TaskCreationSnapshot>("approve-disclosure", `/task-creations/${encodeURIComponent(id)}/disclosure`, { approved }),
    retryCreation: (id: string) => mutate<TaskCreationSnapshot>("retry-creation", `/task-creations/${encodeURIComponent(id)}/retry`, {}),
    answerQuestions: (id: string, answers: Record<string, string>) => mutate("answer-questions", `/task-creations/${encodeURIComponent(id)}/questions`, { answers }),
    materialize: (id: string, approved: boolean) => mutate<TaskCreationSnapshot>("materialize", `/task-creations/${encodeURIComponent(id)}/materialize`, { approved }),
    chatCreation: (id: string, message: string) => mutate<TaskCreationSnapshot>("task-creator-chat", `/task-creations/${encodeURIComponent(id)}/chat`, { message }),
    renameCreation: (id: string, name: string) => mutate<TaskCreationSnapshot>("rename-creation", `/task-creations/${encodeURIComponent(id)}/name`, { name }, "PATCH"),
    cancelCreation: (id: string) => mutate<TaskCreationSnapshot>("cancel-creation", `/task-creations/${encodeURIComponent(id)}/cancel`, {}),
    runMiner: (sourceIds: string[] = [], sessionIds: string[] = [], config?: TaskMinerConfig) => mutate<TaskMinerRun>("run-miner", "/miner/run", { profileId, sourceIds, sessionIds, config }),
    cancelMinerRun: (runId: string) => mutate<TaskMinerRun>("cancel-miner-run", `/miner/runs/${encodeURIComponent(runId)}/cancel`, {}),
    configureMiner: (config: TaskMinerConfig) => mutate("configure-miner", "/miner/config", { profileId, config }, "PUT"),
    patchCandidate: (id: string, patch: Record<string, unknown>) => mutate("candidate", `/candidates/${encodeURIComponent(id)}`, patch, "PATCH"),
    createCandidate: (id: string, mode: "defaults" | "customize", analysisModel?: ChatModelRef | null, analysisReasoningEffort?: CodexReasoningEffort | null) => mutate<TaskCreationSnapshot>("create-candidate", `/candidates/${encodeURIComponent(id)}/create`, { mode, analysisModel: analysisModel ?? null, analysisReasoningEffort: analysisReasoningEffort ?? null }),
    auditGraders: (tasksetId: string) => mutate<{ passed: boolean; results: Array<{ id: string; label: string; expectedPassed?: boolean; expectedRewardEligible?: boolean; result: { passed: boolean; score: number | null; rewardEligible: boolean } }>; failures: Array<{ label: string; gradeId: string }> }>("audit-graders", "/audit-graders", { tasksetId }),
    executeTasksetAttempt: (
      tasksetId: string,
      taskId: string,
      model: ChatModelRef,
    ) => mutate<{
      attempt: TaskAttemptResult;
      grade: GradeResult;
      artifacts: TaskAttemptArtifact[];
    }>(
      "execute-taskset-attempt",
      `/tasksets/${encodeURIComponent(tasksetId)}/attempts`,
      {
        taskId,
        model,
        seed: 17,
        attempt: 0,
        sampling: {
          maxOutputTokens: 4_096,
          temperature: 0,
          topP: 1,
        },
      },
    ),
    materializeSyntheticPreferenceCollection: (input: {
      tasksetId: string;
      actorKey: string;
      comparisonReleaseId: string;
      preferenceDatasetId: string;
      preferenceDatasetRevision: number;
      collection: unknown;
    }) => mutate<{
      collection: { id: string; attempts: TaskAttemptResult[] };
      assignments: Array<{ assignment: { id: string }; partition: "reward_train" | "reward_validation" }>;
      dataset: PreferenceDatasetReleaseView;
    }>(
      "materialize-synthetic-preference-collection",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/synthetic-preference-collection`,
      input,
    ),
    tasksetOperationalState: (tasksetId: string) => {
      if (!connection) return Promise.resolve(null);
      return api.trainingRequest<TasksetOperationalState>(
        connection,
        `/tasksets/${encodeURIComponent(tasksetId)}/operations`,
        {},
        "GET",
      );
    },
    calibrateJudges: (tasksetId: string) => mutate<{ passed: boolean }>("calibrate-judges", "/calibrate-judges", { tasksetId }),
    nextPreferenceComparison: (tasksetId: string, reviewerKey: string) => mutate<PreferenceComparisonReview | null>(
      "next-preference-comparison",
      `/tasksets/${encodeURIComponent(tasksetId)}/preference-comparisons/next`,
      { reviewerKey },
    ),
    submitPreferenceComparison: (input: {
      tasksetId: string;
      assignmentId: string;
      reviewerKey: string;
      order: string[][];
      rejectAll: boolean;
      criterionScores?: Record<string, Record<string, number>>;
      startedAt: string;
    }) => mutate(
      "submit-preference-comparison",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-comparisons/${encodeURIComponent(input.assignmentId)}/submit`,
      input,
    ),
    submitSyntheticFixturePreference: (input: {
      tasksetId: string;
      assignmentId: string;
      actorKey: string;
      labelerRelease: { id: string; contentHash: string };
      fixtureRelease: { id: string; contentHash: string };
      ratings: Record<string, "love" | "like" | "reject">;
      startedAt: string;
    }) => mutate(
      "submit-synthetic-fixture-preference",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-comparisons/${encodeURIComponent(input.assignmentId)}/fixture-submit`,
      { ...input, id: crypto.randomUUID() },
    ),
    listPreferenceDatasets: (tasksetId: string) => {
      if (!connection) return Promise.resolve(null);
      return api.trainingRequest<PreferenceDatasetReleaseView[]>(
        connection,
        `/tasksets/${encodeURIComponent(tasksetId)}/preference-datasets`,
        {},
        "GET",
      );
    },
    materializePreferenceDataset: (input: {
      tasksetId: string;
      comparisonReleaseId: string;
      authority: "human" | "synthetic_fixture";
      groups: Array<{
        assignmentId: string;
        partition: "reward_train" | "reward_validation" | "reward_qualification";
      }>;
      actorKey: string;
    }) => mutate<PreferenceDatasetReleaseView>(
      "materialize-preference-dataset",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-datasets`,
      { ...input, id: `preference-dataset-${crypto.randomUUID()}`, revision: 1 },
    ),
    launchRewardModelRun: (input: {
      tasksetId: string;
      rewardModelId: string;
      preferenceDatasetReleaseId: string;
      recipe: unknown;
      managedBaseModel: unknown;
    }) => mutate<TrainingStateResponse["rewardModelRuns"][number]>(
      "launch-reward-model-run",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/reward-model-runs`,
      { ...input, id: `reward-model-run-${crypto.randomUUID()}` },
    ),
    markPreferenceComparisonUnreviewable: (input: {
      tasksetId: string;
      assignmentId: string;
      reviewerKey: string;
      reason: string;
    }) => mutate(
      "mark-preference-comparison-unreviewable",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-comparisons/${encodeURIComponent(input.assignmentId)}/unreviewable`,
      input,
    ),
    preferenceCalibrationStatus: (
      tasksetId: string,
      reviewerKey: string,
      comparisonReleaseId?: string | null,
    ) => {
      if (!connection) return Promise.resolve(null);
      const params = new URLSearchParams({ reviewerKey });
      if (comparisonReleaseId) params.set("comparisonReleaseId", comparisonReleaseId);
      return api.trainingRequest<PreferenceCalibrationStatus>(
        connection,
        `/tasksets/${encodeURIComponent(tasksetId)}/preference-comparisons/calibration/status?${params}`,
        {},
        "GET",
      );
    },
    startPreferenceCalibrationBatch: (input: {
      tasksetId: string;
      reviewerKey: string;
      rubric: string;
      minimumSamples: number;
      taskId?: string | null;
    }) => mutate<{
      release: { id: string; contentHash: string };
      job: { id: string; state: string };
      requestHash: string;
    }>(
      "start-preference-calibration-batch",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-comparisons/calibration/batches`,
      { ...input, id: crypto.randomUUID() },
    ),
    syncPreferenceCalibrationBatch: (input: {
      tasksetId: string;
      reviewerKey: string;
      jobId: string;
    }) => mutate<{
      job: { id: string; state: string; terminalReason?: string | null };
      batch: unknown | null;
      assignment?: { id: string };
    }>(
      "sync-preference-calibration-batch",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-comparisons/calibration/batches/${encodeURIComponent(input.jobId)}/sync`,
      input,
    ),
    reviewPreferenceComparisonWithModel: (input: {
      tasksetId: string;
      assignmentId: string;
      reviewerKey: string;
      model: ChatModelRef;
      rubric: string;
      reviewVariant?: "canonical" | "order_swap";
    }) => mutate(
      "review-preference-comparison-with-model",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-comparisons/${encodeURIComponent(input.assignmentId)}/model-review`,
      { ...input, id: crypto.randomUUID() },
    ),
    runNextPreferenceCalibrationReview: (input: {
      tasksetId: string;
      reviewerKey: string;
      comparisonReleaseId?: string | null;
      model: ChatModelRef;
      rubric: string;
    }) => mutate(
      "run-next-preference-calibration-review",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-comparisons/calibration/model-reviews/next`,
      { ...input, id: crypto.randomUUID() },
    ),
    savePreferenceCalibration: (input: {
      tasksetId: string;
      reviewerKey: string;
      comparisonReleaseId: string;
      model: ChatModelRef;
    }) => mutate(
      "save-preference-calibration",
      `/tasksets/${encodeURIComponent(input.tasksetId)}/preference-comparisons/calibration/report`,
      { ...input, id: crypto.randomUUID() },
    ),
    preferenceArtifactUrl: async (artifactId: string) => {
      if (!connection) return null;
      const response = await fetch(
        `${connection.serverUrl}/v1/training/artifacts/${encodeURIComponent(artifactId)}/download`,
        { headers: { Authorization: `Bearer ${connection.token}` } },
      );
      if (!response.ok) throw new Error(await response.text());
      return URL.createObjectURL(await response.blob());
    },
    readiness: (tasksetId: string) => mutate("readiness", "/readiness", { tasksetId }),
    previewExpertBootstrap: (tasksetId: string) => mutate<CrossSystemExpertBootstrapPreview>(
      "preview-expert-bootstrap",
      `/tasksets/${encodeURIComponent(tasksetId)}/expert-bootstrap/preview`,
      {},
    ),
    approveExpertBootstrap: (tasksetId: string, previewHash: string) => mutate<{
      approval: CrossSystemExpertBootstrapApproval;
      taskset: Taskset;
    }>(
      "approve-expert-bootstrap",
      `/tasksets/${encodeURIComponent(tasksetId)}/expert-bootstrap/approve`,
      { previewHash },
    ),
    createPlan: (body: Record<string, unknown>) => mutate<TrainingPlan>("create-plan", "/plans", { ...body, tasksetId: body.tasksetId }),
    buildBundle: (planId: string) => mutate<{ manifest: TrainingBundleManifest; directory: string; validation: { valid: boolean; issues: string[] } }>("build-bundle", "/bundles", { planId }),
    approveTraining: (planId: string, bundleId: string) => mutate<{ id: string }>("approve-training", "/approvals", { planId, bundleId }),
    launch: (planId: string, approvalId: string) => mutate("launch", "/launch", { planId, approvalId }),
    prepareTraining: (body: {
      modelId: string;
      tasksetId: string;
      destinationId: string;
      recipe: unknown;
      exportApproved: boolean;
      retentionDays: number | null;
      region: string | null;
    }) => mutate<TrainingPreparedStart>("prepare-training", "/prepare", body),
    prepareModelRun: (
      modelRunId: string,
      input: {
        maximumSpendUsd: number | null;
        retentionDays: number | null;
      },
    ) => mutate<TrainingPreparationPlan>(
      "prepare-model-run",
      `/model-runs/${encodeURIComponent(modelRunId)}/prepare`,
      input,
    ),
    startModelRun: (
      modelRunId: string,
      input: {
        maximumSpendUsd: number | null;
        retentionDays: number | null;
        exportApproved: boolean;
        manifest?: unknown;
      },
    ) => mutate<{
      manifest: { id: string; contentHash: string };
      job: { id: string };
    }>(
      "start-model-run",
      `/model-runs/${encodeURIComponent(modelRunId)}/start`,
      input,
    ),
    startPreparedTraining: (body: {
      planId: string;
      bundleId: string;
      maximumCostUsd: number | null;
    }) => mutate<{
      plan: TrainingPlan;
      bundle: TrainingBundleManifest;
      approval: { id: string };
      job: { id: string };
      createImproveRunId: string;
    }>("start-prepared-training", "/start/prepared", body),
    startTraining: (body: { modelId: string; tasksetId: string; destinationId: string; recipe: unknown; exportApproved: boolean; maximumCostUsd: number | null; retentionDays: number | null; region: string | null }) => mutate<{ plan: TrainingPlan; bundle: TrainingBundleManifest; approval: { id: string }; job: { id: string } }>("start-training", "/start", body),
    cancelJob: (jobId: string) => mutate("cancel-job", `/jobs/${encodeURIComponent(jobId)}/cancel`, {}),
    rejectModel: (modelId: string, reason: string) => mutate("reject-model", `/models/${encodeURIComponent(modelId)}/reject`, { reason }),
    bindModel: (
      modelId: string,
      role: "chat_manual" | "agent" | "extension" | "authoring_optimizer",
      roleTargetId: string,
    ) => mutate("bind-model", `/models/${encodeURIComponent(modelId)}/bind`, {
      profileId,
      role,
      roleTargetId,
      promotedBy: profileId,
    }),
    rollbackModelBinding: (bindingId: string) => mutate(
      "rollback-model-binding",
      `/bindings/${encodeURIComponent(bindingId)}/rollback`,
      { rolledBackBy: profileId },
    ),
    updateModelConfiguration: (modelId: string, configuration: LocalModelChatConfiguration) => mutate("update-model-configuration", `/models/${encodeURIComponent(modelId)}/configuration`, configuration, "PATCH", { silent: true }),
    setModelPinned: (modelId: string, pinned: boolean) => mutate(
      "pin-model-version",
      `/models/${encodeURIComponent(modelId)}/pin`,
      { pinned },
      "PATCH",
    ),
    downloadArtifact: async (artifactId: string) => {
      if (!connection) return false;
      setBusyAction("download-artifact");
      try {
        const response = await fetch(`${connection.serverUrl}/v1/training/artifacts/${encodeURIComponent(artifactId)}/download`, { headers: { Authorization: `Bearer ${connection.token}` } });
        if (!response.ok) throw new Error(await response.text());
        const disposition = response.headers.get("content-disposition") ?? "";
        const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "openpond-model-artifact";
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
        return true;
      } catch (caught) {
        setError(message(caught));
        return false;
      } finally { setBusyAction(null); }
    },
    downloadModelPackage: async (modelId: string) =>
      downloadAuthenticated(
        `/models/${encodeURIComponent(modelId)}/download`,
        `${modelId}.openpond-lora.tar`,
      ),
    downloadBundle: async (bundleId: string) => downloadAuthenticated(`/bundles/${encodeURIComponent(bundleId)}/download`, "openpond-model-improvement-bundle.json"),
  }), [connection, mutate, profileId, refresh]);

  async function downloadAuthenticated(path: string, fallbackName: string) {
    if (!connection) return false;
    setBusyAction("download-bundle");
    try {
      const response = await fetch(`${connection.serverUrl}/v1/training${path}`, { headers: { Authorization: `Bearer ${connection.token}` } });
      if (!response.ok) throw new Error(await response.text());
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
      return true;
    } catch (caught) { setError(message(caught)); return false; }
    finally { setBusyAction(null); }
  }

  return { connection, payload, loading, busyAction, error, refresh, actions };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
