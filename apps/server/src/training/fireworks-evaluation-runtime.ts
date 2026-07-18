import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TrainingJob, TrainingPlan } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  FireworksApiClient,
  resourceId,
  type FireworksDeployedModel,
  type FireworksDeployment,
} from "./fireworks-client.js";
import { errorMessage } from "./fireworks-provider-utils.js";

const FIREWORKS_FROZEN_EVALUATION_MAX_ACCELERATOR_COUNT = 1;

export type FireworksEvaluationDeploymentReceipt = {
  stage: "base" | "trained";
  deploymentId: string;
  model: string;
  deploymentBaseModel: string;
  servingMode: "direct" | "multi_lora" | "hot_reload_lora";
  validationOnly: boolean;
  validationState: string | null;
  acceleratorCount: number;
  acceleratorType: string | null;
  precision: string | null;
  enableAddons: boolean;
  enableHotReloadLatestAddon: boolean;
  deploymentShape: string | null;
  createdAt: string | null;
  readyAt: string | null;
  deployedModelId: string | null;
  addonLoadedAt: string | null;
  addonUnloadedAt: string | null;
  addonUnloadStatus: "not_applicable" | "not_loaded" | "unloaded" | "failed";
  deletedAt: string | null;
  deletionStatus: "not_created" | "deleted" | "failed";
  error: string | null;
  durationMs: number;
  estimatedCostUsd: number;
};

type FireworksEvaluationDeploymentLease = {
  accountId: string;
  deploymentId: string;
  stage: "base" | "trained";
  model?: string;
  deployedModelId?: string;
  createdAt: string;
  expiresAt: string;
};

export function evaluationDeploymentLeases(
  job: TrainingJob,
): FireworksEvaluationDeploymentLease[] {
  const raw = job.metadata.activeEvaluationDeployments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.accountId !== "string" ||
      typeof candidate.deploymentId !== "string" ||
      (candidate.stage !== "base" && candidate.stage !== "trained") ||
      typeof candidate.createdAt !== "string" ||
      typeof candidate.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.expiresAt))
    ) {
      return [];
    }
    return [{
      accountId: candidate.accountId,
      deploymentId: candidate.deploymentId,
      stage: candidate.stage,
      model:
        typeof candidate.model === "string" ? candidate.model : undefined,
      deployedModelId:
        typeof candidate.deployedModelId === "string"
          ? candidate.deployedModelId
          : undefined,
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
    }];
  });
}

export function assertBoundedEvaluationDeployment(
  deployment: FireworksDeployment,
  options: {
    requireAddons?: boolean;
    requireHotReloadAddon?: boolean;
  } = {},
): void {
  if (
    deployment.acceleratorCount !==
    FIREWORKS_FROZEN_EVALUATION_MAX_ACCELERATOR_COUNT
  ) {
    throw new Error(
      `Fireworks deployment validation returned ${deployment.acceleratorCount ?? "unknown"} accelerators; bounded evaluation requires exactly one.`,
    );
  }
  if (
    deployment.minReplicaCount != null &&
    deployment.minReplicaCount !== 1
  ) {
    throw new Error(
      `Fireworks deployment validation returned minReplicaCount=${deployment.minReplicaCount}; bounded evaluation requires one replica.`,
    );
  }
  if (
    deployment.maxReplicaCount != null &&
    deployment.maxReplicaCount !== 1
  ) {
    throw new Error(
      `Fireworks deployment validation returned maxReplicaCount=${deployment.maxReplicaCount}; bounded evaluation requires one replica.`,
    );
  }
  if (deployment.state === "FAILED") {
    throw new Error(
      `Fireworks deployment validation failed: ${deployment.status?.message ?? "unknown provider error"}`,
    );
  }
  if (
    deployment.status?.code &&
    deployment.status.code !== "OK" &&
    deployment.status.code !== "0"
  ) {
    throw new Error(
      `Fireworks deployment reported ${deployment.status.code}: ${deployment.status.message ?? "no provider detail"}`,
    );
  }
  if (
    options.requireAddons &&
    (deployment.precision !== "BF16" || deployment.enableAddons !== true)
  ) {
    throw new Error(
      `Fireworks deployment validation returned precision=${deployment.precision ?? "unknown"} and enableAddons=${String(deployment.enableAddons)}; trained LoRA evaluation requires a BF16 addon deployment.`,
    );
  }
  if (
    options.requireHotReloadAddon &&
    deployment.enableHotReloadLatestAddon !== true
  ) {
    throw new Error(
      "Fireworks deployment validation did not preserve the required hot-reload LoRA merge setting.",
    );
  }
}

export async function waitForEvaluationDeployment(input: {
  client: FireworksApiClient;
  accountId: string;
  deploymentId: string;
  deadlineMs: number;
  requireAddons?: boolean;
  requireHotReloadAddon?: boolean;
}): Promise<FireworksDeployment> {
  while (true) {
    const deployment = await readEvaluationDeployment(input);
    assertBoundedEvaluationDeployment(deployment, {
      requireAddons: input.requireAddons,
      requireHotReloadAddon: input.requireHotReloadAddon,
    });
    if (deployment.state === "READY") return deployment;
    if (
      deployment.state === "FAILED" ||
      deployment.state === "DELETING" ||
      deployment.state === "DELETED"
    ) {
      throw new Error(
        `Fireworks evaluation deployment ${input.deploymentId} entered ${deployment.state}: ${deployment.status?.message ?? "no provider detail"}`,
      );
    }
    const remainingMs = input.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Fireworks evaluation deployment ${input.deploymentId} did not become ready before the bounded runtime expired.`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(2_000, remainingMs)),
    );
  }
}

async function readEvaluationDeployment(input: {
  client: FireworksApiClient;
  accountId: string;
  deploymentId: string;
  deadlineMs: number;
}): Promise<FireworksDeployment> {
  try {
    return await input.client.deployment(
      input.accountId,
      input.deploymentId,
    );
  } catch (error) {
    if (!/failed \((404|500|502|503|504)\)/i.test(errorMessage(error))) {
      throw error;
    }
    const deployments = await input.client.listDeployments(input.accountId);
    const deployment = deployments.find(
      (candidate) => resourceId(candidate.name ?? "") === input.deploymentId,
    );
    if (deployment) return deployment;
    return retryFireworksControlPlane(
      () => input.client.deployment(
        input.accountId,
        input.deploymentId,
      ),
      input.deadlineMs,
    );
  }
}

export async function waitForEvaluationLora(input: {
  client: FireworksApiClient;
  accountId: string;
  deployedModelId: string;
  deadlineMs: number;
}): Promise<FireworksDeployedModel> {
  while (true) {
    const deployedModel = await retryFireworksControlPlane(
      () => input.client.deployedModel(
        input.accountId,
        input.deployedModelId,
      ),
      input.deadlineMs,
    );
    if (deployedModel.state === "DEPLOYED") return deployedModel;
    if (deployedModel.state === "UNDEPLOYING") {
      throw new Error(
        `Fireworks LoRA ${input.deployedModelId} began unloading before evaluation.`,
      );
    }
    if (
      deployedModel.status?.code &&
      deployedModel.status.code !== "OK" &&
      deployedModel.status.code !== "0"
    ) {
      throw new Error(
        `Fireworks LoRA ${input.deployedModelId} failed to load: ${deployedModel.status.message ?? deployedModel.status.code}`,
      );
    }
    const remainingMs = input.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Fireworks LoRA ${input.deployedModelId} did not become ready before the bounded runtime expired.`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(2_000, remainingMs)),
    );
  }
}

export async function unloadEvaluationLoras(input: {
  client: FireworksApiClient;
  accountId: string;
  deploymentName: string;
  model?: string;
  deployedModelId?: string;
}): Promise<string[]> {
  let deployedModelIds = input.deployedModelId
    ? [input.deployedModelId]
    : [];
  if (!deployedModelIds.length) {
    const deployedModels = await input.client.listDeployedModels(input.accountId);
    deployedModelIds = deployedModels
      .filter(
        (candidate) =>
          candidate.deployment === input.deploymentName &&
          (!input.model || candidate.model === input.model),
      )
      .map((candidate) => resourceId(candidate.name ?? ""))
      .filter(Boolean);
  }
  const uniqueIds = [...new Set(deployedModelIds)];
  for (const deployedModelId of uniqueIds) {
    try {
      await input.client.unloadLora(input.accountId, deployedModelId);
    } catch (error) {
      if (!/\(404\)/.test(errorMessage(error))) throw error;
    }
  }
  return uniqueIds;
}

export async function retryFireworksInference<T>(
  request: () => Promise<T>,
  evaluationDeadlineMs: number,
): Promise<T> {
  const deadlineMs = Math.min(
    evaluationDeadlineMs,
    Date.now() + 60_000,
  );
  while (true) {
    try {
      return await request();
    } catch (error) {
      const message = errorMessage(error);
      if (
        !/failed \((404|503)\)/i.test(message) ||
        Date.now() >= deadlineMs
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2_000, deadlineMs - Date.now())),
      );
    }
  }
}

export async function retryFireworksControlPlane<T>(
  request: () => Promise<T>,
  evaluationDeadlineMs: number,
): Promise<T> {
  const deadlineMs = Math.min(
    evaluationDeadlineMs,
    Date.now() + 60_000,
  );
  while (true) {
    try {
      return await request();
    } catch (error) {
      const message = errorMessage(error);
      if (
        !/failed \((404|500|502|503|504)\)/i.test(message) ||
        Date.now() >= deadlineMs
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2_000, deadlineMs - Date.now())),
      );
    }
  }
}

export function frozenEvaluationAttemptId(
  jobId: string,
  stage: "base" | "trained",
  taskId: string,
  evaluationAttemptId: string,
): string {
  return `attempt_${contentHash([
    jobId,
    stage,
    taskId,
    evaluationAttemptId,
  ]).slice(0, 24)}`;
}

export async function withFireworksEvaluationExecutionLock<T>(input: {
  directory: string;
  jobId: string;
  maxRuntimeMs: number;
  execute: () => Promise<T>;
  readCompleted: () => Promise<T | null>;
}): Promise<T> {
  await mkdir(input.directory, { recursive: true });
  const lockPath = path.join(
    input.directory,
    `.frozen-evaluation-${contentHash(input.jobId).slice(0, 16)}.lock`,
  );
  const joinDeadlineMs = Date.now() + input.maxRuntimeMs + 60_000;
  while (true) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(joinDeadlineMs).toISOString(),
        }), "utf8");
      } finally {
        await handle.close();
      }
      try {
        return await input.execute();
      } finally {
        try {
          const lease = JSON.parse(await readFile(lockPath, "utf8")) as {
            token?: unknown;
          };
          if (lease.token === token) await unlink(lockPath);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
        }
      }
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }

    while (true) {
      const lease = await readEvaluationExecutionLease(lockPath);
      if (!lease) break;
      const expired = Date.parse(lease.expiresAt) <= Date.now();
      const ownerAlive = processIsAlive(lease.pid);
      if (expired || !ownerAlive) {
        await unlink(lockPath).catch((error) => {
          if (!isMissingFileError(error)) throw error;
        });
        break;
      }
      if (Date.now() >= joinDeadlineMs) {
        throw new Error(
          `Timed out waiting for the in-progress frozen evaluation for ${input.jobId}.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const completed = await input.readCompleted();
    if (completed != null) return completed;
  }
}

export function selectFireworksEvaluationAccelerator(
  priorDeployments: unknown[],
  stage: "base" | "trained",
): "NVIDIA_A100_80GB" | "NVIDIA_H100_80GB" {
  const stageDeployments = priorDeployments.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const deployment = value as Record<string, unknown>;
    return deployment.stage === stage ? [deployment] : [];
  });
  const latestSuccessfulDeployment = [...stageDeployments]
    .filter((deployment) =>
      typeof deployment.readyAt === "string" &&
      !deployment.error &&
      (
        deployment.acceleratorType === "NVIDIA_A100_80GB" ||
        deployment.acceleratorType === "NVIDIA_H100_80GB"
      ))
    .sort((left, right) =>
      Number(right.evaluationAttemptNumber ?? 0) -
      Number(left.evaluationAttemptNumber ?? 0))[0];
  if (
    latestSuccessfulDeployment?.acceleratorType === "NVIDIA_A100_80GB" ||
    latestSuccessfulDeployment?.acceleratorType === "NVIDIA_H100_80GB"
  ) {
    return latestSuccessfulDeployment.acceleratorType;
  }
  const stageFailures = priorDeployments.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const deployment = value as Record<string, unknown>;
    return (
      deployment.stage === stage &&
      typeof deployment.error === "string"
    )
      ? [deployment]
      : [];
  });
  const latestFailure = [...stageFailures].sort((left, right) =>
    Number(right.evaluationAttemptNumber ?? 0) -
    Number(left.evaluationAttemptNumber ?? 0))[0];
  if (
    latestFailure?.acceleratorType === "NVIDIA_A100_80GB" &&
    /internal error|initializing model server/i.test(
      String(latestFailure.error),
    )
  ) {
    return "NVIDIA_H100_80GB";
  }
  if (
    latestFailure?.acceleratorType === "NVIDIA_H100_80GB" &&
    /internal error|initializing model server/i.test(
      String(latestFailure.error),
    ) &&
    stageFailures.some((deployment) =>
      deployment.acceleratorType === "NVIDIA_A100_80GB" &&
      /internal error|initializing model server/i.test(
        String(deployment.error),
      ))
  ) {
    return "NVIDIA_H100_80GB";
  }
  const h100CapacityFailures = priorDeployments.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const deployment = value as Record<string, unknown>;
    return (
      deployment.stage === stage &&
      deployment.acceleratorType === "NVIDIA_H100_80GB" &&
      typeof deployment.error === "string" &&
      /RESOURCE_EXHAUSTED|no available capacity/i.test(deployment.error)
    );
  }).length;
  return h100CapacityFailures >= 2
    ? "NVIDIA_A100_80GB"
    : "NVIDIA_H100_80GB";
}

export function selectFireworksTrainedServingMode(
  priorDeployments: unknown[],
  configuredMode: unknown,
): "direct" | "hot_reload_lora" | "multi_lora" {
  if (configuredMode === "multi_lora") return "multi_lora";
  const latestSuccessfulMode = priorDeployments
    .flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const deployment = value as Record<string, unknown>;
      return (
        deployment.stage === "trained" &&
        typeof deployment.readyAt === "string" &&
        !deployment.error &&
        (
          deployment.servingMode === "direct" ||
          deployment.servingMode === "hot_reload_lora" ||
          deployment.servingMode === "multi_lora"
        )
      )
        ? [deployment]
        : [];
    })
    .sort((left, right) =>
      Number(right.evaluationAttemptNumber ?? 0) -
      Number(left.evaluationAttemptNumber ?? 0))[0];
  if (
    latestSuccessfulMode?.servingMode === "direct" ||
    latestSuccessfulMode?.servingMode === "hot_reload_lora" ||
    latestSuccessfulMode?.servingMode === "multi_lora"
  ) {
    return latestSuccessfulMode.servingMode;
  }
  const latestFailure = priorDeployments
    .flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const deployment = value as Record<string, unknown>;
      return (
        deployment.stage === "trained" &&
        typeof deployment.servingMode === "string" &&
        typeof deployment.error === "string"
      )
        ? [deployment]
        : [];
    })
    .sort((left, right) =>
      Number(right.evaluationAttemptNumber ?? 0) -
      Number(left.evaluationAttemptNumber ?? 0))[0];
  const directInternalFailure = priorDeployments.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const deployment = value as Record<string, unknown>;
    return (
      deployment.stage === "trained" &&
      deployment.servingMode === "direct" &&
      typeof deployment.error === "string" &&
      /internal error|live.?merge|deployment/i.test(deployment.error)
    );
  });
  if (
    latestFailure?.servingMode === "multi_lora" &&
    /internal error|addon|lora/i.test(String(latestFailure.error))
  ) {
    if (
      directInternalFailure &&
      latestFailure.acceleratorType === "NVIDIA_H100_80GB"
    ) {
      return "hot_reload_lora";
    }
    return directInternalFailure ? "multi_lora" : "direct";
  }
  if (
    latestFailure?.servingMode === "direct" &&
    /internal error|live.?merge|deployment/i.test(String(latestFailure.error))
  ) {
    return "multi_lora";
  }
  if (
    latestFailure?.servingMode === "hot_reload_lora" &&
    /internal error|hot.?reload|addon/i.test(String(latestFailure.error))
  ) {
    return "multi_lora";
  }
  if (
    latestFailure?.servingMode === "multi_lora" &&
    /RESOURCE_EXHAUSTED|no available capacity/i.test(
      String(latestFailure.error),
    )
  ) {
    return "multi_lora";
  }
  return "hot_reload_lora";
}

async function readEvaluationExecutionLease(lockPath: string): Promise<{
  pid: number;
  expiresAt: string;
} | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      return { pid: -1, expiresAt: new Date(0).toISOString() };
    }
    return { pid: value.pid, expiresAt: value.expiresAt };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    return { pid: -1, expiresAt: new Date(0).toISOString() };
  }
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isFileExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function executableBaseRecipe(plan: TrainingPlan) {
  return plan.recipe.method === "sft" || plan.recipe.method === "grpo"
    ? plan.recipe
    : null;
}
