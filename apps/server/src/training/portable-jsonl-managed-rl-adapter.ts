import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import type { Taskset } from "@openpond/contracts";

import {
  createManagedRlHarnessAttemptReceipt,
} from "./marketing-portfolio-managed-rl-adapter.js";
import { parseManagedRlPolicyCompletion, type ManagedRlPolicyMessage } from "./marketing-portfolio-rollout.js";
import {
  registerManagedRlHarnessAdapter,
  type ManagedRlHarnessExecutionInput,
} from "./managed-rl-harness-registry.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";

export const PORTABLE_JSONL_HARNESS_ADAPTER_ID = "portable-jsonl-stateful-v1";
const MAX_STDERR_BYTES = 64 * 1024;

type BridgeInit = {
  environmentVersion?: string;
  policy: string;
  userPrompt: string;
  tools: Array<Record<string, unknown>>;
};

type BridgeStep = {
  toolResults: Array<{ id: string; name: string; output: unknown }>;
  userMessage: string | null;
  terminal: boolean;
  terminationReason?: string | null;
  reward: number;
  components: Record<string, number>;
  stateHashes: Record<string, string | null>;
};

export const portableJsonlManagedRlAdapter = {
  id: PORTABLE_JSONL_HARNESS_ADAPTER_ID,
  priority: -100,
  supports(input: { taskset: Taskset; environmentId: string }): boolean {
    return input.taskset.environment.kind === "stateful_harness"
      && input.taskset.capabilities.requiresState
      && input.taskset.capabilities.requiresTools;
  },
  execute: executePortableJsonlManagedRl,
};

registerManagedRlHarnessAdapter(portableJsonlManagedRlAdapter);

export async function executePortableJsonlManagedRl(
  input: ManagedRlHarnessExecutionInput,
): Promise<Record<string, unknown>> {
  const rewardGrader = input.taskset.graders.find((grader) => grader.rewardEligible);
  if (!rewardGrader) throw new Error("portable_jsonl_reward_grader_missing");
  const taskId = typeof input.task.metadata.benchmarkTaskId === "string"
    ? input.task.metadata.benchmarkTaskId
    : input.task.id;
  const runtime = await loadPortableJsonlRuntime(input.taskset, input.storeDir);
  const bridge = await PortableJsonlBridge.start({
    runtime,
    taskId,
    graderId: rewardGrader.id,
    signal: input.signal,
  });
  const startedAt = (input.timestamp ?? (() => new Date().toISOString()))();
  const baseSeed = Number.isInteger(input.claim.request.seed)
    ? Number(input.claim.request.seed)
    : 0;
  const messages: ManagedRlPolicyMessage[] = [];
  const toolSequence: string[] = [];
  const trace: Array<Record<string, unknown>> = [];
  const policyResults: Array<Record<string, unknown>> = [];
  let lastPolicyResult: Record<string, unknown> | null = null;
  const policyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let policyUsageObserved = false;
  let policyCostUsd = 0;
  let policyCostObserved = false;
  let finalStep: BridgeStep | null = null;
  try {
    const initialized = await bridge.request<BridgeInit>({ operation: "init" });
    const toolNames = initialized.tools.map((tool) =>
      requiredString(requiredRecord(tool.function, "tool function").name, "tool name")
    );
    if (toolNames.join(",") !== input.taskset.environment.toolNames.join(",")) {
      throw new Error("portable_jsonl_tool_contract_mismatch");
    }
    messages.push(
      { role: "system", content: initialized.policy },
      { role: "user", content: initialized.userPrompt },
    );
    for (let turnIndex = 0; turnIndex < runtime.maxTurns; turnIndex += 1) {
      const policyResult = await input.policyRequest({
        deliveryId: input.claim.deliveryId,
        policyVersion: input.claim.policyVersion,
        turnIndex,
        messages,
        tools: initialized.tools,
        toolChoice: "auto",
        maxTokens: 1_024,
        temperature: 0.8,
        seed: baseSeed + turnIndex,
        logprobs: true,
        topLogprobs: 1,
        returnTokenIds: true,
      }, input.signal);
      lastPolicyResult = policyResult;
      policyResults.push(policyResult);
      const normalizedUsage = normalizeModelUsageTokens(policyResult.usage);
      if (
        normalizedUsage.promptTokens !== null
        || normalizedUsage.completionTokens !== null
        || normalizedUsage.totalTokens !== null
      ) {
        policyUsageObserved = true;
        policyUsage.inputTokens += normalizedUsage.promptTokens ?? 0;
        policyUsage.outputTokens += normalizedUsage.completionTokens ?? 0;
        policyUsage.totalTokens += normalizedUsage.totalTokens
          ?? (normalizedUsage.promptTokens ?? 0) + (normalizedUsage.completionTokens ?? 0);
      }
      if (typeof policyResult.costUsd === "number" && Number.isFinite(policyResult.costUsd) && policyResult.costUsd >= 0) {
        policyCostObserved = true;
        policyCostUsd += policyResult.costUsd;
      }
      const completion = parseManagedRlPolicyCompletion(policyResult);
      messages.push({
        role: "assistant",
        content: completion.content,
        tool_calls: completion.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      finalStep = await bridge.request<BridgeStep>({
        operation: "step",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });
      for (const result of finalStep.toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: result.id,
          content: JSON.stringify(result.output),
        });
        toolSequence.push(result.name);
      }
      if (finalStep.userMessage) {
        messages.push({ role: "user", content: finalStep.userMessage });
      }
      trace.push({
        turnIndex,
        content: completion.content,
        toolCalls: completion.toolCalls,
        toolResults: finalStep.toolResults,
        terminal: finalStep.terminal,
      });
      if (finalStep.terminal) break;
    }
    if (finalStep && !finalStep.terminal) {
      finalStep = await bridge.request<BridgeStep>({
        operation: "terminate",
        reason: "max_turns",
      });
      trace.push({
        turnIndex: runtime.maxTurns,
        content: null,
        toolCalls: [],
        toolResults: [],
        terminal: true,
        terminationReason: "max_turns",
      });
    }
  } finally {
    await bridge.close();
  }
  if (!lastPolicyResult || !finalStep) {
    throw new Error("portable_jsonl_policy_result_missing");
  }
  const trainingSamples = policyResults.map((policyResult, index) => requiredRecord(
    policyResult.trainingSample,
    `Managed RL training sample turn ${index + 1}`,
  ));
  const traceSha256 = sha256({ taskId, messages, trace, stateHashes: finalStep.stateHashes });
  const completedAt = (input.timestamp ?? (() => new Date().toISOString()))();
  const bridgeComponents = Object.fromEntries(
    Object.entries(finalStep.components).map(([key, value]) => [key, finite(value, key)]),
  );
  const rollout = {
    traceSha256,
    reward: finite(finalStep.reward, "reward"),
    components: bridgeComponents,
    terminal: finalStep.terminal,
    toolSequence,
  };
  return {
    status: "succeeded",
    executorId: input.executorId,
    environmentSha256: input.claim.environmentSha256,
    policyResult: lastPolicyResult,
    policyResults,
    trace: {
      schemaVersion: "openpond.managedRlLocalHarnessReceipt.v2",
      jobId: input.claim.jobId,
      executionKind: input.claim.executionKind,
      executionId: input.claim.executionId,
      deliveryId: input.claim.deliveryId,
      groupId: input.claim.groupId,
      taskId: input.task.id,
      policyVersion: input.claim.policyVersion,
      environmentSha256: input.claim.environmentSha256,
      harnessReleaseSha256: input.claim.harnessRelease.contentHash,
      tasksetSha256: input.claim.taskset.contentHash,
      traceSha256,
      trainingSampleSha256s: trainingSamples.map((sample) => sha256(sample)),
      modelRequestIds: trainingSamples.map((sample) => requiredString(sample.modelRequestId, "model request ID")),
      reward: rollout.reward,
      components: rollout.components,
      terminal: rollout.terminal,
      terminationReason: finalStep.terminationReason ?? null,
      toolSequence,
    },
    attemptReceipt: createManagedRlHarnessAttemptReceipt({
      claim: input.claim,
      taskId: input.task.id,
      seed: baseSeed,
      rollout,
      startedAt,
      completedAt,
    }),
    ...(input.claim.executionKind === "evaluation"
      ? {
          evaluationEvidence: {
            schemaVersion: "openpond.portableJsonlEvaluationEvidence.v1",
            taskId,
            messages,
            trace,
            components: rollout.components,
            reward: rollout.reward,
            terminal: rollout.terminal,
            terminationReason: finalStep.terminationReason ?? null,
            stateHashes: finalStep.stateHashes,
            policyUsage: policyUsageObserved ? policyUsage : null,
            policyCostUsd: policyCostObserved ? policyCostUsd : null,
          },
        }
      : {}),
  };
}

type PortableJsonlRuntime = {
  command: string[];
  cwd: string;
  maxTurns: number;
  modulePath: string;
};

class PortableJsonlBridge {
  private readonly reader: readline.Interface;
  private readonly pending: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  private stderr = "";
  private closed = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => {
      const waiter = this.pending.shift();
      if (!waiter) return;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.fatal === "string") {
          waiter.reject(new Error(`portable_jsonl_bridge_failed:${String(parsed.message ?? parsed.fatal)}`));
        } else {
          waiter.resolve(parsed);
        }
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < MAX_STDERR_BYTES) this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(
        `portable_jsonl_bridge_exited:${signal ?? code ?? "unknown"}:${this.stderr.slice(-2_000)}`,
      );
      for (const waiter of this.pending.splice(0)) waiter.reject(error);
    });
  }

  static async start(input: {
    runtime: PortableJsonlRuntime;
    taskId: string;
    graderId: string;
    signal: AbortSignal;
  }): Promise<PortableJsonlBridge> {
    const [executable, ...configuredArguments] = input.runtime.command;
    if (!executable) throw new Error("portable_jsonl_command_missing");
    const argumentsWithModule = configuredArguments.map((argument) => (
      argument === "{module}" ? input.runtime.modulePath : argument
    ));
    if (!configuredArguments.includes("{module}")) argumentsWithModule.push(input.runtime.modulePath);
    const child = spawn(executable, [...argumentsWithModule, input.taskId, input.graderId], {
      cwd: input.runtime.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const bridge = new PortableJsonlBridge(child);
    const abort = () => child.kill("SIGTERM");
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
    child.once("exit", () => input.signal.removeEventListener("abort", abort));
    return bridge;
  }

  request<T>(value: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("portable_jsonl_bridge_closed"));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ resolve: (response) => resolve(response as T), reject });
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) {
          const waiter = this.pending.pop();
          waiter?.reject(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

async function loadPortableJsonlRuntime(taskset: Taskset, storeDir: string): Promise<PortableJsonlRuntime> {
  const imported = record(taskset.metadata.importedFromTaskset);
  const declaredSource = typeof taskset.environment.metadata.runtimeSourceTasksetId === "string"
    ? taskset.environment.metadata.runtimeSourceTasksetId.trim()
    : null;
  const importedSource = typeof imported?.id === "string" ? imported.id.trim() : null;
  const sourceTasksetId = declaredSource || importedSource || taskset.id;
  const root = path.resolve(storeDir, "training", "tasksets", sourceTasksetId);
  const runtimeFile = path.join(root, "graders", "managed-rl-runtime.json");
  const raw = JSON.parse(await readFile(runtimeFile, "utf8")) as unknown;
  const config = requiredRecord(raw, "Portable JSONL runtime config");
  if (config.protocolVersion !== "openpond.managedRlJsonlRuntime.v1") {
    throw new Error("portable_jsonl_protocol_unsupported");
  }
  const moduleName = requiredString(config.module, "Portable JSONL runtime module");
  const resolvedRoot = await realpath(root);
  const modulePath = await realpath(path.resolve(resolvedRoot, moduleName));
  if (modulePath !== resolvedRoot && !modulePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("portable_jsonl_module_outside_taskset");
  }
  const expectedModuleSha256 = requiredString(
    config.moduleSha256,
    "Portable JSONL runtime module SHA-256",
  );
  const actualModuleSha256 = createHash("sha256")
    .update(await readFile(modulePath))
    .digest("hex");
  if (actualModuleSha256 !== expectedModuleSha256) {
    throw new Error("portable_jsonl_module_hash_mismatch");
  }
  const command = Array.isArray(config.command)
    ? config.command.map((value, index) => requiredString(value, `Portable JSONL command ${index + 1}`))
    : [];
  if (!command.length) throw new Error("portable_jsonl_command_missing");
  const configuredCwd = typeof config.cwd === "string" && config.cwd.trim()
    ? config.cwd.trim()
    : resolvedRoot;
  const maxTurns = typeof config.maxTurns === "number" && Number.isInteger(config.maxTurns)
    ? config.maxTurns
    : 12;
  if (maxTurns < 1 || maxTurns > 100) throw new Error("portable_jsonl_max_turns_invalid");
  return {
    command,
    cwd: path.isAbsolute(configuredCwd) ? configuredCwd : path.resolve(resolvedRoot, configuredCwd),
    maxTurns,
    modulePath,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) throw new Error(`${label} must be an object.`);
  return parsed;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}
function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
