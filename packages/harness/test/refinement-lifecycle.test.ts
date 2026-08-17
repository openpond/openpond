import { describe, expect, test } from "vitest";

import {
  HarnessCrossRunRefinementRequestSchema,
  HarnessRefinementCandidateSchema,
  HarnessRefinerActivityReceiptSchema,
  LocalHarnessRefinerDecisionAnySchema,
  LocalHarnessRefinerDecisionV2Schema,
  contentHash,
  createHarnessCrossRunRefinementRequest,
  createHarnessRefinementCandidate,
  createHarnessRefinementCandidateLifecycleReceipt,
  createHarnessRefinerActivityReceipt,
  harnessCrossRunRefinementDeduplicationKey,
  verifyHarnessCrossRunRefinementRequest,
  verifyHarnessRefinementCandidate,
  verifyHarnessRefinementCandidateLifecycleReceipt,
  verifyHarnessRefinerActivityReceipt,
} from "../src/index.js";

const createdAt = "2026-08-16T12:00:00.000Z";
const updatedAt = "2026-08-16T12:05:00.000Z";
const expiresAt = "2026-09-16T12:05:00.000Z";
const ref = (id: string) => ({ id, contentHash: contentHash(id) });

function evidence(id: string, state: "authorized" | "revoked" = "authorized") {
  return {
    evidence: ref(id),
    kind: "observation" as const,
    sourceRef: `source-${id}`,
    sourcePolicy: {
      policy: ref(`policy-${id}`),
      state,
      checkedAt: createdAt,
    },
    occurrenceKey: contentHash(`occurrence-${id}`),
    occurredAt: createdAt,
  };
}

describe("Refiner decision compatibility", () => {
  test("keeps v1 valid while v2 requires auditable proposal evidence", () => {
    const v1 = {
      schemaVersion: "openpond.localHarnessRefinerDecision.v1",
      decision: "no_action",
      reason: "The completed turn does not justify a reusable Harness change.",
    };
    const v2 = {
      schemaVersion: "openpond.localHarnessRefinerDecision.v2",
      decision: "propose",
      route: "skill",
      operation: "update",
      target: "skills/pdf/SKILL.md",
      summary: "Use the validated PDF inspection step before delivery.",
      evidenceBasis: {
        kind: "single_deterministic",
        supportingEvidenceIds: ["observation-1"],
        counterevidence: [],
      },
      createContent: null,
      find: "Deliver the PDF.",
      replace: "Inspect the rendered PDF, then deliver it.",
      expectedOutcome: "Equivalent PDF work validates the rendered artifact before delivery.",
      reason: "The supplied turn proves one deterministic reusable omission.",
    };

    expect(LocalHarnessRefinerDecisionAnySchema.parse(v1)).toEqual(v1);
    expect(LocalHarnessRefinerDecisionAnySchema.parse(v2)).toEqual(v2);
  });

  test("rejects invented recurrence and duplicate evidence IDs", () => {
    const base = {
      schemaVersion: "openpond.localHarnessRefinerDecision.v2" as const,
      decision: "route" as const,
      route: "runtime" as const,
      summary: "The supported renderer is unavailable.",
      expectedOutcome: "Provide the supported renderer.",
      reason: "The runtime cannot satisfy the declared capability.",
    };

    expect(() =>
      LocalHarnessRefinerDecisionV2Schema.parse({
        ...base,
        evidenceBasis: {
          kind: "recurrent_independent",
          supportingEvidenceIds: ["one"],
          counterevidence: [],
        },
      }),
    ).toThrow(/at least two/i);
    expect(() =>
      LocalHarnessRefinerDecisionV2Schema.parse({
        ...base,
        evidenceBasis: {
          kind: "recurrent_independent",
          supportingEvidenceIds: ["one", "one"],
          counterevidence: [],
        },
      }),
    ).toThrow(/unique/i);
  });
});

describe("Refiner activity receipts", () => {
  test("hashes a display-safe applied receipt and detects mutation", () => {
    const receipt = createHarnessRefinerActivityReceipt({
      schemaVersion: "openpond.harnessRefinerActivityReceipt.v1",
      id: "activity-1",
      runRef: "run-1",
      turnId: "turn-1",
      result: "applied",
      decision: "propose",
      route: "skill",
      operation: "update",
      target: "skills/pdf/SKILL.md",
      summary: "Updated the PDF skill and advanced the validated release.",
      evidenceBasis: {
        kind: "single_deterministic",
        supportingEvidenceIds: ["observation-1"],
        counterevidence: [],
      },
      critiqueStatus: "passed",
      validationStatus: "passed",
      trigger: ref("trigger-1"),
      outcome: ref("outcome-1"),
      proposal: ref("proposal-1"),
      applyReceipt: ref("apply-1"),
      inputHarness: ref("harness-before"),
      outputHarness: ref("harness-after"),
      createdAt,
    });

    expect(HarnessRefinerActivityReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(verifyHarnessRefinerActivityReceipt(receipt)).toBe(true);
    expect(
      verifyHarnessRefinerActivityReceipt({
        ...receipt,
        summary: "Mutated after hashing.",
      }),
    ).toBe(false);
    const { contentHash: activityHash, ...activityContent } = receipt;
    expect(activityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      createHarnessRefinerActivityReceipt({
        ...activityContent,
        id: "activity-invalid-validation",
        validationStatus: "failed",
      }),
    ).toThrow(/passed critique and validation/i);
  });

  test("does not let no-action or retained receipts imply an advance", () => {
    expect(() =>
      createHarnessRefinerActivityReceipt({
        schemaVersion: "openpond.harnessRefinerActivityReceipt.v1",
        id: "activity-invalid",
        runRef: "run-1",
        turnId: "turn-1",
        result: "no_action",
        decision: "no_action",
        route: "skill",
        operation: null,
        target: null,
        summary: "No reusable change.",
        evidenceBasis: null,
        critiqueStatus: "not_applicable",
        validationStatus: "not_applicable",
        trigger: ref("trigger-1"),
        outcome: ref("outcome-1"),
        proposal: null,
        applyReceipt: null,
        inputHarness: ref("harness-before"),
        outputHarness: ref("harness-after"),
        createdAt,
      }),
    ).toThrow();
  });
});

describe("cross-run candidate lifecycle", () => {
  test("creates immutable bounded candidates and lifecycle receipts", () => {
    const occurrence = evidence("observation-1");
    const candidate = createHarnessRefinementCandidate({
      schemaVersion: "openpond.harnessRefinementCandidate.v1",
      id: "candidate-1",
      ownerScope: { kind: "personal", id: "owner-1" },
      workspaceRef: "workspace-1",
      fingerprint: contentHash("candidate-family-1"),
      recurrenceFamily: "rendered-artifact-verification",
      statement: "Completed artifact work may omit the required rendered inspection.",
      status: "unresolved",
      occurrences: [occurrence],
      counterevidence: [],
      sourceReviews: [ref("review-1")],
      relatedHarnessReleases: [ref("harness-before")],
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      lastReviewedAt: updatedAt,
      expiresAt,
      resolution: null,
      createdAt,
      updatedAt,
    });
    const lifecycle = createHarnessRefinementCandidateLifecycleReceipt({
      schemaVersion: "openpond.harnessRefinementCandidateLifecycleReceipt.v1",
      id: "candidate-lifecycle-1",
      candidateId: candidate.id,
      decision: "created",
      beforeCandidate: null,
      afterCandidate: { id: candidate.id, contentHash: candidate.contentHash },
      review: ref("review-1"),
      addedEvidence: [occurrence],
      removedEvidence: [],
      reason: "One unresolved candidate was retained for later independent evidence.",
      createdAt: updatedAt,
    });

    expect(HarnessRefinementCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(verifyHarnessRefinementCandidate(candidate)).toBe(true);
    expect(verifyHarnessRefinementCandidateLifecycleReceipt(lifecycle)).toBe(true);
    expect(
      verifyHarnessRefinementCandidate({
        ...candidate,
        statement: "Mutated candidate statement.",
      }),
    ).toBe(false);
    const { contentHash: candidateHash, ...candidateContent } = candidate;
    expect(candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      createHarnessRefinementCandidate({
        ...candidateContent,
        id: "candidate-invalid-resolution",
        status: "resolved",
        resolution: {
          kind: "expired",
          reason: "This is not valid resolution evidence.",
          evidenceRefs: [],
          resolvedAt: updatedAt,
        },
      }),
    ).toThrow(/applied-change or later-success/i);
    expect(() =>
      createHarnessRefinementCandidateLifecycleReceipt({
        schemaVersion: "openpond.harnessRefinementCandidateLifecycleReceipt.v1",
        id: "candidate-lifecycle-overlap",
        candidateId: candidate.id,
        decision: "merged",
        beforeCandidate: ref("candidate-before"),
        afterCandidate: ref("candidate-after"),
        review: ref("review-2"),
        addedEvidence: [occurrence],
        removedEvidence: [occurrence.evidence],
        reason: "The same evidence cannot be added and removed.",
        createdAt: updatedAt,
      }),
    ).toThrow(/added and removed/i);
  });

  test("requires actionable candidates and added evidence to remain authorized", () => {
    expect(() =>
      createHarnessRefinementCandidate({
        schemaVersion: "openpond.harnessRefinementCandidate.v1",
        id: "candidate-revoked",
        ownerScope: { kind: "personal", id: "owner-1" },
        workspaceRef: "workspace-1",
        fingerprint: contentHash("candidate-revoked"),
        recurrenceFamily: "revoked-family",
        statement: "This evidence is no longer authorized.",
        status: "unresolved",
        occurrences: [evidence("revoked", "revoked")],
        counterevidence: [],
        sourceReviews: [ref("review-1")],
        relatedHarnessReleases: [],
        firstSeenAt: createdAt,
        lastSeenAt: createdAt,
        lastReviewedAt: updatedAt,
        expiresAt,
        resolution: null,
        createdAt,
        updatedAt,
      }),
    ).toThrow(/authorized/i);
  });
});

describe("cross-run continuation identity", () => {
  test("deduplicates by workspace, candidate fingerprint, and admitted Harness", () => {
    const workspaceRef = "workspace-1";
    const candidateFingerprint = contentHash("candidate-family-1");
    const admittedHarness = ref("harness-before");
    const deduplicationKey = harnessCrossRunRefinementDeduplicationKey({
      workspaceRef,
      candidateFingerprint,
      admittedHarness,
    });
    const request = createHarnessCrossRunRefinementRequest({
      schemaVersion: "openpond.harnessCrossRunRefinementRequest.v1",
      id: "cross-run-request-1",
      ownerScope: { kind: "personal", id: "owner-1" },
      workspaceRef,
      candidate: ref("candidate-1"),
      candidateFingerprint,
      review: ref("review-1"),
      admittedHarness,
      evidence: [evidence("observation-1")],
      capabilities: {
        memory: true,
        prompt: true,
        skill: true,
        agent: false,
      },
      deduplicationKey,
      createdAt,
    });

    expect(HarnessCrossRunRefinementRequestSchema.parse(request)).toEqual(request);
    expect(verifyHarnessCrossRunRefinementRequest(request)).toBe(true);
    expect(
      harnessCrossRunRefinementDeduplicationKey({
        workspaceRef,
        candidateFingerprint,
        admittedHarness,
      }),
    ).toBe(deduplicationKey);
    const { contentHash: requestContentHash, ...requestContent } = request;
    expect(requestContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      createHarnessCrossRunRefinementRequest({
        ...requestContent,
        id: "cross-run-request-tampered",
        deduplicationKey: contentHash("wrong-key"),
      }),
    ).toThrow(/deduplicationKey/i);
  });
});
