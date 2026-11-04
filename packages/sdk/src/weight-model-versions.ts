import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { HostedModelProjectSummarySchema, ModelProjectBaseModelSchema } from "./model-projects.js";
import { AlphaEditTrainingRequestSchema } from "./alphaedit.js";
import { AlphaEditTrainingResultSchema, parseAndVerifyAlphaEditArtifact } from "./alphaedit-artifact.js";
import { NeuronTrainingRequestSchema } from "./neuron-training.js";
import { NeuronTrainingResultSchema } from "./neuron-training-result.js";
import { parseAndVerifyNeuronTrainingArtifact } from "./neuron-training-artifact.js";
import { SavedAlphaEditExperimentSourceSchema } from "./alphaedit-experiment-draft.js";
import { SavedNeuronTrainingExperimentSourceSchema } from "./neuron-training-experiment-draft.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = {
  teamId: Id, ownerUserId: Id, modelProjectId: Id, portableProjectId: Id,
  baseModel: ModelProjectBaseModelSchema,
  source: z.object({executionId: Id, inputHash: Hash, runtimeHash: Hash, resultHash: Hash}).strict(),
  createdAt: z.iso.datetime(),
};
export const AlphaEditModelVersionContentSchema = z.object({
  ...identity, schemaVersion: z.literal("openpond.alphaEditModelVersion.v1"),
  request: AlphaEditTrainingRequestSchema, artifact: AlphaEditTrainingResultSchema.shape.artifact,
}).strict();
export const AlphaEditModelVersionSchema = AlphaEditModelVersionContentSchema.extend({contentHash: Hash});
export type AlphaEditModelVersion = z.infer<typeof AlphaEditModelVersionSchema>;
export const NeuronTrainingModelVersionContentSchema = z.object({
  ...identity, schemaVersion: z.literal("openpond.neuronTrainingModelVersion.v1"),
  request: NeuronTrainingRequestSchema, artifact: NeuronTrainingResultSchema.shape.artifact,
}).strict();
export const NeuronTrainingModelVersionSchema = NeuronTrainingModelVersionContentSchema.extend({contentHash: Hash});
export type NeuronTrainingModelVersion = z.infer<typeof NeuronTrainingModelVersionSchema>;
type Scope = {teamId?: string; modelProjectId?: string; ownerUserId?: string};
function fail(): never {
  throw new OpenPondProtocolError("weight_model_version_mismatch", "The saved Model differs from its exact learned weights, source or committed artifact.");
}
async function verifyEnvelope(value: AlphaEditModelVersion | NeuronTrainingModelVersion, expected: Scope) {
  const {contentHash, ...content} = value;
  if (contentHash !== await canonicalSha256(content)
    || expected.teamId !== undefined && value.teamId !== expected.teamId
    || expected.modelProjectId !== undefined && value.modelProjectId !== expected.modelProjectId
    || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId
    || value.baseModel.source !== "managed" || value.baseModel.modelAssetId !== null
    || value.baseModel.modelId !== value.request.model.modelId
    || value.baseModel.revision !== value.request.model.revision || !value.baseModel.tokenizerRevision
    || value.source.inputHash !== await canonicalSha256(value.request)
    || value.artifact.contentHash !== value.artifact.manifest.contentHash) fail();
}
async function verifyFiles(artifact: {id: string; files: {path: string; artifactId: string; sha256: string; sizeBytes: number}[]},
  manifest: unknown, payloads: {path: string; sha256: string; sizeBytes: number}[], maximumBytes: number) {
  const encoded = canonicalJson(manifest);
  const expected = [{path: "manifest.json", sha256: await canonicalSha256(manifest),
    sizeBytes: new TextEncoder().encode(encoded).byteLength}, ...payloads];
  if (expected[0]!.sizeBytes > 262_144 || artifact.files.length !== expected.length
    || new Set(artifact.files.map(file => file.path)).size !== expected.length
    || artifact.files.some(file => file.artifactId !== artifact.id)
    || artifact.files.reduce((sum, file) => sum + file.sizeBytes, 0) > maximumBytes
    || expected.some(item => !artifact.files.some(file => file.path === item.path && file.sha256 === item.sha256 && file.sizeBytes === item.sizeBytes))) fail();
}
/** Verifies retained metadata; actual blob possession/authorization belongs to
 * the artifact custodian on every publication and serving admission. */
export async function parseAndVerifyAlphaEditModelVersion(raw: unknown, expected: Scope = {}) {
  const value = AlphaEditModelVersionSchema.parse(raw);
  await verifyEnvelope(value, expected);
  const manifest = await parseAndVerifyAlphaEditArtifact(value.artifact.manifest,
    {request: value.request, runtimeHash: value.source.runtimeHash});
  await verifyFiles(value.artifact, manifest, [manifest.payloads.patch, ...manifest.payloads.state], value.request.training.maxCheckpointBytes);
  return value;
}
export async function parseAndVerifyNeuronTrainingModelVersion(raw: unknown, expected: Scope = {}) {
  const value = NeuronTrainingModelVersionSchema.parse(raw);
  await verifyEnvelope(value, expected);
  const manifest = await parseAndVerifyNeuronTrainingArtifact(value.artifact.manifest,
    {request: value.request, runtimeHash: value.source.runtimeHash});
  await verifyFiles(value.artifact, manifest, [manifest.payload], value.request.training.maxCheckpointBytes);
  return value;
}
export async function verifySavedAlphaEditExperimentSource(sourceInput: unknown, raw: unknown, expected: Scope = {}) {
  const source = SavedAlphaEditExperimentSourceSchema.parse(sourceInput);
  const version = await parseAndVerifyAlphaEditModelVersion(raw, {...expected, modelProjectId: source.modelProjectId});
  if (version.contentHash !== source.versionHash || version.artifact.id !== source.artifact.id
    || version.artifact.contentHash !== source.artifact.contentHash
    || await canonicalSha256(version.request.model) !== source.modelHash) fail();
  return version;
}
export async function verifySavedNeuronTrainingExperimentSource(sourceInput: unknown, raw: unknown, expected: Scope = {}) {
  const source = SavedNeuronTrainingExperimentSourceSchema.parse(sourceInput);
  const version = await parseAndVerifyNeuronTrainingModelVersion(raw, {...expected, modelProjectId: source.modelProjectId});
  if (version.contentHash !== source.versionHash || version.artifact.id !== source.artifact.id
    || version.artifact.contentHash !== source.artifact.contentHash
    || await canonicalSha256(version.request.model) !== source.modelHash) fail();
  return version;
}

const SaveRequest = z.object({teamId: Id, operationId: Id, executionId: Id, resultHash: Hash, artifactHash: Hash,
  name: z.string().trim().min(1).max(200), modelProjectId: Id.nullable(), expectedModelRevision: z.number().int().nonnegative(),
}).strict().refine(value => value.modelProjectId ? value.expectedModelRevision > 0 : value.expectedModelRevision === 0,
  {message: "Retain the existing Model revision or create a new Model."});
export const AlphaEditResultSaveRequestSchema = SaveRequest;
export const NeuronTrainingResultSaveRequestSchema = SaveRequest;
export type AlphaEditResultSaveRequest = z.infer<typeof AlphaEditResultSaveRequestSchema>;
export type NeuronTrainingResultSaveRequest = z.infer<typeof NeuronTrainingResultSaveRequestSchema>;
const receipt = {teamId: Id, actorId: Id, operationId: Id, requestHash: Hash, model: HostedModelProjectSummarySchema};
export const AlphaEditResultSaveReceiptContentSchema = z.object({...receipt,
  schemaVersion: z.literal("openpond.alphaEditResultSaveReceipt.v1"), version: AlphaEditModelVersionSchema}).strict();
export const AlphaEditResultSaveReceiptSchema = AlphaEditResultSaveReceiptContentSchema.extend({contentHash: Hash});
export type AlphaEditResultSaveReceipt = z.infer<typeof AlphaEditResultSaveReceiptSchema>;
export const NeuronTrainingResultSaveReceiptContentSchema = z.object({...receipt,
  schemaVersion: z.literal("openpond.neuronTrainingResultSaveReceipt.v1"), version: NeuronTrainingModelVersionSchema}).strict();
export const NeuronTrainingResultSaveReceiptSchema = NeuronTrainingResultSaveReceiptContentSchema.extend({contentHash: Hash});
export type NeuronTrainingResultSaveReceipt = z.infer<typeof NeuronTrainingResultSaveReceiptSchema>;
async function verifySave(value: AlphaEditResultSaveReceipt | NeuronTrainingResultSaveReceipt, request: AlphaEditResultSaveRequest) {
  const {contentHash, ...content} = value;
  if (contentHash !== await canonicalSha256(content) || value.teamId !== request.teamId || value.model.teamId !== request.teamId
    || value.operationId !== request.operationId || value.requestHash !== await canonicalSha256(request)
    || value.version.source.executionId !== request.executionId || value.version.source.resultHash !== request.resultHash
    || value.version.artifact.contentHash !== request.artifactHash || value.model.name !== request.name
    || value.model.revision !== request.expectedModelRevision + 1
    || request.modelProjectId !== null && value.model.id !== request.modelProjectId
    || value.version.portableProjectId !== value.model.portableProjectId) fail();
}
export async function parseAndVerifyAlphaEditResultSaveReceipt(raw: unknown, input: AlphaEditResultSaveRequest) {
  const request = SaveRequest.parse(input), value = AlphaEditResultSaveReceiptSchema.parse(raw);
  await parseAndVerifyAlphaEditModelVersion(value.version, {teamId: request.teamId, modelProjectId: value.model.id, ownerUserId: value.actorId});
  await verifySave(value, request); return value;
}
export async function parseAndVerifyNeuronTrainingResultSaveReceipt(raw: unknown, input: NeuronTrainingResultSaveRequest) {
  const request = SaveRequest.parse(input), value = NeuronTrainingResultSaveReceiptSchema.parse(raw);
  await parseAndVerifyNeuronTrainingModelVersion(value.version, {teamId: request.teamId, modelProjectId: value.model.id, ownerUserId: value.actorId});
  await verifySave(value, request); return value;
}
export function createWeightModelClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const save = (command: AlphaEditResultSaveRequest) => request(`/v1/training/modification-executions/${encodeURIComponent(command.executionId)}/model`,
    {method: "POST", body: canonicalJson(command)});
  return {
    async saveAlphaEditResultModel(raw: AlphaEditResultSaveRequest) {
      const command = SaveRequest.parse(raw); return parseAndVerifyAlphaEditResultSaveReceipt(await save(command), command);
    },
    async saveNeuronTrainingResultModel(raw: NeuronTrainingResultSaveRequest) {
      const command = SaveRequest.parse(raw); return parseAndVerifyNeuronTrainingResultSaveReceipt(await save(command), command);
    },
  };
}
