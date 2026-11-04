import { z } from "zod";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { DecisionModelVersionSchema, parseAndVerifyDecisionModelVersion, type DecisionModelVersion } from "./decision-model-version.js";
import { DecisionScoringInputSchema, DecisionScoringRequestSchema, DecisionScoringResultSchema,
  parseAndVerifyDecisionScoringRequest, parseAndVerifyDecisionScoringResult } from "./decision-model-data.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Binding = z.object({ id: Id, revision: z.number().int().positive() }).strict();
export const SavedDecisionModelSelectionSchema = z.object({ modelProjectId: Id, versionHash: Hash }).strict();
export const ResolvedDecisionSelectionSchema = z.object({
  schemaVersion: z.literal("openpond.resolvedDecisionSelection.v1"),
  savedModel: SavedDecisionModelSelectionSchema, modelHash: Hash,
  artifact: z.object({ id: Id, contentHash: Hash, payloadSha256: Hash }).strict(),
}).strict();
export type ResolvedDecisionSelection = z.infer<typeof ResolvedDecisionSelectionSchema>;

/** The exact version is required; omitted/current/latest versions and generic
 * chat completions cannot substitute for this typed candidate scorer. requestId
 * is retained for original-operation reconciliation after an ambiguous reply. */
export const DecisionModelScoreRequestSchema = z.object({
  schemaVersion: z.literal("openpond.decisionModelScoreRequest.v1"),
  teamId: Id, requestId: Id, versionHash: Hash,
  input: DecisionScoringInputSchema, limits: DecisionScoringRequestSchema.shape.limits,
}).strict();
export type DecisionModelScoreRequest = z.infer<typeof DecisionModelScoreRequestSchema>;
export function parseDecisionModelScoreRequest(raw: unknown) {
  assertBoundedTaskJson(raw, 131_072);
  return DecisionModelScoreRequestSchema.parse(raw);
}
export async function resolvedDecisionSelection(raw: DecisionModelVersion): Promise<ResolvedDecisionSelection> {
  const version = await parseAndVerifyDecisionModelVersion(raw);
  return ResolvedDecisionSelectionSchema.parse({
    schemaVersion: "openpond.resolvedDecisionSelection.v1",
    savedModel: { modelProjectId: version.modelProjectId, versionHash: version.contentHash },
    modelHash: await canonicalSha256(version.request.model),
    artifact: { id: version.artifact.id, contentHash: version.artifact.contentHash,
      payloadSha256: version.artifact.manifest.payload.sha256 },
  });
}
export async function parseAndVerifyResolvedDecisionSelection(raw: unknown, version: DecisionModelVersion) {
  const value = ResolvedDecisionSelectionSchema.parse(raw);
  if (canonicalJson(value) !== canonicalJson(await resolvedDecisionSelection(version)))
    throw new OpenPondProtocolError("decision_selection_mismatch", "The scorer selected a different exact decision Model or adapter.");
  return value;
}

export const DecisionModelScoreReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionModelScoreReceipt.v1"),
  teamId: Id, actorId: Id, modelProjectId: Id, requestId: Id, requestHash: Hash,
  version: DecisionModelVersionSchema, selection: ResolvedDecisionSelectionSchema,
  result: DecisionScoringResultSchema,
  poolId: Id, routingBinding: Binding, runtimeHash: Hash,
  workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  engineGeneration: z.number().int().positive(), cacheNamespace: Hash,
  cleanupComplete: z.literal(true), completedAt: z.iso.datetime(),
}).strict();
export const DecisionModelScoreReceiptSchema = DecisionModelScoreReceiptContentSchema.extend({ contentHash: Hash });
export type DecisionModelScoreReceipt = z.infer<typeof DecisionModelScoreReceiptSchema>;
export type DecisionScoreAdmissionExpectation = {
  poolId: string; routingBinding: { id: string; revision: number };
  runtimeHash: string; workerImageDigest: string; engineGeneration?: number; cacheNamespace?: string;
};

/** Pool, engine generation and cache custody are server-attested receipt
 * values. Callers may additionally compare their independently retained
 * admission evidence; a self-consistent JSON hash alone is not worker proof.
 * The nested result separately binds the exact typed scoring input and checks
 * every finite candidate probability, rather than trusting generated JSON or
 * a partial vocabulary/logprob response. */
export async function parseAndVerifyDecisionModelScoreReceipt(raw: unknown, expected: {
  modelProjectId: string; request: DecisionModelScoreRequest; actorId?: string;
  admission?: DecisionScoreAdmissionExpectation;
}) {
  assertBoundedTaskJson(raw, 1_048_576);
  const request = parseDecisionModelScoreRequest(expected.request);
  const value = DecisionModelScoreReceiptSchema.parse(raw), { contentHash, ...content } = value;
  const version = await parseAndVerifyDecisionModelVersion(value.version, {
    teamId: request.teamId, modelProjectId: expected.modelProjectId,
    ownerUserId: value.actorId, versionHash: request.versionHash,
  });
  await parseAndVerifyResolvedDecisionSelection(value.selection, version);
  const scoringRequest = await parseAndVerifyDecisionScoringRequest({
    schemaVersion: "openpond.decisionScoringRequest.v1", model: version.request.model,
    artifact: { id: version.artifact.id, contentHash: version.artifact.contentHash }, input: request.input, limits: request.limits,
  });
  await parseAndVerifyDecisionScoringResult(value.result, { request: scoringRequest, runtimeHash: value.runtimeHash });
  function fail(): never { throw new OpenPondProtocolError("decision_model_score_mismatch", "The completed score differs from the exact Model, original request or admitted runtime."); }
  if (contentHash !== await canonicalSha256(content) || value.teamId !== request.teamId
    || value.modelProjectId !== expected.modelProjectId || value.requestId !== request.requestId
    || expected.actorId !== undefined && value.actorId !== expected.actorId
    || value.requestHash !== await canonicalSha256({ modelProjectId: expected.modelProjectId, request })) fail();
  const admission = expected.admission;
  if (admission && (value.poolId !== admission.poolId || canonicalJson(value.routingBinding) !== canonicalJson(admission.routingBinding)
    || value.runtimeHash !== admission.runtimeHash || value.workerImageDigest !== admission.workerImageDigest
    || admission.engineGeneration !== undefined && value.engineGeneration !== admission.engineGeneration
    || admission.cacheNamespace !== undefined && value.cacheNamespace !== admission.cacheNamespace)) fail();
  return value;
}
export function createDecisionModelScoringClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async scoreDecisionModel(modelProjectId: string, raw: DecisionModelScoreRequest, options?: {
      signal?: AbortSignal; actorId?: string; admission?: DecisionScoreAdmissionExpectation;
    }) {
      const id = Id.parse(modelProjectId), body = parseDecisionModelScoreRequest(raw);
      return parseAndVerifyDecisionModelScoreReceipt(await request(`/v1/training/models/${encodeURIComponent(id)}/decisions`, {
        method: "POST", body: canonicalJson(body), signal: options?.signal,
      }), { modelProjectId: id, request: body, actorId: options?.actorId, admission: options?.admission });
    },
  };
}
