import { z } from "zod";
import { ModelProjectBaseModelSchema, ModelProjectVersionedRefSchema } from "./model-projects.js";
import { AlphaEditArtifactReferenceSchema, AlphaEditConfigSchema, AlphaEditTrainingSettingsSchema,
  ALPHAEDIT_SOURCE_REVISION } from "./alphaedit.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SavedAlphaEditExperimentSourceSchema = z.object({
  modelProjectId: Id, versionHash: Hash, artifact: AlphaEditArtifactReferenceSchema, modelHash: Hash,
}).strict();
export type SavedAlphaEditExperimentSource = z.infer<typeof SavedAlphaEditExperimentSourceSchema>;

/** Explicit Qwen port defaults. Availability and quality require runtime evidence. */
export const ALPHAEDIT_CONFIG_DEFAULTS = AlphaEditConfigSchema.parse({
  schemaVersion: "openpond.alphaEditConfig.v1", implementation: "openpond_qwen_alphaedit_v1",
  sourceRevision: ALPHAEDIT_SOURCE_REVISION, rewriteModule: "mlp.down_proj.weight", factToken: "subject_last",
  layers: [27, 28, 29], lossLayer: 31, contextTemplateGroups: [["{}"]],
  nullspaceThreshold: 0.02, l2: 10,
  covariance: "non_padding_uncentered_second_moment_fp32_v1",
  projector: "covariance_svd_below_absolute_threshold_v1",
  sequentialState: "post_edit_group_mean_keys_outer_product_sum_v1",
  targetTokenization: "leading_space_no_special_tokens_v1",
});
export const ALPHAEDIT_TRAINING_DEFAULTS = AlphaEditTrainingSettingsSchema.parse({
  maxSteps: 25, learningRate: 0.1, klFactor: 0.0625, latentWeightDecay: 0.5,
  clampNormFactor: 0.75, maxSequenceLength: 2048, maxDurationSeconds: 3600,
  maxForwardTokenWork: 16_000_000, maxCheckpointBytes: 8_589_934_592, seed: 42,
});

const Field = z.string().max(100);
export const AlphaEditConfigFormDraftSchema = z.object({
  layers: z.string().max(200), lossLayer: Field,
  contextTemplateGroups: z.string().max(65_536), nullspaceThreshold: Field, l2: Field,
}).strict();
export const AlphaEditTrainingFormDraftSchema = z.object({
  maxSteps: Field, learningRate: Field, klFactor: Field, latentWeightDecay: Field,
  clampNormFactor: Field, maxSequenceLength: Field, maxDurationSeconds: Field,
  maxForwardTokenWork: Field, maxCheckpointBytes: Field, seed: Field,
}).strict();
/** An incomplete authoring snapshot, never an approved edit or paid dispatch. */
export const AlphaEditExperimentFormDraftSchema = z.object({
  baseModel: ModelProjectBaseModelSchema.nullable(),
  editsBatch: ModelProjectVersionedRefSchema.nullable(),
  preservationBatch: ModelProjectVersionedRefSchema.nullable(),
  name: z.string().max(500), maximumSpendUsd: Field,
  config: AlphaEditConfigFormDraftSchema, training: AlphaEditTrainingFormDraftSchema,
  parentArtifact: AlphaEditArtifactReferenceSchema.nullable(),
  startingModule: SavedAlphaEditExperimentSourceSchema.optional(),
}).strict();
export type AlphaEditExperimentFormDraft = z.infer<typeof AlphaEditExperimentFormDraftSchema>;

export function newAlphaEditExperimentForm(baseModel: z.infer<typeof ModelProjectBaseModelSchema> | null = null): AlphaEditExperimentFormDraft {
  return AlphaEditExperimentFormDraftSchema.parse({
    baseModel, editsBatch: null, preservationBatch: null, name: "", maximumSpendUsd: "",
    config: {layers: ALPHAEDIT_CONFIG_DEFAULTS.layers.join(", "), lossLayer: String(ALPHAEDIT_CONFIG_DEFAULTS.lossLayer),
      contextTemplateGroups: JSON.stringify(ALPHAEDIT_CONFIG_DEFAULTS.contextTemplateGroups),
      nullspaceThreshold: String(ALPHAEDIT_CONFIG_DEFAULTS.nullspaceThreshold), l2: String(ALPHAEDIT_CONFIG_DEFAULTS.l2)},
    training: Object.fromEntries(Object.entries(ALPHAEDIT_TRAINING_DEFAULTS).map(([key, value]) => [key, String(value)])),
    parentArtifact: null,
  });
}
