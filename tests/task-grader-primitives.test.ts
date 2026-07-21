import { describe, expect, test } from "vitest";
import { gradeAttempt } from "../packages/taskset-sdk/src";
import { attemptFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("deterministic grader primitives", () => {
  test("executes content, schema, file, diff, test, runtime-event, and state graders", async () => {
    const task = tasksetFixture().tasks[1]!;
    const attempt = attemptFixture({ output: { text: "Goodbye friend", testsPassed: true, diffAccepted: true }, artifactRefs: ["artifact/report.json"], runtimeEventRefs: ["event/tool.completed"] });
    const graders = [
      { id: "content", version: "1", label: "Content", kind: "content" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: false, config: { includes: ["Goodbye"], excludes: ["secret"] }, metadata: {} },
      { id: "schema", version: "1", label: "Schema", kind: "schema" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: false, config: { requiredKeys: ["text"] }, metadata: {} },
      { id: "file", version: "1", label: "File", kind: "file" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: false, config: { pathIncludes: "report.json" }, metadata: {} },
      { id: "diff", version: "1", label: "Diff", kind: "diff" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: false, config: {}, metadata: {} },
      { id: "test", version: "1", label: "Test", kind: "test" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: false, config: {}, metadata: {} },
      { id: "runtime", version: "1", label: "Runtime", kind: "runtime_event" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: false, config: { requiredEvents: ["tool.completed"] }, metadata: {} },
      { id: "state", version: "1", label: "State", kind: "state" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: true, config: { fields: ["text"] }, metadata: {} },
    ];
    const grade = await gradeAttempt({ task, attempt, graders });
    expect(grade.passed).toBe(true);
    expect(grade.components.map((item) => item.graderId)).toEqual(graders.map((item) => item.id));
  });

  test("supports exact content fields authored for deterministic graders", async () => {
    const task = tasksetFixture().tasks[1]!;
    const grader = { id: "exact", version: "1", label: "Exact", kind: "content" as const, weight: 1, hardGate: true, rewardEligible: false, privileged: true, config: { operator: "exact_equals", outputField: "response", expectedValue: "expected", trimWhitespace: false, normalizeUnicode: false }, metadata: {} };
    await expect(gradeAttempt({ task, attempt: attemptFixture({ output: { response: "expected" } }), graders: [grader] })).resolves.toMatchObject({ passed: true, score: 1 });
    await expect(gradeAttempt({ task, attempt: attemptFixture({ output: { response: "expected\n" } }), graders: [grader] })).resolves.toMatchObject({ passed: false, score: 0 });
  });

  test("extracts and compares deterministic mathematical final answers", async () => {
    const task = {
      ...tasksetFixture().tasks[1]!,
      expectedOutput: { text: "1,234" },
    };
    const grader = {
      id: "math-final",
      version: "1",
      label: "Math final answer",
      kind: "content" as const,
      weight: 1,
      hardGate: true,
      rewardEligible: true,
      privileged: true,
      config: {
        operator: "final_answer_equals_expected",
        outputField: "text",
        expectedField: "text",
      },
      metadata: {},
    };
    await expect(
      gradeAttempt({
        task,
        attempt: attemptFixture({
          output: { text: "Reasoning here. Therefore, \\\\boxed{1234}." },
        }),
        graders: [grader],
      }),
    ).resolves.toMatchObject({ passed: true, score: 1, rewardEligible: true });
    await expect(
      gradeAttempt({
        task,
        attempt: attemptFixture({ output: { text: "#### 1235" } }),
        graders: [grader],
      }),
    ).resolves.toMatchObject({ passed: false, score: 0, rewardEligible: false });
  });
});
