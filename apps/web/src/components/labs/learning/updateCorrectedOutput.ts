/** Keep a normalized response and its matching final message consistent without changing evidence. */
export function updateCorrectedOutput(output: Record<string, unknown>, field: string, value: string): Record<string, unknown> {
  const updated = { ...output, [field]: value };
  if (field !== "response" || !Array.isArray(output.messages)) return updated;
  const last = output.messages.at(-1);
  if (!last || typeof last !== "object" || Array.isArray(last) || last.role !== "assistant" || last.content !== output.response) return updated;
  return { ...updated, messages: [...output.messages.slice(0, -1), { ...last, content: value }] };
}

