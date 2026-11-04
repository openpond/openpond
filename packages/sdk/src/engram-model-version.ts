import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { EngramTrainingResultSchema, parseAndVerifyEngramAdapterArtifact } from "./engram-adapter.js";
import { HostedModelProjectSummarySchema, ModelProjectBaseModelSchema } from "./model-projects.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const EngramModelVersionContentSchema = z.object({
  schemaVersion: z.literal("openpond.engramModelVersion.v1"), teamId: Id, ownerUserId: Id,
  modelProjectId: Id, portableProjectId: Id, baseModel: ModelProjectBaseModelSchema,
  source: z.object({executionId: Id, inputHash: Hash, runtimeHash: Hash, resultHash: Hash}).strict(),
  artifact: EngramTrainingResultSchema.shape.artifact, createdAt: z.iso.datetime(),
}).strict();
export const EngramModelVersionSchema = EngramModelVersionContentSchema.extend({contentHash: Hash});
export type EngramModelVersion = z.infer<typeof EngramModelVersionSchema>;
export const SavedEngramExperimentSourceSchema = z.object({
  modelProjectId: Id, versionHash: Hash,
  artifact: z.object({id: Id, contentHash: Hash}).strict(), modelHash: Hash,
}).strict();
export type SavedEngramExperimentSource = z.infer<typeof SavedEngramExperimentSourceSchema>;
export async function parseAndVerifyEngramModelVersion(raw: unknown, expected: {teamId?: string; modelProjectId?: string; ownerUserId?: string} = {}) {
  const value = EngramModelVersionSchema.parse(raw), {contentHash, ...content} = value;
  const manifest = await parseAndVerifyEngramAdapterArtifact(value.artifact.manifest);
  const files = value.artifact.files, metadata = files.find(file => file.path === "manifest.json"), tensor = files.find(file => file.path === "adapter.safetensors");
  if (contentHash !== await canonicalSha256(content) || expected.teamId && value.teamId !== expected.teamId
    || expected.modelProjectId && value.modelProjectId !== expected.modelProjectId || expected.ownerUserId && value.ownerUserId !== expected.ownerUserId
    || value.baseModel.modelId !== manifest.pins.baseModel.modelId || value.baseModel.revision !== manifest.pins.baseModel.revision
    || value.source.runtimeHash !== manifest.pins.runtimeHash || value.artifact.contentHash !== manifest.contentHash
    || !metadata || !tensor || metadata.sha256 !== await canonicalSha256(manifest)
    || metadata.sizeBytes !== new TextEncoder().encode(canonicalJson(manifest)).byteLength
    || tensor.sha256 !== manifest.payload.sha256 || tensor.sizeBytes !== manifest.payload.sizeBytes
    || files.some(file => file.artifactId !== value.artifact.id))
    throw new OpenPondProtocolError("engram_model_version_mismatch", "The saved Model differs from its exact trained memory module.");
  return value;
}
export const EngramResultSaveRequestSchema = z.object({
  teamId: Id, operationId: Id, executionId: Id, resultHash: Hash, artifactHash: Hash,
  name: z.string().trim().min(1).max(200), modelProjectId: Id.nullable(), expectedModelRevision: z.number().int().nonnegative(),
}).strict().refine(value => value.modelProjectId ? value.expectedModelRevision > 0 : value.expectedModelRevision === 0,
  {message: "Retain the exact existing Model revision, or create a new Model."});
export type EngramResultSaveRequest = z.infer<typeof EngramResultSaveRequestSchema>;
export const EngramResultSaveReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.engramResultSaveReceipt.v1"), teamId: Id, actorId: Id,
  operationId: Id, requestHash: Hash, model: HostedModelProjectSummarySchema, version: EngramModelVersionSchema,
}).strict();
export const EngramResultSaveReceiptSchema = EngramResultSaveReceiptContentSchema.extend({contentHash: Hash});
export type EngramResultSaveReceipt = z.infer<typeof EngramResultSaveReceiptSchema>;
export async function parseAndVerifyEngramResultSaveReceipt(raw: unknown, input: EngramResultSaveRequest) {
  const request = EngramResultSaveRequestSchema.parse(input), value = EngramResultSaveReceiptSchema.parse(raw), {contentHash, ...content} = value;
  await parseAndVerifyEngramModelVersion(value.version, {teamId: request.teamId, modelProjectId: value.model.id, ownerUserId: value.actorId});
  if (contentHash !== await canonicalSha256(content) || value.teamId !== request.teamId || value.model.teamId !== request.teamId
    || value.operationId !== request.operationId || value.requestHash !== await canonicalSha256(request)
    || value.version.source.executionId !== request.executionId || value.version.source.resultHash !== request.resultHash
    || value.version.artifact.contentHash !== request.artifactHash || value.model.name !== request.name
    || value.model.revision !== request.expectedModelRevision + 1 || request.modelProjectId && value.model.id !== request.modelProjectId
    || value.version.portableProjectId !== value.model.portableProjectId)
    throw new OpenPondProtocolError("engram_model_save_mismatch", "The saved Model differs from the original execution, module or Model revision.");
  return value;
}
export function createEngramModelClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async saveEngramResultModel(raw: EngramResultSaveRequest) {
      const body = EngramResultSaveRequestSchema.parse(raw);
      return parseAndVerifyEngramResultSaveReceipt(await request(`/v1/training/modification-executions/${encodeURIComponent(body.executionId)}/model`, {
        method: "POST", body: canonicalJson(body),
      }), body);
    },
  };
}
