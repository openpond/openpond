import { describe, expect, test } from "bun:test";
import { runBaseline } from "../packages/taskset-sdk/src";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import { attemptFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("baseline evaluator", () => {
  test("automatically audits deterministic graders and makes SFT ready without a baseline", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture();
    await store.upsertTaskset(taskset);
    const service = createTaskEvaluationService({ store, loadProfileState: async () => ({ mode: "empty", sourcePath: null } as any) });

    const readiness = await service.readiness(taskset.id);

    expect(readiness).toMatchObject({ ready: true, recommendedMethod: "sft", baselineReportId: null, blockers: [] });
    expect((await store.listGraderAuditReports(taskset.id))[0]).toMatchObject({ passed: true });
    expect(await store.getTaskset(taskset.id)).toMatchObject({ status: "ready", readiness: { ready: true } });
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
