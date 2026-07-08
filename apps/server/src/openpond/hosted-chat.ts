import type { HostedChatMessage } from "@openpond/cloud";
import { formatPromptWithAttachmentContext } from "../chat-attachments.js";
import { textFromUnknown } from "../utils.js";

type ProviderProjectionEvent = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  action?: string | null;
  error?: string | null;
  output?: string | null;
  status?: string | null;
  data?: unknown;
  turnId?: string | null;
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
        compacted.preservedResourceRefs.length > 0
          ? `Preserved resource refs:\n${compacted.preservedResourceRefs.map((ref) => `- ${ref}`).join("\n")}`
          : null,
        "Use this as continuity context. Do not mention compaction unless asked.",
      ].filter(Boolean).join("\n\n"),
    });
  }

  for (const item of replayEventsAfterCompaction(events, compacted)) {
    if (item.name === "session.compaction.completed") continue;
    if (compacted && isFailureProjectionEvent(item)) {
      const value = failureProjectionContent(item);
      if (value) messages.push({ role: "system", content: value });
      continue;
    }
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
  preservedEventIds: string[];
  preservedResourceRefs: string[];
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
      preservedEventIds: compactionPreservedEventIds(item.data),
      preservedResourceRefs: compactionPreservedResourceRefs(item.data),
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
  const priorReplay = events.slice(replayStart, compacted.index);
  const preservedIds = compacted.preservedEventIds.length > 0 ? new Set(compacted.preservedEventIds) : null;
  const preservedReplay = preservedIds ? priorReplay.filter((item) => item.id && preservedIds.has(item.id)) : priorReplay;
  return [...preservedReplay, ...events.slice(compacted.index + 1)];
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

function compactionPreservedEventIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const ids = (value as { preservedEventIds?: unknown }).preservedEventIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function compactionPreservedResourceRefs(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const refs = (value as { preservedResourceRefs?: unknown }).preservedResourceRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isFailureProjectionEvent(event: ProviderProjectionEvent): boolean {
  return event.name === "turn.failed" || event.status === "failed";
}

function failureProjectionContent(event: ProviderProjectionEvent): string | null {
  const body = [
    event.error,
    event.output,
    event.action,
    event.data ? textFromUnknown(event.data) : null,
  ].filter((value): value is string => Boolean(value && value.trim())).join("\n");
  if (!body.trim()) return null;
  const metadata = [
    event.turnId ? `turn=${event.turnId}` : null,
    event.action ? `action=${event.action}` : null,
    event.status ? `status=${event.status}` : null,
  ].filter(Boolean).join(" ");
  const label = metadata ? `Recent unresolved failure (${metadata}):` : "Recent unresolved failure:";
  return `${label}\n${body}`;
}
