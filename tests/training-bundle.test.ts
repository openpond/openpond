import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatasetArtifactManifestSchema } from "@openpond/contracts";
import { computeTasksetHash, contentHash, sha256 } from "../packages/taskset-sdk/src";
import { buildTrainingBundle, createTrainingBundleExport, unpackTrainingBundleExport, validateTrainingBundle } from "../packages/training-sdk/src";
import { planFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("Training Bundle", () => {
  test("exports only approved transformed demonstrations with inspectable hashes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "training-bundle-"));
    try {
      const taskset = tasksetFixture({ ready: true });
      const manifest = await buildTrainingBundle({ taskset, plan: planFixture(taskset), directory });
      expect(manifest).toMatchObject({ containsRawChats: false, containsSecrets: false, containsHiddenGraderAssets: false, excludedSourceIds: [] });
      const rows = (await readFile(path.join(directory, "data/train.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      expect(rows).toEqual([{ id: "task_train", input: { prompt: "Say hello" }, policyVisibleContext: {}, expectedOutput: { text: "Hello friend" }, tags: ["fixture"] }]);
      expect(JSON.stringify(rows)).not.toContain("Source source_train");
      expect((await validateTrainingBundle(directory)).valid).toBe(true);
      const portable = await createTrainingBundleExport(directory);
      const unpacked = `${directory}-unpacked`;
      await unpackTrainingBundleExport(portable, unpacked);
      expect((await validateTrainingBundle(unpacked)).valid).toBe(true);
      expect(portable.files.every((file) => file.encoding === "base64" && file.content.length > 0)).toBe(true);
      await rm(unpacked, { recursive: true, force: true });
      await writeFile(path.join(directory, "data/train.jsonl"), "tampered\n");
      expect((await validateTrainingBundle(directory)).issues).toContain("data/train.jsonl: hash mismatch");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("binds a projected training file to the exact artifact and selection before bundling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "training-projection-"));
    try {
      const original = tasksetFixture({ ready: true });
      const schemaHash = contentHash("fixture-schema");
      const artifactBody = {
        schemaVersion: "openpond.datasetArtifact.v1",
        id: "artifact_fixture",
        tasksetId: original.id,
        tasksetRevision: original.revision,
        format: "parquet",
        schema: {
          schemaVersion: "openpond.datasetSemanticSchema.v1",
          fields: [{ name: "prompt", semanticRole: "prompt", logicalType: "string", nullable: false, policy: "visible" }],
          schemaHash,
        },
        shards: [{ id: "shard_train", split: "train", path: "train/part.parquet", contentHash: contentHash("fixture-shard"), schemaHash, sizeBytes: 128, rowCount: 2, rowGroupCount: 1 }],
        rowCount: 2,
        splitCounts: { train: 2, validation: 0, test: 0, frozen_eval: 0 },
        sourceReceiptRefs: ["fixture-receipt"],
        mappingHash: contentHash("fixture-mapping"),
        qualityReportHash: contentHash("fixture-quality"),
        createdAt: original.createdAt,
      };
      const artifact = DatasetArtifactManifestSchema.parse({ ...artifactBody, contentHash: contentHash(artifactBody) });
      const taskset = { ...original, datasetArtifact: artifact };
      taskset.contentHash = computeTasksetHash(taskset);
      const plan = planFixture(taskset);
      const projectionPath = path.join(root, "projected.jsonl");
      const contents = '{"id":"task_train","input":{"prompt":"Say hello"},"expectedOutput":{"text":"Hello friend"}}\n';
      await writeFile(projectionPath, contents);
      const projection = {
        path: projectionPath,
        contentHash: sha256(contents),
        sizeBytes: Buffer.byteLength(contents),
        exampleCount: 1,
        eligibleRows: 1,
        selectionSeed: 17,
        selectionStrategy: "stable_hash_top_n" as const,
        taskIdsHash: contentHash(["task_train"]),
        dataset: {
          tasksetId: taskset.id,
          artifactId: artifact.id,
          artifactRevision: artifact.tasksetRevision,
          manifestHash: artifact.contentHash,
          mappingHash: artifact.mappingHash,
          approvedSourceIdsHash: contentHash(plan.dataPolicy.approvedSourceIds),
          split: "train" as const,
          mode: "sft" as const,
          availableRows: 2,
        },
      };
      const directory = path.join(root, "bundle");
      const build = (projectedTrainingData: typeof projection) => buildTrainingBundle({ taskset, plan, directory, projectedTrainingData });
      await expect(build({ ...projection, dataset: { ...projection.dataset, manifestHash: contentHash("a different artifact") } })).rejects.toThrow("pinned Dataset");
      await build(projection);
      const policy = JSON.parse(await readFile(path.join(directory, "policy.json"), "utf8"));
      expect(policy.trainingData).toMatchObject({ dataset: projection.dataset, exampleCount: 1, eligibleRows: 1, selectionSeed: 17 });
      await expect(build({ ...projection, selectionSeed: 18 })).rejects.toThrow("pinned Dataset");
      expect((await validateTrainingBundle(directory)).valid).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
