/** Presentation only: routing keeps the provider's exact advertised model ID. */
export function modelDisplayLabel(label: string): string {
  return label
    .replace(/\s+\(default\)$/i, "")
    .replace(/^(?:openai|anthropic|google|xai|deepseek|qwen|meta-llama)\//i, "")
    .replace(/^gpt-/i, "GPT-");
}
