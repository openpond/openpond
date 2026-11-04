import { z } from "zod";
import { TrainingJobSchema, TrainingJobOutputsSchema, TrainingJobSourceSchema } from "./training-job-contracts.js";
import { HostedModelProjectSummarySchema, ModelProjectBaseModelSchema, ModelProjectImmutableRefSchema } from "./model-projects.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TrainingResultSourceSchema = z.object({
  submissionHash: Hash,
  source: z.lazy(() => TrainingJobSourceSchema),
  baseModel: ModelProjectBaseModelSchema,
  recipe: z.record(z.string(), z.unknown()),
}).strict();
export const TrainingResultCandidateSchema = z.object({
  artifact: ModelProjectImmutableRefSchema,
  checkpointId: Id,
  /** Canonical registry publication is independent of saving a named Model. */
  registryArtifactId: Id.nullable(),
  composition: z.enum(["base", "residual_append", "shared", "sequential_merge"]),
  parent: z.object({ jobId: Id, artifact: ModelProjectImmutableRefSchema, checkpointId: Id }).strict().nullable(),
}).strict();
export const TrainingModelVersionContentSchema = z.object({
  schemaVersion: z.literal("openpond.trainingModelVersion.v1"),
  teamId: Id, modelProjectId: Id, portableProjectId: Id, jobId: Id,
  request: TrainingResultSourceSchema,
  candidate: TrainingResultCandidateSchema.omit({ registryArtifactId: true }),
  executionReceipt: ModelProjectImmutableRefSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export const TrainingModelVersionSchema = TrainingModelVersionContentSchema.extend({ contentHash: Hash }).strict();
export type TrainingModelVersion = z.infer<typeof TrainingModelVersionSchema>;

export async function parseAndVerifyTrainingModelVersion(raw: unknown, expected: { teamId?: string; modelProjectId?: string; jobId?: string } = {}) {
  const value = TrainingModelVersionSchema.parse(raw);
  const { contentHash, ...content } = value;
  if (contentHash !== await canonicalSha256(content)
    || expected.teamId && value.teamId !== expected.teamId
    || expected.modelProjectId && value.modelProjectId !== expected.modelProjectId
    || expected.jobId && value.jobId !== expected.jobId
    || value.request.source.modelProject.id !== value.modelProjectId
    || value.request.source.modelProject.portableProjectId !== value.portableProjectId
    || (value.candidate.composition === "base") !== (value.candidate.parent === null))
    throw new OpenPondProtocolError("training_model_version_mismatch", "The saved Model version differs from its original training result.");
  return value;
}
export const TrainingResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.trainingResult.v1"),
  teamId: Id,
  name: z.string().min(1).max(500),
  job: z.lazy(() => TrainingJobSchema),
  model: z.lazy(() => HostedModelProjectSummarySchema).nullable(),
  savedVersion: TrainingModelVersionSchema.nullable(),
  request: TrainingResultSourceSchema.nullable(),
  outputs: z.lazy(() => TrainingJobOutputsSchema),
  candidate: TrainingResultCandidateSchema.nullable(),
  candidateState: z.enum(["not_finished", "request_unavailable", "qualification_only", "not_model_training", "cleanup_pending", "artifact_pending", "retained"]),
}).strict();
export const TrainingResultSchema = TrainingResultContentSchema.extend({ contentHash: Hash }).strict();
export type TrainingResult = z.infer<typeof TrainingResultSchema>;

/** Verify an exact result read without interpreting retained weights as serving
 * readiness, quality approval or authority to start another training Job. */
export async function parseAndVerifyTrainingResult(raw: unknown, expected: { teamId?: string; jobId: string }) {
  const value = TrainingResultSchema.parse(raw);
  const { contentHash, ...content } = value;
  function fail(): never { throw new OpenPondProtocolError("training_result_mismatch", "The trained result differs from its producing Job, request or outputs."); }
  if (contentHash !== await canonicalSha256(content) || value.teamId !== value.job.teamId
    || value.job.id !== expected.jobId || expected.teamId && value.teamId !== expected.teamId
    || value.outputs.outputs.some(output => output.jobId !== value.job.id)
    || new Set(value.outputs.outputs.map(output => output.id)).size !== value.outputs.outputs.length) fail();
  if (value.model && (value.model.id !== value.job.modelProjectId || value.model.teamId !== value.teamId
    || value.model.portableProjectId !== value.job.portableProjectId)) fail();
  const request = value.request;
  if (request && (request.submissionHash !== value.job.submissionHash
    || request.source.modelProject.id !== value.job.modelProjectId
    || request.source.modelProject.portableProjectId !== value.job.portableProjectId
    || request.source.modelProject.revision !== value.job.sourceProjectRevision)) fail();
  const receipt = value.outputs.receipt;
  const payloadOutputs = value.outputs.outputs.filter(output => output.kind !== "receipt");
  const receiptOutputs = value.outputs.outputs.filter(output => output.kind === "receipt");
  if (receipt && (receipt.jobId !== value.job.id || receipt.teamId !== value.teamId
    || receipt.submissionHash !== value.job.submissionHash
    || receipt.outputs.length !== payloadOutputs.length
    || payloadOutputs.some(output => !receipt.outputs.some(ref => ref.id === output.id && ref.contentHash === output.contentHash))
    || new Set(receipt.outputs.map(ref => ref.id)).size !== receipt.outputs.length)) fail();
  // The receipt's recipeHash identifies the compiled worker recipe, while
  // request.recipe retains the original public training settings.
  if (receipt && request && receipt.manifestHash !== request.source.harnessRunManifest.contentHash) fail();
  if (receiptOutputs.length > 1 || !receipt && receiptOutputs.length
    || receiptOutputs[0] && (receiptOutputs[0].id !== `${receipt!.id}:output`
      || receiptOutputs[0].contentHash !== await canonicalSha256(receipt))) fail();
  if ((value.candidate !== null) !== (value.candidateState === "retained")) fail();
  if (value.candidate) {
    const candidate = value.candidate;
    const artifact = value.outputs.outputs.find(output => output.id === candidate.artifact.id && output.contentHash === candidate.artifact.contentHash);
    if (!request || value.job.state !== "succeeded" || value.job.kind !== "policy_optimize" || value.job.executionMode
      || !receipt?.cleanupComplete || !artifact || artifact.kind !== "adapter"
      || artifact.metadata.checkpointId !== candidate.checkpointId
      || candidate.composition === "base" && candidate.parent !== null
      || candidate.composition !== "base" && candidate.parent === null) fail();
    for (const ref of [request.source.harnessRunManifest, request.source.harnessRelease, request.source.tasksetRelease, request.source.dataset, ...request.source.evidenceSets])
      if (!receipt!.inputs.some(item => item.id === ref.id && item.contentHash === ref.contentHash)) fail();
  }
  if (value.savedVersion) {
    const saved = await parseAndVerifyTrainingModelVersion(value.savedVersion, { teamId: value.teamId, modelProjectId: value.job.modelProjectId, jobId: value.job.id });
    const candidate = value.candidate;
    if (!request || !candidate) fail();
    const { registryArtifactId: _registry, ...savedCandidate } = candidate;
    if (await canonicalSha256(saved.request) !== await canonicalSha256(request)
      || await canonicalSha256(saved.candidate) !== await canonicalSha256(savedCandidate)) fail();
  }
  return value;
}

export function createTrainingResultClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return { async result(jobId: string, expected: { teamId?: string } = {}) {
    const id = Id.parse(jobId);
    return parseAndVerifyTrainingResult(await request(`/v1/training/jobs/${encodeURIComponent(id)}/result`), { ...expected, jobId: id });
  } };
}
