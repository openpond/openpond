import { z } from "zod";

import { ContinualBenchIssuePacketSchema } from "./continual-support.js";
import { ModelComparisonEntryRefSchema } from "./model-comparisons.js";
import { ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema, VersionedReleaseRefSchema } from "./release-core.js";

export const ContinualLearningResponseTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("base_model"),
    id: ReleaseIdSchema,
    revision: z.string().trim().min(1).max(500),
    label: z.string().trim().min(1).max(300),
  }).strict(),
  z.object({
    kind: z.literal("model_version"),
    id: ReleaseIdSchema,
    label: z.string().trim().min(1).max(300),
  }).strict(),
  z.object({
    kind: z.literal("captured_model"),
    id: ReleaseIdSchema,
    label: z.string().trim().min(1).max(300),
  }).strict(),
]);

export const ContinualLearningCapturedAttemptSchema = z.union([
  z.object({
    source: z.literal("evaluation_run").default("evaluation_run"),
    evaluationRunId: ReleaseIdSchema,
    attemptId: ReleaseIdSchema,
    modelLabel: z.string().trim().min(1).max(300).nullable().default(null),
    modelVersionId: ReleaseIdSchema.nullable().default(null),
    reward: z.number().finite().nullable(),
    components: z.record(z.string(), z.number().finite()).default({}),
  }).strict(),
  z.object({
    source: z.literal("imported_response"),
    modelLabel: z.string().trim().min(1).max(300),
    modelVersionId: ReleaseIdSchema.nullable().default(null),
    response: z.unknown().refine((value) => value !== undefined, "An imported model response is required."),
    reward: z.number().finite().nullable().default(null),
    components: z.record(z.string(), z.number().finite()).default({}),
  }).strict(),
]);

const ContinualLearningObservedAttemptSchema = z.union([
  z.object({
    taskId: ReleaseIdSchema,
    target: ContinualLearningResponseTargetSchema,
    attempt: ContinualLearningCapturedAttemptSchema,
  }).strict(),
  z.object({
    taskId: ReleaseIdSchema,
    target: z.enum(["base", "current"]).default("current"),
    attempt: ContinualLearningCapturedAttemptSchema,
  }).strict(),
  z.object({
    taskId: ReleaseIdSchema,
    target: z.enum(["base", "current"]).default("current"),
    evaluationRunId: ReleaseIdSchema,
    attemptId: ReleaseIdSchema,
    reward: z.number().finite().nullable(),
    components: z.record(z.string(), z.number().finite()).default({}),
  }).strict().transform(({ taskId, target, ...attempt }) => ({
    taskId,
    target,
    attempt: { source: "evaluation_run" as const, modelLabel: null, modelVersionId: null, ...attempt },
  })),
]);

export const ContinualLearningDailyBatchManifestSchema = z.object({
  schemaVersion: z.literal("openpond.continualLearningDailyBatchManifest.v1"),
  id: ReleaseIdSchema,
  seriesId: ReleaseIdSchema,
  scheduleEntryId: ReleaseIdSchema,
  dayOrdinal: z.number().int().positive().max(10_000),
  sourceTaskset: VersionedReleaseRefSchema,
  taskIds: z.array(ReleaseIdSchema).min(1).max(1_000),
  observedAttempts: z.array(ContinualLearningObservedAttemptSchema).max(1_000).default([]),
  sourceFileName: z.string().trim().min(1).max(500).nullable().default(null),
  availableAt: ReleaseTimestampSchema,
}).strict().superRefine((batch, context) => {
  if (new Set(batch.taskIds).size !== batch.taskIds.length) {
    context.addIssue({ code: "custom", path: ["taskIds"], message: "A daily batch cannot repeat a task." });
  }
  if (new Set(batch.observedAttempts.map((attempt) => `${attempt.taskId}:${observedTargetKey(attempt.target)}`)).size !== batch.observedAttempts.length) {
    context.addIssue({ code: "custom", path: ["observedAttempts"], message: "An intake batch cannot repeat a task and Policy target pair." });
  }
  const taskIds = new Set(batch.taskIds);
  if (batch.observedAttempts.some((attempt) => !taskIds.has(attempt.taskId))) {
    context.addIssue({ code: "custom", path: ["observedAttempts"], message: "Observed attempts must belong to tasks in the daily batch." });
  }
});

export const ContinualLearningDailyBatchSchema = z.object({
  schemaVersion: z.literal("openpond.continualLearningDailyBatch.v1"),
  id: ReleaseIdSchema,
  seriesId: ReleaseIdSchema,
  scheduleEntryId: ReleaseIdSchema,
  dayOrdinal: z.number().int().positive().max(10_000),
  label: z.string().trim().min(1).max(100),
  runMode: z.enum(["automatic", "manual"]).optional(),
  source: z.enum(["json_upload", "sealed_fixture"]),
  sourceFileName: z.string().trim().min(1).max(500).nullable(),
  sourceTaskset: VersionedReleaseRefSchema,
  tasks: z.array(z.object({
    taskId: ReleaseIdSchema,
    taskContentHash: ReleaseHashSchema,
    familyKey: ReleaseIdSchema,
    disposition: z.enum(["include", "defer", "exclude"]).nullable(),
    oracleReview: z.enum(["pending", "confirmed", "needs_correction"]),
    note: z.string().trim().max(2_000),
    observedAttempt: ContinualLearningCapturedAttemptSchema.nullable(),
    baselineAttempt: ContinualLearningCapturedAttemptSchema.nullable().default(null),
    responses: z.array(z.object({
      target: ContinualLearningResponseTargetSchema,
      attempt: ContinualLearningCapturedAttemptSchema,
    }).strict()).max(100).default([]),
    stagedAt: ReleaseTimestampSchema.nullable().default(null),
    queuedEntry: ModelComparisonEntryRefSchema.nullable().default(null),
  }).strict()).min(1).max(1_000),
  intakeEvaluation: z.object({
    status: z.enum(["awaiting", "running", "ready", "failed"]),
    requestedTargets: z.array(z.enum(["base", "current"])).max(2).default(["base", "current"]),
    requestedPolicies: z.array(ContinualLearningResponseTargetSchema).max(100).default([]),
    runs: z.array(z.object({
      target: ContinualLearningResponseTargetSchema,
      runId: ReleaseIdSchema,
    }).strict()).max(100).default([]),
    baselineRunId: ReleaseIdSchema.nullable(),
    currentRunId: ReleaseIdSchema.nullable(),
    currentPolicy: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("base_model"), id: ReleaseIdSchema }).strict(),
      z.object({ kind: z.literal("model_version"), id: ReleaseIdSchema }).strict(),
    ]).nullable(),
    failure: z.string().trim().min(1).max(2_000).nullable(),
  }).strict().default({
    status: "awaiting",
    requestedTargets: ["base", "current"],
    requestedPolicies: [],
    runs: [],
    baselineRunId: null,
    currentRunId: null,
    currentPolicy: null,
    failure: null,
  }),
  status: z.enum(["pending", "reviewed", "queued"]),
  queuedEntry: ModelComparisonEntryRefSchema.nullable(),
  reviewedBy: ReleaseIdSchema.nullable(),
  reviewedAt: ReleaseTimestampSchema.nullable(),
  availableAt: ReleaseTimestampSchema,
  revision: z.number().int().positive(),
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict().superRefine((batch, context) => {
  if (new Set(batch.tasks.map((task) => task.taskId)).size !== batch.tasks.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "A daily batch cannot repeat a task." });
  }
  for (const [taskIndex, task] of batch.tasks.entries()) {
    const keys = task.responses.map((response) => responseTargetKey(response.target));
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", path: ["tasks", taskIndex, "responses"], message: "A task cannot repeat a model response target." });
    }
  }
  const complete = batch.tasks.every((task) => (
    task.disposition !== null
    && task.oracleReview !== "pending"
    && (task.oracleReview !== "needs_correction" || task.note.length > 0)
  ));
  if (batch.status !== "pending" && !complete) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Every task requires a decision and oracle review before the day completes." });
  }
  if ((batch.status === "queued") !== (batch.queuedEntry !== null)) {
    context.addIssue({ code: "custom", path: ["queuedEntry"], message: "Only a queued day carries an exact series-entry reference." });
  }
  if (batch.status === "pending" && (batch.reviewedAt !== null || batch.reviewedBy !== null)) {
    context.addIssue({ code: "custom", path: ["reviewedAt"], message: "A pending day cannot carry reviewer completion identity." });
  }
  if (batch.status !== "pending" && (batch.reviewedAt === null || batch.reviewedBy === null)) {
    context.addIssue({ code: "custom", path: ["reviewedAt"], message: "Reviewed identity is required after a day review completes." });
  }
});

export const ContinualBenchIssueReviewSchema = z.object({
  schemaVersion: z.literal("openpond.continualBenchIssueReview.v1"),
  id: ReleaseIdSchema,
  seriesId: ReleaseIdSchema,
  scheduleEntryId: ReleaseIdSchema,
  passLabel: ReleaseIdSchema,
  packet: ContinualBenchIssuePacketSchema,
  splitManifest: z.object({ id: ReleaseIdSchema, contentHash: ReleaseHashSchema }).strict(),
  decisions: z.array(z.object({
    taskId: ReleaseIdSchema,
    disposition: z.enum(["include", "defer", "exclude"]).nullable(),
    note: z.string().trim().max(2_000),
  }).strict()).min(2).max(10_000),
  status: z.enum(["pending", "reviewed", "queued"]),
  queuedEntry: ModelComparisonEntryRefSchema.nullable(),
  reviewedBy: ReleaseIdSchema.nullable(),
  reviewedAt: ReleaseTimestampSchema.nullable(),
  revision: z.number().int().positive(),
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict().superRefine((review, context) => {
  const caseIds = [...review.packet.cases.map((item) => item.taskId)].sort();
  const decisionIds = [...review.decisions.map((item) => item.taskId)].sort();
  if (JSON.stringify(caseIds) !== JSON.stringify(decisionIds)) context.addIssue({ code: "custom", path: ["decisions"], message: "Review decisions must cover the exact issue-packet cases." });
  const complete = review.decisions.every((item) => item.disposition !== null && item.note.length > 0);
  if (review.status !== "pending" && !complete) context.addIssue({ code: "custom", path: ["decisions"], message: "Every case requires a disposition and note before review completes." });
  if ((review.status === "queued") !== (review.queuedEntry !== null)) context.addIssue({ code: "custom", path: ["queuedEntry"], message: "Only a queued review carries an exact series-entry reference." });
}).readonly();

export type ContinualBenchIssueReview = z.infer<typeof ContinualBenchIssueReviewSchema>;
export type ContinualLearningDailyBatchManifest = z.infer<typeof ContinualLearningDailyBatchManifestSchema>;
export type ContinualLearningDailyBatch = z.infer<typeof ContinualLearningDailyBatchSchema>;
export type ContinualLearningResponseTarget = z.infer<typeof ContinualLearningResponseTargetSchema>;

function responseTargetKey(target: z.infer<typeof ContinualLearningResponseTargetSchema>): string {
  return `${target.kind}:${target.id}`;
}
function observedTargetKey(target: "base" | "current" | z.infer<typeof ContinualLearningResponseTargetSchema>): string {
  return typeof target === "string" ? target : responseTargetKey(target);
}
