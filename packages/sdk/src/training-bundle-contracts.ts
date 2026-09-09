import { z } from "zod";
import { ImmutableReleaseRefSchema, ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";

export const ScopedSecretDeclarationSchema = z
  .object({
    id: ReleaseIdSchema,
    purpose: z.string().trim().min(1).max(500),
    audience: z.enum([
      "orchestrator",
      "environment",
      "privileged_scorer",
      "trainer",
      "infrastructure",
    ]),
    required: z.boolean(),
    ttlSeconds: z.number().int().positive().max(86_400),
    scopes: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  })
  .strict();

export const OpaqueSecretLeaseRefSchema = z
  .object({
    declarationId: ReleaseIdSchema,
    leaseRef: z.string().trim().min(8).max(1_000),
    audience: ScopedSecretDeclarationSchema.shape.audience,
    expiresAt: ReleaseTimestampSchema,
  })
  .strict();

export type ScopedSecretDeclaration = z.infer<
  typeof ScopedSecretDeclarationSchema
>;
export type OpaqueSecretLeaseRef = z.infer<typeof OpaqueSecretLeaseRefSchema>;

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
