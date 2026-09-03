import type { ChatMessage } from "./app-models";

export type ChatTimelineMessageRow = {
  id: string;
  type: "message";
  message: ChatMessage;
  showFooter: boolean;
};

export type ChatTimelineThinkingRow = {
  id: "thinking";
  type: "thinking";
};

export type ChatTimelineRow = ChatTimelineMessageRow | ChatTimelineThinkingRow;

export function buildChatTimelineRows(
  messages: ChatMessage[],
  options: { showThinkingIndicator?: boolean } = {},
): ChatTimelineRow[] {
  const finalAssistantMessageId = latestAssistantMessageId(messages);
  const rows: ChatTimelineRow[] = messages.map((message) => ({
    id: `message:${message.id}`,
    type: "message",
    message,
    showFooter: message.id === finalAssistantMessageId,
  }));
  if (options.showThinkingIndicator) {
    rows.push({
      id: "thinking",
      type: "thinking",
    });
  }
  return rows;
}

export function latestAssistantMessageId(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant") return message.id;
  }
  return null;
}

export function latestAssistantMessageIdsByTurn(
  messages: ChatMessage[],
): ReadonlyMap<string, string> {
  const messageIds = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.turnId) {
      messageIds.set(message.turnId, message.id);
    }
  }
  return messageIds;
}

export function isLatestAssistantMessageForTurn(
  message: ChatMessage,
  latestAssistantByTurn: ReadonlyMap<string, string>,
): boolean {
  const turnId = message.turnId;
  return message.role === "assistant" &&
    turnId !== undefined &&
    latestAssistantByTurn.get(turnId) === message.id;
}

export function shouldShowThinkingIndicator(messages: ChatMessage[]): boolean {
  const latest = messages[messages.length - 1];
  if (!latest) return true;
  if (latest.role === "assistant" || latest.role === "error") return false;
  if (latest.role === "status_divider" && latest.statusState === "running") return false;
  if (latest.role === "activity_group") {
    if (latest.traceState === "running") return false;
    const latestActivity = latest.activities?.[latest.activities.length - 1] ?? null;
    return latestActivity?.state !== "running" && latestActivity?.state !== "pending";
  }
  return true;
}
