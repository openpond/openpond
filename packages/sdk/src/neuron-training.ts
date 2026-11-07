import { z } from "zod";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

export const NEURON_TRAINING_MAX_BYTES = 16_777_216;
export const NEURON_TRAINING_UPSTREAM_REVISION = "8a55f3159f735eb0823d7a894f67f632bf568bb3";
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Exact inference-state continuation. Optimizer/RNG state is never resumed;
 * the parent remains frozen while fresh column parameters learn a residual. */
export const NeuronTrainingParentArtifactReferenceSchema = z.object({
  id: z.string().trim().min(1).max(500), contentHash: Hash,
  selectionHash: Hash, payloadSha256: Hash,
  mode: z.literal("frozen_parent_fresh_residual_adam_v1"),
}).strict();
export const NeuronTrainingCoordinateSchema = z.object({
  layer: z.number().int().min(0).max(35), neuron: z.number().int().min(0).max(12_287),
}).strict();
export const NeuronTrainingSelectionSchema = z.object({
  count: z.number().int().min(1).max(128),
  span: z.enum(["reply_prediction", "reply_start", "prompt"]),
  backgroundStatistic: z.enum(["mean_domains", "max_domains"]),
  maximumBackgroundTargetRatio: z.number().finite().min(0).max(1),
  gradientExamples: z.number().int().min(1).max(64),
  explicitCoordinates: z.array(NeuronTrainingCoordinateSchema).min(1).max(128).nullable(),
}).strict().superRefine((value, context) => {
  if (value.explicitCoordinates && (value.explicitCoordinates.length !== value.count
    || new Set(value.explicitCoordinates.map(row => `${row.layer}:${row.neuron}`)).size !== value.count))
    context.addIssue({code: "custom", path: ["explicitCoordinates"], message: "Explicit coordinates must be distinct and match the selected count."});
});
export const NeuronTrainingDataReferenceSchema = z.object({
  batch: ModelProjectVersionedRefSchema, examplesSha256: Hash, encodingHash: Hash,
}).strict();
export const NeuronTrainingDataSchema = z.object({
  target: NeuronTrainingDataReferenceSchema,
  background: z.array(NeuronTrainingDataReferenceSchema.extend({domain: z.string().trim().min(1).max(100)}).strict()).max(8),
  preservation: NeuronTrainingDataReferenceSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.background.map(row => row.domain)).size !== value.background.length)
    context.addIssue({code: "custom", path: ["background"], message: "Background domains must have distinct names."});
});
export const NeuronTrainingSettingsSchema = z.object({
  learningRate: z.number().finite().positive().max(0.1),
  maxSteps: z.number().int().min(1).max(128),
  gradientAccumulationSteps: z.number().int().min(1).max(32),
  maxSequenceLength: z.number().int().min(2).max(8192),
  preservationWeight: z.number().finite().min(0).max(100),
  preservationExamplesPerStep: z.number().int().min(0).max(32),
  seed: z.number().int().min(0).max(2_147_483_647),
  maxDurationSeconds: z.number().finite().min(1).max(21_600),
  maxCheckpointBytes: z.number().int().min(1).max(NEURON_TRAINING_MAX_BYTES),
  maximumForwardTokenWork: z.number().int().min(1).max(100_000_000),
}).strict();
/** A dense Qwen3 port, not a claim that the upstream quality findings transfer. */
export const NeuronTrainingRequestSchema = z.object({
  schemaVersion: z.literal("openpond.selectiveNeuronTrainingRequest.v1"),
  model: NeuronSteeringModelSchema, data: NeuronTrainingDataSchema,
  selection: NeuronTrainingSelectionSchema, training: NeuronTrainingSettingsSchema,
  parentArtifact: NeuronTrainingParentArtifactReferenceSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.model.modelId !== "Qwen/Qwen3-8B" || value.model.revision !== "b968826d9c46dd6066d109eabc6255188de91218"
    || value.model.dtype !== "bfloat16" || value.model.hiddenSize !== 4096 || value.model.intermediateSizes.length !== 36
    || value.model.intermediateSizes.some(size => size !== 12288) || value.model.adapter !== null)
    context.addIssue({code: "custom", path: ["model"], message: "Use the exact supported dense BF16 Qwen3-8B source identity."});
  const preserve = value.training.preservationWeight > 0;
  if (preserve !== (value.data.preservation !== null) || preserve !== (value.training.preservationExamplesPerStep > 0))
    context.addIssue({code: "custom", path: ["training", "preservationWeight"], message: "Preservation data, weight and per-step work must be present together."});
  if (value.parentArtifact ? value.data.background.length !== 0 : value.data.background.length === 0)
    context.addIssue({code: "custom", path: ["data", "background"], message: "Fresh selection requires reviewed background domains; inherited selection retains its parent observations without new selection data."});
});
export type NeuronTrainingRequest = z.infer<typeof NeuronTrainingRequestSchema>;
export type NeuronTrainingSelection = z.infer<typeof NeuronTrainingSelectionSchema>;
export type NeuronTrainingData = z.infer<typeof NeuronTrainingDataSchema>;
export type NeuronTrainingSettings = z.infer<typeof NeuronTrainingSettingsSchema>;
export const NeuronTrainingEncodingSchema = z.object({
  schemaVersion: z.literal("openpond.neuronTrainingEncoding.v1"),
  implementation: z.literal("supervised_trainer.prepare_example.v1"),
  modelHash: Hash, tokenizerHash: Hash, maxSequenceLength: z.number().int().min(2).max(8192),
  completionOnly: z.literal(true), enableThinking: z.literal(false),
  truncation: z.literal("left_prompt_preserve_final_target_v1"),
  selectionBoundaries: z.literal("verified_last_user_template_offsets_v1"),
}).strict();
export async function neuronTrainingEncoding(model: z.infer<typeof NeuronSteeringModelSchema>, maxSequenceLength: number) {
  const parsed = NeuronSteeringModelSchema.parse(model);
  return NeuronTrainingEncodingSchema.parse({schemaVersion: "openpond.neuronTrainingEncoding.v1",
    implementation: "supervised_trainer.prepare_example.v1", modelHash: await canonicalSha256(parsed), tokenizerHash: parsed.tokenizerHash,
    maxSequenceLength, completionOnly: true, enableThinking: false, truncation: "left_prompt_preserve_final_target_v1",
    selectionBoundaries: "verified_last_user_template_offsets_v1"});
}
export async function parseAndVerifyNeuronTrainingRequest(raw: unknown) {
  assertBoundedTaskJson(raw, 131_072);
  const value = NeuronTrainingRequestSchema.parse(raw);
  const encodingHash = await canonicalSha256(await neuronTrainingEncoding(value.model, value.training.maxSequenceLength));
  if ([value.data.target, ...value.data.background, ...(value.data.preservation ? [value.data.preservation] : [])]
    .some(row => row.encodingHash !== encodingHash))
    throw new OpenPondProtocolError("neuron_training_encoding_mismatch", "The reviewed batches differ from the exact native supervised encoding.");
  return value;
}
