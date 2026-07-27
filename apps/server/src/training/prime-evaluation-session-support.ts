import { createServer } from "node:net";
import {
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { ChatModelRef } from "@openpond/contracts";
import type { HostedChatToolCall } from "@openpond/cloud";
import { PrimeRawComputeHttpClient } from "@openpond/compute-provider-prime";
import { canonicalJson, contentHash } from "@openpond/taskset-sdk";

import type { PrimeGrpoBaseProfile } from "./prime-grpo-base-profiles.js";
import { createPrimeRolloutSshTransport } from "./prime-rollout-ssh.js";
import type {
  FireworksBaselinePrepareOptions,
  PreparedBaselineModels,
} from "./fireworks-baseline-deployment.js";

export const PRIME_EVALUATION_MARKER_PREFIX = "openpond-prime-eval:";
const MARKER_PREFIX = PRIME_EVALUATION_MARKER_PREFIX;

export type PrimeEvaluationAdapterInput = {
  directory: string;
  configSha256: string;
  weightsSha256: string;
};

export type PrimeEvaluationRequestFact = {
  requestId: string;
  servedModel: string;
  responseModel: string;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  toolCallCount: number;
};

export type PrimeEvaluationLiveSession = {
  id: string;
  localPort: number;
  aliases: Map<string, string>;
  requests: PrimeEvaluationRequestFact[];
  signal: AbortSignal;
  models: {
    base: ChatModelRef;
    candidate: ChatModelRef | null;
  };
  resource: {
    nodeId: string;
    deviceOrPool: string;
    gpuType: string;
  };
  release(): Promise<{
    costUsd: number | null;
    receiptPath: string;
  }>;
};

type StartPrimeEvaluationSession = (options: {
  purpose: "train-signal" | "frozen-benchmark";
  adapter?: PrimeEvaluationAdapterInput | null;
  baseProfile?: PrimeGrpoBaseProfile;
  signal?: AbortSignal;
}) => Promise<PrimeEvaluationLiveSession>;

export async function preparePrimeEvaluationBaselineModels(
  models: ChatModelRef[],
  options: FireworksBaselinePrepareOptions,
  start: StartPrimeEvaluationSession,
  resolveBaseProfile: (modelId: string) => PrimeGrpoBaseProfile | null,
): Promise<PreparedBaselineModels> {
  const exact = models.flatMap((model) => {
    if (model.providerId !== "custom-openai-compatible") return [];
    const baseProfile = resolveBaseProfile(model.modelId);
    return baseProfile ? [{ model, baseProfile }] : [];
  });
  if (!exact.length) {
    return {
      models,
      release: async () => ({ costUsd: null }),
    };
  }
  if (models.length !== 1 || exact.length !== 1) {
    throw new Error(
      "The raw-Prime Qwen signal check supports exactly one pinned base model.",
    );
  }
  const session = await start({
    purpose: "train-signal",
    signal: options.signal,
    baseProfile: exact[0]!.baseProfile,
  });
  return {
    models: [{
      providerId: "custom-openai-compatible",
      modelId: marker(session.id, "base"),
    }],
    release: async () => {
      const released = await session.release();
      return { costUsd: released.costUsd };
    },
  };
}

export async function cleanupPrimeEvaluationSessions(input: {
  live: Map<string, PrimeEvaluationLiveSession>;
  storeDir: string;
  resolveProvider(): Promise<{
    privateKeyPath: string;
    client: PrimeRawComputeHttpClient;
  }>;
  now(): Date;
}): Promise<string[]> {
  const ids = [...input.live.keys()];
  for (const session of [...input.live.values()]) await session.release();
  const root = path.join(input.storeDir, "training", "prime-evaluation");
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  let provider: Awaited<ReturnType<typeof input.resolveProvider>> | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(root, entry.name, "controller-state.json");
    let state: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      state = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (state.status !== "active" && state.status !== "cleanup_pending") continue;
    if (typeof state.providerNodeId !== "string") continue;
    provider ??= await input.resolveProvider();
    const reconciled = await provider.client
      .terminate(state.providerNodeId)
      .then(() => true, () => false);
    if (!reconciled) continue;
    const cleanedAt = input.now().toISOString();
    await writeFile(
      statePath,
      canonicalJson({ ...state, status: "reconciled", updatedAt: cleanedAt }),
      { mode: 0o600 },
    );
    const failureReceiptPath = path.join(
      root,
      entry.name,
      "evaluation-session-failure-receipt.json",
    );
    try {
      const failureReceipt = JSON.parse(
        await readFile(failureReceiptPath, "utf8"),
      ) as Record<string, unknown>;
      const { contentHash: _discardedContentHash, ...failureCore } =
        failureReceipt;
      const cleanupRecord =
        failureCore.cleanup &&
        typeof failureCore.cleanup === "object" &&
        !Array.isArray(failureCore.cleanup)
          ? (failureCore.cleanup as Record<string, unknown>)
          : {};
      const reconciledCore = {
        ...failureCore,
        cleanup: {
          ...cleanupRecord,
          remoteStopped: true,
          tunnelClosed: true,
          computeReleased: true,
          completedAt: cleanedAt,
          reconciledAt: cleanedAt,
        },
      };
      await writeFile(
        failureReceiptPath,
        canonicalJson({
          ...reconciledCore,
          contentHash: contentHash(reconciledCore),
        }),
        { mode: 0o600 },
      );
    } catch {
      // Older active sessions may predate the canonical failure receipt.
    }
    ids.push(entry.name);
  }
  return ids;
}

export function marker(
  sessionId: string,
  arm: "base" | "candidate",
): string {
  return `${MARKER_PREFIX}${sessionId}:${arm}`;
}

export function createPrimeEvaluationFailureReceipt(input: {
  sessionId: string;
  purpose: "train-signal" | "frozen-benchmark";
  stage: string;
  error: string;
  model: Record<string, unknown>;
  adapter: Record<string, unknown> | null;
  wallet: unknown;
  quote: unknown;
  provisionAttempts: unknown[];
  providerResource: Record<string, unknown>;
  requests: unknown[];
  usage: unknown;
  cost: Record<string, unknown>;
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
    schemaVersion:
      "openpond.primeEvaluationSessionFailureReceipt.v1" as const,
    ...input,
  };
  return {
    ...core,
    contentHash: contentHash(core),
  };
}

type PrimeEvaluationTransport = Awaited<
  ReturnType<typeof createPrimeRolloutSshTransport>
>;

export async function stopPrimeEvaluationRemote(
  transport: PrimeEvaluationTransport,
  remoteDirectory: string,
): Promise<boolean> {
  return transport
    .runRemote([
      "bash",
      "-lc",
      [
        'run_dir="$1"',
        'touch "$run_dir/cancel"',
        "attempt=0",
        'while [ -f "$run_dir/openpond-runner.pid" ] && [ "$attempt" -lt 50 ]; do',
        "  sleep 0.2",
        "  attempt=$((attempt + 1))",
        "done",
        'test ! -f "$run_dir/openpond-runner.pid"',
      ].join("\n"),
      "openpond-prime-evaluation-stop",
      remoteDirectory,
    ])
    .then(
      () => true,
      () => false,
    );
}

export async function downloadPrimeEvaluationArtifacts(input: {
  transport: PrimeEvaluationTransport;
  remoteDirectory: string;
  artifactRoot: string;
}): Promise<void> {
  await Promise.all([
    "evaluation-server.log",
    "evaluation-server-receipt.json",
    "vllm-bootstrap.log",
    "vllm-help.txt",
    "vllm.log",
  ].map((filename) =>
    input.transport
      .download(
        `${input.remoteDirectory}/${filename}`,
        input.artifactRoot,
      )
      .catch(() => undefined)
  ));
}

export function parseMarker(value: string): {
  sessionId: string;
  arm: "base" | "candidate";
} | null {
  if (!value.startsWith(MARKER_PREFIX)) return null;
  const parts = value.slice(MARKER_PREFIX.length).split(":");
  if (
    parts.length !== 2
    || !parts[0]
    || (parts[1] !== "base" && parts[1] !== "candidate")
  ) {
    return null;
  }
  return {
    sessionId: parts[0],
    arm: parts[1],
  };
}

export async function waitForVllm(input: {
  port: number;
  request: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  let lastError = "vLLM did not answer.";
  while (Date.now() < deadline) {
    throwIfAborted(input.signal);
    try {
      const response = await input.request(
        `http://127.0.0.1:${input.port}/v1/models`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error
        ? error.message
        : String(error);
    }
    await delay(2_000);
  }
  throw new Error(
    `Prime vLLM evaluation readiness timed out: ${lastError}`,
  );
}

export function parsePrimeEvaluationCompletion(
  value: unknown,
  expectedModel: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prime vLLM returned a non-object completion.");
  }
  const record = value as Record<string, unknown>;
  const responseModel =
    typeof record.model === "string" ? record.model : "";
  if (responseModel !== expectedModel) {
    throw new Error(
      `Prime vLLM served ${responseModel || "no model identity"} instead of ${expectedModel}.`,
    );
  }
  const choices = Array.isArray(record.choices)
    ? record.choices
    : [];
  const choice =
    choices[0]
    && typeof choices[0] === "object"
    && !Array.isArray(choices[0])
      ? choices[0] as Record<string, unknown>
      : null;
  const message =
    choice?.message
    && typeof choice.message === "object"
    && !Array.isArray(choice.message)
      ? choice.message as Record<string, unknown>
      : null;
  if (!choice || !message) {
    throw new Error("Prime vLLM completion has no assistant choice.");
  }
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(parseToolCall)
    : [];
  const usage =
    record.usage
    && typeof record.usage === "object"
    && !Array.isArray(record.usage)
      ? record.usage as Record<string, unknown>
      : {};
  return {
    responseModel,
    content:
      typeof message.content === "string"
        ? message.content
        : null,
    toolCalls,
    finishReason:
      typeof choice.finish_reason === "string"
        ? choice.finish_reason
        : null,
    promptTokens: nullableInteger(usage.prompt_tokens),
    completionTokens: nullableInteger(
      usage.completion_tokens,
    ),
    totalTokens: nullableInteger(usage.total_tokens),
  };
}

function parseToolCall(
  value: unknown,
  index: number,
): HostedChatToolCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prime vLLM returned an invalid tool call.");
  }
  const call = value as Record<string, unknown>;
  const fn =
    call.function
    && typeof call.function === "object"
    && !Array.isArray(call.function)
      ? call.function as Record<string, unknown>
      : null;
  if (
    !fn
    || typeof fn.name !== "string"
    || typeof fn.arguments !== "string"
  ) {
    throw new Error("Prime vLLM returned an incomplete tool call.");
  }
  return {
    id:
      typeof call.id === "string"
        ? call.id
        : `call_${index + 1}`,
    type: "function",
    function: {
      name: fn.name,
      arguments: fn.arguments,
    },
  };
}

export function summarizeUsage(facts: PrimeEvaluationRequestFact[]) {
  return {
    requests: facts.length,
    promptTokens: sumNullable(
      facts.map((fact) => fact.promptTokens),
    ),
    completionTokens: sumNullable(
      facts.map((fact) => fact.completionTokens),
    ),
    totalTokens: sumNullable(
      facts.map((fact) => fact.totalTokens),
    ),
    toolCalls: facts.reduce(
      (sum, fact) => sum + fact.toolCallCount,
      0,
    ),
  };
}

function sumNullable(
  values: Array<number | null>,
): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>(
        (sum, value) => sum + (value ?? 0),
        0,
      );
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    ? value
    : null;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Prime evaluation was cancelled.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

type PrimeEvaluationInventory = Awaited<
  ReturnType<PrimeRawComputeHttpClient["inventory"]>
>;

type PrimeEvaluationInventoryAttempt = {
  attempt: number;
  checkedAt: string;
  status: "available" | "empty" | "error";
  deviceCount: number;
  capabilityReceipt: string | null;
  error: string | null;
};

export async function waitForPrimeEvaluationInventory(input: {
  inventory(): Promise<PrimeEvaluationInventory>;
  artifactRoot: string;
  waitMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<PrimeEvaluationInventory> {
  if (
    !Number.isFinite(input.waitMs)
    || input.waitMs < 0
    || !Number.isFinite(input.pollIntervalMs)
    || input.pollIntervalMs <= 0
  ) {
    throw new Error(
      "Prime inventory polling requires a non-negative wait and a positive interval.",
    );
  }
  const now = input.now ?? (() => new Date());
  const wait = input.wait ?? delay;
  const maximumAttempts = Math.max(
    1,
    Math.floor(input.waitMs / input.pollIntervalMs) + 1,
  );
  const attempts: PrimeEvaluationInventoryAttempt[] = [];
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    try {
      const inventory = await input.inventory();
      const available = inventory.devices.length > 0;
      attempts.push({
        attempt,
        checkedAt: inventory.checkedAt || now().toISOString(),
        status: available ? "available" : "empty",
        deviceCount: inventory.devices.length,
        capabilityReceipt: inventory.capabilityReceipt,
        error: null,
      });
      await saveInventoryAttempts(input.artifactRoot, attempts, {
        waitMs: input.waitMs,
        pollIntervalMs: input.pollIntervalMs,
      });
      if (available) return inventory;
      lastError = null;
    } catch (error) {
      lastError = safeMessage(error);
      attempts.push({
        attempt,
        checkedAt: now().toISOString(),
        status: "error",
        deviceCount: 0,
        capabilityReceipt: null,
        error: lastError,
      });
      await saveInventoryAttempts(input.artifactRoot, attempts, {
        waitMs: input.waitMs,
        pollIntervalMs: input.pollIntervalMs,
      });
    }
    if (attempt < maximumAttempts) {
      await wait(input.pollIntervalMs);
    }
  }
  throwIfAborted(input.signal);
  const duration = formatWaitDuration(input.waitMs);
  throw new Error(
    `Prime evaluation inventory remained unavailable after ${attempts.length} check${attempts.length === 1 ? "" : "s"} over up to ${duration}; no H100 was provisioned.${
      lastError ? ` Last inventory error: ${lastError}` : ""
    }`,
  );
}

export async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function saveProvisionAttempts(
  artifactRoot: string,
  attempts: unknown[],
): Promise<void> {
  await writeFile(
    path.join(artifactRoot, "provisioning-attempts.json"),
    canonicalJson({
      schemaVersion:
        "openpond.primeEvaluationProvisionAttempts.v1",
      attempts,
      contentHash: contentHash(attempts),
    }),
    { mode: 0o600 },
  );
}

async function saveInventoryAttempts(
  artifactRoot: string,
  attempts: PrimeEvaluationInventoryAttempt[],
  policy: {
    waitMs: number;
    pollIntervalMs: number;
  },
): Promise<void> {
  const receiptCore = {
    schemaVersion:
      "openpond.primeEvaluationInventoryAttempts.v1",
    policy,
    attempts,
  };
  await writeFile(
    path.join(artifactRoot, "inventory-attempts.json"),
    canonicalJson({
      ...receiptCore,
      contentHash: contentHash(receiptCore),
    }),
    { mode: 0o600 },
  );
}

function formatWaitDuration(milliseconds: number): string {
  if (milliseconds >= 60_000) {
    const minutes = milliseconds / 60_000;
    return Number.isInteger(minutes)
      ? `${minutes} minutes`
      : `${minutes.toFixed(1)} minutes`;
  }
  const seconds = milliseconds / 1_000;
  return Number.isInteger(seconds)
    ? `${seconds} seconds`
    : `${seconds.toFixed(1)} seconds`;
}

export function safeMessage(error: unknown): string {
  return (
    error instanceof Error ? error.message : String(error)
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
