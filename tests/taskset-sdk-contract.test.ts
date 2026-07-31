import { describe, expect, test } from "vitest";
import {
  TaskDataRecordSchema,
  TasksetEnvironmentContractSchema,
  TasksetSchema,
} from "../packages/contracts/src";
import { createHash } from "node:crypto";
import { computeTasksetHash, validatePortability, validateTaskset } from "../packages/taskset-sdk/src";
import { tasksetFixture } from "./helpers/training-fixtures";

describe("Taskset SDK contracts", () => {
  test("validates provider-neutral serialized tasks, environments, and hashes", () => {
    const taskset = tasksetFixture();
    expect(validateTaskset(taskset)).toMatchObject({ valid: true, computedHash: taskset.contentHash });
    expect(computeTasksetHash(taskset)).toBe(taskset.contentHash);
    expect(TaskDataRecordSchema.safeParse(taskset.tasks[0]).success).toBe(true);
    expect(TasksetEnvironmentContractSchema.safeParse(taskset.environment).success).toBe(true);
    expect(validatePortability(taskset.capabilities)).toEqual([]);
  });

  test("rejects source-cluster contamination", () => {
    const taskset = tasksetFixture();
    const contaminated = { ...taskset, tasks: taskset.tasks.map((task, index) => ({ ...task, clusterKey: index ? taskset.tasks[0]!.clusterKey : task.clusterKey })) };
    contaminated.contentHash = computeTasksetHash(contaminated);
    expect(validateTaskset(contaminated).issues).toContainEqual(expect.objectContaining({ code: "split_cluster_contamination", severity: "error" }));
  });

  test("validates typed Work assets and required outputs", () => {
    const taskset = tasksetFixture();
    const bytes = Buffer.from("sku,count\nA,2\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const source = {
      ...taskset.sourceRefs[0]!,
      schemaVersion: "openpond.uploadedFileDatasetSource.v1" as const,
      kind: "uploaded_file" as const,
      originalFileNames: ["inventory.csv"],
      mediaTypes: ["text/csv"],
      sourceFileHashes: [sha256],
      totalBytes: bytes.byteLength,
      parserVersion: "fixture-v1",
    };
    const workTaskset = {
      ...taskset,
      sourceRefs: [source, taskset.sourceRefs[1]!],
      environment: {
        ...taskset.environment,
        kind: "work" as const,
        entrypoint: "openpond-work-v1",
        toolNames: [
          "work_environment",
          "work_read_file",
          "work_write_file",
          "work_exec",
          "work_save_output",
          "work_stop",
        ],
      },
      tasks: taskset.tasks.map((task, index) => index === 0
        ? {
            ...task,
            sourceRefs: [source.id],
            assets: [{
              id: "asset_inventory",
              sourceRefId: source.id,
              artifactRef: "assets/inventory.csv",
              fileName: "inventory.csv",
              mediaType: "text/csv",
              sha256,
              sizeBytes: bytes.byteLength,
              split: task.split,
              metadata: {},
            }],
            requiredOutputs: [{
              path: "normalized.json",
              mediaType: "application/json",
              schemaRef: "normalized-inventory-v1",
              maxBytes: 100_000,
              metadata: {},
            }],
          }
        : {
            ...task,
            requiredOutputs: [{
              path: "normalized.json",
              mediaType: "application/json",
              metadata: {},
            }],
          }),
    };
    const parsed = TasksetSchema.parse({
      ...workTaskset,
      contentHash: "00000000",
    });
    parsed.contentHash = computeTasksetHash(parsed);

    const report = validateTaskset(parsed);
    expect(report.issues, JSON.stringify(report.issues, null, 2)).toEqual([]);
    expect(report).toMatchObject({ valid: true });
  });

  test("rejects unsafe or cross-split Work assets", () => {
    expect(TaskDataRecordSchema.safeParse({
      ...tasksetFixture().tasks[0],
      assets: [{
        id: "asset_escape",
        sourceRefId: "source",
        artifactRef: "../escape.csv",
        fileName: "../escape.csv",
        mediaType: "text/csv",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        split: "train",
        metadata: {},
      }],
    }).success).toBe(false);

    const taskset = tasksetFixture();
    const workTaskset = {
      ...taskset,
      environment: {
        ...taskset.environment,
        kind: "work" as const,
        entrypoint: "openpond-work-v1",
      },
      tasks: taskset.tasks.map((task) => ({
        ...task,
        assets: [{
          id: `asset_${task.id}`,
          sourceRefId: task.sourceRefs[0]!,
          artifactRef: `assets/${task.id}.txt`,
          fileName: `${task.id}.txt`,
          mediaType: "text/plain",
          sha256: "a".repeat(64),
          sizeBytes: 1,
          split: task.split === "train" ? "validation" as const : task.split,
          metadata: {},
        }],
        requiredOutputs: [{
          path: "result.json",
          mediaType: "application/json",
          metadata: {},
        }],
      })),
    };
    workTaskset.contentHash = computeTasksetHash(workTaskset);
    expect(validateTaskset(workTaskset).issues).toContainEqual(
      expect.objectContaining({
        code: "work_asset_split_mismatch",
        severity: "error",
      }),
    );
  });
});
