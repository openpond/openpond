import type { RuntimeEvent } from "@openpond/contracts";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Recover the final response, preserving streamed whitespace and replacing
 * provisional native chunks with their authoritative completed snapshots. */
export function assistantResponseText(events: readonly RuntimeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.name !== "turn.completed") continue;
    const items = record(record(event.data)?.turn)?.items;
    if (!Array.isArray(items)) continue;
    const messages = items
      .map(record)
      .filter(
        (item) =>
          item?.type === "agentMessage" &&
          typeof item.text === "string" &&
          item.text.trim() &&
          item.phase !== "commentary" &&
          item.phase !== "reasoning" &&
          item.phase !== "analysis",
      );
    const final = messages.findLast((item) => item?.phase === "final_answer") ?? messages.at(-1);
    if (final) return (final.text as string).trim();
  }

  const messages = new Map<string, string>();
  let latestId: string | null = null;
  for (const event of events) {
    if (event.name !== "assistant.delta" || !event.output) continue;
    const data = record(event.data);
    if (data?.phase === "commentary" || data?.phase === "reasoning" || data?.phase === "analysis")
      continue;
    const id =
      typeof data?.nativeMessageId === "string"
        ? data.nativeMessageId
        : typeof data?.itemId === "string"
          ? data.itemId
          : "response";
    messages.set(
      id,
      data?.nativeMessageSnapshot === true
        ? event.output
        : `${messages.get(id) ?? ""}${event.output}`,
    );
    latestId = id;
  }
  return latestId ? messages.get(latestId)?.trim() || null : null;
}
