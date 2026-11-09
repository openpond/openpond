import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { ModelProjectBaseModelSchema, HostedModelProjectSummarySchema } from "./model-projects.js";
import { NeuronSteeringProfileSchema, parseAndVerifyNeuronSteeringProfile } from "./neuron-steering.js";
import { ActivationReferenceOutcomeSchema } from "./activation-reference.js";
import { TrainingModelVersionSchema, parseAndVerifyTrainingModelVersion } from "./training-result.js";
import { EngramModelVersionSchema, parseAndVerifyEngramModelVersion } from "./engram-model-version.js";
import { DecisionModelVersionSchema, parseAndVerifyDecisionModelVersion } from "./decision-model-version.js";
import { WeightSpaceModelVersionSchema, parseAndVerifyWeightSpaceModelVersion, AlphaEditModelVersionSchema, NeuronTrainingModelVersionSchema,
  parseAndVerifyAlphaEditModelVersion, parseAndVerifyNeuronTrainingModelVersion } from "./weight-model-versions.js";
const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SteeringProfilePublicationContentSchema = z.object({
  schemaVersion: z.literal("openpond.steeringProfilePublication.v1"), id: Id, revision: z.literal(1),
  teamId: Id, ownerUserId: Id, projectId: Id.nullable(), name: z.string().trim().min(1).max(200),
  baseModel: ModelProjectBaseModelSchema, profile: NeuronSteeringProfileSchema,
  source: z.object({executionId: Id, inputHash: Hash, runtimeHash: Hash, resultHash: Hash, variantId: Id}).strict(),
  calibrationEvidence: z.array(z.object({promptId: Id, calibration: ActivationReferenceOutcomeSchema.shape.calibration}).strict()).min(1).max(8),
  createdAt: z.iso.datetime(),
}).strict();
export const SteeringProfilePublicationSchema = SteeringProfilePublicationContentSchema.extend({contentHash: Hash}).strict();
export type SteeringProfilePublication = z.infer<typeof SteeringProfilePublicationSchema>;
export async function parseAndVerifySteeringProfilePublication(raw: unknown, expected: {teamId?: string; ownerUserId?: string; id?: string} = {}) {
  const value = SteeringProfilePublicationSchema.parse(raw), {contentHash, ...content} = value;
  await parseAndVerifyNeuronSteeringProfile(value.profile);
  if (contentHash !== await canonicalSha256(content) || expected.teamId && value.teamId !== expected.teamId ||
      expected.ownerUserId && value.ownerUserId !== expected.ownerUserId || expected.id && value.id !== expected.id ||
      value.baseModel.modelId !== value.profile.model.modelId || value.baseModel.revision !== value.profile.model.revision ||
      new Set(value.calibrationEvidence.map(row => row.promptId)).size !== value.calibrationEvidence.length)
    throw new OpenPondProtocolError("steering_publication_mismatch", "The immutable steering profile differs from its exact source or workspace.");
  return value;
}
export const SteeringModelVersionContentSchema = z.object({schemaVersion: z.literal("openpond.steeringModelVersion.v1"),
  teamId: Id, modelProjectId: Id, portableProjectId: Id, publication: SteeringProfilePublicationSchema, createdAt: z.iso.datetime()}).strict();
export const SteeringModelVersionSchema = SteeringModelVersionContentSchema.extend({contentHash: Hash}).strict();
export type SteeringModelVersion = z.infer<typeof SteeringModelVersionSchema>;
export const SavedModelVersionSchema = z.discriminatedUnion("schemaVersion", [TrainingModelVersionSchema, SteeringModelVersionSchema, EngramModelVersionSchema, DecisionModelVersionSchema, AlphaEditModelVersionSchema, NeuronTrainingModelVersionSchema, WeightSpaceModelVersionSchema]);
export type SavedModelVersion = z.infer<typeof SavedModelVersionSchema>;
export async function parseAndVerifySavedModelVersion(raw: unknown, expected: {teamId?: string; modelProjectId?: string} = {}): Promise<SavedModelVersion> {
  const value = SavedModelVersionSchema.parse(raw);
  if (value.schemaVersion === "openpond.trainingModelVersion.v1") return parseAndVerifyTrainingModelVersion(value, expected);
  if (value.schemaVersion === "openpond.engramModelVersion.v1") return parseAndVerifyEngramModelVersion(value, expected);
  if (value.schemaVersion === "openpond.decisionModelVersion.v1") return parseAndVerifyDecisionModelVersion(value, expected);
  if (value.schemaVersion === "openpond.alphaEditModelVersion.v1") return parseAndVerifyAlphaEditModelVersion(value, expected);
  if(value.schemaVersion === "openpond.weightSpaceModelVersion.v1") return parseAndVerifyWeightSpaceModelVersion(value,expected);
  if (value.schemaVersion === "openpond.neuronTrainingModelVersion.v1") return parseAndVerifyNeuronTrainingModelVersion(value, expected);
  const {contentHash, ...content} = value;
  await parseAndVerifySteeringProfilePublication(value.publication, expected);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== value.publication.teamId ||
      expected.teamId && value.teamId !== expected.teamId || expected.modelProjectId && value.modelProjectId !== expected.modelProjectId)
    throw new OpenPondProtocolError("saved_model_version_mismatch", "The saved steering Model version differs from its immutable publication.");
  return value;
}
export const SteeringProfileRecordContentSchema = z.object({schemaVersion: z.literal("openpond.steeringProfileRecord.v1"),
  publication: SteeringProfilePublicationSchema, revision: z.number().int().positive(), archived: z.boolean(), updatedAt: z.iso.datetime()}).strict();
export const SteeringProfileRecordSchema = SteeringProfileRecordContentSchema.extend({contentHash: Hash}).strict();
export type SteeringProfileRecord = z.infer<typeof SteeringProfileRecordSchema>;
export async function parseAndVerifySteeringProfileRecord(raw: unknown, expected: {teamId?: string; ownerUserId?: string; id?: string} = {}) {
  const value = SteeringProfileRecordSchema.parse(raw), {contentHash, ...content} = value;
  await parseAndVerifySteeringProfilePublication(value.publication, expected);
  if (contentHash !== await canonicalSha256(content)) throw new OpenPondProtocolError("steering_profile_record_mismatch", "The retained profile record changed.");
  return value;
}
export const SteeringProfileSaveRequestSchema = z.object({teamId: Id, operationId: Id, executionId: Id, variantId: Id,
  resultHash: Hash, profileHash: Hash, name: z.string().trim().min(1).max(200), modelProjectId: Id.nullable(),
  expectedModelRevision: z.number().int().nonnegative()}).strict().refine(value => value.modelProjectId ? value.expectedModelRevision > 0 : value.expectedModelRevision === 0,
  {message: "Retain the exact existing Model revision, or create a new Model."});
export type SteeringProfileSaveRequest = z.infer<typeof SteeringProfileSaveRequestSchema>;
export const SteeringProfileArchiveRequestSchema = z.object({teamId: Id, operationId: Id, expectedRevision: z.number().int().positive(), contentHash: Hash}).strict();
export const SteeringProfileReceiptContentSchema = z.object({schemaVersion: z.literal("openpond.steeringProfileReceipt.v1"),
  teamId: Id, actorId: Id, operationId: Id, requestHash: Hash, record: SteeringProfileRecordSchema,
  model: HostedModelProjectSummarySchema.nullable(), version: SteeringModelVersionSchema.nullable()}).strict();
export const SteeringProfileReceiptSchema = SteeringProfileReceiptContentSchema.extend({contentHash: Hash}).strict();
export type SteeringProfileReceipt = z.infer<typeof SteeringProfileReceiptSchema>;
export async function parseAndVerifySteeringProfileReceipt(raw: unknown, request: SteeringProfileSaveRequest | z.infer<typeof SteeringProfileArchiveRequestSchema>, id?: string) {
  const value = SteeringProfileReceiptSchema.parse(raw), {contentHash, ...content} = value;
  await parseAndVerifySteeringProfileRecord(value.record, {teamId: request.teamId, ownerUserId: value.actorId, id});
  const saving = "executionId" in request;
  if (contentHash !== await canonicalSha256(content) || value.teamId !== request.teamId || value.operationId !== request.operationId ||
      value.requestHash !== await canonicalSha256(saving ? request : {id, request})) throw new OpenPondProtocolError("steering_profile_receipt_mismatch", "Retry the original steering Model command.");
  if (saving) {
    const publication = value.record.publication;
    if (!value.model || !value.version || publication.source.executionId !== request.executionId || publication.source.variantId !== request.variantId ||
        publication.source.resultHash !== request.resultHash || publication.profile.contentHash !== request.profileHash || publication.name !== request.name ||
        value.model.name !== request.name || request.modelProjectId && value.model.id !== request.modelProjectId ||
        value.model.revision !== request.expectedModelRevision + 1) throw new OpenPondProtocolError("steering_profile_receipt_mismatch", "The saved Model differs from the selected result variant.");
    await parseAndVerifySavedModelVersion(value.version, {teamId: request.teamId, modelProjectId: value.model.id});
    if (canonicalJson(value.version.publication) !== canonicalJson(publication)) throw new OpenPondProtocolError("steering_profile_receipt_mismatch", "The Model version has a different publication.");
  } else if (!value.record.archived || value.record.revision !== request.expectedRevision + 1 || value.record.publication.contentHash !== request.contentHash || value.model || value.version)
    throw new OpenPondProtocolError("steering_profile_receipt_mismatch", "The archive receipt differs from its original immutable profile.");
  return value;
}
export const SteeringProfileListQuerySchema = z.object({projectId: Id.optional(), modelProjectId: Id.optional(), archived: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(2048).optional()}).strict();
export const SteeringProfileSummarySchema = z.object({id: Id, teamId: Id, ownerUserId: Id, projectId: Id.nullable(), modelProjectId: Id, name: z.string().min(1).max(200), publicationHash: Hash, profileHash: Hash,
  baseModel: ModelProjectBaseModelSchema, source: SteeringProfilePublicationContentSchema.shape.source,
  revision: z.number().int().positive(), archived: z.boolean(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()}).strict();
export const SteeringProfileReadQuerySchema = z.object({teamId: Id}).strict();
export const SteeringProfilePageContentSchema = z.object({schemaVersion: z.literal("openpond.steeringProfilePage.v1"), teamId: Id, ownerUserId: Id,
  query: SteeringProfileListQuerySchema, items: z.array(SteeringProfileSummarySchema).max(100), nextCursor: z.string().min(1).max(2048).nullable()}).strict();
export const SteeringProfilePageSchema = SteeringProfilePageContentSchema.extend({contentHash: Hash}).strict();
export const SavedModelVersionReadSchema = z.object({schemaVersion: z.literal("openpond.savedModelVersionRead.v1"), teamId: Id, model: HostedModelProjectSummarySchema, version: SavedModelVersionSchema.nullable()}).strict();
export async function parseAndVerifySavedModelVersionRead(raw: unknown, teamId: string, modelProjectId: string, versionHash?: string) {
  const value = SavedModelVersionReadSchema.parse(raw);
  if (value.teamId !== teamId || value.model.teamId !== teamId || value.model.id !== modelProjectId) throw new OpenPondProtocolError("saved_model_version_mismatch", "Choose this Model's workspace.");
  if (versionHash !== undefined && value.version?.contentHash !== versionHash) throw new OpenPondProtocolError("saved_model_version_mismatch", "The response differs from the exact saved Model version.");
  if (value.version) { await parseAndVerifySavedModelVersion(value.version, {teamId, modelProjectId});
    if (value.version.portableProjectId !== value.model.portableProjectId) throw new OpenPondProtocolError("saved_model_version_mismatch", "The saved version belongs to another Model."); }
  return value;
}
export function createSteeringProfileClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async saveModificationResultModel(raw: SteeringProfileSaveRequest) { const body = SteeringProfileSaveRequestSchema.parse(raw);
      return parseAndVerifySteeringProfileReceipt(await request("/v1/training/steering-profiles", {method: "POST", body: JSON.stringify(body)}), body); },
    async getSteeringProfile(teamId: string, id: string) { return parseAndVerifySteeringProfileRecord(await request(`/v1/training/steering-profiles/${encodeURIComponent(Id.parse(id))}?${new URLSearchParams({teamId: Id.parse(teamId)})}`), {teamId, id}); },
    async archiveSteeringProfile(id: string, raw: z.infer<typeof SteeringProfileArchiveRequestSchema>) { const body = SteeringProfileArchiveRequestSchema.parse(raw);
      return parseAndVerifySteeringProfileReceipt(await request(`/v1/training/steering-profiles/${encodeURIComponent(Id.parse(id))}/archive`, {method: "POST", body: JSON.stringify(body)}), body, id); },
    async listSteeringProfiles(teamId: string, raw: z.input<typeof SteeringProfileListQuerySchema> = {}) { const query = Object.fromEntries(Object.entries(SteeringProfileListQuerySchema.parse(raw)).filter(([, value]) => value !== undefined)) as z.infer<typeof SteeringProfileListQuerySchema>;
      const params = new URLSearchParams({teamId: Id.parse(teamId)}); for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      const page = SteeringProfilePageSchema.parse(await request(`/v1/training/steering-profiles?${params}`)), {contentHash, ...content} = page;
      if (page.teamId !== teamId || canonicalJson(page.query) !== canonicalJson(query) || contentHash !== await canonicalSha256(content) || page.items.length > query.limit ||
          new Set(page.items.map(row => row.id)).size !== page.items.length || page.nextCursor !== null && (page.items.length !== query.limit || page.nextCursor === query.cursor))
        throw new OpenPondProtocolError("steering_profile_page_mismatch", "Refresh this profile history.");
      for (const [index, item] of page.items.entries()) {
        if (item.teamId !== teamId || item.ownerUserId !== page.ownerUserId || query.projectId && item.projectId !== query.projectId || query.modelProjectId && item.modelProjectId !== query.modelProjectId || item.archived !== query.archived || index && page.items[index - 1]!.id >= item.id) throw new OpenPondProtocolError("steering_profile_page_mismatch", "The profile list scope changed."); }
      return page; },
    async modelVersion(modelProjectId: string, query: {teamId: string; versionHash?: string}) {
      const params = new URLSearchParams({teamId: Id.parse(query.teamId)});
      if (query.versionHash !== undefined) params.set("versionHash", Hash.parse(query.versionHash));
      return parseAndVerifySavedModelVersionRead(await request(`/v1/training/models/${encodeURIComponent(Id.parse(modelProjectId))}/version?${params}`), query.teamId, modelProjectId, query.versionHash);
    },
  };
}

export type SteeringProfilePage = z.infer<typeof SteeringProfilePageSchema>;
export type SteeringProfileSummary = z.infer<typeof SteeringProfileSummarySchema>;
