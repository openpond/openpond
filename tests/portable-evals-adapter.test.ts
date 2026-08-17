import { describe, expect, it } from "vitest";

import {
  verifyArtifactManifest,
  verifyAttemptReceipt,
  verifyRewardReceipt,
} from "../packages/evals/src/index.js";
import { contentHash } from "../packages/harness/src/index.js";
import { GradeResultSchema, TaskAttemptArtifactSchema, emptyOpenPondProfileState } from "../packages/contracts/src/index.js";
import {
  compileDesktopHarnessContext,
  projectDesktopAttemptReceipt,
  projectDesktopCanonicalReceipts,
  projectDesktopCanonicalRollout,
} from "../apps/server/src/training/portable-evals-adapter.js";
import { benchmarkRefinerRewardPacket } from "../apps/server/src/training/harness-refiner-benchmark-refiner-stage.js";
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
    expect(context.tasksetRelease.environmentRelease).toEqual({
      id: context.environmentRelease.id,
      contentHash: context.environmentRelease.contentHash,
    });
    expect(context.tasksetRelease.verifierSetRelease).toEqual({
      id: context.verifierSetRelease.id,
      contentHash: context.verifierSetRelease.contentHash,
    });
    expect(context.tasksetRelease.tasks).toHaveLength(2);
    expect(JSON.stringify(context)).not.toContain("sourceRefs");
    expect(JSON.stringify(context)).not.toContain("consent");
  });

  it("keeps Harness identity independent from the concrete Taskset environment", () => {
    const first = tasksetFixture({ ready: true });
    const second = structuredClone(first);
    second.environment = {
      ...second.environment,
      entrypoint: `${second.environment.entrypoint}-candidate`,
    };
    const firstContext = compileDesktopHarnessContext({
      taskset: first,
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
    });
    const secondContext = compileDesktopHarnessContext({
      taskset: second,
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
    });
    expect(secondContext.tasksetRelease.contentHash).not.toBe(firstContext.tasksetRelease.contentHash);
    expect(secondContext.harnessRelease.contentHash).toBe(firstContext.harnessRelease.contentHash);
  });

  it("uses an admitted Harness workspace release without reading mutable Profile identity", () => {
    const taskset = tasksetFixture({ ready: true });
    const admitted = compileDesktopHarnessContext({
      taskset,
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
    });
    const profile = {
      ...emptyOpenPondProfileState(),
      mode: "local" as const,
      git: {
        isRepo: true,
        branch: "main",
        head: "profile-mutated-after-release",
        shortHead: "mutated",
        dirty: true,
        upstream: null,
        ahead: null,
        behind: null,
        remoteUrl: null,
        files: [],
        error: null,
      },
    };
    const selected = compileDesktopHarnessContext({
      taskset,
      profile,
      releasedHarness: {
        agentSnapshot: admitted.agentSnapshot,
        harnessRelease: admitted.harnessRelease,
      },
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
    });

    expect(selected.harnessRelease).toEqual(admitted.harnessRelease);
    expect(selected.agentSnapshot).toEqual(admitted.agentSnapshot);
    expect(selected.runManifest.harnessRelease.contentHash).toBe(admitted.harnessRelease.contentHash);
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

  it("projects a failed deterministic grade into an eligible canonical zero reward", () => {
    const taskset = tasksetFixture({ ready: true });
    const context = compileDesktopHarnessContext({
      taskset,
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
      now: () => "2026-08-03T00:00:00.000Z",
    });
    const attempt = attemptFixture({ output: { text: "incorrect" } });
    const grade = GradeResultSchema.parse({
      schemaVersion: "openpond.gradeResult.v1",
      id: "grade-policy-failure-canonical",
      attemptId: attempt.id,
      graderSetHash: contentHash(taskset.graders),
      score: 0,
      passed: false,
      components: [{
        graderId: "expected_output",
        graderVersion: "1",
        score: 0,
        passed: false,
        hardGate: true,
        rewardEligible: true,
        feedback: "mismatch",
        evidenceRefs: [],
        judge: null,
        calibrationStatus: "not_applicable",
      }],
      failureClass: "policy_failure",
      feedback: ["mismatch"],
      rewardEligible: true,
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const canonical = projectDesktopCanonicalReceipts({
      context,
      attempt,
      grade,
      artifacts: [],
    });
    expect(canonical.rewardReceipt).toMatchObject({
      status: "scored",
      reward: 0,
      learningEligible: true,
      outcomeClass: "policy_failure",
      failureOwner: "policy",
    });
    expect(verifyAttemptReceipt(canonical.attemptReceipt)).toBe(true);
    expect(verifyArtifactManifest(canonical.artifactManifest)).toBe(true);
    expect(verifyRewardReceipt(canonical.rewardReceipt)).toBe(true);
    const rollout = projectDesktopCanonicalRollout({
      context,
      attempt,
      artifacts: [],
      canonical,
    });
    expect(rollout).toMatchObject({
      reward: { status: "scored", value: 0, learningEligible: true },
      optimizerSample: null,
      environmentExecutions: [{ status: "completed" }],
    });
  });

  it("makes a missing declared output a scored policy failure", () => {
    const taskset = tasksetFixture({ ready: true });
    taskset.tasks[1]!.requiredOutputs = [{
      path: "index.html",
      mediaType: "text/html",
      maxBytes: 1_000_000,
      metadata: {},
    }];
    const context = compileDesktopHarnessContext({
      taskset,
      model: { providerId: "custom-openai-compatible", modelId: "fixture" },
      now: () => "2026-08-03T00:00:00.000Z",
    });
    const attempt = attemptFixture();
    const grade = GradeResultSchema.parse({
      schemaVersion: "openpond.gradeResult.v1",
      id: "grade-missing-output-canonical",
      attemptId: attempt.id,
      graderSetHash: contentHash(taskset.graders),
      score: 1,
      passed: true,
      components: [{
        graderId: "expected_output",
        graderVersion: "1",
        score: 1,
        passed: true,
        hardGate: true,
        rewardEligible: true,
        feedback: "state matched",
        evidenceRefs: [],
        judge: null,
        calibrationStatus: "not_applicable",
      }],
      failureClass: null,
      feedback: [],
      rewardEligible: true,
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const canonical = projectDesktopCanonicalReceipts({ context, attempt, grade, artifacts: [] });
    expect(canonical.artifactManifest.entries[0]).toMatchObject({
      requiredOutputPath: "index.html",
      status: "missing",
      failureOwner: "policy",
    });
    expect(canonical.rewardReceipt).toMatchObject({
      status: "scored",
      reward: 0,
      learningEligible: true,
      passed: false,
      outcomeClass: "incomplete_output",
      failureOwner: "policy",
    });

    const packet = benchmarkRefinerRewardPacket({
      attempt,
      artifactManifest: canonical.artifactManifest,
      rewardReceipt: canonical.rewardReceipt,
      artifactCount: 0,
    });
    expect(packet).toMatchObject({
      schemaVersion: "openpond.refinerRewardPacket.v1",
      attemptRef: canonical.rewardReceipt.attemptRef,
      artifactManifest: {
        ref: {
          id: canonical.artifactManifest.id,
          contentHash: canonical.artifactManifest.contentHash,
        },
        entryCount: 1,
        truncated: false,
      },
      rewardReceipt: canonical.rewardReceipt,
    });
    expect(JSON.stringify(packet)).not.toContain(taskset.tasks[1]!.expectedOutput);
  });
});
