import { describe, expect, test, vi } from "vitest";
import {
  TasksetBaselineRunSchema,
  type TasksetBaselineRun,
} from "../packages/contracts/src";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import {
  attemptFixture,
  tasksetFixture,
  withTrainingStore,
} from "./helpers/training-fixtures";

describe("persisted Taskset baseline runs", () => {
  test("creates a visible run before provider preparation completes and preserves a capacity failure", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = tasksetFixture();
      await store.upsertTaskset(taskset);
      let releasePreparation!: () => void;
      const preparationGate = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      let preparationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        preparationStarted = resolve;
      });
      const service = createTaskEvaluationService({
        store,
        runAttempt: async () => {
          throw new Error("Inference must not start without provider capacity.");
        },
        prepareBaselineModels: async (_models, options) => {
          await options?.onDeploymentUpdate?.({
            accountId: "test-account",
            deploymentId: "op-baseline-capacity",
            phase: "creating",
            state: "CREATING",
            statusCode: "RESOURCE_EXHAUSTED",
            statusMessage: "no available capacity",
          });
          preparationStarted();
          await preparationGate;
          await options?.onDeploymentUpdate?.({
            accountId: "test-account",
            deploymentId: "op-baseline-capacity",
            phase: "deleted",
            state: "DELETED",
            statusCode: null,
            statusMessage: null,
          });
          throw new Error("Fireworks base-model deployment has no available capacity: no available capacity");
        },
      });

      const accepted = await service.startBaseline({
        tasksetId: taskset.id,
        targetModelId: "model_fixture_capacity",
        models: [{ providerId: "fireworks", modelId: "accounts/fireworks/models/qwen3-0p6b" }],
        seeds: [17],
        attemptsPerTask: 1,
        taskLimit: 1,
        split: "frozen_eval",
        sampling: { maxOutputTokens: 2_048, temperature: 0.8, topP: 0.95 },
      });
      expect(accepted).toMatchObject({
        targetModelId: "model_fixture_capacity",
        status: "queued",
        reportId: null,
      });
      await started;

      expect(await store.getTasksetBaselineRun(accepted.id)).toMatchObject({
        targetModelId: "model_fixture_capacity",
        status: "preparing",
        progress: { stage: "provisioning", completedAttempts: 0 },
        provider: {
          deploymentId: "op-baseline-capacity",
          statusCode: "RESOURCE_EXHAUSTED",
        },
      });

      releasePreparation();
      const failed = await waitForTerminalRun(store, accepted.id);
      expect(failed).toMatchObject({
        status: "failed",
        reportId: null,
        provider: {
          phase: "deleted",
          statusCode: "RESOURCE_EXHAUSTED",
          statusMessage: "no available capacity",
          releasedAt: expect.any(String),
        },
      });
      expect(failed.error).toContain("no available capacity");
      expect(await store.listBaselineReports(taskset.id)).toEqual([]);
      await service.close();
    }));

  test("updates progress and links the completed report", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = tasksetFixture();
      await store.upsertTaskset(taskset);
      let attemptIndex = 0;
      const service = createTaskEvaluationService({
        store,
        runAttempt: async ({ task, seed, attempt }) => attemptFixture({
          id: `persisted_baseline_attempt_${attemptIndex++}`,
          tasksetId: taskset.id,
          taskId: task.id,
          split: task.split,
          seed,
          attempt,
          output: task.expectedOutput ?? {},
        }),
      });

      const accepted = await service.startBaseline({
        tasksetId: taskset.id,
        models: [{ providerId: "custom-openai-compatible", modelId: "fixture" }],
        seeds: [17],
        attemptsPerTask: 1,
        taskLimit: 1,
        split: "frozen_eval",
      });
      const completed = await waitForTerminalRun(store, accepted.id);

      expect(completed).toMatchObject({
        status: "succeeded",
        progress: {
          stage: "complete",
          completedAttempts: 1,
          totalAttempts: 1,
          correctAttempts: 1,
        },
        reportId: expect.any(String),
      });
      expect((await store.listBaselineReports(taskset.id))[0]?.id)
        .toBe(completed.reportId);
      await service.close();
    }));

  test("admits only one concurrent run for the same Taskset revision", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = tasksetFixture();
      await store.upsertTaskset(taskset);
      let releaseAttempt!: () => void;
      const attemptGate = new Promise<void>((resolve) => {
        releaseAttempt = resolve;
      });
      const service = createTaskEvaluationService({
        store,
        runAttempt: async ({ task, seed, attempt }) => {
          await attemptGate;
          return attemptFixture({
            id: `concurrent_${attempt}`,
            tasksetId: taskset.id,
            taskId: task.id,
            split: task.split,
            seed,
            attempt,
            output: task.expectedOutput ?? {},
          });
        },
      });
      const input = {
        tasksetId: taskset.id,
        models: [{
          providerId: "custom-openai-compatible" as const,
          modelId: "fixture",
        }],
        seeds: [17],
        attemptsPerTask: 1,
        taskLimit: 1,
        split: "frozen_eval" as const,
      };

      const results = await Promise.allSettled([
        service.startBaseline(input),
        service.startBaseline(input),
      ]);

      expect(results.filter((result) => result.status === "fulfilled"))
        .toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected"))
        .toHaveLength(1);
      releaseAttempt();
      await service.close();
    }));

  test("marks interrupted runs failed and invokes provider cleanup on restart", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = tasksetFixture();
      await store.upsertTaskset(taskset);
      const interrupted = baselineRunFixture({
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
      });
      await store.saveTasksetBaselineRun(interrupted);
      const cleanup = vi.fn(async () => ["op-baseline-interrupted"]);
      const service = createTaskEvaluationService({
        store,
        cleanupBaselineDeployments: cleanup,
      });

      const reconciled = await service.cancelBaselineRun(interrupted.id);

      expect(cleanup).toHaveBeenCalledOnce();
      expect(reconciled).toMatchObject({
        status: "failed",
        completedAt: expect.any(String),
      });
      expect(reconciled.error).toContain("server restarted");
      await service.close();
    }));
});

async function waitForTerminalRun(
  store: {
    getTasksetBaselineRun: (id: string) => Promise<TasksetBaselineRun | null>;
  },
  id: string,
): Promise<TasksetBaselineRun> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await store.getTasksetBaselineRun(id);
    if (run && ["cancelled", "succeeded", "failed"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Baseline run ${id} did not reach a terminal state.`);
}

function baselineRunFixture(input: {
  tasksetId: string;
  tasksetHash: string;
}): TasksetBaselineRun {
  const timestamp = "2026-07-21T12:00:00.000Z";
  return TasksetBaselineRunSchema.parse({
    schemaVersion: "openpond.tasksetBaselineRun.v1",
    id: "baseline_run_interrupted",
    profileId: "default",
    tasksetId: input.tasksetId,
    tasksetHash: input.tasksetHash,
    status: "running",
    configuration: {
      split: "train",
      taskLimit: 16,
      attemptsPerTask: 8,
      selectionSeed: 17,
      selectionStrategy: "stable_hash_top_n",
      model: { providerId: "fireworks", modelId: "accounts/fireworks/models/qwen3-0p6b" },
      sampling: { maxOutputTokens: 2_048, temperature: 0.8, topP: 0.95 },
    },
    scope: null,
    progress: {
      stage: "provisioning",
      completedAttempts: 0,
      totalAttempts: 128,
      correctAttempts: 0,
      incorrectAttempts: 0,
      parseableAttempts: 0,
      infrastructureFailures: 0,
    },
    provider: null,
    reportId: null,
    estimatedCostUsd: null,
    cancelRequested: false,
    error: null,
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: null,
    updatedAt: timestamp,
  });
}
