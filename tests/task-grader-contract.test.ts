import { describe, expect, test } from "vitest";
import { GradeResultSchema, GraderSpecSchema, TaskAttemptResultSchema } from "../packages/contracts/src";
import { attemptFixture } from "./helpers/training-fixtures";

describe("grader contracts", () => {
  test("bounds attempts and requires calibrated model-judge fixtures", () => {
    expect(TaskAttemptResultSchema.safeParse(attemptFixture()).success).toBe(true);
    expect(TaskAttemptResultSchema.safeParse({ ...attemptFixture(), latencyMs: -1 }).success).toBe(false);
    expect(GraderSpecSchema.safeParse({ id: "judge", version: "1", label: "Judge", kind: "model_judge", weight: 1, hardGate: false, rewardEligible: true, privileged: true, rubric: "Score it", judge: { providerId: "openpond", modelId: "judge" }, calibrationFixtureRefs: [], calibrationStatus: "passed", temperature: 0, metadata: {} }).success).toBe(false);
    expect(GradeResultSchema.safeParse({ score: 2 }).success).toBe(false);
  });
});
