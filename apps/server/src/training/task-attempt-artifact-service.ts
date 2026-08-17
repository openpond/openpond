import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  TaskAttemptArtifactSchema,
  type TaskAttemptArtifact,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";

export async function persistJsonTaskAttemptArtifact(input: {
  store: SqliteStore;
  storeDir: string;
  tasksetId: string;
  taskId: string;
  attemptId: string;
  requestId: string;
  kind: Extract<
    TaskAttemptArtifact["kind"],
    "raw_model_response" | "runtime_trace" | "environment_state" | "grader_evidence"
  >;
  payload: Record<string, unknown>;
  fileLabel?: string;
  timestamp: () => string;
}) {
  const directory = path.join(
    input.storeDir,
    "training",
    "evaluation-artifacts",
    input.tasksetId,
  );
  const file = path.join(
    directory,
    `${input.attemptId}-${safeFileLabel(input.fileLabel ?? input.kind)}.json`,
  );
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "openpond.rawEvaluationArtifact.v1",
    requestId: input.requestId,
    ...input.payload,
  }, null, 2)}\n`, "utf8");
  await mkdir(directory, { recursive: true });
  await writeFile(file, bytes, { mode: 0o600 });
  return saveArtifact({
    ...input,
    file,
    bytes,
    mediaType: "application/json",
  });
}

function safeFileLabel(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Evaluation artifact file label is empty.");
  return normalized;
}

export async function persistTaskAttemptOutputArtifact(input: {
  store: SqliteStore;
  tasksetId: string;
  taskId: string;
  attemptId: string;
  requestId: string;
  path: string;
  mediaType: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  timestamp: () => string;
  metadata?: Record<string, unknown>;
}) {
  const bytes = await readFile(input.path);
  const checksum = sha256(bytes);
  if (
    bytes.byteLength !== input.expectedSizeBytes
    || checksum !== input.expectedSha256
  ) {
    throw new Error(
      `Saved Work output ${path.basename(input.path)} no longer matches its OutputRef.`,
    );
  }
  return saveArtifact({
    ...input,
    file: input.path,
    bytes,
    kind: "output_artifact",
    metadata: {
      ...input.metadata,
      source: "openpond-work",
      outputValidated: true,
    },
  });
}

async function saveArtifact(input: {
  store: SqliteStore;
  tasksetId: string;
  taskId: string;
  attemptId: string;
  requestId: string;
  kind: TaskAttemptArtifact["kind"];
  file: string;
  bytes: Buffer;
  mediaType: string;
  timestamp: () => string;
  metadata?: Record<string, unknown>;
}) {
  const checksum = sha256(input.bytes);
  const artifact = TaskAttemptArtifactSchema.parse({
    schemaVersion: "openpond.taskAttemptArtifact.v1",
    id: `attempt_artifact_${contentHash([
      input.attemptId,
      input.kind,
      input.file,
      checksum,
    ]).slice(0, 24)}`,
    tasksetId: input.tasksetId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: input.kind,
    path: input.file,
    mediaType: input.mediaType,
    sha256: checksum,
    sizeBytes: input.bytes.byteLength,
    createdAt: input.timestamp(),
    metadata: {
      requestId: input.requestId,
      localOnly: true,
      containsPrivilegedOutcome: false,
      ...input.metadata,
    },
  });
  return input.store.saveTaskAttemptArtifact(artifact);
}
