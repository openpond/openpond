import {
  ModelProjectSchema,
  ResolvedTrainingPlanSchema,
  RftRecipeSchema,
  TasksetSchema,
  TrainingApprovalSchema,
} from "@openpond/contracts";
import { computeTasksetHash, contentHash, sha256 } from "@openpond/taskset-sdk";
import { buildTasksetTrainingBundle, createTrainingPlan } from "@openpond/training-sdk";
import { trainingExecutionReceiptHash } from "openpond-sdk/training";
import { describe, expect, test, vi } from "vitest";

import {
  OpenPondManagedTrainingAdapter,
  continuationResumeFrom,
} from "../apps/server/src/training/openpond-managed-training-adapter.js";
import { publishRunGraph } from "../apps/server/src/training/portable-model-run-service.js";
import { managedRftRecipe, rftTasksetFixture } from "./helpers/managed-training-fixtures.js";
import { FIXED_TIME, withTrainingStore } from "./helpers/training-fixtures.js";

const MANAGED_MODEL = {
  id: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
  chatTemplateHash: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
} as const;

describe("OpenPond Managed training adapter", () => {
  test("projects an explicit cross-Job continuation into resumeFrom", () => {
    const parentArtifact = {
      id: "managed-model-artifact-p1",
      contentHash: "9".repeat(64),
    };
    const recipe = RftRecipeSchema.parse({
      ...managedRftRecipe(),
        continuation: {
          schemaVersion: "openpond.crossJobContinuationRequest.v1",
          parentArtifact,
          sourceArtifact: {
            jobId: "sandbox-job-week-0",
            artifactId: "sandbox-artifact-p1",
            checkpointId: "sandbox-checkpoint-p1",
            contentHash: parentArtifact.contentHash,
          },
          optimizerMode: "continue",
        },
    });
    expect(recipe.continuation).toBeDefined();
    expect(continuationResumeFrom(recipe)).toEqual(parentArtifact);
    expect(
      continuationResumeFrom({
        schemaVersion: "openpond.grpoRecipe.v1",
        method: "grpo",
        parameterization: "lora",
      }),
    ).toBeNull();
  });

  test("cancels a managed Reward Model job with optimistic version protection", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      expect(String(request)).toBe("https://api.openpond.ai/v1/training/jobs/job-rm0/cancel");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 7 });
      return json({ job: publicJob("job-rm0", { state: "cancelling", version: 8 }) });
    });
    const adapter = new OpenPondManagedTrainingAdapter({
      store: {} as never,
      storeDir: "/unused",
      fetchImpl,
      resolveAccess: async () => ({ apiBaseUrl: "https://api.openpond.ai", token: "test-token", teamId: "team-test" }),
    });

    await expect(adapter.cancelRewardModelJob("job-rm0", 7)).resolves.toMatchObject({ job: { state: "cancelling", version: 8 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("uploads a verified portable bundle without choosing a cloud provider", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const baseTaskset = rftTasksetFixture();
      const trainTask = baseTaskset.tasks.find((task) => task.split === "train")!;
      const tasksetDraft = {
        ...baseTaskset,
        capabilities: {
          ...baseTaskset.capabilities,
          taskKind: "chat" as const,
          rewardKinds: ["exact" as const],
          requiresTools: false,
          requiresState: false,
          requiresPrivilegedGrading: false,
          environmentPlacements: ["remote" as const],
        },
        environment: {
          ...baseTaskset.environment,
          kind: "chat" as const,
          entrypoint: "openpond/exact-text",
          stateful: false,
          toolNames: [],
          actionBindings: [],
        },
        tasks: [
          ...baseTaskset.tasks,
          {
            ...trainTask,
            id: `${trainTask.id}-second`,
            clusterKey: `${trainTask.clusterKey}-second`,
          },
        ],
        metadata: {
          ...baseTaskset.metadata,
          harnessEvaluationReview: {
            id: "optional-evaluation-review",
            contentHash: sha256("optional-evaluation-review"),
          },
        },
      };
      const taskset = TasksetSchema.parse({
        ...tasksetDraft,
        contentHash: computeTasksetHash(tasksetDraft),
      });
      const recipe = {
        ...managedRftRecipe(),
        baseModel: MANAGED_MODEL,
        dataset: {
          ...managedRftRecipe().dataset,
          maxPromptTokens: 4_096,
        },
        lora: { rank: 16 },
      };
      const modelRunId = "managed-model-run-1";
      const modelProject = ModelProjectSchema.parse({
        schemaVersion: "openpond.modelProject.v2",
        id: "managed-model-project-1",
        profileId: taskset.profileId,
        revision: 1,
        name: "Managed GRPO",
        objective: "Verify managed V2 submission.",
        defaultBaseModel: null,
        defaultDestinationId: "openpond_managed",
        trainingSetup: {
          tasksetRef: {
            id: taskset.id,
            revision: taskset.revision,
            contentHash: taskset.contentHash,
          },
          tasksetRelease: {
            id: "taskset-release-fixture",
            contentHash: sha256(taskset.contentHash),
          },
          harnessRelease: {
            id: "harness-release-fixture",
            contentHash: sha256("harness-release-fixture"),
          },
          baseModel: {
            schemaVersion: "openpond.baseModelPreference.v1",
            modelId: MANAGED_MODEL.id,
            revision: MANAGED_MODEL.revision,
            tokenizerRevision: MANAGED_MODEL.tokenizerRevision,
            chatTemplateHash: MANAGED_MODEL.chatTemplateHash,
            modelAssetId: null,
            source: "managed",
          },
          method: "grpo",
          destinationId: "openpond_managed",
          managedRolloutPlacement: "remote",
          managedGpuPlacementObjective: "fast",
          runPreset: "small",
          recipe,
          preferredMaximumSpendUsd: 9,
          preferredRetentionDays: null,
        },
        hosted: null,
        tasksetSyncs: [],
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      });
      const trainingPlan = createTrainingPlan({
        modelId: modelProject.id,
        taskset,
        destinationId: "openpond_managed",
        recipe,
        environmentPlacement: "remote",
        exportApproved: true,
      });
      const approval = TrainingApprovalSchema.parse({
        schemaVersion: "openpond.trainingApproval.v1",
        id: "approval-managed-1",
        planId: trainingPlan.id,
        bundleHash: sha256("managed-bundle"),
        destinationId: "openpond_managed",
        modelId: MANAGED_MODEL.id,
        method: "grpo",
        parameterization: "lora",
        maximumCostUsd: 9,
        approvedBy: "test-user",
        approvedAt: FIXED_TIME,
      });
      await store.upsertTaskset(taskset);
      await store.saveModelProject(modelProject);
      await store.saveTrainingPlan(trainingPlan);
      await store.saveTrainingApproval(approval);
      const capabilityReceipt = sha256("managed-capability");
      const runtime = {
        adapterId: "openpond-managed-harness",
        placement: "remote" as const,
        capabilityReceipt,
        runtimeVersion: "1",
        dataPlane: null,
      };
      const compute = {
        adapterId: "openpond-managed",
        kind: "managed" as const,
        deviceOrPool: "openpond-managed",
        capabilityReceipt,
        provider: "openpond",
      };
      const engine = {
        adapterId: "sandbox-managed-rl",
        workerVersion: "managed-rl-v2",
        workerImageDigest: null,
        upstreamRevision: "e0d60e4d85ea636873acb2e7083e794740d20226",
        capabilityReceipt,
      };
      const graph = buildTasksetTrainingBundle({
        taskset,
        modelProject,
        modelRunId,
        runtime,
        compute,
        engine,
        approval: {
          approvalHash: contentHash(approval),
          approvedAt: approval.approvedAt,
          maximumSpendUsd: approval.maximumCostUsd,
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
      await publishRunGraph({
        storeDir: directory,
        graph,
      });
      const base = {
        schemaVersion: "openpond.resolvedTrainingPlan.v1" as const,
        manifest: graph.manifest,
        recipe,
        runtime,
        compute,
        engine,
        execution: {
          trainingPlanId: trainingPlan.id,
          approvalId: approval.id,
        },
        maximumSpendUsd: approval.maximumCostUsd,
        approvalHash: contentHash(approval),
      };
      const resolvedPlan = ResolvedTrainingPlanSchema.parse({
        ...base,
        contentHash: contentHash(base),
      });
      const request = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        expect(headers.get("x-openpond-team-id")).toBe("team-test");
        if (url.pathname === "/v1/training/capabilities") {
          return json({ capabilities: trainingCapabilities() });
        }
        if (url.pathname === `/v1/model-projects/${modelProject.id}`) {
          expect(init?.method).toBe("PUT");
          return json({
            project: {
              id: "hosted-project-1",
              teamId: "team-test",
              portableProjectId: modelProject.id,
              name: modelProject.name,
              objective: modelProject.objective,
              defaultBaseModel: modelProject.defaultBaseModel,
              defaultDestinationId: modelProject.defaultDestinationId,
              trainingSetup: modelProject.trainingSetup,
              sourceRevision: modelProject.revision,
              sourceUpdatedAt: modelProject.updatedAt,
              revision: 1,
              etag: "e".repeat(64),
              createdAt: FIXED_TIME,
              updatedAt: FIXED_TIME,
            },
          });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain("lambdalabs");
        expect(serialized).not.toContain("runpod");
        expect(serialized).not.toContain("providerType");
        expect(serialized).not.toContain("cloudId");
        if (url.pathname === "/v1/training/artifacts") {
          expect(body).toMatchObject({
            schemaVersion: "openpond.trainingInputArtifactUpload.v2",
            kind: "portable_training_bundle",
            sourceManifest: { id: graph.manifest.id, contentHash: graph.manifest.contentHash },
            payload: {
              schemaVersion: "openpond.managedRlPortableSubmission.v1",
              sourceRunRef: `openpond:model-run:${graph.manifest.id}`,
              validationTasks: taskset.tasks.filter((task) => task.split === "frozen_eval"),
            },
          });
          return json({
            artifact: {
              schemaVersion: "openpond.trainingInputArtifact.v2",
              kind: "portable_training_bundle",
              sourceManifest: { id: graph.manifest.id, contentHash: graph.manifest.contentHash },
              artifactRef: "r2://managed-rl/portable/submission",
              contentHash: body.contentHash,
              sizeBytes: 1_024,
              createdAt: FIXED_TIME,
            },
          }, 201);
        }
        if (url.pathname === "/v1/training/jobs") {
          expect(body).toMatchObject({
            schemaVersion: "openpond.trainingJobSubmission.v2",
            placementObjective: "fast",
            source: { modelProject: { id: "hosted-project-1", portableProjectId: modelProject.id } },
            job: { kind: "policy_optimize" },
          });
          return json({ job: publicJob("managed-job-1") }, 201);
        }
        return json({ error: "not_found" }, 404);
      });
      const adapter = new OpenPondManagedTrainingAdapter({
        store,
        storeDir: directory,
        fetchImpl: request,
        env: {
        },
        resolveAccess: async () => ({
          apiBaseUrl: "https://api.openpond.ai",
          token: "opk_test",
          teamId: "team-test",
        }),
      });

      await expect(adapter.validate(resolvedPlan)).resolves.toMatchObject({
        valid: true,
      });
      await expect(adapter.launch(resolvedPlan)).resolves.toMatchObject({
        runId: "managed-job-1",
        adapterId: "sandbox-managed-rl",
        tenantId: "team-test",
        manifestHash: graph.manifest.contentHash,
      });
      expect(request).toHaveBeenCalledTimes(5);
    }));

  test("polls logs, cancels, and collects portable artifacts through Sandbox", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const request = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (method === "GET" && url.pathname === "/v1/training/jobs/managed-job-2") {
          return json({ job: publicJob("managed-job-2", { state: "running", version: 4, progress: 0.25 }) });
        }
        if (method === "GET" && url.pathname === "/v1/training/jobs/managed-job-2/logs") {
          return json({
            logs: [
              {
                schemaVersion: "openpond.trainingJobLog.v2",
                jobId: "managed-job-2",
                sequence: 1,
                level: "info",
                message: "optimizer step 2",
                createdAt: FIXED_TIME,
              },
            ],
          });
        }
        if (method === "GET" && url.pathname === "/v1/training/jobs/managed-job-2/events") {
          return json({
            events: [
              {
                schemaVersion: "openpond.trainingJobEvent.v2",
                id: "remote-score-event",
                jobId: "managed-job-2",
                sequence: 0,
                type: "score_reward_model",
                phase: "succeeded",
                message: null,
                data: { errorCode: null },
                createdAt: FIXED_TIME,
              },
              {
                schemaVersion: "openpond.trainingJobEvent.v2",
                id: "remote-rollout-event",
                jobId: "managed-job-2",
                sequence: 1,
                type: "rollout_metric",
                phase: "eligible",
                message: null,
                data: {
                  metricKind: "rollout_trajectory",
                  rolloutGroupId: "group-1",
                  rolloutGroupIndex: 0,
                  rolloutIndex: 0,
                  workerSlot: 0,
                  policyVersion: 0,
                  reward: 0.75,
                  rewardEligible: true,
                  terminalClass: "policy",
                  inputTokens: 10,
                  outputTokens: 2,
                },
                createdAt: FIXED_TIME,
              },
              {
                schemaVersion: "openpond.trainingJobEvent.v2",
                id: "optimizer-event-2",
                jobId: "managed-job-2",
                sequence: 2,
                type: "optimizer_metric",
                phase: "committed",
                message: null,
                data: {
                  schemaVersion: "openpond.policyOptimizationMetric.v1",
                  metricKind: "policy_optimization",
                  method: "grpo",
                  step: 2,
                  timestamp: FIXED_TIME,
                  learningRate: null,
                  policyLoss: 0.2,
                  valueLoss: null,
                  meanReward: 0.75,
                  meanReturn: 0.7,
                  kl: 0.01,
                  entropy: null,
                  policyClipFraction: 0.1,
                  valueClipFraction: null,
                  explainedVariance: null,
                  rolloutLearnerLag: 0,
                  inputTokens: 100,
                  outputTokens: 25,
                  environmentExecutions: 4,
                  costUsd: null,
                },
                createdAt: FIXED_TIME,
              },
            ],
          });
        }
        if (method === "POST" && url.pathname === "/v1/training/jobs/managed-job-2/cancel") {
          expect(JSON.parse(String(init?.body))).toEqual({
            expectedVersion: 4,
          });
          return json({ job: publicJob("managed-job-2", { state: "cancelling", version: 5, progress: 0.25 }) });
        }
        if (method === "GET" && url.pathname === "/v1/training/jobs/managed-job-2/outputs") {
          const receipt = trainingReceipt();
          return json({
            schemaVersion: "openpond.trainingJobOutputs.v2",
            outputs: [
              trainingOutput("model-artifact-2", "adapter", "d".repeat(64), 128),
              trainingOutput(
                `${receipt.id}:output`,
                "receipt",
                await trainingExecutionReceiptHash(receipt),
                512,
              ),
            ],
            receipt,
          });
        }
        return json({ error: "not_found" }, 404);
      });
      const adapter = new OpenPondManagedTrainingAdapter({
        store,
        storeDir: directory,
        fetchImpl: request,
        resolveAccess: async () => ({
          apiBaseUrl: "https://api.example.test",
          token: "opk_test",
          teamId: "team-test",
        }),
      });
      const ref = {
        runId: "managed-job-2",
        adapterId: "sandbox-managed-rl",
        providerJobId: "managed-job-2",
        tenantId: "team-test",
        leaseId: null,
        manifestHash: "a".repeat(64),
        inputBundleHash: "b".repeat(64),
        createdAt: FIXED_TIME,
      };
      await store.saveTrainingJob({
        schemaVersion: "openpond.trainingJob.v1",
        id: ref.runId,
        planId: "plan-managed-job-2",
        bundleHash: "a".repeat(64),
        approvalId: "approval-managed-job-2",
        destinationId: "openpond_managed",
        status: "running",
        nonProduction: false,
        workerPid: null,
        startedAt: FIXED_TIME,
        completedAt: null,
        error: null,
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
        metadata: {},
      });
      await store.saveTrainingJobEvent({
        schemaVersion: "openpond.trainingJobEvent.v1",
        id: "local-start-event",
        jobId: ref.runId,
        sequence: 2,
        type: "start",
        timestamp: FIXED_TIME,
        payload: {},
      });
      await store.saveTrainingJobEvent({
        schemaVersion: "openpond.trainingJobEvent.v1",
        id: "remote-rollout-event",
        jobId: ref.runId,
        sequence: 1_000_000,
        type: "metric",
        timestamp: FIXED_TIME,
        payload: { metricKind: "rollout_trajectory", reward: null },
      });
      await store.saveTrainingJobEvent({
        schemaVersion: "openpond.trainingJobEvent.v1",
        id: "remote-score-event",
        jobId: ref.runId,
        sequence: 1_000_001,
        type: "progress",
        timestamp: FIXED_TIME,
        payload: { remoteEventType: "score_reward_model" },
      });

      await expect(adapter.status(ref)).resolves.toMatchObject({
        state: "running",
        progress: 0.25,
        rolloutProgress: {
          groupsCompleted: 4,
          groupsTarget: 16,
          optimizerUpdatesApplied: 4,
          optimizerUpdatesSkipped: 0,
        },
      });
      await expect(adapter.rewardModelJob(ref.runId)).resolves.toMatchObject({
        job: { id: "managed-job-2", state: "running" },
        resources: [],
      });
      await expect(adapter.logs(ref, "1")).resolves.toEqual({
        cursor: "2",
        entries: [
          {
            timestamp: FIXED_TIME,
            level: "info",
            message: "optimizer step 2",
          },
        ],
      });
      await adapter.refreshEvidence(ref);
      await expect(store.listTrainingJobEvents(ref.runId)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "local-start-event", sequence: 2 }),
          expect.objectContaining({
            id: "optimizer-event-2",
            sequence: 1_000_002,
            type: "metric",
            payload: expect.objectContaining({
              metricKind: "policy_optimization",
              meanReward: 0.75,
              remotePhase: "committed",
            }),
          }),
          expect.objectContaining({
            id: "remote-rollout-event",
            sequence: 1_000_000,
            payload: expect.objectContaining({ reward: 0.75 }),
          }),
        ]),
      );
      expect(
        request.mock.calls.filter(([input]) =>
          new URL(String(input)).pathname.endsWith("/logs"),
        ),
      ).toHaveLength(1);
      expect(
        request.mock.calls.filter(([input]) =>
          new URL(String(input)).pathname.endsWith("/events"),
        ),
      ).toHaveLength(1);
      const terminalJob = await store.getTrainingJob(ref.runId);
      expect(terminalJob).not.toBeNull();
      await store.saveTrainingJob({
        ...terminalJob!,
        status: "failed",
        completedAt: FIXED_TIME,
        error: "test terminal failure",
      });
      await adapter.refreshEvidence(ref);
      expect(
        request.mock.calls.filter(([input]) =>
          new URL(String(input)).pathname.endsWith("/events"),
        ),
      ).toHaveLength(2);
      await adapter.refreshEvidence(ref);
      expect(
        request.mock.calls.filter(([input]) =>
          new URL(String(input)).pathname.endsWith("/events"),
        ),
      ).toHaveLength(2);
      await expect(adapter.cancel(ref)).resolves.toBeUndefined();
      await expect(adapter.collect(ref)).resolves.toMatchObject({
        runId: "managed-job-2",
        manifestHash: "a".repeat(64),
        artifacts: [
          {
            kind: "adapter",
            objectRef: "sandbox-managed-rl://managed-job-2/model-artifact-2",
            sha256: "d".repeat(64),
            sizeBytes: 128,
          },
          expect.objectContaining({ kind: "receipt" }),
        ],
      });
    }));
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function trainingCapabilities() {
  return {
    schemaVersion: "openpond.trainingCapabilities.v2" as const,
    capabilityHash: "f".repeat(64),
    jobKinds: ["reward_model_train", "policy_optimize"] as const,
    methods: ["reward_model", "grpo"],
    placements: ["local", "remote"] as const,
    controls: { cancel: true, stopAfterGroup: true, resumeFromCheckpoint: false },
    limits: {
      maximumSpendUsd: 9.99,
      maximumWallSeconds: 10_800,
      maximumArtifactBytes: 512 * 1024 * 1024,
    },
    checkedAt: FIXED_TIME,
    expiresAt: "2027-07-12T00:00:00.000Z",
  };
}

function publicJob(
  id: string,
  overrides: Partial<{
    state: "queued" | "admitting" | "provisioning" | "running" | "stopping" | "cancelling" | "succeeded" | "failed" | "cancelled";
    version: number;
    progress: number;
  }> = {},
) {
  return {
    schemaVersion: "openpond.trainingJob.v2" as const,
    id,
    teamId: "team-test",
    kind: "policy_optimize" as const,
    modelProjectId: "hosted-project-1",
    portableProjectId: "managed-model-project-1",
    sourceProjectRevision: 1,
    submissionHash: "b".repeat(64),
    state: overrides.state ?? "queued",
    phase: overrides.state ?? "queued",
    version: overrides.version ?? 1,
    progress: overrides.progress ?? 0,
    rolloutProgress: {
      groupsCompleted: Math.floor((overrides.progress ?? 0) * 16),
      groupsTarget: 16,
      optimizerUpdatesApplied: Math.floor((overrides.progress ?? 0) * 16),
      optimizerUpdatesSkipped: 0,
    },
    accruedSpendUsd: 0,
    terminalReason: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    completedAt: null,
  };
}

function trainingReceipt() {
  return {
    schemaVersion: "openpond.trainingExecutionReceipt.v2" as const,
    id: "training-receipt-managed-job-2",
    teamId: "team-test",
    jobId: "managed-job-2",
    submissionHash: "b".repeat(64),
    manifestHash: "a".repeat(64),
    recipeHash: "c".repeat(64),
    capabilityHash: "f".repeat(64),
    runtimeRelease: { id: "worker-runtime", contentHash: "e".repeat(64) },
    inputs: [],
    outputs: [{ id: "model-artifact-2", contentHash: "d".repeat(64) }],
    spendUsd: 0.1,
    durationSeconds: 60,
    cleanupComplete: true,
    issuer: "sandbox.openpond.ai",
    issuedAt: FIXED_TIME,
    signature: null,
  };
}

function trainingOutput(
  id: string,
  kind: "adapter" | "receipt",
  contentHashValue: string,
  sizeBytes: number,
) {
  return {
    schemaVersion: "openpond.trainingJobOutput.v2" as const,
    id,
    jobId: "managed-job-2",
    kind,
    artifactRef: `r2://managed-rl/jobs/managed-job-2/${id}`,
    contentHash: contentHashValue,
    sizeBytes,
    metadata: {},
    createdAt: FIXED_TIME,
  };
}
