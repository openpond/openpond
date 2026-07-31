import type {
  HarnessActionBinding,
  TaskDataRecord,
  Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import {
  MARKETING_PORTFOLIO_POLICY_SYSTEM_PROMPT,
  projectPubliclyFeasibleAllocation,
} from "./marketing-portfolio-constraint-repair.js";
import type { ProfileAgentHarnessRuntime } from "./profile-agent-harness-runtime.js";

type PolicyToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ManagedRlPolicyMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type ManagedRlHarnessPolicy = {
  complete(input: {
    turnIndex: number;
    messages: ManagedRlPolicyMessage[];
    tools: Array<{
      type: "function";
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        strict: true;
      };
    }>;
    requiredToolName: string;
    signal: AbortSignal;
  }): Promise<{
    content: string | null;
    toolCalls: PolicyToolCall[];
    policyResult: Record<string, unknown>;
  }>;
};

export async function runMarketingPortfolioRollout(input: {
  taskset: Taskset;
  task: TaskDataRecord;
  policy: ManagedRlHarnessPolicy;
  runtime: ProfileAgentHarnessRuntime;
  maxTurns?: number;
  signal?: AbortSignal;
}) {
  const bindings = input.taskset.environment.actionBindings ?? [];
  const tools = bindings
    .filter((binding) => binding.studentVisible)
    .map((binding) => ({
      type: "function" as const,
      function: {
        name: binding.modelToolName,
        description: binding.description,
        parameters: modelFacingToolParameters(binding.inputSchema),
        strict: true as const,
      },
    }));
  if (
    tools.length !== 2 ||
    tools[0]?.function.name !== "get_portfolio_snapshot" ||
    tools[1]?.function.name !== "submit_budget_decision"
  ) {
    throw new Error(
      "Marketing rollout requires the exact ordered snapshot and decision tools.",
    );
  }
  const messages: ManagedRlPolicyMessage[] = [
    { role: "system", content: MARKETING_PORTFOLIO_POLICY_SYSTEM_PROMPT },
    { role: "user", content: taskPrompt(input.task) },
  ];
  const toolSequence: string[] = [];
  const toolTrace: Array<Record<string, unknown>> = [];
  let loadedSnapshot = false;
  let snapshot: Record<string, unknown> | null = null;
  let acceptedDecision: Record<string, unknown> | null = null;
  let pendingProjection: ReturnType<
    typeof projectPubliclyFeasibleAllocation
  > = null;
  let lastPolicyResult: Record<string, unknown> | null = null;
  const controller = new AbortController();
  const forwardAbort = () =>
    controller.abort(input.signal?.reason ?? new Error("Rollout cancelled."));
  input.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    for (
      let turnIndex = 0;
      turnIndex < (input.maxTurns ?? 8) && !acceptedDecision;
      turnIndex += 1
    ) {
      const requiredToolName = loadedSnapshot
        ? "submit_budget_decision"
        : "get_portfolio_snapshot";
      const tool = tools.find(
        (candidate) => candidate.function.name === requiredToolName,
      );
      if (!tool) throw new Error(`Required tool ${requiredToolName} is missing.`);
      const requiredToolIndex = tools.indexOf(tool);
      const completion = await input.policy.complete({
        turnIndex,
        messages: structuredClone(messages),
        tools: tools.slice(0, requiredToolIndex + 1),
        requiredToolName,
        signal: controller.signal,
      });
      lastPolicyResult = completion.policyResult;
      messages.push({
        role: "assistant",
        content: completion.content,
        tool_calls: completion.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      if (completion.toolCalls.length === 0) {
        messages.push({
          role: "user",
          content: `Call ${requiredToolName} now.`,
        });
        continue;
      }
      for (const call of completion.toolCalls) {
        if (call.name !== requiredToolName) {
          throw new Error(`Policy called unbound tool ${call.name}.`);
        }
        const binding = bindings.find(
          (candidate) => candidate.modelToolName === call.name,
        );
        if (!binding) throw new Error(`Tool ${call.name} has no action binding.`);
        const policyArguments = parseArguments(call);
        const projection: ReturnType<
          typeof projectPubliclyFeasibleAllocation
        > =
          call.name === "submit_budget_decision" ? pendingProjection : null;
        const executedArguments: Record<string, unknown> = projection
          ? {
              ...policyArguments,
              allocations: structuredClone(projection.allocations),
            }
          : policyArguments;
        const observation = await executeAction({
          binding,
          arguments: executedArguments,
          caseId: privateCaseId(input.task),
          runtime: input.runtime,
          signal: controller.signal,
        });
        const studentOutput = sanitizeStudentObservation(observation.output);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(studentOutput),
        });
        toolSequence.push(call.name);
        toolTrace.push({
          turnIndex,
          toolCallId: call.id,
          toolName: call.name,
          policyArguments,
          executedArguments,
          publicProjectionApplied: projection !== null,
          observation: studentOutput,
          terminal: observation.terminal,
        });
        if (call.name === "get_portfolio_snapshot") {
          loadedSnapshot = true;
          snapshot = studentOutput;
        } else if (observation.terminal) {
          acceptedDecision = executedArguments;
          pendingProjection = null;
          break;
        } else {
          pendingProjection = snapshot
            ? projectPubliclyFeasibleAllocation({
                snapshot,
                decision: executedArguments,
              })
            : null;
          messages.push({
            role: "user",
            content: decisionRepairPrompt({
              observation: studentOutput,
              projection: pendingProjection,
            }),
          });
        }
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", forwardAbort);
  }
  if (!lastPolicyResult) {
    throw new Error("Marketing rollout produced no policy result.");
  }
  const score = acceptedDecision
    ? await input.runtime.scoreDecision({
        ...acceptedDecision,
        scenarioId: privateCaseId(input.task),
      })
    : {
        reward: 0,
        components: {
          constraints: 0,
          portfolioValue: 0,
          riskControls: 0,
          rationale: 0,
        },
        validation: { accepted: false },
      };
  const traceSha256 = contentHash({
    taskId: input.task.id,
    messages,
    toolTrace,
    terminal: acceptedDecision !== null,
  });
  return {
    policyResult: lastPolicyResult,
    traceSha256,
    reward: score.reward,
    components: score.components,
    terminal: acceptedDecision !== null && score.validation.accepted,
    toolSequence,
  };
}

function modelFacingToolParameters(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return removeUnsupportedUniqueItems(schema) as Record<string, unknown>;
}

function removeUnsupportedUniqueItems(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUnsupportedUniqueItems);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "uniqueItems")
      .map(([key, child]) => [key, removeUnsupportedUniqueItems(child)]),
  );
}

export function parseManagedRlPolicyCompletion(
  policyResult: Record<string, unknown>,
): {
  content: string | null;
  toolCalls: PolicyToolCall[];
} {
  const response = object(policyResult.response, "Managed RL policy response");
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choice = object(choices[0], "Managed RL policy choice");
  const message = object(choice.message, "Managed RL policy message");
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((value, index) => {
        const call = object(value, `Managed RL tool call ${index + 1}`);
        const fn = object(call.function, `Managed RL tool function ${index + 1}`);
        return {
          id:
            typeof call.id === "string" && call.id.trim()
              ? call.id
              : `tool_call_${index + 1}`,
          name: requiredString(fn.name, "Managed RL tool name"),
          arguments:
            typeof fn.arguments === "string"
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {}),
        };
      })
    : [];
  return {
    content: typeof message.content === "string" ? message.content : null,
    toolCalls,
  };
}

async function executeAction(input: {
  binding: HarnessActionBinding;
  arguments: Record<string, unknown>;
  caseId: string;
  runtime: ProfileAgentHarnessRuntime;
  signal: AbortSignal;
}) {
  for (const episodeBinding of input.binding.episodeArgumentBindings) {
    if (Object.hasOwn(input.arguments, episodeBinding.argument)) {
      throw new Error(
        `Policy supplied private episode argument ${episodeBinding.argument}.`,
      );
    }
  }
  const resolvedArguments = structuredClone(input.arguments);
  for (const episodeBinding of input.binding.episodeArgumentBindings) {
    resolvedArguments[episodeBinding.argument] = input.caseId;
  }
  const actionController = new AbortController();
  const abort = () => actionController.abort(input.signal.reason);
  input.signal.addEventListener("abort", abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.runtime.executeAction({
        binding: input.binding,
        arguments: resolvedArguments,
        signal: actionController.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(
            `Harness action ${input.binding.actionId} exceeded its timeout.`,
          );
          actionController.abort(error);
          reject(error);
        }, input.binding.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    input.signal.removeEventListener("abort", abort);
  }
}

function decisionRepairPrompt(input: {
  observation: Record<string, unknown>;
  projection: ReturnType<typeof projectPubliclyFeasibleAllocation>;
}): string {
  const errors = Array.isArray(input.observation.errors)
    ? input.observation.errors.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : [];
  return input.projection
    ? [
        "The public decision validator rejected that submission.",
        ...errors.map((error) => `- ${error}`),
        "Use this deterministic projection of your submitted amounts:",
        JSON.stringify({ allocations: input.projection.allocations }),
        `Verified total: ${input.projection.allocationTotalUsd} USD.`,
        "Call submit_budget_decision again with those exact amounts. Keep or improve the rationale and risk controls.",
      ].join("\n")
    : [
        "The public decision validator rejected that submission.",
        ...errors.map((error) => `- ${error}`),
        "Recalculate all four allocations so they satisfy the visible constraints and total the incremental budget exactly.",
      ].join("\n");
}

function parseArguments(call: PolicyToolCall): Record<string, unknown> {
  try {
    return object(JSON.parse(call.arguments), `Arguments for ${call.name}`);
  } catch (error) {
    throw new Error(
      `Policy returned invalid JSON arguments for ${call.name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sanitizeStudentObservation(value: Record<string, unknown>) {
  const output = structuredClone(value);
  stripPrivateSelectors(output);
  return output;
}

function stripPrivateSelectors(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) stripPrivateSelectors(item);
    return;
  }
  const recordValue = value as Record<string, unknown>;
  delete recordValue.scenarioId;
  delete recordValue.caseId;
  delete recordValue.split;
  for (const child of Object.values(recordValue)) stripPrivateSelectors(child);
}

function privateCaseId(task: TaskDataRecord): string {
  return requiredString(task.metadata.caseId, "private Dataset case ID");
}

function taskPrompt(task: TaskDataRecord): string {
  return requiredString(task.input.prompt, "Dataset prompt");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
