import { z } from "zod";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { HostedModelProjectSummarySchema, ModelProjectBaseModelSchema } from "./model-projects.js";
import { DecisionTrainingRequestSchema, DecisionTrainingResultSchema, parseAndVerifyDecisionTrainingRequest } from "./decision-model-training.js";
import { parseAndVerifyDecisionAdapterArtifact } from "./decision-model-artifact.js";
import { DecisionExperimentFormDraftSchema, SavedDecisionExperimentSourceSchema,
  type DecisionExperimentFormDraft, type SavedDecisionExperimentSource } from "./decision-experiment-draft.js";
import { canonicalJson, canonicalJsonByteLength, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DecisionModelVersionContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionModelVersion.v1"),
  teamId: Id, ownerUserId: Id, modelProjectId: Id, portableProjectId: Id,
  baseModel: ModelProjectBaseModelSchema, request: DecisionTrainingRequestSchema,
  source: z.object({ executionId: Id, inputHash: Hash, runtimeHash: Hash, resultHash: Hash }).strict(),
  artifact: DecisionTrainingResultSchema.shape.artifact, createdAt: z.iso.datetime(),
}).strict();
export const DecisionModelVersionSchema = DecisionModelVersionContentSchema.extend({ contentHash: Hash });
export type DecisionModelVersion = z.infer<typeof DecisionModelVersionSchema>;

/** Verifies an immutable metadata publication. Only the authenticated execution
 * owner can establish that resultHash names its actual completed result and
 * that every artifact file was committed; no numerical evidence is invented. */
export async function parseAndVerifyDecisionModelVersion(raw: unknown, expected: {
  teamId?: string; modelProjectId?: string; ownerUserId?: string; versionHash?: string;
} = {}) {
  assertBoundedTaskJson(raw, 524_288);
  const value = DecisionModelVersionSchema.parse(raw), { contentHash, ...content } = value;
  const request = await parseAndVerifyDecisionTrainingRequest(value.request);
  const manifest = await parseAndVerifyDecisionAdapterArtifact(value.artifact.manifest, {
    model: request.model, inputHash: await canonicalSha256(request), recipeHash: await canonicalSha256(request.training),
    dataHash: await canonicalSha256(request.data), runtimeHash: value.source.runtimeHash,
    parentArtifactHash: request.parentArtifact?.contentHash ?? null,
  });
  function fail(): never { throw new OpenPondProtocolError("decision_model_version_mismatch", "The saved decision Model differs from its exact trained source, runtime or committed artifact."); }
  if (contentHash !== await canonicalSha256(content)
    || expected.teamId !== undefined && value.teamId !== expected.teamId
    || expected.modelProjectId !== undefined && value.modelProjectId !== expected.modelProjectId
    || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId
    || expected.versionHash !== undefined && value.contentHash !== expected.versionHash
    || canonicalJson(value.baseModel) !== canonicalJson(request.model.source)
    || value.source.inputHash !== manifest.pins.inputHash || value.artifact.contentHash !== manifest.contentHash
    || new Set(value.artifact.files.map(file => file.path)).size !== 4
    || value.artifact.files.some(file => file.artifactId !== value.artifact.id)
    || value.artifact.files.reduce((sum, file) => sum + file.sizeBytes, 0) > request.training.maxCheckpointBytes) fail();
  const tensor = value.artifact.files.find(file => file.path === "adapter_model.safetensors");
  if (!tensor || tensor.sha256 !== manifest.payload.sha256 || tensor.sizeBytes !== manifest.payload.sizeBytes) fail();
  for (const [path, payload] of [
    ["manifest.json", manifest], ["adapter_config.json", manifest.adapterConfig], ["decision_contract.json", manifest.contract],
  ] as const) {
    const file = value.artifact.files.find(row => row.path === path);
    if (!file || file.sha256 !== await canonicalSha256(payload) || file.sizeBytes !== canonicalJsonByteLength(payload) || file.sizeBytes > 262_144) fail();
  }
  return value;
}

export async function verifySavedDecisionExperimentSource(source: SavedDecisionExperimentSource, raw: unknown, expected: {
  teamId?: string; ownerUserId?: string;
} = {}) {
  const pin = SavedDecisionExperimentSourceSchema.parse(source);
  const version = await parseAndVerifyDecisionModelVersion(raw, { ...expected, modelProjectId: pin.modelProjectId, versionHash: pin.versionHash });
  if (version.artifact.id !== pin.artifact.id || version.artifact.contentHash !== pin.artifact.contentHash
    || await canonicalSha256(version.request.model) !== pin.modelHash)
    throw new OpenPondProtocolError("decision_experiment_source_mismatch", "Retain the exact saved decision Model and trained adapter.");
  return version;
}

/** Reuses the current editable train/score form and its original data, limits,
 * name and cap. The selected exact saved artifact replaces its source; its
 * released backbone is ancestry, never a substitute for the learned adapter. */
export async function decisionFormFromModelVersion(form: DecisionExperimentFormDraft, raw: unknown, expected: {
  teamId?: string; ownerUserId?: string;
} = {}): Promise<DecisionExperimentFormDraft> {
  const current = DecisionExperimentFormDraftSchema.parse(form), version = await parseAndVerifyDecisionModelVersion(raw, expected);
  return DecisionExperimentFormDraftSchema.parse({ ...current, baseModel: version.baseModel,
    parentArtifact: { id: version.artifact.id, contentHash: version.artifact.contentHash },
    startingDecision: { modelProjectId: version.modelProjectId, versionHash: version.contentHash,
      artifact: { id: version.artifact.id, contentHash: version.artifact.contentHash }, modelHash: await canonicalSha256(version.request.model) },
  });
}

export const DecisionResultSaveRequestSchema = z.object({
  teamId: Id, operationId: Id, executionId: Id, resultHash: Hash, artifactHash: Hash,
  name: z.string().trim().min(1).max(200), modelProjectId: Id.nullable(), expectedModelRevision: z.number().int().nonnegative(),
}).strict().refine(value => value.modelProjectId === null ? value.expectedModelRevision === 0 : value.expectedModelRevision > 0,
  { message: "Retain the exact existing Model revision, or create a new Model." });
export type DecisionResultSaveRequest = z.infer<typeof DecisionResultSaveRequestSchema>;
export const DecisionResultSaveReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionResultSaveReceipt.v1"), teamId: Id, actorId: Id,
  operationId: Id, requestHash: Hash, model: HostedModelProjectSummarySchema, version: DecisionModelVersionSchema,
}).strict();
export const DecisionResultSaveReceiptSchema = DecisionResultSaveReceiptContentSchema.extend({ contentHash: Hash });
export type DecisionResultSaveReceipt = z.infer<typeof DecisionResultSaveReceiptSchema>;
export async function parseAndVerifyDecisionResultSaveReceipt(raw: unknown, input: DecisionResultSaveRequest, actorId?: string) {
  const request = DecisionResultSaveRequestSchema.parse(input), value = DecisionResultSaveReceiptSchema.parse(raw), { contentHash, ...content } = value;
  await parseAndVerifyDecisionModelVersion(value.version, { teamId: request.teamId, modelProjectId: value.model.id, ownerUserId: value.actorId });
  if (contentHash !== await canonicalSha256(content) || value.teamId !== request.teamId || value.model.teamId !== request.teamId
    || actorId !== undefined && value.actorId !== actorId || value.operationId !== request.operationId
    || value.requestHash !== await canonicalSha256(request) || value.version.source.executionId !== request.executionId
    || value.version.source.resultHash !== request.resultHash || value.version.artifact.contentHash !== request.artifactHash
    || value.model.name !== request.name || value.model.revision !== request.expectedModelRevision + 1
    || request.modelProjectId !== null && value.model.id !== request.modelProjectId
    || value.version.portableProjectId !== value.model.portableProjectId)
    throw new OpenPondProtocolError("decision_model_save_mismatch", "The saved Model differs from the original decision training result, artifact or Model revision.");
  return value;
}
export function createDecisionModelClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async saveDecisionResultModel(raw: DecisionResultSaveRequest, options?: { signal?: AbortSignal; actorId?: string }) {
      const body = DecisionResultSaveRequestSchema.parse(raw);
      return parseAndVerifyDecisionResultSaveReceipt(await request(`/v1/training/modification-executions/${encodeURIComponent(body.executionId)}/model`, {
        method: "POST", body: canonicalJson(body), signal: options?.signal,
      }), body, options?.actorId);
    },
  };
}
