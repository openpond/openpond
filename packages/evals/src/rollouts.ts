import { z } from "zod";

import {
  ImmutableArtifactRefSchema,
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ModelRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  contentHash,
} from "@openpond/harness";

import {
  AttemptOutcomeClassSchema,
  FailureOwnerSchema,
  RewardReceiptSchema,
  ScoringStatusSchema,
  type RewardReceipt,
} from "./execution-contracts.js";
import { TaskSplitSchema } from "./tasksets.js";
import { AttemptReceiptSchema, verifyAttemptReceipt, type AttemptReceipt } from "./runs.js";

export const OptimizerTrainingSampleSchema = z
  .object({
    schemaVersion: z.literal("openpond.optimizerTrainingSample.v1"),
    tokenIds: z.array(z.number().int().nonnegative()).min(2).max(32_768),
    mask: z.array(z.boolean()).min(2).max(32_768),
    logprobs: z.array(z.number().finite()).min(2).max(32_768),
    temperatures: z.array(z.number().positive().finite()).min(2).max(32_768),
    envName: z.string().trim().min(1).max(200),
    modelRequestId: z.string().trim().min(1).max(1_000),
    promptTokenCount: z.number().int().positive(),
    completionTokenCount: z.number().int().positive(),
    servedPolicyVersion: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((sample, context) => {
    const length = sample.tokenIds.length;
    for (const [name, values] of [
      ["mask", sample.mask],
      ["logprobs", sample.logprobs],
      ["temperatures", sample.temperatures],
    ] as const) {
      if (values.length !== length) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} must align with tokenIds`,
        });
      }
    }
    if (sample.promptTokenCount + sample.completionTokenCount !== length) {
      context.addIssue({
        code: "custom",
        path: ["completionTokenCount"],
        message: "prompt and completion token counts must span tokenIds",
      });
    }
    if (sample.mask.filter((trainable) => !trainable).length !== sample.promptTokenCount) {
      context.addIssue({
        code: "custom",
        path: ["mask"],
        message: "promptTokenCount must equal the non-trainable mask count",
      });
    }
    if (sample.mask.filter(Boolean).length !== sample.completionTokenCount) {
      context.addIssue({
        code: "custom",
        path: ["mask"],
        message: "completionTokenCount must equal the trainable mask count",
      });
    }
  });

export const EnvironmentExecutionEvidenceSchema = z.object({
  id: ReleaseIdSchema,
  environmentRelease: ImmutableReleaseRefSchema,
  status: z.enum(["completed", "failed", "timed_out", "cancelled"]),
  startedAt: ReleaseTimestampSchema,
  completedAt: ReleaseTimestampSchema,
  traceRefs: z.array(ImmutableArtifactRefSchema).max(10_000),
  metadata: MetadataSchema,
}).strict();

const RolloutRewardProjectionSchema = z.object({
  receiptRef: ImmutableReleaseRefSchema,
  status: ScoringStatusSchema,
  value: z.number().min(0).max(1).nullable(),
  learningEligible: z.boolean(),
  passed: z.boolean(),
  outcomeClass: AttemptOutcomeClassSchema,
  failureOwner: FailureOwnerSchema.nullable(),
  components: z.record(ReleaseIdSchema, z.number().min(0).max(1).nullable()),
}).strict();

const CanonicalRolloutRecordFieldsSchema = z.object({
  schemaVersion: z.literal("openpond.canonicalRolloutRecord.v1"),
  id: ReleaseIdSchema,
  attemptRef: ImmutableReleaseRefSchema,
  artifactManifestRef: ImmutableReleaseRefSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  environmentRelease: ImmutableReleaseRefSchema,
  verifierSetRelease: ImmutableReleaseRefSchema,
  harnessRelease: ImmutableReleaseRefSchema,
  taskId: ReleaseIdSchema,
  split: TaskSplitSchema,
  model: ModelRefSchema,
  seed: z.string().trim().min(1).max(500),
  reward: RolloutRewardProjectionSchema,
  traceRef: ImmutableArtifactRefSchema,
  optimizerSample: OptimizerTrainingSampleSchema.nullable(),
  environmentExecutions: z.array(EnvironmentExecutionEvidenceSchema).min(1).max(100_000),
  startedAt: ReleaseTimestampSchema,
  completedAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict();

function validateCanonicalRolloutRecord(
  record: z.infer<typeof CanonicalRolloutRecordFieldsSchema>,
  context: z.RefinementCtx,
): void {
  if (record.reward.status === "scored" && (record.reward.value === null || !record.reward.learningEligible)) {
    context.addIssue({
      code: "custom",
      path: ["reward", "status"],
      message: "A scored rollout requires a numeric, learning-eligible reward.",
    });
  }
  if (record.reward.status === "unscorable" && (record.reward.value !== null || record.reward.learningEligible)) {
    context.addIssue({
      code: "custom",
      path: ["reward", "status"],
      message: "An unscorable rollout has no reward and cannot be learning-eligible.",
    });
  }
}

const CanonicalRolloutRecordBaseSchema = CanonicalRolloutRecordFieldsSchema
  .superRefine(validateCanonicalRolloutRecord);

export const CanonicalRolloutRecordSchema = z.object({
  ...CanonicalRolloutRecordFieldsSchema.shape,
  contentHash: ReleaseHashSchema,
}).strict().superRefine(validateCanonicalRolloutRecord);

export const RolloutQualificationSchema = z.object({
  schemaVersion: z.literal("openpond.rolloutQualification.v1"),
  rolloutCount: z.number().int().nonnegative(),
  scoredCount: z.number().int().nonnegative(),
  optimizerEligibleCount: z.number().int().nonnegative(),
  unscorableCount: z.number().int().nonnegative(),
  zeroRewardCount: z.number().int().nonnegative(),
  rewardMean: z.number().min(0).max(1).nullable(),
  rewardVariance: z.number().nonnegative().nullable(),
  distinctRewardCount: z.number().int().nonnegative(),
  eligibleForRl: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(1_000)).max(100),
}).strict();

export function createCanonicalRolloutRecord(input: {
  id: string;
  attemptReceipt: AttemptReceipt;
  rewardReceipt: RewardReceipt;
  artifactManifestRef: { id: string; contentHash: string };
  tasksetRelease: { id: string; contentHash: string };
  environmentRelease: { id: string; contentHash: string };
  harnessRelease: { id: string; contentHash: string };
  taskId: string;
  split: z.input<typeof TaskSplitSchema>;
  model: z.input<typeof ModelRefSchema>;
  seed: string;
  traceRef: z.input<typeof ImmutableArtifactRefSchema>;
  optimizerSample: z.input<typeof OptimizerTrainingSampleSchema> | null;
  environmentExecutions: z.input<typeof EnvironmentExecutionEvidenceSchema>[];
  startedAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
}): CanonicalRolloutRecord {
  const attemptReceipt = AttemptReceiptSchema.parse(input.attemptReceipt);
  if (!verifyAttemptReceipt(attemptReceipt)) {
    throw new Error("Rollout Attempt Receipt failed content-hash verification.");
  }
  const rewardReceipt = RewardReceiptSchema.parse(input.rewardReceipt);
  if (
    rewardReceipt.attemptRef.id !== attemptReceipt.id
    || rewardReceipt.attemptRef.contentHash !== attemptReceipt.contentHash
  ) {
    throw new Error("Rollout Attempt Receipt does not match its Reward Receipt.");
  }
  if (
    rewardReceipt.artifactManifestRef.id !== input.artifactManifestRef.id
    || rewardReceipt.artifactManifestRef.contentHash !== input.artifactManifestRef.contentHash
  ) {
    throw new Error("Rollout Artifact Manifest does not match its Reward Receipt.");
  }
  if (input.environmentExecutions.some((execution) =>
    execution.environmentRelease.id !== input.environmentRelease.id
    || execution.environmentRelease.contentHash !== input.environmentRelease.contentHash
  )) {
    throw new Error("Rollout Environment execution does not match its admitted Environment Release.");
  }
  const content = CanonicalRolloutRecordBaseSchema.parse({
    schemaVersion: "openpond.canonicalRolloutRecord.v1",
    id: input.id,
    attemptRef: rewardReceipt.attemptRef,
    artifactManifestRef: input.artifactManifestRef,
    tasksetRelease: input.tasksetRelease,
    environmentRelease: input.environmentRelease,
    verifierSetRelease: rewardReceipt.verifierSetRef,
    harnessRelease: input.harnessRelease,
    taskId: input.taskId,
    split: input.split,
    model: input.model,
    seed: input.seed,
    reward: {
      receiptRef: { id: rewardReceipt.id, contentHash: rewardReceipt.contentHash },
      status: rewardReceipt.status,
      value: rewardReceipt.reward,
      learningEligible: rewardReceipt.learningEligible,
      passed: rewardReceipt.passed,
      outcomeClass: rewardReceipt.outcomeClass,
      failureOwner: rewardReceipt.failureOwner,
      components: Object.fromEntries(rewardReceipt.components.map((component) => [
        component.verifierId,
        component.rewardContribution,
      ])),
    },
    traceRef: input.traceRef,
    optimizerSample: input.optimizerSample,
    environmentExecutions: input.environmentExecutions,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    metadata: input.metadata ?? {},
  });
  return CanonicalRolloutRecordSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}

export function verifyCanonicalRolloutRecord(value: unknown): value is CanonicalRolloutRecord {
  const parsed = CanonicalRolloutRecordSchema.safeParse(value);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  const canonical = CanonicalRolloutRecordBaseSchema.safeParse(content);
  return canonical.success && contentHash(canonical.data) === actual;
}

export function optimizerEligibleRollouts(
  records: readonly CanonicalRolloutRecord[],
): CanonicalRolloutRecord[] {
  return records.filter((record) =>
    record.reward.status === "scored"
    && record.reward.learningEligible
    && record.reward.value !== null
    && record.optimizerSample !== null
  );
}

export function qualifyRolloutBatch(input: {
  records: readonly CanonicalRolloutRecord[];
  minimumScoredRollouts?: number;
  minimumDistinctRewards?: number;
  minimumRewardVariance?: number;
}): RolloutQualification {
  const records = input.records.map((record) => CanonicalRolloutRecordSchema.parse(record));
  const scored = records.filter((record) =>
    record.reward.status === "scored"
    && record.reward.learningEligible
    && record.reward.value !== null
  );
  const optimizerEligible = optimizerEligibleRollouts(records);
  const rewards = scored.map((record) => record.reward.value as number);
  const mean = rewards.length
    ? rewards.reduce((total, reward) => total + reward, 0) / rewards.length
    : null;
  const variance = mean === null
    ? null
    : rewards.reduce((total, reward) => total + (reward - mean) ** 2, 0) / rewards.length;
  const distinctRewardCount = new Set(rewards.map((reward) => reward.toPrecision(12))).size;
  const minimumScoredRollouts = input.minimumScoredRollouts ?? 2;
  const minimumDistinctRewards = input.minimumDistinctRewards ?? 2;
  const minimumRewardVariance = input.minimumRewardVariance ?? Number.EPSILON;
  const reasons: string[] = [];
  if (scored.length < minimumScoredRollouts) reasons.push(
    `Requires at least ${minimumScoredRollouts} scored rollouts.`,
  );
  if (optimizerEligible.length !== scored.length) reasons.push(
    "Every scored rollout requires aligned optimizer token evidence.",
  );
  if (distinctRewardCount < minimumDistinctRewards) reasons.push(
    `Requires at least ${minimumDistinctRewards} distinct reward values.`,
  );
  if (variance === null || variance < minimumRewardVariance) reasons.push(
    `Reward variance must be at least ${minimumRewardVariance}.`,
  );
  return RolloutQualificationSchema.parse({
    schemaVersion: "openpond.rolloutQualification.v1",
    rolloutCount: records.length,
    scoredCount: scored.length,
    optimizerEligibleCount: optimizerEligible.length,
    unscorableCount: records.length - scored.length,
    zeroRewardCount: rewards.filter((reward) => reward === 0).length,
    rewardMean: mean,
    rewardVariance: variance,
    distinctRewardCount,
    eligibleForRl: reasons.length === 0,
    reasons,
  });
}

export type OptimizerTrainingSample = z.infer<typeof OptimizerTrainingSampleSchema>;
export type EnvironmentExecutionEvidence = z.infer<typeof EnvironmentExecutionEvidenceSchema>;
export type CanonicalRolloutRecord = z.infer<typeof CanonicalRolloutRecordSchema>;
export type RolloutQualification = z.infer<typeof RolloutQualificationSchema>;
