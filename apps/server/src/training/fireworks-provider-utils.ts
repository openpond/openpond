import path from "node:path";
import {
  TrainingJobSchema,
  type TrainingArtifact,
  type TrainingJob,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  FireworksApiClient,
  fireworksMoneyUsd,
  type FireworksRftJob,
  type FireworksSftJob,
} from "./fireworks-client.js";

const TERMINAL_JOB_STATES = new Set(["cancelled", "succeeded", "failed"]);

export function providerTerminalReceiptComplete(job: TrainingJob): boolean {
  if (!TERMINAL_JOB_STATES.has(job.status)) return false;
  if (job.metadata.providerMetricsCollected !== true) return false;
  return job.status !== "succeeded" || job.metadata.providerCollected === true;
}

export function providerId(prefix: string, source: string): string {
  return `${prefix}-${contentHash(source).slice(0, 24)}`.slice(0, 63);
}

export function providerOutputModel(
  accountId: string,
  providerValue: string | undefined,
  fallbackId: string,
): string {
  if (providerValue?.startsWith("accounts/")) return providerValue;
  return `accounts/${accountId}/models/${providerValue || fallbackId}`;
}

type FireworksManagedJob = FireworksSftJob | FireworksRftJob;

export function providerJobState(job: FireworksManagedJob): TrainingJob["status"] {
  switch (job.state) {
    case "JOB_STATE_COMPLETED":
    case "JOB_STATE_EARLY_STOPPED":
      return "succeeded";
    case "JOB_STATE_FAILED":
    case "JOB_STATE_EXPIRED":
    case "JOB_STATE_DELETED":
      return "failed";
    case "JOB_STATE_CANCELLED":
      return "cancelled";
    case "JOB_STATE_CANCELLING":
    case "JOB_STATE_DELETING":
    case "JOB_STATE_DELETING_CLEANING_UP":
      return "cancelling";
    case "JOB_STATE_RUNNING":
    case "JOB_STATE_WRITING_RESULTS":
      return "running";
    case "JOB_STATE_CREATING":
    case "JOB_STATE_CREATING_INPUT_DATASET":
    case "JOB_STATE_VALIDATING":
    case "JOB_STATE_PENDING":
    case "JOB_STATE_RE_QUEUEING":
    case "JOB_STATE_IDLE":
    case "JOB_STATE_PAUSED":
    default:
      return "starting";
  }
}

export function normalizedJob(
  job: TrainingJob,
  providerJob: FireworksManagedJob,
  timestamp: string,
): TrainingJob {
  const status = providerJobState(providerJob);
  const providerError =
    status === "failed"
      ? providerJob.status?.message || `Fireworks job ended as ${providerJob.state ?? "unknown"}.`
      : null;
  return TrainingJobSchema.parse({
    ...job,
    status,
    completedAt: TERMINAL_JOB_STATES.has(status)
      ? providerJob.completedTime ?? timestamp
      : null,
    error: providerError,
    updatedAt: providerJob.updateTime ?? timestamp,
    metadata: {
      ...job.metadata,
      providerJobName: providerJob.name,
      providerJobState: providerJob.state ?? null,
      providerEstimatedCostUsd: fireworksMoneyUsd(providerJob.estimatedCost),
      providerProgress: providerProgress(providerJob),
    },
  });
}

export function providerProgress(job: FireworksManagedJob): Record<string, unknown> {
  return {
    providerJobState: job.state ?? null,
    percent: job.jobProgress?.percent ?? null,
    epoch: job.jobProgress?.epoch ?? null,
    inputTokens: job.jobProgress?.inputTokens ?? null,
    outputTokens: job.jobProgress?.outputTokens ?? null,
    totalInputRequests: job.jobProgress?.totalInputRequests ?? null,
    totalProcessedRequests: job.jobProgress?.totalProcessedRequests ?? null,
    successfullyProcessedRequests: job.jobProgress?.successfullyProcessedRequests ?? null,
    failedRequests: job.jobProgress?.failedRequests ?? null,
    providerEstimatedCostUsd: fireworksMoneyUsd(job.estimatedCost),
  };
}

export function providerOptimizerUpdates(job: FireworksRftJob): number {
  const candidates = [
    findNumericMetric(job.outputMetrics, ["optimizerSteps", "optimizer_steps", "steps"]),
    findNumericMetric(job.outputStats, ["optimizerSteps", "optimizer_steps", "steps"]),
    providerCheckpointUpdates(job),
  ].filter((value): value is number => value != null);
  return candidates.length ? Math.max(0, Math.trunc(Math.max(...candidates))) : 0;
}

function providerCheckpointUpdates(job: FireworksRftJob): number {
  if (!job.outputMetrics) return 0;
  let payload: unknown;
  try {
    payload = JSON.parse(job.outputMetrics) as unknown;
  } catch {
    return 0;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  const epochs = (payload as Record<string, unknown>).epoch_to_evaluation_output;
  if (!epochs || typeof epochs !== "object" || Array.isArray(epochs)) return 0;
  const baseModel = job.trainingConfig?.baseModel;
  return Object.values(epochs as Record<string, unknown>).filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const epoch = value as Record<string, unknown>;
    const checkpoint = epoch.checkpoint_gcs_path;
    const outputModel = epoch.output_model;
    const targetModules = epoch.target_modules;
    return (
      typeof checkpoint === "string" &&
      checkpoint.trim().length > 0 &&
      typeof outputModel === "string" &&
      outputModel.trim().length > 0 &&
      outputModel !== baseModel &&
      Array.isArray(targetModules) &&
      targetModules.some((item) => typeof item === "string" && item.length > 0)
    );
  }).length;
}

function findNumericMetric(value: string | undefined, keys: string[]): number | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return findNumericMetricInValue(parsed, new Set(keys), 0);
  } catch {
    for (const key of keys) {
      const match = new RegExp(`${key}[^0-9]{0,8}([0-9]+)`, "i").exec(value);
      if (match) return Number(match[1]);
    }
    return null;
  }
}

function findNumericMetricInValue(
  value: unknown,
  keys: Set<string>,
  depth: number,
): number | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericMetricInValue(item, keys, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key) && typeof item === "number" && Number.isFinite(item)) return item;
    const found = findNumericMetricInValue(item, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
}

export function boundedProviderPayload(value: string | undefined): string | null {
  return value?.slice(0, 100_000) ?? null;
}

export async function waitForDataset(
  client: FireworksApiClient,
  accountId: string,
  datasetId: string,
): Promise<Awaited<ReturnType<FireworksApiClient["dataset"]>>> {
  const deadline = Date.now() + 60_000;
  let latest = await client.dataset(accountId, datasetId);
  while (latest.state !== "READY" && Date.now() < deadline) {
    if (latest.status?.code && latest.status.code !== "OK") {
      throw new Error(`Fireworks dataset validation failed: ${latest.status.message ?? latest.status.code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    latest = await client.dataset(accountId, datasetId);
  }
  if (latest.state !== "READY") throw new Error("Timed out waiting for Fireworks dataset validation.");
  return latest;
}

const PROVIDER_METRIC_IDENTITY_KEYS = [
  "step",
  "maxSteps",
  "epoch",
  "loss",
  "learningRate",
  "gradientNorm",
  "entropy",
  "meanTokenAccuracy",
  "reward",
  "policyLoss",
  "advantageLoss",
  "inputTokensSeen",
  "memoryBytes",
  "elapsedSeconds",
] as const;

export function stableProviderMetricFingerprint(
  source: "fireworks_sft" | "fireworks_rft",
  value: Record<string, unknown>,
): string {
  return contentHash([
    source,
    Object.fromEntries(
      PROVIDER_METRIC_IDENTITY_KEYS.map((key) => [key, value[key] ?? null]),
    ),
  ]);
}

export function metadataString(job: TrainingJob, key: string): string {
  const value = job.metadata[key];
  if (typeof value !== "string" || !value) throw new Error(`Fireworks job is missing ${key}.`);
  return value;
}

export function metadataNumber(job: TrainingJob, key: string): number | null {
  const value = job.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function artifactKind(filename: string): TrainingArtifact["kind"] {
  const lower = filename.toLowerCase();
  if (lower.includes("adapter") || lower.endsWith(".safetensors")) return "adapter";
  if (lower.includes("metric")) return "metrics";
  if (lower.includes("log")) return "log";
  if (lower.includes("manifest") || lower.endsWith(".json")) return "manifest";
  return "checkpoint";
}

export function safeArtifactName(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  if (!basename || basename === "." || basename === "..") {
    throw new Error("Fireworks returned an invalid artifact filename.");
  }
  return basename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function isConflict(error: unknown): boolean {
  return errorMessage(error).includes("(409)");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
