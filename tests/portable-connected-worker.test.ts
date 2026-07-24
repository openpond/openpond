import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ResolvedTrainingPlan } from "@openpond/contracts";
import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { resolveLocalConnectedWorkerBundle } from "../apps/server/src/training/portable-connected-worker.js";
import { createManifestFixture } from "./helpers/portable-training-fixtures.js";
import { sftRecipeFixture } from "./helpers/training-fixtures.js";

describe("portable connected worker bundle resolution", () => {
  test("returns only a verified directory bound to the resolved plan", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-connected-bundle-"),
    );
    try {
      const bytes = Buffer.from("asset", "utf8");
      const bundleBase = {
        schemaVersion: "openpond.resolvedTrainingBundle.v1" as const,
        projection: "trainer" as const,
        harnessRelease: {
          id: "harness-release",
          contentHash: sha256("harness"),
        },
        datasetRelease: {
          id: "dataset-release",
          contentHash: sha256("dataset"),
        },
        evidenceSetRelease: null,
        files: [
          {
            path: "asset.json",
            sha256: sha256(bytes),
            sizeBytes: bytes.byteLength,
          },
        ],
      };
      const bundle = {
        ...bundleBase,
        contentHash: contentHash(bundleBase),
      };
      const directory = path.join(
        storeDir,
        "training",
        "portable-releases",
        "resolved-bundles",
        bundle.contentHash,
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "bundle-manifest.json"),
        canonicalJson(bundle),
      );
      await writeFile(path.join(directory, "asset.json"), bytes);
      const recipe = sftRecipeFixture();
      const manifest = createManifestFixture({
        method: recipe.method,
        recipeConfigHash: contentHash(recipe),
        resolvedBundleHash: bundle.contentHash,
      });
      const planBase = {
        schemaVersion: "openpond.resolvedTrainingPlan.v1" as const,
        manifest,
        recipe,
        runtime: manifest.runtimeTarget,
        compute: manifest.computeTarget,
        engine: manifest.engine,
        maximumSpendUsd: manifest.approval.maximumSpendUsd,
        approvalHash: manifest.approval.approvalHash,
      };
      const plan: ResolvedTrainingPlan = {
        ...planBase,
        contentHash: contentHash(planBase),
      };
      const descriptor = await resolveLocalConnectedWorkerBundle({
        storeDir,
        plan,
      });
      expect(descriptor.bundleContentHash).toBe(bundle.contentHash);
      expect(descriptor.sha256).toBe(bundle.contentHash);
      expect(descriptor.objectRef).toMatch(/^file:/);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
