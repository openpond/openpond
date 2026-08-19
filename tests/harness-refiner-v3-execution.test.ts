import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { TasksetSchema } from "@openpond/contracts";
import { harnessRefinerBenchmarkV3Release } from "@openpond/evals";
import { computeTasksetHash } from "@openpond/taskset-sdk";

import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import {
  createInMemoryTasksetWorkRuntime,
} from "./helpers/taskset-work-fixtures";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("Harness Refiner v3 executable path", () => {
  test("runs one Work attempt through the v3 deterministic and semantic graders", () =>
    withTrainingStore(async ({ store, directory }) => {
      const releaseTask = harnessRefinerBenchmarkV3Release.tasks.find(
        (task) => task.id === "adaptation-invoice-correction-email",
      );
      if (!releaseTask) throw new Error("v3 direct-deliverable fixture is missing.");
      const base = tasksetFixture();
      const task = {
        schemaVersion: "openpond.taskData.v1" as const,
        id: releaseTask.id,
        clusterKey: releaseTask.clusterKey,
        split: releaseTask.split,
        input: releaseTask.input,
        expectedOutput: releaseTask.expectedOutput,
        policyVisibleContext: releaseTask.policyVisibleContext,
        privilegedContextRef: releaseTask.privilegedContextRef,
        sourceRefs: [base.sourceRefs[0]!.id],
        tags: releaseTask.tags,
        evaluationCriteria: releaseTask.evaluationCriteria,
        metadata: {},
      };
      const draft = TasksetSchema.parse({
        ...base,
        id: "harness-refiner-v3-execution",
        name: "Harness Refiner v3 execution fixture",
        objective: "Exercise the released v3 grading path.",
        purpose: "benchmark",
        benchmark: {
          schemaVersion: "openpond.tasksetBenchmark.v1",
          definitionId: "harness-refiner-v3-fixture",
          releaseId: harnessRefinerBenchmarkV3Release.id,
          releaseHash: harnessRefinerBenchmarkV3Release.contentHash,
          managedReleasePath: "benchmark/taskset.release.json",
          adaptationSplit: "validation",
          evaluationSplit: "frozen_eval",
          primaryMetric: "success_rate",
          qualityGate: "non_regression",
          source: "builtin",
          metadata: {},
        },
        policy: {
          ...base.policy,
          policyVisibleFields: ["input", "policyVisibleContext", "evaluationCriteria"],
          privilegedFields: ["expectedOutput"],
          hiddenGraderRefs: ["task-semantic-judge"],
        },
        environment: {
          ...base.environment,
          kind: "work",
          entrypoint: "openpond-work-v1",
          stateful: true,
          deterministicSeeds: true,
          toolNames: ["work_environment", "work_save_output", "work_stop"],
          lifecycle: ["create", "reset", "step", "grade", "cleanup"],
          networkPolicy: "none",
        },
        capabilities: {
          ...base.capabilities,
          taskKind: "single_agent",
          requiresTools: true,
          requiresState: true,
          requiresPrivilegedGrading: true,
        },
        tasks: [task],
        graders: [
          {
            id: "task-visible-contract",
            version: "3",
            label: "Visible output constraints",
            kind: "custom_verifier",
            weight: 0.25,
            hardGate: true,
            rewardEligible: true,
            privileged: false,
            module: "verifiers/taskset-v3-contract-verifier.mjs",
            exportName: "verify",
            timeoutMs: 30_000,
            networkPolicy: "none",
            metadata: {},
          },
          {
            id: "task-semantic-judge",
            version: "3",
            label: "Semantic task quality",
            kind: "model_judge",
            weight: 0.75,
            hardGate: false,
            rewardEligible: true,
            privileged: true,
            rubric: "Return the released criterion scores.",
            judge: { providerId: "openai", modelId: "fixture-judge" },
            calibrationFixtureRefs: ["fixture"],
            calibrationStatus: "passed",
            temperature: 0,
            metadata: {},
          },
        ],
        graderFixtures: [{
          ...base.graderFixtures[0]!,
          id: "v3-execution-fixture",
          taskId: task.id,
        }],
        contentHash: "00000000",
      });
      const taskset = TasksetSchema.parse({
        ...draft,
        contentHash: computeTasksetHash(draft),
      });
      await store.upsertTaskset(taskset);
      const verifierDirectory = path.join(
        directory,
        "training",
        "tasksets",
        taskset.id,
        "verifiers",
      );
      await mkdir(verifierDirectory, { recursive: true });
      await copyFile(
        path.join(
          process.cwd(),
          "benchmarks/harness-refiner/taskset/verifiers/taskset-v3-contract-verifier.mjs",
        ),
        path.join(verifierDirectory, "taskset-v3-contract-verifier.mjs"),
      );
      const runtime = createInMemoryTasksetWorkRuntime({ storeDir: directory });
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelJudge: async () => ({
          score: 1,
          passed: true,
          feedback: "The message covers the released request without unsupported claims.",
          criterionScores: [
            {
              criterionId: `${task.id}-task-coverage`,
              score: 1,
              passed: true,
              feedback: "All requested message details are present.",
              evidenceRefs: [],
            },
            {
              criterionId: `${task.id}-factual-grounding`,
              score: 1,
              passed: true,
              feedback: "The supplied invoice facts are preserved.",
              evidenceRefs: [],
            },
          ],
        }),
        modelText: async () => JSON.stringify({
          score: 1,
          passed: true,
          feedback: "The message covers the released request without unsupported claims.",
          criterionScores: [
            {
              criterionId: `${task.id}-task-coverage`,
              score: 1,
              passed: true,
              feedback: "All requested message details are present.",
              evidenceRefs: [],
            },
            {
              criterionId: `${task.id}-factual-grounding`,
              score: 1,
              passed: true,
              feedback: "The supplied invoice facts are preserved.",
              evidenceRefs: [],
            },
          ],
        }),
        modelStream: async function* () {
          yield {
            text: "Subject: Correction to INV-1842\n\nHello Northwind Labs,\n\nINV-1842 incorrectly lists 120 seats instead of 102. A corrected invoice will arrive by August 14, and no payment is due until it arrives. Please send billing questions to accounts@example.com. We apologize for the error and appreciate your patience.",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            costUsd: 0,
          };
        },
        workRuntime: runtime.runtime,
      });
      const result = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: { providerId: "openpond", modelId: "fixture-foreground" },
        seed: 17,
        attempt: 0,
        resultId: "attempt-harness-refiner-v3-execution",
      });

      expect(result.attempt).toMatchObject({
        infrastructureError: null,
        metadata: { execution: "taskset_work", status: "completed" },
      });
      expect(result.grade).toMatchObject({
        score: 1,
        passed: true,
        rewardEligible: true,
        failureClass: null,
        diagnosis: { terminalClass: "completed", causes: [] },
      });
      expect(result.grade.components).toEqual(expect.arrayContaining([
        expect.objectContaining({
          graderId: "task-visible-contract",
          criterionScores: [expect.objectContaining({
            criterionId: `${task.id}-visible-constraints`,
            score: 1,
          })],
        }),
        expect.objectContaining({
          graderId: "task-semantic-judge",
          criterionScores: expect.arrayContaining([
            expect.objectContaining({ criterionId: `${task.id}-task-coverage` }),
            expect.objectContaining({ criterionId: `${task.id}-factual-grounding` }),
          ]),
        }),
      ]));
      expect(runtime.actions).toEqual([]);
    }));
});
