import { TrainingExperimentSetupRequestSchema, type TrainingExperimentSetupRequest } from "./training-experiment-setup.js";
import { PostTrainingAttachmentSchema } from "./post-training.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { TrainingPreparationRequestSchema, TrainingPreparationReceiptSchema, parseAndVerifyTrainingPreparationReceipt } from "./training-preparations.js";
const Id = z.string().trim().min(1).max(191);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.string().datetime({ offset: true });
export const TrainingCapacityBlockerSchema = z.enum([
  "platform_job_limit", "workspace_job_limit", "gpu_create_limit", "gpu_worker_limit",
  "gpu_create_pacing", "gpu_hourly_limit", "provider_capacity_pending",
]);
export type TrainingCapacityBlocker = z.infer<typeof TrainingCapacityBlockerSchema>;
export const TrainingPlacementReviewOptionsSchema = z.object({ deadlineAt: Time.optional() }).strict();
export const TrainingOperationPhaseSchema = z.enum(["preparing", "waiting_capacity", "waiting_platform", "waiting_funding", "needs_review", "starting", "running", "stopping", "completed", "cancelled", "expired", "failed"]);
export const TrainingPlacementReviewSchema = z.object({
  schemaVersion: z.literal("openpond.trainingPlacementReview.v1"), id: Id, teamId: Id, actorUserId: Id,
  requestHash: Hash, runtimeVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  profiles: z.array(z.object({ gpuType: z.string().min(1).max(256), gpuCount: z.union([z.literal(1), z.literal(2)]),
    pricingVersion: Id, hourlyUsd: z.number().finite().positive() }).strict()).max(1000),
  maximumHourlyUsd: z.number().finite().nonnegative(), cloud: z.literal("SECURE"),
  countryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1), cudaVersions: z.array(z.string()).min(1),
  issuedAt: Time, expiresAt: Time, deadlineAt: Time, signature: z.string().min(1).max(512),
}).strict();
export const TrainingOperationRequestSchema = z.object({
  schemaVersion: z.literal("openpond.trainingOperationRequest.v1"), request: TrainingPreparationRequestSchema,
  placementReview: TrainingPlacementReviewSchema,
  postTraining: z.object({...PostTrainingAttachmentSchema.shape,binding:z.never().optional()}).strict().optional(),
}).strict();
export const TrainingOperationStatusSchema = z.object({
  schemaVersion: z.literal("openpond.trainingOperationStatus.v1"), id: Id, preparationId: Id,
  operationId: Id, teamId: Id, requestHash: Hash, request: TrainingPreparationRequestSchema, revision: z.number().int().positive(),
  phase: TrainingOperationPhaseSchema, reason: z.enum(["preparing_inputs", "compatible_capacity", "platform_paused", "platform_limit", "provider_unavailable", "funding_required", "authorization_changed", "runtime_unsupported", "accepted", "stop_requested", "deadline_expired", "finished"]),
  capacityBlocker: TrainingCapacityBlockerSchema.nullable(),
  nextAttemptAt: Time.nullable(), deadlineAt: Time, createdAt: Time, updatedAt: Time,
  jobId: Id.nullable(), chargedUsd: z.number().finite().nonnegative(), pendingEvidence: z.boolean(),
  canStop: z.boolean(), placementReview: TrainingPlacementReviewSchema,
  preparation: TrainingPreparationReceiptSchema.nullable(),
  postTraining:TrainingOperationRequestSchema.shape.postTraining,
}).strict();
export const TrainingOperationControlSchema = z.object({ teamId: Id, expectedRevision: z.number().int().positive() }).strict();
export const TrainingOperationReviewControlSchema=TrainingOperationControlSchema.extend({placementReview:TrainingPlacementReviewSchema}).strict();
export const TrainingOperationListQuerySchema=z.object({afterId:Id.optional(),projectId:Id.optional(),limit:z.number().int().min(1).max(100).optional()}).strict();
export const TrainingOperationPageSchema = z.object({ schemaVersion: z.literal("openpond.trainingOperationPage.v1"),
  teamId: Id, items: z.array(TrainingOperationStatusSchema).max(100), nextCursor: Id.nullable() }).strict();
export type TrainingPlacementReview = z.infer<typeof TrainingPlacementReviewSchema>;
export type TrainingOperationRequest = z.infer<typeof TrainingOperationRequestSchema>;
export type TrainingOperationStatus = z.infer<typeof TrainingOperationStatusSchema>;
export type TrainingOperationControl = z.infer<typeof TrainingOperationControlSchema>;
export function createTrainingOperationClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const base = "/v1/training/preparations/operations";
  const read = async (raw: unknown, teamId: string, id?: string) => {
    const value = TrainingOperationStatusSchema.parse(raw);
    if (value.teamId !== teamId || id && value.id !== id || value.id !== value.preparationId)
      throw new OpenPondProtocolError("training_operation_scope_mismatch", "Training operation identity does not match this workspace.");
    if(value.requestHash!==await canonicalSha256(value.request))throw new OpenPondProtocolError("training_operation_request_mismatch","The operation inputs changed.");
    if(value.preparation){const sealed=await parseAndVerifyTrainingPreparationReceipt(value.preparation);
      if(sealed.plan.id!==value.id||sealed.plan.requestHash!==value.requestHash||sealed.jobId!==value.jobId)throw new OpenPondProtocolError("training_operation_preparation_mismatch","The sealed preparation differs from the original operation.");}
    return value;
  };
  return {
    async reviewOperationPlacement(teamId:string,id:string) {
      const review=TrainingPlacementReviewSchema.parse(await request(`${base}/${encodeURIComponent(Id.parse(id))}/review`));
      if(review.teamId!==Id.parse(teamId))throw new OpenPondProtocolError("training_operation_scope_mismatch","The operation review belongs to another workspace.");
      return review;
    },
    async approveOperationReview(id:string,input:TrainingOperationControl & {placementReview:TrainingPlacementReview}) {
      const parsed=TrainingOperationReviewControlSchema.parse(input);
      return read(await request(`${base}/${encodeURIComponent(Id.parse(id))}/review`,{method:"POST",body:JSON.stringify(parsed)}),parsed.teamId,id);
    },
    async resolveExperiment(input: TrainingExperimentSetupRequest) {
      const parsed=TrainingExperimentSetupRequestSchema.parse(input);
      const resolved=TrainingPreparationRequestSchema.parse(await request(`${base}/resolve-experiment`,{method:"POST",body:JSON.stringify(parsed)}));
      const {schemaVersion:_version,baseModel:_base,settings:_settings,configuration,...expected}=parsed;
      const {schemaVersion:_resolvedVersion,configuration:resolvedConfiguration,...actual}=resolved;
      if(canonicalJson(expected)!==canonicalJson(actual) || configuration && canonicalJson(configuration)!==canonicalJson(resolvedConfiguration))
        throw new OpenPondProtocolError("training_operation_experiment_mismatch","The resolved experiment differs from these reviewed inputs.");
      return resolved;
    },
    async reviewPlacement(input: z.input<typeof TrainingPreparationRequestSchema>, options: z.input<typeof TrainingPlacementReviewOptionsSchema> = {}) {
      const parsed = TrainingPreparationRequestSchema.parse(input);
      const bounded = TrainingPlacementReviewOptionsSchema.parse(options);
      const query = bounded.deadlineAt ? `?${new URLSearchParams({deadlineAt: bounded.deadlineAt})}` : "";
      const review = TrainingPlacementReviewSchema.parse(await request(`${base}/review${query}`, {method:"POST", body:JSON.stringify(parsed)}));
      if (review.teamId !== parsed.teamId || review.requestHash !== await canonicalSha256(parsed) ||
          bounded.deadlineAt !== undefined && Date.parse(review.deadlineAt) !== Date.parse(bounded.deadlineAt))
        throw new OpenPondProtocolError("training_operation_review_mismatch", "The placement review does not match these inputs.");
      return review;
    },
    async queueRun(input: TrainingOperationRequest) {
      const parsed = TrainingOperationRequestSchema.parse(input);
      const value = await read(await request(base, {method:"POST", body:JSON.stringify(parsed)}), parsed.request.teamId);
      if (value.operationId !== parsed.request.operationId || value.requestHash !== await canonicalSha256(parsed.request))
        throw new OpenPondProtocolError("training_operation_request_mismatch", "The retained operation does not match these inputs.");
      return value;
    },
    async findOperation(teamId:string,operationId:string) { return read(await request(`${base}/by-operation/${encodeURIComponent(Id.parse(operationId))}`),Id.parse(teamId)); },
    async getOperation(teamId: string, id: string) { return read(await request(`${base}/${encodeURIComponent(Id.parse(id))}`), Id.parse(teamId), id); },
    async listOperations(teamId: string, input: {afterId?: string; limit?: number; projectId?: string} = {}) {
      const params = new URLSearchParams();
      if(input.projectId) params.set("projectId", Id.parse(input.projectId));
      if(input.afterId) params.set("afterId", Id.parse(input.afterId));
      if(input.limit !== undefined) params.set("limit", String(z.number().int().min(1).max(100).parse(input.limit)));
      const page = TrainingOperationPageSchema.parse(await request(`${base}?${params}`));
      if(page.teamId !== Id.parse(teamId) || new Set(page.items.map(value=>value.id)).size !== page.items.length)
        throw new OpenPondProtocolError("training_operation_page_mismatch", "The operation page does not match this workspace.");
      return {...page, items:await Promise.all(page.items.map(value=>read(value, teamId)))};
    },
    async stopOperation(id: string, input: TrainingOperationControl) {
      const control=TrainingOperationControlSchema.parse(input);
      return read(await request(`${base}/${encodeURIComponent(Id.parse(id))}/stop`, {method:"POST", body:JSON.stringify(control)}), control.teamId,id);
    },
  };
}
