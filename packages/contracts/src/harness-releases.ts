import { z } from "zod";

import {
  LearningSignalEnvelopeSchema,
  LearningSignalKindSchema,
} from "./learning-signals.js";
import {
  ImmutableReleaseRefSchema,
  OpaqueSecretLeaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  ScopedSecretDeclarationSchema,
  VersionedReleaseRefSchema,
} from "./release-core.js";

export const HarnessBundleProjectionSchema = z.enum([
  "student",
  "orchestrator",
  "environment",
  "privileged_scorer",
  "trainer",
  "infrastructure",
]);

export const HarnessReleaseAssetSchema = z
  .object({
    path: z.string().trim().min(1).max(2_000),
    sha256: ReleaseHashSchema,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().trim().min(1).max(200),
    executable: z.boolean(),
    projections: z.array(HarnessBundleProjectionSchema).min(1).max(6),
    visibility: z.enum(["model_visible", "orchestrator_only", "privileged"]),
  })
  .strict();

export const HarnessChildReleaseKindSchema = z.enum([
  "program",
  "tool_contract",
  "runtime_spec",
  "grader_definition",
  "feedback_policy",
  "dependency_lock",
  "extension_lock",
]);

export const HarnessChildReleaseRefSchema = ImmutableReleaseRefSchema.extend({
  kind: HarnessChildReleaseKindSchema,
  contractVersion: z.string().trim().min(1).max(200),
}).strict();

export const HarnessReleaseContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRelease.v1"),
    id: ReleaseIdSchema,
    revision: z.number().int().positive(),
    profileRelease: VersionedReleaseRefSchema.nullable(),
    children: z.array(HarnessChildReleaseRefSchema).min(7).max(10_000),
    assets: z.array(HarnessReleaseAssetSchema).max(100_000),
    secretDeclarations: z
      .array(ScopedSecretDeclarationSchema)
      .max(1_000)
      .default([]),
    requiredContracts: z
      .object({
        openpondRelease: z.string().trim().min(1).max(200),
        workerProtocol: z.string().trim().min(1).max(200),
        harnessRuntime: z.string().trim().min(1).max(200),
        trace: z.string().trim().min(1).max(200),
      })
      .strict(),
    sourceRevision: z.string().trim().min(1).max(500),
    publishedAt: ReleaseTimestampSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const HarnessReleaseSchema = HarnessReleaseContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();

export const DatasetReleaseAssetSchema = z
  .object({
    path: z.string().trim().min(1).max(2_000),
    split: z.enum(["train", "frozen_eval"]),
    sha256: ReleaseHashSchema,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().trim().min(1).max(200),
  })
  .strict();

export const DatasetReleaseContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.datasetRelease.v1"),
    id: ReleaseIdSchema,
    revision: z.number().int().positive(),
    taskset: ImmutableReleaseRefSchema,
    assets: z.array(DatasetReleaseAssetSchema).min(1).max(100_000),
    splitCounts: z
      .object({
        train: z.number().int().nonnegative(),
        frozenEval: z.number().int().nonnegative(),
      })
      .strict(),
    sourceRefsHash: ReleaseHashSchema,
    publishedAt: ReleaseTimestampSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const DatasetReleaseSchema = DatasetReleaseContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();

export const EvidenceSetSignalRefSchema = z
  .object({
    id: ReleaseIdSchema,
    kind: LearningSignalKindSchema,
    contentHash: ReleaseHashSchema,
    objectRef: z.string().trim().min(1).max(2_000),
    approved: z.boolean(),
    verificationReceiptHash: ReleaseHashSchema,
  })
  .strict();

export const EvidenceSetReleaseContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.evidenceSetRelease.v1"),
    id: ReleaseIdSchema,
    revision: z.number().int().positive(),
    datasetRelease: ImmutableReleaseRefSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    profileRelease: ImmutableReleaseRefSchema.nullable(),
    model: z
      .object({
        source: z.string().trim().min(1).max(200),
        revision: z.string().trim().min(1).max(500),
        artifactHash: ReleaseHashSchema.nullable(),
      })
      .strict(),
    environmentHash: ReleaseHashSchema,
    toolContractHash: ReleaseHashSchema,
    graderHash: ReleaseHashSchema,
    signals: z.array(EvidenceSetSignalRefSchema).min(1).max(1_000_000),
    coverageReceiptHash: ReleaseHashSchema,
    verificationPolicyHash: ReleaseHashSchema,
    publishedAt: ReleaseTimestampSchema,
  })
  .strict();

export const EvidenceSetReleaseSchema =
  EvidenceSetReleaseContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const HarnessRuntimeTargetBindingSchema = z
  .object({
    adapterId: ReleaseIdSchema,
    placement: z.enum(["local", "remote", "colocated", "provider_native"]),
    capabilityReceipt: ReleaseHashSchema,
    runtimeVersion: z.string().trim().min(1).max(200),
    dataPlane: z
      .object({
        provider: ReleaseIdSchema,
        dataPlaneId: ReleaseIdSchema,
        cellId: ReleaseIdSchema,
        runnerPoolId: ReleaseIdSchema,
        runtimeImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        capabilityReceipt: ReleaseHashSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const ComputeTargetBindingSchema = z
  .object({
    adapterId: ReleaseIdSchema,
    kind: z.enum(["local", "ssh", "managed", "custom"]),
    deviceOrPool: z.string().trim().min(1).max(1_000),
    capabilityReceipt: ReleaseHashSchema,
    provider: ReleaseIdSchema.nullable(),
  })
  .strict();

export const TrainingEngineBindingSchema = z
  .object({
    adapterId: ReleaseIdSchema,
    workerVersion: z.string().trim().min(1).max(200),
    workerImageDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    upstreamRevision: z.string().trim().min(1).max(500),
    capabilityReceipt: ReleaseHashSchema,
  })
  .strict();

export const HarnessRunManifestContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRunManifest.v1"),
    id: ReleaseIdSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    datasetRelease: ImmutableReleaseRefSchema,
    evidenceSets: z.array(ImmutableReleaseRefSchema).max(10_000),
    model: z
      .object({
        source: z.string().trim().min(1).max(200),
        revision: z.string().trim().min(1).max(500),
        artifactHash: ReleaseHashSchema.nullable(),
        tokenizerRevision: z.string().trim().min(1).max(500),
        chatTemplateHash: ReleaseHashSchema,
      })
      .strict(),
    recipe: z
      .object({
        method: z.string().trim().min(1).max(100),
        version: z.string().trim().min(1).max(200),
        configHash: ReleaseHashSchema,
      })
      .strict(),
    runtimeTarget: HarnessRuntimeTargetBindingSchema,
    computeTarget: ComputeTargetBindingSchema,
    engine: TrainingEngineBindingSchema,
    resolvedBundleHash: ReleaseHashSchema,
    secretLeaseRefs: z.array(OpaqueSecretLeaseRefSchema).max(1_000),
    approval: z
      .object({
        approvalHash: ReleaseHashSchema,
        approvedAt: ReleaseTimestampSchema,
        maximumSpendUsd: z.number().nonnegative().nullable(),
      })
      .strict(),
    createdAt: ReleaseTimestampSchema,
  })
  .strict();

export const HarnessRunManifestSchema = HarnessRunManifestContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();

export const HarnessExecutionBundleFileSchema = HarnessReleaseAssetSchema.extend(
  {
    sourceReleaseId: ReleaseIdSchema,
  },
).strict();

export const HarnessExecutionBundleManifestSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessExecutionBundle.v1"),
    harnessRelease: ImmutableReleaseRefSchema,
    resolvedGraphHash: ReleaseHashSchema,
    target: z
      .object({
        adapterId: ReleaseIdSchema,
        projection: HarnessBundleProjectionSchema,
        runtimeVersion: z.string().trim().min(1).max(200),
      })
      .strict(),
    files: z.array(HarnessExecutionBundleFileSchema).max(100_000),
    secretDeclarations: z.array(ScopedSecretDeclarationSchema).max(1_000),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const ResolvedTrainingBundleContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.resolvedTrainingBundle.v1"),
    projection: z.literal("trainer"),
    harnessRelease: ImmutableReleaseRefSchema,
    datasetRelease: ImmutableReleaseRefSchema,
    evidenceSetRelease: ImmutableReleaseRefSchema.nullable(),
    files: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(2_000),
            sha256: ReleaseHashSchema,
            sizeBytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();

export const ResolvedTrainingBundleManifestSchema =
  ResolvedTrainingBundleContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const ModelActionSchema = z
  .object({
    id: ReleaseIdSchema,
    turn: z.number().int().nonnegative(),
    kind: z.enum(["message", "tool_call", "terminal"]),
    name: ReleaseIdSchema.nullable(),
    arguments: z.record(z.string(), z.unknown()),
    content: z.string().max(1_000_000).nullable(),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const ToolObservationSchema = z
  .object({
    actionId: ReleaseIdSchema,
    turn: z.number().int().nonnegative(),
    terminal: z.boolean(),
    output: z.record(z.string(), z.unknown()),
    artifactRefs: z.array(z.string().trim().min(1).max(2_000)),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const HarnessRuntimeEventReceiptSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    type: z.enum([
      "created",
      "reset",
      "action",
      "observation",
      "terminal",
      "graded",
      "feedback",
      "failure",
      "collected",
      "destroyed",
    ]),
    timestamp: ReleaseTimestampSchema,
    payloadHash: ReleaseHashSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const HarnessGraderEvidenceSchema = z
  .object({
    graderId: ReleaseIdSchema,
    graderVersion: z.string().trim().min(1).max(200),
    score: z.number().finite().nullable(),
    passed: z.boolean(),
    rewardEligible: z.boolean(),
    failureClass: z
      .enum([
        "policy_failure",
        "grader_failure",
        "environment_failure",
        "infrastructure_failure",
        "timeout",
        "cancelled",
      ])
      .nullable(),
    feedback: z.array(z.string().max(500_000)),
    visibleEvidenceRefs: z.array(z.string().trim().min(1).max(2_000)),
    privilegedEvidenceRefs: z.array(z.string().trim().min(1).max(2_000)),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const HarnessRunTraceSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRunTrace.v1"),
    manifest: ImmutableReleaseRefSchema,
    taskId: ReleaseIdSchema,
    seed: z.string().trim().min(1).max(500),
    events: z.array(HarnessRuntimeEventReceiptSchema).max(1_000_000),
    actions: z.array(ModelActionSchema).max(100_000),
    observations: z.array(ToolObservationSchema).max(100_000),
    graderEvidence: z.array(HarnessGraderEvidenceSchema).max(10_000),
    learningSignals: z.array(LearningSignalEnvelopeSchema).max(100_000),
    terminal: z.boolean(),
    failureClass: HarnessGraderEvidenceSchema.shape.failureClass,
    artifactHash: ReleaseHashSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict();

export type HarnessBundleProjection = z.infer<
  typeof HarnessBundleProjectionSchema
>;
export type HarnessReleaseAsset = z.infer<typeof HarnessReleaseAssetSchema>;
export type HarnessChildReleaseRef = z.infer<
  typeof HarnessChildReleaseRefSchema
>;
export type HarnessRelease = z.infer<typeof HarnessReleaseSchema>;
export type DatasetRelease = z.infer<typeof DatasetReleaseSchema>;
export type EvidenceSetRelease = z.infer<typeof EvidenceSetReleaseSchema>;
export type HarnessRuntimeTargetBinding = z.infer<
  typeof HarnessRuntimeTargetBindingSchema
>;
export type ComputeTargetBinding = z.infer<typeof ComputeTargetBindingSchema>;
export type TrainingEngineBinding = z.infer<
  typeof TrainingEngineBindingSchema
>;
export type HarnessRunManifest = z.infer<typeof HarnessRunManifestSchema>;
export type HarnessExecutionBundleManifest = z.infer<
  typeof HarnessExecutionBundleManifestSchema
>;
export type ResolvedTrainingBundleManifest = z.infer<
  typeof ResolvedTrainingBundleManifestSchema
>;
export type ModelAction = z.infer<typeof ModelActionSchema>;
export type ToolObservation = z.infer<typeof ToolObservationSchema>;
export type HarnessRuntimeEventReceipt = z.infer<
  typeof HarnessRuntimeEventReceiptSchema
>;
export type HarnessGraderEvidence = z.infer<
  typeof HarnessGraderEvidenceSchema
>;
export type HarnessRunTrace = z.infer<typeof HarnessRunTraceSchema>;
