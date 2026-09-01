import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  VersionedReleaseRefSchema,
} from "./release-core.js";

export const ModelComparisonSeriesStatusSchema = z.enum(["draft", "active", "completed", "archived"]);
export const ModelComparisonEntryStatusSchema = z.enum([
  "draft", "ready", "queued", "running", "candidate", "accepted",
  "rejected", "no_signal", "failed", "cancelled",
]);
export const ModelComparisonEntryRoleSchema = z.enum([
  "seed", "daily_residual", "weekly_rollup", "full_refresh",
]);
export const ModelComparisonParentRuleSchema = z.enum([
  "base_model", "accepted_daily_head", "accepted_seed",
]);
export const ModelComparisonTaskSourceSchema = z.enum([
  "seed_taskset", "nightly_selection", "daily_cohort_union", "eligible_task_pool",
]);
export const ModelComparisonEvidenceSourceSchema = z.enum([
  "live_client", "evaluation_attempt", "replay_evidence", "manual",
]);

export const ModelComparisonScheduleEntrySchema = z.object({
  id: ReleaseIdSchema,
  ordinal: z.number().int().nonnegative(),
  label: z.string().trim().min(1).max(100),
  role: ModelComparisonEntryRoleSchema,
  parentRule: ModelComparisonParentRuleSchema,
  taskSource: ModelComparisonTaskSourceSchema,
  trainableRank: z.number().int().positive().max(1_024),
  minimumTasks: z.number().int().nonnegative().max(100_000),
  maximumTasks: z.number().int().positive().max(100_000),
}).strict().superRefine((entry, context) => {
  if (entry.minimumTasks > entry.maximumTasks) {
    context.addIssue({ code: "custom", path: ["minimumTasks"], message: "The minimum task count cannot exceed the maximum task count." });
  }
  const expected = {
    seed: ["base_model", "seed_taskset"],
    daily_residual: ["accepted_daily_head", "nightly_selection"],
    weekly_rollup: ["accepted_seed", "daily_cohort_union"],
    full_refresh: ["base_model", "eligible_task_pool"],
  } as const;
  const [parentRule, taskSource] = expected[entry.role];
  if (entry.parentRule !== parentRule) {
    context.addIssue({ code: "custom", path: ["parentRule"], message: `${entry.role} requires parent rule ${parentRule}.` });
  }
  if (entry.taskSource !== taskSource) {
    context.addIssue({ code: "custom", path: ["taskSource"], message: `${entry.role} requires task source ${taskSource}.` });
  }
  if (entry.ordinal === 0 && entry.role !== "seed") {
    context.addIssue({ code: "custom", path: ["role"], message: "The first series entry must be the seed." });
  }
});

export const ModelComparisonAdvancementPolicySchema = z.object({
  id: ReleaseIdSchema,
  version: z.number().int().positive(),
  requireCheckpoint: z.boolean(),
  requireAppliedOptimizerUpdate: z.boolean(),
  minimumCurrentCohortMeanImprovement: z.number().finite(),
  maximumRetainedMeanRegression: z.number().finite().nonnegative(),
  blockCriticalInvariantRegression: z.boolean(),
  automaticDailyAdvancement: z.boolean(),
}).strict();

export const ModelComparisonSeriesSchema = z.object({
  schemaVersion: z.literal("openpond.modelComparisonSeries.v1"),
  id: ReleaseIdSchema,
  profileId: ReleaseIdSchema,
  modelProjectId: ReleaseIdSchema,
  name: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(20_000),
  status: ModelComparisonSeriesStatusSchema,
  revision: z.number().int().positive(),
  productionBinding: z.object({ role: z.literal("chat_manual"), roleTargetId: ReleaseIdSchema }).strict(),
  baseModel: z.object({ id: ReleaseIdSchema, revision: z.string().trim().min(1).max(256) }).strict(),
  seedTaskset: VersionedReleaseRefSchema,
  eligibleTaskPool: VersionedReleaseRefSchema,
  evaluationTasksets: z.object({
    development: VersionedReleaseRefSchema,
    retained: VersionedReleaseRefSchema,
    frozenFinal: VersionedReleaseRefSchema,
  }).strict(),
  grader: ImmutableReleaseRefSchema,
  residualProfile: z.object({
    profileId: ReleaseIdSchema,
    serializedEnvelopeRank: z.number().int().positive().max(1_024),
    maximumEnabledRank: z.number().int().positive().max(1_024),
    topology: z.literal("uniform_block_masked"),
  }).strict(),
  schedule: z.array(ModelComparisonScheduleEntrySchema).min(1).max(1_000),
  scheduleSealedAt: ReleaseTimestampSchema.nullable(),
  advancementPolicy: ModelComparisonAdvancementPolicySchema,
  executionPolicy: z.object({ startWhenReady: z.literal(false) }).strict(),
  acceptedSeedEntryId: ReleaseIdSchema.nullable(),
  acceptedDailyHeadEntryId: ReleaseIdSchema.nullable(),
  promotedBindingId: ReleaseIdSchema.nullable(),
  createdBy: ReleaseIdSchema,
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict().superRefine((series, context) => {
  const ordered = [...series.schedule].sort((left, right) => left.ordinal - right.ordinal);
  if (ordered.some((entry, index) => entry.ordinal !== index)) {
    context.addIssue({ code: "custom", path: ["schedule"], message: "Schedule ordinals must be unique and contiguous from zero." });
  }
  if (new Set(series.schedule.map((entry) => entry.id)).size !== series.schedule.length
    || new Set(series.schedule.map((entry) => entry.label)).size !== series.schedule.length) {
    context.addIssue({ code: "custom", path: ["schedule"], message: "Schedule ids and labels must be unique." });
  }
  if (series.residualProfile.maximumEnabledRank > series.residualProfile.serializedEnvelopeRank) {
    context.addIssue({ code: "custom", path: ["residualProfile"], message: "Maximum enabled rank cannot exceed the serialized envelope." });
  }
  const seed = series.schedule.find((entry) => entry.role === "seed");
  if (!seed || series.schedule.filter((entry) => entry.role === "seed").length !== 1) {
    context.addIssue({ code: "custom", path: ["schedule"], message: "A series requires exactly one seed entry." });
    return;
  }
  const dailyRank = seed.trainableRank + series.schedule
    .filter((entry) => entry.role === "daily_residual")
    .reduce((sum, entry) => sum + entry.trainableRank, 0);
  const branchRanks = [
    dailyRank,
    ...series.schedule.filter((entry) => entry.role === "weekly_rollup").map((entry) => seed.trainableRank + entry.trainableRank),
    ...series.schedule.filter((entry) => entry.role === "full_refresh").map((entry) => entry.trainableRank),
  ];
  if (branchRanks.some((rank) => rank > series.residualProfile.maximumEnabledRank)) {
    context.addIssue({ code: "custom", path: ["schedule"], message: "A declared branch exceeds the maximum enabled rank." });
  }
});

export const ModelComparisonTaskSelectionInputSchema = z.object({
  source: ModelComparisonEvidenceSourceSchema,
  taskIds: z.array(ReleaseIdSchema).min(1).max(100_000),
  observedFrom: ReleaseTimestampSchema,
  observedTo: ReleaseTimestampSchema,
  reviewedAt: ReleaseTimestampSchema,
  reviewedBy: ReleaseIdSchema,
  sourceTaskset: VersionedReleaseRefSchema,
}).strict();

export const ModelComparisonTaskSelectionSchema = ModelComparisonTaskSelectionInputSchema.extend({
  derivedFamilyKeys: z.array(ReleaseIdSchema).min(1).max(100_000),
  familyDerivation: z.object({ algorithm: ReleaseIdSchema, sourceTasksetHash: ReleaseHashSchema }).strict(),
  selectionHash: ReleaseHashSchema,
}).strict();

export const ModelComparisonParentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("base_model"), id: ReleaseIdSchema, revision: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("model_version"), id: ReleaseIdSchema, contentHash: ReleaseHashSchema }).strict(),
]);

export const ModelComparisonResidualBlockSchema = z.object({
  id: ReleaseIdSchema,
  branchOrdinal: z.number().int().nonnegative(),
  rank: z.number().int().positive().max(1_024),
  offsetStart: z.number().int().nonnegative(),
  offsetEnd: z.number().int().positive(),
  optimizationRole: z.enum(["frozen", "trainable"]),
  artifactLineageId: ReleaseIdSchema.nullable(),
}).strict().superRefine((block, context) => {
  if (block.offsetEnd - block.offsetStart !== block.rank) {
    context.addIssue({ code: "custom", path: ["offsetEnd"], message: "Block offsets must span exactly the declared rank." });
  }
});

export const ModelComparisonDecisionSchema = z.object({
  disposition: z.enum(["advance", "hold", "no_signal"]),
  policy: z.object({ id: ReleaseIdSchema, version: z.number().int().positive() }).strict(),
  reasonCodes: z.array(ReleaseIdSchema).min(1).max(100),
  summary: z.string().trim().min(1).max(5_000),
  decidedBy: ReleaseIdSchema,
  decidedAt: ReleaseTimestampSchema,
}).strict();

export const ModelComparisonEvaluationLinkSchema = z.object({
  evaluationRunId: ReleaseIdSchema,
  modelVersionId: ReleaseIdSchema,
  taskset: VersionedReleaseRefSchema,
  grader: ImmutableReleaseRefSchema,
  cohortRole: z.enum(["current", "development", "retained", "prior_disclosed", "frozen_final"]),
}).strict();

/**
 * Immutable identity for a Comparison Series release. The entry itself has a
 * mutable lifecycle, so Plans, Runs, Versions, and Evaluations carry this
 * release identity instead of embedding or trusting the entry's current state.
 */
export const ModelComparisonEntryRefSchema = z.object({
  seriesId: ReleaseIdSchema,
  entryId: ReleaseIdSchema,
  scheduleEntryId: ReleaseIdSchema,
  ordinal: z.number().int().nonnegative(),
  releaseHash: ReleaseHashSchema,
}).strict();

export const ModelComparisonSeriesEntrySchema = z.object({
  schemaVersion: z.literal("openpond.modelComparisonSeriesEntry.v1"),
  id: ReleaseIdSchema,
  seriesId: ReleaseIdSchema,
  profileId: ReleaseIdSchema,
  modelProjectId: ReleaseIdSchema,
  scheduleEntryId: ReleaseIdSchema,
  releaseHash: ReleaseHashSchema,
  ordinal: z.number().int().nonnegative(),
  label: z.string().trim().min(1).max(100),
  role: ModelComparisonEntryRoleSchema,
  branch: z.enum(["daily", "weekly_rollup", "full_refresh"]),
  status: ModelComparisonEntryStatusSchema,
  parent: ModelComparisonParentSchema,
  taskset: VersionedReleaseRefSchema,
  sourceTasksets: z.array(VersionedReleaseRefSchema).min(1).max(1_000),
  taskSelection: ModelComparisonTaskSelectionSchema.nullable(),
  trainableRank: z.number().int().positive().max(1_024),
  serializedEnvelopeRank: z.number().int().positive().max(1_024),
  enabledCumulativeRank: z.number().int().positive().max(1_024),
  trainableBlockId: ReleaseIdSchema,
  residualBlocks: z.array(ModelComparisonResidualBlockSchema).min(1).max(1_024),
  trainingPlanId: ReleaseIdSchema.nullable(),
  modelRunId: ReleaseIdSchema.nullable(),
  modelVersionId: ReleaseIdSchema.nullable(),
  evaluations: z.array(ModelComparisonEvaluationLinkSchema).max(100_000),
  decision: ModelComparisonDecisionSchema.nullable(),
  promotionBindingId: ReleaseIdSchema.nullable(),
  queuedAt: ReleaseTimestampSchema.nullable(),
  startedAt: ReleaseTimestampSchema.nullable(),
  completedAt: ReleaseTimestampSchema.nullable(),
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict().superRefine((entry, context) => {
  const ordered = [...entry.residualBlocks].sort((left, right) => left.offsetStart - right.offsetStart);
  if (ordered.some((block, index) => block.offsetStart !== (index === 0 ? 0 : ordered[index - 1]!.offsetEnd))) {
    context.addIssue({ code: "custom", path: ["residualBlocks"], message: "Residual block offsets must be contiguous from zero." });
  }
  const enabled = ordered.at(-1)?.offsetEnd ?? 0;
  if (enabled !== entry.enabledCumulativeRank || enabled > entry.serializedEnvelopeRank) {
    context.addIssue({ code: "custom", path: ["enabledCumulativeRank"], message: "Enabled rank must match the block inventory and fit the envelope." });
  }
  const trainable = entry.residualBlocks.filter((block) => block.optimizationRole === "trainable");
  if (trainable.length !== 1 || trainable[0]?.id !== entry.trainableBlockId || trainable[0]?.rank !== entry.trainableRank) {
    context.addIssue({ code: "custom", path: ["trainableBlockId"], message: "Exactly one block must be trainable during the Run and match trainableRank." });
  }
});

export const ModelComparisonQueueReleaseRequestSchema = z.object({
  seriesId: ReleaseIdSchema,
  scheduleEntryId: ReleaseIdSchema,
  taskSelection: ModelComparisonTaskSelectionInputSchema.nullable(),
  expectedSeriesRevision: z.number().int().positive(),
}).strict();

export type ModelComparisonSeriesStatus = z.infer<typeof ModelComparisonSeriesStatusSchema>;
export type ModelComparisonEntryStatus = z.infer<typeof ModelComparisonEntryStatusSchema>;
export type ModelComparisonEntryRole = z.infer<typeof ModelComparisonEntryRoleSchema>;
export type ModelComparisonScheduleEntry = z.infer<typeof ModelComparisonScheduleEntrySchema>;
export type ModelComparisonAdvancementPolicy = z.infer<typeof ModelComparisonAdvancementPolicySchema>;
export type ModelComparisonSeries = z.infer<typeof ModelComparisonSeriesSchema>;
export type ModelComparisonTaskSelection = z.infer<typeof ModelComparisonTaskSelectionSchema>;
export type ModelComparisonTaskSelectionInput = z.infer<typeof ModelComparisonTaskSelectionInputSchema>;
export type ModelComparisonParent = z.infer<typeof ModelComparisonParentSchema>;
export type ModelComparisonResidualBlock = z.infer<typeof ModelComparisonResidualBlockSchema>;
export type ModelComparisonDecision = z.infer<typeof ModelComparisonDecisionSchema>;
export type ModelComparisonEvaluationLink = z.infer<typeof ModelComparisonEvaluationLinkSchema>;
export type ModelComparisonEntryRef = z.infer<typeof ModelComparisonEntryRefSchema>;
export type ModelComparisonSeriesEntry = z.infer<typeof ModelComparisonSeriesEntrySchema>;
export type ModelComparisonQueueReleaseRequest = z.infer<typeof ModelComparisonQueueReleaseRequestSchema>;
