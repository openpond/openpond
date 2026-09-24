import { describe, expect, it } from "vitest";
import type { OpenPondProfileRef } from "@openpond/contracts";

import { inspectProfileEvaluationRun } from "./profile-evaluation-run-inspection.js";

describe("Profile evaluation run inspection", () => {
  const profileRef = { source: "openpond_git", repositoryId: "repo-a", profileId: "default" } as OpenPondProfileRef;
  const otherProfileRef = { ...profileRef, repositoryId: "repo-b" };
  const run = {
    profileRef,
    manifest: {
      id: "run-1", contentHash: "a".repeat(64),
      profileEvaluation: { sourceRevision: "b".repeat(40) },
      population: [{ receiptId: "receipt-1", taskId: "task-1", seed: "seed-1" }],
    },
    receiptRefs: [{ id: "receipt-1", contentHash: "c".repeat(64) }],
    gradeRefs: [{ id: "grade-1", contentHash: "d".repeat(64) }],
  };
  const receipt = {
    id: "receipt-1", contentHash: "c".repeat(64), taskId: "task-1", seed: "seed-1",
    runManifest: { id: "run-1", contentHash: "a".repeat(64) },
    graderEvidenceRefs: [{ id: "grade-1", contentHash: "d".repeat(64) }],
    latencyMs: 42, costUsd: 0.01, terminal: true,
  };
  const grade = { contentHash: "d".repeat(64), score: 1, passed: true, gradingStatus: "scored", failureClass: null };

  it("keeps one Profile's run and mismatched case evidence out of another Profile's view", async () => {
    const store = {
      getProfileEvaluationRun: async () => run,
      getProfileEvaluationReceipt: async () => receipt,
      getProfileEvaluationGrade: async () => grade,
    } as unknown as Parameters<typeof inspectProfileEvaluationRun>[0]["store"];
    await expect(inspectProfileEvaluationRun({ store, profileRef: otherProfileRef, runId: "run-1" })).rejects.toThrow("selected Profile");
    expect(await inspectProfileEvaluationRun({ store, profileRef, runId: "run-1" })).toMatchObject({
      sourceRevision: "b".repeat(40),
      cases: [{ taskId: "task-1", score: 1, passed: true, latencyMs: 42 }],
    });
    const tampered = { ...store, getProfileEvaluationReceipt: async () => ({ ...receipt, taskId: "different-task" }) } as unknown as typeof store;
    await expect(inspectProfileEvaluationRun({ store: tampered, profileRef, runId: "run-1" })).rejects.toThrow("differs from its retained run");
  });
});
