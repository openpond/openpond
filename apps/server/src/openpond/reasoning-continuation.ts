import type { ChatProvider } from "@openpond/contracts";
import type { HostedChatContinuation, HostedChatMessage } from "@openpond/cloud";

export type ChatCompletionsReasoningPolicy = {
  kind: "chat_completions_reasoning";
  requestThinking: "zai_clear_thinking" | "deepseek_enabled";
  supportsToolChoice: boolean;
};

export function chatCompletionsReasoningPolicy(input: {
  provider: ChatProvider;
  model: string | null | undefined;
}): ChatCompletionsReasoningPolicy | null {
  const model = input.model?.trim().toLowerCase() ?? "";
  if (
    input.provider === "zai" &&
    /(?:^|[/_-])glm-(?:4\.(?:[5-9]|\d{2,})|[5-9](?:\.\d+)?)(?:$|[/_-])/.test(model)
  ) {
    return {
      kind: "chat_completions_reasoning",
      requestThinking: "zai_clear_thinking",
      supportsToolChoice: true,
    };
  }
  if (
    input.provider === "deepseek" &&
    /(?:^|[/_-])deepseek-v(?:3\.2|[4-9](?:\.\d+)?)(?:$|[/_-])/.test(model)
  ) {
    return {
      kind: "chat_completions_reasoning",
      requestThinking: "deepseek_enabled",
      supportsToolChoice: false,
    };
  }
  return null;
}

export function chatCompletionsContinuation(input: {
  provider: ChatProvider;
  model: string | null | undefined;
  reasoningText: string;
  hasToolCalls: boolean;
}): HostedChatContinuation | null {
  if (!input.hasToolCalls || input.reasoningText.length === 0 || !chatCompletionsReasoningPolicy(input)) return null;
  return {
    kind: "chat_completions_reasoning",
    reasoningContent: input.reasoningText,
  };
}

export function hasChatCompletionsReasoningContinuation(messages: HostedChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.continuation?.kind === "chat_completions_reasoning" &&
      message.continuation.reasoningContent.length > 0,
  );
}
