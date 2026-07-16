import { describe, expect, test } from "vitest";
import { gradeAttempt } from "../packages/taskset-sdk/src";
import { attemptFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("composite reward", () => {
  test("weights components and forces zero when a hard gate fails", async () => {
    const task = tasksetFixture().tasks[1]!;
    const graders = [{ id: "content", version: "1", label: "Content", kind: "content" as const, weight: 3, hardGate: false, rewardEligible: true, privileged: false, config: { includes: ["Goodbye"] }, metadata: {} }, { id: "hard", version: "1", label: "Hard", kind: "schema" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: false, config: { requiredKeys: ["citation"] }, metadata: {} }];
    const grade = await gradeAttempt({ task, attempt: attemptFixture(), graders });
    expect(grade).toMatchObject({ score: 0, passed: false, rewardEligible: false });
    expect(grade.components[0]?.score).toBe(1);
  });
});
