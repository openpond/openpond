import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, open, rename, rm, statfs } from "node:fs/promises";
import readline from "node:readline";
import type {
  DatasetImportJob,
  DatasetImportMapping,
} from "@openpond/contracts";

export type DatasetMaterializeResult = {
  schemaVersion: "openpond.datasetMaterializeResult.v1";
  rowCount: number;
  splitCounts: Record<"train" | "validation" | "test" | "frozen_eval", number>;
  shards: Array<{
    id: string;
    split: "train" | "validation" | "test" | "frozen_eval";
    path: string;
    contentHash: string;
    sizeBytes: number;
    rowCount: number;
    rowGroupCount: number;
  }>;
  schemaHash: string;
  qualityReport: Record<string, unknown>;
  qualityReportHash: string;
  previewRows: Array<Record<string, unknown>>;
  firstTaskIds: Partial<
    Record<"train" | "validation" | "test" | "frozen_eval", string>
  >;
};

export async function downloadDatasetFile(input: {
  request: typeof fetch;
  url: string;
  destination: string;
  expectedSizeBytes: number;
  signal: AbortSignal;
  onProgress: (bytes: number) => Promise<void>;
}): Promise<{ contentHash: string; sizeBytes: number }> {
  if (
    !Number.isSafeInteger(input.expectedSizeBytes)
    || input.expectedSizeBytes < 0
  ) {
    throw new Error("Dataset file size must be a known non-negative integer.");
  }
  const response = await input.request(input.url, {
    redirect: "follow",
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Dataset file download failed (${response.status}).`);
  }
  const declaredResponseBytes = responseByteLength(response);
  if (
    declaredResponseBytes !== null
    && declaredResponseBytes !== input.expectedSizeBytes
  ) {
    throw new Error(
      `Dataset source changed size: expected ${input.expectedSizeBytes} bytes but the response declared ${declaredResponseBytes}.`,
    );
  }
  const handle = await open(input.destination, "wx", 0o600);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let pendingProgress = 0;
  let lastProgressAt = Date.now();
  try {
    const reader = response.body.getReader();
    while (true) {
      assertDatasetImportNotCancelled(input.signal);
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      const nextSizeBytes = sizeBytes + bytes.byteLength;
      if (nextSizeBytes > input.expectedSizeBytes) {
        throw new Error(
          `Dataset source exceeded its inspected size of ${input.expectedSizeBytes} bytes.`,
        );
      }
      await handle.write(bytes);
      hash.update(bytes);
      sizeBytes = nextSizeBytes;
      pendingProgress += bytes.byteLength;
      if (
        pendingProgress >= 4 * 1024 * 1024
        || Date.now() - lastProgressAt >= 750
      ) {
        await input.onProgress(pendingProgress);
        pendingProgress = 0;
        lastProgressAt = Date.now();
      }
    }
    if (pendingProgress) await input.onProgress(pendingProgress);
    if (sizeBytes !== input.expectedSizeBytes) {
      throw new Error(
        `Dataset source changed size: expected ${input.expectedSizeBytes} bytes but downloaded ${sizeBytes}.`,
      );
    }
  } catch (error) {
    await handle.close();
    await rm(input.destination, { force: true });
    throw error;
  }
  await handle.close();
  return { contentHash: hash.digest("hex"), sizeBytes };
}

export async function verifyDatasetFile(input: {
  path: string;
  expectedSizeBytes: number;
  expectedContentHash: string;
}): Promise<boolean> {
  try {
    const file = await open(input.path, "r");
    const fileStat = await file.stat();
    await file.close();
    if (fileStat.size !== input.expectedSizeBytes) return false;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(input.path)) {
      digest.update(chunk);
    }
    return digest.digest("hex") === input.expectedContentHash;
  } catch {
    return false;
  }
}

export async function installVerifiedDatasetBlob(input: {
  temporaryPath: string;
  blobPath: string;
  expectedSizeBytes: number;
  expectedContentHash: string;
}): Promise<void> {
  if (await verifyDatasetFile({
    path: input.blobPath,
    expectedSizeBytes: input.expectedSizeBytes,
    expectedContentHash: input.expectedContentHash,
  })) {
    await rm(input.temporaryPath, { force: true });
    return;
  }
  try {
    await rename(input.temporaryPath, input.blobPath);
  } catch (error) {
    if (await verifyDatasetFile({
      path: input.blobPath,
      expectedSizeBytes: input.expectedSizeBytes,
      expectedContentHash: input.expectedContentHash,
    })) {
      await rm(input.temporaryPath, { force: true });
      return;
    }
    await rm(input.blobPath, { force: true });
    await rename(input.temporaryPath, input.blobPath).catch(() => {
      throw error;
    });
  }
  if (!await verifyDatasetFile({
    path: input.blobPath,
    expectedSizeBytes: input.expectedSizeBytes,
    expectedContentHash: input.expectedContentHash,
  })) {
    throw new Error("Installed dataset blob failed integrity verification.");
  }
}

export async function runDatasetMaterializeWorker(input: {
  projectDir: string;
  controlPath: string;
  resultPath: string;
  signal: AbortSignal;
  onProgress: (event: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "uv",
      [
        "run",
        "--project",
        input.projectDir,
        "openpond-datasets",
        "materialize",
        "--control",
        input.controlPath,
        "--result",
        input.resultPath,
      ],
      {
        cwd: input.projectDir,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          HF_HUB_OFFLINE: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const errors: Buffer[] = [];
    let progressChain = Promise.resolve();
    const abort = () => child.kill("SIGTERM");
    input.signal.addEventListener("abort", abort, { once: true });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event && typeof event === "object") {
          progressChain = progressChain.then(() =>
            input.onProgress(event as Record<string, unknown>),
          );
        }
      } catch {
        // Non-protocol stdout is ignored; the result file remains authoritative.
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.reduce((total, item) => total + item.byteLength, 0) < 256_000) {
        errors.push(chunk);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      input.signal.removeEventListener("abort", abort);
      lines.close();
      void progressChain.then(
        () => {
          if (input.signal.aborted) {
            reject(new Error("Dataset import cancelled."));
          } else if (code !== 0) {
            reject(
              new Error(
                Buffer.concat(errors).toString("utf8").trim()
                || `Dataset worker exited with code ${code ?? "unknown"}.`,
              ),
            );
          } else {
            resolve();
          }
        },
        reject,
      );
    });
  });
}

export async function assertDatasetStorageCapacity(
  root: string,
  files: Array<{ sizeBytes: number | null }>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  const expected = sumKnownDatasetBytes(files);
  if (expected === null) {
    throw new Error(
      "Every Dataset source file must declare its size before materialization.",
    );
  }
  const storage = await statfs(root);
  const available = Number(storage.bavail) * Number(storage.bsize);
  const required = requiredDatasetStorageBytes(expected);
  if (Number.isFinite(available) && available < required) {
    throw new Error(
      `Dataset import needs about ${formatBytes(required)} free; ${formatBytes(available)} is available.`,
    );
  }
}

export function requiredDatasetStorageBytes(sourceBytes: number): number {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new Error("Dataset source size must be a non-negative integer.");
  }
  return Math.ceil(sourceBytes * 2.2) + 256 * 1024 * 1024;
}

export function parseDatasetMaterializeResult(
  value: unknown,
): DatasetMaterializeResult {
  const record = asRecord(value);
  if (
    record?.schemaVersion !== "openpond.datasetMaterializeResult.v1"
    || typeof record.rowCount !== "number"
    || !asRecord(record.splitCounts)
    || !Array.isArray(record.shards)
    || typeof record.schemaHash !== "string"
    || !asRecord(record.qualityReport)
    || typeof record.qualityReportHash !== "string"
    || !Array.isArray(record.previewRows)
    || !asRecord(record.firstTaskIds)
  ) {
    throw new Error("Dataset worker returned an invalid materialization result.");
  }
  return record as unknown as DatasetMaterializeResult;
}

export function selectedDatasetSourceRows(
  inspection: NonNullable<DatasetImportJob["inspection"]>,
  mapping: DatasetImportMapping,
): number | null {
  return inspection.splits
    .filter(
      (split) =>
        split.configuration === mapping.configuration
        && mapping.upstreamSplits.includes(split.split),
    )
    .reduce<number | null>(
      (total, split) =>
        total === null || split.rowCount === null
          ? null
          : total + split.rowCount,
      0,
    );
}

export function sumKnownDatasetBytes(
  files: Array<{ sizeBytes: number | null }>,
): number | null {
  return files.reduce<number | null>(
    (total, file) =>
      total === null || file.sizeBytes === null
        ? null
        : total + file.sizeBytes,
    0,
  );
}

export function assertDatasetImportNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Dataset import cancelled.");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function responseByteLength(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    throw new Error("Dataset file response has an invalid Content-Length.");
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) {
    throw new Error("Dataset file response is too large to verify safely.");
  }
  return bytes;
}
