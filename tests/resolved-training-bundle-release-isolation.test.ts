import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ModelRunDraftSchema } from "@openpond/contracts";
import { describe, expect, test } from "vitest";

import {
  buildTasksetTrainingBundle,
  materializeResolvedTrainingBundle,
} from "../packages/training-sdk/src/index.js";
import { sha256 } from "../packages/taskset-sdk/src/index.js";
import {
  FIXED_TIME,
  sftRecipeFixture,
  tasksetFixture,
} from "./helpers/training-fixtures.js";

describe("resolved training bundle release isolation", () => {
  test("rejects mutable Taskset bytes that no longer match the selected authoring hash", async () => {
    const taskset = tasksetFixture({ ready: true });
    const recipe = sftRecipeFixture();
    const modelRun = ModelRunDraftSchema.parse({
      schemaVersion: "openpond.modelRunDraft.v1",
      id: "model-run-release-isolation",
      profileId: taskset.profileId,
      modelId: "model-release-isolation",
      status: "ready_to_run",
      title: "Release isolation",
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
        modelId: recipe.baseModel.id,
        revision: recipe.baseModel.revision,
        tokenizerRevision: recipe.baseModel.tokenizerRevision,
        chatTemplateHash: sha256("release-isolation-chat-template"),
        modelAssetId: null,
        source: "local",
      },
      method: "sft",
      destinationId: "openpond_managed",
      runPreset: "small",
      recipe,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    const capabilityReceipt = sha256("release-isolation-capability");
    const build = (selectedTaskset: typeof taskset) =>
      buildTasksetTrainingBundle({
        taskset: selectedTaskset,
        modelRun,
        runtime: {
          adapterId: "local-harness",
          placement: "local",
          capabilityReceipt,
          runtimeVersion: "1",
          dataPlane: null,
        },
        compute: {
          adapterId: "openpond-managed",
          kind: "local",
          deviceOrPool: "cpu",
          capabilityReceipt,
          provider: null,
        },
        engine: {
          adapterId: "local-training-worker",
          workerVersion: "1",
          workerImageDigest: null,
          upstreamRevision: "fixture",
          capabilityReceipt,
        },
        approval: {
          approvalHash: sha256("release-isolation-approval"),
          approvedAt: FIXED_TIME,
          maximumSpendUsd: 0,
        },
        openpondRelease: "0.0.38",
        workerProtocol: "openpond.localTrainingWorker.v1",
        harnessRelease: {
          id: "harness-release-isolation",
          contentHash: sha256("harness-release-isolation"),
        },
        tasksetRelease: {
          id: "taskset-release-isolation",
          contentHash: sha256(taskset.contentHash),
        },
      });

    const released = build(taskset);
    expect(released.manifest.harnessRelease.id).toBe(
      "harness-release-isolation",
    );

    const cacheRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-release-isolation-"),
    );
    try {
      const materialized = await materializeResolvedTrainingBundle({
        manifest: released.resolvedBundleManifest,
        assets: released.assets,
        cacheRoot,
      });
      taskset.tasks[0]!.input = {
        prompt: "The mutable source changed after materialization.",
      };
      const trainingDataset = JSON.parse(
        await readFile(
          path.join(materialized.directory, "dataset", "train.json"),
          "utf8",
        ),
      ) as { tasks: Array<{ input: { prompt?: string } }> };
      expect(trainingDataset.tasks[0]?.input.prompt).toBe("Say hello");

      const datasetPath = path.join(
        materialized.directory,
        "dataset",
        "train.json",
      );
      await writeFile(datasetPath, "tampered", "utf8");
      await expect(
        materializeResolvedTrainingBundle({
          manifest: released.resolvedBundleManifest,
          assets: released.assets,
          cacheRoot,
        }),
      ).rejects.toThrow(/asset dataset\/train\.json changed/i);

      await rm(materialized.directory, { recursive: true, force: true });
      await expect(
        materializeResolvedTrainingBundle({
          manifest: released.resolvedBundleManifest,
          assets: new Map(),
          cacheRoot,
        }),
      ).rejects.toThrow(/asset .* failed verification/i);
      expect(
        (await readdir(cacheRoot)).filter((entry) =>
          entry.startsWith(".materializing-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }

    const mutated = tasksetFixture({ ready: true });
    mutated.tasks[0]!.input = { prompt: "This source changed after release." };
    expect(mutated.contentHash).toBe(taskset.contentHash);
    expect(() => build(mutated)).toThrow(
      "Taskset authoring state changed after its release was selected.",
    );
  });
});
