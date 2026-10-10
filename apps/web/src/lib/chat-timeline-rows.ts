import { formatWorkTraceDuration } from "./chat-work-trace";
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

export type ChatTimelineWorkRow = {
  id: string;
  type: "work";
  label: string;
  messages: ChatTimelineMessageRow[];
};

export type ChatTimelineRow = ChatTimelineMessageRow | ChatTimelineThinkingRow | ChatTimelineWorkRow;

function messageRow(message: ChatMessage): ChatTimelineMessageRow {
  return { id: `message:${message.id}`, type: "message", message,
    showFooter: message.role === "assistant" && message.finalAnswer === true };
}

/** Flatten for cache/animation bookkeeping without losing collapsed history. */
export function chatTimelineMessages(rows: ChatTimelineRow[]): ChatMessage[] {
  return rows.flatMap(row => row.type === "message" ? [row.message]
    : row.type === "work" ? row.messages.map(entry => entry.message) : []);
}

export function buildChatTimelineRows(
  messages: ChatMessage[],
  options: { showThinkingIndicator?: boolean } = {},
): ChatTimelineRow[] {
  const rows: ChatTimelineRow[] = [];
  let pending: ChatTimelineMessageRow[] = [];
  let resources: ChatTimelineMessageRow[] = [];
  let visuals: ChatTimelineMessageRow[] = [];
  const flushOutputs = () => {
    rows.push(...resources, ...visuals);
    resources = [];
    visuals = [];
  };
  let startedAt: string | undefined;
  let turnId: string | undefined;
  const flush = (label?: string | ((count: number) => string)) => {
    if (pending.length === 0) return;
    if (label) rows.push({ id: `work:${pending[0]!.message.id}`, type: "work",
      label: typeof label === "function" ? label(pending.length) : label, messages: pending });
    else rows.push(...pending);
    pending = [];
  };
  for (const message of messages) {
    if (message.role === "user") {
      flush(message.interactionKind === "steer" ? count => `${count} previous ${count === 1 ? "message" : "messages"}` : undefined);
      flushOutputs();
      rows.push(messageRow(message));
      startedAt = message.timestamp;
      turnId = message.turnId;
      continue;
    }
    if (turnId && message.turnId && message.turnId !== turnId) {
      flush();
      flushOutputs();
      startedAt = undefined;
    }
    turnId = message.turnId ?? turnId;
    // Keep interactive outputs below the response text and saved-resource area.
    // Their top-level keys remain stable as streaming text or completion adds rows.
    if (message.role === "visual") {
      visuals.push(messageRow(message));
      continue;
    }
    if (message.role === "resources") {
      resources.push(messageRow(message));
      continue;
    }
    if (message.role === "error" || message.userQuestion?.status === "pending") {
      flush();
      rows.push(messageRow(message));
      continue;
    }
    if (message.role === "assistant" && message.finalAnswer) {
      // Hosted providers can keep reasoning and the final answer on one message.
      // Split only the presentation so the answer remains outside the disclosure.
      if (message.reasoningContent) pending.push(messageRow({
        id: `${message.id}:reasoning`, role: "assistant", timestamp: message.timestamp,
        turnId: message.turnId, reasoningContent: message.reasoningContent,
      }));
      const duration = formatWorkTraceDuration(
        message.turnStartedAt ?? startedAt ?? pending[0]?.message.traceStartedAt ?? pending[0]?.message.timestamp,
        message.turnCompletedAt ?? message.timestamp,
      );
      flush(duration ? `Worked for ${duration}` : "Worked");
      rows.push(messageRow(message.reasoningContent ? { ...message, reasoningContent: undefined } : message));
      startedAt = undefined;
      continue;
    }
    pending.push(messageRow(message));
  }
  flush();
  flushOutputs();
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
