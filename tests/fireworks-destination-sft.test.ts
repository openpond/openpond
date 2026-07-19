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
import { API_KEY, fireworksMock, fireworksRecipe, resolveApprovalActor } from "./helpers/fireworks-destination-fixtures";

describe.sequential("Fireworks SFT destination", () => {
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

});
