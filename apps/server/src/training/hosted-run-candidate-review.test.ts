import { describe, expect, it, vi } from "vitest";
import { trainingExecutionReceiptHash } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { createHostedRunCandidateReviewService } from "./hosted-run-candidate-review.js";

const remote = vi.hoisted(() => ({ getJob: vi.fn(), outputs: vi.fn(), candidateDecision: vi.fn(), recordCandidateDecision: vi.fn() }));
vi.mock("openpond-sdk/training", async (original) => ({ ...await original<typeof import("openpond-sdk/training")>(), createTrainingClient: () => remote }));

describe("hosted run candidate review", () => {
  // A metadata-only run must not bypass receipt ownership or let a stale browser
  // decide a different adapter. The hosted API remains the revision authority.
  it("reviews without local weights, rejecting foreign access and substituted evidence before writes", async () => {
    const hash = "a".repeat(64);
    let teamId = "team-a";
    const job = { id: "job-a", destinationId: "openpond_managed", metadata: { source: "hosted_model_project_import", modelProjectId: "model-a", hostedModelProjectId: "hosted-a", hostedTeamId: "team-a" } };
    const store = { getTrainingJob: async () => job, getModelProject: async () => ({ hosted: { apiOrigin: "https://example.test", teamId: "team-a", projectId: "hosted-a" } }) } as unknown as SqliteStore;
    const service = createHostedRunCandidateReviewService({ store, resolveAccess: async () => ({ teamId, token: "test-token", apiBaseUrl: "https://example.test" }) });
    const receipt = { schemaVersion: "openpond.trainingExecutionReceipt.v2" as const, id: "receipt-a", teamId, jobId: job.id, submissionHash: hash, manifestHash: hash, recipeHash: hash, capabilityHash: hash, runtimeRelease: { id: "runtime", contentHash: hash }, inputs: [], outputs: [{ id: "adapter-a", contentHash: hash }, { id: "eval-a", contentHash: hash }], spendUsd: 0.2, durationSeconds: 30, cleanupComplete: true, issuer: "test", issuedAt: "2026-09-09T12:00:00.000Z", signature: null };
    const outputs = { receipt, outputs: [
      { id: "adapter-a", jobId: job.id, kind: "adapter", contentHash: hash, metadata: { policyVersion: 2 } },
      { id: "eval-a", jobId: job.id, kind: "evaluation", contentHash: hash, metadata: { policyVersion: 2, kind: "candidate" } },
      { id: "receipt-output-a", jobId: job.id, kind: "receipt", contentHash: await trainingExecutionReceiptHash(receipt), metadata: {} },
    ] };
    remote.getJob.mockResolvedValue({ id: job.id, teamId, modelProjectId: "hosted-a", portableProjectId: "model-a", state: "succeeded", submissionHash: hash });
    remote.outputs.mockResolvedValue(outputs);
    remote.candidateDecision.mockResolvedValue(null);
    const view = await service.read(job.id);
    expect(view.target.artifact).toEqual({ id: "adapter-a", contentHash: hash });
    const request = { schemaVersion: "openpond.trainingCandidateDecisionRequest.v1" as const, ...view.target, decision: "rejected" as const, reason: "Failed retained examples", idempotencyKey: "review-a", expectedDecision: null };
    remote.recordCandidateDecision.mockResolvedValue({ request });
    await service.record(job.id, request);
    expect(remote.recordCandidateDecision).toHaveBeenCalledWith(request);
    remote.recordCandidateDecision.mockClear();
    await expect(service.record(job.id, { ...request, artifact: { id: "other", contentHash: hash } })).rejects.toThrow("evidence changed");
    receipt.outputs = [];
    outputs.outputs[2]!.contentHash = await trainingExecutionReceiptHash(receipt);
    await expect(service.record(job.id, request)).rejects.toThrow("does not bind");
    teamId = "team-b";
    await expect(service.record(job.id, request)).rejects.toThrow("active workspace");
    expect(remote.recordCandidateDecision).not.toHaveBeenCalled();
  });
});
