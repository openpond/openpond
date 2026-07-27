import { z } from "zod";

import {
  ComputeTargetBindingSchema,
  HarnessRunManifestSchema,
  HarnessRuntimeTargetBindingSchema,
  TrainingEngineBindingSchema,
} from "./harness-releases.js";
import { LearningSignalKindSchema } from "./learning-signals.js";
import { ProviderIdSchema } from "./providers.js";
import {
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./release-core.js";
import { TrainingRecipeSchema } from "./training.js";

export const TrainingEngineCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingEngineCapabilities.v1"),
    adapterId: ReleaseIdSchema,
    available: z.boolean(),
    methods: z.array(z.string().trim().min(1).max(100)),
    signalKinds: z.array(LearningSignalKindSchema),
    modelFamilies: z.array(z.string().trim().min(1).max(200)),
    precisions: z.array(
      z.enum(["fp32", "fp16", "bf16", "tf32", "int8", "int4"]),
    ),
    topologies: z.array(z.string().trim().min(1).max(200)),
    workerProtocolVersion: z.string().trim().min(1).max(200),
    upstreamRevision: z.string().trim().min(1).max(500),
    workerImageDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    capabilityReceipt: ReleaseHashSchema,
    checkedAt: ReleaseTimestampSchema,
    unavailableReason: z.string().trim().min(1).max(5_000).nullable(),
  })
  .strict();

export const ComputeTargetCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal("openpond.computeTargetCapabilities.v1"),
    adapterId: ReleaseIdSchema,
    kind: z.enum(["local", "ssh", "managed", "custom"]),
    provider: ReleaseIdSchema.nullable(),
    available: z.boolean(),
    devices: z.array(
      z
        .object({
          id: ReleaseIdSchema,
          kind: z.enum(["cpu", "gpu", "accelerator"]),
          vendor: z.string().trim().min(1).max(200),
          name: z.string().trim().min(1).max(500),
          memoryBytes: z.number().int().nonnegative().nullable(),
          runtime: z.string().trim().min(1).max(200),
        })
        .strict(),
    ),
    supportsWorkerImages: z.boolean(),
    supportsArtifactTransfer: z.boolean(),
    supportsCancellation: z.boolean(),
    capabilityReceipt: ReleaseHashSchema,
    checkedAt: ReleaseTimestampSchema,
    unavailableReason: z.string().trim().min(1).max(5_000).nullable(),
  })
  .strict();

export const HarnessRuntimeCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRuntimeCapabilities.v1"),
    adapterId: ReleaseIdSchema,
    available: z.boolean(),
    placements: z.array(
      z.enum(["local", "remote", "colocated", "provider_native"]),
    ),
    lifecycle: z.array(
      z.enum(["create", "reset", "step", "grade", "collect", "destroy"]),
    ),
    deterministicReplay: z.boolean(),
    privilegedIsolation: z.boolean(),
    capabilityReceipt: ReleaseHashSchema,
    checkedAt: ReleaseTimestampSchema,
    unavailableReason: z.string().trim().min(1).max(5_000).nullable(),
  })
  .strict();

export const ResolvedTrainingPlanSchema = z
  .object({
    schemaVersion: z.literal("openpond.resolvedTrainingPlan.v1"),
    manifest: HarnessRunManifestSchema,
    recipe: TrainingRecipeSchema,
    runtime: HarnessRuntimeTargetBindingSchema,
    compute: ComputeTargetBindingSchema,
    engine: TrainingEngineBindingSchema,
    execution: z
      .object({
        trainingPlanId: ReleaseIdSchema,
        approvalId: ReleaseIdSchema,
      })
      .strict()
      .nullable(),
    maximumSpendUsd: z.number().nonnegative().nullable(),
    approvalHash: ReleaseHashSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const exactBindings = [
      ["runtime", plan.runtime, plan.manifest.runtimeTarget],
      ["compute", plan.compute, plan.manifest.computeTarget],
      ["engine", plan.engine, plan.manifest.engine],
    ] as const;
    for (const [path, actual, expected] of exactBindings) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} must exactly match the Harness Run Manifest`,
        });
      }
    }
    if (plan.recipe.method !== plan.manifest.recipe.method) {
      context.addIssue({
        code: "custom",
        path: ["recipe", "method"],
        message: "Recipe method must match the Harness Run Manifest",
      });
    }
    if (plan.approvalHash !== plan.manifest.approval.approvalHash) {
      context.addIssue({
        code: "custom",
        path: ["approvalHash"],
        message: "Approval hash must match the Harness Run Manifest",
      });
    }
    if (
      plan.maximumSpendUsd !==
      plan.manifest.approval.maximumSpendUsd
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximumSpendUsd"],
        message: "Maximum spend must match the Harness Run Manifest",
      });
    }
  });

export const AdapterValidationReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.adapterValidationReceipt.v1"),
    adapterId: ReleaseIdSchema,
    valid: z.boolean(),
    issues: z.array(
      z
        .object({
          code: ReleaseIdSchema,
          path: z.string().trim().max(2_000).nullable(),
          message: z.string().trim().min(1).max(5_000),
        })
        .strict(),
    ),
    capabilityReceipt: ReleaseHashSchema,
    planHash: ReleaseHashSchema,
    createdAt: ReleaseTimestampSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const TrainingExecutionRefSchema = z
  .object({
    runId: ReleaseIdSchema,
    adapterId: ReleaseIdSchema,
    routeId: ReleaseIdSchema.optional(),
    providerJobId: z.string().trim().min(1).max(1_000).nullable(),
    leaseId: ReleaseIdSchema.nullable(),
    manifestHash: ReleaseHashSchema.optional(),
    inputBundleHash: ReleaseHashSchema.optional(),
    createdAt: ReleaseTimestampSchema,
  })
  .strict();

export const TrainingExecutionStatusSchema = z
  .object({
    runId: ReleaseIdSchema,
    state: z.enum([
      "queued",
      "preparing",
      "running",
      "cancelling",
      "cancelled",
      "succeeded",
      "failed",
    ]),
    phase: z.string().trim().min(1).max(200),
    progress: z.number().min(0).max(1).nullable(),
    updatedAt: ReleaseTimestampSchema,
    errorCode: ReleaseIdSchema.nullable(),
  })
  .strict();

export const TrainingArtifactsSchema = z
  .object({
    runId: ReleaseIdSchema,
    manifestHash: ReleaseHashSchema,
    artifacts: z.array(
      z
        .object({
          kind: z.enum([
            "checkpoint",
            "adapter",
            "metrics",
            "trace",
            "evaluation",
            "receipt",
          ]),
          objectRef: z.string().trim().min(1).max(2_000),
          sha256: ReleaseHashSchema,
          sizeBytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const TrainingPreparationStateSchema = z.enum([
  "ready",
  "model_download_required",
  "compute_setup_required",
  "provider_managed",
  "unsupported",
]);

export const TrainingCatalogTargetSchema = z
  .object({
    id: ReleaseIdSchema,
    label: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(2_000),
    destinationId: ReleaseIdSchema,
    computeAdapterId: ReleaseIdSchema,
    runtimeAdapterId: ReleaseIdSchema,
    engineAdapterId: ReleaseIdSchema,
    methods: z.array(z.string().trim().min(1).max(100)),
    capabilityPills: z.array(z.string().trim().min(1).max(100)),
    executionMode: z.enum([
      "local_worker",
      "connected_worker",
      "provider_native",
    ]),
    approvalPolicy: z
      .object({
        providerId: ProviderIdSchema,
        providerLabel: z.string().trim().min(1).max(200),
        settingsActionLabel: z.string().trim().min(1).max(500).nullable(),
        exportApprovalRequired: z.boolean(),
        exportDescription: z.string().trim().min(1).max(2_000).nullable(),
        preparationRequired: z.boolean(),
        minimumSpendUsd: z.number().nonnegative(),
        maximumSpendUsd: z.number().positive(),
        defaultMaximumSpendUsd: z.number().positive(),
        minimumRetentionDays: z.number().int().positive(),
        maximumRetentionDays: z.number().int().positive(),
        defaultRetentionDays: z.number().int().positive(),
        methodRequirement: z.string().trim().min(1).max(2_000).nullable(),
      })
      .strict()
      .nullable(),
    limits: z
      .object({
        maximumSequenceLength: z.number().int().positive(),
        maximumOutputTokens: z.number().int().positive(),
        maximumTrainingExamples: z.number().int().positive().nullable(),
      })
      .strict(),
    defaults: z
      .object({
        loraRank: z.number().int().positive(),
        rolloutOutputTokens: z.number().int().positive(),
      })
      .strict(),
    available: z.boolean(),
    unavailableReason: z.string().trim().min(1).max(5_000).nullable(),
  })
  .strict();

export const TrainingCatalogModelSchema = z
  .object({
    selectionKey: ReleaseIdSchema,
    label: z.string().trim().min(1).max(500),
    source: z.enum(["local", "builtin", "huggingface", "managed", "search"]),
    modelId: z.string().trim().min(1).max(1_000),
    revision: z.string().trim().min(1).max(500).nullable(),
    tokenizerRevision: z.string().trim().min(1).max(500).nullable(),
    chatTemplateHash: ReleaseHashSchema.nullable(),
    modelAssetId: ReleaseIdSchema.nullable(),
    expectedBytes: z.number().int().nonnegative().nullable(),
    cached: z.boolean(),
    known: z.boolean(),
    searchResolved: z.boolean(),
    computeAdapterIds: z.array(ReleaseIdSchema),
    engineAdapterIds: z.array(ReleaseIdSchema),
    preparationState: TrainingPreparationStateSchema,
    reason: z.string().trim().min(1).max(5_000).nullable(),
    compatibilities: z.array(
      z
        .object({
          targetId: ReleaseIdSchema,
          methods: z.array(z.string().trim().min(1).max(100)),
          state: TrainingPreparationStateSchema,
          reason: z.string().trim().min(1).max(5_000).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const TrainingCatalogSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingCatalog.v1"),
    models: z.array(TrainingCatalogModelSchema).max(100_000),
    engines: z.array(TrainingEngineCapabilitiesSchema),
    compute: z.array(ComputeTargetCapabilitiesSchema),
    runtimes: z.array(HarnessRuntimeCapabilitiesSchema),
    targets: z.array(TrainingCatalogTargetSchema),
    generatedAt: ReleaseTimestampSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const TrainingPreparationPlanSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingPreparationPlan.v1"),
    modelRunId: ReleaseIdSchema,
    state: TrainingPreparationStateSchema,
    reason: z.string().trim().min(1).max(5_000).nullable(),
    runtime: HarnessRuntimeTargetBindingSchema.nullable(),
    compute: ComputeTargetBindingSchema.nullable(),
    engine: TrainingEngineBindingSchema.nullable(),
    downloads: z.array(
      z
        .object({
          kind: z.literal("model"),
          label: z.string().trim().min(1).max(500),
          expectedBytes: z.number().int().nonnegative(),
          digest: z.string().trim().min(8).max(500),
          cached: z.boolean(),
          state: z.enum([
            "ready",
            "required",
            "downloading",
            "cancelled",
            "failed",
          ]),
          progress: z.number().min(0).max(1).nullable(),
          cancellable: z.boolean(),
          diskImpactBytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    dataMovement: z.array(
      z
        .object({
          direction: z.enum(["upload", "download", "none"]),
          label: z.string().trim().min(1).max(500),
          bytes: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    ),
    quoteUsd: z.number().nonnegative().nullable(),
    maximumSpendUsd: z.number().nonnegative().nullable(),
    retentionDays: z.number().int().nonnegative().nullable(),
    sideEffectsStarted: z.literal(false),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export type TrainingEngineCapabilities = z.infer<
  typeof TrainingEngineCapabilitiesSchema
>;
export type ComputeTargetCapabilities = z.infer<
  typeof ComputeTargetCapabilitiesSchema
>;
export type HarnessRuntimeCapabilities = z.infer<
  typeof HarnessRuntimeCapabilitiesSchema
>;
export type ResolvedTrainingPlan = z.infer<typeof ResolvedTrainingPlanSchema>;
export type AdapterValidationReceipt = z.infer<
  typeof AdapterValidationReceiptSchema
>;
export type TrainingExecutionRef = z.infer<typeof TrainingExecutionRefSchema>;
export type TrainingExecutionStatus = z.infer<
  typeof TrainingExecutionStatusSchema
>;
export type TrainingArtifacts = z.infer<typeof TrainingArtifactsSchema>;
export type TrainingPreparationState = z.infer<
  typeof TrainingPreparationStateSchema
>;
export type TrainingCatalogTarget = z.infer<
  typeof TrainingCatalogTargetSchema
>;
export type TrainingCatalogModel = z.infer<typeof TrainingCatalogModelSchema>;
export type TrainingCatalog = z.infer<typeof TrainingCatalogSchema>;
export type TrainingPreparationPlan = z.infer<
  typeof TrainingPreparationPlanSchema
>;
