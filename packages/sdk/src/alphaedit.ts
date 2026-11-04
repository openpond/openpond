import { z } from "zod";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

export const ALPHAEDIT_SOURCE_REVISION = "b84624f44dfe8fc6cd9e41df916c44124a0c46dc";
export const ALPHAEDIT_MAX_CHECKPOINT_BYTES = 17_179_869_184;
export const ALPHAEDIT_MAX_DATA_BYTES = 8_388_608;
export const AlphaEditHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().trim().min(1).max(500);
const Text = z.string().min(1).max(32_768);

/** This is the measured tensor identity supplied by the qualified runtime,
 * rather than a claim that a repository revision is a torch state digest. */
export const AlphaEditModelSchema = NeuronSteeringModelSchema.refine(model =>
  model.modelId === "Qwen/Qwen3-8B"
  && model.revision === "b968826d9c46dd6066d109eabc6255188de91218"
  && model.dtype === "bfloat16" && model.hiddenSize === 4096
  && model.intermediateSizes.length === 36 && model.intermediateSizes.every(size => size === 12288),
{message: "AlphaEdit requires the exact unquantized Qwen3-8B BF16 backbone."});
export type AlphaEditModel = z.infer<typeof AlphaEditModelSchema>;

function onePlaceholder(value: string) {
  return value.split("{}").length === 2 && !value.replace("{}", "").match(/[{}]/);
}
export const AlphaEditExampleSchema = z.object({
  id: Id, subject: z.string().min(1).max(2048), promptTemplate: Text.refine(onePlaceholder), targetNew: z.string().min(1).max(4096),
}).strict();
export const AlphaEditPreservationExampleSchema = z.object({id: Id, text: Text}).strict();
export const AlphaEditExamplesSchema = z.array(AlphaEditExampleSchema).min(1).max(64).superRefine((rows, context) => {
  if (new Set(rows.map(row => row.id)).size !== rows.length || new TextEncoder().encode(canonicalJson(rows)).byteLength > ALPHAEDIT_MAX_DATA_BYTES)
    context.addIssue({code: "custom", message: "Edit identifiers must be unique and the canonical batch must fit the data byte bound."});
});
export const AlphaEditPreservationExamplesSchema = z.array(AlphaEditPreservationExampleSchema).min(1).max(4096).superRefine((rows, context) => {
  if (new Set(rows.map(row => row.id)).size !== rows.length || new TextEncoder().encode(canonicalJson(rows)).byteLength > ALPHAEDIT_MAX_DATA_BYTES)
    context.addIssue({code: "custom", message: "Preservation identifiers must be unique and the canonical batch must fit the data byte bound."});
});
export type AlphaEditExample = z.infer<typeof AlphaEditExampleSchema>;
export type AlphaEditPreservationExample = z.infer<typeof AlphaEditPreservationExampleSchema>;

const ReviewedData = z.object({batch: ModelProjectVersionedRefSchema, examplesSha256: AlphaEditHashSchema}).strict();
export const AlphaEditDataSchema = z.object({edits: ReviewedData, preservation: ReviewedData}).strict();
export type AlphaEditData = z.infer<typeof AlphaEditDataSchema>;
export const AlphaEditConfigSchema = z.object({
  schemaVersion: z.literal("openpond.alphaEditConfig.v1"),
  implementation: z.literal("openpond_qwen_alphaedit_v1"),
  sourceRevision: z.literal(ALPHAEDIT_SOURCE_REVISION),
  rewriteModule: z.literal("mlp.down_proj.weight"), factToken: z.literal("subject_last"),
  layers: z.array(z.number().int().min(0).max(35)).min(1).max(8),
  lossLayer: z.number().int().min(0).max(35),
  contextTemplateGroups: z.array(z.array(z.string().min(2).max(2048).refine(onePlaceholder)).min(1).max(8)).min(1).max(4),
  nullspaceThreshold: z.number().finite().positive().max(1),
  l2: z.number().finite().positive().max(100_000),
  covariance: z.literal("non_padding_uncentered_second_moment_fp32_v1"),
  projector: z.literal("covariance_svd_below_absolute_threshold_v1"),
  sequentialState: z.literal("post_edit_group_mean_keys_outer_product_sum_v1"),
  targetTokenization: z.literal("leading_space_no_special_tokens_v1"),
}).strict().superRefine((value, context) => {
  if (value.layers.some((layer, index) => index > 0 && layer <= value.layers[index - 1]!)
    || value.lossLayer < value.layers[value.layers.length - 1]!
    || value.contextTemplateGroups[0]?.length !== 1 || value.contextTemplateGroups[0]?.[0] !== "{}")
    context.addIssue({code: "custom", message: "Layers must increase, the loss layer must follow the rewrite layers, and the first context group must be the clean prompt."});
  const templates = value.contextTemplateGroups.flat();
  if (new Set(templates).size !== templates.length)
    context.addIssue({code: "custom", message: "Context templates must be unique."});
});
export type AlphaEditConfig = z.infer<typeof AlphaEditConfigSchema>;
export const AlphaEditTrainingSettingsSchema = z.object({
  maxSteps: z.number().int().min(1).max(128), learningRate: z.number().finite().positive().max(1),
  klFactor: z.number().finite().min(0).max(100), latentWeightDecay: z.number().finite().min(0).max(100),
  clampNormFactor: z.number().finite().positive().max(100),
  maxSequenceLength: z.number().int().min(2).max(8192),
  maxDurationSeconds: z.number().finite().min(1).max(21_600),
  maxForwardTokenWork: z.number().int().positive().max(100_000_000),
  maxCheckpointBytes: z.number().int().positive().max(ALPHAEDIT_MAX_CHECKPOINT_BYTES),
  seed: z.number().int().min(0).max(2_147_483_647),
}).strict();
export type AlphaEditTrainingSettings = z.infer<typeof AlphaEditTrainingSettingsSchema>;
export const AlphaEditArtifactReferenceSchema = z.object({id: Id, contentHash: AlphaEditHashSchema}).strict();
export const AlphaEditTrainingRequestSchema = z.object({
  schemaVersion: z.literal("openpond.alphaEditTrainingRequest.v1"),
  model: AlphaEditModelSchema, data: AlphaEditDataSchema,
  config: AlphaEditConfigSchema, training: AlphaEditTrainingSettingsSchema,
  parentArtifact: AlphaEditArtifactReferenceSchema.nullable(),
}).strict();
export type AlphaEditTrainingRequest = z.infer<typeof AlphaEditTrainingRequestSchema>;

export async function parseAndVerifyAlphaEditTrainingRequest(raw: unknown) {
  return AlphaEditTrainingRequestSchema.parse(raw);
}

/** These are already reviewed literal edit/preservation records. The host must
 * resolve their batch references and reauthorize them before issuing work. */
export async function verifyAlphaEditData(request: AlphaEditTrainingRequest, rawEdits: unknown, rawPreservation: unknown) {
  const parsed = AlphaEditTrainingRequestSchema.parse(request);
  const edits = AlphaEditExamplesSchema.parse(rawEdits), preservation = AlphaEditPreservationExamplesSchema.parse(rawPreservation);
  if (await canonicalSha256(edits) !== parsed.data.edits.examplesSha256
    || await canonicalSha256(preservation) !== parsed.data.preservation.examplesSha256)
    throw new OpenPondProtocolError("alphaedit_data_mismatch", "The AlphaEdit input differs from its reviewed edit or preservation batch.");
  return {edits, preservation};
}
