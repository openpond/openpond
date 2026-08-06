import { describe, expect, it } from "vitest";
import {
  GET_CONVERSATIONS_CONTRACT_VERSION,
  type GetConversationsToolResult,
  type LocalContinuousLearningDefinition,
  type LocalContinuousLearningState,
} from "@openpond/contracts";
import {
  createWorkEvidenceReceipt,
  workEvidenceConformance,
  type WorkEvidenceReceipt,
} from "@openpond/evals/evidence";

import type { StoredWorkEvidenceProjection } from "../store/store-work-evidence.js";
import {
  collectLocalLearningEvidence,
  normalizeLocalWorkEvidence,
} from "./local-learning-evidence.js";

describe("local Work-first learning evidence", () => {
  it("orders verified Work first and keeps chat as recurrence context", async () => {
    const verified = projection(workEvidenceConformance.receipt);
    const failed = projection(failedReceipt());
    const result = await collectLocalLearningEvidence({
      store: {
        listWorkEvidenceProjections: async () => [failed, verified],
        listWorkFeedbackForEvidence: async () => [],
      } as never,
      state: state(),
      definition: definition(),
      conversations: chatEvidence(2),
    });

    expect(result.schemaVersion).toBe("openpond.learningEvidenceView.v1");
    expect(result.lanes.work.evidence.map((item) => item.recommendationWeight))
      .toEqual(["verified_work", "discovery_only"]);
    expect(result.lanes.chat.evidence).toHaveLength(2);
    expect(result.lanes.chat.evidence.every(
      (item) => item.purpose === "recurrence_context",
    )).toBe(true);
  });

  it("keeps failed Work discovery-only", () => {
    const evidence = normalizeLocalWorkEvidence(
      projection(failedReceipt()),
      [],
      "personal",
    );
    expect(evidence).toMatchObject({
      recommendationWeight: "discovery_only",
      terminalStatus: "failed",
      failureClass: "model_failure",
      rewardCandidate: false,
    });
  });

  it("lets feedback change recommendation evidence without becoming reward", () => {
    const withoutFeedback = normalizeLocalWorkEvidence(
      projection(workEvidenceConformance.receipt),
      [],
      "personal",
    );
    const accepted = normalizeLocalWorkEvidence(
      projection(workEvidenceConformance.receipt),
      [workEvidenceConformance.feedback],
      "personal",
    );

    expect(withoutFeedback.feedbackSignal).toBe("none");
    expect(withoutFeedback.eligibleUses).not.toContain(
      "demonstration_candidate",
    );
    expect(accepted.feedbackSignal).toBe("accepted");
    expect(accepted.eligibleUses).toContain("demonstration_candidate");
    expect(accepted.eligibleUses).not.toContain("reward_candidate");
    expect(accepted.rewardCandidate).toBe(false);
  });
});

function failedReceipt(): WorkEvidenceReceipt {
  const { contentHash: _contentHash, ...fixture } =
    workEvidenceConformance.receipt;
  return createWorkEvidenceReceipt({
    ...fixture,
    id: `work-evidence-${"f".repeat(24)}`,
    terminal: { status: "failed", failureClass: "model_failure" },
  });
}

function projection(
  receipt: WorkEvidenceReceipt,
): StoredWorkEvidenceProjection {
  return { receipt } as StoredWorkEvidenceProjection;
}

function chatEvidence(count: number): GetConversationsToolResult {
  return {
    schemaVersion: GET_CONVERSATIONS_CONTRACT_VERSION,
    scope: "personal",
    inputWatermark: null,
    proposedWatermark: "2026-08-04T12:00:02.500Z",
    consideredSourceCount: count,
    excludedCounts: {
      notEligible: 0,
      revoked: 0,
      notCreatedByOwner: 0,
      multiParticipant: 0,
      outsideLookback: 0,
      dismissedFingerprint: 0,
      budgetBound: 0,
    },
    conversations: Array.from({ length: count }, (_, index) => ({
      sourceReference: {
        referenceId: `desktop:chat_${index}`,
        surface: "desktop",
        scope: "personal",
        experience: "chat",
        revision: `revision_${index}`,
        occurredAt: `2026-08-04T12:00:0${index}.000Z`,
        contentHash: `${index + 1}`.repeat(64),
      },
      title: `Chat ${index}`,
      messages: [
        {
          role: "user",
          text: "Repeat the release-note workflow.",
          createdAt: `2026-08-04T12:00:0${index}.000Z`,
        },
      ],
    })),
    emptyReason: null,
  };
}

function state(): LocalContinuousLearningState {
  return {
    scope: "personal",
    workspaceId: null,
  } as LocalContinuousLearningState;
}

function definition(): LocalContinuousLearningDefinition {
  return {
    limits: {
      lookbackDays: 30,
      maxConversations: 12,
    },
  } as LocalContinuousLearningDefinition;
}
