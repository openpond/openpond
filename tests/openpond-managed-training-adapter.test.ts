import {
  ModelRunDraftSchema,
  ResolvedTrainingPlanSchema,
  TasksetSchema,
  TrainingApprovalSchema,
} from "@openpond/contracts";
import { computeTasksetHash, contentHash, sha256 } from "@openpond/taskset-sdk";
import { buildTasksetTrainingBundle, createTrainingPlan } from "@openpond/training-sdk";
import { describe, expect, test, vi } from "vitest";

import { OpenPondManagedTrainingAdapter } from "../apps/server/src/training/openpond-managed-training-adapter.js";
import { publishRunGraph } from "../apps/server/src/training/portable-model-run-service.js";
import { fireworksRftRecipe, rftTasksetFixture } from "./helpers/fireworks-destination-fixtures.js";
import { FIXED_TIME, withTrainingStore } from "./helpers/training-fixtures.js";

const MANAGED_MODEL = {
  id: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
  chatTemplateHash: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
} as const;

describe("OpenPond Managed training adapter", () => {
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
      };
      const taskset = TasksetSchema.parse({
        ...tasksetDraft,
        contentHash: computeTasksetHash(tasksetDraft),
      });
      const recipe = {
        ...fireworksRftRecipe(),
        baseModel: MANAGED_MODEL,
        dataset: {
          ...fireworksRftRecipe().dataset,
          maxPromptTokens: 4_096,
        },
        lora: { rank: 16 },
      };
      const draft = ModelRunDraftSchema.parse({
        schemaVersion: "openpond.modelRunDraft.v1",
        id: "managed-model-run-1",
        profileId: taskset.profileId,
        modelId: "managed-model-project-1",
        status: "ready_to_run",
        title: "Managed GRPO",
        datasetMode: "existing",
        tasksetRef: {
          id: taskset.id,
          revision: taskset.revision,
          contentHash: taskset.contentHash,
        },
        datasetCreationId: null,
        buildIntent: null,
        buildSpecification: null,
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
        runPreset: "small",
        recipe,
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      });
      const trainingPlan = createTrainingPlan({
        modelId: draft.modelId,
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
      await store.saveModelRunDraft(draft);
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
        modelRun: draft,
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
        expect(String(input)).toBe("https://api-new.staging-api.openpond.ai/v1/managed-rl/portable-launches");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-openpond-team-id")).toBe("team-test");
        expect(headers.get("x-vercel-protection-bypass")).toBe(
          "staging-bypass",
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain("lambdalabs");
        expect(serialized).not.toContain("runpod");
        expect(serialized).not.toContain("providerType");
        expect(serialized).not.toContain("cloudId");
        expect(body).toMatchObject({
          schemaVersion: "openpond.managedRlPortableSubmission.v1",
          sourceRunRef: `openpond:model-run:${graph.manifest.id}`,
        });
        expect(body.validationTasks).toEqual(
          taskset.tasks.filter((task) => task.split === "frozen_eval"),
        );
        return new Response(
          JSON.stringify({
            job: {
              id: "managed-job-1",
              state: "admitted",
              version: 1,
              createdAt: FIXED_TIME,
              updatedAt: FIXED_TIME,
            },
            sourceManifestHash: graph.manifest.contentHash,
            resolvedBundleHash: graph.resolvedBundleManifest.contentHash,
            submissionHash: sha256("managed-submission"),
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      });
      const adapter = new OpenPondManagedTrainingAdapter({
        store,
        storeDir: directory,
        fetchImpl: request,
        env: {
          VERCEL_AUTOMATION_BYPASS_SECRET: "staging-bypass",
        },
        resolveAccess: async () => ({
          apiBaseUrl: "https://api-new.staging-api.openpond.ai",
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
      expect(request).toHaveBeenCalledOnce();
    }));

  test("polls logs, cancels, and collects portable artifacts through Sandbox", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const request = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (method === "GET" && url.pathname === "/v1/managed-rl/jobs/managed-job-2") {
          return json({
            job: {
              job: {
                id: "managed-job-2",
                state: "training",
                version: 4,
                completedGroups: 2,
                targetGroups: 8,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
              },
            },
          });
        }
        if (method === "GET" && url.pathname === "/v1/managed-rl/jobs/managed-job-2/logs") {
          expect(url.searchParams.get("cursor")).toBe("1");
          return json({
            cursor: "2",
            entries: [
              {
                timestamp: FIXED_TIME,
                level: "info",
                message: "optimizer step 2",
              },
            ],
          });
        }
        if (method === "POST" && url.pathname === "/v1/managed-rl/jobs/managed-job-2/cancel") {
          expect(JSON.parse(String(init?.body))).toEqual({
            expectedVersion: 4,
          });
          return json({
            job: {
              id: "managed-job-2",
              state: "cancelling",
              version: 5,
              createdAt: FIXED_TIME,
              updatedAt: FIXED_TIME,
            },
          });
        }
        if (method === "GET" && url.pathname === "/v1/managed-rl/jobs/managed-job-2/artifacts") {
          return json({
            candidateBundle: {
              jobId: "managed-job-2",
              artifact: {
                modelArtifactId: "model-artifact-2",
                uri: "r2://managed-rl/jobs/managed-job-2/candidate",
                sha256: "d".repeat(64),
                sizeBytes: 128,
              },
            },
          });
        }
        return new Response("not found", { status: 404 });
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

      await expect(adapter.status(ref)).resolves.toMatchObject({
        state: "running",
        progress: 0.25,
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
