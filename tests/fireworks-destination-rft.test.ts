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
  type TrainingArtifact,
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
  fireworksRftChunkSize,
  fireworksRftOptimizerSteps,
  fireworksRftRolloutCount,
} from "../apps/server/src/training/fireworks-client";
import { selectLineageAdapterArtifact } from "../apps/server/src/training/fireworks-provider-utils";
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
import { API_KEY, fireworksMock, fireworksRecipe, fireworksRftMock, fireworksRftRecipe, jsonResponse, resolveApprovalActor, rftTasksetFixture } from "./helpers/fireworks-destination-fixtures";

describe.sequential("Fireworks RFT destination", () => {
  test("maps the requested update ceiling to Fireworks chunk semantics", () => {
    const chunkSize = fireworksRftChunkSize(256, 10);
    expect(chunkSize).toBe(26);
    expect(fireworksRftOptimizerSteps(256, chunkSize)).toBe(10);
    expect(fireworksRftRolloutCount(256, 8)).toBe(2_048);
  });

  test("anchors lineage to weights when provider filenames include checkpoint paths", () => {
    const artifact = (
      id: string,
      providerFilename: string,
    ): TrainingArtifact =>
      ({
        id,
        kind: "adapter",
        metadata: { providerFilename },
      }) as TrainingArtifact;
    expect(
      selectLineageAdapterArtifact([
        artifact(
          "config",
          "tuned-model/run/checkpoint/adapter_config.json",
        ),
        artifact(
          "weights",
          "tuned-model/run/checkpoint/adapter_model.safetensors",
        ),
      ]).id,
    ).toBe("weights");
  });

  test("executes the DAPO RFT provider lifecycle, proves optimizer updates, imports weights, and evaluates privately", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = rftTasksetFixture();
      const recipe = {
        ...fireworksRftRecipe(),
        loss: { method: "dapo" as const, klBeta: null },
      };
      await store.upsertTaskset(taskset);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
      });
      const provider = fireworksRftMock({
        trainedOutput: String(taskset.tasks.find((task) => task.split === "frozen_eval")?.expectedOutput?.text),
      });
      const evaluatorCalls: Array<Record<string, unknown>> = [];
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        gradeTaskAttempt: evaluation.grade,
        fireworksRequest: provider.request,
        fireworksRftPublicBaseUrl: () =>
          "https://rft.openpond.test/v1/training/fireworks/rft",
        provisionFireworksRftEvaluator: async (input) => {
          evaluatorCalls.push(input);
          return {
            evaluatorId: "op-cso-remote-fixture",
            evaluatorName: "accounts/test-account/evaluators/op-cso-remote-fixture",
            sourceHash: "evaluatorhash0000000000000000000000000000000000000000000000000000",
            publicBaseUrl: input.publicBaseUrl,
          };
        },
      });

      try {
        const started = await service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe,
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
        });

        expect(started.plan).toMatchObject({
          destinationId: "fireworks",
          environmentPlacement: "provider_native",
          estimatedCostUsd: 3,
          recipe: {
            method: "grpo",
            lora: { rank: 8 },
            reward: { graderHash: contentHash(taskset.graders) },
          },
        });
        expect(started.job).toMatchObject({
          status: "starting",
          metadata: {
            trainingMethod: "grpo",
            rftLossMethod: "dapo",
            providerEvaluatorId: "op-cso-remote-fixture",
            providerDatasetTaskIds: [
              taskset.tasks.find((task) => task.split === "train")!.id,
            ],
            optimizerUpdatesObserved: 0,
          },
        });
        expect(evaluatorCalls).toHaveLength(1);
        expect(evaluatorCalls[0]).toMatchObject({
          accountId: "test-account",
          apiKey: API_KEY,
          baseModelId: "accounts/fireworks/models/qwen3-0p6b",
          publicBaseUrl: "https://rft.openpond.test/v1/training/fireworks/rft",
        });
        const trainTask = taskset.tasks.find((task) => task.split === "train")!;
        const frozenTask = taskset.tasks.find((task) => task.split === "frozen_eval")!;
        const uploadedRow = JSON.parse(provider.uploadedDataset.trim()) as {
          messages: Array<{ role: string; content: string }>;
        };
        expect(uploadedRow.messages).toContainEqual({
          role: "user",
          content: String(trainTask.input.prompt),
        });
        expect(provider.uploadedDataset).not.toContain(String(trainTask.expectedOutput?.text));
        expect(provider.uploadedDataset).not.toContain(frozenTask.id);
        expect(provider.uploadedDataset).not.toContain(String(frozenTask.expectedOutput?.text));
        expect(provider.rftCreateBody).toMatchObject({
          evaluator: "accounts/test-account/evaluators/op-cso-remote-fixture",
          trainingConfig: {
            outputModel: expect.stringMatching(/^accounts\/test-account\/models\/op-rft-model-/),
            baseModel: "accounts/fireworks/models/qwen3-0p6b",
            loraRank: 8,
            batchSizeSamples: 4,
            maxContextLength: 1_536,
          },
          inferenceParameters: {
            responseCandidatesCount: 4,
            maxOutputTokens: 512,
            extraBody: JSON.stringify({ reasoning_effort: "none" }),
          },
          lossConfig: { method: "DAPO" },
          chunkSize: 1,
          maxConcurrentRollouts: 4,
        });

        const providerPostsBeforeConcurrentAttempt = provider.calls.filter((call) =>
          call.startsWith("POST ")).length;
        await expect(service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe,
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
        })).rejects.toThrow("is still active");
        expect(provider.calls.filter((call) => call.startsWith("POST "))).toHaveLength(
          providerPostsBeforeConcurrentAttempt,
        );

        const firstState = await service.state();
        const completed = firstState.jobs.find((job) => job.id === started.job.id);
        expect(completed).toMatchObject({
          status: "succeeded",
          metadata: {
            providerCollected: true,
            optimizerUpdatesObserved: 2,
            frozenEvaluationThresholdPassed: true,
          },
        });
        expect(provider.calls).toContain(
          "POST /v1/accounts/test-account/deployedModels?replaceMergedAddon=true",
        );
        expect(provider.calls).toContain(
          "DELETE /v1/accounts/test-account/deployedModels/op-eval-rft-lora-fixture",
        );
        expect(firstState.models.find((model) => model.jobId === started.job.id)).toMatchObject({
          status: "imported",
          promotable: true,
        });
        expect(firstState.artifacts
          .filter((artifact) => artifact.jobId === started.job.id)
          .map((artifact) => artifact.kind)
          .sort()).toEqual(["adapter", "evaluation", "metrics"]);
        const attempts = await store.listTaskAttempts(taskset.id);
        expect(attempts).toHaveLength(2);
        expect(attempts.map((attempt) => attempt.metadata.execution)).toEqual([
          "taskset_baseline_tool_loop",
          "taskset_baseline_tool_loop",
        ]);
        expect(attempts.map((attempt) => attempt.metadata.verifierOutcome)).toEqual([
          "parse_failure",
          "correct",
        ]);
        expect(provider.inferenceBodies.some((body) =>
          Array.isArray(body.tools) &&
          body.tools.length === 4 &&
          body.tool_choice === "auto" &&
          body.reasoning_effort === "none",
        )).toBe(true);
        const providerCallsBeforeReevaluation = provider.calls.length;
        const reevaluated = await service.evaluateJob(started.job.id);
        expect(reevaluated.metadata).toMatchObject({
          evaluationComplete: true,
          reusedStages: ["base", "trained"],
          estimatedDeploymentCostUsd: 0,
          thresholdPassed: true,
        });
        expect(provider.calls).toHaveLength(providerCallsBeforeReevaluation);
        expect(JSON.stringify(firstState)).not.toContain(API_KEY);

        const callsBeforeReplay = provider.calls.length;
        const eventsBeforeReplay = await store.listTrainingJobEvents(started.job.id);
        const replayed = await service.state();
        expect(provider.calls).toHaveLength(callsBeforeReplay);
        expect(await store.listTrainingJobEvents(started.job.id)).toEqual(eventsBeforeReplay);
        const replayedArtifacts = replayed.artifacts.filter(
          (artifact) => artifact.jobId === started.job.id,
        );
        expect(replayedArtifacts.map((artifact) => artifact.kind).sort())
          .toEqual(["adapter", "evaluation", "evaluation", "metrics"]);
        expect(replayedArtifacts.find((artifact) => artifact.kind === "metrics"))
          .toMatchObject({
            metadata: {
              metricSource: "reinforcement_fine_tuning_metrics_endpoint",
              providerFilename: "fireworks-rft-metrics.json",
            },
          });
      } finally {
        await service.close();
      }
    }));

  test("binds Fireworks approval to the signed-in OpenPond account at launch", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = tasksetFixture({ ready: true });
      await store.upsertTaskset(taskset);
      const provider = fireworksMock();
      let currentActor = "0xglu";
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor: async () => currentActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        fireworksRequest: provider.request,
      });
      try {
        const plan = await service.createPlan({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRecipe(),
          exportApproved: true,
          retentionDays: 7,
          region: null,
        });
        const bundle = await service.buildBundle(plan.id);
        const approval = await service.approve({
          planId: plan.id,
          bundleId: bundle.manifest.id,
          approvedBy: "forged-client-actor",
          maximumCostUsd: 9,
        });
        expect(approval.approvedBy).toBe("0xglu");

        currentActor = "different-account";
        await expect(service.launch({
          planId: plan.id,
          approvalId: approval.id,
        })).rejects.toThrow(
          "approved by 0xglu, but the signed-in OpenPond account is different-account",
        );
        expect(provider.calls.some((call) => call.startsWith("POST "))).toBe(false);
        expect(await store.listTrainingJobs()).toHaveLength(0);
      } finally {
        await service.close();
      }
    }));

  test("blocks paid GRPO before provider upload when the frozen baseline has zero reward variance", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const proven = rftTasksetFixture();
      const taskset = TasksetSchema.parse({
        ...proven,
        readiness: {
          ...proven.readiness!,
          baselineReportId: "baseline_zero_variance",
          baselineReward: {
            count: 4,
            mean: 0,
            min: 0,
            max: 0,
            variance: 0,
          },
        },
      });
      await store.upsertTaskset(taskset);
      const provider = fireworksRftMock();
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        fireworksRequest: provider.request,
        fireworksRftPublicBaseUrl: () =>
          "https://rft.openpond.test/v1/training/fireworks/rft",
      });
      try {
        await expect(service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRftRecipe(),
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
        })).rejects.toThrow("Training Plan is incompatible and cannot be bundled");
        const [plan] = await store.listTrainingPlans();
        expect(plan?.compatibility).toMatchObject({
          compatible: false,
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: "rft_reward_variance_missing",
              severity: "error",
            }),
          ]),
        });
        expect(provider.calls.some((call) => call.startsWith("POST "))).toBe(false);
        expect(await store.listTrainingJobs()).toHaveLength(0);
      } finally {
        await service.close();
      }
    }));

  test("blocks Fireworks RFT when the local rollout budget cannot cover the provider batch", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = rftTasksetFixture();
      await store.upsertTaskset(taskset);
      const provider = fireworksRftMock();
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        fireworksRequest: provider.request,
        fireworksRftPublicBaseUrl: () =>
          "https://rft.openpond.test/v1/training/fireworks/rft",
      });
      const recipe = fireworksRftRecipe();
      try {
        await expect(service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: {
            ...recipe,
            resourceLimits: {
              ...recipe.resourceLimits,
              maxRollouts: 3,
            },
          },
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
        })).rejects.toThrow("Training Plan is incompatible");
        expect((await store.listTrainingPlans())[0]?.compatibility.issues)
          .toContainEqual(expect.objectContaining({
            code: "fireworks_rft_rollout_budget_too_small",
            severity: "error",
          }));
        expect(provider.calls.some((call) => call.startsWith("POST "))).toBe(false);
        expect(await store.listTrainingJobs()).toHaveLength(0);
      } finally {
        await service.close();
      }
    }));

  test("rejects an unresolvable GRPO Taskset before provider upload or spend", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const valid = rftTasksetFixture();
      const draft = TasksetSchema.parse({
        ...valid,
        status: "needs_review",
        readiness: null,
        metadata: { ...valid.metadata, worldSpecs: [] },
        contentHash: "00000000",
      });
      const tasksetHash = computeTasksetHash(draft);
      const taskset = TasksetSchema.parse({
        ...draft,
        status: "ready",
        readiness: {
          ...valid.readiness!,
          tasksetId: draft.id,
          tasksetHash,
        },
        contentHash: tasksetHash,
      });
      await store.upsertTaskset(taskset);
      const provider = fireworksRftMock();
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        fireworksRequest: provider.request,
        fireworksRftPublicBaseUrl: () =>
          "https://rft.openpond.test/v1/training/fireworks/rft",
      });
      try {
        await expect(service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRftRecipe(),
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
        })).rejects.toThrow("Training Plan is incompatible");
        expect((await store.listTrainingPlans())[0]?.compatibility.issues).toContainEqual(
          expect.objectContaining({
            code: "fireworks_rft_task_unresolvable",
            message: expect.stringContaining("no versioned Cross-System Operations world specs"),
          }),
        );
        expect(provider.calls.some((call) =>
          call.startsWith("POST /v1/accounts/test-account/datasets"),
        )).toBe(false);
      } finally {
        await service.close();
      }
    }));

  test("rejects an invalid RFT callback URL before provider upload or spend", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = rftTasksetFixture();
      await store.upsertTaskset(taskset);
      const provider = fireworksRftMock();
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        fireworksRequest: provider.request,
        fireworksRftPublicBaseUrl: () =>
          "http://127.0.0.1:17874/v1/training/fireworks/rft",
      });
      try {
        await expect(service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRftRecipe(),
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
        })).rejects.toThrow("public HTTPS callback URL");
        expect(provider.calls.some((call) => call.startsWith("POST "))).toBe(false);
        expect(await store.listTrainingJobs()).toHaveLength(0);
      } finally {
        await service.close();
      }
    }));

  test("does not claim RFT success when the provider has no optimizer-update receipt", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = rftTasksetFixture();
      await store.upsertTaskset(taskset);
      const provider = fireworksRftMock({
        optimizerSteps: 0,
        trainedOutput: String(taskset.tasks.find((task) => task.split === "frozen_eval")?.expectedOutput?.text),
      });
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        fireworksRequest: provider.request,
        fireworksRftPublicBaseUrl: () =>
          "https://rft.openpond.test/v1/training/fireworks/rft",
        provisionFireworksRftEvaluator: async (input) => ({
          evaluatorId: "op-cso-remote-fixture",
          evaluatorName: "accounts/test-account/evaluators/op-cso-remote-fixture",
          sourceHash: "evaluatorhash0000000000000000000000000000000000000000000000000000",
          publicBaseUrl: input.publicBaseUrl,
        }),
      });
      try {
        const started = await service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRftRecipe(),
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
        });
        const state = await service.state();
        expect(state.jobs.find((job) => job.id === started.job.id)).toMatchObject({
          status: "failed",
          metadata: { optimizerUpdatesObserved: 0 },
        });
        expect(state.jobs.find((job) => job.id === started.job.id)?.error).toContain(
          "without a provider receipt proving optimizer updates",
        );
        expect(state.models.find((model) => model.jobId === started.job.id)).toBeUndefined();
        expect(state.artifacts.filter((artifact) =>
          artifact.jobId === started.job.id
          && artifact.kind === "metrics")).toHaveLength(1);
      } finally {
        await service.close();
      }
    }));

  test("redacts provider errors and reports training validation separately", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const validationErrors: Array<string | null> = [];
      const request: typeof fetch = async () =>
        jsonResponse(
          {
            error: {
              message: `Account suspended; credential ${API_KEY} cannot train.`,
            },
          },
          412,
        );
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
        }),
        recordFireworksCredentialValidation: async (error) => {
          validationErrors.push(error);
        },
        fireworksRequest: request,
      });

      try {
        const capabilities = await service.registry.get("fireworks").capabilities();
        expect(capabilities.available).toBe(false);
        expect(capabilities.unavailableReason).toContain("(412)");
        expect(capabilities.unavailableReason).not.toContain(API_KEY);
        expect(validationErrors.at(-1)).toBe(capabilities.unavailableReason);
      } finally {
        await service.close();
      }
    }));

  test("routes cancellation to the owning Fireworks destination", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = tasksetFixture({ ready: true });
      await store.upsertTaskset(taskset);
      const provider = fireworksMock({ remainRunning: true });
      const service = createTrainingService({
        store,
        storeDir: directory,
        localWorkerProjectDir: path.resolve("python/openpond-training"),
        resolveApprovalActor,
        resolveFireworksCredential: async () => ({
          value: API_KEY,
          source: "local_secret",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
        }),
        fireworksRequest: provider.request,
      });

      try {
        const started = await service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRecipe(),
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
        });
        const cancelled = await service.cancelJob(started.job.id);
        expect(cancelled.status).toBe("cancelling");
        expect(provider.calls.some((call) => call.endsWith(":cancel"))).toBe(true);
      } finally {
        await service.close();
      }
    }));
});
