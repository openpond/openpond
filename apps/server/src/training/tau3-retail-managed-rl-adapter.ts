import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
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
import {
  composeTau3RetailOutcomeReward,
  composeTau3RetailOutcomeRewardV3,
  TAU3_RETAIL_OUTCOME_RUBRIC_GRADER_ID,
  TAU3_RETAIL_OUTCOME_RUBRIC_V3_GRADER_ID,
  TAU3_RETAIL_TERMINAL_STATE_GRADER_ID,
} from "./tau3-retail-reward.js";

export const TAU3_RETAIL_HARNESS_ADAPTER_ID = "tau3-retail-v1";
const DEFAULT_TAU3_ROOT = "/tmp/tau3-bench";
const MAX_TURNS = 12;
const MAX_STDERR_BYTES = 64 * 1024;

type BridgeInit = {
  sourceCommit: string;
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

export const tau3RetailManagedRlAdapter = {
  id: TAU3_RETAIL_HARNESS_ADAPTER_ID,
  supports(input: { taskset: Taskset; environmentId: string }): boolean {
    const benchmark = record(input.taskset.environment.metadata.benchmark);
    return input.environmentId === TAU3_RETAIL_HARNESS_ADAPTER_ID
      && benchmark?.id === TAU3_RETAIL_HARNESS_ADAPTER_ID
      && input.taskset.capabilities.requiresState
      && input.taskset.capabilities.requiresTools;
  },
  execute: executeTau3RetailManagedRl,
};

registerManagedRlHarnessAdapter(tau3RetailManagedRlAdapter);

export async function executeTau3RetailManagedRl(
  input: ManagedRlHarnessExecutionInput,
): Promise<Record<string, unknown>> {
  const benchmark = requiredRecord(
    input.taskset.environment.metadata.benchmark,
    "tau3 benchmark metadata",
  );
  const rewardGrader = input.taskset.graders.find((grader) => grader.rewardEligible);
  if (!rewardGrader) throw new Error("tau3_retail_reward_grader_missing");
  if (
    rewardGrader.id !== TAU3_RETAIL_TERMINAL_STATE_GRADER_ID
    && rewardGrader.id !== TAU3_RETAIL_OUTCOME_RUBRIC_GRADER_ID
    && rewardGrader.id !== TAU3_RETAIL_OUTCOME_RUBRIC_V3_GRADER_ID
  ) {
    throw new Error(`tau3_retail_reward_grader_unsupported:${rewardGrader.id}`);
  }
  const taskId = requiredString(
    input.task.metadata.benchmarkTaskId,
    "tau3 Retail task ID",
  );
  const expectedCommit = requiredSha(
    benchmark.sourceCommit,
    "tau3 source commit",
  );
  const bridge = await Tau3Bridge.start({
    root: process.env.OPENPOND_TAU3_BENCH_ROOT?.trim() || DEFAULT_TAU3_ROOT,
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
  let lastPolicyResult: Record<string, unknown> | null = null;
  let finalStep: BridgeStep | null = null;
  try {
    const initialized = await bridge.request<BridgeInit>({ operation: "init" });
    if (initialized.sourceCommit !== expectedCommit) {
      throw new Error("tau3_retail_source_commit_mismatch");
    }
    const toolNames = initialized.tools.map((tool) =>
      requiredString(requiredRecord(tool.function, "tau3 tool function").name, "tau3 tool name")
    );
    if (toolNames.join(",") !== input.taskset.environment.toolNames.join(",")) {
      throw new Error("tau3_retail_tool_contract_mismatch");
    }
    messages.push(
      { role: "system", content: initialized.policy },
      { role: "user", content: initialized.userPrompt },
    );
    for (let turnIndex = 0; turnIndex < MAX_TURNS; turnIndex += 1) {
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
        turnIndex: MAX_TURNS,
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
    throw new Error("tau3_retail_policy_result_missing");
  }
  const trainingSample = requiredRecord(
    lastPolicyResult.trainingSample,
    "tau3 Managed RL training sample",
  );
  const traceSha256 = sha256({ taskId, messages, trace, stateHashes: finalStep.stateHashes });
  const completedAt = (input.timestamp ?? (() => new Date().toISOString()))();
  const bridgeComponents = Object.fromEntries(
    Object.entries(finalStep.components).map(([key, value]) => [key, finite(value, key)]),
  );
  const scored = rewardGrader.id === TAU3_RETAIL_OUTCOME_RUBRIC_V3_GRADER_ID
    ? composeTau3RetailOutcomeRewardV3({
        terminalState: requiredComponent(bridgeComponents, "terminalState"),
        requiredWriteCoverage: requiredComponent(bridgeComponents, "requiredWriteCoverage"),
        requiredReadCoverage: requiredComponent(bridgeComponents, "requiredReadCoverage"),
        toolValidity: requiredComponent(bridgeComponents, "toolValidity"),
        resolvedCommunication: requiredComponent(bridgeComponents, "resolvedCommunication"),
        prematureMutation: requiredComponent(bridgeComponents, "prematureMutation"),
        unexpectedMutation: requiredComponent(bridgeComponents, "unexpectedMutation"),
        invalidToolRate: requiredComponent(bridgeComponents, "invalidToolRate"),
        requiredWritesApplicable: requiredComponent(bridgeComponents, "requiredWritesApplicable") === 1,
        requiredReadsApplicable: requiredComponent(bridgeComponents, "requiredReadsApplicable") === 1,
        toolValidityApplicable: requiredComponent(bridgeComponents, "toolValidityApplicable") === 1,
      })
    : rewardGrader.id === TAU3_RETAIL_OUTCOME_RUBRIC_GRADER_ID
    ? composeTau3RetailOutcomeReward({
        terminalState: requiredComponent(bridgeComponents, "terminalState"),
        requiredWriteCoverage: requiredComponent(bridgeComponents, "requiredWriteCoverage"),
        requiredReadCoverage: requiredComponent(bridgeComponents, "requiredReadCoverage"),
        toolValidity: requiredComponent(bridgeComponents, "toolValidity"),
        resolvedCommunication: requiredComponent(bridgeComponents, "resolvedCommunication"),
        prematureMutation: requiredComponent(bridgeComponents, "prematureMutation"),
        unexpectedMutation: requiredComponent(bridgeComponents, "unexpectedMutation"),
        invalidToolRate: requiredComponent(bridgeComponents, "invalidToolRate"),
      })
    : {
        reward: finite(finalStep.reward, "tau3 reward"),
        components: {
          terminalState: requiredComponent(bridgeComponents, "terminalState"),
          toolExecution: requiredComponent(bridgeComponents, "toolExecution"),
        },
      };
  const rollout = {
    traceSha256,
    reward: scored.reward,
    components: scored.components,
    terminal: finalStep.terminal,
    toolSequence,
  };
  return {
    status: "succeeded",
    executorId: input.executorId,
    environmentSha256: input.claim.environmentSha256,
    policyResult: lastPolicyResult,
    trace: {
      schemaVersion: "openpond.managedRlLocalHarnessReceipt.v1",
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
      trainingSampleSha256: sha256(trainingSample),
      modelRequestId: requiredString(trainingSample.modelRequestId, "tau3 model request ID"),
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
  };
}

class Tau3Bridge {
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
          waiter.reject(new Error(`tau3_bridge_failed:${String(parsed.message ?? parsed.fatal)}`));
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
        `tau3_bridge_exited:${signal ?? code ?? "unknown"}:${this.stderr.slice(-2_000)}`,
      );
      for (const waiter of this.pending.splice(0)) waiter.reject(error);
    });
  }

  static async start(input: {
    root: string;
    taskId: string;
    graderId: string;
    signal: AbortSignal;
  }): Promise<Tau3Bridge> {
    const root = path.resolve(input.root);
    const python = path.join(root, ".venv", "bin", "python");
    const script = fileURLToPath(new URL("./tau3-retail-bridge.py", import.meta.url));
    const child = spawn(python, [script, input.taskId, input.graderId], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const bridge = new Tau3Bridge(child);
    const abort = () => child.kill("SIGTERM");
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
    child.once("exit", () => input.signal.removeEventListener("abort", abort));
    return bridge;
  }

  request<T>(value: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("tau3_bridge_closed"));
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
function requiredSha(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!/^[a-f0-9]{40}$/.test(parsed)) throw new Error(`${label} must be a git commit SHA.`);
  return parsed;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}
function requiredComponent(components: Record<string, number>, key: string): number {
  const value = components[key];
  if (value === undefined) throw new Error(`tau3_retail_component_missing:${key}`);
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
