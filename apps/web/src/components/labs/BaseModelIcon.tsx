const marks = {
  qwen: "/model-brands/qwen.png",
  inkling: "/model-brands/thinking-machines.webp",
  claude: "/agent-sources/claude-code.svg",
  openai: "/agent-sources/codex.svg",
  gemini: "/model-brands/gemini.svg",
  llama: "/model-brands/meta.svg",
  mistral: "/model-brands/mistral-ai.svg",
  deepseek: "/model-brands/deepseek.png",
  grok: "/agent-sources/grok-build.svg",
};

export function BaseModelIcon({ modelId }: { modelId?: string | null }) {
  if (!modelId) return null;
  const id = modelId.toLowerCase();
  const name = id.split("/").at(-1) ?? "";
  const brand = /^(?:gpt|chatgpt|o[134])[-_.]/.test(name) ? "openai"
    : /^(?:mixtral|ministral|codestral|pixtral)[-_.]/.test(name) ? "mistral"
    : Object.keys(marks).find(key => name.startsWith(key) && /^[\d._-]?$/.test(name.slice(key.length, key.length + 1)));
  if (!brand) return null;
  return <img src={marks[brand as keyof typeof marks]} width={15} height={15} alt="" aria-hidden="true" />;
}
