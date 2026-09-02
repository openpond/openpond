import {
  ContinualBenchIssueReviewSchema,
  ContinualLearningDailyBatchManifestSchema,
  ContinualLearningDailyBatchSchema,
  ContinualLearningResponseTargetSchema,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import type { createModelComparisonEvaluationService } from "./model-comparison-evaluation-service.js";
import { readModelComparisonAttemptEvidence } from "./model-comparison-evidence-reader.js";

type Evaluations = ReturnType<typeof createModelComparisonEvaluationService>;
type ActionResult = { handled: false } | { handled: true; value: unknown };

export async function handleContinualLearningAction(input: {
  action: string;
  payload: Record<string, unknown>;
  store: SqliteStore;
  storeDir: string;
  evaluations: Evaluations;
}): Promise<ActionResult> {
  const { action, payload, store } = input;
  if (action === "model_comparison_attempt_evidence") {
    const kind = payload.kind === "trace" ? "trace" : payload.kind === "transcript" ? "transcript" : null;
    if (!kind) throw new Error("kind must be transcript or trace.");
    return handled(await readModelComparisonAttemptEvidence({
      store,
      storeDir: input.storeDir,
      runId: requiredString(payload.runId, "runId"),
      attemptId: requiredString(payload.attemptId, "attemptId"),
      kind,
    }));
  }
  if (action === "save_continual_bench_issue_review") {
    return handled(await store.saveContinualBenchIssueReview(ContinualBenchIssueReviewSchema.parse(payload.review)));
  }
  if (action === "import_continual_learning_daily_batch") {
    return handled(await importDailyBatch({ payload, store }));
  }
  if (action === "save_continual_learning_daily_batch") {
    return handled(await store.saveContinualLearningDailyBatch(ContinualLearningDailyBatchSchema.parse(payload.batch)));
  }
  if (action === "generate_continual_learning_responses") {
    return handled(await generateResponses({ payload, store, evaluations: input.evaluations }));
  }
  return { handled: false };
}

async function importDailyBatch(input: { payload: Record<string, unknown>; store: SqliteStore }) {
  const { payload, store } = input;
  const manifest = ContinualLearningDailyBatchManifestSchema.parse(payload.manifest);
  const series = await store.getModelComparisonSeries(manifest.seriesId);
  if (!series || series.status !== "active" || !series.scheduleSealedAt) {
    throw new Error("Daily task intake requires an active series with a sealed schedule.");
  }
  const scheduleEntry = series.schedule.find((entry) => entry.id === manifest.scheduleEntryId);
  if (!scheduleEntry || scheduleEntry.role !== "daily_residual") {
    throw new Error("A daily task batch must target a daily-residual schedule entry.");
  }
  if (scheduleEntry.ordinal !== manifest.dayOrdinal) {
    throw new Error("The daily batch ordinal must match its sealed schedule entry.");
  }
  if (JSON.stringify(manifest.sourceTaskset) !== JSON.stringify(series.eligibleTaskPool)) {
    throw new Error("The daily batch must reference the series' exact eligible task-pool release.");
  }
  const sourceTaskset = await store.getTasksetRevision(
    manifest.sourceTaskset.id,
    manifest.sourceTaskset.revision,
    manifest.sourceTaskset.contentHash,
  );
  if (!sourceTaskset) throw new Error("The daily batch source Taskset release was not found.");
  const tasksById = new Map(sourceTaskset.tasks.map((task) => [task.id, task]));
  const selectedTasks = manifest.taskIds.map((taskId) => {
    const task = tasksById.get(taskId);
    if (!task) throw new Error(`Daily task ${taskId} is not in the referenced eligible task pool.`);
    if (task.split !== "train") throw new Error(`Daily task ${taskId} is not in the train split.`);
    return task;
  });
  const existingBatches = await store.listContinualLearningDailyBatches({ seriesId: series.id });
  const existingIdentity = existingBatches.find((batch) => (
    batch.id === manifest.id
    || batch.dayOrdinal === manifest.dayOrdinal
    || batch.scheduleEntryId === manifest.scheduleEntryId
  ));
  if (existingIdentity) {
    if (existingIdentity.id === manifest.id) return existingIdentity;
    throw new Error("That series day or schedule entry already has a task batch.");
  }
  const previouslyImported = new Set(existingBatches.flatMap((batch) => batch.tasks.map((task) => task.taskId)));
  const repeated = manifest.taskIds.find((taskId) => previouslyImported.has(taskId));
  if (repeated) throw new Error(`Daily task ${repeated} was already imported for this series.`);
  const now = new Date().toISOString();
  const observedAttempts = new Map(manifest.observedAttempts.map((attempt) => [
    `${attempt.taskId}:${intakeTargetKey(attempt.target)}`,
    attempt,
  ]));
  const requestedPolicies = manifest.observedAttempts.flatMap((attempt) => (
    typeof attempt.target === "string" ? [] : [attempt.target]
  ));
  return store.saveContinualLearningDailyBatch(ContinualLearningDailyBatchSchema.parse({
    schemaVersion: "openpond.continualLearningDailyBatch.v1",
    id: manifest.id,
    seriesId: manifest.seriesId,
    scheduleEntryId: manifest.scheduleEntryId,
    dayOrdinal: manifest.dayOrdinal,
    label: manifest.availableAt.slice(0, 10),
    source: payload.source === "sealed_fixture" ? "sealed_fixture" : "json_upload",
    sourceFileName: manifest.sourceFileName,
    sourceTaskset: manifest.sourceTaskset,
    tasks: selectedTasks.map((task) => ({
      taskId: task.id,
      taskContentHash: contentHash(task),
      familyKey: task.clusterKey || task.id,
      disposition: null,
      oracleReview: "pending",
      note: "",
      observedAttempt: observedAttempts.get(`${task.id}:current`)?.attempt ?? null,
      baselineAttempt: observedAttempts.get(`${task.id}:base`)?.attempt ?? null,
      responses: manifest.observedAttempts.flatMap((attempt) => (
        attempt.taskId === task.id && typeof attempt.target !== "string"
          ? [{ target: attempt.target, attempt: attempt.attempt }]
          : []
      )),
      stagedAt: null,
      queuedEntry: null,
    })),
    intakeEvaluation: {
      status: manifest.observedAttempts.length ? "ready" : "awaiting",
      requestedTargets: [...new Set(manifest.observedAttempts.flatMap((attempt) => (
        typeof attempt.target === "string" ? [attempt.target] : []
      )))],
      requestedPolicies,
      runs: manifest.observedAttempts.flatMap((attempt) => {
        if (typeof attempt.target === "string" || attempt.attempt.source !== "evaluation_run") return [];
        return [{ target: attempt.target, runId: attempt.attempt.evaluationRunId }];
      }),
      baselineRunId: evaluationRunId(manifest.observedAttempts.find((attempt) => attempt.target === "base")?.attempt),
      currentRunId: evaluationRunId(manifest.observedAttempts.find((attempt) => attempt.target === "current")?.attempt),
      currentPolicy: null,
      failure: null,
    },
    status: "pending",
    queuedEntry: null,
    reviewedBy: null,
    reviewedAt: null,
    availableAt: manifest.availableAt,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }));
}

async function generateResponses(input: {
  payload: Record<string, unknown>;
  store: SqliteStore;
  evaluations: Evaluations;
}) {
  const seriesId = requiredString(input.payload.seriesId, "seriesId");
  const requestedIds = Array.isArray(input.payload.batchIds)
    ? new Set(input.payload.batchIds.map((value) => requiredString(value, "batchId")))
    : null;
  const targets = Array.isArray(input.payload.targets)
    ? [...new Map(input.payload.targets.map((value) => {
        const target = ContinualLearningResponseTargetSchema.parse(value);
        return [intakeTargetKey(target), target] as const;
      })).values()]
    : undefined;
  if (targets && !targets.length) throw new Error("Select at least one model for response generation.");
  const batches = (await input.store.listContinualLearningDailyBatches({ seriesId }))
    .filter((batch) => (!requestedIds || requestedIds.has(batch.id))
      && (batch.intakeEvaluation.status === "awaiting" || batch.intakeEvaluation.status === "failed"));
  const started = [];
  for (const batch of batches) {
    started.push(await input.evaluations.startIntake({ batchId: batch.id, targets }));
  }
  return started;
}

function handled(value: unknown): ActionResult { return { handled: true, value }; }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requiredString(value: unknown, name: string): string {
  const parsed = string(value);
  if (!parsed) throw new Error(`${name} is required.`);
  return parsed;
}
function evaluationRunId(value: unknown): string | null { return string(record(value).evaluationRunId); }
function intakeTargetKey(value: "base" | "current" | { kind: string; id: string }): string {
  return typeof value === "string" ? value : `${value.kind}:${value.id}`;
}
