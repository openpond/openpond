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

const API_KEY = "fw_test_secret_that_must_never_appear";
const resolveApprovalActor = async () => "0xglu";

describe.sequential("Fireworks training destination", () => {
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

  test("uses the provider credential, enforces bounded approval, reconciles once, imports weights, and runs frozen Eval", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = tasksetFixture({ ready: true });
      await store.upsertTaskset(taskset);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
      });
      const provider = fireworksMock({ deploymentStatusFailures: 1 });
      const validations: Array<string | null> = [];
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
        recordFireworksCredentialValidation: async (error) => {
          validations.push(error);
        },
        gradeTaskAttempt: evaluation.grade,
        fireworksRequest: provider.request,
      });

      try {
        await expect(service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRecipe(),
          exportApproved: true,
          maximumCostUsd: 10,
          retentionDays: 7,
        })).rejects.toThrow("explicit maximum cost");
        expect(provider.calls.some((call) =>
          call.startsWith("POST /v1/accounts/test-account/datasets"),
        )).toBe(false);

        const started = await service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRecipe(),
          exportApproved: true,
          maximumCostUsd: 9,
          retentionDays: 7,
          region: null,
        });

        expect(started.plan).toMatchObject({
          destinationId: "fireworks",
          environmentPlacement: "provider_native",
          estimatedCostUsd: 3,
          dataPolicy: {
            exportApproved: true,
            retentionDays: 7,
          },
        });
        expect(started.approval.maximumCostUsd).toBe(9);
        expect(started.approval.approvedBy).toBe("0xglu");
        expect(started.job).toMatchObject({
          destinationId: "fireworks",
          status: "starting",
          metadata: {
            provider: "fireworks",
            providerAccountId: "test-account",
            providerDatasetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            providerDatasetTaskIds: ["task_train"],
            approvedMaximumCostUsd: 9,
            quotedCostUsd: 3,
            credentialSource: "local_secret",
            providerRetentionDays: 7,
            providerDatasetDeletionStatus: "retained",
            providerArtifactDeletionStatus: "retained",
          },
        });
        expect(validations).toContain(null);
        expect(provider.uploadedDataset).toContain("Say hello");
        expect(provider.uploadedDataset).not.toContain("Say goodbye");
        expect(provider.uploadedDataset).not.toContain("Goodbye friend");

        const firstState = await service.state();
        const completed = firstState.jobs.find((job) => job.id === started.job.id);
        expect(completed).toMatchObject({
          status: "succeeded",
          metadata: {
            providerCollected: true,
            frozenEvaluationThresholdPassed: true,
          },
        });
        expect(firstState.credentialRefs).toContainEqual({
          destinationId: "fireworks",
          configured: true,
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:01:00.000Z",
        });
        const artifacts = firstState.artifacts.filter(
          (artifact) => artifact.jobId === started.job.id,
        );
        expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
          "adapter",
          "evaluation",
        ]);
        expect(artifacts.find((artifact) => artifact.kind === "adapter")).toMatchObject({
          baseModelId: "accounts/fireworks/models/qwen3-0p6b",
          baseModelRevision: "fireworks-managed-model-resource-v1",
        });
        const lineage = firstState.models.find(
          (candidate) => candidate.jobId === started.job.id,
        );
        expect(lineage).toMatchObject({
          promotable: true,
          status: "imported",
        });
        const attempts = await store.listTaskAttempts(taskset.id);
        expect(attempts).toHaveLength(2);
        expect(attempts.map((attempt) => attempt.metadata.evaluationStage)).toEqual([
          "base",
          "trained",
        ]);
        const grades = await store.listGradeResultsForTaskset(taskset.id);
        expect(grades.map((grade) => grade.passed)).toEqual([false, true]);
        expect(provider.calls).toContain(
          "POST /v1/accounts/test-account/deployedModels?replaceMergedAddon=true",
        );
        expect(provider.calls).toContain(
          "DELETE /v1/accounts/test-account/deployedModels/op-eval-lora-fixture",
        );

        const eventsBefore = await store.listTrainingJobEvents(started.job.id);
        const providerCallsBefore = provider.calls.length;
        const secondState = await service.state();
        expect(await store.listTrainingJobEvents(started.job.id)).toEqual(eventsBefore);
        expect(secondState.artifacts.filter((item) => item.jobId === started.job.id)).toHaveLength(2);
        expect(provider.calls.length).toBe(providerCallsBefore);
        expect(await service.launch({
          planId: started.plan.id,
          approvalId: started.approval.id,
        })).toMatchObject({ id: started.job.id, status: "succeeded" });
        expect(provider.calls.length).toBe(providerCallsBefore);
        const portable = await service.artifactDownload(
          artifacts.find((artifact) => artifact.kind === "adapter")!.id,
        );
        expect(portable.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(provider.calls.length).toBe(providerCallsBefore);
        expect(JSON.stringify(secondState)).not.toContain(API_KEY);
        await expect(service.saveCredential({
          destinationId: "fireworks",
          value: "duplicate",
        })).rejects.toThrow("Settings > Providers");

        const evidence = createEvidenceSnapshot({
          objective: taskset.objective,
          sources: taskset.sourceRefs,
          timestamp: "2026-07-17T00:11:00.000Z",
        });
        const createImprove = createModelTrainingCreateImproveRun({
          profileId: taskset.profileId,
          tasksetId: taskset.id,
          displayName: taskset.name,
          trainingPlanId: started.plan.id,
          trainingJobId: started.job.id,
          tasksetRef: createTasksetRef({
            taskset,
            evidenceSnapshotIds: [evidence.id],
            approvedAt: evidence.createdAt,
          }),
          evidenceSnapshots: [evidence],
          timestamp: evidence.createdAt,
        });
        await store.upsertCreateImproveRun(createImprove);
        await syncModelTrainingCreateImproveRuns({
          store,
          profileId: taskset.profileId,
          execution: {
            jobs: secondState.jobs,
            models: secondState.models,
          },
        });

        const chatBinding = await service.bindModel({
          profileId: taskset.profileId,
          modelId: lineage!.id,
          role: "chat_manual",
          roleTargetId: "default",
          promotedBy: "0xglu",
        });
        const agentBinding = await service.bindModel({
          profileId: taskset.profileId,
          modelId: lineage!.id,
          role: "agent",
          roleTargetId: "agent_fixture",
          promotedBy: "0xglu",
        });
        expect(await resolveModelLineageIdForRuntime(
          store,
          `binding:${taskset.profileId}:agent:agent_fixture`,
        )).toBe(lineage!.id);
        expect((await listLocalAdapterProviderModels(store))[0]).toMatchObject({
          id: lineage!.id,
          raw: {
            activeBindingRoles: expect.arrayContaining([
              "chat_manual:default",
              "agent:agent_fixture",
            ]),
          },
        });
        const releasedRun = await store.getCreateImproveRun(createImprove.id);
        expect(releasedRun).toMatchObject({
          state: "released",
          releaseOutcome: {
            status: "released",
            releaseReceiptRef: agentBinding.id,
          },
          candidates: [{ status: "accepted" }],
        });

        const replacementJob = await store.saveTrainingJob({
          ...completed!,
          id: "training_job_replacement_fixture",
          createdAt: "2026-07-17T00:12:00.000Z",
          updatedAt: "2026-07-17T00:12:00.000Z",
        });
        const originalAdapter = artifacts.find((artifact) => artifact.kind === "adapter")!;
        const originalEvaluation = artifacts.find((artifact) => artifact.kind === "evaluation")!;
        const replacementAdapter = await store.saveTrainingArtifact({
          ...originalAdapter,
          id: "artifact_replacement_fixture",
          jobId: replacementJob.id,
          createdAt: "2026-07-17T00:12:00.000Z",
        });
        const replacementEvaluation = await store.saveTrainingArtifact({
          ...originalEvaluation,
          id: "evaluation_replacement_fixture",
          jobId: replacementJob.id,
          createdAt: "2026-07-17T00:12:00.000Z",
        });
        const replacement = await store.saveModelArtifactLineage({
          ...lineage!,
          id: "lineage_replacement_fixture",
          jobId: replacementJob.id,
          artifactId: replacementAdapter.id,
          frozenEvaluationArtifactId: replacementEvaluation.id,
          importedAt: "2026-07-17T00:12:00.000Z",
        });
        const replacementBinding = await service.bindModel({
          profileId: taskset.profileId,
          modelId: replacement.id,
          role: "chat_manual",
          roleTargetId: "default",
          promotedBy: "0xglu",
        });
        expect(replacementBinding.priorBindingId).toBe(chatBinding.id);
        expect(replacementBinding.rollbackTargetBindingId).toBe(chatBinding.id);
        expect(await store.getModelArtifactLineage(replacement.id)).toMatchObject({
          pinned: true,
        });
        expect(await store.getModelArtifactLineage(lineage!.id)).toMatchObject({
          pinned: true,
        });
        await expect(
          service.setModelPinned({
            modelId: replacement.id,
            pinned: false,
          }),
        ).rejects.toThrow("Current Model versions stay pinned.");
        const rollback = await service.rollbackModelBinding({
          bindingId: replacementBinding.id,
          rolledBackBy: "0xglu",
        });
        expect(rollback.activeBinding).toMatchObject({
          modelArtifactLineageId: lineage!.id,
          priorBindingId: replacementBinding.id,
        });
        expect(await store.getTrainingArtifact(lineage!.artifactId)).not.toBeNull();
        expect(await store.getTrainingArtifact(lineage!.frozenEvaluationArtifactId!)).not.toBeNull();
        expect(await service.rejectModel({
          modelId: replacement.id,
          reason: "Prefer the prior active candidate after comparison.",
        })).toMatchObject({ status: "rejected" });

        const callsBeforeRestart = provider.calls.length;
        await service.close();
        const restarted = createTrainingService({
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
        });
        try {
          expect((await restarted.state()).jobs.find((job) => job.id === started.job.id)).toMatchObject({
            status: "succeeded",
            metadata: { providerCollected: true },
          });
          expect(provider.calls.slice(callsBeforeRestart)).toEqual([
            "GET /v1/accounts",
            "GET /v1/accounts/fireworks/models/qwen3-0p6b",
          ]);
          expect(provider.calls.slice(callsBeforeRestart).some((call) =>
            call.includes("supervisedFineTuningJobs"),
          )).toBe(false);
        } finally {
          await restarted.close();
        }
      } finally {
        await service.close();
      }
    }));

  test("keeps provider inference outages separate from model-quality failure", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = tasksetFixture({ ready: true });
      await store.upsertTaskset(taskset);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
      });
      const provider = fireworksMock({ inferenceUnavailable: true });
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
      });

      try {
        const started = await service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRecipe(),
          exportApproved: true,
          maximumCostUsd: 3,
          retentionDays: 7,
        });
        const state = await service.state();
        const completed = state.jobs.find((job) => job.id === started.job.id)!;
        const artifact = state.artifacts.find(
          (candidate) =>
            candidate.jobId === started.job.id && candidate.kind === "evaluation",
        )!;
        const lineage = state.models.find(
          (candidate) => candidate.jobId === started.job.id,
        )!;

        expect(completed).toMatchObject({
          status: "succeeded",
          metadata: {
            frozenEvaluationComplete: false,
            frozenEvaluationThresholdPassed: false,
          },
        });
        expect(artifact.metadata).toMatchObject({
          evaluationComplete: false,
          infrastructureFailureCount: 2,
          baseInfrastructureFailures: 1,
          trainedInfrastructureFailures: 1,
          thresholdPassed: false,
        });
        expect(lineage).toMatchObject({
          promotable: false,
          status: "imported",
        });

        const evidence = createEvidenceSnapshot({
          objective: taskset.objective,
          sources: taskset.sourceRefs,
          timestamp: "2026-07-17T00:11:00.000Z",
        });
        const createImprove = createModelTrainingCreateImproveRun({
          profileId: taskset.profileId,
          tasksetId: taskset.id,
          displayName: taskset.name,
          trainingPlanId: started.plan.id,
          trainingJobId: started.job.id,
          tasksetRef: createTasksetRef({
            taskset,
            evidenceSnapshotIds: [evidence.id],
            approvedAt: evidence.createdAt,
          }),
          evidenceSnapshots: [evidence],
          timestamp: evidence.createdAt,
        });
        await store.upsertCreateImproveRun(createImprove);
        await syncModelTrainingCreateImproveRuns({
          store,
          profileId: taskset.profileId,
          execution: {
            jobs: state.jobs,
            models: state.models,
          },
        });

        const run = await store.getCreateImproveRun(createImprove.id);
        expect(run).toMatchObject({
          state: "blocked",
          blockedReason: expect.stringContaining(
            "No model-quality result was recorded",
          ),
          evaluationReceipts: [
            expect.objectContaining({
              subject: "active",
              status: "blocked",
              metadata: expect.objectContaining({
                evaluationComplete: false,
                infrastructureFailureCount: 1,
              }),
            }),
            expect.objectContaining({
              subject: "candidate",
              status: "blocked",
              metadata: expect.objectContaining({
                evaluationComplete: false,
                infrastructureFailureCount: 1,
              }),
            }),
          ],
        });

        const reevaluatedAt = new Date(
          Date.parse(completed.updatedAt) + 60_000,
        ).toISOString();
        for (const attempt of await store.listTaskAttempts(taskset.id)) {
          await store.saveTaskAttempt({
            ...attempt,
            completedAt: reevaluatedAt,
            infrastructureError: null,
            output: { text: "ANSWER: {}" },
          });
        }
        const updatedJob = {
          ...completed,
          updatedAt: reevaluatedAt,
          metadata: {
            ...completed.metadata,
            frozenEvaluationComplete: true,
          },
        };
        await store.saveTrainingJob(updatedJob);
        await syncModelTrainingCreateImproveRuns({
          store,
          profileId: taskset.profileId,
          execution: {
            jobs: state.jobs.map((job) =>
              job.id === updatedJob.id ? updatedJob : job),
            models: state.models,
          },
        });

        const refreshed = await store.getCreateImproveRun(createImprove.id);
        expect(refreshed).toMatchObject({
          state: "blocked",
          blockedReason: expect.stringContaining(
            "failed 1 of 1 frozen-evaluation tasks",
          ),
          updatedAt: reevaluatedAt,
          evaluationReceipts: [
            expect.objectContaining({
              subject: "active",
              status: "failed",
              metadata: expect.objectContaining({
                evaluationComplete: true,
                infrastructureFailureCount: 0,
              }),
            }),
            expect.objectContaining({
              subject: "candidate",
              status: "failed",
              metadata: expect.objectContaining({
                evaluationComplete: true,
                infrastructureFailureCount: 0,
              }),
            }),
          ],
        });
      } finally {
        await service.close();
      }
    }));

  test("prepares an exact quote without provider writes and confirms the same plan idempotently", async () =>
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
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        fireworksRequest: provider.request,
      });

      try {
        const prepared = await service.prepareStart({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRecipe(),
          exportApproved: true,
          retentionDays: 7,
          region: null,
        });

        expect(prepared).toMatchObject({
          approvalActor: "0xglu",
          plan: {
            destinationId: "fireworks",
            estimatedCostUsd: 3,
            compatibility: { compatible: true },
          },
          bundle: {
            containsRawChats: false,
            containsSecrets: false,
            containsHiddenGraderAssets: false,
          },
        });
        expect(provider.calls.some((call) => call.startsWith("POST "))).toBe(false);

        const first = await service.startPrepared({
          planId: prepared.plan.id,
          bundleId: prepared.bundle.id,
          maximumCostUsd: 3,
        });
        const providerWrites = provider.calls.filter((call) => call.startsWith("POST ")).length;
        const repeated = await service.startPrepared({
          planId: prepared.plan.id,
          bundleId: prepared.bundle.id,
          maximumCostUsd: 3,
        });

        expect(first.approval).toMatchObject({
          approvedBy: "0xglu",
          maximumCostUsd: 3,
        });
        expect(repeated.approval.id).toBe(first.approval.id);
        expect(repeated.job.id).toBe(first.job.id);
        expect(provider.calls.filter((call) => call.startsWith("POST "))).toHaveLength(
          providerWrites,
        );
        expect((await store.listTrainingJobs())).toHaveLength(1);
      } finally {
        await service.close();
      }
    }));

  test("validates the selected Qwen3 8B model before preparing a retry", async () =>
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
          updatedAt: "2026-07-17T00:01:00.000Z",
        }),
        fireworksRequest: provider.request,
      });

      try {
        const base = fireworksRecipe();
        const recipe = SftRecipeSchema.parse({
          ...base,
          baseModel: {
            ...base.baseModel,
            id: "accounts/fireworks/models/qwen3-8b",
          },
          lora: { ...base.lora, rank: 16, alpha: 32 },
          optimizer: {
            ...base.optimizer,
            epochs: 5,
            learningRate: 0.0001,
          },
        });
        const prepared = await service.prepareStart({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe,
          exportApproved: true,
          retentionDays: 7,
          region: null,
        });

        expect(prepared.plan).toMatchObject({
          estimatedCostUsd: 3,
          compatibility: { compatible: true },
          recipe: {
            baseModel: {
              id: "accounts/fireworks/models/qwen3-8b",
            },
            optimizer: {
              epochs: 5,
              learningRate: 0.0001,
            },
          },
        });
        expect(provider.calls).toContain(
          "GET /v1/accounts/fireworks/models/qwen3-8b",
        );
        expect(provider.calls.some((call) => call.startsWith("POST "))).toBe(
          false,
        );
      } finally {
        await service.close();
      }
    }));

  test("retries a provider-create rejection with the same local job and approval", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = tasksetFixture({ ready: true });
      await store.upsertTaskset(taskset);
      const provider = fireworksMock({ remainRunning: true, failSftCreates: 1 });
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
      });

      try {
        const prepared = await service.prepareStart({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRecipe(),
          exportApproved: true,
          retentionDays: 7,
          region: null,
        });
        const confirmation = {
          planId: prepared.plan.id,
          bundleId: prepared.bundle.id,
          maximumCostUsd: 3,
        };

        await expect(service.startPrepared(confirmation)).rejects.toThrow(
          "invalid fine-tuning job",
        );
        const [failed] = await store.listTrainingJobs();
        expect(failed).toMatchObject({
          status: "failed",
          metadata: { providerJobState: "LOCAL_JOB_RECEIPT_CREATED" },
        });

        const retried = await service.startPrepared(confirmation);

        expect(retried.job).toMatchObject({
          id: failed!.id,
          status: "starting",
        });
        expect(provider.calls.filter((call) =>
          call.startsWith("POST /v1/accounts/test-account/supervisedFineTuningJobs"),
        )).toHaveLength(2);
        expect(await store.listTrainingJobs()).toHaveLength(1);
      } finally {
        await service.close();
      }
    }));

  test("executes the GRPO provider lifecycle, proves optimizer updates, imports weights, and evaluates privately", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = rftTasksetFixture();
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
          recipe: fireworksRftRecipe(),
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
          },
          inferenceParameters: {
            responseCandidatesCount: 4,
            maxOutputTokens: 512,
          },
          lossConfig: { method: "GRPO" },
          maxConcurrentRollouts: 4,
        });

        const providerPostsBeforeConcurrentAttempt = provider.calls.filter((call) =>
          call.startsWith("POST ")).length;
        await expect(service.start({
          tasksetId: taskset.id,
          destinationId: "fireworks",
          recipe: fireworksRftRecipe(),
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

function fireworksRecipe(): SftRecipe {
  return SftRecipeSchema.parse({
    schemaVersion: "openpond.sftRecipe.v1",
    method: "sft",
    parameterization: "lora",
    baseModel: {
      id: "accounts/fireworks/models/qwen3-0p6b",
      revision: "fireworks-managed-model-resource-v1",
      tokenizerRevision: "fireworks-provider-managed",
      chatTemplateHash: "fireworks-qwen3-chat-v1",
    },
    dataset: {
      trainSplit: "train",
      validationSplit: "frozen_eval",
      completionOnly: true,
      maxSequenceLength: 512,
    },
    lora: {
      rank: 8,
      alpha: 16,
      dropout: 0.05,
      targetModules: [
        "q_proj",
        "k_proj",
        "v_proj",
        "o_proj",
        "gate_proj",
        "up_proj",
        "down_proj",
      ],
    },
    optimizer: {
      learningRate: 0.0002,
      epochs: 1,
      maxSteps: 8,
      batchSize: 1,
      gradientAccumulationSteps: 1,
      seed: 17,
    },
    resourceLimits: {
      cpuThreads: 1,
      memoryBytes: 1_000_000_000,
      wallTimeMs: 3_600_000,
    },
  });
}

function rftTasksetFixture() {
  const base = tasksetFixture({ ready: true });
  const worldSpecs = [
    { seed: 101, split: "train" as const, difficulty: "easy" as const },
    { seed: 202, split: "frozen_eval" as const, difficulty: "easy" as const },
  ];
  const generatedTasks = worldSpecs.flatMap((spec) =>
    generateCrossSystemTasks(generateCrossSystemWorld(spec))
      .filter((task) => task.phrasingVariant === 0),
  );
  const selectedTasks = [
    generatedTasks.find((task) => task.split === "train")!,
    generatedTasks.find((task) => task.split === "frozen_eval")!,
  ];
  const tasks = selectedTasks.map((task, index) => ({
    ...base.tasks[index]!,
    id: `authored_${task.id}`,
    clusterKey: task.clusterKey,
    split: task.split,
    input: { prompt: task.prompt },
    expectedOutput: { text: `ANSWER: ${JSON.stringify(task.expectedAnswer)}` },
    privilegedContextRef: `private_${task.id}`,
    tags: ["cross-system-operations"],
    metadata: {
      taskId: task.id,
      family: task.family,
      worldId: task.worldId,
    },
  }));
  const draft = TasksetSchema.parse({
    ...base,
    status: "needs_review",
    readiness: null,
    capabilities: {
      ...base.capabilities,
      taskKind: "single_agent",
      supportedSignals: ["reward"],
      compatibleMethods: ["grpo"],
      rewardKinds: ["deterministic"],
      requiresTools: true,
      requiresState: true,
      environmentPlacements: ["provider_native"],
    },
    environment: {
      ...base.environment,
      kind: "stateful_harness",
      stateful: true,
      toolNames: ["search_crm", "query_billing", "search_support", "run_python"],
      metadata: {
        flagship: "cross-system-operations",
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      },
    },
    tasks,
    graderFixtures: base.graderFixtures.map((fixture) => ({
      ...fixture,
      taskId: tasks[1]!.id,
      output: fixture.expectedPassed
        ? { text: tasks[1]!.expectedOutput!.text }
        : fixture.output,
    })),
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [{
        id: "reward_train",
        kind: "reward",
        taskId: tasks[0]!.id,
        sourceRefs: [base.sourceRefs[0]!.id],
        artifactRef: "private_deterministic_grader",
        approved: true,
        confidence: 1,
        metadata: {},
      }],
      labels: [],
    },
    metadata: {
      ...base.metadata,
      flagship: "cross-system-operations",
      trainingMethod: "grpo",
      worldSpecs,
    },
    contentHash: "00000000",
  });
  const hash = computeTasksetHash(draft);
  return TasksetSchema.parse({
    ...draft,
    status: "ready",
    readiness: {
      schemaVersion: "openpond.tasksetReadiness.v1",
      tasksetId: draft.id,
      tasksetHash: hash,
      ready: true,
      recommendedMethod: "grpo",
      trainingPath: { primaryMethod: "grpo", bootstrap: null },
      compatibleDestinationClasses: ["hosted_byok"],
      blockers: [],
      warnings: [],
      baselineReportId: "baseline_rft_fixture",
      baselineReward: {
        count: 4,
        mean: 0.5,
        min: 0,
        max: 1,
        variance: 0.25,
      },
      generatedAt: "2026-07-17T00:00:00.000Z",
    },
    contentHash: hash,
  });
}

function fireworksRftRecipe(): RftRecipe {
  return RftRecipeSchema.parse({
    schemaVersion: "openpond.rftRecipe.v1",
    method: "grpo",
    parameterization: "lora",
    baseModel: {
      id: "accounts/fireworks/models/qwen3-0p6b",
      revision: "fireworks-managed-model-resource-v1",
      tokenizerRevision: "fireworks-provider-managed",
      chatTemplateHash: "fireworks-qwen3-chat-v1",
    },
    dataset: {
      trainSplit: "train",
      validationSplit: "frozen_eval",
      maxPromptTokens: 1024,
    },
    lora: { rank: 8 },
    rollout: {
      groupSize: 4,
      concurrency: 4,
      maxTurns: 15,
      maxOutputTokens: 512,
      temperature: 0.8,
      topP: 0.95,
      seed: 17,
    },
    optimizer: {
      learningRate: 0.0002,
      maxSteps: 2,
    },
    reward: {
      graderId: "expected_output",
      graderHash: "graderhash00000000",
      environmentId: "cross-system-operations",
      environmentVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    },
    resourceLimits: {
      wallTimeMs: 180_000,
      maxRollouts: 8,
      maxPayloadBytes: 1_000_000,
    },
  });
}

function fireworksMock(options: {
  remainRunning?: boolean;
  failSftCreates?: number;
  inferenceUnavailable?: boolean;
  deploymentStatusFailures?: number;
} = {}) {
  const calls: string[] = [];
  let uploadedDataset = "";
  let remainingSftCreateFailures = options.failSftCreates ?? 0;
  let remainingDeploymentStatusFailures =
    options.deploymentStatusFailures ?? 0;
  const deployments = new Map<string, Record<string, unknown>>();
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL
      ? input
      : input.url);
    const route = `${init.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push(route);
    const authorization = new Headers(init.headers).get("authorization");
    if (url.hostname !== "weights.example.test") {
      expect(authorization).toBe(`Bearer ${API_KEY}`);
    }
    if (url.pathname === "/v1/accounts") {
      return jsonResponse({ accounts: [{ name: "accounts/test-account" }] });
    }
    if (
      url.pathname === "/v1/accounts/fireworks/models/qwen3-0p6b" ||
      url.pathname === "/v1/accounts/fireworks/models/qwen3-8b"
    ) {
      return jsonResponse({
        name: url.pathname.slice("/v1/".length),
        state: "READY",
        tunable: true,
        rlTunable: true,
        supportsLora: true,
      });
    }
    if (url.pathname === "/v1/accounts/-/deploymentShapes/-/versions") {
      return jsonResponse({
        deploymentShapeVersions: [{
          name: "accounts/fireworks/deploymentShapes/rft-qwen3-0p6b/versions/mock",
          validated: true,
          latestValidated: true,
          snapshot: {
            name: "accounts/fireworks/deploymentShapes/rft-qwen3-0p6b",
            baseModel: "accounts/fireworks/models/qwen3-0p6b",
            acceleratorCount: 1,
            acceleratorType: "NVIDIA_H200_141GB",
            precision: "BF16",
          },
        }],
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployments" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        baseModel: string;
        minReplicaCount: number;
        maxReplicaCount: number;
        precision?: string;
        enableAddons?: boolean;
        enableHotReloadLatestAddon?: boolean;
        deploymentShape?: string;
      };
      const deploymentId = url.searchParams.get("deploymentId");
      if (deploymentId?.startsWith("op-eval-trained-")) {
        expect(body).toMatchObject({
          baseModel: "accounts/fireworks/models/qwen3-0p6b",
          enableAddons: false,
          enableHotReloadLatestAddon: true,
        });
        expect(body).not.toHaveProperty("deploymentShape");
      }
      const response = {
        name: `accounts/test-account/deployments/${deploymentId}`,
        baseModel: body.baseModel,
        state: url.searchParams.get("validateOnly") === "true"
          ? "STATE_UNSPECIFIED"
          : "CREATING",
        minReplicaCount: body.minReplicaCount,
        maxReplicaCount: body.maxReplicaCount,
        acceleratorCount: 1,
        acceleratorType: "NVIDIA_H100_80GB",
        precision: body.precision,
        enableAddons: body.enableAddons,
        enableHotReloadLatestAddon: body.enableHotReloadLatestAddon,
        deploymentShape:
          body.deploymentShape ?? "mock-single-h100",
      };
      if (
        deploymentId &&
        url.searchParams.get("validateOnly") !== "true"
      ) {
        deployments.set(deploymentId, {
          ...response,
          state: "READY",
          replicaStats: { readyReplicaCount: 1 },
        });
      }
      return jsonResponse(response);
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployments" &&
      init.method !== "POST"
    ) {
      return jsonResponse({ deployments: [...deployments.values()] });
    }
    if (url.pathname.startsWith("/v1/accounts/test-account/deployments/")) {
      const deploymentId = url.pathname.split("/").at(-1)!;
      if (init.method === "DELETE") {
        deployments.delete(deploymentId);
        return jsonResponse({});
      }
      if (remainingDeploymentStatusFailures > 0) {
        remainingDeploymentStatusFailures -= 1;
        return jsonResponse({ code: 13, message: "" }, 500);
      }
      return jsonResponse(deployments.get(deploymentId) ?? {
        code: 5,
        message: "deployment not found",
      }, deployments.has(deploymentId) ? 200 : 404);
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployedModels" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        deployment: string;
        serverless: boolean;
        public: boolean;
      };
      expect(body).toMatchObject({
        model: "accounts/test-account/models/op-model-fixture",
        deployment: expect.stringContaining(
          "accounts/test-account/deployments/op-eval-trained-",
        ),
        serverless: false,
        public: false,
      });
      return jsonResponse({
        name: "accounts/test-account/deployedModels/op-eval-lora-fixture",
        ...body,
        state: "DEPLOYING",
      });
    }
    if (url.pathname === "/v1/accounts/test-account/deployedModels") {
      return jsonResponse({ deployedModels: [] });
    }
    if (url.pathname.startsWith("/v1/accounts/test-account/deployedModels/")) {
      if (init.method === "DELETE") return jsonResponse({});
      return jsonResponse({
        name: "accounts/test-account/deployedModels/op-eval-lora-fixture",
        state: "DEPLOYED",
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/datasets" &&
      init.method === "POST"
    ) {
      return jsonResponse({
        name: "accounts/test-account/datasets/op-sft-data-fixture",
        state: "UPLOADING",
      });
    }
    if (url.pathname.endsWith(":upload")) {
      const file = (init.body as FormData).get("file");
      if (!(file instanceof Blob)) throw new Error("Expected Fireworks dataset Blob.");
      uploadedDataset = await file.text();
      return jsonResponse({});
    }
    if (
      url.pathname.startsWith("/v1/accounts/test-account/datasets/") &&
      init.method !== "POST"
    ) {
      return jsonResponse({
        name: `accounts/test-account/datasets/${url.pathname.split("/").at(-1)}`,
        state: "READY",
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/supervisedFineTuningJobs" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("earlyStop");
      expect(body).toMatchObject({
        evalAutoCarveout: false,
        outputModel: expect.stringMatching(/^accounts\/test-account\/models\/op-model-/),
        purpose: "PURPOSE_PILOT",
      });
      if (remainingSftCreateFailures > 0) {
        remainingSftCreateFailures -= 1;
        return jsonResponse({
          code: 3,
          message: "invalid fine-tuning job",
        }, 400);
      }
      const jobId = url.searchParams.get("supervisedFineTuningJobId");
      return jsonResponse({
        name: `accounts/test-account/supervisedFineTuningJobs/${jobId}`,
        state: "JOB_STATE_PENDING",
        outputModel: "op-model-fixture",
        estimatedCost: { currencyCode: "USD", units: "2", nanos: 500_000_000 },
      });
    }
    if (
      url.pathname.includes("/supervisedFineTuningJobs/") &&
      url.pathname.endsWith(":cancel")
    ) {
      return jsonResponse({});
    }
    if (url.pathname.includes("/supervisedFineTuningJobs/")) {
      return jsonResponse({
        name: `accounts/test-account/supervisedFineTuningJobs/${url.pathname.split("/").at(-1)}`,
        state: options.remainRunning ? "JOB_STATE_RUNNING" : "JOB_STATE_COMPLETED",
        outputModel: "op-model-fixture",
        completedTime: options.remainRunning ? undefined : "2026-07-17T00:10:00.000Z",
        estimatedCost: { currencyCode: "USD", units: "2", nanos: 500_000_000 },
        jobProgress: { percent: options.remainRunning ? 25 : 100, epoch: 1 },
      });
    }
    if (url.pathname.endsWith(":getDownloadEndpoint")) {
      return jsonResponse({
        filenameToSignedUrls: {
          "adapter_model.safetensors": "https://weights.example.test/adapter_model.safetensors",
        },
      });
    }
    if (url.hostname === "weights.example.test") {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    if (url.pathname === "/inference/v1/chat/completions") {
      if (options.inferenceUnavailable) {
        return jsonResponse({
          error: {
            message: "Model not found, inaccessible, and/or not deployed",
          },
        }, 500);
      }
      const body = JSON.parse(String(init.body)) as { model: string };
      return jsonResponse({
        choices: [{
          message: {
            content: body.model.includes("op-model-fixture")
              || body.model.includes("op-eval-trained")
              ? "Goodbye friend"
              : "Incorrect base answer",
          },
        }],
        usage: { total_tokens: 8 },
      });
    }
    throw new Error(`Unexpected Fireworks request: ${route}`);
  };
  return {
    request,
    calls,
    get uploadedDataset() {
      return uploadedDataset;
    },
  };
}

function fireworksRftMock(options: { optimizerSteps?: number; trainedOutput?: string } = {}) {
  const calls: string[] = [];
  const inferenceBodies: Array<Record<string, unknown>> = [];
  const deployments = new Map<string, Record<string, unknown>>();
  let uploadedDataset = "";
  let rftCreateBody: Record<string, unknown> | null = null;
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL
      ? input
      : input.url);
    const route = `${init.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push(route);
    const authorization = new Headers(init.headers).get("authorization");
    if (url.hostname !== "weights.example.test") {
      expect(authorization).toBe(`Bearer ${API_KEY}`);
    }
    if (url.pathname === "/v1/accounts") {
      return jsonResponse({ accounts: [{ name: "accounts/test-account" }] });
    }
    if (url.pathname === "/v1/accounts/fireworks/models/qwen3-0p6b") {
      return jsonResponse({
        name: "accounts/fireworks/models/qwen3-0p6b",
        state: "READY",
        tunable: true,
        rlTunable: true,
        supportsLora: true,
      });
    }
    if (url.pathname === "/v1/accounts/-/deploymentShapes/-/versions") {
      return jsonResponse({
        deploymentShapeVersions: [{
          name: "accounts/fireworks/deploymentShapes/rft-qwen3-0p6b/versions/mock",
          validated: true,
          latestValidated: true,
          snapshot: {
            name: "accounts/fireworks/deploymentShapes/rft-qwen3-0p6b",
            baseModel: "accounts/fireworks/models/qwen3-0p6b",
            acceleratorCount: 1,
            acceleratorType: "NVIDIA_H200_141GB",
            precision: "BF16",
          },
        }],
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployments" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        baseModel: string;
        minReplicaCount: number;
        maxReplicaCount: number;
        precision?: string;
        enableAddons?: boolean;
        enableHotReloadLatestAddon?: boolean;
        deploymentShape?: string;
      };
      const deploymentId = url.searchParams.get("deploymentId");
      if (deploymentId?.startsWith("op-eval-trained-")) {
        expect(body).toMatchObject({
          baseModel: "accounts/fireworks/models/qwen3-0p6b",
          enableAddons: false,
          enableHotReloadLatestAddon: true,
        });
        expect(body).not.toHaveProperty("deploymentShape");
      }
      const response = {
        name: `accounts/test-account/deployments/${deploymentId}`,
        baseModel: body.baseModel,
        state: url.searchParams.get("validateOnly") === "true"
          ? "STATE_UNSPECIFIED"
          : "CREATING",
        minReplicaCount: body.minReplicaCount,
        maxReplicaCount: body.maxReplicaCount,
        acceleratorCount: 1,
        acceleratorType: "NVIDIA_H100_80GB",
        precision: body.precision,
        enableAddons: body.enableAddons,
        enableHotReloadLatestAddon: body.enableHotReloadLatestAddon,
        deploymentShape:
          body.deploymentShape ?? "mock-single-h100",
      };
      if (
        deploymentId &&
        url.searchParams.get("validateOnly") !== "true"
      ) {
        deployments.set(deploymentId, {
          ...response,
          state: "READY",
          replicaStats: { readyReplicaCount: 1 },
        });
      }
      return jsonResponse(response);
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployments" &&
      init.method !== "POST"
    ) {
      return jsonResponse({ deployments: [...deployments.values()] });
    }
    if (url.pathname.startsWith("/v1/accounts/test-account/deployments/")) {
      const deploymentId = url.pathname.split("/").at(-1)!;
      if (init.method === "DELETE") {
        deployments.delete(deploymentId);
        return jsonResponse({});
      }
      return jsonResponse(deployments.get(deploymentId) ?? {
        code: 5,
        message: "deployment not found",
      }, deployments.has(deploymentId) ? 200 : 404);
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployedModels" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        deployment: string;
        serverless: boolean;
        public: boolean;
      };
      expect(body).toMatchObject({
        model: expect.stringMatching(
          /^accounts\/test-account\/models\/op-rft-model-/,
        ),
        deployment: expect.stringContaining(
          "accounts/test-account/deployments/op-eval-trained-",
        ),
        serverless: false,
        public: false,
      });
      return jsonResponse({
        name: "accounts/test-account/deployedModels/op-eval-rft-lora-fixture",
        ...body,
        state: "DEPLOYING",
      });
    }
    if (url.pathname === "/v1/accounts/test-account/deployedModels") {
      return jsonResponse({ deployedModels: [] });
    }
    if (url.pathname.startsWith("/v1/accounts/test-account/deployedModels/")) {
      if (init.method === "DELETE") return jsonResponse({});
      return jsonResponse({
        name: "accounts/test-account/deployedModels/op-eval-rft-lora-fixture",
        state: "DEPLOYED",
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/datasets" &&
      init.method === "POST"
    ) {
      return jsonResponse({
        name: "accounts/test-account/datasets/op-rft-data-fixture",
        state: "UPLOADING",
      });
    }
    if (url.pathname.endsWith(":upload")) {
      const file = (init.body as FormData).get("file");
      if (!(file instanceof Blob)) throw new Error("Expected Fireworks dataset Blob.");
      uploadedDataset = await file.text();
      return jsonResponse({});
    }
    if (
      url.pathname.startsWith("/v1/accounts/test-account/datasets/") &&
      init.method !== "POST"
    ) {
      return jsonResponse({
        name: `accounts/test-account/datasets/${url.pathname.split("/").at(-1)}`,
        state: "READY",
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/reinforcementFineTuningJobs" &&
      init.method === "POST"
    ) {
      rftCreateBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      const jobId = url.searchParams.get("reinforcementFineTuningJobId");
      return jsonResponse({
        name: `accounts/test-account/reinforcementFineTuningJobs/${jobId}`,
        state: "JOB_STATE_PENDING",
        trainingConfig: {
          ...(rftCreateBody.trainingConfig as Record<string, unknown>),
          outputModel: (rftCreateBody.trainingConfig as Record<string, unknown>).outputModel,
        },
        inferenceParameters: rftCreateBody.inferenceParameters,
        lossConfig: rftCreateBody.lossConfig,
        maxConcurrentRollouts: rftCreateBody.maxConcurrentRollouts,
        estimatedCost: { currencyCode: "USD", units: "2" },
      });
    }
    if (url.pathname.includes("/reinforcementFineTuningJobs/")) {
      const jobId = url.pathname.split("/").at(-1);
      return jsonResponse({
        name: `accounts/test-account/reinforcementFineTuningJobs/${jobId}`,
        state: "JOB_STATE_COMPLETED",
        completedTime: "2026-07-17T00:10:00.000Z",
        trainingConfig: {
          outputModel: "accounts/test-account/models/op-rft-model-fixture",
          baseModel: "accounts/fireworks/models/qwen3-0p6b",
          learningRate: 0.0002,
          loraRank: 16,
        },
        outputStats: JSON.stringify({
          optimizer_steps: options.optimizerSteps ?? 2,
          rollout_count: 8,
        }),
        outputMetrics: JSON.stringify({
          mean_reward: 0.92,
        }),
        jobProgress: { percent: 100, outputRows: 8 },
        estimatedCost: { currencyCode: "USD", units: "2" },
      });
    }
    if (url.pathname.endsWith(":getDownloadEndpoint")) {
      return jsonResponse({
        filenameToSignedUrls: {
          "adapter_model.safetensors": "https://weights.example.test/adapter_model.safetensors",
        },
      });
    }
    if (url.hostname === "weights.example.test") {
      return new Response(new Uint8Array([5, 6, 7, 8]), { status: 200 });
    }
    if (url.pathname === "/inference/v1/chat/completions") {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        messages?: Array<{ role?: string }>;
      } & Record<string, unknown>;
      inferenceBodies.push(body);
      const trained =
        body.model.includes("op-rft-model") ||
        body.model.includes("op-eval-trained");
      const hasToolResult = body.messages?.some(
        (message) => message.role === "tool",
      ) ?? false;
      return jsonResponse({
        choices: [{
          message: trained && !hasToolResult
            ? {
                content: "",
                tool_calls: [{
                  id: "call_search_crm",
                  type: "function",
                  function: {
                    name: "search_crm",
                    arguments: JSON.stringify({
                      query: "*",
                      fields: ["account_id", "name"],
                      cursor: null,
                      limit: 20,
                    }),
                  },
                }],
              }
            : {
                content: trained
                  ? options.trainedOutput ?? "Goodbye friend"
                  : "Incorrect base answer",
              },
        }],
        usage: { total_tokens: 8 },
      });
    }
    throw new Error(`Unexpected Fireworks RFT request: ${route}`);
  };
  return {
    request,
    calls,
    get uploadedDataset() {
      return uploadedDataset;
    },
    get rftCreateBody() {
      return rftCreateBody;
    },
    inferenceBodies,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
