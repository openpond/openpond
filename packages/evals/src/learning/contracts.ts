import { LearningDomainError } from "./errors.js";
import { z } from "zod";
import { ImmutableAssetRefSchema, ImmutableReleaseRefSchema, ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema, contentHash } from "@openpond/harness";

import { RewardBindingSchema, RewardCompositionSchema, RewardReleaseRefSchema, RewardReleaseSchema } from "../rewards.js";
import { TaskSplitSchema, TasksetReleaseContentSchema } from "../tasksets.js";
import { assertBoundedTaskJson, validateTaskSchema } from "../task-schema.js";

export const LearningJsonObjectSchema = z.record(z.string(), z.json());
export const LearningRevisionRefSchema = RewardReleaseRefSchema;
export const LearningJsonPointerSchema = z.string().max(2_000).refine((value) => value === "" || (value.startsWith("/") && !/~(?![01])/u.test(value)), "Use an RFC 6901 JSON pointer.");

export const TaskDefinitionContentSchema = z.object({
  schemaVersion: z.literal("openpond.taskDefinition.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(500),
  description: z.string().max(10_000),
  instructions: z.string().trim().min(1).max(20_000),
  category: z.enum(["structured", "question_answering", "coding", "tool_workflow", "custom"]),
  familyNamespace: ReleaseIdSchema,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  rewardBinding: LearningRevisionRefSchema,
  harness: ImmutableReleaseRefSchema.nullable(),
  execution: TasksetReleaseContentSchema.pick({ policy: true, environment: true, environmentRelease: true, tools: true, capabilities: true, verifierSetRelease: true }).strict(),
}).strict().superRefine((definition, context) => {
  for (const field of ["inputSchema", "outputSchema"] as const) {
    const schema = definition[field];
    if (schema.type !== "object") context.addIssue({ code: "custom", path: [field], message: "Task input/output use object envelopes; declare type: object." });
    const report = validateTaskSchema(schema);
    if (!report.valid) context.addIssue({ code: "custom", path: [field], message: report.issues[0]!.message });
  }
  if (Boolean(definition.execution.environmentRelease) !== Boolean(definition.execution.verifierSetRelease)) context.addIssue({ code: "custom", path: ["execution"], message: "Bind both the environment and verifier-set releases." });
});
export const TaskDefinitionSchema = TaskDefinitionContentSchema.safeExtend({ contentHash: ReleaseHashSchema }).strict();

export const TaskSourceMappingSchema = z.object({
  schemaVersion: z.literal("openpond.taskSourceMapping.v1"),
  exampleId: LearningJsonPointerSchema,
  attemptId: LearningJsonPointerSchema,
  occurredAt: LearningJsonPointerSchema,
  input: LearningJsonPointerSchema,
  observedOutput: LearningJsonPointerSchema.nullable(),
  expected: LearningJsonPointerSchema.nullable(),
  evaluatorContext: LearningJsonPointerSchema.nullable(),
  familyKey: LearningJsonPointerSchema,
  split: TaskSplitSchema,
}).strict();
export const LearningSourceContentSchema = z.object({
  schemaVersion: z.literal("openpond.learningSource.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(500),
  kind: z.enum(["direct", "benchmark", "work", "opentelemetry", "provider"]),
  taskDefinition: LearningRevisionRefSchema,
  enabled: z.boolean(),
  allowedSplits: z.array(TaskSplitSchema).min(1).max(4),
  mapping: TaskSourceMappingSchema.nullable(),
  adapterVersion: z.string().trim().min(1).max(200).nullable(),
}).strict().superRefine((source, context) => {
  if (source.kind !== "direct" && !source.mapping) context.addIssue({ code: "custom", path: ["mapping"], message: "Mapped sources require an explicit mapping." });
  if (source.mapping && !source.allowedSplits.includes(source.mapping.split)) context.addIssue({ code: "custom", path: ["allowedSplits"], message: "The mapping split must be allowed by this source." });
  if (["opentelemetry", "provider"].includes(source.kind) && !source.adapterVersion) context.addIssue({ code: "custom", path: ["adapterVersion"], message: "Trace adapters require a pinned version." });
});
export const LearningSourceSchema = LearningSourceContentSchema.safeExtend({ contentHash: ReleaseHashSchema }).strict();

export const TaskExampleSubmissionSchema = z.object({
  schemaVersion: z.literal("openpond.taskExample.v1"),
  sourceId: ReleaseIdSchema,
  idempotencyKey: ReleaseIdSchema,
  taskDefinition: LearningRevisionRefSchema,
  exampleId: ReleaseIdSchema,
  attemptId: ReleaseIdSchema,
  occurredAt: ReleaseTimestampSchema,
  familyKey: ReleaseIdSchema.nullable(),
  split: TaskSplitSchema,
  input: LearningJsonObjectSchema,
  observedOutput: LearningJsonObjectSchema.nullable(),
  expected: LearningJsonObjectSchema.nullable(),
  evaluatorContext: LearningJsonObjectSchema.nullable(),
  assets: z.array(ImmutableAssetRefSchema).max(1_000),
  provenance: z.object({ sourceRecordRef: z.string().max(2_000).nullable(), mappingHash: ReleaseHashSchema.nullable() }).strict(),
}).strict();

export const TaskEvidenceContentSchema = z.object({
  schemaVersion: z.literal("openpond.taskEvidence.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  source: LearningRevisionRefSchema,
  submission: TaskExampleSubmissionSchema,
  supersedes: LearningRevisionRefSchema.nullable(),
  correctionFeedbackId: ReleaseIdSchema.nullable(),
  receivedAt: ReleaseTimestampSchema,
}).strict();
export const TaskEvidenceSchema = TaskEvidenceContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export const TaskFeedbackSubmissionSchema = z.object({
  schemaVersion: z.literal("openpond.taskFeedback.v1"),
  sourceId: ReleaseIdSchema,
  idempotencyKey: ReleaseIdSchema,
  exampleId: ReleaseIdSchema,
  attemptId: ReleaseIdSchema,
  expectedEvidenceHash: ReleaseHashSchema.nullable(),
  occurredAt: ReleaseTimestampSchema,
  kind: z.enum(["outcome", "target_correction", "ground_truth_correction", "input_correction", "family_resolution"]),
  value: LearningJsonObjectSchema,
  note: z.string().max(20_000),
}).strict();
export const TaskFeedbackSchema = z.object({
  schemaVersion: z.literal("openpond.taskFeedbackRecord.v1"),
  id: ReleaseIdSchema,
  submission: TaskFeedbackSubmissionSchema,
  status: z.enum(["pending_example", "pending_review", "applied", "superseded", "rejected"]),
  evidence: LearningRevisionRefSchema.nullable(),
  createdAt: ReleaseTimestampSchema,
  revision: z.number().int().positive(),
  review: z.object({ actorId: ReleaseIdSchema, decision: LearningRevisionRefSchema.nullable(), note: z.string().max(20_000), resolvedAt: ReleaseTimestampSchema }).strict().nullable().default(null),
}).strict();

export const TaskAdmissionDecisionContentSchema = z.object({
  schemaVersion: z.literal("openpond.taskAdmissionDecision.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  evidence: LearningRevisionRefSchema,
  supersedes: LearningRevisionRefSchema.nullable(),
  actor: z.object({ kind: z.enum(["human", "qualified_policy"]), id: ReleaseIdSchema, policy: LearningRevisionRefSchema.nullable() }).strict(),
  evidenceValidity: z.enum(["valid", "invalid", "pending"]),
  taskAdmissibility: z.enum(["approved", "rejected", "pending"]),
  observedQuality: z.enum(["passed", "failed", "unscored", "unavailable"]),
  targetApproval: z.enum(["approved", "rejected", "pending", "not_required"]),
  approvedTarget: LearningJsonObjectSchema.nullable(),
  grade: RewardCompositionSchema.nullable(),
  targetGrade: RewardCompositionSchema.nullable(),
  note: z.string().max(20_000),
  decidedAt: ReleaseTimestampSchema,
}).strict().superRefine((decision, context) => {
  if (decision.targetApproval === "approved" && decision.approvedTarget === null) context.addIssue({ code: "custom", path: ["approvedTarget"], message: "Target approval requires an actual target." });
  if (decision.targetApproval !== "approved" && decision.approvedTarget !== null) context.addIssue({ code: "custom", path: ["approvedTarget"], message: "Only approved targets may be selected for supervised learning." });
  if (decision.actor.kind === "qualified_policy" && !decision.actor.policy) context.addIssue({ code: "custom", path: ["actor"], message: "Automatic admission must pin its qualified policy." });
  if (decision.taskAdmissibility === "approved" && decision.evidenceValidity !== "valid") context.addIssue({ code: "custom", path: ["taskAdmissibility"], message: "Only valid evidence can produce an approved task." });
});
export const TaskAdmissionDecisionSchema = TaskAdmissionDecisionContentSchema.safeExtend({ contentHash: ReleaseHashSchema }).strict();

export const TaskBatchContentSchema = z.object({
  schemaVersion: z.literal("openpond.taskBatch.v1"),
  id: ReleaseIdSchema,
  revision: z.literal(1),
  taskDefinition: LearningRevisionRefSchema,
  rewardBinding: LearningRevisionRefSchema,
  purpose: z.enum(["supervised_training", "reward_training", "evaluation"]),
  examples: z.array(z.object({ evidence: LearningRevisionRefSchema, decision: LearningRevisionRefSchema, familyKey: ReleaseIdSchema, inputHash: ReleaseHashSchema, split: TaskSplitSchema }).strict()).min(1).max(10_000),
  sealedAt: ReleaseTimestampSchema,
  sealedBy: ReleaseIdSchema,
}).strict().superRefine((batch, context) => {
  if (new Set(batch.examples.map((entry) => entry.evidence.id)).size !== batch.examples.length) context.addIssue({ code: "custom", path: ["examples"], message: "Each evidence identity can occur only once in a batch." });
  const splits = new Map<string, string>();
  for (const [index, entry] of batch.examples.entries()) {
    if ((batch.purpose === "evaluation") === (entry.split === "train")) context.addIssue({ code: "custom", path: ["examples", index, "split"], message: "Training uses train examples; evaluation uses held-out examples." });
    for (const key of [`family:${entry.familyKey}`, `input:${entry.inputHash}`]) {
      if (splits.has(key) && splits.get(key) !== entry.split) context.addIssue({ code: "custom", path: ["examples", index], message: "A task family or identical input cannot cross splits." });
      splits.set(key, entry.split);
    }
  }
});
export const TaskBatchSchema = TaskBatchContentSchema.safeExtend({ contentHash: ReleaseHashSchema }).strict();

export const LearningPolicyContentSchema = z.object({
  schemaVersion: z.literal("openpond.learningPolicy.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  modelProjectId: ReleaseIdSchema,
  executionOwner: z.enum(["local", "hosted"]),
  enabled: z.boolean(),
  sources: z.array(LearningRevisionRefSchema).min(1).max(100),
  taskDefinition: LearningRevisionRefSchema,
  rewardBinding: LearningRevisionRefSchema,
  admission: z.object({ mode: z.enum(["human", "qualified_automatic"]), qualification: ImmutableReleaseRefSchema.nullable(), minimumApprovedExamples: z.number().int().positive().max(100_000) }).strict(),
  trigger: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual") }).strict(),
    z.object({ kind: z.literal("approved_count") }).strict(),
    z.object({ kind: z.literal("schedule"), intervalSeconds: z.number().int().min(60).max(31_536_000) }).strict(),
    z.object({ kind: z.literal("upstream_accepted"), modelProjectId: ReleaseIdSchema }).strict(),
  ]),
  trainingParent: ImmutableReleaseRefSchema,
  teacher: ImmutableReleaseRefSchema.nullable(),
  training: z.object({ method: z.enum(["sft", "dpo", "grpo", "ppo", "sdft", "opd", "opsd", "sdpo"]), recipe: ImmutableReleaseRefSchema, retentionEvaluation: ImmutableReleaseRefSchema, replayBatches: z.array(ImmutableReleaseRefSchema).max(100) }).strict(),
  limits: z.object({ maxIterationSpendUsd: z.number().positive().max(100_000), maxDailySpendUsd: z.number().positive().max(1_000_000), cooldownSeconds: z.number().int().nonnegative().max(31_536_000), maxRetries: z.number().int().nonnegative().max(10), maxBatchExamples: z.number().int().positive().max(10_000), maxBacklogExamples: z.number().int().positive().max(1_000_000) }).strict(),
  automation: z.object({ collect: z.boolean(), train: z.boolean(), accept: z.boolean(), serve: z.boolean() }).strict(),
  acceptance: z.object({ minimumScore: z.number().min(0).max(1), maximumRetentionRegression: z.number().min(0).max(1), requireImprovement: z.boolean(), rollbackVersion: ImmutableReleaseRefSchema.nullable() }).strict(),
}).strict().superRefine((policy, context) => {
  if (policy.admission.mode === "qualified_automatic" && !policy.admission.qualification) context.addIssue({ code: "custom", path: ["admission"], message: "Automatic admission requires qualification evidence." });
  if (policy.automation.serve && !policy.automation.accept) context.addIssue({ code: "custom", path: ["automation"], message: "Automatic serving requires configured acceptance." });
  if (policy.automation.accept && !policy.acceptance.rollbackVersion) context.addIssue({ code: "custom", path: ["acceptance"], message: "Automatic acceptance requires a rollback version." });
  if (policy.trigger.kind === "upstream_accepted" && policy.trigger.modelProjectId === policy.modelProjectId) context.addIssue({ code: "custom", path: ["trigger"], message: "A model cannot trigger itself through upstream acceptance." });
  if (policy.limits.maxBatchExamples < policy.admission.minimumApprovedExamples) context.addIssue({ code: "custom", path: ["limits"], message: "The batch limit must permit the minimum approved example count." });
  if (policy.limits.maxDailySpendUsd < policy.limits.maxIterationSpendUsd) context.addIssue({ code: "custom", path: ["limits"], message: "Daily spend must permit the iteration budget." });
});
export const LearningPolicySchema = LearningPolicyContentSchema.safeExtend({ contentHash: ReleaseHashSchema }).strict();
export const LearningIterationStatusSchema = z.enum(["waiting_for_data", "waiting_for_review", "ready", "training", "evaluating", "candidate_ready", "accepted", "rejected", "paused", "failed", "cancelling", "cancelled"]);
export const LearningIterationSchema = z.object({
  schemaVersion: z.literal("openpond.learningIteration.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  policy: LearningRevisionRefSchema,
  status: LearningIterationStatusSchema,
  triggerIdentity: ReleaseIdSchema,
  batch: LearningRevisionRefSchema.nullable(),
  sourceWatermarks: z.record(ReleaseIdSchema, z.number().int().nonnegative()),
  trainingParent: ImmutableReleaseRefSchema,
  teacher: ImmutableReleaseRefSchema.nullable(),
  upstreamEvent: ImmutableReleaseRefSchema.nullable(),
  trainingJob: ImmutableReleaseRefSchema.nullable(),
  evaluationJob: ImmutableReleaseRefSchema.nullable(),
  candidateVersion: ImmutableReleaseRefSchema.nullable(),
  dispatchId: ReleaseIdSchema,
  retryCount: z.number().int().nonnegative(),
  spendUsd: z.number().nonnegative(),
  failure: z.object({ code: ReleaseIdSchema, message: z.string().max(20_000) }).strict().nullable(),
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict();

export const TaskGradeRunSchema = z.object({
  schemaVersion: z.literal("openpond.taskGradeRun.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  evidence: LearningRevisionRefSchema,
  binding: LearningRevisionRefSchema,
  target: z.enum(["observed", "proposed_target"]),
  output: LearningJsonObjectSchema,
  status: z.enum(["queued", "running", "completed", "failed", "cancelling", "cancelled"]),
  composition: RewardCompositionSchema.nullable(),
  leaseOwner: ReleaseIdSchema.nullable(),
  leaseExpiresAt: ReleaseTimestampSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(100).max(300_000),
  maximumSpendUsd: z.number().nonnegative().max(1_000),
  failure: z.string().max(20_000).nullable(),
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict();

export const LearningResourceSchema = z.union([TaskDefinitionSchema, RewardReleaseSchema, RewardBindingSchema, LearningSourceSchema, TaskEvidenceSchema, TaskFeedbackSchema, TaskAdmissionDecisionSchema, TaskBatchSchema, LearningPolicySchema, LearningIterationSchema, TaskGradeRunSchema]);

export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export type LearningSource = z.infer<typeof LearningSourceSchema>;
export type TaskExampleSubmission = z.infer<typeof TaskExampleSubmissionSchema>;
export type TaskEvidence = z.infer<typeof TaskEvidenceSchema>;
export type TaskFeedbackSubmission = z.infer<typeof TaskFeedbackSubmissionSchema>;
export type TaskFeedback = z.infer<typeof TaskFeedbackSchema>;
export type TaskAdmissionDecision = z.infer<typeof TaskAdmissionDecisionSchema>;
export type TaskBatch = z.infer<typeof TaskBatchSchema>;
export type LearningPolicy = z.infer<typeof LearningPolicySchema>;
export type LearningIteration = z.infer<typeof LearningIterationSchema>;
export type TaskGradeRun = z.infer<typeof TaskGradeRunSchema>;
export type LearningResource = z.infer<typeof LearningResourceSchema>;
export type LearningRevisionRef = z.infer<typeof LearningRevisionRefSchema>;

export function learningRef(resource: { id: string; revision: number; contentHash: string }): LearningRevisionRef {
  return LearningRevisionRefSchema.parse({ id: resource.id, revision: resource.revision, contentHash: resource.contentHash });
}
export function sameLearningRef(left: LearningRevisionRef, right: LearningRevisionRef): boolean {
  return left.id === right.id && left.revision === right.revision && left.contentHash === right.contentHash;
}
export function sealLearningContent<T extends Record<string, unknown>>(content: T): T & { contentHash: string } {
  assertBoundedTaskJson(content, 16_777_216);
  return { ...content, contentHash: contentHash(content) };
}
export function assertLearningContentHash(resource: { contentHash: string }): void {
  const { contentHash: hash, ...content } = resource;
  assertBoundedTaskJson(content, 16_777_216);
  if (contentHash(content) !== hash) throw new LearningDomainError("learning_content_hash_mismatch", 422);
}
