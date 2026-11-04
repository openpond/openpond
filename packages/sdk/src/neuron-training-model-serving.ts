import { ManagedServingUsageApprovalSchema, ManagedServingUsageSnapshotSchema, ManagedServingUsageReviewResultSchema, managedServingUsageApprovalMatches, verifyManagedServingUsageBilling } from "./managed-serving-usage.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { NeuronTrainingModelVersionSchema, parseAndVerifyNeuronTrainingModelVersion } from "./weight-model-versions.js";
import { TrainingServingPoolSchema } from "./model-serving-pool.js";
import { WeightModelInferenceReceiptSchema, parseAndVerifyResolvedWeightModelSelection } from "./weight-inference.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const BindingRef = z.object({ id: Id, revision: z.number().int().positive() }).strict();
export const NeuronTrainingModelServingQuerySchema = z.object({ teamId: Id, versionHash: Hash }).strict();
export const NeuronTrainingModelServingControlRequestSchema = z.object({
  usageApproval: ManagedServingUsageApprovalSchema.optional(),
  schemaVersion: z.literal("openpond.neuronTrainingModelServingControlRequest.v1"),
  teamId: Id, operationId: Id, versionHash: Hash,
  expectedRevision: z.number().int().nonnegative(), action: z.enum(["activate", "stop"]),
  idleTimeoutSeconds: z.number().int().min(60).max(3600),
}).strict();
export type NeuronTrainingModelServingControlRequest = z.infer<typeof NeuronTrainingModelServingControlRequestSchema>;
export const NeuronTrainingModelServingControlIntentSchema = NeuronTrainingModelServingControlRequestSchema.omit({ operationId: true }).extend({ modelProjectId: Id }).strict();
export const NeuronTrainingModelServingControlCommandSchema = z.object({ modelProjectId: Id, request: NeuronTrainingModelServingControlRequestSchema }).strict();
export const NeuronTrainingModelServingControlSchema = z.object({
  usage: ManagedServingUsageSnapshotSchema.optional(),
  schemaVersion: z.literal("openpond.neuronTrainingModelServingControl.v1"),
  teamId: Id, modelProjectId: Id, versionHash: Hash, actorId: Id, operationId: Id,
  revision: z.number().int().positive(), desiredState: z.enum(["active", "stopped"]),
  phase: z.enum(["starting", "active", "stopping", "stopped", "failed"]),
  capacityState: z.enum(["pending", "shared", "retiring", "released"]),
  modelId: z.string().trim().min(1).max(500), poolId: Id.nullable(), binding: BindingRef.nullable(),
  activeRequests: z.number().int().nonnegative(), unsettledRequests: z.number().int().nonnegative(),
  idleTimeoutSeconds: z.number().int().min(60).max(3600), failureCode: Id.nullable(), updatedAt: z.iso.datetime(),
}).strict();
export type NeuronTrainingModelServingControl = z.infer<typeof NeuronTrainingModelServingControlSchema>;
export const NeuronTrainingServingBindingSchema = z.object({
  id: Id, revision: z.number().int().positive(), modelId: z.string().trim().min(1).max(500), poolId: Id, versionHash: Hash,
}).strict();
export const NeuronTrainingServingAvailabilitySchema = z.object({
  state: z.enum(["qualified", "unavailable"]),
  reason: z.enum(["qualified", "runtime_unavailable", "artifact_unavailable", "model_mismatch"]),
  runtimeHash: Hash.nullable(),
}).strict();
export const NeuronTrainingModelServingContentSchema = z.object({
  usageBilling: ManagedServingUsageReviewResultSchema.optional(),
  schemaVersion: z.literal("openpond.neuronTrainingModelServing.v1"),
  teamId: Id, modelProjectId: Id, observedAt: z.iso.datetime(), version: NeuronTrainingModelVersionSchema,
  availability: NeuronTrainingServingAvailabilitySchema,
  control: NeuronTrainingModelServingControlSchema.nullable(), cleanup: z.array(NeuronTrainingModelServingControlSchema).max(100),
  pools: z.array(TrainingServingPoolSchema).max(100), bindings: z.array(NeuronTrainingServingBindingSchema).max(100),
  lastVerifiedInference: WeightModelInferenceReceiptSchema.nullable(),
  state: z.enum(["unavailable", "inactive", "starting", "active", "retiring"]),
}).strict();
export const NeuronTrainingModelServingSchema = NeuronTrainingModelServingContentSchema.extend({ contentHash: Hash });
export type NeuronTrainingModelServing = z.infer<typeof NeuronTrainingModelServingSchema>;
export const NeuronTrainingModelServingControlReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronTrainingModelServingControlReceipt.v1"), teamId: Id, modelProjectId: Id, actorId: Id,
  request: NeuronTrainingModelServingControlRequestSchema, version: NeuronTrainingModelVersionSchema, control: NeuronTrainingModelServingControlSchema,
}).strict();
export const NeuronTrainingModelServingControlReceiptSchema = NeuronTrainingModelServingControlReceiptContentSchema.extend({ contentHash: Hash });
export type NeuronTrainingModelServingControlReceipt = z.infer<typeof NeuronTrainingModelServingControlReceiptSchema>;

function validControl(value: NeuronTrainingModelServingControl) {
  return value.modelId === `personalized:model:${value.modelProjectId}`
    && (!value.binding || value.poolId !== null)
    && (value.phase !== "active" || value.desiredState === "active" && value.poolId !== null && value.binding !== null
      && ["pending", "shared"].includes(value.capacityState))
    && (value.phase !== "stopping" || value.desiredState === "stopped")
    && (value.capacityState !== "released" || !value.binding && value.activeRequests === 0 && value.unsettledRequests === 0)
    && (value.phase !== "stopped" || value.desiredState === "stopped" && !value.binding
      && value.activeRequests === 0 && value.unsettledRequests === 0 && ["shared", "released"].includes(value.capacityState));
}
/** A routable exact-version binding is distinct from historical score evidence
 * or a still-shared pool. Stop cannot claim release while requests are unsettled. */
export function neuronTrainingModelServingState(value: Pick<NeuronTrainingModelServing, "availability" | "control" | "cleanup" | "pools" | "bindings">): NeuronTrainingModelServing["state"] {
  const control = value.control;
  if (control?.phase === "stopping" || value.cleanup.some(row => row.phase !== "stopped" || !["shared", "released"].includes(row.capacityState))) return "retiring";
  if (value.availability.state !== "qualified" || control?.phase === "failed") return "unavailable";
  if (!control || control.desiredState === "stopped") return value.bindings.length ? "unavailable" : "inactive";
  const binding = control.binding;
  if (control.phase === "active" && binding && value.bindings.some(row => row.id === binding.id && row.revision === binding.revision
    && row.poolId === control.poolId && value.pools.some(pool => pool.id === row.poolId && pool.state === "ready" && pool.endpointRecorded))) return "active";
  return control.phase === "starting" ? "starting" : "unavailable";
}
export async function parseAndVerifyNeuronTrainingModelServingControl(raw: unknown, expected: {
  modelProjectId: string; request: NeuronTrainingModelServingControlRequest; actorId?: string;
}) {
  const value = NeuronTrainingModelServingControlReceiptSchema.parse(raw), request = NeuronTrainingModelServingControlRequestSchema.parse(expected.request);
  const { contentHash, ...content } = value, control = value.control;
  await parseAndVerifyNeuronTrainingModelVersion(value.version, { teamId: request.teamId, modelProjectId: expected.modelProjectId,
    ownerUserId: value.actorId });
  if (!managedServingUsageApprovalMatches(request, control) || contentHash !== await canonicalSha256(content) || canonicalJson(value.request) !== canonicalJson(request)
    || value.teamId !== request.teamId || value.modelProjectId !== expected.modelProjectId || expected.actorId !== undefined && value.actorId !== expected.actorId
    || value.version.contentHash !== request.versionHash || control.teamId !== value.teamId || control.modelProjectId !== value.modelProjectId || control.actorId !== value.actorId
    || control.operationId !== request.operationId || control.versionHash !== request.versionHash || control.revision !== request.expectedRevision + 1
    || control.idleTimeoutSeconds !== request.idleTimeoutSeconds || control.desiredState !== (request.action === "activate" ? "active" : "stopped")
    || !validControl(control) || request.action === "activate" && !["starting", "active"].includes(control.phase)
    || request.action === "stop" && !["stopping", "stopped"].includes(control.phase))
    throw new OpenPondProtocolError("neuron_training_serving_control_mismatch", "The serving receipt differs from the exact neuron-training Model or original control command.");
  return value;
}
export async function parseAndVerifyNeuronTrainingModelServing(raw: unknown, expected: {
  teamId: string; modelProjectId: string; versionHash: string; ownerUserId?: string;
}) {
  const value = NeuronTrainingModelServingSchema.parse(raw), { contentHash, ...content } = value;
  await verifyManagedServingUsageBilling(value.usageBilling, { ...expected, method: "selective_neuron_training" }, value.control);
  await parseAndVerifyNeuronTrainingModelVersion(value.version, expected);
  function fail(): never { throw new OpenPondProtocolError("neuron_training_model_serving_mismatch", "The serving evidence differs from the exact neuron-training Model or retained resource custody."); }
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.modelProjectId !== expected.modelProjectId
    || value.version.contentHash !== expected.versionHash || value.state !== neuronTrainingModelServingState(value) || (value.availability.state === "qualified") !== (value.availability.reason === "qualified")
    || value.availability.state === "qualified" && value.availability.runtimeHash === null) fail();
  for (const rows of [value.pools, value.bindings]) if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
  for (const control of [...value.cleanup, ...(value.control ? [value.control] : [])])
    if (control.teamId !== expected.teamId || control.modelProjectId !== expected.modelProjectId || !validControl(control)) fail();
  if (new Set(value.cleanup.map(row => row.operationId)).size !== value.cleanup.length || value.cleanup.some(row => row.desiredState !== "stopped")) fail();
  const control = value.control;
  if (control && control.versionHash !== expected.versionHash && !(control.phase === "stopped" && control.desiredState === "stopped")) fail();
  if (value.bindings.some(row => row.versionHash !== expected.versionHash || row.modelId !== `personalized:model:${expected.modelProjectId}`
    || !value.pools.some(pool => pool.id === row.poolId))) fail();
  if (control?.binding) {
    const binding = control.binding;
    if (!value.bindings.some(row => row.id === binding.id && row.revision === binding.revision && row.poolId === control.poolId && row.modelId === control.modelId)) fail();
  }
  if (value.pools.some(pool => pool.workersMin > pool.workersMax)) fail();
  const inference = value.lastVerifiedInference;
  if (inference) {
    const {contentHash: hash, ...receipt} = inference;
    await parseAndVerifyResolvedWeightModelSelection(inference.selection, value.version);
    if (hash !== await canonicalSha256(receipt) || inference.teamId !== expected.teamId
      || value.pools.some(pool => pool.id === inference.poolId && pool.workerImageDigest !== inference.workerImageDigest)) fail();
  }
  return value;
}
export function createNeuronTrainingModelServingClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async neuronTrainingModelServing(modelProjectId: string, raw: z.infer<typeof NeuronTrainingModelServingQuerySchema>, options?: { signal?: AbortSignal; ownerUserId?: string }) {
      const id = Id.parse(modelProjectId), query = NeuronTrainingModelServingQuerySchema.parse(raw);
      return parseAndVerifyNeuronTrainingModelServing(await request(`/v1/training/models/${encodeURIComponent(id)}/serving?${new URLSearchParams(query)}`, {
        signal: options?.signal,
      }), { modelProjectId: id, ...query, ownerUserId: options?.ownerUserId });
    },
    async controlNeuronTrainingModelServing(modelProjectId: string, raw: NeuronTrainingModelServingControlRequest, options?: { signal?: AbortSignal; actorId?: string }) {
      const id = Id.parse(modelProjectId), body = NeuronTrainingModelServingControlRequestSchema.parse(raw);
      return parseAndVerifyNeuronTrainingModelServingControl(await request(`/v1/training/models/${encodeURIComponent(id)}/serving`, {
        method: "POST", body: canonicalJson(body), signal: options?.signal,
      }), { modelProjectId: id, request: body, actorId: options?.actorId });
    },
  };
}
