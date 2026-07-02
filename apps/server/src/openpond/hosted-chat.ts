import type { HostedChatMessage } from "@openpond/cloud";
import { formatPromptWithAttachmentContext } from "../chat-attachments.js";

type ProviderProjectionEvent = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  output?: string | null;
  data?: unknown;
};

export function buildChatMessagesForProvider(
  events: ProviderProjectionEvent[],
  prompt: string,
  systemPrompt: string
): HostedChatMessage[] {
  const messages: HostedChatMessage[] = [{ role: "system", content: systemPrompt }];
  const compacted = latestCompactionContext(events);
  if (compacted) {
    messages.push({
      role: "system",
      content: [
        "Conversation summary from earlier turns:",
        compacted.summary,
        "Use this as continuity context. Do not mention compaction unless asked.",
      ].join("\n\n"),
    });
  }

  for (const item of replayEventsAfterCompaction(events, compacted)) {
    if (item.name === "session.compaction.completed") continue;
    if (item.name === "turn.started") {
      const value = typeof item.args?.prompt === "string" ? item.args.prompt.trim() : "";
      const attachmentContext =
        typeof item.args?.attachmentContext === "string" ? item.args.attachmentContext : "";
      if (value || attachmentContext) {
        messages.push({ role: "user", content: formatPromptWithAttachmentContext(value, attachmentContext) });
      }
      continue;
    }
    if (item.name === "assistant.delta") {
      const value = item.output ?? "";
      if (!value) continue;
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant") {
        previous.content += value;
      } else {
        messages.push({ role: "assistant", content: value });
      }
    }
  }
  if (prompt.trim()) messages.push({ role: "user", content: prompt });
  return messages;
}

type CompactionContext = {
  index: number;
  preservedFromEventId: string | null;
  summary: string;
};

function latestCompactionContext(events: ProviderProjectionEvent[]): CompactionContext | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    if (item.name !== "session.compaction.completed") continue;
    const summary = compactionSummary(item.data);
    if (!summary) continue;
    return {
      index,
      preservedFromEventId: compactionPreservedFromEventId(item.data),
      summary,
    };
  }
  return null;
}

function replayEventsAfterCompaction(
  events: ProviderProjectionEvent[],
  compacted: CompactionContext | null
): ProviderProjectionEvent[] {
  if (!compacted) return events;
  const preservedIndex = compacted.preservedFromEventId
    ? events.findIndex((item) => item.id === compacted.preservedFromEventId)
    : -1;
  const replayStart = preservedIndex >= 0 && preservedIndex < compacted.index ? preservedIndex : compacted.index + 1;
  return [...events.slice(replayStart, compacted.index), ...events.slice(compacted.index + 1)];
}

function compactionSummary(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
}

function compactionPreservedFromEventId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const preservedFromEventId = (value as { preservedFromEventId?: unknown }).preservedFromEventId;
  return typeof preservedFromEventId === "string" && preservedFromEventId.trim() ? preservedFromEventId : null;
}
