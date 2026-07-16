import { describe, expect, test } from "vitest";
import { computeTasksetHash, runBaseline } from "../packages/taskset-sdk/src";
import { TasksetSchema } from "../packages/contracts/src";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import { buildTasksetReadiness } from "../apps/server/src/training/readiness";
import { attemptFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("baseline evaluator", () => {
  test("automatically audits deterministic graders and makes SFT ready without a baseline", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture();
    await store.upsertTaskset(taskset);
    const service = createTaskEvaluationService({ store, loadProfileState: async () => ({ mode: "empty", sourcePath: null } as any) });

    const readiness = await service.readiness(taskset.id);

    expect(readiness).toMatchObject({ ready: true, recommendedMethod: "sft", trainingPath: { primaryMethod: "sft", bootstrap: null }, baselineReportId: null, blockers: [] });
    expect((await store.listGraderAuditReports(taskset.id))[0]).toMatchObject({ passed: true });
    expect(await store.getTaskset(taskset.id)).toMatchObject({ status: "ready", readiness: { ready: true } });
  }));

  test("preserves GRPO as primary while representing local SFT only as a trajectory bootstrap", async () => withTrainingStore(async ({ store }) => {
    const base = tasksetFixture();
    const draft = TasksetSchema.parse({
      ...base,
      contentHash: "00000000",
      capabilities: { ...base.capabilities, supportedSignals: ["demonstration", "reward"], compatibleMethods: ["grpo", "sft"], requiresTools: true, requiresState: true },
      metadata: { ...base.metadata, trainingMethod: "grpo" },
    });
    const taskset = TasksetSchema.parse({ ...draft, contentHash: computeTasksetHash(draft) });
    await store.upsertTaskset(taskset);
    const service = createTaskEvaluationService({ store, loadProfileState: async () => ({ mode: "empty", sourcePath: null } as any) });

    const readiness = await service.readiness(taskset.id);

    expect(readiness).toMatchObject({
      ready: true,
      recommendedMethod: "grpo",
      trainingPath: { primaryMethod: "grpo", bootstrap: { method: "sft", purpose: "trajectory_bootstrap", demonstrationRefs: ["demo_train"] } },
    });
    expect(readiness.compatibleDestinationClasses).not.toContain("local_cpu_fixture");
    expect(readiness.trainingPath?.bootstrap?.limitations.join(" ")).toContain("does not satisfy the primary GRPO recommendation");
  }));

  test("runs repeated models/seeds and reports pass@k, reward, failures, cost, and interventions", async () => {
    const taskset = tasksetFixture();
    let index = 0;
    const result = await runBaseline({ taskset, models: [{ providerId: "custom-openai-compatible", modelId: "fixture" }], seeds: [1, 2], attemptsPerTask: 2, runAttempt: async ({ task, seed, attempt }) => attemptFixture({ id: `attempt_${index++}`, taskId: task.id, seed, attempt, output: attempt % 2 ? { text: "wrong" } : task.expectedOutput ?? {}, costUsd: 0.01, userInterventions: attempt }) });
    expect(result.attempts).toHaveLength(4);
    expect(result.report.passAtK).toMatchObject({ "1": 1, "2": 1 });
    expect(result.report.reward).toMatchObject({ count: 4, mean: 0.5, variance: 0.25 });
    expect(result.report.totalCostUsd).toBeCloseTo(0.04);
    expect(result.report.userInterventions).toBe(2);
  });

  test("blocks training readiness when the grader audit fails", () => {
    const taskset = tasksetFixture();
    const readiness = buildTasksetReadiness({
      taskset,
      baseline: null,
      graderAudit: {
        schemaVersion: "openpond.graderAuditReport.v1",
        id: "grader_audit_failed_fixture",
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        fixtureRefs: ["fixture_negative"],
        gradeRefs: ["grade_false_positive"],
        passed: false,
        hackingChecksPassed: false,
        leakageChecksPassed: true,
        infrastructureSafetyPassed: true,
        failures: [{ fixtureId: "fixture_negative", label: "negative", gradeId: "grade_false_positive", reason: "The negative fixture incorrectly passed." }],
        createdAt: "2026-07-13T00:00:00.000Z",
      },
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["grader_audit_failed", "grader_hacking"]));
  });

  test("persists fixture audits, attempts, component grades, baseline, and readiness", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture();
    await store.upsertTaskset(taskset);
    let ordinal = 0;
    const service = createTaskEvaluationService({ store, loadProfileState: async () => ({ mode: "empty", sourcePath: null } as any), runAttempt: async ({ task, seed, attempt }) => attemptFixture({ id: `service_attempt_${ordinal++}`, tasksetId: taskset.id, taskId: task.id, split: task.split, seed, attempt, output: task.expectedOutput ?? {} }) });
    const result = await service.baseline({ tasksetId: taskset.id, models: [{ providerId: "custom-openai-compatible", modelId: "fixture" }], seeds: [1], attemptsPerTask: 1 });
    expect(result.readiness).toMatchObject({ ready: true, recommendedMethod: "sft", blockers: [] });
    expect((await store.listGraderAuditReports(taskset.id))[0]).toMatchObject({ passed: true, hackingChecksPassed: true, infrastructureSafetyPassed: true });
    expect(await store.listTaskAttempts(taskset.id)).toHaveLength(7);
    expect(await store.listGradeResultsForTaskset(taskset.id)).toHaveLength(7);
    expect((await store.getTaskset(taskset.id))?.status).toBe("ready");
  }));
});
