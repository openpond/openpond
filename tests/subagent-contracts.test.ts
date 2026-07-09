import { describe, expect, test } from "bun:test";
import {
  SubagentRuntimeEventNameSchema,
  SubagentEvidenceRetentionPolicySchema,
  SubagentReviewRoutingReasonSchema,
  SubagentReviewStateSchema,
  SubagentRunSchema,
  SubagentRunStatusSchema,
  SubagentWorkerBriefSchema,
} from "@openpond/contracts";

describe("subagent contracts", () => {
  test("constructs typed worker brief defaults for runs", () => {
    const run = SubagentRunSchema.parse({
      id: "run_1",
      parentSessionId: "session_parent",
      roleId: "coding",
      objective: "Fix the failing test",
      required: true,
      createdAt: "2026-07-08T12:00:00.000Z",
    });

    expect(run.workerBrief).toEqual({
      plan: [],
      targetFiles: [],
      acceptanceCriteria: [],
      validationCommands: [],
      stopConditions: [],
    });
    expect(run.progress.phase).toBe("orient");
    expect(run.review.status).toBe("pending");
    expect(run.evidenceRetention).toEqual({
      kind: "retain_with_parent",
      messageRetentionDays: null,
      artifactRetentionDays: null,
      cleanupAfterExpiry: false,
    });
    expect(run.review.packetQuality).toEqual({
      status: "reviewable",
      issues: [],
      warnings: [],
      evidence: {
        finalSummaryPresent: false,
        finalSummaryLength: 0,
        requestedValidationCommandCount: 0,
        validationAttemptCount: 0,
        failedValidationCount: 0,
        testsRunCount: 0,
        changedFileCount: 0,
        patchRefPresent: false,
        diffRefPresent: false,
        artifactCount: 0,
        findingCount: 0,
        blockerCount: 0,
        unvalidatedWorkspaceChanges: false,
      },
    });
    expect(run.review.independentReviewRecommended).toBe(false);
    expect(run.review.reviewerRoutingReasons).toEqual([]);
    expect(run.review.reviewerRoutingEvidence).toEqual({
      packetQualityStatus: "reviewable",
      confidence: null,
      changedFileCount: 0,
      highRiskFileCount: 0,
      validationAttemptCount: 0,
      failedValidationCount: 0,
      missingRequestedValidation: false,
      providerFailureAfterChanges: false,
      userRequestedIndependentReview: false,
    });
  });

  test("accepts structured worker brief and review lifecycle statuses", () => {
    expect(
      SubagentEvidenceRetentionPolicySchema.parse({}),
    ).toEqual({
      kind: "retain_with_parent",
      messageRetentionDays: null,
      artifactRetentionDays: null,
      cleanupAfterExpiry: false,
    });
    expect(
      SubagentEvidenceRetentionPolicySchema.parse({
        messageRetentionDays: null,
        artifactRetentionDays: null,
      }),
    ).toMatchObject({
      cleanupAfterExpiry: false,
    });
    expect(() =>
      SubagentEvidenceRetentionPolicySchema.parse({
        messageRetentionDays: 0,
      })
    ).toThrow();

    expect(
      SubagentWorkerBriefSchema.parse({
        plan: ["Inspect the target files", "Patch the implementation"],
        targetFiles: ["apps/server/src/runtime/turn-runner.ts"],
        acceptanceCriteria: ["Child submits a review packet"],
        validationCommands: ["bun test tests/turn-runner-subagents.test.ts"],
        stopConditions: ["Report a blocker if validation cannot run"],
      }),
    ).toMatchObject({
      plan: ["Inspect the target files", "Patch the implementation"],
      validationCommands: ["bun test tests/turn-runner-subagents.test.ts"],
    });

    expect(SubagentRunStatusSchema.parse("submitted_for_review")).toBe("submitted_for_review");
    expect(SubagentRunStatusSchema.parse("needs_revision")).toBe("needs_revision");
    expect(SubagentRunStatusSchema.parse("accepted")).toBe("accepted");
    expect(SubagentRunStatusSchema.parse("failed_with_artifacts")).toBe("failed_with_artifacts");
    expect(SubagentRunStatusSchema.parse("superseded")).toBe("superseded");
    expect(SubagentReviewRoutingReasonSchema.parse("validation_missing")).toBe("validation_missing");
    expect(() => SubagentReviewRoutingReasonSchema.parse("provider_specific_unknown_risk")).toThrow();
    expect(() =>
      SubagentReviewStateSchema.parse({
        reviewerRoutingReasons: ["provider_specific_unknown_risk"],
      })
    ).toThrow();
    expect(
      SubagentRunSchema.parse({
        id: "run_dismissed",
        parentSessionId: "session_parent",
        roleId: "research",
        objective: "Dismiss failed work",
        createdAt: "2026-07-08T12:00:00.000Z",
        review: { status: "dismissed" },
      }).review.status,
    ).toBe("dismissed");
    expect(SubagentRuntimeEventNameSchema.parse("subagent.stale")).toBe("subagent.stale");
    expect(SubagentRuntimeEventNameSchema.parse("subagent.cleanup")).toBe("subagent.cleanup");
    expect(SubagentRuntimeEventNameSchema.parse("subagent.workspace_retained")).toBe("subagent.workspace_retained");
    expect(SubagentRuntimeEventNameSchema.parse("subagent.workspace_retention_expiring")).toBe("subagent.workspace_retention_expiring");
    expect(SubagentRuntimeEventNameSchema.parse("subagent.archived")).toBe("subagent.archived");
    expect(SubagentRuntimeEventNameSchema.parse("subagent.superseded")).toBe("subagent.superseded");
    expect(SubagentRuntimeEventNameSchema.parse("subagent.dismissed")).toBe("subagent.dismissed");
  });
});
