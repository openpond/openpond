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
import { CrossSystemEnvironment, CrossSystemToolError } from "./environment.js";
import type { CrossSystemTask, CrossSystemWorld } from "./types.js";
import { parseCrossSystemAnswer } from "./verifier.js";

export type CrossSystemModelDelta = {
  text?: string;
  continuation?: HostedChatContinuation;
  toolCalls?: HostedChatToolCall[];
  responseFacts?: {
    providerResponseIdentity: string;
    promptTokens: number | null;
    generatedTokens: number | null;
    samplingSupport: {
      seed: boolean;
      temperature: boolean;
      topP: boolean;
    };
  };
};

export type CrossSystemModelStream = (input: {
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  messages: HostedChatMessage[];
  tools: HostedChatTool[];
  toolChoice: HostedChatToolChoice;
  requestId: string;
  signal: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
}) => AsyncIterable<CrossSystemModelDelta>;

export async function runCrossSystemRollout(input: {
  world: CrossSystemWorld;
  task: CrossSystemTask;
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  stream: CrossSystemModelStream;
  signal: AbortSignal;
  trajectoryId?: string;
  metadata?: Record<string, unknown>;
  maxTurns?: number;
  maxFormatRepairs?: number;
}): Promise<CrossSystemTrajectory> {
  const id = input.trajectoryId ?? `cso_rollout_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const environment = new CrossSystemEnvironment({
    attemptId: id,
    world: input.world,
    task: input.task,
  });
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
    const maxTurns = Math.max(
      1,
      Math.min(
        input.task.budget.maxTurns,
        input.maxTurns ?? input.task.budget.maxTurns,
      ),
    );
    const maxFormatRepairs = Math.max(
      0,
      Math.min(2, input.maxFormatRepairs ?? 1),
    );
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
        requestId: `cso-rollout:${id.slice(-36)}:${turn}`,
        signal: input.signal,
      })) {
        if (delta.text) text += delta.text;
        if (delta.continuation) continuation = delta.continuation;
        if (delta.toolCalls?.length) accumulator.append(delta.toolCalls);
      }
      const toolCalls = accumulator.completed();
      if (!toolCalls.length) {
        messages.push({
          role: "assistant",
          content: text,
          ...(continuation ? { continuation } : {}),
        });
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
            content:
              "Return only ANSWER: followed by one JSON object matching the task shape. Do not include analysis, markdown, or surrounding prose.",
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
          const missingTools = [
            ...new Set(
              input.task.queryPlan
                .map((item) => item.tool)
                .filter((name) => !completedTools.has(name)),
            ),
          ];
          messages.push({
            role: "user",
            content:
              "Continue with the registered tools before answering. "
              + `Collect the remaining evidence from: ${missingTools.join(", ")}.`,
          });
          continue;
        }
        steps.push({ kind: "final", turn, content: text });
        break;
      }
      forceFinalAnswer = false;
      if (text.trim()) steps.push({ kind: "model", turn, content: text });
      messages.push(
        assistantMessageForNativeToolCalls(text, toolCalls, { continuation }),
      );
      for (const call of toolCalls) {
        if (!isCrossSystemToolName(call.name)) {
          messages.push(toolResultMessage(unknownNativeToolResult(call)));
          continue;
        }
        let args: Record<string, unknown>;
        try {
          args = parseNativeToolArguments(call);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          steps.push({
            kind: "tool_call",
            turn,
            callId: call.id,
            name: call.name,
            arguments: {},
          });
          steps.push({
            kind: "tool_result",
            turn,
            callId: call.id,
            name: call.name,
            ok: false,
            result: null,
            rows: 0,
            bytes: 0,
            durationMs: 0,
            error: `Schema violation: ${message}`,
          });
          messages.push(
            toolResultMessage(
              invalidNativeToolArgumentsResult(call, message),
            ),
          );
          continue;
        }
        steps.push({
          kind: "tool_call",
          turn,
          callId: call.id,
          name: call.name,
          arguments: args,
        });
        try {
          const result = await environment.execute(
            call.name,
            args,
            input.signal,
          );
          const evidence = environment.evidence.at(-1)!;
          steps.push({
            kind: "tool_result",
            turn,
            callId: call.id,
            name: call.name,
            ok: true,
            result,
            rows: evidence.rows,
            bytes: evidence.bytes,
            durationMs: evidence.durationMs,
            error: null,
          });
          messages.push(
            toolResultMessage({
              toolCallId: call.id,
              name: call.name,
              ok: true,
              contentText: JSON.stringify({ ok: true, result }),
            }),
          );
        } catch (error) {
          const evidence = environment.evidence.at(-1);
          const message =
            error instanceof Error ? error.message : String(error);
          steps.push({
            kind: "tool_result",
            turn,
            callId: call.id,
            name: call.name,
            ok: false,
            result: null,
            rows: evidence?.rows ?? 0,
            bytes: evidence?.bytes ?? 0,
            durationMs: evidence?.durationMs ?? 0,
            error: message,
          });
          messages.push(
            toolResultMessage({
              toolCallId: call.id,
              name: call.name,
              ok: false,
              contentText: JSON.stringify({ ok: false, error: message }),
            }),
          );
          if (
            error instanceof CrossSystemToolError
            && error.code === "budget_exhausted"
          ) {
            status = "budget_exhausted";
          }
        }
      }
      if (status === "budget_exhausted") break;
      if (turn === maxTurns - 1) status = "budget_exhausted";
    }
  } catch (error) {
    if (input.signal.aborted) {
      status = "cancelled";
    } else {
      status = "infrastructure_failure";
      infrastructureError =
        error instanceof Error ? error.message : String(error);
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
      step.kind === "tool_result"
      && step.ok
      && isCrossSystemToolName(step.name)
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
      parameters: structuredClone(
        definition.parameters,
      ) as Record<string, unknown>,
    },
  }));
  return crossSystemToolsFromRequest(requested, "auto");
}

function isCrossSystemToolName(value: string): value is CrossSystemToolName {
  return (CROSS_SYSTEM_TOOL_NAMES as readonly string[]).includes(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new Error("Cross-System rollout was cancelled.");
}
