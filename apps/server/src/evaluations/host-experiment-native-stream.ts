import { z } from "zod";
import { contentHash, type ToolDeclaration } from "@openpond/harness";
import type { AgentHostStorageClient } from "@openpond/agent-runtime";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { JavaScriptEnvironmentPolicyMessage } from "@openpond/evals/javascript-environment/attempt";
import type { ExperimentModelCase } from "./experiment-case-contract.js";
import { createHostExperimentPolicy } from "./host-experiment-policy.js";

/** Feed the ordinary native turn through the existing owner-only policy
 * capability. Provider credentials, reasoning continuation and spend stay at
 * the owner. This adapter exposes no ordinary chat or Work authority. */
export function createHostExperimentNativeStream(
  client: AgentHostStorageClient, admitted: ExperimentModelCase, declarations: readonly ToolDeclaration[],
): typeof streamOpenPondHostedChatTurn {
  const policy = createHostExperimentPolicy(client, admitted);
  return async function* (request) {
    const model = admitted.model;
    if (!request.signal || request.model !== model.modelId || request.maxTokens !== model.maxOutputTokens
      || request.temperature !== model.temperature || request.topP !== model.topP)
      throw new Error("Native Experiment policy request differs from its admitted model configuration.");
    const messages: JavaScriptEnvironmentPolicyMessage[] = request.messages.map(message => {
      if (message.images?.length || message.continuation)
        throw new Error("The owner policy capability does not admit multimodal or caller-supplied continuation inputs.");
      if (message.role === "tool") return {
        role: "tool", callId: z.string().min(1).max(200).parse(message.tool_call_id),
        name: z.string().min(1).max(64).parse(message.name),
        observation: observation(message.content ?? ""),
      };
      if (message.role === "assistant") return {
        role: "assistant", text: message.content ?? "", toolCalls: (message.tool_calls ?? []).map(call => ({
          id: z.string().min(1).max(200).parse(call.id), name: z.string().min(1).max(64).parse(call.function?.name),
          arguments: z.record(z.string(), z.unknown()).parse(JSON.parse(z.string().parse(call.function?.arguments))),
        })),
      };
      if (message.role !== "user" && message.role !== "system") throw new Error("Native Experiment message role is not admitted.");
      return { role: message.role, text: message.content ?? "" };
    });
    const tools = (request.tools ?? []).map(tool => {
      if (tool.type !== "function" || !tool.function) throw new Error("Native Experiment requires declared function tools.");
      const declaration = declarations.find(value => value.name === tool.function!.name);
      if (!declaration || contentHash(tool.function.parameters) !== declaration.inputSchemaHash)
        throw new Error("Native Experiment requested an undeclared or changed tool.");
      return declaration;
    });
    if (tools.length !== declarations.length || new Set(tools.map(tool => tool.name)).size !== tools.length)
      throw new Error("Native Experiment changed its admitted tool inventory.");
    const result = await policy({ messages, tools, signal: request.signal });
    request.signal.throwIfAborted();
    if (result.text) yield { type: "text_delta", text: result.text, raw: null };
    if (result.toolCalls.length) yield { type: "tool_call_delta", toolCalls: result.toolCalls.map(call => ({
      id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })), raw: null };
    yield { type: "finish", finishReason: result.toolCalls.length ? "tool_calls" : "stop", raw: null };
  };
}

function observation(text: string): Record<string, unknown> {
  // Native tools return both JSON objects and plain diagnostic text. Preserve
  // the latter as evidence instead of treating it as a parsing failure.
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : { output: value };
  } catch { return { output: text }; }
}
