import { describe, expect, it } from "vitest";

import { contentHash, verifyAttemptReceipt } from "../packages/evals/src/index.js";
import { GradeResultSchema, TaskAttemptArtifactSchema } from "../packages/contracts/src/index.js";
import { compileDesktopHarnessContext, projectDesktopAttemptReceipt } from "../apps/server/src/training/portable-evals-adapter.js";
import { attemptFixture, tasksetFixture } from "./helpers/training-fixtures.js";

describe("portable Desktop eval adapter", () => {
  it("compiles the current Taskset/model identity without serializing authoring state", () => {
    const taskset = tasksetFixture({ ready: true });
    const context = compileDesktopHarnessContext({
      taskset,
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
      now: () => "2026-08-03T00:00:00.000Z",
    });
    expect(context.runManifest.tasksetRelease.contentHash).toBe(context.tasksetRelease.contentHash);
    expect(context.runManifest.harnessRelease.contentHash).toBe(context.harnessRelease.contentHash);
    expect(context.tasksetRelease.tasks).toHaveLength(2);
    expect(JSON.stringify(context)).not.toContain("sourceRefs");
    expect(JSON.stringify(context)).not.toContain("consent");
  });

  it("projects legacy persistence into a hash-bound canonical receipt", () => {
    const taskset = tasksetFixture({ ready: true });
    const context = compileDesktopHarnessContext({
      taskset,
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
      now: () => "2026-08-03T00:00:00.000Z",
    });
    const attempt = attemptFixture();
    const grade = GradeResultSchema.parse({
      schemaVersion: "openpond.gradeResult.v1",
      id: "grade-fixture",
      attemptId: attempt.id,
      graderSetHash: contentHash(taskset.graders),
      score: 1,
      passed: true,
      components: [{ graderId: "expected_output", graderVersion: "1", score: 1, passed: true, hardGate: true, rewardEligible: true, feedback: "passed", evidenceRefs: [], judge: null, calibrationStatus: "not_applicable" }],
      failureClass: null,
      feedback: [],
      rewardEligible: true,
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const artifact = TaskAttemptArtifactSchema.parse({
      schemaVersion: "openpond.taskAttemptArtifact.v1",
      id: "trace-fixture",
      tasksetId: taskset.id,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      kind: "runtime_trace",
      path: "traces/fixture.json",
      mediaType: "application/json",
      sha256: contentHash("trace"),
      sizeBytes: 5,
      createdAt: "2026-08-03T00:00:00.000Z",
      metadata: {},
    });
    const receipt = projectDesktopAttemptReceipt({ manifest: context.runManifest, attempt, grade, artifacts: [artifact] });
    expect(receipt.legacyAttemptRef).toBe(attempt.id);
    expect(receipt.traceHash).toBe(artifact.sha256);
    expect(receipt.graderEvidenceRefs).toHaveLength(1);
    expect(verifyAttemptReceipt(receipt)).toBe(true);
  });

  it.each([
    ["policy_failure", true],
    ["grader_failure", true],
    ["environment_failure", true],
    ["infrastructure_failure", false],
    ["timeout", false],
    ["cancelled", false],
  ] as const)("preserves %s classification and terminal semantics", (failureClass, terminal) => {
    const taskset = tasksetFixture({ ready: true });
    const context = compileDesktopHarnessContext({
      taskset,
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
      now: () => "2026-08-03T00:00:00.000Z",
    });
    const attempt = attemptFixture({
      infrastructureError: failureClass === "infrastructure_failure" ? "runtime unavailable" : null,
      metadata: failureClass === "infrastructure_failure" ? {} : { failureClass },
    });
    const grade = GradeResultSchema.parse({
      schemaVersion: "openpond.gradeResult.v1",
      id: `grade-${failureClass}`,
      attemptId: attempt.id,
      graderSetHash: contentHash(taskset.graders),
      score: failureClass === "infrastructure_failure" ? null : 0,
      passed: false,
      components: [{ graderId: "expected_output", graderVersion: "1", score: 0, passed: false, hardGate: true, rewardEligible: false, feedback: failureClass, evidenceRefs: [], judge: null, calibrationStatus: "not_applicable" }],
      failureClass,
      feedback: [failureClass],
      rewardEligible: false,
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const receipt = projectDesktopAttemptReceipt({ manifest: context.runManifest, attempt, grade, artifacts: [] });
    expect(receipt).toMatchObject({ failureClass, terminal });
    expect(verifyAttemptReceipt(receipt)).toBe(true);
  });
});
