import { describe, expect, test } from "vitest";
import { gradeAttempt } from "../packages/taskset-sdk/src";
import { runSandboxedVerifier } from "../apps/server/src/training/sandboxed-verifier";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import { buildTaskset, computeTasksetHash } from "../packages/taskset-sdk/src";
import { attemptFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tasksetPackageDirectoryId } from "../apps/server/src/training/taskset-package-path.js";
import os from "node:os";
import path from "node:path";

describe("grader execution", () => {
  test("records calibrated judge identity and custom-verifier evidence", async () => {
    const task = tasksetFixture().tasks[1]!;
    const judge = { id: "judge", version: "1", label: "Judge", kind: "model_judge" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: true, rubric: "Match intent", judge: { providerId: "openpond", modelId: "judge-v1" }, calibrationFixtureRefs: ["fixture_positive"], calibrationStatus: "passed" as const, temperature: 0, metadata: {} };
    const custom = { id: "custom", version: "1", label: "Custom", kind: "custom_verifier" as const, weight: 1, hardGate: false, rewardEligible: true, privileged: true, module: "graders/custom.js", exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" as const, metadata: {} };
    const grade = await gradeAttempt({ task, attempt: attemptFixture(), graders: [judge, custom], modelJudge: async () => ({ score: 0.8, passed: true, feedback: "rubric passed", evidenceRefs: ["judge-output"] }), customVerifier: async () => ({ score: 1, passed: true, feedback: "verified", evidenceRefs: ["artifact"] }) });
    expect(grade.components[0]).toMatchObject({ judge: judge.judge, calibrationStatus: "passed", score: 0.8 });
    expect(grade.components[1]?.evidenceRefs).toEqual(["artifact"]);
    // Missing execution and pending human review are absent scores, including
    // their components, and cannot be mistaken for a scored training failure.
    for (const grader of [judge, custom, { id: "human", version: "1", label: "Human", kind: "human" as const, weight: 1, hardGate: false, rewardEligible: false, privileged: true, rubric: "Review the result", reviewerRole: "reviewer", metadata: {} }]) {
      const missing = await gradeAttempt({ task, attempt: attemptFixture(), graders: [grader] });
      expect(missing).toMatchObject({ score: null, rewardEligible: false, failureClass: "grader_failure", components: [{ score: null, rewardEligible: false }] });
    }
  });

  test("infrastructure failure always returns null score and no reward", async () => {
    const taskset = tasksetFixture();
    const grade = await gradeAttempt({ task: taskset.tasks[1]!, attempt: attemptFixture({ infrastructureError: "GPU unavailable" }), graders: taskset.graders });
    expect(grade).toMatchObject({ score: null, passed: false, rewardEligible: false, failureClass: "infrastructure_failure" });
  });

  test("derives model-judge cost from admitted pricing when explicit cost is omitted", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const judge = {
        id: "judge",
        version: "1",
        label: "Judge",
        kind: "model_judge" as const,
        weight: 1,
        hardGate: true,
        rewardEligible: true,
        privileged: true,
        rubric: "Match intent",
        judge: { providerId: "openpond", modelId: "judge-v1" },
        calibrationFixtureRefs: ["fixture_positive"],
        calibrationStatus: "passed" as const,
        temperature: 0,
        metadata: {},
      };
      const taskset = tasksetFixture({ graders: [judge] });
      await store.upsertTaskset(taskset);
      const attempt = attemptFixture({
        tasksetId: taskset.id,
        taskId: taskset.tasks[1]!.id,
      });
      const service = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelJudge: async () => ({
          score: 1,
          passed: true,
          feedback: "matched",
          usage: {
            promptTokens: 1_000,
            completionTokens: 200,
            promptTokensDetails: { cachedTokens: 400 },
          },
        }),
      });

      await service.grade({
        tasksetId: taskset.id,
        taskId: taskset.tasks[1]!.id,
        attempt,
        hostedTokenPricing: {
          version: "test-v1",
          source: "test",
          effectiveAt: "2026-08-11T00:00:00.000Z",
          inputUsdPerMillionTokens: 2,
          cachedInputUsdPerMillionTokens: 0.5,
          outputUsdPerMillionTokens: 4,
        },
      });

      expect(service.consumeGraderUsage([attempt.id])).toEqual({
        inputTokens: 1_000,
        outputTokens: 200,
        totalTokens: 1_200,
        costUsd: 0.0022,
      });
    }));

  test("runs generated verifier code without process, imports, network, or path escape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "verifier-sandbox-"));
    try {
      await mkdir(path.join(root, "graders"));
      const module = path.join(root, "graders", "verify.js");
      await writeFile(module, "export function verify({ attempt }) { return { score: attempt.output.text ? 1 : 0, passed: Boolean(attempt.output.text), feedback: 'verified' }; }\n");
      const grader = { id: "custom", version: "1", label: "Custom", kind: "custom_verifier" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: true, module: "graders/verify.js", exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" as const, metadata: {} };
      await expect(runSandboxedVerifier({ grader, task: tasksetFixture().tasks[1]!, attempt: attemptFixture(), allowedRoot: root })).resolves.toMatchObject({ score: 1, passed: true });
      await writeFile(module, "export function verify({ output, expectedOutput }) { const passed = output.text === expectedOutput.text; return { score: Number(passed), passed, feedback: passed ? 'flat aliases matched' : 'mismatch' }; }\n");
      await expect(runSandboxedVerifier({ grader, task: tasksetFixture().tasks[1]!, attempt: attemptFixture(), allowedRoot: root })).resolves.toMatchObject({ score: 1, passed: true, feedback: "flat aliases matched" });
      await writeFile(module, "export function verify() { return process.env; }\n");
      await expect(runSandboxedVerifier({ grader, task: tasksetFixture().tasks[1]!, attempt: attemptFixture(), allowedRoot: root })).rejects.toThrow("process");
      await writeFile(module, "export function verify() { for (;;) {} }\n");
      const controller = new AbortController();
      const pending = runSandboxedVerifier({ grader: { ...grader, timeoutMs: 5_000 }, task: tasksetFixture().tasks[1]!, attempt: attemptFixture(), allowedRoot: root, signal: controller.signal });
      const cancel = setTimeout(() => controller.abort(new Error("Cancelled verifier")), 100);
      await expect(pending).rejects.toThrow("Cancelled verifier");
      clearTimeout(cancel);
      await expect(runSandboxedVerifier({ ...{ grader }, grader: { ...grader, module: "../outside.js" }, task: tasksetFixture().tasks[1]!, attempt: attemptFixture(), allowedRoot: root })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // A partial or ambiguous fixture set must not produce a passing calibration.
  test.each(["missing", "duplicate"])("rejects %s calibration fixtures before calling any judge", async (problem) => withTrainingStore(async ({ store, directory }) => {
    const judge = { id: "judge", version: "1", label: "Judge", kind: "model_judge" as const, weight: 1, hardGate: true, rewardEligible: false, privileged: true, rubric: "Match the expected outcome", judge: { providerId: "openpond", modelId: "judge-v1" }, calibrationFixtureRefs: ["fixture_positive", "missing_fixture"], calibrationStatus: "pending" as const, temperature: 0, metadata: { requestedRewardEligible: true } };
    const taskset = tasksetFixture({ graders: [judge] });
    if (problem === "duplicate") {
      judge.calibrationFixtureRefs = ["fixture_positive"];
      taskset.graders = [judge];
      taskset.graderFixtures.push({ ...taskset.graderFixtures.find(fixture => fixture.id === "fixture_positive")! });
    }
    await store.upsertTaskset(taskset);
    let calls = 0;
    const service = createTaskEvaluationService({ store, storeDir: directory, loadProfileState: async () => ({ mode: "local", sourcePath: directory } as any), modelJudge: async () => { calls += 1; return { score: 1, passed: true, feedback: "matched" }; } });
    await expect(service.calibrateModelJudges(taskset.id)).rejects.toThrow(`exactly one fixture for ${problem === "missing" ? "missing_fixture" : "fixture_positive"}`);
    expect(calls).toBe(0);
    expect(await store.getTaskset(taskset.id)).toMatchObject({ revision: taskset.revision, graders: [{ calibrationStatus: "pending", rewardEligible: false }] });
  }));

  // Matching pass flags cannot calibrate a judge that misses the authored score.
  test.each([1, 0.75])("checks score expectation %s before enabling calibrated reward", async (expectedScore) => withTrainingStore(async ({ store, directory }) => {
    const judge = { id: "judge", version: "1", label: "Judge", kind: "model_judge" as const, weight: 1, hardGate: true, rewardEligible: false, privileged: true, rubric: "Match the expected outcome", judge: { providerId: "openpond", modelId: "judge-v1" }, calibrationFixtureRefs: ["fixture_positive", "fixture_negative", "fixture_boundary", "fixture_adversarial", "fixture_prompt", "fixture_infra"], calibrationStatus: "pending" as const, temperature: 0, metadata: { requestedRewardEligible: true } };
    const taskset = tasksetFixture({ graders: [judge] });
    taskset.graderFixtures.find(fixture => fixture.id === "fixture_positive")!.metadata.expectedScore = expectedScore;
    taskset.contentHash = computeTasksetHash(taskset);
    const profileSource = path.join(directory, "profile");
    await buildTaskset(taskset, path.join(profileSource, "tasksets", taskset.id));
    const originalDirectory = path.join(directory, "training", "tasksets", taskset.id);
    await buildTaskset(taskset, originalDirectory);
    await writeFile(path.join(originalDirectory, "context.txt"), "private calibration context");
    const originalManifest = await readFile(path.join(originalDirectory, "taskset.json"));
    await store.upsertTaskset(taskset);
    const service = createTaskEvaluationService({ store, storeDir: directory, loadProfileState: async () => ({ mode: "local", sourcePath: profileSource } as any), modelJudge: async ({ attempt }) => { const passed = attempt.output.text === "Goodbye friend"; return { score: passed ? 1 : 0, passed, feedback: passed ? "matched" : "did not match" }; } });
    const calibrated = await service.calibrateModelJudges(taskset.id);
    expect(calibrated.passed).toBe(expectedScore === 1);
    expect(calibrated.taskset).toMatchObject({
      revision: taskset.revision + 1,
      metadata: {
        judgeCalibration: {
          parentTasksetHash: taskset.contentHash,
          graderIds: ["judge"],
        },
      },
    });
    expect(calibrated.taskset.graders[0]).toMatchObject({ kind: "model_judge", calibrationStatus: expectedScore === 1 ? "passed" : "failed", rewardEligible: expectedScore === 1, metadata: { calibrationEvidenceHash: expect.any(String), calibrationAccuracy: expectedScore === 1 ? 1 : 5 / 6 } });
    expect(calibrated.taskset.contentHash).not.toBe(taskset.contentHash);
    const calibratedDirectory = path.join(directory, "training", "tasksets", tasksetPackageDirectoryId(calibrated.taskset));
    expect(calibratedDirectory).not.toBe(originalDirectory);
    expect(await readFile(path.join(calibratedDirectory, "context.txt"), "utf8")).toBe("private calibration context");
    expect(await readFile(path.join(originalDirectory, "taskset.json"))).toEqual(originalManifest);
    await expect(store.getTasksetRevision(taskset.id, taskset.revision, taskset.contentHash)).resolves.toMatchObject({
      contentHash: taskset.contentHash,
      revision: taskset.revision,
    });
  }));
});
