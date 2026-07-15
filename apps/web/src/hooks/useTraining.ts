import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatModelRef,
  CodexReasoningEffort,
  CrossSystemFrontierBaselineRun,
  TaskMinerRun,
  TaskCreationRequest,
  TaskCreationSnapshot,
  TaskMinerConfig,
  TrainingBundleManifest,
  TrainingPlan,
  TrainingSourceRef,
  TrainingSourceEstimate,
  TrainingChatSearchResult,
  TrainingStateResponse,
  LocalModelChatConfiguration,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

export function useTraining(input: { connection: ClientConnection | null; profileId: string }) {
  const { connection, profileId } = input;
  const [payload, setPayload] = useState<TrainingStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef<Promise<TrainingStateResponse | null> | null>(null);

  const refresh = useCallback((): Promise<TrainingStateResponse | null> => {
    if (!connection) return Promise.resolve(null);
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    setLoading(true);
    const request = api.trainingState(connection, profileId)
      .then((next) => {
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
    if (!connection) { setPayload(null); return; }
    void refresh();
  }, [connection, profileId, refresh]);

  const hasActiveJob = payload?.jobs.some((job) => ["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status)) ?? false;
  const hasActiveMinerRun = payload?.minerRuns.some((run) => ["queued", "running", "cancelling"].includes(run.status)) ?? false;
  const hasActiveFrontierBaselineRun = payload?.frontierBaselineRuns.some((run) => ["queued", "running", "cancelling"].includes(run.status)) ?? false;
  useEffect(() => {
    if (!connection) return undefined;
    let active = true;
    let timer: number | null = null;
    const delay = hasActiveJob || hasActiveMinerRun || hasActiveFrontierBaselineRun ? 500 : 30_000;
    const poll = async () => {
      await refresh();
      if (active) timer = window.setTimeout(() => void poll(), delay);
    };
    timer = window.setTimeout(() => void poll(), delay);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [connection, hasActiveFrontierBaselineRun, hasActiveJob, hasActiveMinerRun, refresh]);

  const actions = useMemo(() => ({
    addSource: (sessionId: string, turnIds?: string[]) => mutate<TrainingSourceRef>("add-source", "/sources", { profileId, sessionId, turnIds }),
    addSources: (sessionIds: string[]) => mutate<TrainingSourceRef[]>("add-sources", "/sources/batch", { profileId, sessionIds }),
    estimateSources: (sessionIds: string[]) => connection
      ? api.trainingRequest<TrainingSourceEstimate[]>(connection, "/sources/estimate", { sessionIds })
      : Promise.resolve([]),
    searchChats: (query: string, candidates: Array<{ sessionId: string; title: string; updatedAt: string }>, offset = 0, limit = 20) => connection
      ? api.trainingRequest<TrainingChatSearchResult>(connection, "/sources/search", { query, candidates, offset, limit })
      : Promise.resolve({ schemaVersion: "openpond.trainingChatSearchResult.v1" as const, query, offset, limit, total: 0, hasMore: false, indexedChats: 0, totalChats: 0, indexing: false, entries: [] }),
    runCrossSystemFrontierBaseline: (localProjectId: string, model: ChatModelRef, reasoningEffort: CodexReasoningEffort | null) => mutate<CrossSystemFrontierBaselineRun>("cross-system-frontier-baseline", "/cross-system-operations/frontier-baseline", {
      profileId,
      localProjectId,
      model,
      reasoningEffort,
      worldSpecs: [
        { seed: 301, split: "train", difficulty: "easy" },
        { seed: 302, split: "validation", difficulty: "medium" },
        { seed: 303, split: "frozen_eval", difficulty: "hard" },
      ],
    }),
    cancelCrossSystemFrontierBaseline: (runId: string) => mutate<CrossSystemFrontierBaselineRun>("cancel-cross-system-frontier-baseline", `/cross-system-operations/frontier-baseline/runs/${encodeURIComponent(runId)}/cancel`, {}),
    removeSource: (sourceId: string) => mutate("remove-source", `/sources/${encodeURIComponent(sourceId)}`, {}, "DELETE"),
    deleteTaskset: (tasksetId: string) => mutate<{ deleted: boolean; tasksetId: string }>("delete-model", `/tasksets/${encodeURIComponent(tasksetId)}`, {}, "DELETE"),
    startCreation: (sourceIds: string[], options: { objective?: string; methodHint?: TaskCreationRequest["methodHint"]; mode?: "defaults" | "customize"; entryMode?: TaskCreationRequest["entryMode"]; surface?: TaskCreationRequest["surface"]; candidateId?: string | null; analysisModel?: ChatModelRef | null; analysisReasoningEffort?: CodexReasoningEffort | null } = {}) => mutate<TaskCreationSnapshot>("create-taskset", "/task-creations", { profileId, sourceIds, surface: options.surface ?? "training_page", mode: options.mode ?? "defaults", entryMode: options.entryMode ?? "manual", objective: options.objective ?? null, methodHint: options.methodHint ?? null, candidateId: options.candidateId ?? null, analysisModel: options.analysisModel ?? null, analysisReasoningEffort: options.analysisReasoningEffort ?? null }),
    approveDisclosure: (id: string, approved: boolean) => mutate<TaskCreationSnapshot>("approve-disclosure", `/task-creations/${encodeURIComponent(id)}/disclosure`, { approved }),
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
    baseline: (tasksetId: string, models: ChatModelRef[]) => mutate("baseline", "/baseline", { tasksetId, models, seeds: [0, 1, 2], attemptsPerTask: 3 }),
    auditGraders: (tasksetId: string) => mutate<{ passed: boolean; results: Array<{ id: string; label: string; expectedPassed?: boolean; expectedRewardEligible?: boolean; result: { passed: boolean; score: number | null; rewardEligible: boolean } }>; failures: Array<{ label: string; gradeId: string }> }>("audit-graders", "/audit-graders", { tasksetId }),
    calibrateJudges: (tasksetId: string) => mutate<{ passed: boolean }>("calibrate-judges", "/calibrate-judges", { tasksetId }),
    readiness: (tasksetId: string) => mutate("readiness", "/readiness", { tasksetId }),
    createPlan: (body: Record<string, unknown>) => mutate<TrainingPlan>("create-plan", "/plans", { ...body, tasksetId: body.tasksetId }),
    buildBundle: (planId: string) => mutate<{ manifest: TrainingBundleManifest; directory: string; validation: { valid: boolean; issues: string[] } }>("build-bundle", "/bundles", { planId }),
    approveTraining: (planId: string, bundleId: string) => mutate<{ id: string }>("approve-training", "/approvals", { planId, bundleId }),
    launch: (planId: string, approvalId: string) => mutate("launch", "/launch", { planId, approvalId }),
    startTraining: (body: { tasksetId: string; destinationId: string; recipe: unknown; exportApproved: boolean; maximumCostUsd: number | null }) => mutate<{ plan: TrainingPlan; bundle: TrainingBundleManifest; approval: { id: string }; job: { id: string } }>("start-training", "/start", body),
    cancelJob: (jobId: string) => mutate("cancel-job", `/jobs/${encodeURIComponent(jobId)}/cancel`, {}),
    importArtifact: (planId: string, bundleId: string, artifactDirectory: string) => mutate("import-artifact", "/import", { planId, bundleId, artifactDirectory }),
    rejectModel: (modelId: string, reason: string) => mutate("reject-model", `/models/${encodeURIComponent(modelId)}/reject`, { reason }),
    updateModelConfiguration: (modelId: string, configuration: LocalModelChatConfiguration) => mutate("update-model-configuration", `/models/${encodeURIComponent(modelId)}/configuration`, configuration, "PATCH", { silent: true }),
    downloadArtifact: async (artifactId: string) => {
      if (!connection) return false;
      setBusyAction("download-artifact");
      try {
        const response = await fetch(`${connection.serverUrl}/v1/training/artifacts/${encodeURIComponent(artifactId)}/download`, { headers: { Authorization: `Bearer ${connection.token}` } });
        if (!response.ok) throw new Error(await response.text());
        const disposition = response.headers.get("content-disposition") ?? "";
        const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "openpond-training-artifact";
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
    downloadBundle: async (bundleId: string) => downloadAuthenticated(`/bundles/${encodeURIComponent(bundleId)}/download`, "openpond-training-bundle.json"),
  }), [connection, mutate, profileId]);

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

  return { payload, loading, busyAction, error, refresh, actions };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
