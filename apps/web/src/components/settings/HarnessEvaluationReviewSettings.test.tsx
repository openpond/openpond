import { renderToStaticMarkup } from "react-dom/server";
import type {
  HarnessEvaluationReviewReceipt,
  HarnessEvaluationReviewSchedule,
} from "@openpond/contracts";
import { describe, expect, it } from "vitest";

import { HarnessEvaluationReviewSettings } from "./HarnessEvaluationReviewSettings";

const schedule: HarnessEvaluationReviewSchedule = {
  enabled: false,
  activityEnabled: false,
  activityBatchSize: 10,
  cadence: "manual",
  maxEstimatedCostUsd: 0.1,
  nextRunAt: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  updatedAt: null,
};

describe("HarnessEvaluationReviewSettings", () => {
  it("offers canonical Taskset authoring only for a pending human review", () => {
    const html = renderToStaticMarkup(
      <HarnessEvaluationReviewSettings
        acceptingReviewId={null}
        busy={false}
        candidates={[]}
        onAcceptTasksetReview={() => undefined}
        onReview={() => undefined}
        qualifications={[]}
        reviews={[reviewReceipt("taskset")]}
        schedule={schedule}
      />,
    );

    expect(html).toContain("Build training Taskset");
    expect(html).toContain("3</strong> independent occurrences");
    expect(html).toContain("Review now");
    expect(html).toContain("Last review");
    expect(html).toContain("Last result");
    expect(html).toContain("Patterns");
    expect(html).toContain("Receipts stay compact");
    expect(html).not.toContain("Watermark");
  });

  it("does not offer Taskset authoring for no-action review receipts", () => {
    const html = renderToStaticMarkup(
      <HarnessEvaluationReviewSettings
        acceptingReviewId={null}
        busy={false}
        candidates={[]}
        onAcceptTasksetReview={() => undefined}
        onReview={() => undefined}
        qualifications={[]}
        reviews={[reviewReceipt("no_action")]}
        schedule={schedule}
      />,
    );

    expect(html).not.toContain("Build training Taskset");
    expect(html).toContain("No action");
    expect(html).toContain("No recurring patterns are being tracked");
    expect(html).toContain("Manual only");
  });
});

function reviewReceipt(
  classification: "taskset" | "no_action",
): HarnessEvaluationReviewReceipt {
  const hash = "a".repeat(64);
  return {
    schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1",
    id: `review-${classification}`,
    ownerScope: { kind: "personal", id: "personal" },
    workspaceRef: "workspace-1",
    harnessRelease: { id: "release-1", contentHash: hash },
    previousWatermark: null,
    nextWatermark: {
      cursor: hash,
      throughCreatedAt: "2026-08-08T22:30:45.811Z",
    },
    selectedEvidence: [],
    excludedEvidence: [],
    claim: classification === "taskset"
      ? {
          fingerprint: hash,
          recurrenceFamily: "model-policy-sequence-completion",
          statement: "The model repeatedly stops before verification and summary.",
          independentOccurrences: 3,
          unresolvedOccurrences: 3,
        }
      : null,
    classification,
    triage: [],
    reason: classification === "taskset"
      ? "Three independent occurrences require controlled measurement."
      : "No reusable claim was found.",
    nextAuthority: classification === "taskset" ? "human_review" : "none",
    maxEstimatedCostUsd: 0.1,
    tasksetProposal: null,
    evaluation: null,
    trainingQualification: null,
    policyVersion: "review-policy-v1",
    createdAt: "2026-08-08T22:30:45.811Z",
    metadata: {},
    contentHash: hash,
  };
}
