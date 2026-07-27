import { z } from "zod";

import {
  TrainingHashSchema as HashSchema,
  TrainingIdSchema as IdSchema,
  TrainingTimestampSchema as TimestampSchema,
} from "./training-schema-primitives.js";

export const LocalModelChatConfigurationSchema = z.object({
  schemaVersion: z
    .literal("openpond.localModelChatConfiguration.v1")
    .default("openpond.localModelChatConfiguration.v1"),
  profile: z.enum(["efficient", "full_harness", "custom"]).default("efficient"),
  systemPromptMode: z
    .enum(["lean", "full_harness", "custom"])
    .default("lean"),
  customSystemPrompt: z.string().max(20_000).nullable().default(null),
  contextWindowTokens: z.number().int().min(128).max(32_768).default(1_024),
  maxOutputTokens: z.number().int().min(1).max(512).default(64),
  temperature: z.number().min(0).max(2).default(0),
  repetitionPenalty: z.number().min(0.5).max(2).default(1.1),
  noRepeatNgramSize: z.number().int().min(0).max(10).default(3),
  compaction: z.enum(["off", "when_needed"]).default("when_needed"),
  keepWarmSeconds: z.number().int().min(0).max(3_600).default(300),
  updatedAt: TimestampSchema.nullable().default(null),
});

export const DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION =
  LocalModelChatConfigurationSchema.parse({});

export const ManagedAdapterEvaluationEvidenceSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelAdapterEvaluation.v1"),
    evaluationId: IdSchema,
    role: z.enum([
      "chat_manual",
      "agent",
      "extension",
      "authoring_optimizer",
    ]),
    policyId: IdSchema,
    policyRevision: z.number().int().positive(),
    policyHash: HashSchema,
    tasksetId: IdSchema,
    tasksetHash: HashSchema,
    baselineScore: z.number().finite().min(0).max(1),
    candidateScore: z.number().finite().min(0).max(1),
    threshold: z.number().finite().min(0).max(1),
    minimumCandidateScore: z.number().finite().min(0).max(1),
    passed: z.boolean(),
    frozenEvaluatorHash: HashSchema,
    compatibility: z.object({
      passed: z.boolean(),
      workerImageDigest: z.string().trim().min(1).max(512),
      baseProfileHash: HashSchema,
      diagnosticSetHash: HashSchema,
      testedAt: TimestampSchema,
    }),
    resultHashes: z.object({
      baselineOutputsHash: HashSchema,
      candidateOutputsHash: HashSchema,
      diagnosticOutputsHash: HashSchema,
      resultSetHash: HashSchema,
    }),
    evidenceHash: HashSchema,
    completedAt: TimestampSchema,
  })
  .passthrough();

export const ManagedAdapterDeploymentEvidenceSchema = z
  .object({
    schemaVersion: z.literal("openpond.adapterDeployment.v1"),
    id: IdSchema,
    artifactId: IdSchema,
    provider: z.string().trim().min(1).max(128),
    poolId: IdSchema.nullable(),
    opaqueModelName: z.string().trim().min(1).max(240),
    state: z.enum([
      "requested",
      "deploying",
      "ready",
      "degraded",
      "deleting",
      "deleted",
      "failed",
    ]),
    providerConfigurationHash: HashSchema.nullable(),
    lastVerifiedAt: TimestampSchema.nullable(),
    failureCode: z.string().trim().min(1).max(512).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .passthrough();

export const ManagedAdapterServingPoolEvidenceSchema = z
  .object({
    id: IdSchema,
    baseProfileId: IdSchema,
    provider: z.string().trim().min(1).max(128),
    state: z.string().trim().min(1).max(128),
    workersMin: z.number().int().nonnegative(),
    workersMax: z.number().int().nonnegative(),
    idleTimeoutSeconds: z.number().int().nonnegative(),
    providerConfigurationHash: HashSchema.nullable(),
    leaseExpiresAt: TimestampSchema.nullable(),
    estimatedHourlyUsd: z.string().trim().min(1).max(64).nullable(),
    lastReconciledAt: TimestampSchema.nullable(),
    failureCode: z.string().trim().min(1).max(512).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .passthrough();

export const ManagedAdapterServingReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelAdapterServingReceipt.v1"),
    correlation: z
      .object({
        requestId: IdSchema,
        providerJobId: IdSchema,
        deploymentId: IdSchema,
        poolId: IdSchema,
        provider: z.string().trim().min(1).max(128),
        providerEndpointId: IdSchema,
      })
      .passthrough(),
    identity: z
      .object({
        logicalModelName: z.string().trim().min(1).max(240),
        baseProfileId: IdSchema,
        baseRepository: z.string().trim().min(1).max(512),
        baseRevision: z.string().trim().min(1).max(256),
        workerImage: z.string().trim().min(1).max(1_000),
        workerBootId: IdSchema,
        artifactId: IdSchema,
        artifactContentHash: HashSchema,
        requestedAlias: z.string().trim().min(1).max(240),
        resolvedManifestSha256: HashSchema,
        appliedVllmAdapterId: z.number().int().positive(),
      })
      .passthrough(),
    state: z
      .object({
        requestTemperature: z.enum(["cold", "warm"]),
        adapterCacheHit: z.boolean(),
        baseEngineInitializationCount: z.number().int().positive(),
        outcome: z.enum(["succeeded", "cancelled"]),
      })
      .passthrough(),
    timestamps: z
      .object({
        requestStartedAt: TimestampSchema,
        firstOutputAt: TimestampSchema,
        completedAt: TimestampSchema,
      })
      .passthrough(),
    durationsMs: z
      .object({
        adapterMaterialization: z.number().finite().nonnegative(),
        timeToFirstToken: z.number().finite().nonnegative(),
        generation: z.number().finite().nonnegative(),
        totalRequest: z.number().finite().nonnegative(),
      })
      .passthrough(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        providerUsageSource: z.enum(["provider", "estimated"]),
      })
      .passthrough(),
    cost: z
      .object({
        currency: z.literal("USD"),
        providerReportedUsd: z.number().finite().nonnegative().nullable(),
        estimatedUsd: z.number().finite().nonnegative(),
        estimateMethodology: z.string().trim().min(1).max(240),
      })
      .passthrough(),
    rawWorkerTelemetrySha256: HashSchema,
    contentHash: HashSchema,
  })
  .passthrough();

export const ManagedAdapterServingReceiptRecordSchema = z.object({
  schemaVersion: z.literal("openpond.modelAdapterServingReceiptRecord.v1"),
  requestId: IdSchema,
  state: z.enum([
    "reserved",
    "submitted",
    "streaming",
    "completed",
    "cancelling",
    "cancelled",
    "failed",
    "reconciled",
    "rejected",
  ]),
  artifactId: IdSchema,
  deploymentId: IdSchema,
  poolId: IdSchema,
  provider: z.string().trim().min(1).max(128),
  receipt: ManagedAdapterServingReceiptSchema,
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  reconciledAt: TimestampSchema.nullable(),
});

export const ManagedAdapterServingProjectionSchema = z.object({
  schemaVersion: z.literal("openpond.managedAdapterServingProjection.v1"),
  teamId: IdSchema.nullable().default(null),
  source: z.enum(["openpond_fireworks", "openpond_training"]),
  sourceRef: IdSchema,
  canonicalArtifactId: IdSchema.nullable(),
  canonicalArtifactState: z
    .enum([
      "imported_unvalidated",
      "evaluating",
      "promotable",
      "rejected",
      "deleted",
    ])
    .nullable(),
  canonicalDeploymentId: IdSchema.nullable(),
  canonicalDeploymentState: z
    .enum([
      "requested",
      "deploying",
      "ready",
      "degraded",
      "deleting",
      "deleted",
      "failed",
    ])
    .nullable(),
  state: z.enum(["pending", "imported", "ready", "failed"]),
  artifactContentHash: HashSchema.nullable().default(null),
  baseProfileId: IdSchema.nullable().default(null),
  evaluation: ManagedAdapterEvaluationEvidenceSchema.nullable().default(null),
  deployment: ManagedAdapterDeploymentEvidenceSchema.nullable().default(null),
  servingPool: ManagedAdapterServingPoolEvidenceSchema.nullable().default(null),
  servingReceipts: z
    .array(ManagedAdapterServingReceiptRecordSchema)
    .max(20)
    .default([]),
  publishedAt: TimestampSchema.nullable(),
  lastSyncedAt: TimestampSchema,
  lastError: z.string().trim().min(1).max(5_000).nullable(),
});

export type LocalModelChatConfiguration = z.infer<
  typeof LocalModelChatConfigurationSchema
>;
export type ManagedAdapterEvaluationEvidence = z.infer<
  typeof ManagedAdapterEvaluationEvidenceSchema
>;
export type ManagedAdapterDeploymentEvidence = z.infer<
  typeof ManagedAdapterDeploymentEvidenceSchema
>;
export type ManagedAdapterServingPoolEvidence = z.infer<
  typeof ManagedAdapterServingPoolEvidenceSchema
>;
export type ManagedAdapterServingReceipt = z.infer<
  typeof ManagedAdapterServingReceiptSchema
>;
export type ManagedAdapterServingReceiptRecord = z.infer<
  typeof ManagedAdapterServingReceiptRecordSchema
>;
export type ManagedAdapterServingProjection = z.infer<
  typeof ManagedAdapterServingProjectionSchema
>;
