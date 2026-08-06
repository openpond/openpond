import { describe, expect, it } from "vitest";

import { contentHash } from "@openpond/harness";

import {
  WorkEvidenceReceiptSchema,
  WorkProcessTraceSchema,
  assertFeedbackTargetsEvidence,
  classifyWorkEvidence,
  createWorkFeedbackReceipt,
  eligibleEvidenceUses,
  evidenceArtifactRef,
  toWorkEvidenceAuthoringInput,
  verifyWorkEvidenceEligibility,
  verifyWorkEvidenceReceipt,
  verifyWorkFeedbackReceipt,
  verifyWorkProcessTrace,
  workEvidenceConformance,
} from "../src/evidence/index.js";
import { createAttemptReceipt } from "../src/runs.js";

describe("portable Work evidence contracts", () => {
  it("constructs and verifies the canonical redacted fixtures", () => {
    const fixture = workEvidenceConformance;
    expect(verifyWorkProcessTrace(fixture.trace)).toBe(true);
    expect(verifyWorkEvidenceReceipt(fixture.receipt)).toBe(true);
    expect(verifyWorkFeedbackReceipt(fixture.feedback)).toBe(true);
    expect(verifyWorkEvidenceEligibility(fixture.activeEligibility)).toBe(true);
    expect(JSON.stringify(fixture.trace)).not.toMatch(/reasoning|apiKey|fixture prompt|fixture output/);
    expect(JSON.stringify(fixture.receipt)).not.toMatch(/fixture-session|fixture-turn|fixture prompt/);
  });

  it("pins cross-runtime canonical hashes", () => {
    expect(workEvidenceConformance.trace.contentHash).toBe("90e00580b2f54a75a75dc8f3e7a264c7be1d61553394471ef2bb5a488fe401e9");
    expect(workEvidenceConformance.receipt.contentHash).toBe("44e2d19ca458be51ec95c52740ac4587f27057572729cbf1d43a3f2281349c72");
    expect(workEvidenceConformance.feedback.contentHash).toBe("c54be6f934edb3a4e12795af5aa18128e10a7188fb022e02b839cb9afdaa29d8");
  });

  it("rejects raw ids, private refs, hidden reasoning, and content-hash drift", () => {
    expect(WorkEvidenceReceiptSchema.safeParse(workEvidenceConformance.invalidRawEvidence).success).toBe(false);
    expect(verifyWorkEvidenceReceipt({
      ...workEvidenceConformance.receipt,
      inputHash: contentHash("changed"),
    })).toBe(false);
    expect(WorkProcessTraceSchema.safeParse({
      ...workEvidenceConformance.trace,
      privateRef: "/private/trace.json",
    }).success).toBe(false);
  });

  it("requires content-addressed artifact ids", () => {
    expect(() => evidenceArtifactRef({
      contentHash: contentHash("artifact"),
      mediaType: "text/plain",
      sizeBytes: 8,
    })).not.toThrow();
    expect(() => evidenceArtifactRef({
      contentHash: "not-a-hash",
      mediaType: null,
      sizeBytes: null,
    })).toThrow();
  });

  it("keeps incomplete and revoked evidence out of stronger uses", () => {
    const active = workEvidenceConformance.activeEligibility;
    expect(eligibleEvidenceUses(active)).toEqual([
      "discovery_only",
      "eval_candidate",
      "demonstration_candidate",
    ]);
    for (const decision of Object.values(workEvidenceConformance.revokedEligibility.decisions)) {
      expect(decision.eligible).toBe(false);
      expect(decision.blockers).toContain("consent_revoked");
    }
  });

  it("requires an actual bound reward-eligible AttemptReceipt", () => {
    const receipt = workEvidenceConformance.receipt;
    const attempt = createAttemptReceipt({
      schemaVersion: "openpond.attemptReceipt.v1",
      id: "replayed-attempt",
      runManifest: { id: "manifest", contentHash: contentHash("manifest") },
      taskId: "task",
      seed: "0",
      terminal: true,
      failureClass: null,
      outputHash: receipt.outputRefs[0]!.contentHash,
      traceHash: contentHash("attempt-trace"),
      artifactRefs: [],
      graderEvidenceRefs: [],
      startedAt: "2026-08-04T12:02:00.000Z",
      completedAt: "2026-08-04T12:02:01.000Z",
      latencyMs: 1_000,
      costUsd: 0,
      legacyAttemptRef: null,
      metadata: { rewardEligible: true, score: 1 },
    });
    const noReplay = workEvidenceConformance.activeEligibility;
    expect(noReplay.decisions.reward_candidate).toMatchObject({
      eligible: false,
      blockers: ["attempt_receipt_missing"],
    });
    const replayed = classifyWorkEvidence({
      evidence: receipt,
      feedback: [workEvidenceConformance.feedback],
      policyState: "active",
      reconstructability: { input: true, environment: true, verifier: true },
      replay: { attemptReceipt: attempt, sourceEvidenceReceiptHash: receipt.contentHash },
    });
    expect(replayed.decisions.reward_candidate).toEqual({ eligible: true, blockers: [] });
  });

  it("binds feedback to the exact evidence and output revision", () => {
    const fixture = workEvidenceConformance;
    expect(() => assertFeedbackTargetsEvidence(fixture.feedback, fixture.receipt)).not.toThrow();
    const unrelated = evidenceArtifactRef({
      contentHash: contentHash("unrelated output"),
      mediaType: "text/plain",
      sizeBytes: 16,
    });
    expect(() => createWorkFeedbackReceipt({
      ...withoutHash(fixture.feedback),
      id: `work-feedback-${contentHash("unrelated").slice(0, 24)}`,
      outputRevisionRef: unrelated,
    }, fixture.receipt)).toThrow(/output revision/);
  });

  it("projects only bounded receipt references into authoring input", () => {
    const authoring = toWorkEvidenceAuthoringInput(
      workEvidenceConformance.receipt,
      workEvidenceConformance.activeEligibility,
    );
    expect(authoring.evalCandidate).toBe(true);
    expect(authoring).not.toHaveProperty("prompt");
    expect(authoring).not.toHaveProperty("privateTrace");
  });
});

function withoutHash<T extends { contentHash: string }>(value: T): Omit<T, "contentHash"> {
  const { contentHash: _contentHash, ...content } = value;
  return content;
}
