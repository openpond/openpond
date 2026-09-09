import { randomUUID } from "node:crypto";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { createManagedAdapterChatRuntime } from "./managed-adapter-chat-runtime.js";

/** Preserve the selected managed Version through ordinary chat and compaction. */
export function createManagedAdapterHostedChatStream(dependencies: {
  managed: ReturnType<typeof createManagedAdapterChatRuntime>;
  hosted: typeof streamOpenPondHostedChatTurn;
}): typeof streamOpenPondHostedChatTurn {
  return async function* (input) {
    if (!await dependencies.managed.appliesTo(input.model)) {
      yield* dependencies.hosted(input);
      return;
    }
    for await (const delta of dependencies.managed.stream({
      modelId: input.model,
      messages: input.messages,
      tools: input.tools,
      toolChoice: input.toolChoice,
      requestId: input.requestId ?? randomUUID(),
      maxNewTokens: input.maxTokens,
      temperature: input.temperature,
      signal: input.signal ?? new AbortController().signal,
    })) {
      if (delta.text) yield { type: "text_delta", text: delta.text, raw: delta.raw };
      if (delta.toolCalls) yield { type: "tool_call_delta", toolCalls: delta.toolCalls, raw: delta.raw };
      if (delta.usage) yield { type: "usage", usage: delta.usage, raw: delta.raw };
      if (delta.finishReason !== undefined) yield { type: "finish", finishReason: delta.finishReason, raw: delta.raw };
    }
  };
}
