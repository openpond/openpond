import { ModelRunDraftSchema, TasksetSchema } from "@openpond/contracts";
import {
  ContentAddressedReleaseStore,
  publishTasksetTrainingGraph,
} from "@openpond/training-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeTasksetHash, contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

import {
  FIXED_TIME,
  sftRecipeFixture,
  tasksetFixture,
} from "./helpers/training-fixtures.js";

describe("Taskset portable release publication", () => {
  it("publishes separate immutable Harness, Dataset, Evidence, and Run identities", async () => {
    const baseTaskset = tasksetFixture({ ready: true });
    const agentInputSchema = {
      type: "object",
      additionalProperties: false,
      properties: { campaignId: { type: "string" } },
      required: ["campaignId"],
    };
    const tasksetDraft = TasksetSchema.parse({
      ...baseTaskset,
      status: "needs_review",
      readiness: null,
      environment: {
        ...baseTaskset.environment,
        toolNames: ["agent_review_campaign"],
        actionBindings: [
          {
            schemaVersion: "openpond.harnessActionBinding.v1",
            actionId: "profile.cmo.review-campaign",
            modelToolName: "agent_review_campaign",
            description:
              "Review campaign metrics and recommend the next action.",
            inputSchema: agentInputSchema,
            actionSchemaHash: contentHash(agentInputSchema),
            agentRelease: {
              id: "agent_cmo_r1",
              contentHash: sha256("agent-cmo-release"),
            },
            implementationHash: sha256("agent-cmo-implementation"),
            runtimeBindingId: "profile-action-runtime",
            capabilityReceiptHash: sha256("profile-action-capability"),
            sideEffect: "read",
            studentVisible: true,
            timeoutMs: 120_000,
          },
        ],
      },
      contentHash: "00000000",
    });
    const taskset = TasksetSchema.parse({
      ...tasksetDraft,
      contentHash: computeTasksetHash(tasksetDraft),
    });
    const modelRun = ModelRunDraftSchema.parse({
      schemaVersion: "openpond.modelRunDraft.v1",
      id: "model-run-portable-1",
      profileId: taskset.profileId,
      modelId: "model-project-1",
      status: "ready_to_run",
      title: "Portable fixture",
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
        modelId: "openpond/tiny-cpu-gpt2-fixture",
        revision: "architecture-v2-seed-17-context-512",
        tokenizerRevision: "wordlevel-v1",
        chatTemplateHash: sha256("fixture-chat-template"),
        modelAssetId: null,
        source: "builtin",
      },
      method: "sft",
      destinationId: "local_cpu_fixture",
      runPreset: "small",
      recipe: sftRecipeFixture(),
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    const capabilityReceipt = sha256("local-capability");
    const graph = publishTasksetTrainingGraph({
      taskset,
      modelRun,
      runtime: {
        adapterId: "local-harness",
        placement: "local",
        capabilityReceipt,
        runtimeVersion: "1",
        dataPlane: null,
      },
      compute: {
        adapterId: "local-compute",
        kind: "local",
        deviceOrPool: "cpu",
        capabilityReceipt,
        provider: null,
      },
      engine: {
        adapterId: "local-trl",
        workerVersion: "0.0.1",
        workerImageDigest: null,
        upstreamRevision: "trl-0.26.2",
        capabilityReceipt,
      },
      approval: {
        approvalHash: contentHash({ modelRunId: modelRun.id, maximum: 0 }),
        approvedAt: FIXED_TIME,
        maximumSpendUsd: 0,
      },
      openpondRelease: "0.0.38",
      workerProtocol: "openpond.connectedWorker.v1",
    });

    expect(graph.manifest.harnessRelease.contentHash).toBe(
      graph.harnessRelease.contentHash
    );
    expect(graph.manifest.datasetRelease.contentHash).not.toBe(
      graph.harnessRelease.contentHash
    );
    expect(graph.manifest.datasetRelease.contentHash).toBe(
      graph.datasetRelease.contentHash
    );
    expect(graph.evidenceSetRelease.signals).toHaveLength(1);
    expect(graph.harnessRelease.actionBindings).toEqual(
      taskset.environment.actionBindings
    );
    expect(
      JSON.parse(
        new TextDecoder().decode(graph.assets.get("tool-contract.json"))
      )
    ).toEqual(
      expect.objectContaining({
        toolNames: ["agent_review_campaign"],
        actionBindings: taskset.environment.actionBindings,
      })
    );
    expect(
      graph.harnessRelease.assets
        .filter((asset) => asset.visibility === "privileged")
        .every((asset) => !asset.projections.includes("student"))
    ).toBe(true);
    expect(graph.manifest.contentHash).toHaveLength(64);
    expect(graph.manifest.resolvedBundleHash).toBe(
      graph.resolvedBundleManifest.contentHash
    );
    expect(graph.resolvedBundleManifest.projection).toBe("trainer");
    expect(graph.resolvedBundleManifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "dataset/train.json",
        "environment.json",
        "tool-contract.json",
        "evidence/evidence-set-release.json",
      ])
    );
    const laterModelRun = ModelRunDraftSchema.parse({
      ...modelRun,
      id: "model-run-portable-2",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const replay = publishTasksetTrainingGraph({
      taskset,
      modelRun: laterModelRun,
      runtime: graph.manifest.runtimeTarget,
      compute: graph.manifest.computeTarget,
      engine: graph.manifest.engine,
      approval: {
        approvalHash: contentHash({
          modelRunId: laterModelRun.id,
          maximum: 0,
        }),
        approvedAt: laterModelRun.updatedAt,
        maximumSpendUsd: 0,
      },
      openpondRelease: "0.0.38",
      workerProtocol: "openpond.connectedWorker.v1",
    });
    expect(replay.harnessRelease).toEqual(graph.harnessRelease);
    expect(replay.datasetRelease).toEqual(graph.datasetRelease);
    expect(replay.evidenceSetRelease).toEqual(graph.evidenceSetRelease);
    expect(replay.resolvedBundleManifest).toEqual(graph.resolvedBundleManifest);
    expect(replay.manifest.contentHash).not.toBe(graph.manifest.contentHash);
    expect(
      graph.resolvedBundleManifest.files.map((file) => file.path)
    ).not.toEqual(
      expect.arrayContaining(["dataset/frozen-eval.json", "graders.json"])
    );
    const storeRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-dataset-release-")
    );
    try {
      const store = new ContentAddressedReleaseStore(storeRoot);
      await store.publishDatasetRelease({
        release: graph.datasetRelease,
        readAsset: async (asset) => graph.assets.get(asset.path)!,
      });
      expect(
        await store.readDatasetRelease({
          id: graph.datasetRelease.id,
          revision: graph.datasetRelease.revision,
          contentHash: graph.datasetRelease.contentHash,
        })
      ).toEqual(graph.datasetRelease);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("omits the Evidence Set release when online training has no frozen signals", () => {
    const base = tasksetFixture({ ready: true });
    const draft = TasksetSchema.parse({
      ...base,
      status: "needs_review",
      readiness: null,
      learningSignals: {
        demonstrations: [],
        preferences: [],
        corrections: [],
        feedback: [],
        rewards: [],
        labels: [],
      },
      contentHash: "00000000",
    });
    const taskset = TasksetSchema.parse({
      ...draft,
      contentHash: computeTasksetHash(draft),
    });
    const modelRun = ModelRunDraftSchema.parse({
      schemaVersion: "openpond.modelRunDraft.v1",
      id: "model-run-online-no-evidence",
      profileId: taskset.profileId,
      modelId: "model-project-1",
      status: "ready_to_run",
      title: "No offline evidence fixture",
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
        modelId: "openpond/tiny-cpu-gpt2-fixture",
        revision: "architecture-v2-seed-17-context-512",
        tokenizerRevision: "wordlevel-v1",
        chatTemplateHash: sha256("fixture-chat-template"),
        modelAssetId: null,
        source: "builtin",
      },
      method: "sft",
      destinationId: "local_cpu_fixture",
      runPreset: "small",
      recipe: sftRecipeFixture(),
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    const capabilityReceipt = sha256("local-capability");
    const graph = publishTasksetTrainingGraph({
      taskset,
      modelRun,
      runtime: {
        adapterId: "local-harness",
        placement: "local",
        capabilityReceipt,
        runtimeVersion: "1",
        dataPlane: null,
      },
      compute: {
        adapterId: "local-compute",
        kind: "local",
        deviceOrPool: "cpu",
        capabilityReceipt,
        provider: null,
      },
      engine: {
        adapterId: "local-trl",
        workerVersion: "0.0.1",
        workerImageDigest: null,
        upstreamRevision: "trl-0.26.2",
        capabilityReceipt,
      },
      approval: {
        approvalHash: contentHash({ modelRunId: modelRun.id, maximum: 0 }),
        approvedAt: FIXED_TIME,
        maximumSpendUsd: 0,
      },
      openpondRelease: "0.0.38",
      workerProtocol: "openpond.connectedWorker.v1",
    });

    expect(graph.evidenceSetRelease).toBeNull();
    expect(graph.manifest.evidenceSets).toEqual([]);
  });
});
