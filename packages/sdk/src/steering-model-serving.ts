import { WeightSpaceModelServingSchema, parseAndVerifyWeightSpaceModelServing } from "./weight-space-model-serving.js";
import { ManagedServingUsageApprovalSchema, ManagedServingUsageSnapshotSchema, ManagedServingUsageReviewResultSchema, managedServingUsageApprovalMatches, verifyManagedServingUsageBilling } from "./managed-serving-usage.js";
import { EngramModelServingSchema, parseAndVerifyEngramModelServing } from "./engram-model-serving.js";
import { DecisionModelServingSchema, parseAndVerifyDecisionModelServing } from "./decision-model-serving.js";
import { AlphaEditModelServingSchema, parseAndVerifyAlphaEditModelServing } from "./alphaedit-model-serving.js";
import { NeuronTrainingModelServingSchema, parseAndVerifyNeuronTrainingModelServing } from "./neuron-training-model-serving.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { SteeringModelVersionSchema, parseAndVerifySavedModelVersion } from "./steering-profile-publication.js";
import { TrainingModelServingSchema, TrainingModelServingQuerySchema, TrainingServingPoolSchema,
  parseAndVerifyTrainingModelServing } from "./training-model-serving.js";
import { SteeringPublicationReferenceSchema, type SteeringPublicationReference } from "./steering-model-selection.js";
import { SteeringInferenceReceiptSchema, parseAndVerifyResolvedSteeringSelection } from "./steering-inference.js";
export * from "./steering-model-selection.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const BindingRef = z.object({ id: Id, revision: z.number().int().positive() }).strict();
const Timestamp = z.iso.datetime();

export const SteeringModelServingControlRequestSchema = z.object({
  usageApproval: ManagedServingUsageApprovalSchema.optional(),
  schemaVersion: z.literal("openpond.steeringModelServingControlRequest.v1"),
  teamId: Id, operationId: Id, versionHash: Hash,
  expectedRevision: z.number().int().nonnegative(), action: z.enum(["activate", "stop"]),
  defaultPublication: SteeringPublicationReferenceSchema.nullable(),
  idleTimeoutSeconds: z.number().int().min(60).max(3600),
}).strict();
export type SteeringModelServingControlRequest = z.infer<typeof SteeringModelServingControlRequestSchema>;
export const SteeringModelServingControlIntentSchema = SteeringModelServingControlRequestSchema.omit({ operationId: true }).extend({ modelProjectId: Id }).strict();
export const SteeringModelServingControlCommandSchema = z.object({ modelProjectId: Id, request: SteeringModelServingControlRequestSchema }).strict();

export const SteeringModelServingControlSchema = z.object({
  usage: ManagedServingUsageSnapshotSchema.optional(),
  schemaVersion: z.literal("openpond.steeringModelServingControl.v1"),
  teamId: Id, modelProjectId: Id, versionHash: Hash, actorId: Id, operationId: Id,
  revision: z.number().int().positive(), defaultPublication: SteeringPublicationReferenceSchema.nullable(),
  desiredState: z.enum(["active", "stopped"]),
  phase: z.enum(["starting", "active", "stopping", "stopped", "failed"]),
  capacityState: z.enum(["pending", "shared", "retiring", "released"]),
  modelId: Id, poolId: Id.nullable(), binding: BindingRef.nullable(),
  activeRequests: z.number().int().nonnegative(), unsettledRequests: z.number().int().nonnegative(),
  idleTimeoutSeconds: z.number().int().min(60).max(3600), failureCode: Id.nullable(), updatedAt: Timestamp,
}).strict();
export type SteeringModelServingControl = z.infer<typeof SteeringModelServingControlSchema>;

export const SteeringServingBindingSchema = z.object({
  id: Id, revision: z.number().int().positive(), modelId: Id, poolId: Id, versionHash: Hash,
}).strict();
export const SteeringServingAvailabilitySchema = z.object({
  state: z.enum(["qualified", "unavailable"]),
  reason: z.enum(["qualified", "runtime_unavailable", "calibration_unavailable", "profile_archived", "model_mismatch"]),
  runtimeHash: Hash.nullable(),
}).strict();
export const SteeringModelServingContentSchema = z.object({
  usageBilling: ManagedServingUsageReviewResultSchema.optional(),
  schemaVersion: z.literal("openpond.steeringModelServing.v1"),
  teamId: Id, modelProjectId: Id, observedAt: Timestamp, version: SteeringModelVersionSchema,
  defaultPublication: SteeringPublicationReferenceSchema.nullable(),
  availability: SteeringServingAvailabilitySchema,
  control: SteeringModelServingControlSchema.nullable(), cleanup: z.array(SteeringModelServingControlSchema).max(100),
  pools: z.array(TrainingServingPoolSchema).max(100), bindings: z.array(SteeringServingBindingSchema).max(100),
  lastVerifiedInference: SteeringInferenceReceiptSchema.nullable(),
  state: z.enum(["unavailable", "inactive", "starting", "active", "retiring"]),
}).strict();
export const SteeringModelServingSchema = SteeringModelServingContentSchema.extend({ contentHash: Hash }).strict();
export type SteeringModelServing = z.infer<typeof SteeringModelServingSchema>;
export const SavedModelServingSchema = z.discriminatedUnion("schemaVersion", [TrainingModelServingSchema, SteeringModelServingSchema, EngramModelServingSchema, DecisionModelServingSchema, AlphaEditModelServingSchema, NeuronTrainingModelServingSchema, WeightSpaceModelServingSchema]);
export type SavedModelServing = z.infer<typeof SavedModelServingSchema>;
export const SavedModelServingQuerySchema = TrainingModelServingQuerySchema;

export const SteeringModelServingControlReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.steeringModelServingControlReceipt.v1"),
  teamId: Id, modelProjectId: Id, actorId: Id,
  request: SteeringModelServingControlRequestSchema, version: SteeringModelVersionSchema,
  control: SteeringModelServingControlSchema,
}).strict();
export const SteeringModelServingControlReceiptSchema = SteeringModelServingControlReceiptContentSchema.extend({ contentHash: Hash }).strict();
export type SteeringModelServingControlReceipt = z.infer<typeof SteeringModelServingControlReceiptSchema>;

function sameRef(a: SteeringPublicationReference | null, b: SteeringPublicationReference | null) { return canonicalJson(a) === canonicalJson(b); }
function publicationRef(version: z.infer<typeof SteeringModelVersionSchema>): SteeringPublicationReference {
  const { id, revision, contentHash } = version.publication;
  return { id, revision, contentHash };
}
function validControl(value: SteeringModelServingControl) {
  return value.modelId === `personalized:model:${value.modelProjectId}`
    && (!value.binding || value.poolId !== null)
    && (value.phase !== "active" || value.desiredState === "active" && value.poolId !== null && value.binding !== null
      && ["pending", "shared"].includes(value.capacityState))
    && (value.phase !== "stopping" || value.desiredState === "stopped")
    && (value.capacityState !== "released" || !value.binding && value.activeRequests === 0 && value.unsettledRequests === 0)
    && (value.phase !== "stopped" || value.desiredState === "stopped" && !value.binding
      && value.activeRequests === 0 && value.unsettledRequests === 0 && ["shared", "released"].includes(value.capacityState));
}

export function steeringModelServingState(value: Pick<SteeringModelServing, "availability" | "control" | "cleanup" | "pools" | "bindings">): SteeringModelServing["state"] {
  const control = value.control;
  if (control?.phase === "stopping" || value.cleanup.some(row => row.phase !== "stopped" || !["shared", "released"].includes(row.capacityState))) return "retiring";
  if (value.availability.state !== "qualified" || control?.phase === "failed") return "unavailable";
  if (!control || control.desiredState === "stopped") return value.bindings.length ? "unavailable" : "inactive";
  const binding = control.binding;
  if (control.phase === "active" && binding && value.bindings.some(row => row.id === binding.id && row.revision === binding.revision
    && row.poolId === control.poolId && value.pools.some(pool => pool.id === row.poolId && pool.state === "ready" && pool.endpointRecorded))) return "active";
  return control.phase === "starting" ? "starting" : "unavailable";
}

export async function parseAndVerifySteeringModelServingControl(raw: unknown, expected: {
  modelProjectId: string; request: SteeringModelServingControlRequest; actorId?: string;
}) {
  const value = SteeringModelServingControlReceiptSchema.parse(raw), request = SteeringModelServingControlRequestSchema.parse(expected.request);
  const { contentHash, ...content } = value, control = value.control;
  await parseAndVerifySavedModelVersion(value.version, { teamId: request.teamId, modelProjectId: expected.modelProjectId });
  if (!managedServingUsageApprovalMatches(request, control) || contentHash !== await canonicalSha256(content) || canonicalJson(value.request) !== canonicalJson(request)
    || value.teamId !== request.teamId || value.modelProjectId !== expected.modelProjectId || expected.actorId && value.actorId !== expected.actorId
    || value.version.contentHash !== request.versionHash || request.defaultPublication !== null && !sameRef(request.defaultPublication, publicationRef(value.version))
    || control.teamId !== value.teamId || control.modelProjectId !== value.modelProjectId || control.actorId !== value.actorId
    || control.operationId !== request.operationId || control.versionHash !== request.versionHash || control.revision !== request.expectedRevision + 1
    || control.idleTimeoutSeconds !== request.idleTimeoutSeconds || !sameRef(control.defaultPublication, request.defaultPublication)
    || control.desiredState !== (request.action === "activate" ? "active" : "stopped") || !validControl(control)
    || request.action === "activate" && !["starting", "active"].includes(control.phase)
    || request.action === "stop" && !["stopping", "stopped"].includes(control.phase))
    throw new OpenPondProtocolError("steering_serving_control_mismatch", "The serving receipt differs from the exact saved steering Model, default or original command.");
  return value;
}

export async function parseAndVerifySteeringModelServing(raw: unknown, expected: { teamId: string; modelProjectId: string; versionHash: string }) {
  const value = SteeringModelServingSchema.parse(raw), { contentHash, ...content } = value;
  await verifyManagedServingUsageBilling(value.usageBilling, { ...expected, method: "steering" }, value.control);
  await parseAndVerifySavedModelVersion(value.version, expected);
  function fail(): never { throw new OpenPondProtocolError("steering_model_serving_mismatch", "The serving evidence differs from the exact saved steering Model or retained capacity."); }
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.modelProjectId !== expected.modelProjectId
    || value.version.contentHash !== expected.versionHash || value.defaultPublication !== null && !sameRef(value.defaultPublication, publicationRef(value.version))
    || value.state !== steeringModelServingState(value) || (value.availability.state === "qualified") !== (value.availability.reason === "qualified")
    || value.availability.state === "qualified" && value.availability.runtimeHash === null) fail();
  for (const rows of [value.pools, value.bindings]) if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
  for (const control of [...value.cleanup, ...(value.control ? [value.control] : [])]) {
    if (control.teamId !== expected.teamId || control.modelProjectId !== expected.modelProjectId || !validControl(control)) fail();
  }
  if (new Set(value.cleanup.map(row => row.operationId)).size !== value.cleanup.length || value.cleanup.some(row => row.desiredState !== "stopped")) fail();
  const control = value.control;
  if (control && (control.versionHash !== expected.versionHash && !(control.phase === "stopped" && control.desiredState === "stopped")
    || control.versionHash === expected.versionHash && !sameRef(control.defaultPublication, value.defaultPublication))) fail();
  if (value.bindings.some(row => row.versionHash !== expected.versionHash || row.modelId !== `personalized:model:${expected.modelProjectId}`
    || !value.pools.some(pool => pool.id === row.poolId))) fail();
  if (control?.binding && !value.bindings.some(row => row.id === control.binding!.id && row.revision === control.binding!.revision
    && row.poolId === control.poolId && row.modelId === control.modelId)) fail();
  if (value.pools.some(pool => pool.workersMin > pool.workersMax)) fail();
  const inference = value.lastVerifiedInference;
  if (inference) {
    const { contentHash: hash, ...receipt } = inference;
    await parseAndVerifyResolvedSteeringSelection(inference.selection, {
      ...(inference.selection.savedModel === null ? {} : { savedModel: inference.selection.savedModel }),
      ...(inference.selection.requested === "inherit" ? {} : { steering: inference.selection.requested === "off" ? null : inference.selection.effectivePublication }),
    });
    const knownPublication = publicationRef(value.version), profile = value.version.publication.profile;
    const calibration = profile.normalization.mode === "fixed_residual_reference" ? profile.normalization.calibration : null;
    if (inference.selection.defaultPublication !== null && !sameRef(inference.selection.defaultPublication, knownPublication)
      || sameRef(inference.selection.effectivePublication, knownPublication) && (inference.selection.profileHash !== profile.contentHash
        || canonicalJson(inference.selection.calibration) !== canonicalJson(calibration))) fail();
    if (hash !== await canonicalSha256(receipt) || inference.teamId !== expected.teamId || inference.selection.savedModel?.modelProjectId !== expected.modelProjectId
      || inference.selection.savedModel.versionHash !== expected.versionHash
      || inference.selection.modelHash !== await canonicalSha256(value.version.publication.profile.model)
      || value.pools.some(pool => pool.id === inference.poolId && pool.workerImageDigest !== inference.workerImageDigest)) fail();
  }
  return value;
}

export async function parseAndVerifySavedModelServing(raw: unknown, expected: { teamId: string; modelProjectId: string; versionHash: string }): Promise<SavedModelServing> {
  const value = SavedModelServingSchema.parse(raw);
  if (value.schemaVersion === "openpond.alphaEditModelServing.v1") return parseAndVerifyAlphaEditModelServing(value, expected);
  if (value.schemaVersion === "openpond.weightSpaceModelServing.v1") return parseAndVerifyWeightSpaceModelServing(value, expected);
  if (value.schemaVersion === "openpond.neuronTrainingModelServing.v1") return parseAndVerifyNeuronTrainingModelServing(value, expected);
  return value.schemaVersion === "openpond.trainingModelServing.v1"
    ? parseAndVerifyTrainingModelServing(value, expected) : value.schemaVersion === "openpond.engramModelServing.v1"
      ? parseAndVerifyEngramModelServing(value, expected) : value.schemaVersion === "openpond.decisionModelServing.v1"
        ? parseAndVerifyDecisionModelServing(value, expected) : parseAndVerifySteeringModelServing(value, expected);
}

export function createSavedModelServingClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async savedModelServing(modelProjectId: string, raw: z.infer<typeof SavedModelServingQuerySchema>) {
      const id = Id.parse(modelProjectId), query = SavedModelServingQuerySchema.parse(raw);
      return parseAndVerifySavedModelServing(await request(`/v1/training/models/${encodeURIComponent(id)}/serving?${new URLSearchParams(query)}`), { modelProjectId: id, ...query });
    },
    async controlSteeringModelServing(modelProjectId: string, raw: SteeringModelServingControlRequest) {
      const id = Id.parse(modelProjectId), body = SteeringModelServingControlRequestSchema.parse(raw);
      return parseAndVerifySteeringModelServingControl(await request(`/v1/training/models/${encodeURIComponent(id)}/serving`, {
        method: "POST", body: JSON.stringify(body),
      }), { modelProjectId: id, request: body });
    },
  };
}
