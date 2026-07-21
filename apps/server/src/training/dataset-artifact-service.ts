import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  DatasetArtifactSummarySchema,
  DatasetRowPageRequestSchema,
  DatasetRowPageSchema,
  TaskDataRecordSchema,
  type TaskDataRecord,
  type DatasetSelectionStrategy,
  type DatasetArtifactRegistryEntry,
  type DatasetArtifactSummary,
  type DatasetRowPage,
  type DatasetRowPageRequest,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

const MAX_WORKER_OUTPUT_BYTES = 12 * 1024 * 1024;

export type DatasetProjectionResult = {
  schemaVersion: "openpond.datasetProjectionResult.v1";
  split: "train" | "validation" | "test" | "frozen_eval";
  mode: "sft" | "grpo" | "baseline";
  exampleCount: number;
  eligibleRows: number;
  duplicateRows: number;
  selectionSeed: number;
  selectionStrategy: DatasetSelectionStrategy;
  contentHash: string;
  sizeBytes: number;
  taskIdsHash: string;
  outputPath: string;
};

export function createDatasetArtifactService(deps: {
  store: SqliteStore;
  workerProjectDir: string;
}) {
  async function summaries(profileId: string): Promise<DatasetArtifactSummary[]> {
    const entries = await deps.store.listDatasetArtifactRegistryEntries(profileId);
    return Promise.all(entries.map(summary));
  }

  async function rows(
    tasksetId: string,
    requestInput: unknown,
  ): Promise<DatasetRowPage> {
    const request = DatasetRowPageRequestSchema.parse(requestInput);
    const entry = await deps.store.getDatasetArtifactForTaskset(tasksetId);
    if (!entry) throw new Error("Dataset artifact not found.");
    const cursor = request.cursor
      ? decodeCursor(request.cursor, entry, request)
      : { offset: 0 };
    const totalRows = request.split
      ? entry.manifest.splitCounts[request.split] ?? 0
      : entry.manifest.rowCount;
    if (totalRows === 0) {
      return DatasetRowPageSchema.parse({
        schemaVersion: "openpond.datasetRowPage.v1",
        tasksetId,
        tasksetRevision: entry.manifest.tasksetRevision,
        artifactHash: entry.manifest.contentHash,
        split: request.split,
        rows: [],
        nextCursor: null,
        totalRows: 0,
        returnedRows: 0,
      });
    }
    const manifestPath = safeArtifactPath(
      entry.storageRoot,
      entry.relativeManifestPath,
    );
    await access(manifestPath);
    const position = locateShard(
      entry,
      request.split,
      cursor.offset,
    );
    const output = await runDatasetWorker(deps.workerProjectDir, [
      "rows",
      "--manifest",
      manifestPath,
      "--root",
      entry.storageRoot,
      ...(request.split ? ["--split", request.split] : []),
      "--start-shard",
      position.shardId,
      "--offset",
      String(position.offset),
      "--limit",
      String(request.limit),
      ...(request.columns.length ? ["--columns", request.columns.join(",")] : []),
    ]);
    const parsed = JSON.parse(output) as { rows?: unknown };
    if (!Array.isArray(parsed.rows)) {
      throw new Error("Dataset row worker returned an invalid page.");
    }
    const pageRows = parseDatasetPageRows(parsed.rows, request.columns);
    const nextOffset = cursor.offset + pageRows.length;
    const nextCursor =
      pageRows.length === request.limit && nextOffset < totalRows
        ? encodeCursor({
            artifactHash: entry.manifest.contentHash,
            split: request.split,
            offset: nextOffset,
          })
        : null;
    return DatasetRowPageSchema.parse({
      schemaVersion: "openpond.datasetRowPage.v1",
      tasksetId,
      tasksetRevision: entry.manifest.tasksetRevision,
      artifactHash: entry.manifest.contentHash,
      split: request.split,
      rows: pageRows,
      nextCursor,
      totalRows,
      returnedRows: pageRows.length,
    });
  }

  async function task(
    tasksetId: string,
    taskId: string,
    split?: DatasetRowPageRequest["split"],
  ): Promise<TaskDataRecord> {
    const entry = await deps.store.getDatasetArtifactForTaskset(tasksetId);
    if (!entry) throw new Error("Dataset artifact not found.");
    const manifestPath = safeArtifactPath(
      entry.storageRoot,
      entry.relativeManifestPath,
    );
    await access(manifestPath);
    const output = await runDatasetWorker(deps.workerProjectDir, [
      "task",
      "--manifest",
      manifestPath,
      "--root",
      entry.storageRoot,
      "--task-id",
      taskId,
      ...(split ? ["--split", split] : []),
    ]);
    const parsed = JSON.parse(output) as { task?: unknown };
    return TaskDataRecordSchema.parse(parsed.task);
  }

  async function project(input: {
    tasksetId: string;
    split: DatasetProjectionResult["split"];
    mode: DatasetProjectionResult["mode"];
    limit: number;
    seed: number;
    selectionStrategy?: DatasetSelectionStrategy;
    approvedSourceIds: string[];
    outputPath: string;
  }): Promise<DatasetProjectionResult> {
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > 100_000
    ) {
      throw new Error("Dataset projection limit must be from 1 through 100,000.");
    }
    if (!Number.isSafeInteger(input.seed)) {
      throw new Error("Dataset projection seed must be an integer.");
    }
    const entry = await deps.store.getDatasetArtifactForTaskset(input.tasksetId);
    if (!entry) throw new Error("Dataset artifact not found.");
    const manifestPath = safeArtifactPath(
      entry.storageRoot,
      entry.relativeManifestPath,
    );
    await access(manifestPath);
    const outputPath = path.resolve(input.outputPath);
    const output = await runDatasetWorker(deps.workerProjectDir, [
      "project",
      "--manifest",
      manifestPath,
      "--root",
      entry.storageRoot,
      "--output",
      outputPath,
      "--split",
      input.split,
      "--mode",
      input.mode,
      "--limit",
      String(input.limit),
      "--seed",
      String(input.seed),
      "--selection-strategy",
      input.selectionStrategy ?? "stable_hash_top_n",
      ...(input.approvedSourceIds.length
        ? ["--approved-sources", input.approvedSourceIds.join(",")]
        : []),
    ]);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const result = parseProjectionResult(parsed, outputPath);
    await access(outputPath);
    return result;
  }

  return { project, rows, summaries, task };
}

export function parseDatasetPageRows(
  rows: unknown[],
  columns: string[],
): Array<Record<string, unknown>> {
  return columns.length
    ? DatasetRowPageSchema.shape.rows.parse(rows)
    : rows.map((row) => TaskDataRecordSchema.parse(row));
}

function parseProjectionResult(
  value: Record<string, unknown>,
  outputPath: string,
): DatasetProjectionResult {
  if (
    value.schemaVersion !== "openpond.datasetProjectionResult.v1"
    || !["train", "validation", "test", "frozen_eval"].includes(
      String(value.split),
    )
    || !["sft", "grpo", "baseline"].includes(String(value.mode))
    || !Number.isSafeInteger(value.exampleCount)
    || !Number.isSafeInteger(value.eligibleRows)
    || !Number.isSafeInteger(value.duplicateRows)
    || !Number.isSafeInteger(value.selectionSeed)
    || !["stable_hash_top_n", "rft_easy_curriculum_v1"].includes(
      String(value.selectionStrategy),
    )
    || typeof value.contentHash !== "string"
    || value.contentHash.length < 8
    || !Number.isSafeInteger(value.sizeBytes)
    || typeof value.taskIdsHash !== "string"
    || value.taskIdsHash.length < 8
  ) {
    throw new Error("Dataset projection worker returned an invalid result.");
  }
  return {
    ...(value as Omit<DatasetProjectionResult, "outputPath">),
    outputPath,
  };
}

function locateShard(
  entry: DatasetArtifactRegistryEntry,
  split: DatasetRowPageRequest["split"],
  offset: number,
): { shardId: string; offset: number } {
  const shards = entry.manifest.shards.filter(
    (shard) => !split || shard.split === split,
  );
  let remaining = offset;
  for (const shard of shards) {
    if (remaining < shard.rowCount) {
      return { shardId: shard.id, offset: remaining };
    }
    remaining -= shard.rowCount;
  }
  const last = shards.at(-1);
  if (!last) throw new Error("Dataset split has no Parquet shards.");
  return { shardId: last.id, offset: last.rowCount };
}

async function summary(
  entry: DatasetArtifactRegistryEntry,
): Promise<DatasetArtifactSummary> {
  let available = entry.available;
  let unavailableReason = entry.unavailableReason;
  if (available) {
    try {
      await access(
        safeArtifactPath(entry.storageRoot, entry.relativeManifestPath),
      );
    } catch {
      available = false;
      unavailableReason = "The configured Dataset storage is unavailable.";
    }
  }
  return DatasetArtifactSummarySchema.parse({
    schemaVersion: "openpond.datasetArtifactSummary.v1",
    artifactId: entry.manifest.id,
    tasksetId: entry.manifest.tasksetId,
    tasksetRevision: entry.manifest.tasksetRevision,
    format: entry.manifest.format,
    rowCount: entry.manifest.rowCount,
    splitCounts: entry.manifest.splitCounts,
    sizeBytes: entry.manifest.shards.reduce(
      (total, shard) => total + shard.sizeBytes,
      0,
    ),
    contentHash: entry.manifest.contentHash,
    available,
    unavailableReason,
    createdAt: entry.createdAt,
  });
}

function safeArtifactPath(rootValue: string, relativeValue: string): string {
  const root = path.resolve(rootValue);
  const candidate = path.resolve(root, relativeValue);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Dataset artifact path escapes its registered storage root.");
  }
  return candidate;
}

function encodeCursor(value: {
  artifactHash: string;
  split: DatasetRowPageRequest["split"];
  offset: number;
}): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(
  value: string,
  entry: DatasetArtifactRegistryEntry,
  request: DatasetRowPageRequest,
): { offset: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Dataset row cursor is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Dataset row cursor is invalid.");
  }
  const cursor = parsed as Record<string, unknown>;
  if (
    cursor.artifactHash !== entry.manifest.contentHash
    || cursor.split !== request.split
    || typeof cursor.offset !== "number"
    || !Number.isSafeInteger(cursor.offset)
    || cursor.offset < 0
  ) {
    throw new Error("Dataset row cursor is stale or invalid.");
  }
  return { offset: cursor.offset };
}

async function runDatasetWorker(
  projectDir: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "uv",
      ["run", "--project", projectDir, "openpond-datasets", ...args],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_WORKER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        reject(new Error("Dataset row response exceeded its byte limit."));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim()
            || `Dataset worker exited with code ${code ?? "unknown"}.`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}
