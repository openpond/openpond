import { contentHash } from "@openpond/taskset-sdk";
import { TrainingCandidateDecisionRequestSchema, parseAndVerifyTrainingExecutionReceipt } from "openpond-sdk/training";
import { z } from "zod";
import type { SqliteStore } from "../store/store.js";
import { createHostedModelRunEvidence } from "./hosted-model-run-evidence.js";
import type { ManagedCandidateReview } from "./managed-candidate-review.js";

const TargetSchema = TrainingCandidateDecisionRequestSchema.pick({ teamId: true, jobId: true, artifact: true, evaluation: true, executionReceipt: true });

/** Review retained outputs through the same authority as imported Versions. */
export function createHostedRunCandidateReviewService(deps: {
  store: SqliteStore;
  resolveAccess?: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
}) {
  const evidence = createHostedModelRunEvidence(deps);
  async function context(jobId: string) {
    const job = await deps.store.getTrainingJob(jobId);
    if (!job || job.metadata.source !== "hosted_model_project_import" || job.destinationId !== "openpond_managed") {
      throw new Error("An imported hosted run is required for candidate review.");
    }
    const client = await evidence.clientFor(job);
    const [remote, outputs] = await Promise.all([client.getJob(jobId), client.outputs(jobId)]);
    if (remote.id !== jobId || remote.teamId !== job.metadata.hostedTeamId || remote.modelProjectId !== job.metadata.hostedModelProjectId || remote.portableProjectId !== job.metadata.modelProjectId) {
      throw new Error("The candidate belongs to a different run or workspace.");
    }
    if (remote.state !== "succeeded" || !outputs.receipt) throw new Error("A completed run with a retained execution receipt is required.");
    const adapters = outputs.outputs.filter(output => output.kind === "adapter");
    if (adapters.length !== 1) throw new Error("The run must identify one completed candidate adapter.");
    const adapter = adapters[0]!;
    const policyVersion = z.number().int().nonnegative().parse(adapter.metadata.policyVersion);
    const evaluations = outputs.outputs.filter(output => output.kind === "evaluation" && output.metadata.kind === "candidate" && output.metadata.policyVersion === policyVersion);
    if (evaluations.length !== 1) throw new Error("The candidate must have one matching retained evaluation.");
    const evaluation = evaluations[0]!;
    const receiptOutputs = outputs.outputs.filter(output => output.kind === "receipt" && output.jobId === jobId);
    if (receiptOutputs.length !== 1) throw new Error("The run must retain one execution receipt output.");
    const receiptHash = receiptOutputs[0]!.contentHash;
    const receipt = await parseAndVerifyTrainingExecutionReceipt(outputs.receipt, { id: outputs.receipt.id, contentHash: receiptHash, teamId: remote.teamId, jobId, requireCleanup: true });
    if (receipt.submissionHash !== remote.submissionHash || [adapter, evaluation].some(output => output.jobId !== jobId || !receipt.outputs.some(ref => ref.id === output.id && ref.contentHash === output.contentHash))) {
      throw new Error("The execution receipt does not bind this candidate and evaluation to the run.");
    }
    const target = TargetSchema.parse({ teamId: remote.teamId, jobId, artifact: { id: adapter.id, contentHash: adapter.contentHash }, evaluation: { id: evaluation.id, contentHash: evaluation.contentHash }, executionReceipt: { id: receipt.id, contentHash: receiptHash } });
    return { client, target };
  }
  function assertTarget(target: ManagedCandidateReview["target"], request: unknown) {
    if (contentHash(TargetSchema.strip().parse(request)) !== contentHash(target)) throw new Error("The candidate evidence changed. Refresh before recording a review.");
  }
  async function read(jobId: string): Promise<ManagedCandidateReview> {
    const { client, target } = await context(jobId);
    const decision = await client.candidateDecision(target);
    if (decision) assertTarget(target, decision.request);
    return { target, decision, syncedAt: new Date().toISOString() };
  }
  async function record(jobId: string, value: unknown): Promise<ManagedCandidateReview> {
    const request = TrainingCandidateDecisionRequestSchema.parse(value);
    const { client, target } = await context(jobId);
    assertTarget(target, request);
    const decision = await client.recordCandidateDecision(request);
    return { target, decision, syncedAt: new Date().toISOString() };
  }
  async function history(jobId: string, reference: { id: string; contentHash: string }) {
    const { client, target } = await context(jobId);
    const decision = await client.candidateDecision(target, { decision: reference });
    if (!decision) throw new Error("Candidate decision history entry not found.");
    assertTarget(target, decision.request);
    return decision;
  }
  return { read, record, history };
}
