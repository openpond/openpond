import { ManagedServingUsageReviewResultSchema, verifyManagedServingUsageBilling } from "./managed-serving-usage.js";
import { ServerlessServingReviewSchema, verifyServerlessServingReview } from "./serverless-serving.js";
import { TrainingServingPoolSchema } from "./model-serving-pool.js";
export { TrainingServingPoolSchema, MODEL_SERVING_IDLE_TIMEOUT_SECONDS } from "./model-serving-pool.js";
import { z } from "zod";
import { ModelProjectImmutableRefSchema } from "./model-projects.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { TrainingModelVersionSchema, parseAndVerifyTrainingModelVersion } from "./training-result.js";
import { TrainingModelServingControlSchema } from "./training-model-serving-control.js";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.string().datetime({ offset: true });
export const TrainingModelServingQuerySchema = z.object({ teamId: Id, versionHash: Hash }).strict();
export const TrainingServingVersionSchema = z.lazy(() => TrainingModelVersionSchema);
export const TrainingServingRegistrySchema = z.object({
  artifact: ModelProjectImmutableRefSchema, baseProfileId: Id, state: Id, qualified: z.boolean(), revoked: z.boolean(), deleted: z.boolean(),
  reason: z.enum(["qualified", "evaluation_pending", "post_training_pending", "evaluation_failed", "candidate_rejected", "artifact_revoked", "artifact_deleted", "runtime_unavailable"]),
  source: z.object({ jobId: Id, artifact: ModelProjectImmutableRefSchema, checkpointId: Id }).strict(),
}).strict();
export const TrainingServingDeploymentSchema = z.object({
  id: Id, artifactId: Id, poolId: Id.nullable(), revision: z.number().int().positive(),
  state: z.enum(["requested", "deploying", "ready", "degraded", "deleting", "deleted", "failed"]),
  revoked: z.boolean(), lastReadyCheckAt: Timestamp.nullable(), updatedAt: Timestamp,
}).strict();
export const TrainingServingBindingSchema = z.object({ id: Id, modelId: Id, artifactId: Id, deploymentId: Id, revision: z.number().int().positive() }).strict();
export const TrainingServingLoadEvidenceSchema = z.object({
  requestId: Id, receipt: ModelProjectImmutableRefSchema, artifact: ModelProjectImmutableRefSchema,
  deploymentId: Id, poolId: Id, workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), completedAt: Timestamp,
}).strict();
export const TrainingModelServingContentSchema = z.object({
  serverlessReview: ServerlessServingReviewSchema.nullable().optional(),
  usageBilling: ManagedServingUsageReviewResultSchema.optional(),
  schemaVersion: z.literal("openpond.trainingModelServing.v1"), teamId: Id, modelProjectId: Id, observedAt: Timestamp,
  version: TrainingServingVersionSchema, registry: TrainingServingRegistrySchema.nullable(),
  control: TrainingModelServingControlSchema.nullable(),
  cleanup: z.array(TrainingModelServingControlSchema).max(100),
  deployments: z.array(TrainingServingDeploymentSchema).max(100), pools: z.array(TrainingServingPoolSchema).max(100),
  bindings: z.array(TrainingServingBindingSchema).max(100), lastVerifiedInference: TrainingServingLoadEvidenceSchema.nullable(),
  state: z.enum(["unpublished", "qualification_pending", "unavailable", "inactive", "starting", "active", "retiring"]),
}).strict();
export const TrainingModelServingSchema = TrainingModelServingContentSchema.extend({ contentHash: Hash }).strict();
export type TrainingModelServing = z.infer<typeof TrainingModelServingSchema>;

/** Active means a routable, eligible deployment. Worker residency and provider
 * scale-to-zero are separate observations; a past inference is historical. */
export function trainingModelServingState(value: Pick<TrainingModelServing, "registry" | "deployments" | "pools" | "bindings" | "control">): TrainingModelServing["state"] {
  if (value.control?.desiredState === "stopped") return value.control.phase === "stopping" ? "retiring" : value.bindings.length ? "unavailable" : "inactive";
  if (value.control?.phase === "failed") return "unavailable";
  if (!value.registry) return "unpublished";
  if (!value.registry.qualified) return ["evaluation_pending", "post_training_pending"].includes(value.registry.reason) ? "qualification_pending" : "unavailable";
  const pools = new Map(value.pools.map(pool => [pool.id, pool]));
  if (value.bindings.some(binding => value.deployments.some(deployment => deployment.id === binding.deploymentId
    && deployment.state === "ready" && !deployment.revoked && deployment.poolId
    && pools.get(deployment.poolId)?.state === "ready" && pools.get(deployment.poolId)?.endpointRecorded))) return "active";
  if (value.control?.desiredState === "active" && value.control.phase === "starting") return "starting";
  if (value.deployments.some(deployment => ["requested", "deploying"].includes(deployment.state)
    || deployment.poolId && ["requested", "provisioning"].includes(pools.get(deployment.poolId)?.state ?? ""))) return "starting";
  if (value.deployments.some(deployment => deployment.state === "deleting") || value.pools.some(pool => pool.state === "deleting")) return "retiring";
  return value.bindings.length ? "unavailable" : "inactive";
}

export async function parseAndVerifyTrainingModelServing(raw: unknown, expected: { modelProjectId: string; teamId: string; versionHash: string }) {
  const value = TrainingModelServingSchema.parse(raw), { contentHash, ...content } = value;
  await verifyManagedServingUsageBilling(value.usageBilling, { ...expected, method: "training" }, value.control);
  for (const pair of [
    {review: value.serverlessReview, versionHash: expected.versionHash, artifact: value.registry?.artifact},
    {review: value.control?.serverless?.review, versionHash: value.control?.versionHash, artifact: value.control?.artifact},
  ]) {
    const {review} = pair;
    if (!review) continue;
    await verifyServerlessServingReview(review, {teamId: expected.teamId, modelProjectId: expected.modelProjectId,
      versionHash: pair.versionHash!, artifact: pair.artifact});
  }
  await parseAndVerifyTrainingModelVersion(value.version, expected);
  function fail(): never { throw new OpenPondProtocolError("training_model_serving_mismatch", "Serving evidence differs from the exact saved Model, registry or deployment."); }
  if (value.teamId !== expected.teamId || value.modelProjectId !== expected.modelProjectId || value.version.contentHash !== expected.versionHash
    || contentHash !== await canonicalSha256(content) || value.state !== trainingModelServingState(value)) fail();
  for (const rows of [value.deployments, value.pools, value.bindings]) if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
  const registry = value.registry;
  const control = value.control;
  if (new Set(value.cleanup.map(row => row.operationId)).size !== value.cleanup.length || value.cleanup.some(row =>
    row.teamId !== expected.teamId || row.modelProjectId !== expected.modelProjectId || row.desiredState !== "stopped")) fail();
  if (control && (control.teamId !== expected.teamId || control.modelProjectId !== expected.modelProjectId
    || control.versionHash !== value.version.contentHash && !(control.desiredState === "stopped" && control.phase === "stopped")
    || control.desiredState === "active" && registry && (control.artifact.id !== registry.artifact.id || control.artifact.contentHash !== registry.artifact.contentHash))) fail();
  if (!registry) { if (value.deployments.length || value.pools.length || value.bindings.length || value.lastVerifiedInference) fail(); return value; }
  if (registry.source.jobId !== value.version.jobId || registry.source.checkpointId !== value.version.candidate.checkpointId
    || registry.source.artifact.id !== value.version.candidate.artifact.id || registry.source.artifact.contentHash !== value.version.candidate.artifact.contentHash
    || registry.qualified !== (registry.reason === "qualified")
    || registry.qualified && (registry.state !== "promotable" || registry.revoked || registry.deleted)) fail();
  const deployments = new Map(value.deployments.map(row => [row.id, row]));
  const pools = new Map(value.pools.map(row => [row.id, row]));
  if (value.deployments.some(row => row.artifactId !== registry.artifact.id || row.poolId && !pools.has(row.poolId))
    || value.bindings.some(row => row.artifactId !== registry.artifact.id || !deployments.has(row.deploymentId))
    || value.pools.some(pool => pool.workersMin > pool.workersMax || !value.deployments.some(row => row.poolId === pool.id))) fail();
  const evidence = value.lastVerifiedInference;
  if (evidence && (evidence.artifact.id !== registry.artifact.id || evidence.artifact.contentHash !== registry.artifact.contentHash
    || deployments.get(evidence.deploymentId)?.poolId !== evidence.poolId
    || pools.get(evidence.poolId)?.workerImageDigest !== evidence.workerImageDigest || evidence.receipt.id !== evidence.requestId)) fail();
  return value;
}

export function createTrainingModelServingClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return { async modelServing(modelProjectId: string, raw: z.infer<typeof TrainingModelServingQuerySchema>) {
    const id = Id.parse(modelProjectId), query = TrainingModelServingQuerySchema.parse(raw);
    return parseAndVerifyTrainingModelServing(await request(`/v1/training/models/${encodeURIComponent(id)}/serving?${new URLSearchParams(query)}`), { modelProjectId: id, ...query });
  } };
}
