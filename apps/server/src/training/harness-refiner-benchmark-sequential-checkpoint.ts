import { promises as fs } from "node:fs";
import path from "node:path";

import { contentHash } from "@openpond/harness";

import type { SequentialAdaptationStep } from "./harness-refiner-benchmark-protocol.js";

export type BenchmarkRefinerFailureKind =
  | "timeout"
  | "invalid_output"
  | "provider_failure"
  | "cancelled"
  | "unknown";

export type BenchmarkRefinerInvocationReceipt = {
  schemaVersion: "openpond.benchmarkRefinerInvocation.v1";
  id: string;
  taskId: string;
  attemptId: string;
  invocationOrdinal: number;
  trigger: { id: string; contentHash: string };
  status: "completed" | "failed";
  outcome: { id: string; contentHash: string; decision: string } | null;
  failure: {
    kind: BenchmarkRefinerFailureKind;
    message: string;
    retryable: boolean;
  } | null;
  inputHarness: { id: string; contentHash: string };
  outputHarness: { id: string; contentHash: string };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number | null;
  };
  costBasis: "authoritative" | "estimated" | "none";
  estimatedCostUsd: number | null;
  startedAt: string;
  completedAt: string;
  contentHash: string;
};

export type SequentialAdaptationCheckpoint = {
  schemaVersion: "openpond.sequentialAdaptationCheckpoint.v1";
  modelRunId: string;
  initialHarness: { id: string; contentHash: string };
  steps: SequentialAdaptationStep[];
  invocations: BenchmarkRefinerInvocationReceipt[];
  updatedAt: string;
  contentHash: string;
};

export function createBenchmarkRefinerInvocationReceipt(input: Omit<
  BenchmarkRefinerInvocationReceipt,
  "schemaVersion" | "id" | "contentHash"
>): BenchmarkRefinerInvocationReceipt {
  const core = {
    schemaVersion: "openpond.benchmarkRefinerInvocation.v1" as const,
    id: `benchmark-refiner-invocation-${contentHash({
      taskId: input.taskId,
      attemptId: input.attemptId,
      invocationOrdinal: input.invocationOrdinal,
      trigger: input.trigger,
      status: input.status,
      startedAt: input.startedAt,
    }).slice(0, 24)}`,
    ...input,
  };
  return { ...core, contentHash: contentHash(core) };
}

export async function loadSequentialAdaptationCheckpoint(input: {
  storeDir: string;
  modelRunId: string;
}): Promise<SequentialAdaptationCheckpoint | null> {
  const filePath = checkpointPath(input.storeDir, input.modelRunId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseCheckpoint(parsed, input.modelRunId);
}

export async function initializeSequentialAdaptationCheckpoint(input: {
  storeDir: string;
  modelRunId: string;
  initialHarness: { id: string; contentHash: string };
  now: string;
}): Promise<SequentialAdaptationCheckpoint> {
  const existing = await loadSequentialAdaptationCheckpoint(input);
  if (existing) {
    if (!sameRef(existing.initialHarness, input.initialHarness)) {
      throw new Error("Sequential adaptation checkpoint changed its initial Harness release.");
    }
    return existing;
  }
  return writeSequentialAdaptationCheckpoint({
    storeDir: input.storeDir,
    checkpoint: checkpoint({
      modelRunId: input.modelRunId,
      initialHarness: input.initialHarness,
      steps: [],
      invocations: [],
      updatedAt: input.now,
    }),
  });
}

export async function appendSequentialAdaptationInvocation(input: {
  storeDir: string;
  modelRunId: string;
  initialHarness: { id: string; contentHash: string };
  invocation?: BenchmarkRefinerInvocationReceipt;
  step?: SequentialAdaptationStep;
  now: string;
}): Promise<SequentialAdaptationCheckpoint> {
  const current = await initializeSequentialAdaptationCheckpoint({
    storeDir: input.storeDir,
    modelRunId: input.modelRunId,
    initialHarness: input.initialHarness,
    now: input.now,
  });
  if (!input.invocation && !input.step) {
    throw new Error("A sequential checkpoint append requires an invocation or step.");
  }
  const invocations = input.invocation
    ? [
        ...current.invocations.filter((item) => item.id !== input.invocation!.id),
        input.invocation,
      ]
    : current.invocations;
  const steps = input.step
    ? [
        ...current.steps.filter((item) => item.taskId !== input.step!.taskId),
        input.step,
      ].sort((left, right) => left.ordinal - right.ordinal)
    : current.steps;
  return writeSequentialAdaptationCheckpoint({
    storeDir: input.storeDir,
    checkpoint: checkpoint({
      modelRunId: current.modelRunId,
      initialHarness: current.initialHarness,
      steps,
      invocations,
      updatedAt: input.now,
    }),
  });
}

function checkpoint(input: Omit<
  SequentialAdaptationCheckpoint,
  "schemaVersion" | "contentHash"
>): SequentialAdaptationCheckpoint {
  const core = {
    schemaVersion: "openpond.sequentialAdaptationCheckpoint.v1" as const,
    ...input,
  };
  return { ...core, contentHash: contentHash(core) };
}

async function writeSequentialAdaptationCheckpoint(input: {
  storeDir: string;
  checkpoint: SequentialAdaptationCheckpoint;
}): Promise<SequentialAdaptationCheckpoint> {
  const filePath = checkpointPath(input.storeDir, input.checkpoint.modelRunId);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(input.checkpoint, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
  return input.checkpoint;
}

function parseCheckpoint(
  value: unknown,
  modelRunId: string,
): SequentialAdaptationCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sequential adaptation checkpoint is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== "openpond.sequentialAdaptationCheckpoint.v1"
    || record.modelRunId !== modelRunId
    || !record.initialHarness
    || !Array.isArray(record.steps)
    || !Array.isArray(record.invocations)
    || typeof record.updatedAt !== "string"
    || typeof record.contentHash !== "string"
  ) {
    throw new Error("Sequential adaptation checkpoint is malformed.");
  }
  const { contentHash: admittedHash, ...core } = record;
  if (contentHash(core) !== admittedHash) {
    throw new Error("Sequential adaptation checkpoint failed content-hash validation.");
  }
  const parsed = record as SequentialAdaptationCheckpoint;
  for (const invocation of parsed.invocations) {
    const { contentHash: invocationHash, ...invocationCore } = invocation;
    if (contentHash(invocationCore) !== invocationHash) {
      throw new Error(`Refiner invocation ${invocation.id} failed content-hash validation.`);
    }
  }
  return parsed;
}

function checkpointPath(storeDir: string, modelRunId: string): string {
  return path.join(
    storeDir,
    "training",
    "harness-refiner-benchmarks",
    modelRunId,
    "sequential-adaptation.json",
  );
}

function sameRef(
  left: { id: string; contentHash: string },
  right: { id: string; contentHash: string },
): boolean {
  return left.id === right.id && left.contentHash === right.contentHash;
}
