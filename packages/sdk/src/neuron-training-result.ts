import { z } from "zod";
import { NEURON_TRAINING_MAX_BYTES, parseAndVerifyNeuronTrainingRequest, type NeuronTrainingRequest } from "./neuron-training.js";
import { NeuronTrainingArtifactSchema, NeuronTrainingSelectionResultSchema, parseAndVerifyNeuronTrainingArtifact } from "./neuron-training-artifact.js";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/), Work = z.number().int().nonnegative().max(100_000_000);
export const NeuronTrainingWorkSchema = z.object({selectionTarget: Work, selectionBackground: Work, selectionGradient: Work,
  training: Work, preservationOriginal: Work, preservationEdited: Work, verification: Work}).strict();
export const NeuronTrainingResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronTrainingResult.v1"), inputHash: Hash, modelHash: Hash, runtimeHash: Hash, dataHash: Hash,
  preparedRowsHash: Hash, selection: NeuronTrainingSelectionResultSchema,
  optimizerSteps: z.number().int().min(1).max(128), examplesProcessed: z.number().int().min(1).max(4096),
  targetTokens: z.number().int().positive().max(33_554_432), preservationTokens: Work,
  work: NeuronTrainingWorkSchema, forwardTokenWork: Work, backwardTokenWork: Work,
  durationMs: z.number().finite().nonnegative().max(21_600_000), meanLoss: z.number().finite().nonnegative(), finalLoss: z.number().finite().nonnegative(),
  meanPreservationKl: z.number().finite().nonnegative().nullable(),
  baseWeightsHashBefore: Hash, baseWeightsHashAfter: Hash,
  baseOptimizerParameterCount: z.literal(0), baseGradientParameterCount: z.literal(0),
  trainableParameterCount: z.number().int().min(4097).max(524_416),
  artifact: z.object({id: z.string().min(1).max(500), contentHash: Hash, manifest: NeuronTrainingArtifactSchema,
    files: z.array(z.object({path: z.enum(["manifest.json", "patch.safetensors"]), artifactId: z.string().min(1).max(500),
      sha256: Hash, sizeBytes: z.number().int().positive().max(NEURON_TRAINING_MAX_BYTES)}).strict()).length(2)}).strict(),
}).strict();
export const NeuronTrainingResultSchema = NeuronTrainingResultContentSchema.extend({contentHash: Hash});
export type NeuronTrainingResult = z.infer<typeof NeuronTrainingResultSchema>;
export async function parseAndVerifyNeuronTrainingResult(raw: unknown, expected: {request: NeuronTrainingRequest; runtimeHash: string}) {
  assertBoundedTaskJson(raw, 1_048_576);
  const request = await parseAndVerifyNeuronTrainingRequest(expected.request);
  const value = NeuronTrainingResultSchema.parse(raw), {contentHash, ...content} = value;
  const manifest = await parseAndVerifyNeuronTrainingArtifact(value.artifact.manifest, {request, runtimeHash: expected.runtimeHash});
  const tensor = value.artifact.files.find(row => row.path === "patch.safetensors"), metadata = value.artifact.files.find(row => row.path === "manifest.json");
  if (contentHash !== await canonicalSha256(content) || value.inputHash !== await canonicalSha256(request)
    || value.modelHash !== await canonicalSha256(request.model) || value.dataHash !== await canonicalSha256(request.data)
    || value.runtimeHash !== expected.runtimeHash || value.preparedRowsHash !== value.selection.preparedRowsHash
    || canonicalJson(value.selection) !== canonicalJson(manifest.selection) || value.artifact.contentHash !== manifest.contentHash
    || value.baseWeightsHashBefore !== request.model.weightsHash || value.baseWeightsHashAfter !== value.baseWeightsHashBefore
    || value.trainableParameterCount !== request.selection.count * (request.model.hiddenSize + 1)
    || value.optimizerSteps !== request.training.maxSteps || value.examplesProcessed !== value.optimizerSteps * request.training.gradientAccumulationSteps
    || value.durationMs > request.training.maxDurationSeconds * 1000 || value.forwardTokenWork > request.training.maximumForwardTokenWork
    || value.forwardTokenWork !== Object.values(value.work).reduce((sum, work) => sum + work, 0)
    || value.backwardTokenWork !== value.work.selectionGradient + value.work.training + value.work.preservationEdited
    || value.targetTokens > value.work.training || value.work.selectionTarget <= 0 || value.work.selectionBackground <= 0
    || value.work.selectionGradient !== value.work.selectionTarget || value.work.verification <= 0
    || (request.training.preservationWeight > 0) !== (value.meanPreservationKl !== null)
    || value.work.preservationOriginal !== value.work.preservationEdited
    || request.training.preservationWeight === 0 && (value.preservationTokens !== 0 || value.work.preservationOriginal !== 0)
    || request.training.preservationWeight > 0 && (value.preservationTokens <= 0 || value.work.preservationOriginal <= 0)
    || !tensor || !metadata || tensor.sha256 !== manifest.payload.sha256 || tensor.sizeBytes !== manifest.payload.sizeBytes
    || metadata.sha256 !== await canonicalSha256(manifest) || metadata.sizeBytes !== new TextEncoder().encode(canonicalJson(manifest)).byteLength
    || value.artifact.files.some(row => row.artifactId !== value.artifact.id)
    || value.artifact.files.reduce((sum, row) => sum + row.sizeBytes, 0) > request.training.maxCheckpointBytes)
    throw new OpenPondProtocolError("neuron_training_result_mismatch", "The selective neuron result differs from its exact run, measured work, frozen base or committed learned patch.");
  return value;
}
