import { z } from "zod";
import { HostedModelProjectSummarySchema, ModelProjectImmutableRefSchema } from "./model-projects.js";
import { TrainingModelVersionSchema, parseAndVerifyTrainingModelVersion } from "./training-result.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(200);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TrainingResultSaveRequestSchema = z.object({
  schemaVersion: z.literal("openpond.trainingResultSave.v1"),
  teamId: Id, operationId: Id, name: z.string().trim().min(1).max(200),
  expectedModelRevision: z.number().int().positive(),
  submissionHash: Hash, artifact: ModelProjectImmutableRefSchema, checkpointId: Id,
}).strict();
export type TrainingResultSaveRequest = z.infer<typeof TrainingResultSaveRequestSchema>;
export const TrainingResultSaveIntentSchema = TrainingResultSaveRequestSchema.omit({ operationId: true }).extend({ jobId: Id }).strict();
export const TrainingResultSaveCommandSchema = z.object({ jobId: Id, request: TrainingResultSaveRequestSchema }).strict();
export const TrainingResultSaveReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.trainingResultSaveReceipt.v1"),
  teamId: Id, actorId: Id, operationId: Id, requestHash: Hash,
  model: z.lazy(() => HostedModelProjectSummarySchema), version: z.lazy(() => TrainingModelVersionSchema),
  contentHash: Hash,
}).strict();
export type TrainingResultSaveReceipt = z.infer<typeof TrainingResultSaveReceiptSchema>;
export const TrainingSavedModelQuerySchema = z.object({ teamId: Id }).strict();
export const TrainingSavedModelSchema = z.object({
  schemaVersion: z.literal("openpond.trainingSavedModel.v1"), teamId: Id,
  model: z.lazy(() => HostedModelProjectSummarySchema), version: z.lazy(() => TrainingModelVersionSchema).nullable(),
}).strict();
export async function parseAndVerifyTrainingSavedModel(raw: unknown, expected: { teamId: string; modelProjectId: string }) {
  const value = TrainingSavedModelSchema.parse(raw);
  if (value.teamId !== expected.teamId || value.model.teamId !== expected.teamId || value.model.id !== expected.modelProjectId)
    throw new OpenPondProtocolError("training_saved_model_mismatch", "The saved Model belongs to another workspace or configuration.");
  if (value.version) {
    const version = await parseAndVerifyTrainingModelVersion(value.version, expected);
    if (version.portableProjectId !== value.model.portableProjectId)
      throw new OpenPondProtocolError("training_saved_model_mismatch", "The saved Model version belongs to another configuration.");
  }
  return value;
}
export async function parseAndVerifyTrainingResultSave(raw: unknown, expected: { jobId: string; request: TrainingResultSaveRequest; actorId?: string }) {
  const value = TrainingResultSaveReceiptSchema.parse(raw);
  const request = TrainingResultSaveRequestSchema.parse(expected.request);
  const { contentHash, ...content } = value;
  const version = await parseAndVerifyTrainingModelVersion(value.version, { teamId: request.teamId, modelProjectId: value.model.id, jobId: expected.jobId });
  if (contentHash !== await canonicalSha256(content) || value.requestHash !== await canonicalSha256(request)
    || value.teamId !== request.teamId || value.model.teamId !== request.teamId
    || expected.actorId && value.actorId !== expected.actorId
    || value.operationId !== request.operationId || value.model.name !== request.name
    || value.model.revision !== request.expectedModelRevision + 1
    || value.model.portableProjectId !== version.portableProjectId
    || version.request.submissionHash !== request.submissionHash
    || version.candidate.artifact.id !== request.artifact.id || version.candidate.artifact.contentHash !== request.artifact.contentHash
    || version.candidate.checkpointId !== request.checkpointId)
    throw new OpenPondProtocolError("training_result_save_mismatch", "The saved Model differs from the reviewed training result or name.");
  return value;
}
export function createTrainingModelSaveClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async savedModel(modelProjectId: string, query: z.infer<typeof TrainingSavedModelQuerySchema>) {
      const id = Id.parse(modelProjectId), scope = TrainingSavedModelQuerySchema.parse(query);
      return parseAndVerifyTrainingSavedModel(await request(`/v1/training/models/${encodeURIComponent(id)}?${new URLSearchParams(scope)}`), { ...scope, modelProjectId: id });
    },
    async saveResultModel(jobId: string, raw: TrainingResultSaveRequest) {
    const id = Id.parse(jobId), body = TrainingResultSaveRequestSchema.parse(raw);
    return parseAndVerifyTrainingResultSave(await request(`/v1/training/jobs/${encodeURIComponent(id)}/model`, {
      method: "POST", body: JSON.stringify(body),
    }), { jobId: id, request: body });
  } };
}
