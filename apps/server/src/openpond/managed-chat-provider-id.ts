import type { ChatProvider } from "@openpond/contracts";
import type { ProviderId } from "@openpond/contracts/providers";

export const OPENAI_COMPATIBLE_PROVIDER_IDS = [
  "openai",
  "xai",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "custom-openai-compatible",
] as const satisfies readonly ProviderId[];

export type OpenAiCompatibleProviderId = (typeof OPENAI_COMPATIBLE_PROVIDER_IDS)[number];

export function isOpenAiCompatibleProviderId(
  providerId: ProviderId,
): providerId is OpenAiCompatibleProviderId {
  return (OPENAI_COMPATIBLE_PROVIDER_IDS as readonly ProviderId[]).includes(providerId);
}

export function isManagedLocalChatProvider(provider: ChatProvider): boolean {
  return provider === "anthropic" || isOpenAiCompatibleProviderId(provider);
}
