import { describe, expect, test } from "bun:test";
import { TaskCandidateSchema, TaskMinerConfigSchema, TrainingTacticRecommendationSchema } from "../packages/contracts/src";

describe("task miner contracts", () => {
  test("uses conservative local defaults and rejects malformed candidates", () => {
    const config = TaskMinerConfigSchema.parse({ schemaVersion: "openpond.taskMinerConfig.v1" });
    expect(config).toMatchObject({ enabled: false, localOnly: true, observationWindowDays: 30, minimumRecurrence: 3, clustering: "hybrid_deterministic_first", consentRequired: true });
    expect(TaskCandidateSchema.safeParse({ schemaVersion: "openpond.taskCandidate.v1" }).success).toBe(false);
    expect(TrainingTacticRecommendationSchema.safeParse({ tactic: "sft", eligible: true, reasons: [] }).success).toBe(false);
  });
});
