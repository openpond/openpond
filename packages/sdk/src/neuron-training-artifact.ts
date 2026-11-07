import { z } from "zod";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";
import { NeuronTrainingCoordinateSchema, NeuronTrainingDataSchema, NEURON_TRAINING_MAX_BYTES,
  NEURON_TRAINING_UPSTREAM_REVISION, parseAndVerifyNeuronTrainingRequest, type NeuronTrainingRequest } from "./neuron-training.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const NeuronTrainingAlgorithmSchema = z.object({
  implementation: z.literal("openpond_qwen3_selective_columns_v1"),
  upstream: z.literal("changjonathanc/neuron-tuning"), revision: z.literal(NEURON_TRAINING_UPSTREAM_REVISION), license: z.literal("Apache-2.0"),
  hook: z.literal("mlp.down_proj"), operation: z.literal("output_plus_selected_input_times_delta_v1"),
  parameterization: z.literal("column_gain_rms_direction_v1"), activityQuantile: z.literal(0.9),
  backgroundFloor: z.literal(0.000001), gradientSubsetSeed: z.literal(0),
  optimizer: z.literal("Adam"), betas: z.tuple([z.literal(0.9), z.literal(0.999)]), epsilon: z.literal(1e-8),
  weightDecay: z.literal(0), gradientClipNorm: z.literal(1), batchSize: z.literal(1),
  parameterDtype: z.literal("float32"), resume: z.literal("unsupported"),
}).strict();
export function neuronTrainingAlgorithm() {
  return NeuronTrainingAlgorithmSchema.parse({implementation: "openpond_qwen3_selective_columns_v1",
    upstream: "changjonathanc/neuron-tuning", revision: NEURON_TRAINING_UPSTREAM_REVISION, license: "Apache-2.0",
    hook: "mlp.down_proj", operation: "output_plus_selected_input_times_delta_v1", parameterization: "column_gain_rms_direction_v1",
    activityQuantile: 0.9, backgroundFloor: 0.000001, gradientSubsetSeed: 0,
    optimizer: "Adam", betas: [0.9, 0.999], epsilon: 1e-8, weightDecay: 0, gradientClipNorm: 1,
    batchSize: 1, parameterDtype: "float32", resume: "unsupported"});
}
export const NeuronTrainingSelectionEntrySchema = NeuronTrainingCoordinateSchema.extend({
  targetMeanAbsolute: z.number().finite().positive(), backgroundMeanAbsolute: z.number().finite().nonnegative(),
  backgroundTargetRatio: z.number().finite().nonnegative(), gradientNorm: z.number().finite().nonnegative(),
  score: z.number().finite().nonnegative(), targetActivityThreshold: z.number().finite().nonnegative(),
  backgroundByDomain: z.array(z.object({domainIndex: z.number().int().min(0).max(7), meanAbsolute: z.number().finite().nonnegative()}).strict()).min(1).max(8),
}).strict();
export const NeuronTrainingSelectionResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronTrainingSelectionResult.v1"), modelHash: Hash, dataHash: Hash, selectionConfigHash: Hash,
  preparedRowsHash: Hash, source: z.enum(["automatic", "explicit"]),
  targetExampleIds: z.array(z.string().min(1).max(200)).min(1).max(64),
  eligibleCount: z.number().int().min(1).max(442_368),
  entries: z.array(NeuronTrainingSelectionEntrySchema).min(1).max(128),
}).strict();
export const NeuronTrainingSelectionResultSchema = NeuronTrainingSelectionResultContentSchema.extend({contentHash: Hash});
export type NeuronTrainingSelectionResult = z.infer<typeof NeuronTrainingSelectionResultSchema>;
function fail(): never { throw new OpenPondProtocolError("neuron_training_artifact_mismatch", "The learned patch differs from its exact base, verified selection, data, settings or tensor inventory."); }
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
export async function parseAndVerifyNeuronTrainingSelection(raw: unknown, request: NeuronTrainingRequest) {
  const value = NeuronTrainingSelectionResultSchema.parse(raw), {contentHash, ...content} = value;
  const coordinates = value.entries.map(({layer, neuron}) => ({layer, neuron}));
  if (contentHash !== await canonicalSha256(content) || value.modelHash !== await canonicalSha256(request.model)
    || (request.parentArtifact ? value.contentHash !== request.parentArtifact.selectionHash
      : value.dataHash !== await canonicalSha256(request.data)) || value.selectionConfigHash !== await canonicalSha256(request.selection)
    || value.entries.length !== request.selection.count || value.eligibleCount < value.entries.length
    || new Set(value.entries.map(row => `${row.layer}:${row.neuron}`)).size !== value.entries.length
    || new Set(value.targetExampleIds).size !== value.targetExampleIds.length || value.targetExampleIds.length > request.selection.gradientExamples
    || value.source !== (request.selection.explicitCoordinates ? "explicit" : "automatic")
    || request.selection.explicitCoordinates && canonicalJson(coordinates) !== canonicalJson(request.selection.explicitCoordinates)) fail();
  if (value.source === "automatic" && value.entries.some((row, index) => {
    const previous = value.entries[index - 1];
    return previous && (row.score > previous.score || row.score === previous.score
      && (row.layer < previous.layer || row.layer === previous.layer && row.neuron < previous.neuron));
  })) fail();
  for (const row of value.entries) {
    if (row.targetMeanAbsolute < row.targetActivityThreshold
      || row.backgroundTargetRatio > request.selection.maximumBackgroundTargetRatio + 1e-6
      || !close(row.backgroundTargetRatio, row.backgroundMeanAbsolute / row.targetMeanAbsolute)
      || !close(row.score, row.gradientNorm / Math.max(row.backgroundMeanAbsolute, 0.000001))
      || canonicalJson(row.backgroundByDomain.map(item => item.domainIndex)) !== canonicalJson(Array.from({length:
        request.parentArtifact ? value.entries[0]!.backgroundByDomain.length : request.data.background.length}, (_item, index) => index))) fail();
    const background = request.selection.backgroundStatistic === "max_domains"
      ? Math.max(...row.backgroundByDomain.map(item => item.meanAbsolute))
      : row.backgroundByDomain.reduce((sum, item) => sum + item.meanAbsolute, 0) / row.backgroundByDomain.length;
    if (!close(background, row.backgroundMeanAbsolute)) fail();
  }
  return value;
}
export const NeuronTrainingPatchTensorSchema = z.object({
  name: z.string().regex(/^layer(?:[0-9]|[12][0-9]|3[0-5])\.(?:indices|delta)$/),
  dtype: z.enum(["I64", "F32"]), shape: z.array(z.number().int().positive().max(4096)).min(1).max(2),
}).strict();
export function neuronTrainingPatchTensorInventory(selection: NeuronTrainingSelectionResult) {
  const layers = new Map<number, number>();
  for (const entry of NeuronTrainingSelectionResultSchema.parse(selection).entries) layers.set(entry.layer, (layers.get(entry.layer) ?? 0) + 1);
  return [...layers].flatMap(([layer, count]) => [
    {name: `layer${layer}.indices`, dtype: "I64" as const, shape: [count]},
    {name: `layer${layer}.delta`, dtype: "F32" as const, shape: [4096, count]},
  ]).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export const NeuronTrainingArtifactContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronTrainingArtifact.v1"), method: z.literal("selective_neuron_training"),
  algorithm: NeuronTrainingAlgorithmSchema,
  pins: z.object({baseModel: NeuronSteeringModelSchema, inputHash: Hash, data: NeuronTrainingDataSchema, dataHash: Hash,
    selectionConfigHash: Hash, trainingConfigHash: Hash, runtimeHash: Hash, parentArtifactHash: Hash.nullable()}).strict(),
  selection: NeuronTrainingSelectionResultSchema,
  continuation: z.object({
    mode: z.literal("frozen_parent_fresh_residual_adam_v1"),
    selectionProvenance: z.literal("inherited_parent_observations"),
    parameterAnchor: z.literal("original_dense_base_columns_v1"),
    parentArtifactHash: Hash, parentSelectionHash: Hash, parentPayloadSha256: Hash,
    parentPatchStateSha256: Hash, initialPatchStateSha256: Hash, finalPatchStateSha256: Hash,
    installedBeforeOptimizer: z.literal(true), optimizerState: z.literal("fresh"),
  }).strict().optional(),
  payload: z.object({path: z.literal("patch.safetensors"), sha256: Hash,
    sizeBytes: z.number().int().positive().max(NEURON_TRAINING_MAX_BYTES),
    tensors: z.array(NeuronTrainingPatchTensorSchema).min(2).max(72)}).strict(),
}).strict();
export const NeuronTrainingArtifactSchema = NeuronTrainingArtifactContentSchema.extend({contentHash: Hash});
export type NeuronTrainingArtifact = z.infer<typeof NeuronTrainingArtifactSchema>;
export async function parseAndVerifyNeuronTrainingArtifact(raw: unknown, expected: {request: NeuronTrainingRequest; runtimeHash: string}) {
  assertBoundedTaskJson(raw, 262_144);
  const value = NeuronTrainingArtifactSchema.parse(raw), {contentHash, ...content} = value;
  const request = await parseAndVerifyNeuronTrainingRequest(expected.request);
  await parseAndVerifyNeuronTrainingSelection(value.selection, request);
  if (contentHash !== await canonicalSha256(content) || canonicalJson(value.pins.baseModel) !== canonicalJson(request.model)
    || canonicalJson(value.pins.data) !== canonicalJson(request.data) || value.pins.inputHash !== await canonicalSha256(request)
    || value.pins.dataHash !== await canonicalSha256(request.data) || value.pins.selectionConfigHash !== await canonicalSha256(request.selection)
    || value.pins.trainingConfigHash !== await canonicalSha256(request.training) || value.pins.runtimeHash !== expected.runtimeHash
    || value.pins.parentArtifactHash !== (request.parentArtifact?.contentHash ?? null)
    || canonicalJson(value.payload.tensors) !== canonicalJson(neuronTrainingPatchTensorInventory(value.selection))
    || value.payload.sizeBytes > request.training.maxCheckpointBytes) fail();
  const continuation = value.continuation, parent = request.parentArtifact;
  if (parent ? !continuation || continuation.parentArtifactHash !== parent.contentHash
    || continuation.parentSelectionHash !== parent.selectionHash || continuation.parentPayloadSha256 !== parent.payloadSha256
    || continuation.parentPatchStateSha256 !== continuation.initialPatchStateSha256
    || continuation.finalPatchStateSha256 === continuation.initialPatchStateSha256 : continuation !== undefined) fail();
  return value;
}
