import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  RftRecipeSchema,
  SftRecipeSchema,
  TasksetSchema,
  type RftRecipe,
  type SftRecipe,
} from "../packages/contracts/src";
import { computeTasksetHash, contentHash } from "../packages/taskset-sdk/src";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import { createTrainingService } from "../apps/server/src/training/training-service";
import {
  createEvidenceSnapshot,
  createTasksetRef,
} from "../apps/server/src/training/create-improve-taskset-lineage";
import { createModelTrainingCreateImproveRun } from "../apps/server/src/training/model-create-improve";
import { syncModelTrainingCreateImproveRuns } from "../apps/server/src/training/model-create-improve-reconciliation";
import { listLocalAdapterProviderModels } from "../apps/server/src/training/local-adapter-models";
import { resolveModelLineageIdForRuntime } from "../apps/server/src/training/local-adapter-chat-runtime";
import { resolveFireworksRftEvaluatorId } from "../apps/server/src/training/fireworks-rft-evaluator";
import {
  providerOptimizerUpdates,
  selectFireworksEvaluationAccelerator,
  selectFireworksTrainedServingMode,
  withFireworksEvaluationExecutionLock,
} from "../apps/server/src/training/fireworks-destination";
import {
  generateCrossSystemTasks,
  generateCrossSystemWorld,
} from "../apps/server/src/training/cross-system-operations/world-generator";
import {
  tasksetFixture,
  withTrainingStore,
} from "./helpers/training-fixtures";

describe.sequential("Fireworks destination selection", () => {
  test("switches a failed trained hot-reload deployment to multi-LoRA", () => {
    expect(selectFireworksTrainedServingMode([], null))
      .toBe("hot_reload_lora");
    expect(selectFireworksTrainedServingMode([{
      stage: "trained",
      servingMode: "hot_reload_lora",
      error: "Fireworks deployment validation failed: Internal error occurred",
      evaluationAttemptNumber: 8,
    }], null)).toBe("multi_lora");
    expect(selectFireworksTrainedServingMode([{
      stage: "trained",
      servingMode: "hot_reload_lora",
      error: "Fireworks deployment validation failed: Internal error occurred",
      evaluationAttemptNumber: 8,
    }, {
      stage: "trained",
      servingMode: "multi_lora",
      error: "Fireworks deployment validation failed: Internal error occurred",
      evaluationAttemptNumber: 9,
    }], null)).toBe("direct");
    expect(selectFireworksTrainedServingMode([{
      stage: "trained",
      servingMode: "direct",
      error: "Fireworks deployment validation failed: Internal error occurred",
      evaluationAttemptNumber: 10,
    }], null)).toBe("multi_lora");
    expect(selectFireworksTrainedServingMode([{
      stage: "trained",
      servingMode: "direct",
      acceleratorType: "NVIDIA_A100_80GB",
      error: "Fireworks deployment validation failed: Internal error occurred",
      evaluationAttemptNumber: 10,
    }, {
      stage: "trained",
      servingMode: "multi_lora",
      acceleratorType: "NVIDIA_H100_80GB",
      error: "Fireworks deployment validation failed: Internal error occurred",
      evaluationAttemptNumber: 12,
    }], null)).toBe("hot_reload_lora");
    expect(selectFireworksTrainedServingMode([{
      stage: "trained",
      servingMode: "multi_lora",
      error: "Fireworks deployment validation failed: Internal error occurred",
      evaluationAttemptNumber: 12,
    }, {
      stage: "trained",
      servingMode: "hot_reload_lora",
      acceleratorType: "NVIDIA_H100_80GB",
      readyAt: "2026-07-17T23:43:00.000Z",
      error: null,
      evaluationAttemptNumber: 13,
    }], null)).toBe("hot_reload_lora");
    expect(selectFireworksTrainedServingMode([{
      stage: "base",
      servingMode: "direct",
      error: "Internal error occurred",
    }], null)).toBe("hot_reload_lora");
    expect(selectFireworksTrainedServingMode([], "multi_lora"))
      .toBe("multi_lora");
  });

  test("falls back to one A100 after repeated H100 capacity failures", () => {
    const failure = {
      stage: "trained",
      acceleratorType: "NVIDIA_H100_80GB",
      error: "Fireworks deployment reported RESOURCE_EXHAUSTED: no available capacity",
    };
    expect(selectFireworksEvaluationAccelerator([failure], "trained"))
      .toBe("NVIDIA_H100_80GB");
    expect(selectFireworksEvaluationAccelerator(
      [failure, { ...failure }],
      "trained",
    )).toBe("NVIDIA_A100_80GB");
    expect(selectFireworksEvaluationAccelerator(
      [
        failure,
        { ...failure },
        {
          stage: "trained",
          acceleratorType: "NVIDIA_A100_80GB",
          error: "Fireworks deployment validation failed: Internal error occurred",
          evaluationAttemptNumber: 11,
        },
      ],
      "trained",
    )).toBe("NVIDIA_H100_80GB");
    expect(selectFireworksEvaluationAccelerator(
      [
        failure,
        { ...failure },
        {
          stage: "trained",
          acceleratorType: "NVIDIA_H100_80GB",
          readyAt: "2026-07-17T23:43:00.000Z",
          error: null,
          evaluationAttemptNumber: 13,
        },
      ],
      "trained",
    )).toBe("NVIDIA_H100_80GB");
    expect(selectFireworksEvaluationAccelerator(
      [
        failure,
        { ...failure },
        {
          stage: "trained",
          acceleratorType: "NVIDIA_A100_80GB",
          error: "Fireworks deployment validation failed: Internal error occurred",
          evaluationAttemptNumber: 11,
        },
        {
          stage: "trained",
          acceleratorType: "NVIDIA_H100_80GB",
          error: "Fireworks deployment validation failed: Internal error occurred",
          evaluationAttemptNumber: 12,
        },
      ],
      "trained",
    )).toBe("NVIDIA_H100_80GB");
    expect(selectFireworksEvaluationAccelerator(
      [failure, { ...failure, stage: "base" }],
      "trained",
    )).toBe("NVIDIA_H100_80GB");
  });

  test("joins a cross-process frozen-evaluation lock instead of duplicating execution", async () =>
    withTrainingStore(async ({ directory }) => {
      let executions = 0;
      let completed: string | null = null;
      let release!: () => void;
      let markStarted!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const input = {
        directory,
        jobId: "job_evaluation_lock",
        maxRuntimeMs: 2_000,
        execute: async () => {
          executions += 1;
          markStarted();
          await gate;
          completed = "shared-evaluation-artifact";
          return completed;
        },
        readCompleted: async () => completed,
      };
      const first = withFireworksEvaluationExecutionLock(input);
      await started;
      const second = withFireworksEvaluationExecutionLock(input);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(executions).toBe(1);
      release();
      await expect(Promise.all([first, second])).resolves.toEqual([
        "shared-evaluation-artifact",
        "shared-evaluation-artifact",
      ]);
      expect(executions).toBe(1);
    }));

  test("recognizes current Fireworks epoch checkpoints as optimizer-update proof", () => {
    expect(providerOptimizerUpdates({
      name: "accounts/test-account/reinforcementFineTuningJobs/rft-current",
      state: "JOB_STATE_COMPLETED",
      trainingConfig: {
        baseModel: "accounts/fireworks/models/qwen3-8b",
      },
      outputMetrics: JSON.stringify({
        epoch_to_evaluation_output: {
          "0": {
            checkpoint_gcs_path: "gs://private-bucket/output/checkpoint",
            output_model: "accounts/test-account/models/rft-current-output",
            target_modules: ["q_proj", "v_proj"],
          },
        },
      }),
    })).toBe(1);
    expect(providerOptimizerUpdates({
      name: "accounts/test-account/reinforcementFineTuningJobs/rft-no-update",
      state: "JOB_STATE_EARLY_STOPPED",
      trainingConfig: {
        baseModel: "accounts/fireworks/models/qwen3-8b",
      },
      outputMetrics: JSON.stringify({
        epoch_to_evaluation_output: {
          "0": {
            output_model: "accounts/fireworks/models/qwen3-8b",
          },
        },
      }),
    })).toBe(0);
  });

  test("uses the evaluator ID that Eval Protocol actually uploads", () => {
    expect(resolveFireworksRftEvaluatorId(
      "✅ Successfully uploaded evaluator: test-openpond-remote-openpond-cross-system-reward\n",
      "op-cso-remote-requested",
    )).toBe("test-openpond-remote-openpond-cross-system-reward");
    expect(resolveFireworksRftEvaluatorId(
      "upload completed without a resource line",
      "op-cso-remote-requested",
    )).toBe("op-cso-remote-requested");
  });

});
