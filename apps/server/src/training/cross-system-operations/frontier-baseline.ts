import { randomUUID } from "node:crypto";
import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  CROSS_SYSTEM_TOOL_NAMES,
  CrossSystemTrajectorySchema,
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
import { buildCrossSystemBaselineReport, type CrossSystemBaselineReport } from "./baseline.js";
import { CrossSystemEnvironment, CrossSystemToolError } from "./environment.js";
import type { CrossSystemTask, CrossSystemWorld } from "./types.js";
import { verifyCrossSystemTrajectory } from "./verifier.js";

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
}): Promise<{
  report: CrossSystemBaselineReport;
  tasks: CrossSystemTask[];
  trajectories: CrossSystemTrajectory[];
  results: CrossSystemVerifierResult[];
}> {
  const selectedTasks = input.tasks.filter((task) => task.phrasingVariant === 0);
  const worldById = new Map(input.worlds.map((world) => [world.id, world]));
  const signal = input.signal ?? new AbortController().signal;
  const trajectories: CrossSystemTrajectory[] = [];
  const results: CrossSystemVerifierResult[] = [];
  for (const task of selectedTasks) {
    throwIfAborted(signal);
    const world = worldById.get(task.worldId);
    if (!world) throw new Error(`Missing world ${task.worldId}.`);
    const trajectory = await runFrontierTask({ ...input, world, task, signal });
    trajectories.push(trajectory);
    results.push(verifyCrossSystemTrajectory({ task, trajectory }));
  }
  return {
    report: buildCrossSystemBaselineReport({
      id: `cso_frontier_baseline_${randomUUID()}`,
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

async function runFrontierTask(input: {
  world: CrossSystemWorld;
  task: CrossSystemTask;
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  stream: CrossSystemFrontierModelStream;
  signal: AbortSignal;
}): Promise<CrossSystemTrajectory> {
  const id = `cso_frontier_${randomUUID()}`;
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
        "When the answer is ready, stop calling tools and return exactly ANSWER: followed by one JSON object with no surrounding prose.",
      ].join("\n"),
    },
    { role: "user", content: input.task.prompt },
  ];
  let status: CrossSystemTrajectory["status"] = "completed";
  let infrastructureError: string | null = null;
  try {
    for (let turn = 0; turn < input.task.budget.maxTurns; turn += 1) {
      throwIfAborted(input.signal);
      const accumulator = new NativeToolCallAccumulator();
      let text = "";
      let continuation: HostedChatContinuation | null = null;
      for await (const delta of input.stream({
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        messages,
        tools,
        toolChoice: "auto",
        requestId: `cso-frontier:${id.slice(-36)}:${turn}`,
        signal: input.signal,
      })) {
        if (delta.text) text += delta.text;
        if (delta.continuation) continuation = delta.continuation;
        if (delta.toolCalls?.length) accumulator.append(delta.toolCalls);
      }
      const toolCalls = accumulator.completed();
      if (!toolCalls.length) {
        steps.push({ kind: "final", turn, content: text });
        messages.push({ role: "assistant", content: text, ...(continuation ? { continuation } : {}) });
        break;
      }
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
      if (turn === input.task.budget.maxTurns - 1) status = "budget_exhausted";
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
      baseline: "frontier",
      execution: "provider_tool_loop",
      worldSeed: input.world.seed,
      worldSplit: input.world.split,
      worldDifficulty: input.world.difficulty,
    },
  });
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
