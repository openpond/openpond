import { z } from "zod";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const NeuronSteeringReferenceSchema = z.object({ id: Id, revision: z.number().int().positive(), contentHash: Hash }).strict();

/** Reference identity is verified against tensor state, configuration and
 * tokenizer descriptors. It is not a registry publication or worker release. */
export const NeuronSteeringModelSchema = z.object({
  schemaVersion: z.literal("openpond.neuronSteeringModel.v1"), modelId: Id, revision: Id,
  configHash: Hash, weightsHash: Hash, tokenizerHash: Hash,
  weightIdentity: z.literal("torch_state_dict_sha256_v1"), architecture: z.literal("dense_decoder"),
  dtype: z.enum(["float32", "float16", "bfloat16"]), quantization: z.literal("none"), adapter: z.null(),
  hiddenSize: z.number().int().positive().max(1_000_000),
  intermediateSizes: z.array(z.number().int().positive().max(10_000_000)).min(1).max(512),
}).strict();
export type NeuronSteeringModel = z.infer<typeof NeuronSteeringModelSchema>;
export const NeuronSteeringEntrySchema = z.object({
  layer: z.number().int().nonnegative().max(511), neuron: z.number().int().nonnegative().max(9_999_999), dose: z.number().finite(),
}).strict();
export const NeuronSteeringTokenScopeSchema = z.object({
  phase: z.enum(["prompt_and_decode", "prompt_only", "decode_only"]),
  positions: z.enum(["all_non_padding", "after_position_zero"]),
}).strict();
export const NeuronSteeringNormalizationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("baseline_prompt_residual_median"), statistic: z.literal("midpoint_median_fp32"),
    sample: z.literal("non_padding_prompt_after_position_zero") }).strict(),
  z.object({ mode: z.literal("fixed_residual_reference"), calibration: NeuronSteeringReferenceSchema }).strict(),
]);
export const NeuronSteeringProfileContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronSteeringProfile.v1"),
  model: NeuronSteeringModelSchema, hook: z.literal("mlp.down_proj.input"), operation: z.literal("add"),
  normalization: NeuronSteeringNormalizationSchema, tokenScope: NeuronSteeringTokenScopeSchema,
  entries: z.array(NeuronSteeringEntrySchema).min(1).max(64),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    const key = `${entry.layer}:${entry.neuron}`;
    if (seen.has(key) || entry.layer >= value.model.intermediateSizes.length || entry.neuron >= (value.model.intermediateSizes[entry.layer] ?? 0))
      ctx.addIssue({ code: "custom", path: ["entries", index], message: "Each coordinate must be unique and within this exact dense model." });
    seen.add(key);
  });
});
export const NeuronSteeringProfileSchema = NeuronSteeringProfileContentSchema.safeExtend({ contentHash: Hash });
export type NeuronSteeringProfile = z.infer<typeof NeuronSteeringProfileSchema>;
export async function createNeuronSteeringProfile(raw: z.input<typeof NeuronSteeringProfileContentSchema>): Promise<NeuronSteeringProfile> {
  const content = NeuronSteeringProfileContentSchema.parse(raw);
  return { ...content, contentHash: await canonicalSha256(content) };
}
export async function parseAndVerifyNeuronSteeringProfile(raw: unknown, model?: NeuronSteeringModel) {
  const value = NeuronSteeringProfileSchema.parse(raw), { contentHash, ...content } = value;
  if (contentHash !== await canonicalSha256(content) || model && await canonicalSha256(value.model) !== await canonicalSha256(NeuronSteeringModelSchema.parse(model)))
    throw new OpenPondProtocolError("neuron_steering_profile_mismatch", "The intervention differs from its exact model or retained payload.");
  return value;
}

export const NeuronResidualCalibrationContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronResidualCalibration.v1"), id: Id, revision: z.number().int().positive(), modelHash: Hash,
  source: z.object({ id: Id, contentHash: Hash }).strict(), statistic: z.literal("midpoint_median_fp32"),
  sample: z.literal("non_padding_prompt_after_position_zero"),
  layers: z.array(z.object({ layer: z.number().int().nonnegative().max(511), median: z.number().finite().positive(),
    sampleCount: z.number().int().positive() }).strict()).min(1).max(512),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.layers.map(layer => layer.layer)).size !== value.layers.length)
    ctx.addIssue({ code: "custom", path: ["layers"], message: "Calibration layers must be unique." });
});
export const NeuronResidualCalibrationSchema = NeuronResidualCalibrationContentSchema.safeExtend({ contentHash: Hash });
export type NeuronResidualCalibration = z.infer<typeof NeuronResidualCalibrationSchema>;
export async function parseAndVerifyNeuronResidualCalibration(raw: unknown, model: NeuronSteeringModel, reference?: z.infer<typeof NeuronSteeringReferenceSchema>) {
  const value = NeuronResidualCalibrationSchema.parse(raw), { contentHash, ...content } = value;
  if (contentHash !== await canonicalSha256(content) || value.modelHash !== await canonicalSha256(NeuronSteeringModelSchema.parse(model))
    || reference && (reference.id !== value.id || reference.revision !== value.revision || reference.contentHash !== value.contentHash)
    || value.layers.some(layer => layer.layer >= model.intermediateSizes.length))
    throw new OpenPondProtocolError("neuron_calibration_mismatch", "The residual calibration differs from its exact model or immutable reference.");
  return value;
}
