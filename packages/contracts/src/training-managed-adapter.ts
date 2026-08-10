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
  systemPromptMode: z.enum(["lean", "full_harness", "custom"]).default("lean"),
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

export const DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION = LocalModelChatConfigurationSchema.parse({});

export const ManagedAdapterServingProjectionSchema = z.object({
  schemaVersion: z.literal("openpond.managedAdapterServingProjection.v1"),
  teamId: IdSchema.nullable().default(null),
  source: z.literal("sandbox_managed_rl"),
  sourceRef: IdSchema,
  canonicalArtifactId: IdSchema.nullable(),
  canonicalArtifactState: z
    .enum(["imported_unvalidated", "evaluating", "promotable", "rejected", "deleted"])
    .nullable(),
  canonicalDeploymentId: IdSchema.nullable(),
  canonicalDeploymentState: z
    .enum(["requested", "deploying", "ready", "degraded", "deleting", "deleted", "failed"])
    .nullable(),
  state: z.enum(["pending", "imported", "ready", "failed"]),
  customerBindingAllowed: z.boolean().default(false),
  artifactContentHash: HashSchema.nullable().default(null),
  baseProfileId: IdSchema.nullable().default(null),
  publishedAt: TimestampSchema.nullable(),
  lastSyncedAt: TimestampSchema,
  lastError: z.string().trim().min(1).max(5_000).nullable(),
});

export type LocalModelChatConfiguration = z.infer<typeof LocalModelChatConfigurationSchema>;
export type ManagedAdapterServingProjection = z.infer<typeof ManagedAdapterServingProjectionSchema>;

type ManagedAdapterPromotionLineage = {
  promotable: boolean;
  frozenEvaluationArtifactId: string | null;
  managedServing: ManagedAdapterServingProjection | null;
};

export type ModelBindingPromotionGate =
  | {
      kind: "source_frozen_evaluation";
      evaluationArtifactId: string;
      canonicalArtifactId: null;
      canonicalDeploymentId: null;
    }
  | {
      kind: "sandbox_customer_binding";
      evaluationArtifactId: null;
      canonicalArtifactId: string;
      canonicalDeploymentId: string;
    };

export function managedAdapterCustomerBindingAllowed(
  lineage: ManagedAdapterPromotionLineage,
): boolean {
  const projection = lineage.managedServing;
  return Boolean(
    projection?.source === "sandbox_managed_rl" &&
    projection.canonicalArtifactState === "promotable" &&
    projection.customerBindingAllowed,
  );
}

export function managedAdapterProjectionReady(
  projection: ManagedAdapterServingProjection,
): boolean {
  return (
    projection.state === "ready" &&
    projection.canonicalArtifactState === "promotable" &&
    projection.canonicalDeploymentState === "ready" &&
    projection.customerBindingAllowed &&
    Boolean(projection.teamId) &&
    Boolean(projection.canonicalArtifactId) &&
    Boolean(projection.canonicalDeploymentId)
  );
}

export function resolveModelBindingPromotionGate(
  lineage: ManagedAdapterPromotionLineage,
): ModelBindingPromotionGate | null {
  if (lineage.promotable && lineage.frozenEvaluationArtifactId) {
    return {
      kind: "source_frozen_evaluation",
      evaluationArtifactId: lineage.frozenEvaluationArtifactId,
      canonicalArtifactId: null,
      canonicalDeploymentId: null,
    };
  }
  const projection = lineage.managedServing;
  if (
    projection?.source === "sandbox_managed_rl" &&
    managedAdapterProjectionReady(projection) &&
    projection.canonicalArtifactId &&
    projection.canonicalDeploymentId
  ) {
    return {
      kind: "sandbox_customer_binding",
      evaluationArtifactId: null,
      canonicalArtifactId: projection.canonicalArtifactId,
      canonicalDeploymentId: projection.canonicalDeploymentId,
    };
  }
  return null;
}
