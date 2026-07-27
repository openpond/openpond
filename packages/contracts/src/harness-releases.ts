import { z } from "zod";

import { LearningSignalEnvelopeSchema } from "./learning-signals.js";
import {
  ImmutableReleaseRefSchema,
  OpaqueSecretLeaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./release-core.js";

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

export type HarnessRuntimeTargetBinding = z.infer<
  typeof HarnessRuntimeTargetBindingSchema
>;
export type ComputeTargetBinding = z.infer<typeof ComputeTargetBindingSchema>;
export type TrainingEngineBinding = z.infer<
  typeof TrainingEngineBindingSchema
>;
export type HarnessRunManifest = z.infer<typeof HarnessRunManifestSchema>;
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
