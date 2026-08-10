import { TasksetSchema } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service.js";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures.js";

describe("Taskset benchmark execution", () => {
  test("persists paired baseline and candidate summaries through the normal evaluator", async () => {
    await withTrainingStore(async ({ store, directory }) => {
      const base = tasksetFixture({ ready: true });
      const draft = TasksetSchema.parse({
        ...base,
        purpose: "benchmark",
        benchmark: {
          schemaVersion: "openpond.tasksetBenchmark.v1",
          definitionId: "fixture-benchmark",
          releaseId: "fixture-release",
          releaseHash: contentHash("fixture-release"),
          managedReleasePath: "benchmark/taskset.release.json",
          adaptationSplit: "validation",
          evaluationSplit: "frozen_eval",
          primaryMetric: "foreground_tokens",
          qualityGate: "non_regression",
          source: "imported",
          metadata: {},
        },
        contentHash: "00000000",
      });
      const taskset = TasksetSchema.parse({
        ...draft,
        contentHash: computeTasksetHash(draft),
      });
      await store.upsertTaskset(taskset);

      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        loadProfileState: async () => ({
          mode: "local",
          sourcePath: null,
          git: null,
          skills: [],
          agents: [],
        }) as never,
        modelText: async () => "Goodbye friend",
        modelStream: async function* () {
          throw new Error("The chat benchmark must not use the Work stream.");
        },
        workRuntime: {
          createSession: async () => { throw new Error("Unexpected Work session."); },
          getSession: async () => { throw new Error("Unexpected Work session read."); },
          executeWorkspaceTool: async () => { throw new Error("Unexpected Work tool."); },
          runtimeEventsForSession: async () => [],
        },
      });
      const model = {
        providerId: "custom-openai-compatible",
        modelId: "fixture",
      } as const;

      const baseline = await evaluation.executeBenchmark({
        tasksetId: taskset.id,
        phase: "baseline",
        model,
        reasoningEffort: "high",
      });
      const candidate = await evaluation.executeBenchmark({
        tasksetId: taskset.id,
        phase: "candidate",
        model,
        reasoningEffort: "high",
      });

      expect(baseline).toMatchObject({
        comparison: null,
        run: { phase: "baseline", attemptCount: 1, passedCount: 1 },
      });
      expect(candidate).toMatchObject({
        run: { phase: "candidate", attemptCount: 1, passedCount: 1 },
        comparison: {
          qualityPassed: true,
          improved: false,
          foregroundTokenDelta: 0,
        },
      });
      expect(await store.listBenchmarkRuns(taskset.id)).toHaveLength(2);
      expect(await store.listBenchmarkComparisons(taskset.id)).toHaveLength(1);
    });
  });
});
