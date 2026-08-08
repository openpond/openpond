import { describe, expect, test } from "vitest";

import {
  contentHash,
  createHarnessEvaluationReviewReceipt,
  verifyHarnessEvaluationReviewReceipt,
} from "../src/index.js";

const createdAt = "2026-08-08T12:00:00.000Z";
const ref = (id: string) => ({ id, contentHash: contentHash(id) });

function noActionInput() {
  return {
    schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1" as const,
    id: "review-no-action",
    ownerScope: { kind: "personal" as const, id: "owner-1" },
    workspaceRef: "workspace-1",
    harnessRelease: ref("harness-release"),
    previousWatermark: null,
    nextWatermark: {
      cursor: contentHash("watermark"),
      throughCreatedAt: createdAt,
    },
    selectedEvidence: [],
    excludedEvidence: [],
    claim: null,
    classification: "no_action" as const,
    triage: [],
    reason: "No unresolved reusable claim was present in the bounded window.",
    nextAuthority: "none" as const,
    maxEstimatedCostUsd: 0,
    tasksetProposal: null,
    evaluation: null,
    trainingQualification: null,
    policyVersion: "review-policy-v1",
    createdAt,
    metadata: {},
  };
}

describe("Harness Evaluation review contracts", () => {
  test("creates and verifies an immutable bounded no-action receipt", () => {
    const receipt = createHarnessEvaluationReviewReceipt(noActionInput());

    expect(verifyHarnessEvaluationReviewReceipt(receipt)).toBe(true);
    expect(receipt).toMatchObject({
      classification: "no_action",
      nextAuthority: "none",
      selectedEvidence: [],
    });
    expect(
      verifyHarnessEvaluationReviewReceipt({
        ...receipt,
        reason: "mutated after hashing",
      }),
    ).toBe(false);
  });

  test("rejects revoked selected evidence and incomplete actionable routing", () => {
    const evidence = {
      evidence: ref("observation-1"),
      kind: "observation" as const,
      sourceRef: "source-1",
      sourcePolicy: {
        policy: ref("source-policy"),
        state: "revoked" as const,
        checkedAt: createdAt,
      },
      occurrenceKey: contentHash("occurrence-1"),
      occurredAt: createdAt,
    };

    expect(() =>
      createHarnessEvaluationReviewReceipt({
        ...noActionInput(),
        id: "review-invalid-taskset",
        selectedEvidence: [evidence],
        claim: {
          fingerprint: contentHash("claim"),
          recurrenceFamily: "document-recovery",
          statement: "Document recovery remains unreliable.",
          independentOccurrences: 3,
          unresolvedOccurrences: 3,
        },
        classification: "taskset",
        nextAuthority: "human_review",
      }),
    ).toThrow(/authorized|proposal/i);
  });
});
