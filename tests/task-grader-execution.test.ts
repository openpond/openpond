import { describe, expect, test } from "bun:test";
import { gradeAttempt } from "../packages/taskset-sdk/src";
import { runSandboxedVerifier } from "../apps/server/src/training/sandboxed-verifier";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import { buildTaskset } from "../packages/taskset-sdk/src";
import { attemptFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  });

  test("infrastructure failure always returns null score and no reward", async () => {
    const taskset = tasksetFixture();
    const grade = await gradeAttempt({ task: taskset.tasks[1]!, attempt: attemptFixture({ infrastructureError: "GPU unavailable" }), graders: taskset.graders });
    expect(grade).toMatchObject({ score: null, passed: false, rewardEligible: false, failureClass: "infrastructure_failure" });
  });

  test("runs generated verifier code without process, imports, network, or path escape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "verifier-sandbox-"));
    try {
      await mkdir(path.join(root, "graders"));
      const module = path.join(root, "graders", "verify.js");
      await writeFile(module, "export function verify({ attempt }) { return { score: attempt.output.text ? 1 : 0, passed: Boolean(attempt.output.text), feedback: 'verified' }; }\n");
      const grader = { id: "custom", version: "1", label: "Custom", kind: "custom_verifier" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: true, module: "graders/verify.js", exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" as const, metadata: {} };
      await expect(runSandboxedVerifier({ grader, task: tasksetFixture().tasks[1]!, attempt: attemptFixture(), allowedRoot: root })).resolves.toMatchObject({ score: 1, passed: true });
      await writeFile(module, "export function verify() { return process.env; }\n");
      await expect(runSandboxedVerifier({ grader, task: tasksetFixture().tasks[1]!, attempt: attemptFixture(), allowedRoot: root })).rejects.toThrow("forbidden capability");
      await expect(runSandboxedVerifier({ ...{ grader }, grader: { ...grader, module: "../outside.js" }, task: tasksetFixture().tasks[1]!, attempt: attemptFixture(), allowedRoot: root })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("calibrates model judges on declared fixtures before enabling reward", async () => withTrainingStore(async ({ store, directory }) => {
    const judge = { id: "judge", version: "1", label: "Judge", kind: "model_judge" as const, weight: 1, hardGate: true, rewardEligible: false, privileged: true, rubric: "Match the expected outcome", judge: { providerId: "openpond", modelId: "judge-v1" }, calibrationFixtureRefs: ["fixture_positive", "fixture_negative", "fixture_boundary", "fixture_adversarial", "fixture_prompt", "fixture_infra"], calibrationStatus: "pending" as const, temperature: 0, metadata: { requestedRewardEligible: true } };
    const taskset = tasksetFixture({ graders: [judge] });
    const profileSource = path.join(directory, "profile");
    await buildTaskset(taskset, path.join(profileSource, "tasksets", taskset.id));
    await store.upsertTaskset(taskset);
    const service = createTaskEvaluationService({ store, loadProfileState: async () => ({ mode: "local", sourcePath: profileSource } as any), modelJudge: async ({ attempt }) => { const passed = attempt.output.text === "Goodbye friend"; return { score: passed ? 1 : 0, passed, feedback: passed ? "matched" : "did not match" }; } });
    const calibrated = await service.calibrateModelJudges(taskset.id);
    expect(calibrated.passed).toBe(true);
    expect(calibrated.taskset.graders[0]).toMatchObject({ kind: "model_judge", calibrationStatus: "passed", rewardEligible: true, metadata: { calibrationEvidenceHash: expect.any(String), calibrationAccuracy: 1 } });
    expect(calibrated.taskset.contentHash).not.toBe(taskset.contentHash);
  }));
});
