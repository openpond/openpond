import { ManagedServingUsageApprovalSchema, ManagedServingUsageSnapshotSchema, ManagedServingUsageReviewResultSchema, managedServingUsageApprovalMatches, verifyManagedServingUsageBilling } from "./managed-serving-usage.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { DecisionModelVersionSchema, parseAndVerifyDecisionModelVersion } from "./decision-model-version.js";
import { TrainingServingPoolSchema } from "./model-serving-pool.js";
import { DecisionModelScoreReceiptSchema, parseAndVerifyResolvedDecisionSelection } from "./decision-model-scoring.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const BindingRef = z.object({ id: Id, revision: z.number().int().positive() }).strict();
export const DecisionModelServingQuerySchema = z.object({ teamId: Id, versionHash: Hash }).strict();
export const DecisionModelServingControlRequestSchema = z.object({
  usageApproval: ManagedServingUsageApprovalSchema.optional(),
  schemaVersion: z.literal("openpond.decisionModelServingControlRequest.v1"),
  teamId: Id, operationId: Id, versionHash: Hash,
  expectedRevision: z.number().int().nonnegative(), action: z.enum(["activate", "stop"]),
  idleTimeoutSeconds: z.number().int().min(60).max(3600),
}).strict();
export type DecisionModelServingControlRequest = z.infer<typeof DecisionModelServingControlRequestSchema>;
export const DecisionModelServingControlIntentSchema = DecisionModelServingControlRequestSchema.omit({ operationId: true }).extend({ modelProjectId: Id }).strict();
export const DecisionModelServingControlCommandSchema = z.object({ modelProjectId: Id, request: DecisionModelServingControlRequestSchema }).strict();
export const DecisionModelServingControlSchema = z.object({
  usage: ManagedServingUsageSnapshotSchema.optional(),
  schemaVersion: z.literal("openpond.decisionModelServingControl.v1"),
  teamId: Id, modelProjectId: Id, versionHash: Hash, actorId: Id, operationId: Id,
  revision: z.number().int().positive(), desiredState: z.enum(["active", "stopped"]),
  phase: z.enum(["starting", "active", "stopping", "stopped", "failed"]),
  capacityState: z.enum(["pending", "shared", "retiring", "released"]),
  modelId: z.string().trim().min(1).max(500), poolId: Id.nullable(), binding: BindingRef.nullable(),
  activeRequests: z.number().int().nonnegative(), unsettledRequests: z.number().int().nonnegative(),
  idleTimeoutSeconds: z.number().int().min(60).max(3600), failureCode: Id.nullable(), updatedAt: z.iso.datetime(),
}).strict();
export type DecisionModelServingControl = z.infer<typeof DecisionModelServingControlSchema>;
export const DecisionServingBindingSchema = z.object({
  id: Id, revision: z.number().int().positive(), modelId: z.string().trim().min(1).max(500), poolId: Id, versionHash: Hash,
}).strict();
export const DecisionServingAvailabilitySchema = z.object({
  state: z.enum(["qualified", "unavailable"]),
  reason: z.enum(["qualified", "runtime_unavailable", "artifact_unavailable", "model_mismatch"]),
  runtimeHash: Hash.nullable(),
}).strict();
export const DecisionModelServingContentSchema = z.object({
  usageBilling: ManagedServingUsageReviewResultSchema.optional(),
  schemaVersion: z.literal("openpond.decisionModelServing.v1"),
  teamId: Id, modelProjectId: Id, observedAt: z.iso.datetime(), version: DecisionModelVersionSchema,
  availability: DecisionServingAvailabilitySchema,
  control: DecisionModelServingControlSchema.nullable(), cleanup: z.array(DecisionModelServingControlSchema).max(100),
  pools: z.array(TrainingServingPoolSchema).max(100), bindings: z.array(DecisionServingBindingSchema).max(100),
  lastVerifiedScore: DecisionModelScoreReceiptSchema.nullable(),
  state: z.enum(["unavailable", "inactive", "starting", "active", "retiring"]),
}).strict();
export const DecisionModelServingSchema = DecisionModelServingContentSchema.extend({ contentHash: Hash });
export type DecisionModelServing = z.infer<typeof DecisionModelServingSchema>;
export const DecisionModelServingControlReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionModelServingControlReceipt.v1"), teamId: Id, modelProjectId: Id, actorId: Id,
  request: DecisionModelServingControlRequestSchema, version: DecisionModelVersionSchema, control: DecisionModelServingControlSchema,
}).strict();
export const DecisionModelServingControlReceiptSchema = DecisionModelServingControlReceiptContentSchema.extend({ contentHash: Hash });
export type DecisionModelServingControlReceipt = z.infer<typeof DecisionModelServingControlReceiptSchema>;

function validControl(value: DecisionModelServingControl) {
  return value.modelId === `decision:model:${value.modelProjectId}`
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
export function decisionModelServingState(value: Pick<DecisionModelServing, "availability" | "control" | "cleanup" | "pools" | "bindings">): DecisionModelServing["state"] {
  const control = value.control;
  if (control?.phase === "stopping" || value.cleanup.some(row => row.phase !== "stopped" || !["shared", "released"].includes(row.capacityState))) return "retiring";
  if (value.availability.state !== "qualified" || control?.phase === "failed") return "unavailable";
  if (!control || control.desiredState === "stopped") return value.bindings.length ? "unavailable" : "inactive";
  const binding = control.binding;
  if (control.phase === "active" && binding && value.bindings.some(row => row.id === binding.id && row.revision === binding.revision
    && row.poolId === control.poolId && value.pools.some(pool => pool.id === row.poolId && pool.state === "ready" && pool.endpointRecorded))) return "active";
  return control.phase === "starting" ? "starting" : "unavailable";
}
export async function parseAndVerifyDecisionModelServingControl(raw: unknown, expected: {
  modelProjectId: string; request: DecisionModelServingControlRequest; actorId?: string;
}) {
  const value = DecisionModelServingControlReceiptSchema.parse(raw), request = DecisionModelServingControlRequestSchema.parse(expected.request);
  const { contentHash, ...content } = value, control = value.control;
  await parseAndVerifyDecisionModelVersion(value.version, { teamId: request.teamId, modelProjectId: expected.modelProjectId,
    ownerUserId: value.actorId, versionHash: request.versionHash });
  if (!managedServingUsageApprovalMatches(request, control) || contentHash !== await canonicalSha256(content) || canonicalJson(value.request) !== canonicalJson(request)
    || value.teamId !== request.teamId || value.modelProjectId !== expected.modelProjectId || expected.actorId !== undefined && value.actorId !== expected.actorId
    || control.teamId !== value.teamId || control.modelProjectId !== value.modelProjectId || control.actorId !== value.actorId
    || control.operationId !== request.operationId || control.versionHash !== request.versionHash || control.revision !== request.expectedRevision + 1
    || control.idleTimeoutSeconds !== request.idleTimeoutSeconds || control.desiredState !== (request.action === "activate" ? "active" : "stopped")
    || !validControl(control) || request.action === "activate" && !["starting", "active"].includes(control.phase)
    || request.action === "stop" && !["stopping", "stopped"].includes(control.phase))
    throw new OpenPondProtocolError("decision_serving_control_mismatch", "The serving receipt differs from the exact decision Model or original control command.");
  return value;
}
export async function parseAndVerifyDecisionModelServing(raw: unknown, expected: {
  teamId: string; modelProjectId: string; versionHash: string; ownerUserId?: string;
}) {
  const value = DecisionModelServingSchema.parse(raw), { contentHash, ...content } = value;
  await verifyManagedServingUsageBilling(value.usageBilling, { ...expected, method: "decision" }, value.control);
  await parseAndVerifyDecisionModelVersion(value.version, expected);
  function fail(): never { throw new OpenPondProtocolError("decision_model_serving_mismatch", "The serving evidence differs from the exact decision Model or retained resource custody."); }
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.modelProjectId !== expected.modelProjectId
    || value.state !== decisionModelServingState(value) || (value.availability.state === "qualified") !== (value.availability.reason === "qualified")
    || value.availability.state === "qualified" && value.availability.runtimeHash === null) fail();
  for (const rows of [value.pools, value.bindings]) if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
  for (const control of [...value.cleanup, ...(value.control ? [value.control] : [])])
    if (control.teamId !== expected.teamId || control.modelProjectId !== expected.modelProjectId || !validControl(control)) fail();
  if (new Set(value.cleanup.map(row => row.operationId)).size !== value.cleanup.length || value.cleanup.some(row => row.desiredState !== "stopped")) fail();
  const control = value.control;
  if (control && control.versionHash !== expected.versionHash && !(control.phase === "stopped" && control.desiredState === "stopped")) fail();
  if (value.bindings.some(row => row.versionHash !== expected.versionHash || row.modelId !== `decision:model:${expected.modelProjectId}`
    || !value.pools.some(pool => pool.id === row.poolId))) fail();
  if (control?.binding) {
    const binding = control.binding;
    if (!value.bindings.some(row => row.id === binding.id && row.revision === binding.revision && row.poolId === control.poolId && row.modelId === control.modelId)) fail();
  }
  if (value.pools.some(pool => pool.workersMin > pool.workersMax)) fail();
  const score = value.lastVerifiedScore;
  if (score) {
    const { contentHash: receiptHash, ...receipt } = score, { contentHash: resultHash, ...result } = score.result;
    await parseAndVerifyResolvedDecisionSelection(score.selection, value.version);
    // This read checks retained receipt identity, not the unavailable original
    // raw state/questions. Full score verification requires that original command.
    if (receiptHash !== await canonicalSha256(receipt) || resultHash !== await canonicalSha256(result)
      || score.teamId !== expected.teamId || score.modelProjectId !== expected.modelProjectId
      || score.actorId !== value.version.ownerUserId || score.version.contentHash !== expected.versionHash
      || canonicalJson(score.version) !== canonicalJson(value.version)
      || score.result.modelHash !== await canonicalSha256(value.version.request.model)
      || score.result.runtimeHash !== score.runtimeHash
      || canonicalJson(score.result.artifact) !== canonicalJson({ id: value.version.artifact.id, contentHash: value.version.artifact.contentHash })
      || value.pools.some(pool => pool.id === score.poolId && pool.workerImageDigest !== score.workerImageDigest)) fail();
  }
  return value;
}
export function createDecisionModelServingClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async decisionModelServing(modelProjectId: string, raw: z.infer<typeof DecisionModelServingQuerySchema>, options?: { signal?: AbortSignal; ownerUserId?: string }) {
      const id = Id.parse(modelProjectId), query = DecisionModelServingQuerySchema.parse(raw);
      return parseAndVerifyDecisionModelServing(await request(`/v1/training/models/${encodeURIComponent(id)}/serving?${new URLSearchParams(query)}`, {
        signal: options?.signal,
      }), { modelProjectId: id, ...query, ownerUserId: options?.ownerUserId });
    },
    async controlDecisionModelServing(modelProjectId: string, raw: DecisionModelServingControlRequest, options?: { signal?: AbortSignal; actorId?: string }) {
      const id = Id.parse(modelProjectId), body = DecisionModelServingControlRequestSchema.parse(raw);
      return parseAndVerifyDecisionModelServingControl(await request(`/v1/training/models/${encodeURIComponent(id)}/serving`, {
        method: "POST", body: canonicalJson(body), signal: options?.signal,
      }), { modelProjectId: id, request: body, actorId: options?.actorId });
    },
  };
}
