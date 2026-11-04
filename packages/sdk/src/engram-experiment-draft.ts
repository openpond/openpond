import { z } from "zod";
import { ModelProjectBaseModelSchema, ModelProjectVersionedRefSchema } from "./model-projects.js";
import { EngramAdapterConfigSchema, EngramArtifactReferenceSchema, EngramTrainingSettingsSchema } from "./engram-adapter.js";
import { SavedEngramExperimentSourceSchema } from "./engram-model-version.js";

export const ENGRAM_TRAINING_DEFAULTS = EngramTrainingSettingsSchema.parse({
  learningRate: 0.001, weightDecay: 0, maxSteps: 16,
  gradientAccumulationSteps: 8, maxSequenceLength: 2048, seed: 42,
  maxDurationSeconds: 3600, maxCheckpointBytes: 2_147_483_648,
});

/** The two paper configurations describe architecture, not runtime availability.
 * Execution still requires an exact qualified base and server-owned capability. */
export function engramPaperConfig(perHashDim: 128 | 256) {
  return EngramAdapterConfigSchema.parse({
    schemaVersion: "openpond.engramAdapterConfig.v1",
    implementation: "openpond_qwen_engram_paper_v1", hook: "self_attn.input",
    injectLayers: [1, 3, 7, 15], suffixOrders: [2, 3], previousOrders: [3],
    numHashes: 4, tableSize: 90_007, perHashDim, alpha: 0.2, memoryInitStd: 0.02,
    adapterDtype: "float32", projectionInit: "zeros", gateInit: "zeros_no_bias",
    boundary: "incomplete_group_off_v1", occupancy: "training_before_lookup_v1",
    history: "request_absolute_positions_v1", batchSize: 1,
  });
}

const Field = z.string().max(100);
export const EngramTrainingFormDraftSchema = z.object({
  learningRate: Field, weightDecay: Field, maxSteps: Field,
  gradientAccumulationSteps: Field, maxSequenceLength: Field, seed: Field,
  maxDurationSeconds: Field, maxCheckpointBytes: Field,
}).strict();
/** Incomplete authoring is retained verbatim. Preparing resolves an owned
 * reviewed batch and exact runtime; this draft grants no training authority. */
export const EngramExperimentFormDraftSchema = z.object({
  baseModel: ModelProjectBaseModelSchema.nullable(),
  batch: ModelProjectVersionedRefSchema.nullable(),
  name: z.string().max(500), maximumSpendUsd: z.string().max(100),
  training: EngramTrainingFormDraftSchema,
  parentArtifact: EngramArtifactReferenceSchema.nullable(),
  startingModule: SavedEngramExperimentSourceSchema.optional(),
}).strict();
export type EngramExperimentFormDraft = z.infer<typeof EngramExperimentFormDraftSchema>;
