import type { HostedChatContinuation, HostedChatMessage } from "@openpond/cloud";
import type { ChatModelRef, CodexReasoningEffort } from "@openpond/contracts";
import type { runJavaScriptEnvironmentAttempt } from "@openpond/evals/javascript-environment/attempt";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { NativeToolCallAccumulator, parseNativeToolArguments } from "../openpond/native-tool-calls.js";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-types.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";

type Policy = Parameters<typeof runJavaScriptEnvironmentAttempt>[0]["policy"];

/** Adapts provider streaming while keeping provider continuations outside the world. */
export function createStarterToolPolicy(input: {
  stream: TasksetWorkModelStream;
  model: ChatModelRef;
  reasoningEffort?: CodexReasoningEffort | "none" | null;
  requestId: string;
  seed: number;
  sampling?: { maxOutputTokens: number; temperature: number; topP: number };
  hostedTokenPricing?: HostedTokenPricing;
}) {
  let turn = 0;
  let costUsd: number | null = null;
  const continuations = new Map<number, HostedChatContinuation>();
  const policy: Policy = async ({ messages, tools, signal }) => {
    signal.throwIfAborted();
    let assistantIndex = 0;
    const providerMessages: HostedChatMessage[] = messages.map(message => {
      if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, name: message.name, content: JSON.stringify(message.observation) };
      if (message.role === "assistant") {
        const continuation = continuations.get(assistantIndex++);
        return { role: "assistant", content: message.text || null, ...(continuation ? { continuation } : {}), tool_calls: message.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
      }
      return { role: message.role, content: message.text };
    });
    assertBoundedTaskJson(providerMessages, 8_388_608);
    const currentTurn = turn++;
    const accumulator = new NativeToolCallAccumulator();
    let text = "";
    let responseBytes = 0;
    for await (const delta of input.stream({
      model: input.model, reasoningEffort: input.reasoningEffort ?? null,
      messages: providerMessages,
      tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      toolChoice: "auto", requestId: `${input.requestId}:${currentTurn}`, signal,
      maxOutputTokens: input.sampling?.maxOutputTokens ?? 4_096,
      temperature: input.sampling?.temperature ?? 0, topP: input.sampling?.topP ?? 1,
      seed: input.seed, hostedTokenPricing: input.hostedTokenPricing,
    })) {
      signal.throwIfAborted();
      // Provider adapters may emit explicit undefined optional fields. Project
      // their JSON wire content before applying the portable JSON boundary.
      const wire = definedFields({ text: delta.text, continuation: delta.continuation, toolCalls: delta.toolCalls?.map(call => definedFields({ ...call, function: call.function ? definedFields(call.function) : undefined })) });
      assertBoundedTaskJson(wire, 1_048_576);
      responseBytes += new TextEncoder().encode(JSON.stringify(wire)).byteLength;
      if (responseBytes > 1_048_576) throw new Error("Model tool response exceeded its byte budget.");
      if (delta.text) text += delta.text;
      if (delta.toolCalls) accumulator.append(delta.toolCalls);
      if (delta.continuation) continuations.set(currentTurn, structuredClone(delta.continuation));
      if (typeof delta.costUsd === "number" && Number.isFinite(delta.costUsd) && delta.costUsd >= 0) costUsd = (costUsd ?? 0) + delta.costUsd;
    }
    signal.throwIfAborted();
    return { text, toolCalls: accumulator.completed({ strict: true }).map(call => ({ id: call.id, name: call.name, arguments: parseNativeToolArguments(call) })) };
  };
  return { policy, costUsd: () => costUsd };
}

function definedFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
