import { canonicalSha256 } from "openpond-sdk/training";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.object({ id: z.string().min(1), contentHash: hash }).passthrough();
const Recovery = z.object({
  sourceJobId: z.string().min(1), sourceInputManifestSha256: hash,
  checkpointId: z.string().min(1), checkpointPolicyVersion: z.number().int().positive(),
  completedGroups: z.number().int().positive(), adapterSha256: hash, resumeSha256: hash,
  approvedManifest: ref, evaluationTaskset: ref, receiptSha256: hash,
}).passthrough();

export const HostedRecoveryImportSchema = Recovery.extend({
  executionSubmissionHash: hash,
  sourceSubmission: z.unknown(),
  optimizerStateRestored: z.boolean(),
});
export type HostedRecoveryImport = z.infer<typeof HostedRecoveryImportSchema>;

/** Recovery has its own execution identity and inherits its source approval.
 * Resolve that authenticated chain without inventing a new public submission. */
export async function resolveHostedModelRecovery(input: {
  job: Record<string, unknown>;
  resolveSource: (id: string) => Promise<{ job: Record<string, unknown>; checkpoints: unknown[] }>;
  commands: unknown[];
}): Promise<Record<string, unknown>> {
  const job = input.job;
  if (job.publicSubmission != null) return job;
  const bundle = z.object({ recovery: Recovery }).passthrough().parse(job.inputBundle);
  const recovery = bundle.recovery;
  const { receiptSha256, ...content } = recovery;
  if (await canonicalSha256(content) !== receiptSha256 || recovery.sourceJobId === job.id) {
    throw new Error("Hosted recovery receipt identity changed.");
  }
  const source = await input.resolveSource(recovery.sourceJobId);
  const origin = source.job;
  const inherited = HostedRecoveryImportSchema.nullish().parse(origin.recoveryImport);
  const submission = origin.publicSubmission ?? inherited?.sourceSubmission;
  const sourceSubmission = z.object({ source: z.object({
    harnessRunManifest: ref, evaluation: z.object({ taskset: ref }).passthrough().optional(),
    taskset: ref,
  }).passthrough() }).passthrough().parse(submission);
  const expectedEvaluation = sourceSubmission.source.evaluation?.taskset ?? sourceSubmission.source.taskset;
  const checkpoint = source.checkpoints.map(value => z.object({
    id: z.string(), state: z.string(), policyVersion: z.number(), adapterSha256: hash.nullish(), resumeSha256: hash.nullish(),
  }).passthrough().parse(value)).find(value => value.id === recovery.checkpointId);
  if (origin.id !== recovery.sourceJobId || origin.teamId !== job.teamId || origin.modelProjectId !== job.modelProjectId
    || origin.inputBundleSha256 !== recovery.sourceInputManifestSha256
    || sourceSubmission.source.harnessRunManifest.id !== recovery.approvedManifest.id
    || sourceSubmission.source.harnessRunManifest.contentHash !== recovery.approvedManifest.contentHash
    || expectedEvaluation.id !== recovery.evaluationTaskset.id || expectedEvaluation.contentHash !== recovery.evaluationTaskset.contentHash
    || checkpoint?.state !== "ready" || checkpoint.policyVersion !== recovery.checkpointPolicyVersion
    || checkpoint.adapterSha256 !== recovery.adapterSha256 || checkpoint.resumeSha256 !== recovery.resumeSha256) {
    throw new Error("Hosted recovery differs from its exact source run and checkpoint.");
  }
  const commands = input.commands.map(value => z.object({ commandType: z.string(), state: z.string() }).passthrough().parse(value));
  const restored = commands.some(value => value.commandType === "materialize_checkpoint" && value.state === "succeeded")
    && commands.some(value => value.commandType === "start_inference" && value.state === "succeeded");
  return { ...job, portableProjectId: origin.portableProjectId, sourceProjectRevision: origin.sourceProjectRevision,
    recoveryImport: HostedRecoveryImportSchema.parse({ ...recovery, executionSubmissionHash: job.inputBundleSha256,
      sourceSubmission: submission, optimizerStateRestored: restored }) };
}
