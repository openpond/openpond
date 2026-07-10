import type { ChatProvider } from "@openpond/contracts";

export type ReasoningContinuationMode = "none" | "zai_preserved_thinking";

export function reasoningContinuationMode(input: {
  provider: ChatProvider;
  model: string | null | undefined;
}): ReasoningContinuationMode {
  if (input.provider !== "zai") return "none";
  const model = input.model?.trim().toLowerCase() ?? "";
  return /(?:^|[/_-])glm-(?:4\.(?:[5-9]|\d{2,})|[5-9](?:\.\d+)?)(?:$|[/_-])/.test(model)
    ? "zai_preserved_thinking"
    : "none";
}

export function reasoningContentForToolContinuation(input: {
  provider: ChatProvider;
  model: string | null | undefined;
  reasoningText: string;
}): string | null {
  if (reasoningContinuationMode(input) === "none") return null;
  return input.reasoningText.length > 0 ? input.reasoningText : null;
}
