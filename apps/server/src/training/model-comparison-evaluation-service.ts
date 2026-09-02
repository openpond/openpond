import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ModelComparisonBenchmarkReceiptSchema,
  ModelRunSchema,
  type ChatModelRef,
  type ContinualLearningDailyBatch,
  type ContinualLearningResponseTarget,
  type ModelComparisonEntryStatus,
  type ModelComparisonSeries,
  type ModelComparisonSeriesEntry,
  type ModelRun,
  type Taskset,
  type VersionedReleaseRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import { hostedApiAuthHeaders, resolveManagedAdapterUserAccess } from "../openpond/hosted-api-access.js";
import type { SqliteStore } from "../store/store.js";
import type { createModelComparisonSeriesService } from "./model-comparison-series-service.js";
import {
  declaredEnvironmentId,
  resolveManagedRlHarnessAdapter,
} from "./managed-rl-harness-registry.js";
import "./portable-jsonl-managed-rl-adapter.js";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-runner.js";
import { NativeToolCallAccumulator } from "../openpond/native-tool-calls.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";
import { readModelComparisonAttemptEvidence } from "./model-comparison-evidence-reader.js";
import { resolveBaseCheckpoint } from "./model-comparison-evaluation-scheduler.js";
import {
  createCodexTasksetPolicyRuntime,
  type CodexTasksetPolicyRuntime,
} from "./codex-taskset-policy-runtime.js";

type ComparisonSeriesService = ReturnType<typeof createModelComparisonSeriesService>;
type Access = { apiBaseUrl: string; token: string; teamId: string };
export type ModelComparisonCohortRole = "current" | "correction" | "sibling_verification" | "cumulative_known" | "development" | "retained" | "prior_disclosed" | "frozen_final";

type StartInput = {
  entryId: string;
  cohortRole: ModelComparisonCohortRole;
  panelId?: string;
  taskset?: VersionedReleaseRef;
  targetModelVersionId?: string;
  targetBaseCheckpointId?: string;
  idempotencyKey?: string;
  seeds?: number[];
  repetitions?: number;
  maximumSpendUsd?: number;
  maxGpuSeconds?: number;
};

type ReferenceStartInput = {
  seriesId: string;
  entryId?: string;
  cohortRole: ModelComparisonCohortRole;
  panelId?: string;
  taskset?: VersionedReleaseRef;
  targetKind: "base_model" | "external_reference";
  label: string;
  model: ChatModelRef;
  seeds?: number[];
  repetitions?: number;
  maximumSpendUsd?: number;
  idempotencyKey?: string;
};

type IntakeStartInput = {
  batchId: string;
  targets?: ContinualLearningResponseTarget[];
  maximumSpendUsd?: number;
  maxGpuSeconds?: number;
};

type SignedQuote = {
  quote: Record<string, unknown> & { hourlyUsd?: string; diskHourlyUsd?: string; quotedAt?: string };
  quoteSignature: string;
  imageVerified?: boolean;
};

type SoakStatus = {
  job: {
    id: string;
    state: string;
    version: number;
    accruedSpendUsd?: string;
    cleanupAttestation?: Record<string, unknown> | null;
  };
  source: { policyVersion: number; adapterSha256: string };
  serving: { state: string; policyVersion: number | null; adapterSha256: string | null };
  cleanup?: { resourceCount: number; activeResourceCount: 0 };
};

const TERMINAL_SOAK_STATES = new Set(["completed", "cancelled", "failed", "budget_exhausted"]);

export function createModelComparisonEvaluationService(deps: {
  store: SqliteStore;
  storeDir: string;
  comparisonSeries: ComparisonSeriesService;
  resolveAccess?: (teamId?: string) => Promise<Access>;
  modelStream?: TasksetWorkModelStream;
  fetch?: typeof fetch;
  projectCurrency?: (entryId: string) => Promise<unknown>;
  reconcileAutomatic?: () => Promise<unknown>;
}) {
  const fetchImpl = deps.fetch ?? fetch;
  const resolveAccess = deps.resolveAccess ?? ((teamId) => resolveManagedAdapterUserAccess({ teamId }));
  const active = new Map<string, { controller: AbortController; promise: Promise<ModelRun> }>();
  const starting = new Map<string, Promise<ModelRun>>();

  function start(input: StartInput): Promise<ModelRun> {
    if (!input.idempotencyKey) return startOnce(input);
    const key = contentHash({ entryId: input.entryId, panelId: input.panelId, taskset: input.taskset, targetModelVersionId: input.targetModelVersionId, targetBaseCheckpointId: input.targetBaseCheckpointId, idempotencyKey: input.idempotencyKey });
    const current = starting.get(key);
    if (current) return current;
    const pending = startOnce(input).finally(() => starting.delete(key));
    starting.set(key, pending);
    return pending;
  }

  async function startIntake(input: IntakeStartInput): Promise<ContinualLearningDailyBatch> {
    const batch = await deps.store.getContinualLearningDailyBatch(input.batchId);
    if (!batch) throw new Error("The requested Evals intake batch was not found.");
    if (batch.intakeEvaluation.status === "running" || batch.intakeEvaluation.status === "ready") return batch;
    const series = await requireSeries(deps.store, batch.seriesId);
    const protocol = series.benchmarkProtocol;
    if (!protocol) throw new Error("Generating responses requires a sealed benchmark protocol.");
    const protocolSchedule = protocol.schedule.find((entry) => entry.scheduleEntryId === batch.scheduleEntryId);
    if (!protocolSchedule) throw new Error("The intake batch is not authorized by the sealed schedule.");
    const correctionPanels = protocolSchedule.correctionPanelIds
      .map((panelId) => protocol.panels.find((panel) => panel.id === panelId))
      .filter((panel): panel is NonNullable<typeof panel> => Boolean(panel));
    if (correctionPanels.length !== 1) {
      throw new Error("An Evals intake batch must disclose exactly one correction panel.");
    }
    const panel = correctionPanels[0]!;
    if (panel.role !== "correction") throw new Error("The disclosed Evals panel must be a correction panel.");
    const taskset = await deps.store.getTasksetRevision(panel.taskset.id, panel.taskset.revision, panel.taskset.contentHash);
    if (!taskset) throw new Error("The disclosed Evals Taskset release is unavailable.");
    if (!sameIdSet(batch.tasks.map((task) => task.taskId), taskset.tasks.map((task) => task.id))) {
      throw new Error("The uploaded task batch must exactly match its disclosed correction panel.");
    }
    const targets = uniqueResponseTargets(input.targets?.length ? input.targets : [{
      kind: "base_model",
      id: series.baseModel.id,
      revision: series.baseModel.revision,
      label: series.baseModel.id,
    }]);
    const entries = await deps.store.listModelComparisonSeriesEntries({ seriesId: series.id });
    const needsBase = targets.some((target) => target.kind === "base_model");
    const baseCheckpointId = needsBase ? await resolveBaseCheckpoint(deps.store, series) : null;
    if (needsBase && !baseCheckpointId) throw new Error("The selected base-model checkpoint is not ready for response generation.");
    const common = {
      series,
      taskset,
      panel: { id: panel.id, role: panel.role, passLabel: panel.passLabel },
      maximumSpendUsd: input.maximumSpendUsd ?? 6,
      maxGpuSeconds: input.maxGpuSeconds ?? 7_200,
    };
    const runs: Array<{ target: ContinualLearningResponseTarget; runId: string }> = [];
    for (const target of targets) {
      if (target.kind === "captured_model") throw new Error("Captured external models can be imported, but cannot be generated by the managed model runtime.");
      if (target.kind === "base_model") {
        if (target.id !== series.baseModel.id || target.revision !== series.baseModel.revision) throw new Error("The selected base model does not match the sealed series base Policy.");
        const run = await startIntakeTarget({ ...common, batch, target, targetEntry: null, managedCheckpointId: baseCheckpointId, idempotencyKey: `evals-intake:${batch.id}:${responseTargetKey(target)}:revision:${batch.revision}` });
        runs.push({ target, runId: run.id });
        continue;
      }
      const version = await deps.store.getModelVersion(target.id);
      if (!version || version.modelId !== series.modelProjectId || !version.comparisonSeriesEntry) throw new Error(`Model Version ${target.id} is not a runnable version of this Model Project.`);
      const targetEntry = entries.find((entry) => entry.id === version.comparisonSeriesEntry!.entryId && entry.modelVersionId === version.id);
      if (!targetEntry) throw new Error(`Model Version ${target.id} has no immutable Comparison entry lineage.`);
      const run = await startIntakeTarget({ ...common, batch, target, targetEntry, managedCheckpointId: null, idempotencyKey: `evals-intake:${batch.id}:${responseTargetKey(target)}:revision:${batch.revision}` });
      runs.push({ target, runId: run.id });
    }
    const now = new Date().toISOString();
    return deps.store.saveContinualLearningDailyBatch({
      ...batch,
      intakeEvaluation: {
        status: "running",
        requestedTargets: [],
        requestedPolicies: targets,
        runs,
        baselineRunId: null,
        currentRunId: null,
        currentPolicy: null,
        failure: null,
      },
      revision: batch.revision + 1,
      updatedAt: now,
    });
  }

  async function startIntakeTarget(input: {
    batch: ContinualLearningDailyBatch;
    series: ModelComparisonSeries;
    taskset: Taskset;
    panel: { id: string; role: "correction"; passLabel: string | null };
    target: Exclude<ContinualLearningResponseTarget, { kind: "captured_model" }>;
    targetEntry: ModelComparisonSeriesEntry | null;
    managedCheckpointId: string | null;
    maximumSpendUsd: number;
    maxGpuSeconds: number;
    idempotencyKey: string;
  }): Promise<ModelRun> {
    const targetModelVersionId = input.target.kind === "model_version" ? input.target.id : null;
    if (input.targetEntry && !targetModelVersionId) throw new Error("The current Policy has no published Model Version.");
    const project = await deps.store.getModelProject(input.series.modelProjectId);
    if (!project?.hosted?.teamId) throw new Error("Generating Qwen responses requires a hosted Model Project workspace.");
    const id = `model_evaluation_${contentHash({ seriesId: input.series.id, batchId: input.batch.id, target: targetModelVersionId ?? `base:${input.series.baseModel.id}`, idempotencyKey: input.idempotencyKey }).slice(0, 24)}`;
    const existing = await deps.store.getModelRun(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const tasksetRef = input.panel
      ? input.series.benchmarkProtocol!.panels.find((panel) => panel.id === input.panel.id)!.taskset
      : input.batch.sourceTaskset;
    const run = await deps.store.saveModelRun(ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id,
      modelId: input.series.modelProjectId,
      modelVersionId: targetModelVersionId,
      profileId: input.series.profileId,
      kind: "evaluation",
      status: "prepared",
      method: null,
      destinationId: null,
      taskset: tasksetRef,
      comparisonSeriesEntry: input.targetEntry ? entryRef(input.targetEntry) : null,
      harnessRelease: project.trainingSetup.harnessRelease,
      quote: { maximumSpendUsd: input.maximumSpendUsd, hourlyCostUsd: null },
      evaluation: {
        benchmarkId: "model-comparison",
        target: targetModelVersionId
          ? { kind: "model_version", label: input.target.label, modelVersionId: targetModelVersionId, model: null }
          : { kind: "base_model", label: input.target.label, modelVersionId: null, model: null },
        grader: input.series.grader,
        judge: null,
        seeds: [1701],
        repetitions: 1,
        maximumSpendUsd: input.maximumSpendUsd,
        series: protocolConfiguration(input.series),
        panel: input.panel,
        comparisonPair: null,
        attemptPlan: [{ stage: "comparison", split: "correction", taskIds: input.taskset.tasks.map((task) => task.id), attemptCount: input.taskset.tasks.length }],
      },
      evaluationProgress: { stage: "comparison", completedAttempts: 0, totalAttempts: input.taskset.tasks.length, accounting: null, evidenceSnapshot: null },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    }));
    const controller = new AbortController();
    const execution = execute({
      run,
      targetEntry: input.targetEntry,
      managedCheckpointId: input.managedCheckpointId,
      comparisonEntry: null,
      series: input.series,
      taskset: input.taskset,
      cohortRole: "correction",
      panelId: input.panel.id,
      maximumSpendUsd: input.maximumSpendUsd,
      maxGpuSeconds: input.maxGpuSeconds,
      teamId: project.hosted.teamId,
      referenceModel: null,
      signal: controller.signal,
    });
    active.set(id, { controller, promise: execution });
    void execution.finally(() => active.delete(id));
    return run;
  }

  async function reconcileIntakeBatches(): Promise<void> {
    const batches = (await deps.store.listContinualLearningDailyBatches())
      .filter((batch) => batch.intakeEvaluation.status === "running");
    for (const batch of batches) {
      const declaredRuns = batch.intakeEvaluation.runs;
      if (!declaredRuns.length) continue;
      const requestedRuns = await Promise.all(declaredRuns.map(async (declared) => ({ declared, run: await deps.store.getModelRun(declared.runId) })));
      if (requestedRuns.some(({ run }) => !run)) continue;
      const failure = requestedRuns.find(({ run }) => run!.status === "failed" || run!.status === "cancelled");
      if (failure) {
        const now = new Date().toISOString();
        await deps.store.saveContinualLearningDailyBatch({
          ...batch,
          intakeEvaluation: { ...batch.intakeEvaluation, status: "failed", failure: failure.run!.failure ?? `Response generation ${failure.run!.status}.` },
          revision: batch.revision + 1,
          updatedAt: now,
        });
        continue;
      }
      if (requestedRuns.some(({ run }) => run!.status !== "succeeded")) continue;
      const attemptsByTarget = new Map<string, Awaited<ReturnType<typeof intakeAttempts>>>();
      for (const { declared, run } of requestedRuns) attemptsByTarget.set(responseTargetKey(declared.target), await intakeAttempts(run!));
      const now = new Date().toISOString();
      await deps.store.saveContinualLearningDailyBatch({
        ...batch,
        tasks: batch.tasks.map((task) => ({
          ...task,
          responses: mergeTaskResponses(task.responses, declaredRuns.flatMap((declared) => {
            const attempt = attemptsByTarget.get(responseTargetKey(declared.target))?.get(task.taskId);
            return attempt ? [{ target: declared.target, attempt }] : [];
          })),
        })),
        intakeEvaluation: { ...batch.intakeEvaluation, status: "ready", failure: null },
        revision: batch.revision + 1,
        updatedAt: now,
      });
    }
  }

  async function intakeAttempts(run: ModelRun): Promise<Map<string, {
    source: "evaluation_run";
    evaluationRunId: string;
    attemptId: string;
    modelLabel: string | null;
    modelVersionId: string | null;
    reward: number | null;
    components: Record<string, number>;
  }>> {
    const receipt = run.receipt?.schemaVersion === "openpond.modelComparisonBenchmarkReceipt.v1" ? run.receipt : null;
    const target = run.evaluation?.benchmarkId === "model-comparison" ? run.evaluation.target : null;
    const attempts = new Map<string, { source: "evaluation_run"; evaluationRunId: string; attemptId: string; modelLabel: string | null; modelVersionId: string | null; reward: number | null; components: Record<string, number> }>();
    for (const attempt of receipt?.attempts ?? []) {
      if (attempt.status !== "succeeded" || !attempt.attemptId || attempts.has(attempt.taskId)) continue;
      const trace = await readModelComparisonAttemptEvidence({ store: deps.store, storeDir: deps.storeDir, runId: run.id, attemptId: attempt.attemptId, kind: "trace" });
      const traceRecord = requiredRecord(trace.value, "intake evaluation trace");
      const rawComponents = requiredRecord(traceRecord.components, "intake reward components");
      const components = Object.fromEntries(Object.entries(rawComponents).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
      attempts.set(attempt.taskId, { source: "evaluation_run", evaluationRunId: run.id, attemptId: attempt.attemptId, modelLabel: target?.label ?? null, modelVersionId: run.modelVersionId, reward: attempt.deterministicScore, components });
    }
    return attempts;
  }

  async function startOnce(input: StartInput): Promise<ModelRun> {
    const entry = await requireEntry(deps.store, input.entryId);
    if (!entry.modelVersionId) throw new Error("Comparison evaluation requires a trained Model Version.");
    const series = await requireSeries(deps.store, entry.seriesId);
    if (input.targetBaseCheckpointId && input.targetModelVersionId) throw new Error("A comparison target must be either an exact Model Version or the sealed base Policy.");
    const targetModelVersionId = input.targetBaseCheckpointId ? null : input.targetModelVersionId ?? entry.modelVersionId;
    const targetVersion = targetModelVersionId ? await deps.store.getModelVersion(targetModelVersionId) : null;
    if (targetModelVersionId && (!targetVersion || targetVersion.modelId !== entry.modelProjectId)) throw new Error("The exact comparison target Model Version is unavailable.");
    const targetEntry = targetModelVersionId === entry.modelVersionId
      ? entry
      : targetVersion?.comparisonSeriesEntry
        ? await requireEntry(deps.store, targetVersion.comparisonSeriesEntry.entryId)
        : null;
    if (targetModelVersionId && !targetEntry) throw new Error("A managed comparison target requires immutable series-entry lineage.");
    if (input.targetBaseCheckpointId) {
      if (entry.parent.kind !== "base_model") throw new Error("Only a base-parent comparison may target a managed base checkpoint.");
      if (entry.parent.id !== series.baseModel.id || entry.parent.revision !== series.baseModel.revision) throw new Error("The managed base checkpoint does not match the sealed series base Policy.");
    }
    const resolvedPanel = resolveComparisonPanel(series, entry, input.cohortRole, input.panelId, input.taskset);
    const tasksetRef = resolvedPanel.taskset;
    const taskset = await deps.store.getTasksetRevision(tasksetRef.id, tasksetRef.revision, tasksetRef.contentHash)
      ?? await deps.store.getTaskset(tasksetRef.id);
    if (!taskset || taskset.revision !== tasksetRef.revision || taskset.contentHash !== tasksetRef.contentHash) {
      throw new Error("The exact Comparison evaluation Taskset is unavailable.");
    }
    const project = await deps.store.getModelProject(entry.modelProjectId);
    if (!project?.hosted?.teamId) throw new Error("Comparison evaluation requires a hosted Model Project workspace.");
    const seeds = [...new Set(input.seeds ?? series.benchmarkProtocol?.evaluation.seeds ?? [1701])];
    const repetitions = input.repetitions ?? series.benchmarkProtocol?.evaluation.repetitions ?? 1;
    assertSealedSampling(series, seeds, repetitions);
    const totalAttempts = taskset.tasks.length * seeds.length * repetitions;
    if (!totalAttempts) throw new Error("Comparison evaluation Taskset has no tasks.");
    const maximumSpendUsd = input.maximumSpendUsd ?? 6;
    const maxGpuSeconds = input.maxGpuSeconds ?? 7_200;
    const id = input.idempotencyKey
      ? `model_evaluation_${contentHash({ seriesId: series.id, entryId: entry.id, panelId: resolvedPanel.panel?.id, target: targetModelVersionId ?? `base:${series.baseModel.id}`, idempotencyKey: input.idempotencyKey }).slice(0, 24)}`
      : `model_evaluation_${randomUUID()}`;
    const existing = await deps.store.getModelRun(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const run = await deps.store.saveModelRun(ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id,
      modelId: entry.modelProjectId,
      modelVersionId: targetModelVersionId,
      profileId: entry.profileId,
      kind: "evaluation",
      status: "prepared",
      method: null,
      destinationId: null,
      taskset: tasksetRef,
      comparisonSeriesEntry: entryRef(entry),
      harnessRelease: project.trainingSetup.harnessRelease,
      quote: { maximumSpendUsd, hourlyCostUsd: null },
      evaluation: {
        benchmarkId: "model-comparison",
        target: targetModelVersionId
          ? { kind: "model_version", label: targetEntry!.label, modelVersionId: targetModelVersionId, model: null }
          : { kind: "base_model", label: series.baseModel.id, modelVersionId: null, model: null },
        grader: series.grader,
        judge: null,
        seeds,
        repetitions,
        maximumSpendUsd,
        series: protocolConfiguration(series),
        panel: resolvedPanel.panel,
        comparisonPair: { entryId: entry.id, parent: entry.parent, candidateModelVersionId: entry.modelVersionId },
        attemptPlan: [{ stage: "comparison", split: input.cohortRole, taskIds: taskset.tasks.map((task) => task.id), attemptCount: totalAttempts }],
      },
      evaluationProgress: { stage: "comparison", completedAttempts: 0, totalAttempts, accounting: null, evidenceSnapshot: null },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    }));
    const controller = new AbortController();
    const execution = execute({ run, targetEntry, managedCheckpointId: input.targetBaseCheckpointId ?? null, comparisonEntry: entry, series, taskset, cohortRole: input.cohortRole, panelId: resolvedPanel.panel?.id ?? null, maximumSpendUsd, maxGpuSeconds, teamId: project.hosted.teamId, referenceModel: null, signal: controller.signal });
    active.set(id, { controller, promise: execution });
    void execution.finally(() => active.delete(id));
    return run;
  }

  async function startReference(input: ReferenceStartInput): Promise<ModelRun> {
    if (input.model.providerId !== "codex" && !deps.modelStream) {
      throw new Error("External Comparison evaluation is not configured.");
    }
    const series = await requireSeries(deps.store, input.seriesId);
    const comparisonEntry = input.entryId ? await requireEntry(deps.store, input.entryId) : null;
    if (comparisonEntry && comparisonEntry.seriesId !== series.id) throw new Error("The reference Evaluation entry does not belong to the requested series.");
    const resolvedPanel = resolveComparisonPanel(series, comparisonEntry, input.cohortRole, input.panelId, input.taskset);
    const tasksetRef = resolvedPanel.taskset;
    const taskset = await deps.store.getTasksetRevision(tasksetRef.id, tasksetRef.revision, tasksetRef.contentHash)
      ?? await deps.store.getTaskset(tasksetRef.id);
    if (!taskset || taskset.revision !== tasksetRef.revision || taskset.contentHash !== tasksetRef.contentHash) throw new Error("The exact Comparison evaluation Taskset is unavailable.");
    const project = await deps.store.getModelProject(series.modelProjectId);
    if (!project) throw new Error("The Comparison Model Project is unavailable.");
    const seeds = [...new Set(input.seeds ?? series.benchmarkProtocol?.evaluation.seeds ?? [1701])];
    const repetitions = input.repetitions ?? series.benchmarkProtocol?.evaluation.repetitions ?? 1;
    assertSealedSampling(series, seeds, repetitions);
    const totalAttempts = taskset.tasks.length * seeds.length * repetitions;
    const maximumSpendUsd = input.maximumSpendUsd ?? 20;
    const id = input.idempotencyKey
      ? `model_evaluation_${contentHash({ seriesId: series.id, entryId: comparisonEntry?.id, panelId: resolvedPanel.panel?.id, targetKind: input.targetKind, label: input.label, idempotencyKey: input.idempotencyKey }).slice(0, 24)}`
      : `model_evaluation_${randomUUID()}`;
    const existing = await deps.store.getModelRun(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const run = await deps.store.saveModelRun(ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1", id, modelId: series.modelProjectId, modelVersionId: null,
      profileId: series.profileId, kind: "evaluation", status: "prepared", method: null, destinationId: null,
      taskset: tasksetRef, comparisonSeriesEntry: comparisonEntry ? entryRef(comparisonEntry) : null, harnessRelease: project.trainingSetup.harnessRelease,
      quote: { maximumSpendUsd, hourlyCostUsd: null },
      evaluation: { benchmarkId: "model-comparison", target: { kind: input.targetKind, label: input.label, modelVersionId: null, model: input.model }, grader: series.grader, judge: null, seeds, repetitions, maximumSpendUsd, series: protocolConfiguration(series), panel: resolvedPanel.panel, comparisonPair: comparisonEntry?.modelVersionId ? { entryId: comparisonEntry.id, parent: comparisonEntry.parent, candidateModelVersionId: comparisonEntry.modelVersionId } : null, attemptPlan: [{ stage: "comparison", split: input.cohortRole, taskIds: taskset.tasks.map((task) => task.id), attemptCount: totalAttempts }] },
      evaluationProgress: { stage: "comparison", completedAttempts: 0, totalAttempts, accounting: null, evidenceSnapshot: null },
      reward: null, receipt: null, adapterArtifactLineageId: null, failure: null, startedAt: now, completedAt: null, updatedAt: now,
    }));
    const controller = new AbortController();
    const execution = execute({ run, targetEntry: null, managedCheckpointId: null, comparisonEntry, series, taskset, cohortRole: input.cohortRole, panelId: resolvedPanel.panel?.id ?? null, maximumSpendUsd, maxGpuSeconds: 0, teamId: null, referenceModel: input.model, signal: controller.signal });
    active.set(id, { controller, promise: execution });
    void execution.finally(() => active.delete(id));
    return run;
  }

  async function execute(input: {
    run: ModelRun;
    targetEntry: ModelComparisonSeriesEntry | null;
    managedCheckpointId: string | null;
    comparisonEntry: ModelComparisonSeriesEntry | null;
    series: ModelComparisonSeries;
    taskset: Taskset;
    cohortRole: ModelComparisonCohortRole;
    panelId: string | null;
    maximumSpendUsd: number;
    maxGpuSeconds: number;
    teamId: string | null;
    referenceModel: ChatModelRef | null;
    signal: AbortSignal;
  }): Promise<ModelRun> {
    const evaluation = input.run.evaluation;
    if (!evaluation || evaluation.benchmarkId !== "model-comparison") {
      throw new Error("Comparison evaluation configuration is invalid.");
    }
    const runningAt = new Date().toISOString();
    await deps.store.saveModelRun(ModelRunSchema.parse({ ...input.run, status: "running", updatedAt: runningAt }));
    let soak: SoakStatus | null = null;
    let access: Access | null = null;
    const codexPolicy = input.referenceModel?.providerId === "codex"
      ? createCodexTasksetPolicyRuntime({
          modelId: input.referenceModel.modelId,
          runId: input.run.id,
          cwd: process.cwd(),
          reasoningEffort: "xhigh",
        })
      : null;
    try {
      if (input.targetEntry || input.managedCheckpointId) {
        access = await resolveAccess(input.teamId!);
        const checkpointId = input.managedCheckpointId ?? await checkpointForEntry(deps.store, input.targetEntry!);
        const quote = await stableQuote(access, fetchImpl);
        assertQuoteFitsCap(quote, input.maximumSpendUsd, input.maxGpuSeconds);
        soak = await createSoak({
          access,
          fetchImpl,
          checkpointId,
          target: input.managedCheckpointId ? "base_model" : "checkpoint",
          requestCount: Math.max(
            16,
            input.taskset.tasks.length * evaluation.seeds.length * evaluation.repetitions,
          ),
          maximumSpendUsd: input.maximumSpendUsd,
          maxGpuSeconds: input.maxGpuSeconds,
          runId: input.run.id,
          quote,
        });
        soak = await waitForSoak(access, fetchImpl, soak.job.id, input.maxGpuSeconds, input.signal);
      }
      const evidenceAttempts: Array<Record<string, unknown>> = [];
      const attempts: Array<{
        taskId: string;
        seed: number;
        repetition: number;
        status: "succeeded" | "failed";
        deterministicScore: number | null;
        passed: boolean | null;
        judgeScore: null;
        judgePreference: null;
        transcriptHash: string | null;
        traceHash: string | null;
        latencyMs: number | null;
        failureClass: "policy_failure" | "grader_failure" | "environment_failure" | "infrastructure_failure" | "timeout" | "cancelled" | null;
      }> = [];
      const policyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null as number | null };
      let policyUsageObserved = false;
      let completed = 0;
      for (const seed of evaluation.seeds) {
        for (let repetition = 0; repetition < evaluation.repetitions; repetition += 1) {
          for (const task of input.taskset.tasks) {
            input.signal.throwIfAborted();
            const deliveryId = contentHash({ runId: input.run.id, taskId: task.id, seed, repetition });
            const attemptStartedAt = Date.now();
            try {
              const capability = input.targetEntry || input.managedCheckpointId
                ? await requestJson<{ token: string; source: { policyVersion: number } }>(access!, fetchImpl, `/v1/managed-rl/serving-soaks/${encodeURIComponent(soak!.job.id)}/deliveries`, { method: "POST", body: JSON.stringify({ deliveryId }) })
                : { token: "external-reference", source: { policyVersion: 0 } };
              const adapter = resolveManagedRlHarnessAdapter({
                taskset: input.taskset,
                environmentId: declaredEnvironmentId(input.taskset),
              });
              const result = await adapter.execute({
                claim: {
                  schemaVersion: "openpond.managedRlLocalRolloutClaim.v1",
                  executionKind: "evaluation",
                  executionId: `${input.run.id}:${task.id}:${seed}:${repetition}`,
                  jobId: soak?.job.id ?? input.run.id,
                  groupId: null,
                  rolloutId: null,
                  deliveryId,
                  policyVersion: capability.source.policyVersion,
                  task: { id: task.id, expectedText: null },
                  taskset: input.run.taskset,
                  harnessRelease: input.run.harnessRelease ?? input.series.grader,
                  reward: { kind: "local_harness_receipt_v1", environmentId: input.taskset.environment.entrypoint },
                  environmentSha256: contentHash(input.taskset.environment),
                  request: { seed },
                  policy: { path: "/v1/managed-rl/policy/chat/completions", token: capability.token },
                },
                taskset: input.taskset,
                task,
                harnessRoot: process.cwd(),
                storeDir: deps.storeDir,
                executorId: `comparison-evaluator:${input.run.id}`,
                signal: AbortSignal.any([input.signal, AbortSignal.timeout(12 * 60_000)]),
                policyRequest: input.targetEntry || input.managedCheckpointId
                  ? (request, signal) => policyRequest(access!, fetchImpl, capability.token, request, signal)
                  : codexPolicy
                    ? (request, signal) => codexPolicyRequest(codexPolicy, request, signal)
                    : (request, signal) => externalPolicyRequest(deps.modelStream!, input.referenceModel!, input.run.id, request, signal),
              });
              const trace = requiredRecord(result.trace, "evaluation trace");
              const evidence = requiredRecord(result.evaluationEvidence, "evaluation evidence");
              const attemptUsage = optionalUsage(evidence.policyUsage);
              if (attemptUsage) {
                policyUsageObserved = true;
                policyUsage.inputTokens += attemptUsage.inputTokens;
                policyUsage.outputTokens += attemptUsage.outputTokens;
                policyUsage.totalTokens += attemptUsage.totalTokens;
              }
              const attemptCost = optionalNonnegative(evidence.policyCostUsd);
              if (attemptCost !== null) policyUsage.costUsd = (policyUsage.costUsd ?? 0) + attemptCost;
              const score = finite(trace.reward, "deterministic score");
              const components = requiredRecord(trace.components, "deterministic components");
              const passed = finite(components.terminalState, "terminal state") === 1;
              attempts.push({ taskId: task.id, seed, repetition, status: "succeeded", deterministicScore: score, passed, judgeScore: null, judgePreference: null, transcriptHash: contentHash(evidence.messages), traceHash: requiredHash(trace.traceSha256), latencyMs: Date.now() - attemptStartedAt, failureClass: null });
              evidenceAttempts.push({ taskId: task.id, seed, repetition, trace, evidence });
            } catch (error) {
              if (input.signal.aborted) throw input.signal.reason;
              attempts.push({ taskId: task.id, seed, repetition, status: "failed", deterministicScore: null, passed: null, judgeScore: null, judgePreference: null, transcriptHash: null, traceHash: null, latencyMs: Date.now() - attemptStartedAt, failureClass: classifyFailure(error) });
              evidenceAttempts.push({ taskId: task.id, seed, repetition, error: message(error) });
            }
            completed += 1;
            const current = await deps.store.getModelRun(input.run.id);
            if (current?.status === "running") {
              await deps.store.saveModelRun(ModelRunSchema.parse({ ...current, evaluationProgress: { ...current.evaluationProgress!, completedAttempts: completed }, updatedAt: new Date().toISOString() }));
            }
          }
        }
      }
      if (soak && access) {
        soak = await cancelAndCleanSoak(access, fetchImpl, soak);
      }
      const finishedAt = new Date().toISOString();
      const succeeded = attempts.filter((attempt) => attempt.status === "succeeded");
      const passed = succeeded.filter((attempt) => attempt.passed).length;
      const evidenceContent = { schemaVersion: "openpond.modelComparisonEvidenceSnapshot.v1", runId: input.run.id, target: evaluation.target, taskset: input.run.taskset, grader: input.series.grader, attempts: evidenceAttempts, completedAt: finishedAt };
      const evidenceHash = contentHash(evidenceContent);
      const evidenceId = `comparison_evidence_${evidenceHash.slice(0, 24)}`;
      const evidenceDirectory = path.join(deps.storeDir, "training", "comparison-evaluations");
      const evidencePath = path.join(evidenceDirectory, `${evidenceId}.json`);
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(evidenceContent, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const receiptAttempts = attempts.map((attempt, index) => ({
        ...attempt,
        attemptId: `comparison_attempt_${contentHash({ runId: input.run.id, taskId: attempt.taskId, seed: attempt.seed, repetition: attempt.repetition }).slice(0, 24)}`,
        transcriptArtifact: attempt.transcriptHash ? { artifactPath: evidencePath, jsonPointer: `/attempts/${index}/evidence/messages` } : null,
        traceArtifact: attempt.traceHash ? { artifactPath: evidencePath, jsonPointer: `/attempts/${index}/trace` } : null,
      }));
      const scores = succeeded.map((attempt) => attempt.deterministicScore!).filter(Number.isFinite);
      const passRate = succeeded.length ? passed / succeeded.length : null;
      const observedSpendUsd = soak ? optionalNonnegative(soak.job.accruedSpendUsd) : policyUsage.costUsd;
      const managedServing = soak?.job.cleanupAttestation && soak.cleanup
        ? {
            jobId: soak.job.id,
            terminalState: terminalSoakState(soak.job.state),
            sourcePolicyVersion: soak.source.policyVersion,
            sourceAdapterSha256: optionalHash(soak.source.adapterSha256),
            servedPolicyVersion: soak.serving.policyVersion,
            servedAdapterSha256: optionalHash(soak.serving.adapterSha256),
            accruedSpendUsd: requiredNonnegative(soak.job.accruedSpendUsd, "managed serving spend"),
            cleanupAttestationHash: contentHash(soak.job.cleanupAttestation),
            resourceCount: soak.cleanup.resourceCount,
            activeResourceCount: soak.cleanup.activeResourceCount,
          }
        : null;
      const receiptContent = {
        schemaVersion: "openpond.modelComparisonBenchmarkReceipt.v1" as const,
        benchmarkId: "model-comparison" as const,
        target: evaluation.target,
        taskset: input.run.taskset,
        grader: input.series.grader,
        sampling: { seeds: evaluation.seeds, repetitions: evaluation.repetitions },
        deterministic: {
          attemptedTaskCount: attempts.length,
          completedTaskCount: succeeded.length,
          passedTaskCount: passed,
          failedTaskCount: succeeded.length - passed,
          meanScore: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
          passRate,
          passRateCi95: passRate === null ? null : wilsonInterval(passed, succeeded.length),
        },
        judge: null,
        attempts: receiptAttempts,
        usage: { policy: policyUsageObserved ? policyUsage : null, judge: null, observedSpendUsd, evaluationGpuSeconds: input.targetEntry || input.managedCheckpointId ? Math.max(0, (Date.parse(finishedAt) - Date.parse(runningAt)) / 1_000) : null },
        managedServing,
        evidenceSnapshot: { id: evidenceId, contentHash: evidenceHash, artifactPath: evidencePath },
        completedAt: finishedAt,
      };
      const receipt = ModelComparisonBenchmarkReceiptSchema.parse({ ...receiptContent, contentHash: contentHash(receiptContent) });
      const current = await deps.store.getModelRun(input.run.id);
      const final = await deps.store.saveModelRun(ModelRunSchema.parse({ ...current!, status: "succeeded", receipt, evaluationProgress: { ...current!.evaluationProgress!, completedAttempts: attempts.length }, completedAt: finishedAt, updatedAt: finishedAt }));
      if (input.comparisonEntry && input.run.modelVersionId) await deps.comparisonSeries.linkRun({ entryId: input.comparisonEntry.id, expectedStatus: input.comparisonEntry.status as ModelComparisonEntryStatus, status: input.comparisonEntry.status as ModelComparisonEntryStatus, evaluations: [{ evaluationRunId: final.id, modelVersionId: input.run.modelVersionId, taskset: input.run.taskset, grader: input.series.grader, cohortRole: input.cohortRole, panelId: input.panelId, protocol: input.series.benchmarkProtocol ? { id: input.series.benchmarkProtocol.id, revision: input.series.benchmarkProtocol.revision, contentHash: input.series.benchmarkProtocol.contentHash } : null }] });
      if (input.comparisonEntry && deps.projectCurrency) await deps.projectCurrency(input.comparisonEntry.id).catch(() => undefined);
      return final;
    } catch (error) {
      const current = await deps.store.getModelRun(input.run.id) ?? input.run;
      const failedAt = new Date().toISOString();
      return deps.store.saveModelRun(ModelRunSchema.parse({ ...current, status: input.signal.aborted ? "cancelled" : "failed", failure: message(error).slice(0, 5_000), completedAt: failedAt, updatedAt: failedAt }));
    } finally {
      if (codexPolicy) await codexPolicy.close().catch(() => undefined);
      const cleanup = access && soak
        ? (() => {
            const settledAccess = access;
            const settledSoak = soak;
            return () => cancelAndCleanSoak(settledAccess, fetchImpl, settledSoak);
          })()
        : null;
      await settleComparisonEvaluationLifecycle({
        cleanup,
        reconcileAutomatic: deps.reconcileAutomatic ?? null,
      });
    }
  }

  async function reconcileInterrupted(): Promise<void> {
    const runs = (await deps.store.listModelRuns()).filter((run) => run.kind === "evaluation" && run.evaluation?.benchmarkId === "model-comparison" && (run.status === "prepared" || run.status === "running"));
    for (const run of runs) {
      const timestamp = new Date().toISOString();
      await deps.store.saveModelRun(ModelRunSchema.parse({ ...run, status: "failed", failure: "The local evaluation process restarted before it wrote a terminal receipt.", completedAt: timestamp, updatedAt: timestamp }));
    }
  }

  async function cancel(id: string): Promise<ModelRun> {
    const run = await deps.store.getModelRun(id);
    if (!run || run.kind !== "evaluation" || run.evaluation?.benchmarkId !== "model-comparison") {
      throw new Error("No Model Comparison evaluation exists for this Model Run.");
    }
    if (run.status !== "prepared" && run.status !== "running") return run;
    const execution = active.get(id);
    if (!execution) {
      throw new Error("The Model Comparison evaluation is not active in this process.");
    }
    execution.controller.abort(new Error("The Model Comparison evaluation was cancelled."));
    return execution.promise;
  }

  return { start, startReference, startIntake, reconcileIntakeBatches, cancel, reconcileInterrupted, activeRun: (id: string) => active.get(id)?.promise ?? null };
}

export async function settleComparisonEvaluationLifecycle(input: {
  cleanup: (() => Promise<unknown>) | null;
  reconcileAutomatic: (() => Promise<unknown>) | null;
}): Promise<void> {
  if (input.cleanup) await input.cleanup().catch(() => undefined);
  if (input.reconcileAutomatic) {
    await input.reconcileAutomatic().catch(() => undefined);
  }
}

async function requireEntry(store: SqliteStore, id: string) { const value = await store.getModelComparisonSeriesEntry(id); if (!value) throw new Error("Comparison entry was not found."); return value; }
async function requireSeries(store: SqliteStore, id: string) { const value = await store.getModelComparisonSeries(id); if (!value) throw new Error("Comparison Series was not found."); return value; }
function entryRef(entry: ModelComparisonSeriesEntry) { return { seriesId: entry.seriesId, entryId: entry.id, scheduleEntryId: entry.scheduleEntryId, releaseHash: entry.releaseHash, ordinal: entry.ordinal }; }
function protocolConfiguration(series: ModelComparisonSeries) {
  const protocol = series.benchmarkProtocol;
  return protocol ? { id: series.id, protocol: { id: protocol.id, revision: protocol.revision, contentHash: protocol.contentHash } } : null;
}
export function resolveComparisonPanel(
  series: ModelComparisonSeries,
  entry: ModelComparisonSeriesEntry | null,
  role: ModelComparisonCohortRole,
  panelId: string | undefined,
  explicitTaskset: VersionedReleaseRef | undefined,
): {
  taskset: VersionedReleaseRef;
  panel: { id: string; role: "correction" | "sibling_verification" | "cumulative_known" | "development" | "retained" | "frozen_final"; passLabel: string | null } | null;
} {
  const protocol = series.benchmarkProtocol;
  if (protocol && (panelId || explicitTaskset)) {
    const selected = protocol.panels.find((panel) => panelId ? panel.id === panelId : sameTasksetRef(panel.taskset, explicitTaskset!));
    if (!selected || selected.role === "training_eligible") throw new Error("The requested Evaluation panel is not part of the sealed benchmark protocol.");
    if (explicitTaskset && !sameTasksetRef(selected.taskset, explicitTaskset)) throw new Error("The requested Taskset does not match the sealed Evaluation panel.");
    if (role !== "prior_disclosed" && role !== "current" && role !== selected.role) throw new Error("The requested cohort role does not match the sealed Evaluation panel.");
    if (!entry && (selected.passLabel || selected.role === "frozen_final")) throw new Error("Issue-specific and frozen Evaluation panels require an exact Comparison entry context.");
    if (entry && selected.passLabel) {
      const panelOrdinal = series.schedule.find((scheduled) => scheduled.label === selected.passLabel)?.ordinal;
      if (panelOrdinal === undefined || panelOrdinal > entry.ordinal) throw new Error("An Evaluation cannot disclose a future benchmark panel.");
    }
    return { taskset: selected.taskset, panel: { id: selected.id, role: selected.role, passLabel: selected.passLabel } };
  }
  if (explicitTaskset) throw new Error("An explicit Evaluation Taskset requires a matching sealed protocol panel.");
  if (role === "current") {
    if (!entry) throw new Error("A reference evaluation requires an explicit sealed panel.");
    const selected = protocol?.panels.find((panel) => panel.role === "correction" && panel.passLabel === entry.label);
    return { taskset: selected?.taskset ?? entry.taskset, panel: selected ? { id: selected.id, role: "correction", passLabel: selected.passLabel } : null };
  }
  const stable = role === "development" ? series.evaluationTasksets.development : role === "retained" ? series.evaluationTasksets.retained : role === "frozen_final" ? series.evaluationTasksets.frozenFinal : null;
  if (stable) {
    const selected = protocol?.panels.find((panel) => sameTasksetRef(panel.taskset, stable));
    return { taskset: stable, panel: selected && selected.role !== "training_eligible" ? { id: selected.id, role: selected.role, passLabel: selected.passLabel } : null };
  }
  throw new Error("Prior-disclosed and issue-specific Evaluations require an explicit sealed panel.");
}
function sameTasksetRef(left: VersionedReleaseRef, right: VersionedReleaseRef): boolean {
  return left.id === right.id && left.revision === right.revision && left.contentHash === right.contentHash;
}
function sameIdSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
function responseTargetKey(target: ContinualLearningResponseTarget): string {
  return `${target.kind}:${target.id}`;
}
function uniqueResponseTargets(targets: ContinualLearningResponseTarget[]): ContinualLearningResponseTarget[] {
  return [...new Map(targets.map((target) => [responseTargetKey(target), target])).values()];
}
function mergeTaskResponses(
  existing: ContinualLearningDailyBatch["tasks"][number]["responses"],
  incoming: ContinualLearningDailyBatch["tasks"][number]["responses"],
): ContinualLearningDailyBatch["tasks"][number]["responses"] {
  return [...new Map([...existing, ...incoming].map((response) => [responseTargetKey(response.target), response])).values()];
}
function assertSealedSampling(series: ModelComparisonSeries, seeds: number[], repetitions: number): void {
  const sampling = series.benchmarkProtocol?.evaluation;
  if (!sampling) return;
  if (repetitions !== sampling.repetitions || JSON.stringify([...seeds].sort((a, b) => a - b)) !== JSON.stringify([...sampling.seeds].sort((a, b) => a - b))) {
    throw new Error("Benchmark Evaluation sampling must match the sealed protocol seeds and repetitions.");
  }
}

async function checkpointForEntry(store: SqliteStore, entry: ModelComparisonSeriesEntry): Promise<string> {
  const jobs = await store.listTrainingJobs();
  const job = jobs.find((candidate) => candidate.metadata.modelRunId === entry.modelRunId);
  if (!job) throw new Error("The candidate training Job was not found.");
  const checkpoint = (await store.listTrainingArtifacts(job.id)).find((artifact) => artifact.kind === "checkpoint");
  const id = optionalString(checkpoint?.metadata.managedRlOutputId);
  if (!id) throw new Error("The candidate checkpoint output identity is unavailable.");
  return id;
}

async function stableQuote(access: Access, fetchImpl: typeof fetch): Promise<SignedQuote> {
  const response = await requestJson<{ quotes: SignedQuote[] }>(access, fetchImpl, "/v1/managed-rl/quotes");
  const selected = response.quotes
    .filter((candidate) => candidate.imageVerified !== false && Number.isFinite(Number(candidate.quote.hourlyUsd)))
    .sort((a, b) =>
      (Number(a.quote.hourlyUsd) + Number(a.quote.diskHourlyUsd ?? 0))
      - (Number(b.quote.hourlyUsd) + Number(b.quote.diskHourlyUsd ?? 0))
    )[0];
  if (!selected) throw new Error("No supported GPU quote is currently available.");
  return selected;
}

function assertQuoteFitsCap(quote: SignedQuote, cap: number, seconds: number) { const hourly = Number(quote.quote.hourlyUsd) + Number(quote.quote.diskHourlyUsd ?? 0); if (hourly * (seconds / 3_600) + cap * 0.1 > cap) throw new Error("The selected GPU quote exceeds the caller-approved evaluation cap."); }

async function createSoak(input: { access: Access; fetchImpl: typeof fetch; checkpointId: string; target: "checkpoint" | "base_model"; requestCount: number; maximumSpendUsd: number; maxGpuSeconds: number; runId: string; quote: SignedQuote }): Promise<SoakStatus> {
  const response = await requestJson<{ job: { id: string; state: string; version: number } }>(input.access, input.fetchImpl, "/v1/managed-rl/serving-soaks", { method: "POST", body: JSON.stringify({ checkpointId: input.checkpointId, target: input.target, idempotencyKey: `comparison-evaluation-${contentHash({ runId: input.runId, checkpointId: input.checkpointId, target: input.target })}`, quote: input.quote.quote, quoteSignature: input.quote.quoteSignature, maximumSpendUsd: input.maximumSpendUsd, maxGpuSeconds: input.maxGpuSeconds, requests: Math.min(64, input.requestCount) }) });
  return { job: response.job, source: { policyVersion: 0, adapterSha256: "" }, serving: { state: "pending", policyVersion: null, adapterSha256: null } };
}

async function waitForSoak(access: Access, fetchImpl: typeof fetch, jobId: string, maxGpuSeconds: number, signal: AbortSignal): Promise<SoakStatus> {
  const deadline = Date.now() + maxGpuSeconds * 1_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const response = await requestJson<{ soak: SoakStatus }>(access, fetchImpl, `/v1/managed-rl/serving-soaks/${encodeURIComponent(jobId)}`, { signal });
    if (response.soak.job.state === "serving_soak_ready" && response.soak.serving.state === "ready") return response.soak;
    if (TERMINAL_SOAK_STATES.has(response.soak.job.state)) throw new Error(`Serving allocation terminated during initialization (${response.soak.job.state}).`);
    await delay(5_000, signal);
  }
  throw new Error("Serving allocation did not become ready before its caller-approved deadline.");
}

async function currentSoak(access: Access, fetchImpl: typeof fetch, jobId: string): Promise<SoakStatus> {
  return (await requestJson<{ soak: SoakStatus }>(access, fetchImpl, `/v1/managed-rl/serving-soaks/${encodeURIComponent(jobId)}`)).soak;
}

async function currentJobResources(access: Access, fetchImpl: typeof fetch, jobId: string): Promise<Array<{ state: string }>> {
  const response = await requestJson<{ job: { resources: Array<{ state: string }> } }>(access, fetchImpl, `/v1/managed-rl/jobs/${encodeURIComponent(jobId)}`);
  return response.job.resources;
}

async function cancelSoak(access: Access, fetchImpl: typeof fetch, soak: SoakStatus): Promise<void> { if (TERMINAL_SOAK_STATES.has(soak.job.state)) return; await requestJson(access, fetchImpl, `/v1/managed-rl/jobs/${encodeURIComponent(soak.job.id)}/cancel`, { method: "POST", body: JSON.stringify({ expectedVersion: soak.job.version }) }); }

async function cancelAndCleanSoak(access: Access, fetchImpl: typeof fetch, soak: SoakStatus): Promise<SoakStatus> {
  let current = await currentSoak(access, fetchImpl, soak.job.id);
  if (!TERMINAL_SOAK_STATES.has(current.job.state)) {
    await cancelSoak(access, fetchImpl, current);
  }
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const [next, resources] = await Promise.all([
      currentSoak(access, fetchImpl, soak.job.id),
      currentJobResources(access, fetchImpl, soak.job.id),
    ]);
    current = next;
    const activeResourceCount = resources.filter((resource) => resource.state === "active").length;
    if (TERMINAL_SOAK_STATES.has(current.job.state) && current.job.cleanupAttestation && activeResourceCount === 0) {
      return { ...current, cleanup: { resourceCount: resources.length, activeResourceCount: 0 } };
    }
    await delay(1_000);
  }
  throw new Error("Managed serving allocation cleanup did not become receipt-complete.");
}

async function policyRequest(access: Access, fetchImpl: typeof fetch, token: string, request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> { const response = await fetchImpl(`${access.apiBaseUrl}/v1/managed-rl/policy/chat/completions`, { method: "POST", headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(request), signal }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`Managed Policy request failed (${response.status}).`); return requiredRecord(payload, "Managed Policy response"); }

async function externalPolicyRequest(stream: TasksetWorkModelStream, model: ChatModelRef, runId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const messages = Array.isArray(request.messages) ? request.messages as Parameters<TasksetWorkModelStream>[0]["messages"] : [];
  const tools = Array.isArray(request.tools) ? request.tools as Parameters<TasksetWorkModelStream>[0]["tools"] : [];
  const accumulator = new NativeToolCallAccumulator();
  let text = "";
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let usageObserved = false;
  let costUsd = 0;
  let costObserved = false;
  const requestId = `${runId}:${String(request.deliveryId ?? "delivery")}:${String(request.turnIndex ?? 0)}`;
  for await (const delta of stream({ model, reasoningEffort: null, messages, tools, toolChoice: "auto", requestId, signal, maxOutputTokens: optionalPositive(request.maxTokens) ?? 1_024, temperature: optionalFinite(request.temperature) ?? 0.8, topP: 1, seed: optionalInteger(request.seed) ?? 0 })) {
    if (delta.text) text += delta.text;
    if (delta.toolCalls?.length) accumulator.append(delta.toolCalls);
    if (delta.usage !== undefined) {
      const normalized = normalizeModelUsageTokens(delta.usage);
      if (normalized.promptTokens !== null || normalized.completionTokens !== null || normalized.totalTokens !== null) {
        usageObserved = true;
        usage.promptTokens += normalized.promptTokens ?? 0;
        usage.completionTokens += normalized.completionTokens ?? 0;
        usage.totalTokens += normalized.totalTokens ?? (normalized.promptTokens ?? 0) + (normalized.completionTokens ?? 0);
      }
    }
    if (typeof delta.costUsd === "number" && Number.isFinite(delta.costUsd) && delta.costUsd >= 0) { costObserved = true; costUsd += delta.costUsd; }
  }
  const toolCalls = accumulator.completed().map((call) => call.hostedToolCall);
  return { response: { choices: [{ message: { content: text || null, tool_calls: toolCalls } }] }, trainingSample: { modelRequestId: requestId }, usage: usageObserved ? usage : undefined, costUsd: costObserved ? costUsd : undefined };
}

async function codexPolicyRequest(
  runtime: CodexTasksetPolicyRuntime,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return runtime.complete(request, signal);
}

async function requestJson<T>(access: Access, fetchImpl: typeof fetch, pathname: string, init: RequestInit = {}): Promise<T> { const headers = hostedApiAuthHeaders(access.token); headers.set("accept", "application/json"); headers.set("x-openpond-team-id", access.teamId); if (init.body) headers.set("content-type", "application/json"); const response = await fetchImpl(`${access.apiBaseUrl}${pathname}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(180_000) }); const payload = await response.json().catch(() => ({})); if (!response.ok) { const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {}; throw new Error(typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : `Managed RL request failed (${response.status}).`); } return payload as T; }

function wilsonInterval(successes: number, total: number) { const z = 1.959963984540054; const p = successes / total; const denominator = 1 + z * z / total; const center = (p + z * z / (2 * total)) / denominator; const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator; return { level: 0.95 as const, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) }; }
function classifyFailure(error: unknown): "policy_failure" | "grader_failure" | "environment_failure" | "infrastructure_failure" | "timeout" | "cancelled" { const value = message(error).toLowerCase(); if (value.includes("cancel") || value.includes("abort")) return "cancelled"; if (value.includes("policy")) return "policy_failure"; if (value.includes("timeout") || value.includes("timed out")) return "timeout"; if (value.includes("grader") || value.includes("reward")) return "grader_failure"; if (value.includes("environment") || value.includes("tool") || value.includes("bridge")) return "environment_failure"; return "infrastructure_failure"; }
function requiredRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is unavailable.`); return value as Record<string, unknown>; }
function requiredHash(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Evaluation trace hash is invalid."); return value; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid.`); return value; }
function optionalString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function optionalNonnegative(value: unknown): number | null { const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN; return Number.isFinite(parsed) && parsed >= 0 ? parsed : null; }
function requiredNonnegative(value: unknown, label: string): number { const parsed = optionalNonnegative(value); if (parsed === null) throw new Error(`${label} is unavailable.`); return parsed; }
function optionalHash(value: unknown): string | null { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; }
function terminalSoakState(value: string): "completed" | "cancelled" | "failed" | "budget_exhausted" { if (value === "completed" || value === "cancelled" || value === "failed" || value === "budget_exhausted") return value; throw new Error("Managed serving allocation is not terminal."); }
function optionalUsage(value: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null; const usage = value as Record<string, unknown>; const inputTokens = optionalNonnegative(usage.inputTokens); const outputTokens = optionalNonnegative(usage.outputTokens); const totalTokens = optionalNonnegative(usage.totalTokens); return inputTokens === null || outputTokens === null || totalTokens === null ? null : { inputTokens, outputTokens, totalTokens }; }
function optionalPositive(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null; }
function optionalInteger(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) ? value : null; }
function optionalFinite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
