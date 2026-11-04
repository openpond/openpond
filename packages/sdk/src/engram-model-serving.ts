import { ManagedServingUsageApprovalSchema, ManagedServingUsageSnapshotSchema, ManagedServingUsageReviewResultSchema, managedServingUsageApprovalMatches, verifyManagedServingUsageBilling } from "./managed-serving-usage.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { EngramModelVersionSchema, parseAndVerifyEngramModelVersion } from "./engram-model-version.js";
import { TrainingServingPoolSchema } from "./model-serving-pool.js";
import { EngramInferenceReceiptSchema, parseAndVerifyResolvedEngramSelection } from "./engram-inference.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const BindingRef = z.object({ id: Id, revision: z.number().int().positive() }).strict();
const Timestamp = z.iso.datetime();

export const EngramModelServingControlRequestSchema = z.object({
  usageApproval: ManagedServingUsageApprovalSchema.optional(),
  schemaVersion: z.literal("openpond.engramModelServingControlRequest.v1"),
  teamId: Id, operationId: Id, versionHash: Hash,
  expectedRevision: z.number().int().nonnegative(), action: z.enum(["activate", "stop"]),
  defaultEnabled: z.boolean(),
  idleTimeoutSeconds: z.number().int().min(60).max(3600),
}).strict();
export type EngramModelServingControlRequest = z.infer<typeof EngramModelServingControlRequestSchema>;
export const EngramModelServingControlIntentSchema = EngramModelServingControlRequestSchema.omit({ operationId: true }).extend({ modelProjectId: Id }).strict();
export const EngramModelServingControlCommandSchema = z.object({ modelProjectId: Id, request: EngramModelServingControlRequestSchema }).strict();

export const EngramModelServingControlSchema = z.object({
  usage: ManagedServingUsageSnapshotSchema.optional(),
  schemaVersion: z.literal("openpond.engramModelServingControl.v1"),
  teamId: Id, modelProjectId: Id, versionHash: Hash, actorId: Id, operationId: Id,
  revision: z.number().int().positive(), defaultEnabled: z.boolean(),
  desiredState: z.enum(["active", "stopped"]),
  phase: z.enum(["starting", "active", "stopping", "stopped", "failed"]),
  capacityState: z.enum(["pending", "shared", "retiring", "released"]),
  modelId: Id, poolId: Id.nullable(), binding: BindingRef.nullable(),
  activeRequests: z.number().int().nonnegative(), unsettledRequests: z.number().int().nonnegative(),
  idleTimeoutSeconds: z.number().int().min(60).max(3600), failureCode: Id.nullable(), updatedAt: Timestamp,
}).strict();
export type EngramModelServingControl = z.infer<typeof EngramModelServingControlSchema>;

export const EngramServingBindingSchema = z.object({
  id: Id, revision: z.number().int().positive(), modelId: Id, poolId: Id, versionHash: Hash,
}).strict();
export const EngramServingAvailabilitySchema = z.object({
  state: z.enum(["qualified", "unavailable"]),
  reason: z.enum(["qualified", "runtime_unavailable", "module_unavailable", "model_mismatch"]),
  runtimeHash: Hash.nullable(),
}).strict();
export const EngramModelServingContentSchema = z.object({
  usageBilling: ManagedServingUsageReviewResultSchema.optional(),
  schemaVersion: z.literal("openpond.engramModelServing.v1"),
  teamId: Id, modelProjectId: Id, observedAt: Timestamp, version: EngramModelVersionSchema,
  defaultEnabled: z.boolean(),
  availability: EngramServingAvailabilitySchema,
  control: EngramModelServingControlSchema.nullable(), cleanup: z.array(EngramModelServingControlSchema).max(100),
  pools: z.array(TrainingServingPoolSchema).max(100), bindings: z.array(EngramServingBindingSchema).max(100),
  lastVerifiedInference: EngramInferenceReceiptSchema.nullable(),
  state: z.enum(["unavailable", "inactive", "starting", "active", "retiring"]),
}).strict();
export const EngramModelServingSchema = EngramModelServingContentSchema.extend({ contentHash: Hash }).strict();
export type EngramModelServing = z.infer<typeof EngramModelServingSchema>;
export const EngramModelServingControlReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.engramModelServingControlReceipt.v1"),
  teamId: Id, modelProjectId: Id, actorId: Id,
  request: EngramModelServingControlRequestSchema, version: EngramModelVersionSchema,
  control: EngramModelServingControlSchema,
}).strict();
export const EngramModelServingControlReceiptSchema = EngramModelServingControlReceiptContentSchema.extend({ contentHash: Hash }).strict();
export type EngramModelServingControlReceipt = z.infer<typeof EngramModelServingControlReceiptSchema>;

function validControl(value: EngramModelServingControl) {
  return value.modelId === `personalized:model:${value.modelProjectId}`
    && (!value.binding || value.poolId !== null)
    && (value.phase !== "active" || value.desiredState === "active" && value.poolId !== null && value.binding !== null
      && ["pending", "shared"].includes(value.capacityState))
    && (value.phase !== "stopping" || value.desiredState === "stopped")
    && (value.capacityState !== "released" || !value.binding && value.activeRequests === 0 && value.unsettledRequests === 0)
    && (value.phase !== "stopped" || value.desiredState === "stopped" && !value.binding
      && value.activeRequests === 0 && value.unsettledRequests === 0 && ["shared", "released"].includes(value.capacityState));
}

export function engramModelServingState(value: Pick<EngramModelServing, "availability" | "control" | "cleanup" | "pools" | "bindings">): EngramModelServing["state"] {
  const control = value.control;
  if (control?.phase === "stopping" || value.cleanup.some(row => row.phase !== "stopped" || !["shared", "released"].includes(row.capacityState))) return "retiring";
  if (value.availability.state !== "qualified" || control?.phase === "failed") return "unavailable";
  if (!control || control.desiredState === "stopped") return value.bindings.length ? "unavailable" : "inactive";
  const binding = control.binding;
  if (control.phase === "active" && binding && value.bindings.some(row => row.id === binding.id && row.revision === binding.revision
    && row.poolId === control.poolId && value.pools.some(pool => pool.id === row.poolId && pool.state === "ready" && pool.endpointRecorded))) return "active";
  return control.phase === "starting" ? "starting" : "unavailable";
}

export async function parseAndVerifyEngramModelServingControl(raw: unknown, expected: {
  modelProjectId: string; request: EngramModelServingControlRequest; actorId?: string;
}) {
  const value = EngramModelServingControlReceiptSchema.parse(raw), request = EngramModelServingControlRequestSchema.parse(expected.request);
  const {contentHash, ...content} = value, control = value.control;
  await parseAndVerifyEngramModelVersion(value.version, {teamId: request.teamId, modelProjectId: expected.modelProjectId});
  if (!managedServingUsageApprovalMatches(request, control) || contentHash !== await canonicalSha256(content) || canonicalJson(value.request) !== canonicalJson(request)
    || value.teamId !== request.teamId || value.modelProjectId !== expected.modelProjectId || expected.actorId && value.actorId !== expected.actorId
    || value.version.contentHash !== request.versionHash || control.teamId !== value.teamId || control.modelProjectId !== value.modelProjectId
    || control.actorId !== value.actorId || control.operationId !== request.operationId || control.versionHash !== request.versionHash
    || control.revision !== request.expectedRevision + 1 || control.idleTimeoutSeconds !== request.idleTimeoutSeconds
    || control.defaultEnabled !== request.defaultEnabled || control.desiredState !== (request.action === "activate" ? "active" : "stopped")
    || !validControl(control) || request.action === "activate" && !["starting", "active"].includes(control.phase)
    || request.action === "stop" && !["stopping", "stopped"].includes(control.phase))
    throw new OpenPondProtocolError("engram_serving_control_mismatch", "The serving receipt differs from the exact memory Model or original command.");
  return value;
}

export async function parseAndVerifyEngramModelServing(raw: unknown, expected: {teamId: string; modelProjectId: string; versionHash: string}) {
  const value = EngramModelServingSchema.parse(raw), {contentHash, ...content} = value;
  await verifyManagedServingUsageBilling(value.usageBilling, { ...expected, method: "engram" }, value.control);
  await parseAndVerifyEngramModelVersion(value.version, expected);
  function fail(): never {throw new OpenPondProtocolError("engram_model_serving_mismatch", "The serving evidence differs from the exact memory Model or retained capacity.");}
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.modelProjectId !== expected.modelProjectId
    || value.version.contentHash !== expected.versionHash || value.state !== engramModelServingState(value)
    || (value.availability.state === "qualified") !== (value.availability.reason === "qualified")
    || value.availability.state === "qualified" && value.availability.runtimeHash === null) fail();
  for (const rows of [value.pools, value.bindings]) if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
  for (const control of [...value.cleanup, ...(value.control ? [value.control] : [])])
    if (control.teamId !== expected.teamId || control.modelProjectId !== expected.modelProjectId || !validControl(control)) fail();
  if (new Set(value.cleanup.map(row => row.operationId)).size !== value.cleanup.length || value.cleanup.some(row => row.desiredState !== "stopped")) fail();
  const control = value.control;
  if (control && (control.versionHash !== expected.versionHash && !(control.phase === "stopped" && control.desiredState === "stopped")
    || control.versionHash === expected.versionHash && control.defaultEnabled !== value.defaultEnabled)) fail();
  if (value.bindings.some(row => row.versionHash !== expected.versionHash || row.modelId !== `personalized:model:${expected.modelProjectId}`
    || !value.pools.some(pool => pool.id === row.poolId))) fail();
  if (control?.binding && !value.bindings.some(row => row.id === control.binding!.id && row.revision === control.binding!.revision
    && row.poolId === control.poolId && row.modelId === control.modelId)) fail();
  if (value.pools.some(pool => pool.workersMin > pool.workersMax)) fail();
  const inference = value.lastVerifiedInference;
  if (inference) {
    const {contentHash: hash, ...receipt} = inference;
    parseAndVerifyResolvedEngramSelection(inference.selection, {savedModel: inference.selection.savedModel,
      ...(inference.selection.requested === "inherit" ? {} : {engram: inference.selection.requested === "on"})});
    if (hash !== await canonicalSha256(receipt) || inference.teamId !== expected.teamId
      || inference.selection.savedModel.modelProjectId !== expected.modelProjectId || inference.selection.savedModel.versionHash !== expected.versionHash
      || inference.selection.module.id !== value.version.artifact.id || inference.selection.module.contentHash !== value.version.artifact.contentHash
      || inference.selection.module.payloadSha256 !== value.version.artifact.manifest.payload.sha256
      || inference.selection.modelHash !== await canonicalSha256(value.version.artifact.manifest.pins.baseModel)
      || value.pools.some(pool => pool.id === inference.poolId && pool.workerImageDigest !== inference.workerImageDigest)) fail();
  }
  return value;
}
export function createEngramModelServingClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {async controlEngramModelServing(modelProjectId: string, raw: EngramModelServingControlRequest) {
    const id = Id.parse(modelProjectId), body = EngramModelServingControlRequestSchema.parse(raw);
    return parseAndVerifyEngramModelServingControl(await request(`/v1/training/models/${encodeURIComponent(id)}/serving`, {
      method: "POST", body: canonicalJson(body),
    }), {modelProjectId: id, request: body});
  }};
}
