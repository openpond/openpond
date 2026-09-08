import { describe, expect, test } from "vitest";
import { gradeAttempt as gradeLocalAttempt, materializePortableTasksetRelease } from "../packages/taskset-sdk/src";
import { gradeEvidence } from "@openpond/evals/graders";
import { createTasksetPackage } from "openpond-sdk/taskset-packages";
import { prepareImportedTasksetPackage } from "../apps/server/src/training/taskset-package-import.js";
import { attemptFixture, tasksetFixture } from "./helpers/training-fixtures";

// A grader must retain its meaning through real release construction and import,
// including negative attempts; native-only checks missed changed configuration.
async function gradeAttempt(input: Parameters<typeof gradeLocalAttempt>[0]) {
  const native = await gradeLocalAttempt(input);
  const taskset = { ...tasksetFixture({ graders: input.graders }), tasks: [{ ...input.task, assets: [], privilegedContextRef: null }] };
  const releases = materializePortableTasksetRelease({ taskset, adapterId: "grader-parity" });
  const portable = await gradeEvidence({ task: releases.tasksetRelease.tasks[0]!, graders: releases.tasksetRelease.graders,
    evidence: { output: input.attempt.output, artifactRefs: input.attempt.artifactRefs, runtimeEventRefs: input.attempt.runtimeEventRefs, infrastructureError: input.attempt.infrastructureError } });
  const value = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset: releases.tasksetRelease, environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease, files: [] });
  const imported = prepareImportedTasksetPackage({ package: value, profileId: "grader-import", name: "Imported graders", createdAt: input.attempt.completedAt });
  const roundtrip = await gradeLocalAttempt({ ...input, task: imported.taskset.tasks[0]!, graders: imported.taskset.graders });
  const outcomes = (items: Array<{ score: number | null; passed: boolean }>) => items.map(({ score, passed }) => ({ score, passed }));
  expect(outcomes(portable)).toEqual(outcomes(native.components));
  expect(outcomes(roundtrip.components)).toEqual(outcomes(native.components));
  expect(materializePortableTasksetRelease({ taskset: imported.taskset, adapterId: "grader-parity" }).tasksetRelease).toEqual(value.taskset);
  return native;
}

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
    const failed = await gradeAttempt({ task, attempt: attemptFixture({ output: { response: "secret", testsPassed: false, diffAccepted: false }, artifactRefs: [], runtimeEventRefs: [] }), graders });
    expect(failed.components.every(component => component.score === 0 && !component.passed)).toBe(true);
  });

  test("keeps empty and unsupported checks unscorable through package transfer", async () => {
    const task = tasksetFixture().tasks[1]!;
    for (const check of [
      { kind: "content" as const, config: { includes: [] } },
      { kind: "content" as const, config: { operator: "unknown" } },
      { kind: "schema" as const, config: { requiredKeys: [] } },
      { kind: "file" as const, config: {} },
      { kind: "runtime_event" as const, config: { requiredEvents: [] } },
      { kind: "state" as const, config: { fields: ["missing"] } },
    ]) {
      const grader = { id: "unscorable", version: "1", label: "Unscorable", weight: 1, hardGate: false, rewardEligible: true, privileged: false, metadata: {}, ...check };
      const result = await gradeAttempt({ task, attempt: attemptFixture(), graders: [grader] });
      expect(result).toMatchObject({ score: null, rewardEligible: false, failureClass: "grader_failure", components: [{ score: null }] });
    }
  });

  test("supports exact content fields authored for deterministic graders", async () => {
    const task = tasksetFixture().tasks[1]!;
    const grader = { id: "exact", version: "1", label: "Exact", kind: "content" as const, weight: 1, hardGate: true, rewardEligible: false, privileged: true, config: { operator: "exact_equals", outputField: "response", expectedValue: "expected", trimWhitespace: false, normalizeUnicode: false }, metadata: {} };
    await expect(gradeAttempt({ task, attempt: attemptFixture({ output: { response: "expected" } }), graders: [grader] })).resolves.toMatchObject({ passed: true, score: 1 });
    await expect(gradeAttempt({ task, attempt: attemptFixture({ output: { response: "expected\n" } }), graders: [grader] })).resolves.toMatchObject({ passed: false, score: 0 });
  });

  test("validates forced JSON semantically against the structured output contract", async () => {
    const task = tasksetFixture().tasks[1]!;
    const grader = {
      id: "structured-selection",
      version: "1",
      label: "Structured selection",
      kind: "schema" as const,
      weight: 1,
      hardGate: true,
      rewardEligible: true,
      privileged: false,
      config: {
        operator: "json_schema_subset",
        jsonField: "text",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["traits"],
          properties: {
            traits: {
              type: "object",
              additionalProperties: false,
              required: ["background", "skin"],
              properties: {
                background: { type: "string", enum: ["background-001", "background-002"] },
                skin: { type: "string", enum: ["skin-001"] },
              },
            },
          },
        },
      },
      metadata: {},
    };
    await expect(gradeAttempt({
      task,
      attempt: attemptFixture({
        output: { text: '{"traits":{"background":"background-002","skin":"skin-001"}}' },
      }),
      graders: [grader],
    })).resolves.toMatchObject({ passed: true, score: 1 });
    await expect(gradeAttempt({
      task,
      attempt: attemptFixture({
        output: { text: '{"traits":{"background":"unknown","skin":"skin-001"}}' },
      }),
      graders: [grader],
    })).resolves.toMatchObject({ passed: false, score: 0 });
    await expect(gradeAttempt({
      task,
      attempt: attemptFixture({ output: { text: "not json" } }),
      graders: [grader],
    })).resolves.toMatchObject({ passed: false, score: 0 });
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
    ).resolves.toMatchObject({ passed: false, score: 0, rewardEligible: true });
  });
});
