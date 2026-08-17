import { describe, expect, test } from "vitest";

import { recommendTrainingTactic } from "../apps/server/src/training/tactic-recommender";
import {
  GradeResultSchema,
  GraderSpecSchema,
  TaskAttemptResultSchema,
  TaskCandidateSchema,
  TaskMinerConfigSchema,
  TrainingTacticRecommendationSchema,
  type TaskCandidateEvidence,
  type TaskCandidateScorecard,
} from "../packages/contracts/src";
import { gradeAttempt } from "../packages/taskset-sdk/src";
import { attemptFixture, tasksetFixture } from "./helpers/training-fixtures";

const evidence: TaskCandidateEvidence[] = [
  { id: "evidence_1", kind: "repeated_success", sourceRefIds: ["source_1"], occurredAt: "2026-07-12T00:00:00Z", signature: "workflow", summary: "Worked", confidence: 0.9, consented: true, metadata: {} },
  { id: "evidence_2", kind: "repeated_success", sourceRefIds: ["source_2"], occurredAt: "2026-07-12T00:00:00Z", signature: "workflow", summary: "Worked", confidence: 0.9, consented: true, metadata: {} },
];
const scorecard: TaskCandidateScorecard = {
  frequency: 0.8,
  businessValue: 0.8,
  frontierCost: 0.8,
  signalQuality: 0.9,
  verifiability: 0.9,
  repeatability: 0.8,
  privacyRisk: 0.1,
  overall: 0.85,
};

describe("task evaluation contracts", () => {
  test("uses conservative miner defaults and rejects malformed candidates", () => {
    const config = TaskMinerConfigSchema.parse({ schemaVersion: "openpond.taskMinerConfig.v1" });
    expect(config).toMatchObject({
      enabled: false,
      localOnly: true,
      observationWindowDays: 30,
      minimumRecurrence: 3,
      clustering: "hybrid_deterministic_first",
      consentRequired: true,
    });
    expect(TaskCandidateSchema.safeParse({ schemaVersion: "openpond.taskCandidate.v1" }).success).toBe(false);
    expect(TrainingTacticRecommendationSchema.safeParse({ tactic: "sft", eligible: true, reasons: [] }).success).toBe(false);
  });

  test("bounds attempts and requires calibrated model-judge fixtures", () => {
    expect(TaskAttemptResultSchema.safeParse(attemptFixture()).success).toBe(true);
    expect(TaskAttemptResultSchema.safeParse({ ...attemptFixture(), latencyMs: -1 }).success).toBe(false);
    expect(GraderSpecSchema.safeParse({
      id: "judge",
      version: "1",
      label: "Judge",
      kind: "model_judge",
      weight: 1,
      hardGate: false,
      rewardEligible: true,
      privileged: true,
      rubric: "Score it",
      judge: { providerId: "openpond", modelId: "judge" },
      calibrationFixtureRefs: [],
      calibrationStatus: "passed",
      temperature: 0,
      metadata: {},
    }).success).toBe(false);
    expect(GradeResultSchema.safeParse({ score: 2 }).success).toBe(false);
  });

  test("weights reward components and forces zero when a hard gate fails", async () => {
    const task = tasksetFixture().tasks[1]!;
    const graders = [
      { id: "content", version: "1", label: "Content", kind: "content" as const, weight: 3, hardGate: false, rewardEligible: true, privileged: false, config: { includes: ["Goodbye"] }, metadata: {} },
      { id: "hard", version: "1", label: "Hard", kind: "schema" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: false, config: { requiredKeys: ["citation"] }, metadata: {} },
    ];
    const grade = await gradeAttempt({ task, attempt: attemptFixture(), graders });
    expect(grade).toMatchObject({ score: 0, passed: false, rewardEligible: true });
    expect(grade.components[0]?.score).toBe(1);
  });

  test("chooses retrieval for changing facts and SFT for approved demonstrations", () => {
    expect(recommendTrainingTactic({ evidence, scorecard, changingFacts: true }).tactic).toBe("retrieval");
    expect(recommendTrainingTactic({ evidence, scorecard }).tactic).toBe("sft");
  });

  test("recommends GRPO for verifiable expert labels", () => {
    const expertEvidence = evidence.map((item) => ({ ...item, kind: "expert_label" as const }));
    expect(recommendTrainingTactic({ evidence: expertEvidence, scorecard }).tactic).toBe("grpo_rft");
  });
});
