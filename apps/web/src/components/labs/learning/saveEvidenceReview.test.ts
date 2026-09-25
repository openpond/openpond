import { describe, expect, test } from "vitest";
import type { OpenPondLearningClient as LearningClient } from "openpond-sdk/learning";
import { createEvidenceReviewSave, reviewDisposition } from "./saveEvidenceReview";

const now = "2026-09-10T12:00:00.000Z";
const reference = { id: "attempt", revision: 1, contentHash: "a".repeat(64) };
const submission = { schemaVersion: "openpond.taskFeedback.v1" as const, sourceId: "source", exampleId: "example", attemptId: "attempt", expectedEvidenceHash: reference.contentHash, occurredAt: now, note: "Reviewer disagrees with the automatic check." };

function fixture(disposition: "approved" | "rejected" | "pending") {
  const calls: string[] = [];
  let failReview = true;
  const review = { action: "review" as const, operationId: "review-operation", evidence: reference, expectedRevision: 0, disposition, targetApproval: "pending" as const, approvedTarget: null, observedGradeId: null, targetGradeId: null, note: submission.note };
  const save = createEvidenceReviewSave({
    feedback: { ...submission, kind: "outcome", idempotencyKey: "feedback-operation", value: { assessment: "cannot_assess" } },
    correction: { ...submission, kind: "target_correction", idempotencyKey: "correction-operation", value: { answer: "Human correction" } },
    review, feedbackResolutionId: "resolve-rating", correctionResolutionId: "resolve-correction",
  });
  const api = {
    async submitFeedback(value: typeof submission & { kind: string; idempotencyKey: string }) {
      calls.push(value.idempotencyKey);
      return { resources: [{ schemaVersion: "openpond.taskFeedbackRecord.v1", id: value.idempotencyKey, submission: value, status: "pending_review", evidence: reference, createdAt: now, revision: 1 }] };
    },
    async command(value: { action: string; operationId: string }) {
      calls.push(value.operationId);
      if (value.action === "review") {
        if (failReview) { failReview = false; throw new Error("Transient review failure"); }
        return { resources: [{ schemaVersion: "openpond.taskAdmissionDecision.v1", id: "decision", revision: 1, contentHash: reference.contentHash, evidence: reference, supersedes: null, actor: { kind: "human", id: "reviewer", policy: null }, evidenceValidity: "valid", taskAdmissibility: disposition, observedQuality: "failed", targetApproval: "pending", approvedTarget: null, grade: null, targetGrade: null, note: submission.note, decidedAt: now }] };
      }
      return { resources: [] };
    },
  } as unknown as Pick<LearningClient, "submitFeedback" | "command">;
  return { save, api, calls };
}

describe("human review retention and admission", () => {
  test("retains correction before a failed review and retries without duplicate feedback", async () => {
    const { save, api, calls } = fixture("pending");
    await expect(save(api)).rejects.toThrow("Transient review failure");
    expect(calls).toEqual(["feedback-operation", "correction-operation", "review-operation"]);
    expect((await save(api)).taskAdmissibility).toBe("pending");
    expect(calls).toEqual(["feedback-operation", "correction-operation", "review-operation", "review-operation"]);
  });
  test("excluding a task resolves its rating without falsely applying its correction", async () => {
    const { save, api, calls } = fixture("rejected");
    await expect(save(api)).rejects.toThrow();
    await save(api);
    expect(calls).toContain("resolve-rating");
    expect(calls).not.toContain("resolve-correction");
  });
  test("failed checks, incomplete tasks and cannot-assess keep learning pending", () => {
    const input = { selected: "approved" as const, cannotAssess: false, taskReady: true, hasCorrection: true, correctionPassed: false };
    expect(reviewDisposition(input)).toBe("pending");
    expect(reviewDisposition({ ...input, correctionPassed: true })).toBe("approved");
    expect(reviewDisposition({ ...input, hasCorrection: false })).toBe("approved");
    expect(reviewDisposition({ ...input, hasCorrection: false, taskReady: false })).toBe("pending");
    expect(reviewDisposition({ ...input, hasCorrection: false, cannotAssess: true })).toBe("pending");
    expect(reviewDisposition({ ...input, selected: "rejected" })).toBe("rejected");
  });
});
