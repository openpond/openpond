import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  TasksetSchema,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { tasksetFixture } from "./helpers/training-fixtures";
import { resolveTasksetWorkAssets } from "../apps/server/src/training/taskset-work-assets";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("Taskset Work assets", () => {
  test("resolves an approved regular file with exact manifest evidence", async () => {
    const fixture = await workFixture();
    const resolved = await resolveTasksetWorkAssets(fixture);

    expect(resolved).toEqual([
      expect.objectContaining({
        assetId: "asset_inventory",
        sourceRefId: "source_inventory",
        artifactRef: "assets/inventory.csv",
        storageName: "inventory.csv",
        mediaType: "text/csv",
        sha256: fixture.task.assets?.[0]?.sha256,
        sizeBytes: fixture.bytes.byteLength,
      }),
    ]);
    expect(resolved[0]?.bytes.equals(fixture.bytes)).toBe(true);
  });

  test("rejects changed bytes before they can be staged", async () => {
    const fixture = await workFixture();
    await writeFile(
      path.join(
        fixture.storeDir,
        "training",
        "tasksets",
        fixture.taskset.id,
        "assets",
        "inventory.csv",
      ),
      "changed",
      "utf8",
    );

    await expect(resolveTasksetWorkAssets(fixture)).rejects.toThrow(
      /size does not match|hash does not match/,
    );
  });

  test("rejects symlinks even when they point inside the Taskset", async () => {
    const fixture = await workFixture();
    const assetDirectory = path.join(
      fixture.storeDir,
      "training",
      "tasksets",
      fixture.taskset.id,
      "assets",
    );
    await rm(path.join(assetDirectory, "inventory.csv"));
    await writeFile(path.join(assetDirectory, "target.csv"), fixture.bytes);
    await symlink("target.csv", path.join(assetDirectory, "inventory.csv"));

    await expect(resolveTasksetWorkAssets(fixture)).rejects.toThrow(
      "regular file",
    );
  });
});

async function workFixture(): Promise<{
  storeDir: string;
  taskset: Taskset;
  task: TaskDataRecord;
  bytes: Buffer;
}> {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-work-assets-"));
  temporaryDirectories.push(storeDir);
  const base = tasksetFixture();
  const bytes = Buffer.from("sku,count\nA,2\n", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const source = {
    schemaVersion: "openpond.uploadedFileDatasetSource.v1" as const,
    id: "source_inventory",
    kind: "uploaded_file" as const,
    profileId: base.profileId,
    title: "Inventory",
    sourceHash: sha256,
    occurredAt: "2026-07-30T00:00:00.000Z",
    licensingStatus: "approved" as const,
    secretScanStatus: "passed" as const,
    piiScanStatus: "passed" as const,
    metadata: {},
    originalFileNames: ["inventory.csv"],
    mediaTypes: ["text/csv"],
    sourceFileHashes: [sha256],
    totalBytes: bytes.byteLength,
    parserVersion: "fixture-v1",
  };
  const task = {
    ...base.tasks[0]!,
    sourceRefs: [source.id],
    assets: [{
      id: "asset_inventory",
      sourceRefId: source.id,
      artifactRef: "assets/inventory.csv",
      fileName: "inventory.csv",
      mediaType: "text/csv",
      sha256,
      sizeBytes: bytes.byteLength,
      split: base.tasks[0]!.split,
      metadata: {},
    }],
    requiredOutputs: [{
      path: "normalized.json",
      mediaType: "application/json",
      metadata: {},
    }],
  };
  const draft = TasksetSchema.parse({
    ...base,
    sourceRefs: [source, base.sourceRefs[1]!],
    environment: {
      ...base.environment,
      kind: "work",
      entrypoint: "openpond-work-v1",
      toolNames: ["work_read_file", "work_write_file", "work_save_output"],
    },
    tasks: [
      task,
      {
        ...base.tasks[1]!,
        requiredOutputs: [{
          path: "normalized.json",
          mediaType: "application/json",
          metadata: {},
        }],
      },
    ],
    contentHash: "00000000",
  });
  const taskset = TasksetSchema.parse({
    ...draft,
    contentHash: computeTasksetHash(draft),
  });
  const assetDirectory = path.join(
    storeDir,
    "training",
    "tasksets",
    taskset.id,
    "assets",
  );
  await mkdir(assetDirectory, { recursive: true });
  await writeFile(path.join(assetDirectory, "inventory.csv"), bytes);
  return {
    storeDir,
    taskset,
    task: taskset.tasks[0]!,
    bytes,
  };
}
