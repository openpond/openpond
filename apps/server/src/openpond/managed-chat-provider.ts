import { streamAnthropicChatCompletion } from "./anthropic-provider.js";
import { isOpenAiCompatibleProviderId, streamOpenAiCompatibleChatCompletion } from "./openai-compatible-provider.js";
import type { ChatProvider } from "@openpond/contracts";

export function isManagedLocalChatProvider(provider: ChatProvider): boolean {
  return provider === "anthropic" || isOpenAiCompatibleProviderId(provider);
}

export function streamManagedLocalChatCompletion(input: Parameters<typeof streamOpenAiCompatibleChatCompletion>[0]) {
  return input.providerId === "anthropic" ? streamAnthropicChatCompletion(input) : streamOpenAiCompatibleChatCompletion(input);
}
