import { createServer } from "node:net";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  ModelRunSchema,
  TrainingArtifactSchema,
  TrainingJobEventSchema,
  type TrainingJob,
} from "@openpond/contracts";
import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import type { PrimeQuoteCandidate } from "./prime-grpo-plan.js";

const REMOTE_INFERENCE_PORT = 8_000;
const REMOTE_HARNESS_PORT = 17_777;
export const PRIME_GRPO_PYTHON_EXECUTABLE = "python";

export function buildPrimeGrpoRemoteCommand(input: {
  remoteDirectory: string;
  remoteProject: string;
  callbackPort?: number;
  inferencePort?: number;
}): string[] {
  return [
    "env",
    `PYTHONPATH=${input.remoteProject}/src`,
    PRIME_GRPO_PYTHON_EXECUTABLE,
    "-m",
    "openpond_training.prime_grpo_runner",
    "--run-dir",
    input.remoteDirectory,
    "--project-root",
    input.remoteProject,
    "--callback-port",
    String(input.callbackPort ?? REMOTE_HARNESS_PORT),
    "--inference-port",
    String(input.inferencePort ?? REMOTE_INFERENCE_PORT),
    "--model-timeout-seconds",
    "900",
    "--callback-timeout-seconds",
    "600",
  ];
}

export function createPrimeGrpoFailureReceipt(input: {
  modelRunId: string;
  jobId: string;
  stage: string;
  error: string;
  planHash: string;
  manifestHash: string;
  bundleHash: string;
  model: Record<string, unknown>;
  quote: PrimeQuoteCandidate;
  providerResource: Record<string, unknown> | null;
  usage: Record<string, unknown>;
  cost: {
    providerReportedUsd: number | null;
    estimatedUsd: number;
    methodology: string;
    methodologyVersion: string;
  };
  cleanup: {
    remoteStopped: boolean;
    tunnelClosed: boolean;
    computeReleased: boolean;
    startedAt: string;
    completedAt: string;
  };
  startedAt: string;
  completedAt: string;
}) {
  const core = {
    schemaVersion: "openpond.primeGrpoFailureReceipt.v1" as const,
    ...input,
  };
  return {
    ...core,
    contentHash: contentHash(core),
  };
}

export function estimatePrimeGrpoCostUsd(input: {
  acquiredAt: string;
  releasedAt: string;
  hourlyCostUsd: number;
  maximumCostUsd: number;
}): number {
  const acquiredAt = providerTimestampMs(input.acquiredAt);
  const releasedAt = providerTimestampMs(input.releasedAt);
  return roundUsd(
    Math.min(
      input.maximumCostUsd,
      (Math.max(0, releasedAt - acquiredAt) / 3_600_000) * input.hourlyCostUsd
    )
  );
}

export function recentPrimeProvisioningFailureDevices(
  jobs: TrainingJob[],
  currentTime: Date,
  options: {
    recentCooldownMs?: number;
    repeatedFailureCooldownMs?: number;
    repeatedFailureWindowMs?: number;
    repeatedFailureThreshold?: number;
  } = {}
): Set<string> {
  const currentTimeMs = currentTime.getTime();
  const recentCooldownMs = options.recentCooldownMs ?? 30 * 60_000;
  const repeatedFailureCooldownMs =
    options.repeatedFailureCooldownMs ?? 6 * 60 * 60_000;
  const repeatedFailureWindowMs =
    options.repeatedFailureWindowMs ?? 24 * 60 * 60_000;
  const repeatedFailureThreshold = options.repeatedFailureThreshold ?? 2;
  const byDevice = new Map<
    string,
    Array<{ completedAt: number; job: TrainingJob }>
  >();
  for (const job of jobs) {
    const completedAt = job.completedAt
      ? Date.parse(job.completedAt)
      : Number.NaN;
    const deviceId = metadataString(job, "deviceOrPool");
    if (
      job.metadata.primeGrpo !== true ||
      !deviceId ||
      !Number.isFinite(completedAt) ||
      completedAt > currentTimeMs
    ) {
      continue;
    }
    const entries = byDevice.get(deviceId) ?? [];
    entries.push({ completedAt, job });
    byDevice.set(deviceId, entries);
  }

  const excluded = new Set<string>();
  for (const [deviceId, entries] of byDevice) {
    entries.sort((left, right) => right.completedAt - left.completedAt);
    const provisioningFailures: number[] = [];
    for (const entry of entries) {
      if (metadataString(entry.job, "sshReadyAt")) {
        break;
      }
      const failureStage = metadataString(entry.job, "failureStage");
      if (
        entry.job.status === "failed" &&
        (failureStage === "provisioning" ||
          failureStage === "provisioning_ssh") &&
        entry.completedAt >= currentTimeMs - repeatedFailureWindowMs
      ) {
        provisioningFailures.push(entry.completedAt);
      }
    }
    const latestFailure = provisioningFailures[0];
    if (
      latestFailure !== undefined &&
      (latestFailure >= currentTimeMs - recentCooldownMs ||
        (provisioningFailures.length >= repeatedFailureThreshold &&
          latestFailure >= currentTimeMs - repeatedFailureCooldownMs))
    ) {
      excluded.add(deviceId);
    }
  }
  return excluded;
}

export async function readPrimeGrpoFailureUsage(artifactRoot: string): Promise<{
  promptTokens: number;
  generatedTokens: number;
  optimizerSteps: number;
  rolloutGroups: number;
  completedRollouts: number;
}> {
  const state = await readJsonRecord(
    path.join(artifactRoot, "grouped-grpo-state.json")
  );
  const optimizerSteps = Array.isArray(state?.optimizerReceipts)
    ? state.optimizerReceipts.length
    : 0;
  const rolloutGroups = Array.isArray(state?.batchReceipts)
    ? state.batchReceipts.length
    : 0;
  const traceDirectory = path.join(artifactRoot, "traces");
  const filenames = await readdir(traceDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
  let promptTokens = 0;
  let generatedTokens = 0;
  let completedRollouts = 0;
  for (const filename of filenames
    .filter((candidate) => candidate.endsWith(".json"))
    .sort()) {
    const trace = await readJsonRecord(path.join(traceDirectory, filename));
    const result = recordValue(trace?.result);
    const sample = recordValue(result?.optimizerSample);
    if (!sample) continue;
    promptTokens += nonnegativeInteger(sample.promptTokenCount);
    generatedTokens += nonnegativeInteger(sample.completionTokenCount);
    completedRollouts += 1;
  }
  return {
    promptTokens,
    generatedTokens,
    optimizerSteps,
    rolloutGroups,
    completedRollouts,
  };
}

export async function saveFileArtifact(input: {
  store: SqliteStore;
  jobId: string;
  kind: "metrics" | "log" | "manifest";
  filePath: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  modelIdentity?: {
    baseModelId: string;
    baseModelRevision: string;
    tokenizerRevision: string;
    chatTemplateHash: string;
  };
}) {
  const bytes = await readFile(input.filePath);
  return input.store.saveTrainingArtifact(
    TrainingArtifactSchema.parse({
      schemaVersion: "openpond.trainingArtifact.v1",
      id: `training_artifact_${contentHash([
        input.jobId,
        input.kind,
        sha256(bytes),
      ]).slice(0, 24)}`,
      jobId: input.jobId,
      kind: input.kind,
      path: input.filePath,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      baseModelId: input.modelIdentity?.baseModelId ?? null,
      baseModelRevision: input.modelIdentity?.baseModelRevision ?? null,
      tokenizerRevision: input.modelIdentity?.tokenizerRevision ?? null,
      chatTemplateHash: input.modelIdentity?.chatTemplateHash ?? null,
      nonProduction: false,
      createdAt: input.createdAt,
      metadata: input.metadata,
    })
  );
}

export async function failRun(input: {
  store: SqliteStore;
  modelRunId: string;
  jobId: string;
  error: string;
  failedAt: string;
  metadata?: Record<string, unknown>;
}) {
  const job = await updateJob(input.store, input.jobId, {
    status: "failed",
    completedAt: input.failedAt,
    error: input.error,
    metadata: {
      phase: "failed",
      ...input.metadata,
    },
  });
  await saveJobEvent(input.store, job, "failure", {
    phase: "failed",
    error: input.error,
  });
  const modelRun = await input.store.getModelRun(input.modelRunId);
  if (modelRun && !isTerminalModelRun(modelRun.status)) {
    await input.store.saveModelRun({
      ...modelRun,
      status: "failed",
      failure: input.error,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    });
  }
}

export async function cancelRun(input: {
  store: SqliteStore;
  modelRunId: string;
  jobId: string;
  cancelledAt: string;
}) {
  const job = await updateJob(input.store, input.jobId, {
    status: "cancelled",
    completedAt: input.cancelledAt,
    error: null,
    metadata: { phase: "cancelled" },
  });
  const events = await input.store.listTrainingJobEvents(job.id);
  if (!events.some((event) => event.type === "cancel")) {
    await saveJobEvent(input.store, job, "cancel", {
      requested: true,
    });
  }
  const modelRun = await input.store.getModelRun(input.modelRunId);
  if (modelRun && !isTerminalModelRun(modelRun.status)) {
    await input.store.saveModelRun({
      ...modelRun,
      status: "cancelled",
      failure: "Cancelled by user.",
      completedAt: input.cancelledAt,
      updatedAt: input.cancelledAt,
    });
  }
  return job;
}

export function verifyGroupedReceipt(
  value: unknown,
  plan: ResolvedTrainingPlan
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prime grouped-GRPO receipt must be an object.");
  }
  const receipt = value as Record<string, unknown>;
  const { contentHash: suppliedHash, ...core } = receipt;
  if (
    suppliedHash !== contentHash(core) ||
    receipt.schemaVersion !== "openpond.groupedGrpoCoordinatorReceipt.v1" ||
    receipt.runId !== plan.manifest.id ||
    receipt.manifestId !== plan.manifest.id ||
    receipt.manifestHash !== plan.manifest.contentHash ||
    receipt.optimizerSteps !==
      (plan.recipe.method === "grpo" ? plan.recipe.optimizer.maxSteps : -1) ||
    receipt.finalPolicyVersion !==
      (plan.recipe.method === "grpo" ? plan.recipe.optimizer.maxSteps : -1)
  ) {
    throw new Error("Prime grouped-GRPO receipt hash or lineage is invalid.");
  }
  return receipt;
}

export async function readVerifiedGroupedReceipt(
  receiptPath: string,
  plan: ResolvedTrainingPlan
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    throw new Error("Prime grouped-GRPO canonical receipt could not be read.", {
      cause: error,
    });
  }
  return verifyGroupedReceipt(value, plan);
}

export function expectedAdapterIdentity(receipt: Record<string, unknown>): {
  configSha256: string;
  weightsSha256: string;
} {
  const optimizerReceipts = receipt.optimizerReceipts;
  if (!Array.isArray(optimizerReceipts) || optimizerReceipts.length === 0) {
    throw new Error("Prime grouped-GRPO receipt has no optimizer update.");
  }
  const final = optimizerReceipts.at(-1);
  if (!final || typeof final !== "object" || Array.isArray(final)) {
    throw new Error("Prime grouped-GRPO final optimizer receipt is invalid.");
  }
  const adapter = (final as Record<string, unknown>).adapter;
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new Error("Prime grouped-GRPO final adapter receipt is invalid.");
  }
  const identity = adapter as Record<string, unknown>;
  if (
    typeof identity.configSha256 !== "string" ||
    typeof identity.weightsSha256 !== "string"
  ) {
    throw new Error("Prime grouped-GRPO adapter hashes are invalid.");
  }
  return {
    configSha256: identity.configSha256,
    weightsSha256: identity.weightsSha256,
  };
}

export async function verifyAdapterDirectory(
  adapterDirectory: string,
  receipt: Record<string, unknown>
): Promise<void> {
  const identity = expectedAdapterIdentity(receipt);
  const config = path.join(adapterDirectory, "adapter_config.json");
  const weights = path.join(adapterDirectory, "adapter_model.safetensors");
  await Promise.all([readFile(config), readFile(weights)]).then(
    ([configBytes, weightBytes]) => {
      if (
        sha256(configBytes) !== identity.configSha256 ||
        sha256(weightBytes) !== identity.weightsSha256
      ) {
        throw new Error(
          "Downloaded Prime LoRA adapter changed after optimizer receipt."
        );
      }
    }
  );
}

export async function materializeVerifiedPrimeAdapterForImport(
  outputDirectory: string,
  receipt: Record<string, unknown>
): Promise<{ recoveredFrom: string | null }> {
  const canonicalDirectory = path.join(outputDirectory, "adapter");
  try {
    await verifyAdapterDirectory(canonicalDirectory, receipt);
    return { recoveredFrom: null };
  } catch (canonicalError) {
    const finalPolicyVersion = receipt.finalPolicyVersion;
    if (
      typeof finalPolicyVersion !== "number" ||
      !Number.isInteger(finalPolicyVersion) ||
      finalPolicyVersion < 1
    ) {
      throw canonicalError;
    }
    const recoveryDirectory = path.join(
      outputDirectory,
      ".prime-rl",
      "output",
      "weights",
      `step_${finalPolicyVersion}`,
      "lora_adapters"
    );
    try {
      await verifyAdapterDirectory(recoveryDirectory, receipt);
      await mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
      await Promise.all([
        copyFile(
          path.join(recoveryDirectory, "adapter_config.json"),
          path.join(canonicalDirectory, "adapter_config.json")
        ),
        copyFile(
          path.join(recoveryDirectory, "adapter_model.safetensors"),
          path.join(canonicalDirectory, "adapter_model.safetensors")
        ),
      ]);
      await verifyAdapterDirectory(canonicalDirectory, receipt);
      return { recoveredFrom: recoveryDirectory };
    } catch (recoveryError) {
      throw new Error(
        "Prime LoRA adapter is unavailable in both the canonical and recoverable optimizer outputs.",
        { cause: recoveryError }
      );
    }
  }
}

export async function requireJob(store: SqliteStore, modelRunId: string) {
  const job = (await store.listTrainingJobs()).find(
    (candidate) =>
      candidate.id === modelRunId ||
      candidate.metadata.modelRunId === modelRunId
  );
  if (!job || job.metadata.primeGrpo !== true) {
    throw new Error("No Prime GRPO execution exists for this Model Run.");
  }
  return job;
}

export async function updateJob(
  store: SqliteStore,
  jobId: string,
  update: {
    status?: TrainingJob["status"];
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const job = await store.getTrainingJob(jobId);
  if (!job) {
    throw new Error(`Training Job ${jobId} is unavailable.`);
  }
  return store.saveTrainingJob(
    TrainingJobSchema.parse({
      ...job,
      ...update,
      metadata: {
        ...job.metadata,
        ...update.metadata,
      },
      updatedAt: new Date().toISOString(),
    })
  );
}

export async function saveJobEvent(
  store: SqliteStore,
  job: TrainingJob,
  type: import("@openpond/contracts").TrainingJobEvent["type"],
  payload: Record<string, unknown>
) {
  const sequence = (await store.listTrainingJobEvents(job.id)).length;
  return store.saveTrainingJobEvent(
    TrainingJobEventSchema.parse({
      schemaVersion: "openpond.trainingJobEvent.v1",
      id: `training_event_${contentHash([
        job.id,
        sequence,
        type,
        payload,
      ]).slice(0, 24)}`,
      jobId: job.id,
      sequence,
      type,
      timestamp: new Date().toISOString(),
      payload,
    })
  );
}

export function modelVersionId(modelId: string, version: number): string {
  return `model_version_${contentHash({
    modelId,
    version,
  }).slice(0, 24)}`;
}

export function isTerminalModelRun(status: string): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

export function metadataString(job: TrainingJob, key: string): string | null {
  const value = job.metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function requireMetadataString(job: TrainingJob, key: string): string {
  const value = metadataString(job, key);
  if (!value) {
    throw new Error(`Prime GRPO Job is missing metadata ${key}.`);
  }
  return value;
}

export function requireMetadataNumber(job: TrainingJob, key: string): number {
  const value = job.metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Prime GRPO Job has invalid metadata ${key}.`);
  }
  return value;
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (!port) throw new Error("Failed to allocate an inference port.");
  return port;
}

export function safeMessage(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5_000) || "Prime GRPO execution failed."
  );
}

export function isPrimeNodeAlreadyTerminatedError(error: unknown): boolean {
  return /Prime API DELETE .* failed \((?:404|410)\):/.test(
    error instanceof Error ? error.message : String(error)
  );
}

export function providerTimestampMs(value: string): number {
  const timezoneQualified = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(value)
    ? value
    : `${value}Z`;
  const timestamp = Date.parse(timezoneQualified);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Prime provider timestamp is invalid.");
  }
  return timestamp;
}

export function providerWalletSpend(
  job: TrainingJob,
  finalBalanceUsd: number
): number | null {
  const initialBalanceUsd = job.metadata.walletBalanceUsd;
  if (
    typeof initialBalanceUsd !== "number" ||
    !Number.isFinite(initialBalanceUsd) ||
    !Number.isFinite(finalBalanceUsd)
  ) {
    return null;
  }
  return roundUsd(Math.max(0, initialBalanceUsd - finalBalanceUsd));
}

export async function readJsonRecord(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return recordValue(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

