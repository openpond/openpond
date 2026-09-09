import { candidateEvaluationArtifact } from "./portable-model-run-artifacts.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TrainingExecutionRefSchema, type ModelArtifactLineage, type TrainingArtifact } from "@openpond/contracts";
import { canonicalSha256, trainingCandidateDecisionHash, type TrainingCandidateDecisionRequest, type TrainingCandidateDecision } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { createManagedCandidateReviewService } from "./managed-candidate-review.js";
import { assertManagedTrainingEvaluationReceipt } from "./managed-training-evaluation-source.js";

vi.mock("./managed-training-evaluation-source.js", () => ({ assertManagedTrainingEvaluationReceipt: vi.fn(async () => undefined) }));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))); vi.clearAllMocks(); });
const hash = "a".repeat(64);
const at = "2026-09-09T03:00:00Z";
async function fixture() {
  const storeDir = await mkdtemp(path.join(tmpdir(), "candidate-review-")); directories.push(storeDir);
  const ref = TrainingExecutionRefSchema.parse({ adapterId: "sandbox-managed-rl", runId: "job-1", providerJobId: "job-1", tenantId: "team-1", manifestHash: hash, inputBundleHash: hash, leaseId: null, createdAt: at });
  const receipt = { schemaVersion: "openpond.trainingExecutionReceipt.v2" as const, id: "receipt-1", teamId: "team-1", jobId: "job-1", submissionHash: hash, manifestHash: hash,
    recipeHash: hash, capabilityHash: hash, runtimeRelease: { id: "runtime", contentHash: hash }, inputs: [], outputs: [], spendUsd: 0.2, durationSeconds: 20, cleanupComplete: true, issuer: "sandbox", issuedAt: at, signature: null };
  const receiptHash = await canonicalSha256(receipt);
  let lineage = { id: "lineage-1", jobId: "job-1", artifactId: "local-adapter", status: "imported", frozenEvaluationArtifactId: "local-baseline", rejectedAt: null, rejectionReason: null } as ModelArtifactLineage;
  function artifact(id: string, outputId: string, kind: string, sha256: string, metadata = {}) { return { id, jobId: "job-1", sha256, metadata: { verified: true, portableKind: kind, managedRlJobId: "job-1", managedRlTeamId: "team-1", managedRlOutputId: outputId, managedRlOutputMetadata: metadata } } as unknown as TrainingArtifact; }
  const artifacts = [artifact("local-adapter", "adapter-1", "adapter", hash), artifact("local-receipt", "receipt-1:output", "receipt", receiptHash),
    artifact("local-baseline", "baseline-1", "evaluation", "b".repeat(64), { kind: "baseline", policyVersion: 0 }),
    artifact("local-candidate", "evaluation-1", "evaluation", "c".repeat(64), { kind: "candidate", policyVersion: 2 })];
  const outputs = {
    schemaVersion: "openpond.trainingJobOutputs.v2", receipt,
    outputs: artifacts.map(item => ({ schemaVersion: "openpond.trainingJobOutput.v2", id: item.metadata.managedRlOutputId, jobId: "job-1", kind: item.metadata.portableKind, contentHash: item.sha256, artifactRef: "retained://artifact", sizeBytes: 20, createdAt: at,
      metadata: item.id === "local-adapter" ? { policyVersion: 2, checkpointId: "checkpoint-2" } : item.metadata.managedRlOutputMetadata })),
  };
  let decision: TrainingCandidateDecision | null = null;
  let offline = false;
  let accessTeam = "team-1";
  let bound = false;
  const writes: TrainingCandidateDecisionRequest[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (offline) throw new Error("offline");
    const address = String(url);
    expect(new Headers(init?.headers).get("x-openpond-team-id")).toBe("team-1");
    if (address.endsWith("/outputs")) return new Response(JSON.stringify(outputs));
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as TrainingCandidateDecisionRequest; writes.push(request);
      if (!decision) {
        const content = { schemaVersion: "openpond.trainingCandidateDecision.v1" as const, id: "decision-1", request, revision: 1, actor: { userId: "reviewer", kind: "user" as const, id: "reviewer" }, decidedAt: at };
        decision = { ...content, contentHash: await trainingCandidateDecisionHash(content) };
      }
      return new Response(JSON.stringify(decision));
    }
    return new Response(JSON.stringify({ decision }));
  });
  const store = {
    getModelArtifactLineage: vi.fn(async () => lineage),
    getTrainingJob: vi.fn(async () => ({ id: "job-1", destinationId: "openpond_managed", status: "succeeded", metadata: { portableExecutionRef: ref } })),
    listTrainingArtifacts: vi.fn(async () => artifacts), listModelBindings: vi.fn(async () => bound ? [{ status: "active", modelArtifactLineageId: lineage.id }] : []),
    updateModelArtifactLineageReview: vi.fn(async (_id, patch) => { lineage = { ...lineage, ...patch }; }),
  } as unknown as SqliteStore;
  const service = createManagedCandidateReviewService({ store, storeDir, resolveAccess: async () => ({ apiBaseUrl: "https://example.test", token: "opk_fixture", teamId: accessTeam }), fetch: fetch as typeof globalThis.fetch });
  return { service, storeDir, fetch, outputs, artifacts, store, writes, ref, lineage: () => lineage, offline: () => { offline = true; }, switchTeam: () => { accessTeam = "other-team"; }, bind: () => { bound = true; } };
}

// Browser review must select the adapter's candidate policy, retain the original receipt, and remain readable offline.
it("pins candidate evidence, records a retryable review, and retains verified offline readback", async () => {
  const value = await fixture();
  const view = (await value.service.read("lineage-1", true))!;
  expect(view.target.evaluation.id).toBe("evaluation-1");
  expect(assertManagedTrainingEvaluationReceipt).toHaveBeenCalledWith(expect.objectContaining({ expectedManifestHash: hash, expectedSubmissionHash: hash }));
  const request: TrainingCandidateDecisionRequest = { schemaVersion: "openpond.trainingCandidateDecisionRequest.v1", ...view.target, decision: "rejected", reason: "No measured improvement.", expectedDecision: null, idempotencyKey: "review-1" };
  const recorded = await value.service.record("lineage-1", request);
  expect(recorded.decision?.request).toEqual(request);
  expect(value.lineage()).toMatchObject({ status: "rejected", frozenEvaluationArtifactId: "local-candidate" });
  expect((await value.service.record("lineage-1", request)).decision).toEqual(recorded.decision);
  expect(value.writes[0]).toEqual(value.writes[1]);
  value.offline(); value.fetch.mockClear();
  expect((await value.service.read("lineage-1", false))?.decision).toEqual(recorded.decision);
  expect(value.fetch).not.toHaveBeenCalled();
  const root = path.join(value.storeDir, "training", "candidate-reviews");
  const file = path.join(root, (await readdir(root))[0]!);
  const cached = JSON.parse(await readFile(file, "utf8")); cached.view.decision.request.reason = "changed";
  await writeFile(file, JSON.stringify(cached));
  await expect(value.service.read("lineage-1", false)).rejects.toThrow(/saved candidate review changed/);
});

// A changed team, baseline substitution, or active binding must stop before a hosted decision is written.
it("refuses substituted evidence and ownership changes before recording a review", async () => {
  const value = await fixture(); const view = (await value.service.read("lineage-1", true))!;
  const request: TrainingCandidateDecisionRequest = { schemaVersion: "openpond.trainingCandidateDecisionRequest.v1", ...view.target, decision: "rejected", reason: "No improvement.", expectedDecision: null, idempotencyKey: "review-1" };
  await expect(value.service.record("lineage-1", { ...request, evaluation: { id: "baseline-1", contentHash: "b".repeat(64) } })).rejects.toThrow(/candidate evaluation/);
  value.switchTeam();
  await expect(value.service.record("lineage-1", request)).rejects.toThrow(/selected team/);
  value.bind();
  await expect(value.service.record("lineage-1", request)).rejects.toThrow(/Deactivate/);
  expect(value.writes).toHaveLength(0);
  const mismatch = await fixture();
  mismatch.outputs.outputs[0]!.metadata = { policyVersion: 7 };
  await expect(mismatch.service.read("lineage-1", true)).rejects.toThrow(/matching retained candidate/);
});

// A collected Version must never use a baseline or another checkpoint’s evaluation.
it("selects the candidate evaluation for the collected adapter policy", async () => {
  const value = await fixture();
  const weights = value.artifacts[0]!; weights.metadata.provider = "sandbox"; weights.metadata.managedRlOutputMetadata = { policyVersion: 2 };
  value.artifacts[2]!.kind = "evaluation"; value.artifacts[3]!.kind = "evaluation";
  expect(candidateEvaluationArtifact(weights, value.artifacts)?.id).toBe("local-candidate");
  weights.metadata.managedRlOutputMetadata = { policyVersion: 7 };
  expect(() => candidateEvaluationArtifact(weights, value.artifacts)).toThrow(/exact candidate evaluation/);
});
