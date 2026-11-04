import { z } from "zod";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().trim().min(1).max(500);
export const ENGRAM_ADAPTER_MAX_BYTES = 2_147_483_648;

/** Independent implementation of arXiv:2608.29327v1, section 3 and appendix B.
 * Explicit boundary, initialization and history choices identify this runtime;
 * the paper's reported retention is not a guarantee for a trained module. */
export const EngramAdapterConfigSchema = z.object({
  schemaVersion: z.literal("openpond.engramAdapterConfig.v1"),
  implementation: z.literal("openpond_qwen_engram_paper_v1"),
  hook: z.literal("self_attn.input"),
  injectLayers: z.tuple([z.literal(1), z.literal(3), z.literal(7), z.literal(15)]),
  suffixOrders: z.tuple([z.literal(2), z.literal(3)]),
  previousOrders: z.tuple([z.literal(3)]),
  numHashes: z.literal(4), tableSize: z.literal(90_007),
  perHashDim: z.union([z.literal(128), z.literal(256)]),
  alpha: z.literal(0.2), memoryInitStd: z.literal(0.02),
  adapterDtype: z.literal("float32"), projectionInit: z.literal("zeros"),
  gateInit: z.literal("zeros_no_bias"), boundary: z.literal("incomplete_group_off_v1"),
  occupancy: z.literal("training_before_lookup_v1"),
  history: z.literal("request_absolute_positions_v1"), batchSize: z.literal(1),
}).strict();
export type EngramAdapterConfig = z.infer<typeof EngramAdapterConfigSchema>;

export const EngramTrainingSettingsSchema = z.object({
  learningRate: z.number().finite().positive().max(0.001),
  weightDecay: z.number().finite().min(0).max(0.1),
  maxSteps: z.number().int().min(1).max(128),
  gradientAccumulationSteps: z.number().int().min(1).max(32),
  maxSequenceLength: z.number().int().min(2).max(8192),
  seed: z.number().int().min(0).max(2_147_483_647),
  maxDurationSeconds: z.number().finite().min(1).max(21_600),
  maxCheckpointBytes: z.number().int().positive().max(ENGRAM_ADAPTER_MAX_BYTES),
}).strict();
export type EngramTrainingSettings = z.infer<typeof EngramTrainingSettingsSchema>;
export const EngramTrainingDataSchema = z.object({
  batch: ModelProjectVersionedRefSchema, examplesSha256: Hash, encodingHash: Hash,
}).strict();
export const EngramArtifactReferenceSchema = z.object({ id: Id, contentHash: Hash }).strict();
export const EngramTrainingRequestSchema = z.object({
  schemaVersion: z.literal("openpond.engramTrainingRequest.v1"),
  model: NeuronSteeringModelSchema,
  data: EngramTrainingDataSchema,
  config: EngramAdapterConfigSchema,
  training: EngramTrainingSettingsSchema,
  parentArtifact: EngramArtifactReferenceSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.model.intermediateSizes.length <= 15 || value.model.dtype !== "bfloat16")
    context.addIssue({code: "custom", path: ["model"], message: "This Engram implementation requires the exact compatible BF16 dense base."});
});
export type EngramTrainingRequest = z.infer<typeof EngramTrainingRequestSchema>;

export const EngramSupervisedEncodingSchema = z.object({
  schemaVersion: z.literal("openpond.engramSupervisedEncoding.v1"),
  implementation: z.literal("supervised_trainer.prepare_example.v1"),
  modelHash: Hash, tokenizerHash: Hash,
  maxSequenceLength: z.number().int().min(2).max(8192),
  completionOnly: z.literal(true), enableThinking: z.literal(false),
  truncation: z.literal("left_prompt_preserve_final_target_v1"),
}).strict();

/** Declares the exact existing supervised encoder. This is not a claim that
 * the caller measured tokenization or inspected private Dataset examples. */
export async function engramSupervisedEncoding(model: z.infer<typeof NeuronSteeringModelSchema>, maxSequenceLength: number) {
  return EngramSupervisedEncodingSchema.parse({
    schemaVersion: "openpond.engramSupervisedEncoding.v1",
    implementation: "supervised_trainer.prepare_example.v1",
    modelHash: await canonicalSha256(NeuronSteeringModelSchema.parse(model)),
    tokenizerHash: model.tokenizerHash, maxSequenceLength,
    completionOnly: true, enableThinking: false,
    truncation: "left_prompt_preserve_final_target_v1",
  });
}
export async function parseAndVerifyEngramTrainingRequest(raw: unknown) {
  const request = EngramTrainingRequestSchema.parse(raw);
  if (request.data.encodingHash !== await canonicalSha256(await engramSupervisedEncoding(request.model, request.training.maxSequenceLength)))
    throw new OpenPondProtocolError("engram_encoding_mismatch", "The Engram request differs from its exact supervised encoder.");
  return request;
}

export const EngramArtifactPinsSchema = z.object({
  baseModel: NeuronSteeringModelSchema,
  adapterConfigHash: Hash, recipeHash: Hash, dataHash: Hash,
  data: EngramTrainingDataSchema, runtimeHash: Hash,
  parentArtifactHash: Hash.nullable(),
}).strict();
export const EngramAdapterTensorSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
  shape: z.array(z.number().int().positive().max(10_000_000)).min(1).max(2),
  dtype: z.enum(["F32", "BOOL"]),
}).strict();
export const EngramAdapterArtifactContentSchema = z.object({
  schemaVersion: z.literal("openpond.engramAdapterArtifact.v1"),
  method: z.literal("engram_adapter"), config: EngramAdapterConfigSchema,
  pins: EngramArtifactPinsSchema,
  payload: z.object({
    path: z.literal("adapter.safetensors"), sha256: Hash,
    sizeBytes: z.number().int().positive().max(ENGRAM_ADAPTER_MAX_BYTES),
    tensors: z.array(EngramAdapterTensorSchema).min(1).max(100),
  }).strict(),
}).strict();
export const EngramAdapterArtifactSchema = EngramAdapterArtifactContentSchema.extend({contentHash: Hash});
export type EngramAdapterArtifact = z.infer<typeof EngramAdapterArtifactSchema>;

export function engramAdapterTensorInventory(config: EngramAdapterConfig, hiddenSize: number) {
  const parsed = EngramAdapterConfigSchema.parse(config);
  const hidden = z.number().int().positive().max(1_000_000).parse(hiddenSize);
  const items: z.infer<typeof EngramAdapterTensorSchema>[] = [];
  for (const group of ["suffix2", "suffix3", "previous3"]) {
    for (let head = 0; head < parsed.numHashes; head++) {
      items.push({name: `shared.embeddings.${group}.${head}.weight`, dtype: "F32", shape: [parsed.tableSize, parsed.perHashDim]});
      items.push({name: `shared.occupancy.${group}.h${head}`, dtype: "BOOL", shape: [parsed.tableSize]});
    }
  }
  const memoryWidth = 3 * parsed.numHashes * parsed.perHashDim;
  for (const layer of parsed.injectLayers) {
    items.push({name: `layers.${layer}.projection.weight`, dtype: "F32", shape: [hidden, memoryWidth]});
    items.push({name: `layers.${layer}.gate_memory`, dtype: "F32", shape: [memoryWidth]});
    items.push({name: `layers.${layer}.gate_hidden`, dtype: "F32", shape: [hidden]});
  }
  return items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Metadata verification does not prove possession of the tensor bytes. The
 * artifact custodian must separately verify their size, digest and inventory. */
export async function parseAndVerifyEngramAdapterArtifact(raw: unknown, expected?: {
  request: EngramTrainingRequest; runtimeHash: string;
}) {
  const value = EngramAdapterArtifactSchema.parse(raw), {contentHash, ...content} = value;
  const fail = (): never => {throw new OpenPondProtocolError("engram_artifact_mismatch", "The Engram module differs from its exact configuration, data or parent.");};
  if (contentHash !== await canonicalSha256(content)
    || value.pins.adapterConfigHash !== await canonicalSha256(value.config)
    || value.pins.dataHash !== await canonicalSha256(value.pins.data)
    || new Set(value.payload.tensors.map(row => row.name)).size !== value.payload.tensors.length
    || canonicalJson([...value.payload.tensors].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      !== canonicalJson(engramAdapterTensorInventory(value.config, value.pins.baseModel.hiddenSize))) fail();
  if (expected) {
    const request = await parseAndVerifyEngramTrainingRequest(expected.request);
    if (canonicalJson(value.config) !== canonicalJson(request.config)
      || canonicalJson(value.pins.baseModel) !== canonicalJson(request.model)
      || canonicalJson(value.pins.data) !== canonicalJson(request.data)
      || value.pins.recipeHash !== await canonicalSha256(request.training)
      || value.pins.runtimeHash !== expected.runtimeHash
      || value.pins.parentArtifactHash !== (request.parentArtifact?.contentHash ?? null)
      || value.payload.sizeBytes > request.training.maxCheckpointBytes) fail();
  }
  return value;
}

export const EngramModuleFileSchema = z.object({
  path: z.enum(["manifest.json", "adapter.safetensors"]),
  artifactId: Id, sha256: Hash,
  sizeBytes: z.number().int().positive().max(ENGRAM_ADAPTER_MAX_BYTES),
}).strict();
export const EngramTrainingResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.engramTrainingResult.v1"),
  inputHash: Hash, modelHash: Hash, runtimeHash: Hash, dataHash: Hash,
  preparedRowsHash: Hash,
  optimizerSteps: z.number().int().min(1).max(128),
  examplesProcessed: z.number().int().positive().max(4096),
  targetTokens: z.number().int().positive().max(33_554_432),
  forwardTokenWork: z.number().int().positive().max(100_000_000),
  durationMs: z.number().finite().nonnegative().max(21_600_000),
  meanLoss: z.number().finite().nonnegative(), finalLoss: z.number().finite().nonnegative(),
  baseWeightsHashBefore: Hash, baseWeightsHashAfter: Hash,
  baseOptimizerParameterCount: z.literal(0), baseGradientParameterCount: z.literal(0),
  artifact: z.object({
    id: Id, contentHash: Hash, manifest: EngramAdapterArtifactSchema,
    files: z.array(EngramModuleFileSchema).length(2),
  }).strict(),
}).strict();
export const EngramTrainingResultSchema = EngramTrainingResultContentSchema.extend({contentHash: Hash});
export type EngramTrainingResult = z.infer<typeof EngramTrainingResultSchema>;

/** Successful results require exact committed file custody as well as the
 * producer's training evidence. A manifest alone is not a trained Model. */
export async function parseAndVerifyEngramTrainingResult(raw: unknown, expected: {
  request: EngramTrainingRequest; runtimeHash: string;
}) {
  const request = await parseAndVerifyEngramTrainingRequest(expected.request);
  const value = EngramTrainingResultSchema.parse(raw), {contentHash, ...content} = value;
  const manifest = await parseAndVerifyEngramAdapterArtifact(value.artifact.manifest, expected);
  const tensor = value.artifact.files.find(file => file.path === "adapter.safetensors");
  const metadata = value.artifact.files.find(file => file.path === "manifest.json");
  if (contentHash !== await canonicalSha256(content)
    || value.inputHash !== await canonicalSha256(request)
    || value.modelHash !== await canonicalSha256(request.model)
    || value.dataHash !== await canonicalSha256(request.data)
    || value.runtimeHash !== expected.runtimeHash
    || value.optimizerSteps !== request.training.maxSteps
    || value.examplesProcessed !== value.optimizerSteps * request.training.gradientAccumulationSteps
    || value.targetTokens > value.forwardTokenWork
    || value.durationMs > request.training.maxDurationSeconds * 1000
    || value.baseWeightsHashBefore !== request.model.weightsHash
    || value.baseWeightsHashAfter !== value.baseWeightsHashBefore
    || value.artifact.contentHash !== manifest.contentHash
    || !tensor || !metadata || metadata.sizeBytes > 262_144
    || metadata.sha256 !== await canonicalSha256(manifest)
    || metadata.sizeBytes !== new TextEncoder().encode(canonicalJson(manifest)).byteLength
    || tensor.sha256 !== manifest.payload.sha256 || tensor.sizeBytes !== manifest.payload.sizeBytes
    || value.artifact.files.some(file => file.artifactId !== value.artifact.id)
    || value.artifact.files.reduce((total, file) => total + file.sizeBytes, 0) > request.training.maxCheckpointBytes)
    throw new OpenPondProtocolError("engram_training_result_mismatch", "The Engram training result differs from its exact run, frozen base or committed module.");
  return value;
}
