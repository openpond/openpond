import { describe, expect, test } from "vitest";
import { recommendTrainingTactic } from "../apps/server/src/training/tactic-recommender";
import type { TaskCandidateEvidence, TaskCandidateScorecard } from "../packages/contracts/src";

const evidence: TaskCandidateEvidence[] = [{ id: "evidence_1", kind: "repeated_success", sourceRefIds: ["source_1"], occurredAt: "2026-07-12T00:00:00Z", signature: "workflow", summary: "Worked", confidence: 0.9, consented: true, metadata: {} }, { id: "evidence_2", kind: "repeated_success", sourceRefIds: ["source_2"], occurredAt: "2026-07-12T00:00:00Z", signature: "workflow", summary: "Worked", confidence: 0.9, consented: true, metadata: {} }];
const scorecard: TaskCandidateScorecard = { frequency: 0.8, businessValue: 0.8, frontierCost: 0.8, signalQuality: 0.9, verifiability: 0.9, repeatability: 0.8, privacyRisk: 0.1, overall: 0.85 };

describe("training tactic recommender", () => {
  test("chooses retrieval for changing facts and SFT for approved demonstrations", () => {
    expect(recommendTrainingTactic({ evidence, scorecard, changingFacts: true }).tactic).toBe("retrieval");
    expect(recommendTrainingTactic({ evidence, scorecard }).tactic).toBe("sft");
  });

  test("recommends GRPO for verifiable expert labels", () => {
    const expertEvidence: TaskCandidateEvidence[] = evidence.map(
      (item) => ({ ...item, kind: "expert_label" }),
    );
    expect(
      recommendTrainingTactic({
        evidence: expertEvidence,
        scorecard,
      }).tactic,
    ).toBe("grpo_rft");
  });
});
