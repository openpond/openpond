/** Presentation only: routing keeps the provider's exact advertised model ID. */
export function modelDisplayLabel(label: string): string {
  const value = label
    .replace(/\s+\(default\)$/i, "")
    .replace(/^accounts(?:\/| )[^/ ]+(?:\/| )models(?:\/| )/i, "")
    .replace(/^(?:openai|anthropic|google|xai|deepseek|qwen|meta-llama)\//i, "");
  if (/^gpt[- ]/i.test(value)) return value.replace(/^gpt[- ]/i, "GPT ").replace(/[- ](sol|astra|luna|terra)(?=\s|$)/i, (_, name: string) => ` ${name[0]!.toUpperCase()}${name.slice(1).toLowerCase()}`);
  if (/^deepseek[- ]v/i.test(value)) return value.replace(/^deepseek[- ]v/i, "DeepSeek V").replace(/(\d)p(\d)/g, "$1.$2").replace(/[- ](flash|pro)(?=\s|$)/i, (_, name: string) => ` ${name[0]!.toUpperCase()}${name.slice(1).toLowerCase()}`);
  if (/^glm[- ]/i.test(value)) return value.replace(/^glm[- ]/i, "GLM ").replace(/(\d)p(\d)/g, "$1.$2").replace(/[- ]flash(?=\s|$)/i, " Flash");
  return value;
}
