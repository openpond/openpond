import { z } from "zod";
import { AlphaEditArtifactReferenceSchema, AlphaEditConfigSchema, AlphaEditDataSchema, AlphaEditHashSchema as Hash,
  AlphaEditModelSchema, AlphaEditTrainingRequestSchema,
  type AlphaEditConfig, type AlphaEditTrainingRequest } from "./alphaedit.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

export const AlphaEditTensorSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.]{1,200}$/),
  shape: z.array(z.number().int().positive().max(1_000_000)).length(2), dtype: z.enum(["BF16", "F32"]),
}).strict();
export const ALPHAEDIT_MAX_FILE_BYTES = 2_147_483_648;
export const AlphaEditStateFilePathSchema = z.string().regex(/^state-(?:[0-9]|[12][0-9]|3[0-5])\.safetensors$/);
const Payload = z.object({sha256: Hash, sizeBytes: z.number().int().positive().max(ALPHAEDIT_MAX_FILE_BYTES),
  tensors: z.array(AlphaEditTensorSchema).min(1).max(24)}).strict();

export function alphaEditTensorInventory(config: AlphaEditConfig) {
  const parsed = AlphaEditConfigSchema.parse(config);
  return {
    patch: parsed.layers.map(layer => ({name: `layers.${layer}.mlp.down_proj.weight`, shape: [4096, 12288], dtype: "BF16" as const})),
    state: parsed.layers.flatMap(layer => ["covariance", "projector", "cache_c"].map(name => ({
      name: `layers.${layer}.${name}`, shape: [12288, 12288], dtype: "F32" as const,
    }))),
  };
}
/** Uncompressed tensors plus bounded safetensors headers and canonical manifest.
 * This is a storage bound; it is not a GPU-memory or monetary estimate. */
export function alphaEditMinimumCheckpointBytes(config: AlphaEditConfig) {
  const layers = AlphaEditConfigSchema.parse(config).layers.length;
  return layers * (4096 * 12288 * 2 + 3 * 12288 * 12288 * 4) + (layers + 1) * (65_536 + 8) + 262_144;
}
export const AlphaEditArtifactContentSchema = z.object({
  schemaVersion: z.literal("openpond.alphaEditArtifact.v1"), method: z.literal("alphaedit"),
  config: AlphaEditConfigSchema,
  pins: z.object({baseModel: AlphaEditModelSchema, configHash: Hash, recipeHash: Hash, dataHash: Hash,
    data: AlphaEditDataSchema, runtimeHash: Hash, parentArtifactHash: Hash.nullable(),
    preservationModelHash: Hash,
  }).strict(),
  representation: z.literal("exact_replacement_bf16_down_proj_matrices_v1"),
  payloads: z.object({patch: Payload.extend({path: z.literal("patch.safetensors")}),
    state: z.array(Payload.extend({path: AlphaEditStateFilePathSchema})).min(1).max(8)}).strict(),
}).strict();
export const AlphaEditArtifactSchema = AlphaEditArtifactContentSchema.extend({contentHash: Hash});
export type AlphaEditArtifact = z.infer<typeof AlphaEditArtifactSchema>;
const order = (items: z.infer<typeof AlphaEditTensorSchema>[]) => [...items].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
export async function parseAndVerifyAlphaEditArtifact(raw: unknown, expected?: {request: AlphaEditTrainingRequest; runtimeHash: string}) {
  const value = AlphaEditArtifactSchema.parse(raw), {contentHash, ...content} = value;
  const inventory = alphaEditTensorInventory(value.config);
  const fail = (): never => {throw new OpenPondProtocolError("alphaedit_artifact_mismatch", "The AlphaEdit matrix patch differs from its exact model, state or input.");};
  if (contentHash !== await canonicalSha256(content)
    || value.pins.configHash !== await canonicalSha256(value.config)
    || value.pins.dataHash !== await canonicalSha256(value.pins.data)
    || value.pins.preservationModelHash !== await canonicalSha256(value.pins.baseModel)
    || value.payloads.patch.sizeBytes < value.config.layers.length * 4096 * 12288 * 2
    || value.payloads.state.length !== value.config.layers.length
    || canonicalJson(order(value.payloads.patch.tensors)) !== canonicalJson(order(inventory.patch))
    || value.payloads.state.some((payload, index) => payload.path !== `state-${value.config.layers[index]}.safetensors`
      || payload.sizeBytes < 3 * 12288 * 12288 * 4
      || canonicalJson(order(payload.tensors)) !== canonicalJson(order(inventory.state.filter(tensor => tensor.name.startsWith(`layers.${value.config.layers[index]}.`)))))) fail();
  if (expected) {
    const request = AlphaEditTrainingRequestSchema.parse(expected.request);
    if (canonicalJson(value.pins.baseModel) !== canonicalJson(request.model)
      || canonicalJson(value.config) !== canonicalJson(request.config)
      || canonicalJson(value.pins.data) !== canonicalJson(request.data)
      || value.pins.recipeHash !== await canonicalSha256(request.training)
      || value.pins.runtimeHash !== expected.runtimeHash
      || value.pins.parentArtifactHash !== (request.parentArtifact?.contentHash ?? null)
      || value.payloads.patch.sizeBytes + value.payloads.state.reduce((sum, payload) => sum + payload.sizeBytes, 0) > request.training.maxCheckpointBytes) fail();
  }
  return value;
}

export const AlphaEditModuleFileSchema = z.object({path: z.union([z.enum(["manifest.json", "patch.safetensors"]), AlphaEditStateFilePathSchema]),
  artifactId: z.string().min(1).max(500), sha256: Hash, sizeBytes: z.number().int().positive().max(ALPHAEDIT_MAX_FILE_BYTES)}).strict();
/** Actual final-head teacher-forced outcomes on the same reviewed inputs.
 * These are separate from latent objectives and are not held-out quality. */
export const AlphaEditComparisonsSchema = z.object({
  schemaVersion: z.literal("openpond.alphaEditComparisons.v1"),
  startingState: z.enum(["base", "parent"]), vocabularySize: z.number().int().min(1).max(262_144),
  edits: z.array(z.object({id: z.string().min(1).max(500), contextCount: z.number().int().min(1).max(32),
    targetTokens: z.number().int().min(1).max(32 * 8191),
    beforeMeanTargetNll: z.number().finite().nonnegative(), afterMeanTargetNll: z.number().finite().nonnegative(),
    reloadedMeanTargetNll: z.number().finite().nonnegative(),
  }).strict()).min(1).max(64),
  /** Full-vocabulary KL(final edited || starting) at each literal preservation
   * text's final non-padding position; every reviewed row is included. */
  preservation: z.object({examples: z.number().int().min(1).max(4096), comparedPositions: z.number().int().min(1).max(4096),
    meanNextTokenKl: z.number().finite().nonnegative(), maximumNextTokenKl: z.number().finite().nonnegative(),
  }).strict(),
  reload: z.object({reference: z.literal("final_edited_model"),
    comparedTargetTokens: z.number().int().min(1).max(64 * 32 * 8191),
    comparedPreservationPositions: z.number().int().min(1).max(4096),
    /** KL(reloaded || final), not KL to the original unedited state. */
    meanNextTokenKl: z.number().finite().nonnegative(), maximumNextTokenKl: z.number().finite().nonnegative(),
    maximumAbsoluteTargetNllDifference: z.number().finite().nonnegative(),
    maximumAbsoluteLogProbabilityDifference: z.number().finite().nonnegative(),
    absoluteTolerance: z.literal(1e-5), equivalent: z.boolean(),
    baseWeightsHash: Hash, editedWeightsHash: Hash, untouchedWeightsHash: Hash,
  }).strict(),
}).strict();
export type AlphaEditComparisons = z.infer<typeof AlphaEditComparisonsSchema>;

export const AlphaEditTrainingResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.alphaEditTrainingResult.v1"), inputHash: Hash, modelHash: Hash, runtimeHash: Hash, dataHash: Hash,
  preparedRowsHash: Hash, editsProcessed: z.number().int().min(1).max(64),
  latentOptimizerSteps: z.number().int().min(0).max(8192),
  forwardTokenWork: z.number().int().positive().max(100_000_000),
  durationMs: z.number().finite().nonnegative().max(21_600_000),
  comparisons: AlphaEditComparisonsSchema,
  targetLosses: z.array(z.object({id: z.string().min(1).max(500), initial: z.number().finite().nonnegative(), final: z.number().finite().nonnegative(),
    optimizerSteps: z.number().int().min(0).max(128)}).strict()).min(1).max(64),
  untouchedWeightsHashBefore: Hash, untouchedWeightsHashAfter: Hash,
  editedWeightsHashBefore: Hash, editedWeightsHashAfter: Hash,
  baseOptimizerParameterCount: z.literal(0), baseGradientParameterCount: z.literal(0),
  layerEvidence: z.array(z.object({layer: z.number().int().min(0).max(35), preservationTokens: z.number().int().positive(),
    nullspaceRank: z.number().int().min(0).max(12288), updateFrobeniusNorm: z.number().finite().nonnegative(),
    solveRelativeResidual: z.number().finite().nonnegative().max(0.01),
    sequentialKeyCount: z.number().int().min(1).max(64),
  }).strict()).min(1).max(8),
  artifact: AlphaEditArtifactReferenceSchema.extend({manifest: AlphaEditArtifactSchema, files: z.array(AlphaEditModuleFileSchema).min(3).max(10)}),
}).strict();
export const AlphaEditTrainingResultSchema = AlphaEditTrainingResultContentSchema.extend({contentHash: Hash});
export type AlphaEditTrainingResult = z.infer<typeof AlphaEditTrainingResultSchema>;
export async function parseAndVerifyAlphaEditTrainingResult(raw: unknown, expected: {request: AlphaEditTrainingRequest; runtimeHash: string}) {
  const request = AlphaEditTrainingRequestSchema.parse(expected.request);
  const value = AlphaEditTrainingResultSchema.parse(raw), {contentHash, ...content} = value;
  const manifest = await parseAndVerifyAlphaEditArtifact(value.artifact.manifest, expected);
  const metadata = value.artifact.files.find(file => file.path === "manifest.json");
  const patch = value.artifact.files.find(file => file.path === "patch.safetensors");
  const payloads = [manifest.payloads.patch, ...manifest.payloads.state];
  const comparison = value.comparisons, reload = comparison.reload;
  const contextCount = request.config.contextTemplateGroups.reduce((sum, group) => sum + group.length, 0);
  const equivalent = reload.baseWeightsHash === request.model.weightsHash
    && reload.editedWeightsHash === value.editedWeightsHashAfter
    && reload.untouchedWeightsHash === value.untouchedWeightsHashAfter
    && reload.maximumAbsoluteTargetNllDifference <= reload.absoluteTolerance
    && reload.maximumAbsoluteLogProbabilityDifference <= reload.absoluteTolerance
    && reload.maximumNextTokenKl <= reload.absoluteTolerance;
  if (contentHash !== await canonicalSha256(content) || value.inputHash !== await canonicalSha256(request)
    || value.modelHash !== await canonicalSha256(request.model) || value.runtimeHash !== expected.runtimeHash
    || value.dataHash !== await canonicalSha256(request.data)
    || value.untouchedWeightsHashBefore !== value.untouchedWeightsHashAfter
    || value.targetLosses.length !== value.editsProcessed || new Set(value.targetLosses.map(row => row.id)).size !== value.editsProcessed
    || value.latentOptimizerSteps !== value.targetLosses.reduce((sum, row) => sum + row.optimizerSteps, 0)
    || value.targetLosses.some(row => row.optimizerSteps > request.training.maxSteps)
    || comparison.startingState !== (request.parentArtifact ? "parent" : "base")
    || comparison.edits.length !== value.editsProcessed
    || canonicalJson(comparison.edits.map(row => row.id)) !== canonicalJson(value.targetLosses.map(row => row.id))
    || comparison.edits.some(row => row.contextCount !== contextCount || row.targetTokens % contextCount !== 0
      || row.targetTokens > contextCount * (request.training.maxSequenceLength - 1)
      || Math.abs(row.afterMeanTargetNll - row.reloadedMeanTargetNll) > reload.maximumAbsoluteTargetNllDifference + 1e-12)
    || comparison.preservation.examples !== comparison.preservation.comparedPositions
    || comparison.preservation.meanNextTokenKl > comparison.preservation.maximumNextTokenKl + 1e-12
    || reload.comparedTargetTokens !== comparison.edits.reduce((sum, row) => sum + row.targetTokens, 0)
    || reload.comparedPreservationPositions !== comparison.preservation.comparedPositions
    || reload.meanNextTokenKl > reload.maximumNextTokenKl + 1e-12
    || reload.equivalent !== equivalent
    || value.forwardTokenWork < 3 * (reload.comparedTargetTokens + reload.comparedPreservationPositions)
    || value.forwardTokenWork > request.training.maxForwardTokenWork || value.durationMs > request.training.maxDurationSeconds * 1000
    || canonicalJson(value.layerEvidence.map(row => row.layer)) !== canonicalJson(request.config.layers)
    || value.layerEvidence.some(row => row.sequentialKeyCount !== value.editsProcessed)
    || value.artifact.contentHash !== manifest.contentHash || !metadata || !patch
    || value.artifact.files.length !== request.config.layers.length + 2
    || new Set(value.artifact.files.map(file => file.path)).size !== value.artifact.files.length
    || metadata.sha256 !== await canonicalSha256(manifest) || metadata.sizeBytes !== new TextEncoder().encode(canonicalJson(manifest)).byteLength
    || metadata.sizeBytes > 262_144
    || patch.sha256 !== manifest.payloads.patch.sha256 || patch.sizeBytes !== manifest.payloads.patch.sizeBytes
    || payloads.some(payload => !value.artifact.files.some(file => file.path === payload.path
      && file.sha256 === payload.sha256 && file.sizeBytes === payload.sizeBytes))
    || value.artifact.files.some(file => file.artifactId !== value.artifact.id)
    || value.artifact.files.reduce((sum, file) => sum + file.sizeBytes, 0) > request.training.maxCheckpointBytes)
    throw new OpenPondProtocolError("alphaedit_result_mismatch", "The AlphaEdit result differs from its matrix patch, observed work or committed custody.");
  return value;
}
