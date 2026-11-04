import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { parseAndVerifyAlphaEditModelVersion, parseAndVerifyNeuronTrainingModelVersion,
  type AlphaEditModelVersion, type NeuronTrainingModelVersion } from "./weight-model-versions.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SavedWeightModelSelectionSchema = z.object({modelProjectId: Id, versionHash: Hash}).strict();
export const ResolvedWeightModelSelectionSchema = z.object({
  schemaVersion: z.literal("openpond.resolvedWeightModelSelection.v1"),
  method: z.enum(["alphaedit", "selective_neuron_training"]), savedModel: SavedWeightModelSelectionSchema,
  artifact: z.object({id: Id, contentHash: Hash, manifestSha256: Hash}).strict(), modelHash: Hash,
}).strict();
export type ResolvedWeightModelSelection = z.infer<typeof ResolvedWeightModelSelectionSchema>;

/** A saved weight Model always selects its installed patch. Off/baseline
 * comparison is a separate exact source, never an implicit base substitution. */
export async function parseAndVerifyResolvedWeightModelSelection(raw: unknown, input: AlphaEditModelVersion | NeuronTrainingModelVersion) {
  const value = ResolvedWeightModelSelectionSchema.parse(raw);
  const version = input.schemaVersion === "openpond.alphaEditModelVersion.v1"
    ? await parseAndVerifyAlphaEditModelVersion(input) : await parseAndVerifyNeuronTrainingModelVersion(input);
  const method = version.schemaVersion === "openpond.alphaEditModelVersion.v1" ? "alphaedit" : "selective_neuron_training";
  if (value.method !== method || value.savedModel.modelProjectId !== version.modelProjectId
    || value.savedModel.versionHash !== version.contentHash || value.artifact.id !== version.artifact.id
    || value.artifact.contentHash !== version.artifact.contentHash
    || value.artifact.manifestSha256 !== await canonicalSha256(version.artifact.manifest)
    || value.modelHash !== await canonicalSha256(version.request.model))
    throw new OpenPondProtocolError("weight_model_selection_mismatch", "The admitted Model differs from its exact learned patch and base.");
  return value;
}
export const WeightModelInferenceReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.weightModelInferenceReceipt.v1"),
  teamId: Id, requestId: Id, requestHash: Hash, selection: ResolvedWeightModelSelectionSchema,
  poolId: Id, routingBinding: z.object({id: Id, revision: z.number().int().positive()}).strict(),
  runtimeHash: Hash, workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  engineGeneration: z.number().int().positive(), cacheNamespace: Hash, completedAt: z.iso.datetime(),
}).strict();
export const WeightModelInferenceReceiptSchema = WeightModelInferenceReceiptContentSchema.extend({contentHash: Hash});
export type WeightModelInferenceReceipt = z.infer<typeof WeightModelInferenceReceiptSchema>;
export async function parseAndVerifyWeightModelInferenceReceipt(raw: unknown, expected: {
  teamId: string; requestId: string; requestHash: string; selection: ResolvedWeightModelSelection;
  version: AlphaEditModelVersion | NeuronTrainingModelVersion; poolId: string;
  routingBinding: {id: string; revision: number}; runtimeHash: string; workerImageDigest: string;
  engineGeneration: number; cacheNamespace: string;
}) {
  const value = WeightModelInferenceReceiptSchema.parse(raw), {contentHash, ...content} = value;
  await parseAndVerifyResolvedWeightModelSelection(value.selection, expected.version);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId
    || value.requestId !== expected.requestId || value.requestHash !== expected.requestHash
    || canonicalJson(value.selection) !== canonicalJson(expected.selection) || value.poolId !== expected.poolId
    || canonicalJson(value.routingBinding) !== canonicalJson(expected.routingBinding)
    || value.runtimeHash !== expected.runtimeHash || value.workerImageDigest !== expected.workerImageDigest
    || value.engineGeneration !== expected.engineGeneration || value.cacheNamespace !== expected.cacheNamespace)
    throw new OpenPondProtocolError("weight_model_inference_mismatch", "The completed inference differs from its admitted Model, runtime or cache.");
  return value;
}
