import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  isTrainingSourceRef,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import type { WorkRuntimeInput } from "../openpond/work-runtime-service.js";

const DEFAULT_MAX_WORK_INPUT_BYTES = 250_000_000;
const MAX_WORK_INPUT_BYTES = 1_000_000_000;

export type ResolvedTasksetWorkAsset = WorkRuntimeInput & {
  assetId: string;
  sourceRefId: string;
  mediaType: string;
  artifactRef: string;
  storageName: string;
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
};

export async function resolveTasksetWorkAssets(input: {
  storeDir: string;
  taskset: Taskset;
  task: TaskDataRecord;
}): Promise<ResolvedTasksetWorkAsset[]> {
  if (input.taskset.environment.kind !== "work") {
    throw new Error(`Taskset ${input.taskset.id} does not select Work.`);
  }
  const sourceById = new Map(
    input.taskset.sourceRefs.map((source) => [source.id, source]),
  );
  const tasksetRoot = path.resolve(
    input.storeDir,
    "training",
    "tasksets",
    input.taskset.id,
  );
  const assetRoot = path.resolve(tasksetRoot, "assets");
  const resolved: ResolvedTasksetWorkAsset[] = [];

  for (const asset of input.task.assets ?? []) {
    if (asset.split !== input.task.split) {
      throw new Error(
        `Work asset ${asset.id} split does not match task ${input.task.id}.`,
      );
    }
    if (!input.task.sourceRefs.includes(asset.sourceRefId)) {
      throw new Error(
        `Work asset ${asset.id} source is outside task ${input.task.id}.`,
      );
    }
    const source = sourceById.get(asset.sourceRefId);
    if (!source) {
      throw new Error(
        `Work asset ${asset.id} source ${asset.sourceRefId} was not found.`,
      );
    }
    assertEligibleSource(source, asset);
    const target = path.resolve(tasksetRoot, asset.artifactRef);
    if (
      target === assetRoot
      || !target.startsWith(`${assetRoot}${path.sep}`)
    ) {
      throw new Error(
        `Work asset ${asset.id} must resolve inside the Taskset assets directory.`,
      );
    }
    const status = await lstat(target);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Work asset ${asset.id} must be a regular file.`);
    }
    const bytes = await readFile(target);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== asset.sizeBytes) {
      throw new Error(
        `Work asset ${asset.id} size does not match its immutable manifest.`,
      );
    }
    if (sha256 !== asset.sha256) {
      throw new Error(
        `Work asset ${asset.id} hash does not match its immutable manifest.`,
      );
    }
    resolved.push({
      assetId: asset.id,
      sourceRefId: asset.sourceRefId,
      artifactRef: asset.artifactRef,
      storageName: asset.fileName,
      mediaType: asset.mediaType,
      bytes,
      sha256,
      sizeBytes: bytes.byteLength,
    });
  }

  const configuredLimit = input.taskset.environment.metadata.maxInputBytes;
  const maxInputBytes =
    typeof configuredLimit === "number"
    && Number.isInteger(configuredLimit)
    && configuredLimit > 0
      ? Math.min(configuredLimit, MAX_WORK_INPUT_BYTES)
      : DEFAULT_MAX_WORK_INPUT_BYTES;
  const totalBytes = resolved.reduce(
    (sum, asset) => sum + asset.sizeBytes,
    0,
  );
  if (totalBytes > maxInputBytes) {
    throw new Error(
      `Work task ${input.task.id} inputs exceed the ${maxInputBytes} byte limit.`,
    );
  }
  return resolved;
}

export async function resolveTasksetTrainingAssetBytes(input: {
  storeDir: string;
  taskset: Taskset;
}): Promise<ReadonlyMap<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for (const task of input.taskset.tasks.filter((candidate) => candidate.split === "train")) {
    for (const asset of await resolveTasksetWorkAssets({
      storeDir: input.storeDir,
      taskset: input.taskset,
      task,
    })) {
      if (result.has(asset.artifactRef)) {
        throw new Error(
          `Training asset path ${asset.artifactRef} is shared by multiple tasks.`,
        );
      }
      result.set(asset.artifactRef, asset.bytes);
    }
  }
  return result;
}

export async function resolveTasksetEvaluationAssetBytes(input: {
  storeDir: string;
  taskset: Taskset;
}): Promise<ReadonlyMap<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for (const task of input.taskset.tasks.filter(
    (candidate) => candidate.split === "validation" || candidate.split === "frozen_eval",
  )) {
    for (const asset of await resolveTasksetWorkAssets({
      storeDir: input.storeDir,
      taskset: input.taskset,
      task,
    })) {
      if (result.has(asset.artifactRef)) {
        throw new Error(
          `Evaluation asset path ${asset.artifactRef} is shared by multiple tasks.`,
        );
      }
      result.set(asset.artifactRef, asset.bytes);
    }
  }
  return result;
}

function assertEligibleSource(
  source: Taskset["sourceRefs"][number],
  asset: NonNullable<TaskDataRecord["assets"]>[number],
): void {
  if (isTrainingSourceRef(source)) {
    if (source.consent.status !== "granted") {
      throw new Error(`Work asset ${asset.id} source consent is not granted.`);
    }
    throw new Error(
      `Work asset ${asset.id} requires a source with registered file hashes.`,
    );
  }
  if (
    source.secretScanStatus !== "passed"
    || source.piiScanStatus !== "passed"
    || source.licensingStatus !== "approved"
  ) {
    throw new Error(
      `Work asset ${asset.id} source policy is not fully approved.`,
    );
  }
  if (
    !("sourceFileHashes" in source)
    || !source.sourceFileHashes.includes(asset.sha256)
  ) {
    throw new Error(
      `Work asset ${asset.id} hash is not registered by its source.`,
    );
  }
  if (source.kind === "uploaded_file") {
    if (!source.originalFileNames.includes(asset.fileName)) {
      throw new Error(
        `Work asset ${asset.id} file name is not registered by its source.`,
      );
    }
    if (!source.mediaTypes.includes(asset.mediaType)) {
      throw new Error(
        `Work asset ${asset.id} media type is not registered by its source.`,
      );
    }
  }
}
