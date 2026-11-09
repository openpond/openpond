import { ManagedServingUsageApprovalSchema, ManagedServingUsageSnapshotSchema, ManagedServingUsageReviewResultSchema, managedServingUsageApprovalMatches, verifyManagedServingUsageBilling } from "./managed-serving-usage.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { WeightSpaceModelVersionSchema, parseAndVerifyWeightSpaceModelVersion } from "./weight-model-versions.js";
import { TrainingServingPoolSchema } from "./model-serving-pool.js";
import { WeightModelInferenceReceiptSchema, parseAndVerifyResolvedWeightModelSelection } from "./weight-inference.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const BindingRef = z.object({ id: Id, revision: z.number().int().positive() }).strict();
export const WeightSpaceModelServingQuerySchema = z.object({ teamId: Id, versionHash: Hash }).strict();
export const WeightSpaceModelServingControlRequestSchema = z.object({
  usageApproval: ManagedServingUsageApprovalSchema.optional(),
  schemaVersion: z.literal("openpond.weightSpaceModelServingControlRequest.v1"),
  teamId: Id, operationId: Id, versionHash: Hash,
  expectedRevision: z.number().int().nonnegative(), action: z.enum(["activate", "stop"]),
  idleTimeoutSeconds: z.number().int().min(60).max(3600),
}).strict();
export type WeightSpaceModelServingControlRequest = z.infer<typeof WeightSpaceModelServingControlRequestSchema>;
export const WeightSpaceModelServingControlIntentSchema = WeightSpaceModelServingControlRequestSchema.omit({ operationId: true }).extend({ modelProjectId: Id }).strict();
export const WeightSpaceModelServingControlCommandSchema = z.object({ modelProjectId: Id, request: WeightSpaceModelServingControlRequestSchema }).strict();
export const WeightSpaceModelServingControlSchema = z.object({
  usage: ManagedServingUsageSnapshotSchema.optional(),
  schemaVersion: z.literal("openpond.weightSpaceModelServingControl.v1"),
  teamId: Id, modelProjectId: Id, versionHash: Hash, actorId: Id, operationId: Id,
  revision: z.number().int().positive(), desiredState: z.enum(["active", "stopped"]),
  phase: z.enum(["starting", "active", "stopping", "stopped", "failed"]),
  capacityState: z.enum(["pending", "shared", "retiring", "released"]),
  modelId: z.string().trim().min(1).max(500), poolId: Id.nullable(), binding: BindingRef.nullable(),
  activeRequests: z.number().int().nonnegative(), unsettledRequests: z.number().int().nonnegative(),
  idleTimeoutSeconds: z.number().int().min(60).max(3600), failureCode: Id.nullable(), updatedAt: z.iso.datetime(),
}).strict();
export type WeightSpaceModelServingControl = z.infer<typeof WeightSpaceModelServingControlSchema>;
export const WeightSpaceServingBindingSchema = z.object({
  id: Id, revision: z.number().int().positive(), modelId: z.string().trim().min(1).max(500), poolId: Id, versionHash: Hash,
}).strict();
export const WeightSpaceServingAvailabilitySchema = z.object({
  state: z.enum(["qualified", "unavailable"]),
  reason: z.enum(["qualified", "runtime_unavailable", "artifact_unavailable", "model_mismatch"]),
  runtimeHash: Hash.nullable(),
}).strict();
export const WeightSpaceModelServingContentSchema = z.object({
  usageBilling: ManagedServingUsageReviewResultSchema.optional(),
  schemaVersion: z.literal("openpond.weightSpaceModelServing.v1"),
  teamId: Id, modelProjectId: Id, observedAt: z.iso.datetime(), version: WeightSpaceModelVersionSchema,
  availability: WeightSpaceServingAvailabilitySchema,
  control: WeightSpaceModelServingControlSchema.nullable(), cleanup: z.array(WeightSpaceModelServingControlSchema).max(100),
  pools: z.array(TrainingServingPoolSchema).max(100), bindings: z.array(WeightSpaceServingBindingSchema).max(100),
  lastVerifiedInference: WeightModelInferenceReceiptSchema.nullable(),
  state: z.enum(["unavailable", "inactive", "starting", "active", "retiring"]),
}).strict();
export const WeightSpaceModelServingSchema = WeightSpaceModelServingContentSchema.extend({ contentHash: Hash });
export type WeightSpaceModelServing = z.infer<typeof WeightSpaceModelServingSchema>;
export const WeightSpaceModelServingControlReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceModelServingControlReceipt.v1"), teamId: Id, modelProjectId: Id, actorId: Id,
  request: WeightSpaceModelServingControlRequestSchema, version: WeightSpaceModelVersionSchema, control: WeightSpaceModelServingControlSchema,
}).strict();
export const WeightSpaceModelServingControlReceiptSchema = WeightSpaceModelServingControlReceiptContentSchema.extend({ contentHash: Hash });
export type WeightSpaceModelServingControlReceipt = z.infer<typeof WeightSpaceModelServingControlReceiptSchema>;

function validControl(value: WeightSpaceModelServingControl) {
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
export function weightSpaceModelServingState(value: Pick<WeightSpaceModelServing, "availability" | "control" | "cleanup" | "pools" | "bindings">): WeightSpaceModelServing["state"] {
  const control = value.control;
  if (control?.phase === "stopping" || value.cleanup.some(row => row.phase !== "stopped" || !["shared", "released"].includes(row.capacityState))) return "retiring";
  if (value.availability.state !== "qualified" || control?.phase === "failed") return "unavailable";
  if (!control || control.desiredState === "stopped") return value.bindings.length ? "unavailable" : "inactive";
  const binding = control.binding;
  if (control.phase === "active" && binding && value.bindings.some(row => row.id === binding.id && row.revision === binding.revision
    && row.poolId === control.poolId && value.pools.some(pool => pool.id === row.poolId && pool.state === "ready" && pool.endpointRecorded))) return "active";
  return control.phase === "starting" ? "starting" : "unavailable";
}
export async function parseAndVerifyWeightSpaceModelServingControl(raw: unknown, expected: {
  modelProjectId: string; request: WeightSpaceModelServingControlRequest; actorId?: string;
}) {
  const value = WeightSpaceModelServingControlReceiptSchema.parse(raw), request = WeightSpaceModelServingControlRequestSchema.parse(expected.request);
  const { contentHash, ...content } = value, control = value.control;
  await parseAndVerifyWeightSpaceModelVersion(value.version, { teamId: request.teamId, modelProjectId: expected.modelProjectId,
    ownerUserId: value.actorId });
  if (!managedServingUsageApprovalMatches(request, control) || contentHash !== await canonicalSha256(content) || canonicalJson(value.request) !== canonicalJson(request)
    || value.teamId !== request.teamId || value.modelProjectId !== expected.modelProjectId || expected.actorId !== undefined && value.actorId !== expected.actorId
    || value.version.contentHash !== request.versionHash || control.teamId !== value.teamId || control.modelProjectId !== value.modelProjectId || control.actorId !== value.actorId
    || control.operationId !== request.operationId || control.versionHash !== request.versionHash || control.revision !== request.expectedRevision + 1
    || control.idleTimeoutSeconds !== request.idleTimeoutSeconds || control.desiredState !== (request.action === "activate" ? "active" : "stopped")
    || !validControl(control) || request.action === "activate" && !["starting", "active"].includes(control.phase)
    || request.action === "stop" && !["stopping", "stopped"].includes(control.phase))
    throw new OpenPondProtocolError("weight_space_serving_control_mismatch", "The serving receipt differs from the exact weight-space Model or original control command.");
  return value;
}
export async function parseAndVerifyWeightSpaceModelServing(raw: unknown, expected: {
  teamId: string; modelProjectId: string; versionHash: string; ownerUserId?: string;
}) {
  const value = WeightSpaceModelServingSchema.parse(raw), { contentHash, ...content } = value;
  await verifyManagedServingUsageBilling(value.usageBilling, { ...expected, method: "weight_space_programming" }, value.control);
  await parseAndVerifyWeightSpaceModelVersion(value.version, expected);
  function fail(): never { throw new OpenPondProtocolError("weight_space_model_serving_mismatch", "The serving evidence differs from the exact weight-space Model or retained resource custody."); }
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.modelProjectId !== expected.modelProjectId
    || value.version.contentHash !== expected.versionHash || value.state !== weightSpaceModelServingState(value) || (value.availability.state === "qualified") !== (value.availability.reason === "qualified")
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
export function createWeightSpaceModelServingClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async weightSpaceModelServing(modelProjectId: string, raw: z.infer<typeof WeightSpaceModelServingQuerySchema>, options?: { signal?: AbortSignal; ownerUserId?: string }) {
      const id = Id.parse(modelProjectId), query = WeightSpaceModelServingQuerySchema.parse(raw);
      return parseAndVerifyWeightSpaceModelServing(await request(`/v1/training/models/${encodeURIComponent(id)}/serving?${new URLSearchParams(query)}`, {
        signal: options?.signal,
      }), { modelProjectId: id, ...query, ownerUserId: options?.ownerUserId });
    },
    async controlWeightSpaceModelServing(modelProjectId: string, raw: WeightSpaceModelServingControlRequest, options?: { signal?: AbortSignal; actorId?: string }) {
      const id = Id.parse(modelProjectId), body = WeightSpaceModelServingControlRequestSchema.parse(raw);
      return parseAndVerifyWeightSpaceModelServingControl(await request(`/v1/training/models/${encodeURIComponent(id)}/serving`, {
        method: "POST", body: canonicalJson(body), signal: options?.signal,
      }), { modelProjectId: id, request: body, actorId: options?.actorId });
    },
  };
}
