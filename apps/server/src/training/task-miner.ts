import { randomUUID } from "node:crypto";
import {
  TaskCandidateSchema,
  TaskMinerConfigSchema,
  TaskMinerRunSchema,
  type TaskCandidate,
  type TaskCandidateEvidence,
  type TaskCandidateScorecard,
  type TaskMinerConfig,
  type TaskMinerRun,
  type TrainingSourceRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { now } from "../utils.js";
import { recommendTrainingTactic } from "./tactic-recommender.js";

export const DEFAULT_TASK_MINER_CONFIG: TaskMinerConfig = TaskMinerConfigSchema.parse({
  schemaVersion: "openpond.taskMinerConfig.v1",
  enabled: false,
  localOnly: true,
  observationWindowDays: 30,
  minimumRecurrence: 3,
  clustering: "hybrid_deterministic_first",
  consentRequired: true,
});

export function createTaskMinerService(deps: {
  store: SqliteStore;
  addSessionSource?: (input: { profileId: string; sessionId: string; consentScope: "full_session" }) => Promise<TrainingSourceRef>;
}) {
  const activeRuns = new Map<string, { controller: AbortController; execution: Promise<void> }>();
  let closing = false;
  const ready = reconcileInterruptedRuns();

  async function config(profileId: string): Promise<TaskMinerConfig> {
    await ready;
    return (await deps.store.getTaskMinerConfig(profileId)) ?? DEFAULT_TASK_MINER_CONFIG;
  }

  async function updateConfig(profileId: string, value: unknown): Promise<TaskMinerConfig> {
    await ready;
    return deps.store.saveTaskMinerConfig(profileId, TaskMinerConfigSchema.parse(value));
  }

  async function run(input: {
    profileId: string;
    sourceIds?: string[];
    config?: TaskMinerConfig;
    signal?: AbortSignal;
    onProgress?: (progress: TaskMinerRun["progress"]) => Promise<void> | void;
  }): Promise<TaskCandidate[]> {
    await ready;
    const activeConfig = TaskMinerConfigSchema.parse(input.config ?? await config(input.profileId));
    if (input.config) await deps.store.saveTaskMinerConfig(input.profileId, activeConfig);
    throwIfAborted(input.signal);
    await input.onProgress?.({ stage: "preparing", processedSources: 0, totalSources: 0, candidatesFound: 0, skippedSources: 0 });
    const allSources = await deps.store.listTrainingSources(input.profileId);
    const sourceFilter = input.sourceIds?.length ? new Set(input.sourceIds) : null;
    const cutoff = Date.now() - activeConfig.observationWindowDays * 24 * 60 * 60 * 1_000;
    const sources = allSources.filter((source) => (!sourceFilter || sourceFilter.has(source.id)) && Date.parse(source.occurredAt) >= cutoff && (!activeConfig.consentRequired || source.consent.status === "granted"));
    const groups = clusterSources(sources);
    const candidates: TaskCandidate[] = [];
    let processedSources = 0;
    await input.onProgress?.({ stage: "clustering", processedSources, totalSources: sources.length, candidatesFound: 0, skippedSources: 0 });
    for (const [signature, group] of groups) {
      throwIfAborted(input.signal);
      processedSources += group.length;
      if (group.length < activeConfig.minimumRecurrence) {
        await input.onProgress?.({ stage: "clustering", processedSources, totalSources: sources.length, candidatesFound: candidates.length, skippedSources: 0 });
        continue;
      }
      const evidence = group.map((source) => evidenceFromSource(source, signature));
      const scorecard = scoreCandidate(group, evidence);
      const crossSystem = crossSystemBaseline(group);
      const fingerprint = contentHash([input.profileId, signature]);
      const existing = await deps.store.findTaskCandidateByFingerprint(input.profileId, fingerprint);
      const timestamp = now();
      const candidate = TaskCandidateSchema.parse({
        schemaVersion: "openpond.taskCandidate.v1",
        id: existing?.id ?? `task_candidate_${randomUUID()}`,
        profileId: input.profileId,
        status: existing?.status === "dismissed" || existing?.status === "rejected" ? existing.status : "needs_review",
        fingerprint,
        title: titleForGroup(group),
        summary: `${group.length} consented conversations share the workflow signature “${signature}”.`,
        workflowSignature: signature,
        evidence,
        scorecard,
        recommendation: recommendTrainingTactic({ evidence, scorecard, changingFacts: group.some((source) => source.metadata.changingFacts === true), baselineReward: crossSystem?.reward }),
        mergedIntoId: existing?.mergedIntoId ?? null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        metadata: {
          sourceCount: group.length,
          clustering: activeConfig.clustering,
          ...(crossSystem ? {
            flagship: "cross-system-operations",
            toolContractHash: crossSystem.toolContractHash,
            baselineReward: crossSystem.reward,
            approvedSuccessfulTrajectoryIds: crossSystem.approvedSuccessfulTrajectoryIds,
          } : {}),
        },
      });
      await deps.store.upsertTaskCandidate(candidate);
      candidates.push(candidate);
      await input.onProgress?.({ stage: "persisting", processedSources, totalSources: sources.length, candidatesFound: candidates.length, skippedSources: 0 });
    }
    await input.onProgress?.({ stage: "complete", processedSources: sources.length, totalSources: sources.length, candidatesFound: candidates.length, skippedSources: 0 });
    return candidates;
  }

  async function startRun(input: { profileId: string; sourceIds?: string[]; sessionIds?: string[]; config?: TaskMinerConfig }): Promise<TaskMinerRun> {
    await ready;
    if (closing) throw new Error("The Task Miner service is closing.");
    const activeConfig = TaskMinerConfigSchema.parse(input.config ?? await config(input.profileId));
    if (input.config) await deps.store.saveTaskMinerConfig(input.profileId, activeConfig);
    const sessionIds = [...new Set(input.sessionIds ?? [])];
    const timestamp = now();
    const runRecord = TaskMinerRunSchema.parse({
      schemaVersion: "openpond.taskMinerRun.v1",
      id: `task_miner_run_${randomUUID()}`,
      profileId: input.profileId,
      status: "queued",
      config: activeConfig,
      sourceIds: input.sourceIds ?? [],
      sessionIds,
      progress: { stage: "queued", processedSources: 0, totalSources: sessionIds.length || input.sourceIds?.length || 0, candidatesFound: 0, skippedSources: 0 },
      candidateIds: [],
      cancelRequested: false,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
    });
    await deps.store.saveTaskMinerRun(runRecord);
    const controller = new AbortController();
    const execution = Promise.resolve()
      .then(() => executeRun(runRecord, controller))
      .finally(() => activeRuns.delete(runRecord.id));
    activeRuns.set(runRecord.id, { controller, execution });
    return runRecord;
  }

  async function executeRun(initial: TaskMinerRun, controller: AbortController): Promise<void> {
    const startedAt = now();
    let current = await deps.store.saveTaskMinerRun({ ...initial, status: "running", startedAt, updatedAt: startedAt });
    try {
      current = await ingestSessionSources(current, controller);
      const candidates = await run({
        profileId: current.profileId,
        sourceIds: current.sourceIds,
        config: current.config,
        signal: controller.signal,
        onProgress: async (progress) => {
          const persisted = await deps.store.getTaskMinerRun(current.id);
          if (persisted?.cancelRequested) controller.abort();
          throwIfAborted(controller.signal);
          if (!persisted) throw new Error("Task Miner run disappeared while it was executing.");
          current = await deps.store.saveTaskMinerRun({
            ...persisted,
            status: "running",
            progress: {
              ...progress,
              skippedSources: Math.max(progress.skippedSources, persisted.progress.skippedSources),
            },
            updatedAt: now(),
          });
        },
      });
      throwIfAborted(controller.signal);
      const completedAt = now();
      current = await deps.store.saveTaskMinerRun({ ...current, status: "succeeded", candidateIds: candidates.map((candidate) => candidate.id), progress: { ...current.progress, stage: "complete", candidatesFound: candidates.length }, completedAt, updatedAt: completedAt });
    } catch (error) {
      const completedAt = now();
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const persisted = await deps.store.getTaskMinerRun(initial.id) ?? current;
      current = await deps.store.saveTaskMinerRun({ ...persisted, status: cancelled ? "cancelled" : "failed", cancelRequested: cancelled || persisted.cancelRequested, error: cancelled ? null : error instanceof Error ? error.message : String(error), completedAt, updatedAt: completedAt });
    }
  }

  async function ingestSessionSources(current: TaskMinerRun, controller: AbortController): Promise<TaskMinerRun> {
    if (!current.sessionIds.length) return current;
    if (!deps.addSessionSource) throw new Error("Task Miner session ingestion is unavailable.");
    current = await deps.store.saveTaskMinerRun({
      ...current,
      progress: {
        stage: "ingesting",
        processedSources: 0,
        totalSources: current.sessionIds.length,
        candidatesFound: 0,
        skippedSources: 0,
      },
      updatedAt: now(),
    });
    const sourceIds = new Set(current.sourceIds);
    let processedSources = 0;
    let skippedSources = 0;
    for (let offset = 0; offset < current.sessionIds.length; offset += 16) {
      throwIfAborted(controller.signal);
      const persisted = await deps.store.getTaskMinerRun(current.id);
      if (!persisted) throw new Error("Task Miner run disappeared while it was ingesting sources.");
      if (persisted.cancelRequested) controller.abort();
      throwIfAborted(controller.signal);
      const batch = current.sessionIds.slice(offset, offset + 16);
      const records = await Promise.all(batch.map(async (sessionId) => {
        throwIfAborted(controller.signal);
        try {
          return { source: await deps.addSessionSource!({ profileId: current.profileId, sessionId, consentScope: "full_session" }), skipped: false };
        } catch (error) {
          if (isUnavailableSessionEvidence(error)) return { source: null, skipped: true };
          throw error;
        }
      }));
      for (const record of records) if (record.source) sourceIds.add(record.source.id);
      processedSources += batch.length;
      skippedSources += records.filter((record) => record.skipped).length;
      current = await deps.store.saveTaskMinerRun({
        ...persisted,
        status: "running",
        sourceIds: [...sourceIds],
        progress: {
          stage: "ingesting",
          processedSources,
          totalSources: current.sessionIds.length,
          candidatesFound: 0,
          skippedSources,
        },
        updatedAt: now(),
      });
    }
    return current;
  }

  async function cancelRun(id: string): Promise<TaskMinerRun> {
    await ready;
    const runRecord = await deps.store.getTaskMinerRun(id);
    if (!runRecord) throw new Error("Task Miner run not found.");
    if (["cancelled", "succeeded", "failed"].includes(runRecord.status)) return runRecord;
    const updated = await deps.store.saveTaskMinerRun({ ...runRecord, status: "cancelling", cancelRequested: true, updatedAt: now() });
    activeRuns.get(id)?.controller.abort();
    return updated;
  }

  async function reconcileInterruptedRuns(): Promise<void> {
    for (const runRecord of await deps.store.listTaskMinerRuns()) {
      if (!["queued", "running", "cancelling"].includes(runRecord.status)) continue;
      const completedAt = now();
      const cancelled = runRecord.status === "cancelling" || runRecord.cancelRequested;
      await deps.store.saveTaskMinerRun({
        ...runRecord,
        status: cancelled ? "cancelled" : "failed",
        cancelRequested: cancelled,
        error: cancelled ? null : "OpenPond restarted before this Task Miner scan completed. Start a new scan; ingested sources were preserved.",
        completedAt,
        updatedAt: completedAt,
      });
    }
  }

  async function close(): Promise<void> {
    closing = true;
    await ready;
    for (const active of activeRuns.values()) active.controller.abort();
    await Promise.allSettled([...activeRuns.values()].map((active) => active.execution));
  }

  async function patch(id: string, input: { status?: TaskCandidate["status"]; mergeIntoId?: string | null }): Promise<TaskCandidate> {
    const candidate = await deps.store.getTaskCandidate(id);
    if (!candidate) throw new Error("Task Candidate not found.");
    if (input.mergeIntoId) {
      const target = await deps.store.getTaskCandidate(input.mergeIntoId);
      if (!target || target.profileId !== candidate.profileId) throw new Error("Merge target was not found in this profile.");
    }
    return deps.store.upsertTaskCandidate(TaskCandidateSchema.parse({ ...candidate, status: input.mergeIntoId ? "retired" : input.status ?? candidate.status, mergedIntoId: input.mergeIntoId ?? candidate.mergedIntoId, updatedAt: now() }));
  }

  return { config, updateConfig, run, startRun, cancelRun, patch, close };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Task Miner scan was cancelled.");
  error.name = "AbortError";
  throw error;
}

function isUnavailableSessionEvidence(error: unknown): boolean {
  return error instanceof Error && ["No completed turns were selected.", "Session not found."].includes(error.message);
}

function clusterSources(sources: TrainingSourceRef[]): Map<string, TrainingSourceRef[]> {
  const groups = new Map<string, TrainingSourceRef[]>();
  for (const source of sources) {
    const signature = workflowSignature(source);
    const group = groups.get(signature) ?? [];
    group.push(source);
    groups.set(signature, group);
  }
  return groups;
}

function workflowSignature(source: TrainingSourceRef): string {
  const declared = typeof source.metadata.workflowSignature === "string" ? source.metadata.workflowSignature.trim() : "";
  if (declared) return declared.slice(0, 2_000);
  const stop = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "chat", "task"]);
  const tokens = source.title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((token) => token.length > 2 && !stop.has(token));
  return [...new Set(tokens)].sort().slice(0, 8).join(":") || "general_workflow";
}

function evidenceFromSource(source: TrainingSourceRef, signature: string): TaskCandidateEvidence {
  const crossSystem = metadataRecord(source.metadata.crossSystemOperations);
  const kind = source.metadata.acceptedCorrection === true
    ? "accepted_correction"
    : source.metadata.runtimeFeedback === true
      ? "runtime_feedback"
      : source.metadata.agentAction === true || crossSystem
        ? "agent_action_recurrence"
        : source.metadata.outcomeLinkedChange === true
          ? "outcome_linked_change"
          : source.metadata.frontierCost === true
            ? "frontier_cost"
            : "repeated_success";
  return { id: `task_evidence_${contentHash([source.id, kind]).slice(0, 20)}`, kind, sourceRefIds: [source.id], occurredAt: source.occurredAt, signature, summary: source.title, confidence: typeof source.metadata.confidence === "number" ? Math.max(0, Math.min(1, source.metadata.confidence)) : crossSystem ? 0.95 : 0.75, consented: source.consent.status === "granted", metadata: crossSystem ? { trajectoryId: crossSystem.trajectoryId, outcome: crossSystem.outcome, reward: crossSystem.reward, toolContractHash: crossSystem.toolContractHash } : {} };
}

function scoreCandidate(sources: TrainingSourceRef[], evidence: TaskCandidateEvidence[]): TaskCandidateScorecard {
  const recurrence = Math.min(1, sources.length / 10);
  const isCrossSystem = sources.some((source) => metadataRecord(source.metadata.crossSystemOperations));
  const verifiable = isCrossSystem ? 0.98 : sources.some((source) => source.metadata.verifiableOutcome === true) ? 0.9 : sources.some((source) => source.metadata.acceptedCorrection === true) ? 0.65 : 0.45;
  const privacyRisk = sources.some((source) => source.secretScanStatus === "blocked") ? 1 : sources.some((source) => source.piiScanStatus === "review") ? 0.5 : 0.1;
  const frontierCost = sources.some((source) => source.metadata.frontierCost === true) ? 0.9 : 0.4;
  const signalQuality = evidence.reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, evidence.length);
  const overall = Math.max(0, Math.min(1, recurrence * 0.2 + verifiable * 0.2 + signalQuality * 0.25 + frontierCost * 0.15 + (1 - privacyRisk) * 0.2));
  return { frequency: recurrence, businessValue: isCrossSystem ? 0.85 : 0.6, frontierCost, signalQuality, verifiability: verifiable, repeatability: recurrence, privacyRisk, overall };
}

function crossSystemBaseline(sources: TrainingSourceRef[]): {
  toolContractHash: string;
  reward: { count: number; mean: number; min: number; max: number; variance: number };
  approvedSuccessfulTrajectoryIds: string[];
} | null {
  const traces = sources.map((source) => metadataRecord(source.metadata.crossSystemOperations)).filter((value): value is Record<string, unknown> => Boolean(value));
  if (traces.length !== sources.length || traces.length < 3) return null;
  const hashes = new Set(traces.map((trace) => typeof trace.toolContractHash === "string" ? trace.toolContractHash : ""));
  if (hashes.size !== 1 || ![...hashes][0]) return null;
  const rewards = traces.map((trace) => typeof trace.reward === "number" ? trace.reward : null).filter((value): value is number => value !== null && Number.isFinite(value));
  if (rewards.length < 3) return null;
  const mean = rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length;
  const variance = rewards.reduce((sum, reward) => sum + (reward - mean) ** 2, 0) / rewards.length;
  return {
    toolContractHash: [...hashes][0]!,
    reward: { count: rewards.length, mean, min: Math.min(...rewards), max: Math.max(...rewards), variance },
    approvedSuccessfulTrajectoryIds: traces.flatMap((trace) => trace.outcome === "correct" && trace.approved === true && typeof trace.trajectoryId === "string" ? [trace.trajectoryId] : []),
  };
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function titleForGroup(sources: TrainingSourceRef[]): string {
  const first = sources[0]?.title ?? "Repeated workflow";
  return first.length <= 80 ? first : `${first.slice(0, 77)}…`;
}
