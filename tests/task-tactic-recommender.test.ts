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

  test("only recommends GRPO after useful baseline reward variance", () => {
    const baseline = { schemaVersion: "openpond.baselineReport.v1" as const, id: "baseline", tasksetId: "taskset", tasksetHash: "tasksethash", graderSetHash: "graderhash", attemptRefs: ["attempt"], gradeRefs: ["grade"], passAtK: { "1": 0.5 }, reward: { count: 4, mean: 0.5, min: 0, max: 1, variance: 0.25 }, failureClusters: {}, totalCostUsd: 0, userInterventions: 0, hackingChecksPassed: true, leakageChecksPassed: true, createdAt: "2026-07-12T00:00:00Z" };
    expect(recommendTrainingTactic({ evidence, scorecard, baseline }).tactic).toBe("grpo_rft");
  });
});
