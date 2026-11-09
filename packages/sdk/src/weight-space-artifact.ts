import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { WEIGHT_SPACE_MAX_PATCH_BYTES, WeightSpaceColumnsSchema, WeightSpaceHashSchema as Hash,
  WeightSpaceIdSchema as Id, WeightSpaceModelSchema, WeightSpaceRequestSchema, type WeightSpaceRequest } from "./weight-space-programming.js";

export const WeightSpacePatchTensorSchema = z.object({
  name: z.string().regex(/^layer(?:[0-9]|[12][0-9]|3[0-5])\.(?:indices|replacement)$/),
  dtype: z.enum(["I64", "BF16"]), shape: z.array(z.number().int().positive().max(4096)).min(1).max(2),
}).strict();
export function weightSpacePatchTensorInventory(columns: z.infer<typeof WeightSpaceColumnsSchema>[]) {
  return columns.flatMap(row => [
    { name: `layer${row.layer}.indices`, dtype: "I64" as const, shape: [row.columns.length] },
    { name: `layer${row.layer}.replacement`, dtype: "BF16" as const, shape: [4096, row.columns.length] },
  ]).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export const WeightSpaceArtifactContentSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceArtifact.v1"), method: z.literal("weight_space_programming"),
  representation: z.literal("exact_bf16_mlp_column_replacements_v1"),
  model: WeightSpaceModelSchema, requestHash: Hash, runtimeHash: Hash, candidateHash: Hash,
  teacher: WeightSpaceRequestSchema.shape.teacher, historyHash: Hash,
  columns: z.array(WeightSpaceColumnsSchema).min(1).max(36),
  columnHashes: z.array(Hash).min(1).max(36),
  payload: z.object({ path: z.literal("patch.safetensors"), sha256: Hash,
    sizeBytes: z.number().int().positive().max(WEIGHT_SPACE_MAX_PATCH_BYTES),
    tensors: z.array(WeightSpacePatchTensorSchema).min(2).max(72) }).strict(),
  reload: z.object({ effectiveColumnsHash: Hash, reloadedColumnsHash: Hash,
    untouchedWeightsHashBefore: Hash, untouchedWeightsHashAfter: Hash, equivalent: z.literal(true) }).strict(),
}).strict();
export const WeightSpaceArtifactSchema = WeightSpaceArtifactContentSchema.extend({ contentHash: Hash });
export type WeightSpaceArtifact = z.infer<typeof WeightSpaceArtifactSchema>;
export const WeightSpaceArtifactReferenceSchema = z.object({
  id: Id, contentHash: Hash, manifest: WeightSpaceArtifactSchema,
  files: z.array(z.object({ path: z.enum(["manifest.json", "patch.safetensors"]), artifactId: Id,
    sha256: Hash, sizeBytes: z.number().int().positive().max(WEIGHT_SPACE_MAX_PATCH_BYTES) }).strict()).length(2),
}).strict();

export async function parseAndVerifyWeightSpaceArtifact(raw: unknown, expected?: { request: WeightSpaceRequest; runtimeHash: string }) {
  const value = WeightSpaceArtifactSchema.parse(raw), { contentHash, ...content } = value;
  const count = value.columns.reduce((sum, row) => sum + row.columns.length, 0);
  const inventory = weightSpacePatchTensorInventory(value.columns);
  const candidateHash = await canonicalSha256({ schemaVersion: "openpond.weightSpaceCandidate.v1", model: value.model,
    columns: value.columns.map((row, index) => ({ ...row, sha256: value.columnHashes[index] })) });
  if (contentHash !== await canonicalSha256(content) || count > 128
    || value.columns.some((row, index) => index > 0 && row.layer <= value.columns[index - 1]!.layer)
    || value.columnHashes.length !== value.columns.length || value.candidateHash !== candidateHash
    || canonicalJson(value.payload.tensors) !== canonicalJson(inventory)
    || value.payload.sizeBytes < count * (4096 * 2 + 8)
    || value.reload.effectiveColumnsHash !== await canonicalSha256(value.columnHashes)
    || value.reload.untouchedWeightsHashBefore !== value.model.weightsHash
    || value.reload.effectiveColumnsHash !== value.reload.reloadedColumnsHash
    || value.reload.untouchedWeightsHashBefore !== value.reload.untouchedWeightsHashAfter
    || expected && (value.runtimeHash !== expected.runtimeHash || value.requestHash !== await canonicalSha256(expected.request)
      || canonicalJson(value.model) !== canonicalJson(expected.request.model)
      || canonicalJson(value.teacher) !== canonicalJson(expected.request.teacher)
      || count > expected.request.limits.maximumPatchColumns
      || value.payload.sizeBytes > expected.request.limits.maximumCheckpointBytes))
    throw new OpenPondProtocolError("weight_space_artifact_mismatch", "The parameter patch differs from its exact base, candidate or reload evidence.");
  return value;
}

export const WeightSpaceResultSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceResult.v1"), inputHash: Hash, runtimeHash: Hash,
  candidateHash: Hash, historyHash: Hash, artifact: WeightSpaceArtifactReferenceSchema,
  commands: z.number().int().positive().max(512), candidates: z.number().int().positive().max(64),
  forwardTokenWork: z.number().int().nonnegative().max(100_000_000),
  durationMs: z.number().finite().nonnegative().max(21_600_000), contentHash: Hash,
}).strict();
export type WeightSpaceResult = z.infer<typeof WeightSpaceResultSchema>;
export async function parseAndVerifyWeightSpaceResult(raw: unknown, expected: { request: WeightSpaceRequest; runtimeHash: string }) {
  const value = WeightSpaceResultSchema.parse(raw), { contentHash, ...content } = value;
  const manifest = await parseAndVerifyWeightSpaceArtifact(value.artifact.manifest, expected);
  const metadata = value.artifact.files.find(row => row.path === "manifest.json");
  const patch = value.artifact.files.find(row => row.path === "patch.safetensors");
  if (contentHash !== await canonicalSha256(content) || value.inputHash !== await canonicalSha256(expected.request)
    || value.runtimeHash !== expected.runtimeHash || value.candidateHash !== manifest.candidateHash || value.historyHash !== manifest.historyHash
    || value.artifact.contentHash !== manifest.contentHash || !metadata || !patch
    || value.artifact.files.some(row => row.artifactId !== value.artifact.id)
    || metadata.sha256 !== await canonicalSha256(manifest) || metadata.sizeBytes !== new TextEncoder().encode(canonicalJson(manifest)).byteLength
    || patch.sha256 !== manifest.payload.sha256 || patch.sizeBytes !== manifest.payload.sizeBytes
    || value.commands > expected.request.limits.maximumCommands || value.candidates > expected.request.limits.maximumCandidates
    || value.forwardTokenWork > expected.request.limits.maximumForwardTokenWork
    || value.durationMs > expected.request.limits.maximumDurationSeconds * 1000)
    throw new OpenPondProtocolError("weight_space_result_mismatch", "The retained weight edit differs from its exact execution and committed patch.");
  return value;
}
