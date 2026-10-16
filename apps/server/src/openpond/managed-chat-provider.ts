import { streamAnthropicChatCompletion } from "./anthropic-provider.js";
import { streamOpenAiCompatibleChatCompletion } from "./openai-compatible-provider.js";
export { isManagedLocalChatProvider } from "./managed-chat-provider-id.js";

export function streamManagedLocalChatCompletion(input: Parameters<typeof streamOpenAiCompatibleChatCompletion>[0]) {
  return input.providerId === "anthropic" ? streamAnthropicChatCompletion(input) : streamOpenAiCompatibleChatCompletion(input);
}
