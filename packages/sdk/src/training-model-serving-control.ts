import { ManagedServingUsageApprovalSchema, ManagedServingUsageSnapshotSchema, managedServingUsageApprovalMatches } from "./managed-serving-usage.js";
import { z } from "zod";
import { ModelProjectImmutableRefSchema } from "./model-projects.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TrainingModelServingControlSchema = z.object({
  usage: ManagedServingUsageSnapshotSchema.optional(),
  schemaVersion: z.literal("openpond.trainingModelServingControl.v1"),
  teamId: Id, modelProjectId: Id, versionHash: Hash, artifact: ModelProjectImmutableRefSchema,
  actorId: Id, operationId: Id, revision: z.number().int().positive(),
  desiredState: z.enum(["active", "stopped"]), phase: z.enum(["starting", "active", "stopping", "stopped", "failed"]),
  capacityState: z.enum(["pending", "shared", "retiring", "released"]),
  modelId: Id, deploymentId: Id, poolId: Id, idleTimeoutSeconds: z.number().int().min(60).max(3600),
  failureCode: Id.nullable(), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type TrainingModelServingControl = z.infer<typeof TrainingModelServingControlSchema>;
export const TrainingModelServingControlRequestSchema = z.object({
  usageApproval: ManagedServingUsageApprovalSchema.optional(),
  schemaVersion: z.literal("openpond.trainingModelServingControlRequest.v1"), teamId: Id, operationId: Id,
  artifact: ModelProjectImmutableRefSchema,
  versionHash: Hash, expectedRevision: z.number().int().nonnegative(), action: z.enum(["activate", "stop"]),
  idleTimeoutSeconds: z.number().int().min(60).max(3600),
}).strict();
export type TrainingModelServingControlRequest = z.infer<typeof TrainingModelServingControlRequestSchema>;
export const TrainingModelServingControlIntentSchema = TrainingModelServingControlRequestSchema.omit({ operationId: true }).extend({ modelProjectId: Id }).strict();
export const TrainingModelServingControlCommandSchema = z.object({ modelProjectId: Id, request: TrainingModelServingControlRequestSchema }).strict();
export const TrainingModelServingControlReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.trainingModelServingControlReceipt.v1"), teamId: Id, modelProjectId: Id,
  actorId: Id, request: TrainingModelServingControlRequestSchema, control: TrainingModelServingControlSchema, contentHash: Hash,
}).strict();
export type TrainingModelServingControlReceipt = z.infer<typeof TrainingModelServingControlReceiptSchema>;

export async function parseAndVerifyTrainingModelServingControl(raw: unknown, expected: {
  modelProjectId: string; request: TrainingModelServingControlRequest; actorId?: string;
}) {
  const value = TrainingModelServingControlReceiptSchema.parse(raw), request = TrainingModelServingControlRequestSchema.parse(expected.request);
  const { contentHash, ...content } = value, control = value.control;
  if (!managedServingUsageApprovalMatches(request, control) || contentHash !== await canonicalSha256(content) || await canonicalSha256(value.request) !== await canonicalSha256(request)
    || value.modelProjectId !== expected.modelProjectId || value.teamId !== request.teamId
    || expected.actorId && value.actorId !== expected.actorId || control.actorId !== value.actorId
    || control.teamId !== request.teamId || control.modelProjectId !== value.modelProjectId
    || control.operationId !== request.operationId || control.versionHash !== request.versionHash
    || control.artifact.id !== request.artifact.id || control.artifact.contentHash !== request.artifact.contentHash
    || control.modelId !== `personalized:model:${expected.modelProjectId}`
    || control.revision !== request.expectedRevision + 1 || control.idleTimeoutSeconds !== request.idleTimeoutSeconds
    || control.desiredState !== (request.action === "activate" ? "active" : "stopped")
    || request.action === "activate" && !["starting", "active"].includes(control.phase)
    || request.action === "stop" && !["stopping", "stopped"].includes(control.phase))
    throw new OpenPondProtocolError("training_model_serving_control_mismatch", "The serving command differs from its reviewed Model, version or action.");
  return value;
}

export function createTrainingModelServingControlClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return { async controlModelServing(modelProjectId: string, raw: TrainingModelServingControlRequest) {
    const id = Id.parse(modelProjectId), body = TrainingModelServingControlRequestSchema.parse(raw);
    return parseAndVerifyTrainingModelServingControl(await request(`/v1/training/models/${encodeURIComponent(id)}/serving`, {
      method: "POST", body: JSON.stringify(body),
    }), { modelProjectId: id, request: body });
  } };
}
