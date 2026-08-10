import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  CROSS_SYSTEM_TOOL_NAMES,
  CrossSystemTrajectorySchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type CrossSystemToolName,
} from "@openpond/contracts";
import type { HostedChatMessage, HostedChatTool } from "@openpond/cloud";
import type { TasksetWorkModelStream } from "../taskset-work-attempt-runner.js";
import { CrossSystemEnvironment, CrossSystemToolError } from "./environment.js";
import type { CrossSystemTask, CrossSystemWorld } from "./types.js";

export type CrossSystemModelStream = TasksetWorkModelStream;

export async function runCrossSystemRollout(input: {
  world: CrossSystemWorld;
  task: CrossSystemTask;
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | "none" | null;
  stream: CrossSystemModelStream;
  signal: AbortSignal;
  trajectoryId: string;
  metadata?: Record<string, unknown>;
}) {
  const startedAt = new Date().toISOString();
  const environment = new CrossSystemEnvironment({
    attemptId: input.trajectoryId,
    world: input.world,
    task: input.task,
  });
  const steps: Array<Record<string, unknown>> = [];
  const messages: HostedChatMessage[] = [
    { role: "system", content: "Use the registered synthetic data tools. Finish with ANSWER: followed by one JSON object." },
    { role: "user", content: input.task.prompt },
  ];
  let status: "completed" | "budget_exhausted" | "cancelled" | "infrastructure_failure" = "completed";
  let infrastructureError: string | null = null;
  try {
    for (let turn = 0; turn <= input.task.budget.maxTurns; turn += 1) {
      if (input.signal.aborted) throw input.signal.reason ?? new Error("Cross-system rollout cancelled.");
      let content = "";
      const toolCalls: import("@openpond/cloud").HostedChatToolCall[] = [];
      for await (const delta of input.stream({
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        messages,
        tools: crossSystemTools(),
        toolChoice: "auto",
        requestId: `${input.trajectoryId}:${turn}`,
        signal: input.signal,
      })) {
        if (delta.text) content += delta.text;
        if (delta.toolCalls) toolCalls.push(...delta.toolCalls);
      }
      if (content) steps.push({ kind: "model", turn, content });
      if (!toolCalls.length) {
        steps.push({ kind: "final", turn, content });
        break;
      }
      messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
      for (const [index, call] of toolCalls.entries()) {
        const callId = call.id?.trim() || `${input.trajectoryId}:${turn}:${index}`;
        const name = call.function?.name;
        if (!name || !(CROSS_SYSTEM_TOOL_NAMES as readonly string[]).includes(name)) {
          throw new Error(`Model requested unknown cross-system tool ${name ?? "<missing>"}.`);
        }
        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse(call.function?.arguments ?? "{}");
          args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch {
          args = {};
        }
        steps.push({ kind: "tool_call", turn, callId, name, arguments: args });
        const before = environment.evidence.length;
        try {
          const result = await environment.execute(name as CrossSystemToolName, args, input.signal);
          const evidence = environment.evidence[before]!;
          steps.push({ kind: "tool_result", turn, callId, name, ok: true, result, rows: evidence.rows, bytes: evidence.bytes, durationMs: evidence.durationMs, error: null });
          messages.push({ role: "tool", tool_call_id: callId, name, content: JSON.stringify(result) });
        } catch (error) {
          const evidence = environment.evidence[before];
          const message = error instanceof Error ? error.message : String(error);
          steps.push({ kind: "tool_result", turn, callId, name, ok: false, result: null, rows: evidence?.rows ?? 0, bytes: evidence?.bytes ?? 0, durationMs: evidence?.durationMs ?? 0, error: message });
          messages.push({ role: "tool", tool_call_id: callId, name, content: JSON.stringify({ ok: false, error: message }) });
          if (error instanceof CrossSystemToolError && error.code === "budget_exhausted") {
            status = "budget_exhausted";
            break;
          }
        }
      }
      if (status === "budget_exhausted") break;
      if (turn === input.task.budget.maxTurns) status = "budget_exhausted";
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
    id: input.trajectoryId,
    worldId: input.world.id,
    taskId: input.task.id,
    toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    modelRef: input.model,
    status,
    steps,
    startedAt,
    completedAt: new Date().toISOString(),
    infrastructureError,
    metadata: input.metadata ?? {},
  });
}

function crossSystemTools(): HostedChatTool[] {
  return CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: structuredClone(definition.parameters) as Record<string, unknown>,
    },
  }));
}
