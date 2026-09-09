import { expect, it } from "vitest";
import {
  createTrainingClient,
  parseAndVerifyTrainingCandidateDecision,
  trainingCandidateDecisionHash,
  TrainingCandidateDecisionRequestSchema,
  TrainingCandidateDecisionSchema,
  type TrainingCandidateDecision,
  type TrainingCandidateDecisionRequest,
} from "../src/training.js";

const request: TrainingCandidateDecisionRequest = {
  schemaVersion: "openpond.trainingCandidateDecisionRequest.v1",
  teamId: "team-1", jobId: "job-1",
  artifact: { id: "adapter-1", contentHash: "a".repeat(64) },
  evaluation: { id: "evaluation-1", contentHash: "b".repeat(64) },
  executionReceipt: { id: "receipt-1", contentHash: "c".repeat(64) },
  decision: "rejected", reason: "No measured improvement on the retained panel.",
  idempotencyKey: "review-1", expectedDecision: null,
};
async function receipt(overrides: Partial<Omit<TrainingCandidateDecision, "contentHash">> = {}) {
  const value = {
    schemaVersion: "openpond.trainingCandidateDecision.v1" as const,
    id: "decision-1", request, revision: 1,
    actor: { userId: "reviewer-1", kind: "user" as const, id: "reviewer-1" },
    decidedAt: "2026-09-09T03:00:00Z", ...overrides,
  };
  return { ...value, contentHash: await trainingCandidateDecisionHash(value) };
}

// Even a self-consistent server response must not replace the candidate or review the caller selected.
it("verifies exact candidate, owner, evidence and submitted decision before adoption", async () => {
  const original = await receipt();
  expect(await parseAndVerifyTrainingCandidateDecision(original, { ...request, request })).toEqual(original);
  for (const changed of [
    { ...original, request: { ...request, reason: "tampered" } },
    await receipt({ request: { ...request, teamId: "another-team" } }),
    await receipt({ request: { ...request, jobId: "another-job" } }),
    await receipt({ request: { ...request, artifact: { ...request.artifact, contentHash: "d".repeat(64) } } }),
    await receipt({ request: { ...request, evaluation: { ...request.evaluation, contentHash: "d".repeat(64) } } }),
    await receipt({ request: { ...request, executionReceipt: { ...request.executionReceipt, id: "another-receipt" } } }),
    await receipt({ request: { ...request, decision: "accepted" } }),
    await receipt({ request: { ...request, idempotencyKey: "another-review" } }),
  ]) await expect(parseAndVerifyTrainingCandidateDecision(changed, { ...request, request })).rejects.toThrow();
  expect(() => TrainingCandidateDecisionRequestSchema.parse({ ...request, reason: " " })).toThrow();
  expect(() => TrainingCandidateDecisionRequestSchema.parse({ ...request, activateServing: true })).toThrow();
  expect(() => TrainingCandidateDecisionSchema.parse({ ...original, revision: 2 })).toThrow();
});

// Retrying a review must retain its idempotency and CAS identities; history reads must not silently return latest.
it("sends a bounded review and follows immutable decision history through the shared client", async () => {
  const original = await receipt();
  const previous = { id: original.id, contentHash: original.contentHash };
  const nextRequest = { ...request, decision: "accepted" as const, reason: "Reviewed the tradeoff.", idempotencyKey: "review-2", expectedDecision: previous };
  const next = await receipt({ id: "decision-2", request: nextRequest, revision: 2 });
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let response: unknown = { decision: null };
  const client = createTrainingClient({ baseUrl: "https://example.test", fetch: (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(response));
  }) as typeof fetch });
  expect(await client.candidateDecision(request)).toBeNull();
  response = original;
  expect(await client.recordCandidateDecision(request)).toEqual(original);
  expect(await client.recordCandidateDecision(request)).toEqual(original);
  expect(calls[1]).toEqual(calls[2]);
  response = next;
  expect(await client.recordCandidateDecision(nextRequest)).toEqual(next);
  expect(calls.at(-1)?.body).toEqual(nextRequest);
  response = { decision: original };
  expect(await client.candidateDecision(request, { decision: previous })).toEqual(original);
  expect(calls.at(-1)?.url).toBe("https://example.test/v1/training/jobs/job-1/candidates/adapter-1/decision?decisionId=decision-1");
  response = { decision: next };
  await expect(client.candidateDecision(request, { decision: previous })).rejects.toThrow(/history entry/);
  response = { decision: null };
  await expect(client.candidateDecision(request, { decision: previous })).rejects.toThrow();
});
