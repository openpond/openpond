import { randomUUID } from "node:crypto";
import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";
import {
  FireworksModelServingSessionSchema,
  type FireworksModelServingSession,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  FireworksApiClient,
  resourceId,
  type FireworksDeployedModel,
  type FireworksDeployment,
} from "./fireworks-client.js";
import { resolveModelLineageIdForRuntime } from "./local-adapter-chat-runtime.js";

const HOURLY_COST_USD = 7;
const IDLE_TIMEOUT_SECONDS = 5 * 60;
const MAX_DURATION_SECONDS = 10 * 60;
const MAX_ESTIMATED_COST_USD = 1.17;
const ACTIVE_STATES = new Set(["starting", "ready", "stopping"]);

type Credential = {
  value: string;
};

export type FireworksServingDelta = {
  text?: string;
  usage?: unknown;
  finishReason?: string;
  toolCalls?: HostedChatToolCall[];
  raw?: unknown;
};

export function createFireworksServingService(deps: {
  store: SqliteStore;
  resolveCredential: () => Promise<Credential | null>;
  request?: typeof fetch;
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}) {
  const runtimeId = `fireworks_serving_runtime_${randomUUID()}`;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stopRequests = new Set<string>();
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let reconcilePromise: Promise<void> | null = null;

  function timestamp(): string {
    return (deps.now?.() ?? new Date()).toISOString();
  }

  async function update(
    session: FireworksModelServingSession,
    patch: Partial<FireworksModelServingSession>,
  ): Promise<FireworksModelServingSession> {
    return deps.store.saveFireworksModelServingSession(
      FireworksModelServingSessionSchema.parse({
        ...session,
        ...patch,
      }),
    );
  }

  async function modelContext(modelId: string) {
    const lineageId = await resolveModelLineageIdForRuntime(
      deps.store,
      modelId,
    );
    const lineage = await deps.store.getModelArtifactLineage(lineageId);
    if (!lineage || lineage.status !== "imported") {
      throw new Error("The selected Model is not an imported adapter.");
    }
    const [job, taskset] = await Promise.all([
      deps.store.getTrainingJob(lineage.jobId),
      deps.store.getTaskset(lineage.tasksetId),
    ]);
    if (!job || job.status !== "succeeded") {
      throw new Error("The selected Model does not have a successful training receipt.");
    }
    const provider = job.metadata.provider;
    if (provider !== "fireworks" && job.destinationId !== "fireworks") {
      return null;
    }
    if (!taskset) throw new Error("The selected Model Taskset was not found.");
    const outputModel = metadataString(job.metadata, "outputModelName");
    const baseModel = metadataString(job.metadata, "baseModel");
    if (!outputModel || !baseModel) {
      throw new Error("The Fireworks Model receipt is missing its output or base model.");
    }
    return { lineage, job, taskset, outputModel, baseModel };
  }

  async function appliesTo(modelId: string | null | undefined): Promise<boolean> {
    if (!modelId) return false;
    return Boolean(await modelContext(modelId));
  }

  async function start(input: {
    profileId: string;
    modelId: string;
  }): Promise<FireworksModelServingSession> {
    const context = await modelContext(input.modelId);
    if (!context) {
      throw new Error("This Model runs locally and does not need Fireworks serving.");
    }
    if (context.taskset.profileId !== input.profileId) {
      throw new Error("The selected Model does not belong to the active Profile.");
    }
    const sessions = await deps.store.listFireworksModelServingSessions();
    const reusable = sessions.find(
      (session) =>
        session.runtimeId === runtimeId
        && session.modelArtifactLineageId === context.lineage.id
        && (session.state === "starting" || session.state === "ready"),
    );
    if (reusable) return withCurrentCost(reusable);

    for (const active of sessions.filter((session) =>
      ACTIVE_STATES.has(session.state))) {
      await stop(active.id, "user");
    }

    const createdAt = timestamp();
    const suffix = contentHash([
      context.lineage.id,
      createdAt,
      randomUUID(),
    ]).slice(0, 16);
    const session = FireworksModelServingSessionSchema.parse({
      schemaVersion: "openpond.fireworksModelServingSession.v1",
      id: `fireworks_serving_${suffix}`,
      runtimeId,
      profileId: input.profileId,
      modelArtifactLineageId: context.lineage.id,
      jobId: context.job.id,
      tasksetId: context.taskset.id,
      provider: "fireworks",
      state: "starting",
      accountId: null,
      baseModel: context.baseModel,
      outputModel: context.outputModel,
      deploymentId: `op-use-${suffix}`,
      deployedModelId: null,
      acceleratorType: "NVIDIA_H100_80GB",
      acceleratorCount: 1,
      hourlyCostUsd: HOURLY_COST_USD,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      maxDurationSeconds: MAX_DURATION_SECONDS,
      maxEstimatedCostUsd: MAX_ESTIMATED_COST_USD,
      estimatedCostUsd: 0,
      createdAt,
      readyAt: null,
      lastUsedAt: null,
      stopRequestedAt: null,
      stoppedAt: null,
      updatedAt: createdAt,
      stopReason: null,
      error: null,
    });
    await deps.store.saveFireworksModelServingSession(session);
    void provision(session.id);
    return session;
  }

  async function provision(sessionId: string): Promise<void> {
    let client: FireworksApiClient | null = null;
    let accountId: string | null = null;
    try {
      const session = await requiredSession(sessionId);
      const credential = await deps.resolveCredential();
      if (!credential?.value.trim()) {
        throw new Error("Save a valid Fireworks provider credential before serving.");
      }
      client = new FireworksApiClient(credential.value, deps.request);
      const account = await client.resolveAccount();
      accountId = resourceId(account.name);
      if (!accountId) throw new Error("Fireworks did not return an account identifier.");
      await update(session, {
        accountId,
        updatedAt: timestamp(),
      });
      assertNotStopping(sessionId);
      const preview = await client.createDeployment({
        accountId,
        deploymentId: session.deploymentId,
        baseModel: session.baseModel,
        displayName: "OpenPond model chat",
        description: "Temporary bounded deployment for OpenPond Model chat.",
        validateOnly: true,
        acceleratorType: session.acceleratorType,
        enableHotReloadLatestAddon: true,
        purpose: "bounded-model-chat",
      });
      assertBoundedDeployment(preview);
      assertNotStopping(sessionId);
      const deployment = await client.createDeployment({
        accountId,
        deploymentId: session.deploymentId,
        baseModel: session.baseModel,
        displayName: "OpenPond model chat",
        description: "Temporary bounded deployment for OpenPond Model chat.",
        validateOnly: false,
        acceleratorType: session.acceleratorType,
        enableHotReloadLatestAddon: true,
        purpose: "bounded-model-chat",
      });
      assertBoundedDeployment(deployment);
      await waitForDeployment({
        client,
        accountId,
        deploymentId: session.deploymentId,
        deadlineMs: deadline(session),
        nowMs: () => (deps.now?.() ?? new Date()).getTime(),
      });
      assertNotStopping(sessionId);
      const deployed = await client.loadLora({
        accountId,
        model: session.outputModel,
        deployment: `accounts/${accountId}/deployments/${session.deploymentId}`,
        displayName: "OpenPond model chat LoRA",
        description: "Temporary LoRA attachment for bounded OpenPond Model chat.",
        replaceMergedAddon: true,
      });
      const deployedModelId = resourceId(deployed.name ?? "");
      if (!deployedModelId) {
        throw new Error("Fireworks did not return a deployed LoRA identifier.");
      }
      await update(await requiredSession(sessionId), {
        deployedModelId,
        updatedAt: timestamp(),
      });
      await waitForLora({
        client,
        accountId,
        deployedModelId,
        deadlineMs: deadline(session),
        nowMs: () => (deps.now?.() ?? new Date()).getTime(),
      });
      assertNotStopping(sessionId);
      const readyAt = timestamp();
      const ready = await update(await requiredSession(sessionId), {
        state: "ready",
        readyAt,
        lastUsedAt: readyAt,
        updatedAt: readyAt,
        error: null,
      });
      schedule(ready);
    } catch (error) {
      const existing = await deps.store.getFireworksModelServingSession(sessionId);
      if (!existing) return;
      const requested = stopRequests.has(sessionId);
      const cleanupError = client && accountId
        ? await cleanupProvider(client, accountId, existing)
        : null;
      const stoppedAt = timestamp();
      await deps.store.saveFireworksModelServingSession({
        ...existing,
        state: requested && !cleanupError ? "stopped" : "failed",
        estimatedCostUsd: estimatedCost(existing, stoppedAt),
        stopReason: requested ? existing.stopReason ?? "user" : "startup_error",
        stopRequestedAt: existing.stopRequestedAt ?? stoppedAt,
        stoppedAt,
        updatedAt: stoppedAt,
        error: [errorMessage(error), cleanupError].filter(Boolean).join(" Cleanup: ") || null,
      });
    } finally {
      stopRequests.delete(sessionId);
    }
  }

  async function stop(
    sessionId: string,
    reason: FireworksModelServingSession["stopReason"] = "user",
  ): Promise<FireworksModelServingSession> {
    const current = await requiredSession(sessionId);
    if (current.state === "stopped") return current;
    const wasStarting = current.state === "starting";
    stopRequests.add(sessionId);
    unschedule(sessionId);
    const stopRequestedAt = timestamp();
    let stopping = await update(current, {
      state: "stopping",
      stopReason: reason,
      stopRequestedAt,
      updatedAt: stopRequestedAt,
    });
    const credential = await deps.resolveCredential();
    let cleanupError: string | null = null;
    if (credential?.value.trim() && stopping.accountId) {
      const client = new FireworksApiClient(credential.value, deps.request);
      cleanupError = await cleanupProvider(client, stopping.accountId, stopping);
    } else if (stopping.accountId) {
      cleanupError =
        "The Fireworks credential is unavailable, so provider cleanup could not be confirmed.";
    }
    const stoppedAt = timestamp();
    stopping = await update(stopping, {
      state: cleanupError ? "failed" : "stopped",
      estimatedCostUsd: estimatedCost(stopping, stoppedAt),
      stoppedAt,
      updatedAt: stoppedAt,
      error: cleanupError,
    });
    if (!wasStarting) stopRequests.delete(sessionId);
    return stopping;
  }

  async function list(
    profileId?: string,
  ): Promise<FireworksModelServingSession[]> {
    const sessions = await deps.store.listFireworksModelServingSessions({
      profileId,
    });
    return sessions.map(withCurrentCost);
  }

  function reconcile(): Promise<void> {
    if (reconcilePromise) return reconcilePromise;
    const execution = performReconcile();
    reconcilePromise = execution;
    return execution.finally(() => {
      if (reconcilePromise === execution) reconcilePromise = null;
    });
  }

  async function performReconcile(): Promise<void> {
    const sessions = await deps.store.listFireworksModelServingSessions();
    for (const session of sessions) {
      if (!ACTIVE_STATES.has(session.state)) continue;
      if (session.runtimeId !== runtimeId) {
        await stop(session.id, "restart_cleanup");
        continue;
      }
      if (shouldStopForDuration(session)) {
        await stop(session.id, "duration");
        continue;
      }
      if (shouldStopForBudget(session)) {
        await stop(session.id, "budget");
        continue;
      }
      if (shouldStopForIdle(session)) {
        await stop(session.id, "idle");
        continue;
      }
      schedule(session);
    }
  }

  async function* stream(input: {
    modelId: string | null | undefined;
    messages: HostedChatMessage[];
    requestId: string;
    signal: AbortSignal;
    maxNewTokens?: number;
    temperature?: number;
    tools?: HostedChatTool[];
    toolChoice?: HostedChatToolChoice;
  }): AsyncGenerator<FireworksServingDelta, void, unknown> {
    if (!input.modelId) throw new Error("Select a Model before chatting.");
    const context = await modelContext(input.modelId);
    if (!context) throw new Error("The selected Model does not use Fireworks serving.");
    const sessions = await deps.store.listFireworksModelServingSessions({
      modelArtifactLineageId: context.lineage.id,
    });
    const session = sessions.find(
      (candidate) =>
        candidate.runtimeId === runtimeId && candidate.state === "ready",
    );
    if (!session?.accountId) {
      throw new Error("Start Fireworks serving for this Model before chatting.");
    }
    if (input.signal.aborted) throw input.signal.reason;
    const credential = await deps.resolveCredential();
    if (!credential?.value.trim()) {
      throw new Error("The Fireworks provider credential is unavailable.");
    }
    const touchedAt = timestamp();
    const touched = await update(session, {
      lastUsedAt: touchedAt,
      updatedAt: touchedAt,
    });
    schedule(touched);
    const client = new FireworksApiClient(credential.value, deps.request);
    const deploymentName =
      `accounts/${session.accountId}/deployments/${session.deploymentId}`;
    const completion = await client.chatCompletionWithTools({
      model: `${session.outputModel}#${deploymentName}`,
      messages: input.messages,
      tools: input.tools,
      toolChoice: input.toolChoice,
      maxTokens: input.maxNewTokens ?? 512,
      temperature: input.temperature ?? 0,
      reasoningEffort: "none",
    });
    if (completion.text) {
      yield {
        text: completion.text,
        raw: { provider: "fireworks", requestId: input.requestId },
      };
    }
    if (completion.toolCalls.length) {
      yield {
        toolCalls: completion.toolCalls,
        raw: { provider: "fireworks", requestId: input.requestId },
      };
    }
    yield { usage: completion.usage };
    yield {
      finishReason: completion.toolCalls.length ? "tool_calls" : "stop",
    };
    const usedAt = timestamp();
    const used = await update(await requiredSession(session.id), {
      lastUsedAt: usedAt,
      estimatedCostUsd: estimatedCost(session, usedAt),
      updatedAt: usedAt,
    });
    schedule(used);
  }

  async function close(): Promise<void> {
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    const sessions = await deps.store.listFireworksModelServingSessions();
    for (const session of sessions.filter(
      (candidate) =>
        candidate.runtimeId === runtimeId && ACTIVE_STATES.has(candidate.state),
    )) {
      await stop(session.id, "shutdown");
    }
  }

  function schedule(session: FireworksModelServingSession): void {
    unschedule(session.id);
    if (session.state !== "ready") return;
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    const durationAt =
      Date.parse(session.createdAt) + session.maxDurationSeconds * 1_000;
    const idleAt =
      Date.parse(session.lastUsedAt ?? session.readyAt ?? session.createdAt)
      + session.idleTimeoutSeconds * 1_000;
    const delayMs = Math.max(0, Math.min(durationAt, idleAt) - nowMs);
    timers.set(
      session.id,
      setTimer(() => {
        timers.delete(session.id);
        void reconcile();
      }, delayMs),
    );
  }

  function unschedule(sessionId: string): void {
    const timer = timers.get(sessionId);
    if (timer) clearTimer(timer);
    timers.delete(sessionId);
  }

  function assertNotStopping(sessionId: string): void {
    if (stopRequests.has(sessionId)) {
      throw new Error("Fireworks serving was stopped during startup.");
    }
  }

  async function requiredSession(
    sessionId: string,
  ): Promise<FireworksModelServingSession> {
    const session = await deps.store.getFireworksModelServingSession(sessionId);
    if (!session) throw new Error("Fireworks serving session was not found.");
    return session;
  }

  function withCurrentCost(
    session: FireworksModelServingSession,
  ): FireworksModelServingSession {
    if (!ACTIVE_STATES.has(session.state)) return session;
    return {
      ...session,
      estimatedCostUsd: estimatedCost(session, timestamp()),
    };
  }

  function shouldStopForDuration(session: FireworksModelServingSession): boolean {
    return Date.parse(timestamp()) >= deadline(session);
  }

  function shouldStopForBudget(session: FireworksModelServingSession): boolean {
    return estimatedCost(session, timestamp()) >= session.maxEstimatedCostUsd;
  }

  function shouldStopForIdle(session: FireworksModelServingSession): boolean {
    if (session.state !== "ready") return false;
    const lastUse = Date.parse(
      session.lastUsedAt ?? session.readyAt ?? session.createdAt,
    );
    return Date.parse(timestamp()) - lastUse >= session.idleTimeoutSeconds * 1_000;
  }

  return {
    appliesTo,
    start,
    stop,
    list,
    reconcile,
    stream,
    close,
  };
}

async function cleanupProvider(
  client: FireworksApiClient,
  accountId: string,
  session: FireworksModelServingSession,
): Promise<string | null> {
  const errors: string[] = [];
  if (session.deployedModelId) {
    try {
      await client.unloadLora(accountId, session.deployedModelId);
    } catch (error) {
      if (!/\(404\)/.test(errorMessage(error))) errors.push(errorMessage(error));
    }
  }
  try {
    await client.deleteDeployment(accountId, session.deploymentId);
  } catch (error) {
    if (!/\(404\)/.test(errorMessage(error))) errors.push(errorMessage(error));
  }
  return errors.length ? errors.join("; ") : null;
}

async function waitForDeployment(input: {
  client: FireworksApiClient;
  accountId: string;
  deploymentId: string;
  deadlineMs: number;
  nowMs: () => number;
}): Promise<FireworksDeployment> {
  while (input.nowMs() < input.deadlineMs) {
    let deployment: FireworksDeployment;
    try {
      deployment = await input.client.deployment(
        input.accountId,
        input.deploymentId,
      );
    } catch (error) {
      if (!/\((404|500|502|503|504)\)/.test(errorMessage(error))) throw error;
      await delay(Math.min(2_000, input.deadlineMs - input.nowMs()));
      continue;
    }
    assertBoundedDeployment(deployment);
    if (deployment.state === "READY") return deployment;
    if (
      deployment.state === "FAILED"
      || deployment.state === "DELETING"
      || deployment.state === "DELETED"
    ) {
      throw new Error(
        `Fireworks serving deployment entered ${deployment.state}: ${deployment.status?.message ?? "no provider detail"}`,
      );
    }
    await delay(Math.min(2_000, input.deadlineMs - input.nowMs()));
  }
  throw new Error("Fireworks serving did not become ready before its cost limit.");
}

async function waitForLora(input: {
  client: FireworksApiClient;
  accountId: string;
  deployedModelId: string;
  deadlineMs: number;
  nowMs: () => number;
}): Promise<FireworksDeployedModel> {
  while (input.nowMs() < input.deadlineMs) {
    let deployed: FireworksDeployedModel;
    try {
      deployed = await input.client.deployedModel(
        input.accountId,
        input.deployedModelId,
      );
    } catch (error) {
      if (!/\((404|500|502|503|504)\)/.test(errorMessage(error))) throw error;
      await delay(Math.min(2_000, input.deadlineMs - input.nowMs()));
      continue;
    }
    if (deployed.state === "DEPLOYED") return deployed;
    if (deployed.state === "UNDEPLOYING") {
      throw new Error("Fireworks unloaded the LoRA during startup.");
    }
    if (
      deployed.status?.code
      && deployed.status.code !== "OK"
      && deployed.status.code !== "0"
    ) {
      throw new Error(
        `Fireworks failed to load the LoRA: ${deployed.status.message ?? deployed.status.code}`,
      );
    }
    await delay(Math.min(2_000, input.deadlineMs - input.nowMs()));
  }
  throw new Error("Fireworks did not load the LoRA before its cost limit.");
}

function assertBoundedDeployment(deployment: FireworksDeployment): void {
  if (deployment.acceleratorCount !== 1) {
    throw new Error("Bounded Model chat requires exactly one Fireworks accelerator.");
  }
  if (
    (deployment.minReplicaCount != null && deployment.minReplicaCount !== 1)
    || (deployment.maxReplicaCount != null && deployment.maxReplicaCount !== 1)
  ) {
    throw new Error("Bounded Model chat requires exactly one Fireworks replica.");
  }
  if (deployment.enableHotReloadLatestAddon !== true) {
    throw new Error("Fireworks did not preserve hot-reload LoRA serving.");
  }
  if (deployment.state === "FAILED") {
    throw new Error(
      `Fireworks deployment validation failed: ${deployment.status?.message ?? "unknown provider error"}`,
    );
  }
}

function estimatedCost(
  session: FireworksModelServingSession,
  at: string,
): number {
  const elapsedSeconds = Math.max(
    0,
    (Date.parse(at) - Date.parse(session.createdAt)) / 1_000,
  );
  return roundUsd(
    Math.min(
      session.maxEstimatedCostUsd,
      elapsedSeconds / 3_600 * session.hourlyCostUsd,
    ),
  );
}

function deadline(session: FireworksModelServingSession): number {
  return Date.parse(session.createdAt) + session.maxDurationSeconds * 1_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}
