import { randomUUID } from "node:crypto";
import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  CROSS_SYSTEM_TOOL_NAMES,
  CrossSystemTrajectorySchema,
  type CrossSystemBaselineReport,
  type ChatModelRef,
  type CodexReasoningEffort,
  type CrossSystemToolName,
  type CrossSystemTrajectory,
  type CrossSystemTrajectoryStep,
  type CrossSystemVerifierResult,
} from "@openpond/contracts";
import type {
  HostedChatContinuation,
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";
import {
  assistantMessageForNativeToolCalls,
  invalidNativeToolArgumentsResult,
  NativeToolCallAccumulator,
  parseNativeToolArguments,
  toolResultMessage,
  unknownNativeToolResult,
} from "../../openpond/native-tool-calls.js";
import { crossSystemToolsFromRequest } from "../local-adapter-tool-protocol.js";
import { buildCrossSystemBaselineReport } from "./baseline.js";
import { CrossSystemEnvironment, CrossSystemToolError } from "./environment.js";
import type { CrossSystemTask, CrossSystemWorld } from "./types.js";
import {
  parseCrossSystemAnswer,
  verifyCrossSystemTrajectory,
} from "./verifier.js";

export type CrossSystemFrontierModelDelta = {
  text?: string;
  continuation?: HostedChatContinuation;
  toolCalls?: HostedChatToolCall[];
};

export type CrossSystemFrontierModelStream = (input: {
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  messages: HostedChatMessage[];
  tools: HostedChatTool[];
  toolChoice: HostedChatToolChoice;
  requestId: string;
  signal: AbortSignal;
}) => AsyncIterable<CrossSystemFrontierModelDelta>;

export async function runFrontierCrossSystemBaseline(input: {
  worlds: CrossSystemWorld[];
  tasks: CrossSystemTask[];
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  stream: CrossSystemFrontierModelStream;
  signal?: AbortSignal;
  reportId?: string;
  maxInfrastructureRetries?: number;
  onTaskStarted?: (input: { index: number; total: number; task: CrossSystemTask }) => void | Promise<void>;
  onTaskCompleted?: (input: {
    index: number;
    total: number;
    task: CrossSystemTask;
    trajectory: CrossSystemTrajectory;
    result: CrossSystemVerifierResult;
  }) => void | Promise<void>;
}): Promise<{
  report: CrossSystemBaselineReport;
  tasks: CrossSystemTask[];
  trajectories: CrossSystemTrajectory[];
  results: CrossSystemVerifierResult[];
}> {
  const selectedTasks = selectCrossSystemRepresentativeTasks(
    input.worlds,
    input.tasks,
  );
  const worldById = new Map(input.worlds.map((world) => [world.id, world]));
  const signal = input.signal ?? new AbortController().signal;
  const trajectories: CrossSystemTrajectory[] = [];
  const results: CrossSystemVerifierResult[] = [];
  for (let index = 0; index < selectedTasks.length; index += 1) {
    const task = selectedTasks[index]!;
    throwIfAborted(signal);
    await input.onTaskStarted?.({ index, total: selectedTasks.length, task });
    throwIfAborted(signal);
    const world = worldById.get(task.worldId);
    if (!world) throw new Error(`Missing world ${task.worldId}.`);
    const maxInfrastructureRetries = Math.max(0, Math.min(2, input.maxInfrastructureRetries ?? 1));
    const priorInfrastructureErrors: string[] = [];
    let trajectory: CrossSystemTrajectory | null = null;
    let result: CrossSystemVerifierResult | null = null;
    for (let attempt = 0; attempt <= maxInfrastructureRetries; attempt += 1) {
      trajectory = await runCrossSystemRollout({
        ...input,
        world,
        task,
        signal,
        metadata: {
          baseline: "frontier",
          infrastructureRetryAttempt: attempt,
          priorInfrastructureErrors: [...priorInfrastructureErrors],
        },
      });
      result = verifyCrossSystemTrajectory({ task, trajectory });
      if (result.outcome !== "infrastructure_failure" || attempt === maxInfrastructureRetries) break;
      priorInfrastructureErrors.push(trajectory.infrastructureError ?? "Unknown infrastructure failure.");
      throwIfAborted(signal);
    }
    if (!trajectory || !result) throw new Error(`Cross-System task ${task.id} produced no trajectory.`);
    trajectories.push(trajectory);
    results.push(result);
    await input.onTaskCompleted?.({ index, total: selectedTasks.length, task, trajectory, result });
  }
  return {
    report: buildCrossSystemBaselineReport({
      id: input.reportId ?? `cso_frontier_baseline_${randomUUID()}`,
      model: input.model,
      tasks: selectedTasks,
      trajectories,
      results,
    }),
    tasks: selectedTasks,
    trajectories,
    results,
  };
}

export function selectCrossSystemRepresentativeTasks(
  worlds: CrossSystemWorld[],
  tasks: CrossSystemTask[],
): CrossSystemTask[] {
  const worldById = new Map(worlds.map((world) => [world.id, world]));
  const groups = new Map<string, CrossSystemTask[]>();
  for (const task of tasks) {
    const key = `${task.worldId}:${task.family}`;
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const ordered = [...group].sort(
      (left, right) => left.phrasingVariant - right.phrasingVariant,
    );
    const world = worldById.get(ordered[0]!.worldId);
    if (!world) return [];
    const familyIndex = [
      "renewal_exposure",
      "collections_prioritization",
      "invoice_reconciliation",
      "sla_escalation",
      "contract_billing_mismatch",
    ].indexOf(ordered[0]!.family);
    const targetVariant =
      Math.abs(world.seed + Math.max(0, familyIndex)) % 3;
    return [
      ordered.find((task) => task.phrasingVariant === targetVariant)
      ?? ordered[0]!,
    ];
  });
}

export async function runCrossSystemRollout(input: {
  world: CrossSystemWorld;
  task: CrossSystemTask;
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  stream: CrossSystemFrontierModelStream;
  signal: AbortSignal;
  trajectoryId?: string;
  metadata?: Record<string, unknown>;
  maxTurns?: number;
  maxFormatRepairs?: number;
}): Promise<CrossSystemTrajectory> {
  const id = input.trajectoryId ?? `cso_frontier_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const environment = new CrossSystemEnvironment({ attemptId: id, world: input.world, task: input.task });
  const steps: CrossSystemTrajectoryStep[] = [];
  const tools = crossSystemTools();
  const messages: HostedChatMessage[] = [
    {
      role: "system",
      content: [
        "You are being evaluated in the bounded synthetic Cross-System Operations environment.",
        `Use only the four registered tools under contract ${CROSS_SYSTEM_TOOL_CONTRACT_HASH}; never infer operational facts without tool evidence.`,
        "Reconcile identifiers across systems, respect pagination and budgets, and use run_python for exact arithmetic when useful.",
        'Use search_crm query "*" to enumerate all synthetic accounts when a task requires a full-world scan; do not guess customer names.',
        "Follow the response shape in the task exactly and omit every field that shape does not declare.",
        "When the answer is ready, stop calling tools and return exactly ANSWER: followed by one JSON object with no surrounding prose.",
      ].join("\n"),
    },
    { role: "user", content: input.task.prompt },
  ];
  let status: CrossSystemTrajectory["status"] = "completed";
  let infrastructureError: string | null = null;
  let formatRepairAttempts = 0;
  let toolNudgeAttempts = 0;
  let forceFinalAnswer = false;
  try {
    const maxTurns = Math.max(1, Math.min(input.task.budget.maxTurns, input.maxTurns ?? input.task.budget.maxTurns));
    const maxFormatRepairs = Math.max(0, Math.min(2, input.maxFormatRepairs ?? 1));
    for (let turn = 0; turn < maxTurns; turn += 1) {
      throwIfAborted(input.signal);
      const accumulator = new NativeToolCallAccumulator();
      let text = "";
      let continuation: HostedChatContinuation | null = null;
      const requestTools = forceFinalAnswer ? [] : tools;
      for await (const delta of input.stream({
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        messages,
        tools: requestTools,
        toolChoice: forceFinalAnswer ? "none" : "auto",
        requestId: `cso-frontier:${id.slice(-36)}:${turn}`,
        signal: input.signal,
      })) {
        if (delta.text) text += delta.text;
        if (delta.continuation) continuation = delta.continuation;
        if (delta.toolCalls?.length) accumulator.append(delta.toolCalls);
      }
      const toolCalls = accumulator.completed();
      if (!toolCalls.length) {
        messages.push({ role: "assistant", content: text, ...(continuation ? { continuation } : {}) });
        const invalidAnswer = !hasValidAnswerEnvelope(text);
        const canContinue = turn < maxTurns - 1;
        if (
          formatRepairAttempts < maxFormatRepairs
          && canContinue
          && invalidAnswer
          && (
            looksLikeAnswerAttempt(text)
            || hasRequiredToolEvidence(input.task, steps)
          )
        ) {
          steps.push({ kind: "model", turn, content: text });
          formatRepairAttempts += 1;
          forceFinalAnswer = true;
          messages.push({
            role: "user",
            content: [
              "Your last response did not match the public response contract.",
              "Return only ANSWER: followed by one JSON object matching the shape in the task.",
              "Do not include analysis, explanation, markdown, or any surrounding prose.",
            ].join(" "),
          });
          continue;
        }
        if (
          canContinue
          && invalidAnswer
          && !looksLikeAnswerAttempt(text)
          && !hasRequiredToolEvidence(input.task, steps)
        ) {
          steps.push({ kind: "model", turn, content: text });
          toolNudgeAttempts += 1;
          forceFinalAnswer = false;
          const completedTools = successfulToolNames(steps);
          const missingTools = [...new Set(
            input.task.queryPlan
              .map((item) => item.tool)
              .filter((name) => !completedTools.has(name)),
          )];
          messages.push({
            role: "user",
            content: [
              "Continue the task with the registered tools before answering.",
              `Collect the remaining required evidence from: ${missingTools.join(", ")}.`,
              "Do not guess operational facts or return a final answer yet.",
            ].join(" "),
          });
          continue;
        }
        steps.push({ kind: "final", turn, content: text });
        break;
      }
      forceFinalAnswer = false;
      if (text.trim()) steps.push({ kind: "model", turn, content: text });
      messages.push(assistantMessageForNativeToolCalls(text, toolCalls, { continuation }));
      for (const call of toolCalls) {
        if (!isCrossSystemToolName(call.name)) {
          messages.push(toolResultMessage(unknownNativeToolResult(call)));
          continue;
        }
        let args: Record<string, unknown>;
        try {
          args = parseNativeToolArguments(call);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          steps.push({ kind: "tool_call", turn, callId: call.id, name: call.name, arguments: {} });
          steps.push({ kind: "tool_result", turn, callId: call.id, name: call.name, ok: false, result: null, rows: 0, bytes: 0, durationMs: 0, error: `Schema violation: ${message}` });
          messages.push(toolResultMessage(invalidNativeToolArgumentsResult(call, message)));
          continue;
        }
        steps.push({ kind: "tool_call", turn, callId: call.id, name: call.name, arguments: args });
        try {
          const result = await environment.execute(call.name, args, input.signal);
          const evidence = environment.evidence.at(-1)!;
          steps.push({ kind: "tool_result", turn, callId: call.id, name: call.name, ok: true, result, rows: evidence.rows, bytes: evidence.bytes, durationMs: evidence.durationMs, error: null });
          messages.push(toolResultMessage({ toolCallId: call.id, name: call.name, ok: true, contentText: JSON.stringify({ ok: true, result }) }));
        } catch (error) {
          const evidence = environment.evidence.at(-1);
          const message = error instanceof Error ? error.message : String(error);
          steps.push({ kind: "tool_result", turn, callId: call.id, name: call.name, ok: false, result: null, rows: evidence?.rows ?? 0, bytes: evidence?.bytes ?? 0, durationMs: evidence?.durationMs ?? 0, error: message });
          messages.push(toolResultMessage({ toolCallId: call.id, name: call.name, ok: false, contentText: JSON.stringify({ ok: false, error: message }) }));
          if (error instanceof CrossSystemToolError && error.code === "budget_exhausted") status = "budget_exhausted";
        }
      }
      if (status === "budget_exhausted") break;
      if (turn === maxTurns - 1) status = "budget_exhausted";
    }
  } catch (error) {
    if (input.signal.aborted) status = "cancelled";
    else {
      status = "infrastructure_failure";
      infrastructureError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await environment.close();
  }
  return CrossSystemTrajectorySchema.parse({
    schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
    id,
    worldId: input.world.id,
    taskId: input.task.id,
    toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    modelRef: input.model,
    status,
    steps,
    startedAt,
    completedAt: new Date().toISOString(),
    infrastructureError,
    metadata: {
      baseline: input.metadata ? null : "frontier",
      execution: "provider_tool_loop",
      worldSeed: input.world.seed,
      worldSplit: input.world.split,
      worldDifficulty: input.world.difficulty,
      formatRepairAttempts,
      toolNudgeAttempts,
      ...input.metadata,
    },
  });
}

function hasValidAnswerEnvelope(value: string): boolean {
  try {
    parseCrossSystemAnswer(value);
    return true;
  } catch {
    return false;
  }
}

function looksLikeAnswerAttempt(value: string): boolean {
  const trimmed = value.trim();
  return /(?:^|\s)ANSWER\s*:/i.test(trimmed) || trimmed.startsWith("{");
}

function successfulToolNames(
  steps: CrossSystemTrajectoryStep[],
): Set<CrossSystemToolName> {
  return new Set(
    steps.flatMap((step) =>
      step.kind === "tool_result" && step.ok && isCrossSystemToolName(step.name)
        ? [step.name]
        : [],
    ),
  );
}

function hasRequiredToolEvidence(
  task: CrossSystemTask,
  steps: CrossSystemTrajectoryStep[],
): boolean {
  const completedTools = successfulToolNames(steps);
  return task.queryPlan.every((item) => completedTools.has(item.tool));
}

function crossSystemTools(): HostedChatTool[] {
  const requested = CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => ({
    type: "function" as const,
    function: {
      name: definition.name,
      description: definition.description,
      parameters: structuredClone(definition.parameters) as Record<string, unknown>,
    },
  }));
  return crossSystemToolsFromRequest(requested, "auto");
}

function isCrossSystemToolName(value: string): value is CrossSystemToolName {
  return (CROSS_SYSTEM_TOOL_NAMES as readonly string[]).includes(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new Error("Cross-system frontier baseline was cancelled.");
}
