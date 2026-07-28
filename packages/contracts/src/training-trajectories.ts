import { z } from "zod";

import {
  CrossSystemTrajectorySchema,
  CrossSystemVerifierResultSchema,
} from "./cross-system-operations.js";
import {
  TrainingHashSchema as HashSchema,
  TrainingIdSchema as IdSchema,
  TrainingMetadataSchema as MetadataSchema,
  TrainingTimestampSchema as TimestampSchema,
} from "./training-schema-primitives.js";

export const SingleTurnPolicyTrajectorySchema = z.object({
  schemaVersion: z.literal("openpond.singleTurnPolicyTrajectory.v1"),
  id: IdSchema,
  taskId: IdSchema,
  status: z.enum(["completed", "infrastructure_failure"]),
  promptHash: HashSchema,
  responseText: z.string().max(2_000_000),
  infrastructureError: z.string().trim().min(1).max(10_000).nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  metadata: MetadataSchema,
});

export const PpoTrajectorySchema = z.object({
  schemaVersion: z.literal("openpond.ppoTrajectory.v1"),
  id: IdSchema,
  taskId: IdSchema,
  policyModelId: IdSchema,
  referenceModelId: IdSchema,
  valueModelId: IdSchema,
  steps: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        observationHash: HashSchema,
        actionTokenIds: z.array(z.number().int().nonnegative()).min(1),
        terminated: z.boolean(),
        truncated: z.boolean(),
        reward: z.number(),
        policyLogProbability: z.number(),
        referenceLogProbability: z.number(),
        valuePrediction: z.number(),
        return: z.number(),
        advantage: z.number(),
        mask: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(100_000),
  createdAt: TimestampSchema,
});

export const ExactAnswerVerifierResultSchema = z.object({
  schemaVersion: z.literal("openpond.exactAnswerVerifierResult.v1"),
  outcome: z.enum([
    "correct",
    "incorrect",
    "parse_failure",
    "infrastructure_failure",
  ]),
  graderSetHash: HashSchema,
  score: z.number().min(0).max(1).nullable(),
  passed: z.boolean(),
  rewardEligible: z.boolean(),
  expectedAnswerHash: HashSchema,
  extractedAnswer: z.string().max(20_000).nullable(),
  feedback: z.array(z.string().trim().min(1).max(20_000)).max(1_000),
});

export const RolloutTrajectoryReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.rolloutTrajectoryReceipt.v1"),
  id: IdSchema,
  jobId: IdSchema,
  planId: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  taskId: IdSchema,
  split: z.literal("train"),
  correlationId: IdSchema,
  provider: IdSchema,
  providerTrace: z.object({
    invocationId: IdSchema,
    experimentId: IdSchema,
    rolloutId: IdSchema,
    runId: IdSchema,
    rowId: IdSchema,
  }),
  optimizerMethod: z.enum(["grpo", "ppo"]).default("grpo"),
  evidenceLevels: z
    .object({
      requested: z.enum(["trajectory", "aggregate", "provider_reported"]),
      observed: z.enum(["trajectory", "aggregate", "provider_reported"]),
      providerReported: z.enum([
        "trajectory",
        "aggregate",
        "provider_reported",
      ]),
    })
    .default({
      requested: "trajectory",
      observed: "trajectory",
      providerReported: "provider_reported",
    }),
  budgetUsage: z
    .object({
      rollouts: z.number().int().nonnegative(),
      environmentExecutions: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      optimizerSteps: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    })
    .default({
      rollouts: 0,
      environmentExecutions: 0,
      inputTokens: 0,
      outputTokens: 0,
      optimizerSteps: 0,
      costUsd: 0,
    }),
  environment: z.object({
    id: IdSchema,
    version: z.string().trim().min(1).max(256),
    worldId: IdSchema,
    worldHash: HashSchema,
    toolContractHash: HashSchema,
  }),
  policy: z.object({
    modelId: IdSchema,
    checkpointId: IdSchema.nullable(),
    completionParametersHash: HashSchema,
  }),
  status: z.enum(["received", "running", "succeeded", "failed"]),
  failureClass: z
    .enum([
      "policy_failure",
      "parse_failure",
      "tool_schema_violation",
      "budget_exhausted",
      "cancelled",
      "environment_failure",
      "infrastructure_failure",
    ])
    .nullable(),
  reward: z.object({
    eligible: z.boolean(),
    raw: z.number().min(0).max(1.15).nullable(),
    normalized: z.number().min(0).max(1).nullable(),
    components: z.record(z.string(), z.number()),
  }),
  trajectory: z
    .union([
      CrossSystemTrajectorySchema,
      SingleTurnPolicyTrajectorySchema,
      PpoTrajectorySchema,
    ])
    .nullable(),
  verifier: z
    .union([
      CrossSystemVerifierResultSchema,
      ExactAnswerVerifierResultSchema,
    ])
    .nullable(),
  providerStatus: z.record(z.string(), z.unknown()).default({}),
  receivedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
});

export type RolloutTrajectoryReceipt = z.infer<
  typeof RolloutTrajectoryReceiptSchema
>;
export type PpoTrajectory = z.infer<typeof PpoTrajectorySchema>;
