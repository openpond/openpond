import { ModelProjectSchema, TrainingJobSchema } from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { buildTasksetTrainingBundle, createTrainingPlan } from "@openpond/training-sdk";
import { describe, expect, test } from "vitest";

import {
  portableModelVersionMetadata,
  portableReleaseGraphMetadata,
  preparePortableModelRunLifecycle,
  reconcilePortableModelRunLifecycle,
} from "../apps/server/src/training/portable-model-run-lifecycle.js";
import { managedRftRecipe, rftTasksetFixture } from "./helpers/managed-training-fixtures.js";
import { FIXED_TIME, withTrainingStore } from "./helpers/training-fixtures.js";

describe("portable Model Run lifecycle", () => {
  test("imports a Sandbox-owned managed candidate into canonical lineage and Model Version state", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = rftTasksetFixture();
      const recipeFixture = managedRftRecipe();
      const recipe = {
        ...recipeFixture,
        baseModel: {
          ...recipeFixture.baseModel,
          chatTemplateHash: sha256("portable-chat-template"),
        },
      };
      const modelRunId = "portable-model-run-1";
      const modelProject = ModelProjectSchema.parse({
        schemaVersion: "openpond.modelProject.v2",
        id: "portable-model-project-1",
        profileId: taskset.profileId,
        revision: 1,
        name: "Portable GRPO",
        objective: "Verify portable managed lifecycle.",
        defaultBaseModel: null,
        defaultDestinationId: "openpond_managed",
        trainingSetup: {
          tasksetRef: {
            id: taskset.id,
            revision: taskset.revision,
            contentHash: taskset.contentHash,
          },
          harnessRelease: {
            id: "harness-release-fixture",
            contentHash: sha256("harness-release-fixture"),
          },
          tasksetRelease: {
            id: "taskset-release-fixture",
            contentHash: sha256(taskset.contentHash),
          },
          baseModel: {
            schemaVersion: "openpond.baseModelPreference.v1",
            modelId: recipe.baseModel.id,
            revision: recipe.baseModel.revision,
            tokenizerRevision: recipe.baseModel.tokenizerRevision,
            chatTemplateHash: recipe.baseModel.chatTemplateHash,
            modelAssetId: null,
            source: "managed",
          },
          method: "grpo",
          destinationId: "openpond_managed",
          managedRolloutPlacement: "remote",
          runPreset: "small",
          recipe,
          preferredMaximumSpendUsd: 2,
          preferredRetentionDays: null,
        },
        hosted: null,
        tasksetSyncs: [],
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      });
      await store.upsertTaskset(taskset);
      await store.saveModelProject(modelProject);
      const capabilityReceipt = sha256("portable-lifecycle-capability");
      const graph = buildTasksetTrainingBundle({
        taskset,
        modelProject,
        modelRunId,
        runtime: {
          adapterId: "openpond-managed-harness",
          placement: "remote",
          capabilityReceipt,
          runtimeVersion: "1",
          dataPlane: null,
        },
        compute: {
          adapterId: "openpond-managed",
          kind: "managed",
          deviceOrPool: "gpu-0",
          capabilityReceipt,
          provider: "openpond",
        },
        engine: {
          adapterId: "sandbox-managed-rl",
          workerVersion: "managed-rl-v2",
          workerImageDigest: null,
          upstreamRevision: sha256("managed-rl-revision"),
          capabilityReceipt,
        },
        approval: {
          approvalHash: sha256("approval"),
          approvedAt: FIXED_TIME,
          maximumSpendUsd: 2,
        },
        openpondRelease: "0.0.38",
        workerProtocol: "openpond.managedRlWorker.v2",
        harnessRelease: {
          id: "harness-release-fixture",
          contentHash: sha256("harness-release-fixture"),
        },
        tasksetRelease: {
          id: "taskset-release-fixture",
          contentHash: sha256(taskset.contentHash),
        },
      });
      const profileRelease = graph.profileRelease;
      const releaseGraph = portableReleaseGraphMetadata({
        resolvedBundleHash: graph.resolvedBundleManifest.contentHash,
        profileRelease: profileRelease!,
        harnessRelease: graph.manifest.harnessRelease,
        agentRelease: taskset.environment.actionBindings?.[0]?.agentRelease ?? null,
        grader: {
          id: taskset.graders[0]!.id,
          contentHash: contentHash(taskset.graders[0]),
        },
      });
      const prepared = await preparePortableModelRunLifecycle({
        store,
        modelProject,
        modelRunId,
        taskset,
        sourceProjectRevision: 3,
        releaseGraph,
        maximumSpendUsd: 2,
        startedAt: FIXED_TIME,
      });
      expect(prepared.modelRun.harnessRelease).toEqual(graph.manifest.harnessRelease);
      expect(prepared.targetVersion.version).toBe(1);
      expect(
        await store.getModelVersion(
          `model_version_${contentHash({
            modelId: modelProject.id,
            version: 0,
          }).slice(0, 24)}`,
        ),
      ).toMatchObject({
        version: 0,
        kind: "base_reference",
      });

      const plan = createTrainingPlan({
        modelId: modelProject.id,
        taskset,
        destinationId: "openpond_managed",
        recipe,
        exportApproved: true,
      });
      await store.saveTrainingPlan(plan);
      const jobId = graph.manifest.id;
      const job = await store.saveTrainingJob(
        TrainingJobSchema.parse({
          schemaVersion: "openpond.trainingJob.v1",
          id: jobId,
          planId: plan.id,
          bundleHash: sha256("training-bundle"),
          approvalId: "approval-1",
          destinationId: "openpond_managed",
          status: "running",
          nonProduction: false,
          workerPid: null,
          startedAt: FIXED_TIME,
          completedAt: null,
          error: null,
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
          metadata: {
            harnessRunManifestHash: graph.manifest.contentHash,
            portableModelVersion: portableModelVersionMetadata(prepared.targetVersion),
            portableReleaseGraph: releaseGraph,
            sourceSnapshot: prepared.sourceSnapshot,
            portableAdapterBindings: {
              compute: graph.manifest.computeTarget,
              engine: graph.manifest.engine,
            },
          },
        }),
      );
      const artifactEntries = [
        {
          kind: "adapter" as const,
          objectRef: "sandbox-managed-rl://managed-provider-job-1/model-artifact-1",
          sha256: sha256("managed candidate"),
          sizeBytes: 8_000_000,
        },
      ];
      const artifactBase = {
        runId: "managed-provider-job-1",
        manifestHash: graph.manifest.contentHash,
        artifacts: artifactEntries,
      };
      const executionRef = {
        runId: "managed-provider-job-1",
        adapterId: "sandbox-managed-rl",
        providerJobId: "managed-provider-job-1",
        tenantId: "team_managed",
        leaseId: null,
        createdAt: FIXED_TIME,
      };
      const completedAt = "2026-07-12T00:10:00.000Z";
      const terminal = await reconcilePortableModelRunLifecycle({
        store,
        storeDir: directory,
        modelRunId,
        job,
        executionRef,
        status: {
          runId: "managed-provider-job-1",
          state: "succeeded",
          phase: "complete",
          progress: 1,
          rolloutProgress: {
            groupsCompleted: 4,
            groupsTarget: 4,
            optimizerUpdatesApplied: 3,
            optimizerUpdatesSkipped: 1,
          },
          updatedAt: completedAt,
          errorCode: null,
        },
        artifacts: {
          ...artifactBase,
          contentHash: contentHash(artifactBase),
        },
      });

      expect(terminal).toMatchObject({
        status: "succeeded",
        modelVersionId: prepared.targetVersion.id,
        receipt: {
          provider: "sandbox",
          providerRunId: "managed-provider-job-1",
          cleanup: {
            computeReleased: true,
            tunnelClosed: true,
          },
        },
      });
      expect(await store.getModelVersion(prepared.targetVersion.id)).toMatchObject({
        version: 1,
        kind: "lora_adapter",
        artifactLineageId: terminal.adapterArtifactLineageId,
      });
      const artifacts = await store.listTrainingArtifacts(jobId);
      expect(artifacts).toHaveLength(1);
      expect(artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "adapter",
            metadata: expect.objectContaining({
              provider: "sandbox",
              providerFilename: "managed-rl-candidate",
              managedRlCandidate: true,
              managedRlJobId: "managed-provider-job-1",
              managedRlOutputId: "model-artifact-1",
              managedRlTeamId: "team_managed",
            }),
          }),
        ]),
      );
      expect(await store.getTrainingJob(jobId)).toMatchObject({
        status: "succeeded",
        metadata: {
          importedModelLineageId: terminal.adapterArtifactLineageId,
          modelVersionId: prepared.targetVersion.id,
          rolloutProgress: {
            groupsCompleted: 4,
            groupsTarget: 4,
            optimizerUpdatesApplied: 3,
            optimizerUpdatesSkipped: 1,
          },
        },
      });
    }));
});
