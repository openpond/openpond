import { randomUUID } from "node:crypto";
import type { ChatModelRef } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  FireworksApiClient,
  resourceId,
  type FireworksDeployment,
} from "./fireworks-client.js";

const HOURLY_COST_USD = 7;
const MAX_DURATION_SECONDS = 10 * 60;
export const FIREWORKS_BASELINE_MAX_ESTIMATED_COST_USD = 1.17;

type Credential = { value: string };

export type PreparedBaselineModels = {
  models: ChatModelRef[];
  release: () => Promise<{ costUsd: number | null }>;
};

export type FireworksBaselineDeploymentUpdate = {
  accountId: string;
  deploymentId: string;
  phase: "validating" | "creating" | "ready" | "deleting" | "deleted" | "failed";
  state: string | null;
  statusCode: string | null;
  statusMessage: string | null;
};

export type FireworksBaselinePrepareOptions = {
  signal?: AbortSignal;
  onDeploymentUpdate?: (
    update: FireworksBaselineDeploymentUpdate,
  ) => Promise<void> | void;
};

export function createFireworksBaselineDeploymentService(deps: {
  resolveCredential: () => Promise<Credential | null>;
  request?: typeof fetch;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
}) {
  async function prepare(
    models: ChatModelRef[],
    options: FireworksBaselinePrepareOptions = {},
  ): Promise<PreparedBaselineModels> {
    const fireworksModels = models.filter((model) =>
      model.providerId === "fireworks");
    if (!fireworksModels.length) {
      return { models, release: async () => ({ costUsd: null }) };
    }
    if (fireworksModels.length !== 1 || models.length !== 1) {
      throw new Error(
        "A bounded Fireworks base-model test supports exactly one model.",
      );
    }

    const credential = await deps.resolveCredential();
    if (!credential?.value.trim()) {
      throw new Error(
        "Save a valid Fireworks provider credential before testing the base model.",
      );
    }
    const client = new FireworksApiClient(credential.value, deps.request);
    const account = await client.resolveAccount();
    const accountId = resourceId(account.name);
    if (!accountId) {
      throw new Error("Fireworks did not return an account identifier.");
    }

    const original = fireworksModels[0]!;
    const startedAt = (deps.now?.() ?? new Date()).getTime();
    const deploymentId = `op-baseline-${contentHash([
      original.modelId,
      startedAt,
      randomUUID(),
    ]).slice(0, 16)}`;
    const deadlineMs = startedAt + MAX_DURATION_SECONDS * 1_000;
    let created = false;
    let released = false;
    let releaseAttempt: Promise<void> | null = null;

    const notify = async (
      phase: FireworksBaselineDeploymentUpdate["phase"],
      deployment: FireworksDeployment | null = null,
    ) => options.onDeploymentUpdate?.({
      accountId,
      deploymentId,
      phase,
      state: nonEmptyText(deployment?.state)
        ?? (phase === "deleted" ? "DELETED" : null),
      statusCode: nonEmptyText(deployment?.status?.code),
      statusMessage: nonEmptyText(deployment?.status?.message),
    });

    try {
      throwIfAborted(options.signal);
      await notify("validating");
      const preview = await client.createDeployment({
        accountId,
        deploymentId,
        baseModel: original.modelId,
        displayName: "OpenPond base-model test",
        description: "Temporary bounded deployment for an OpenPond pre-training test.",
        validateOnly: true,
        acceleratorType: "NVIDIA_H100_80GB",
        enableAddons: false,
        purpose: "bounded-base-model-test",
      });
      assertBoundedDeployment(preview);
      throwIfAborted(options.signal);
      const deployment = await client.createDeployment({
        accountId,
        deploymentId,
        baseModel: original.modelId,
        displayName: "OpenPond base-model test",
        description: "Temporary bounded deployment for an OpenPond pre-training test.",
        validateOnly: false,
        acceleratorType: "NVIDIA_H100_80GB",
        enableAddons: false,
        purpose: "bounded-base-model-test",
      });
      created = true;
      assertBoundedDeployment(deployment);
      await notify("creating", deployment);
      await waitUntilReady({
        client,
        accountId,
        deploymentId,
        deadlineMs,
        now: () => (deps.now?.() ?? new Date()).getTime(),
        delay: deps.delay ?? delay,
        signal: options.signal,
        onDeploymentUpdate: (next) => notify(
          next.state === "READY" ? "ready" : "creating",
          next,
        ),
      });
    } catch (error) {
      if (created) {
        await notify("deleting").catch(() => {});
        await deleteDeployment(client, accountId, deploymentId).catch(() => {});
        await notify("deleted").catch(() => {});
      } else {
        await notify("failed").catch(() => {});
      }
      throw error;
    }

    const deploymentName =
      `accounts/${accountId}/deployments/${deploymentId}`;
    return {
      models: models.map((model) => model.providerId === "fireworks"
        ? { ...model, modelId: `${model.modelId}#${deploymentName}` }
        : model),
      release: async () => {
        if (!released) {
          releaseAttempt ??= (async () => {
            await notify("deleting").catch(() => {});
            await deleteDeployment(client, accountId, deploymentId);
            released = true;
            await notify("deleted").catch(() => {});
          })().finally(() => {
            releaseAttempt = null;
          });
          await releaseAttempt;
        }
        const elapsedMs = Math.max(
          0,
          (deps.now?.() ?? new Date()).getTime() - startedAt,
        );
        return {
          costUsd: roundUsd(Math.min(
            FIREWORKS_BASELINE_MAX_ESTIMATED_COST_USD,
            elapsedMs / 3_600_000 * HOURLY_COST_USD,
          )),
        };
      },
    };
  }

  async function cleanupOrphanedDeployments(): Promise<string[]> {
    const credential = await deps.resolveCredential();
    if (!credential?.value.trim()) return [];
    const client = new FireworksApiClient(credential.value, deps.request);
    const account = await client.resolveAccount();
    const accountId = resourceId(account.name);
    if (!accountId) return [];
    const deployments = await client.listDeployments(accountId);
    const orphaned = deployments.filter((deployment) =>
      (deployment.name ? resourceId(deployment.name) : "").startsWith("op-baseline-")
      && deployment.state !== "DELETED");
    const deleted: string[] = [];
    for (const deployment of orphaned) {
      const deploymentId = resourceId(deployment.name!);
      await deleteDeployment(client, accountId, deploymentId);
      deleted.push(deploymentId);
    }
    return deleted;
  }

  return { prepare, cleanupOrphanedDeployments };
}

async function waitUntilReady(input: {
  client: FireworksApiClient;
  accountId: string;
  deploymentId: string;
  deadlineMs: number;
  now: () => number;
  delay: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  onDeploymentUpdate?: (deployment: FireworksDeployment) => Promise<void> | void;
}): Promise<void> {
  while (input.now() < input.deadlineMs) {
    throwIfAborted(input.signal);
    let deployment: FireworksDeployment;
    try {
      deployment = await input.client.deployment(
        input.accountId,
        input.deploymentId,
      );
    } catch (error) {
      if (!/(404|500|502|503|504|NOT_FOUND)/i.test(errorMessage(error))) {
        throw error;
      }
      await input.delay(Math.min(2_000, input.deadlineMs - input.now()));
      continue;
    }
    assertBoundedDeployment(deployment);
    await input.onDeploymentUpdate?.(deployment);
    if (deployment.state === "READY") return;
    if (deployment.status?.code === "RESOURCE_EXHAUSTED") {
      throw new Error(
        `Fireworks base-model deployment has no available capacity: ${deployment.status.message ?? "RESOURCE_EXHAUSTED"}`,
      );
    }
    if (
      deployment.state === "FAILED"
      || deployment.state === "DELETING"
      || deployment.state === "DELETED"
    ) {
      throw new Error(
        `Fireworks base-model deployment entered ${deployment.state}: ${deployment.status?.message ?? "no provider detail"}`,
      );
    }
    await input.delay(Math.min(2_000, input.deadlineMs - input.now()));
  }
  throw new Error(
    "Fireworks did not make the base model ready before the 10-minute cost limit.",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("The Fireworks base-model test was cancelled.");
}

function assertBoundedDeployment(deployment: FireworksDeployment): void {
  if (deployment.acceleratorCount !== 1) {
    throw new Error(
      "The Fireworks base-model test requires exactly one accelerator.",
    );
  }
  if (
    (deployment.minReplicaCount != null && deployment.minReplicaCount !== 1)
    || (deployment.maxReplicaCount != null && deployment.maxReplicaCount !== 1)
  ) {
    throw new Error(
      "The Fireworks base-model test requires exactly one replica.",
    );
  }
  if (deployment.state === "FAILED") {
    throw new Error(
      `Fireworks base-model deployment validation failed: ${deployment.status?.message ?? "unknown provider error"}`,
    );
  }
}

async function deleteDeployment(
  client: FireworksApiClient,
  accountId: string,
  deploymentId: string,
): Promise<void> {
  try {
    await client.deleteDeployment(accountId, deploymentId);
  } catch (error) {
    if (!/(404|NOT_FOUND)/i.test(errorMessage(error))) throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmptyText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
