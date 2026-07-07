import type { ChatAttachment, ChatAttachmentSummary } from "@openpond/contracts";
import type { ChatMessage } from "./app-models";

export type PendingChatUserMessage = ChatMessage & {
  role: "user";
  content: string;
  sessionId: string;
  afterMessageId: string | null;
};

export function createPendingUserChatMessage({
  afterMessageId = null,
  attachments,
  content,
  sessionId,
}: {
  afterMessageId?: string | null;
  attachments: ChatAttachment[];
  content: string;
  sessionId: string;
}): PendingChatUserMessage {
  const timestamp = new Date().toISOString();
  const id = `pending_user_${sessionId}_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
  const attachmentSummaries = pendingAttachmentSummaries(attachments);
  return {
    id,
    role: "user",
    content,
    sessionId,
    afterMessageId,
    timestamp,
    turnId: id,
    ...(attachmentSummaries.length > 0 ? { attachments: attachmentSummaries } : {}),
  };
}

export function appendPendingUserChatMessage(
  messages: ChatMessage[],
  pending: PendingChatUserMessage | null | undefined,
): ChatMessage[] {
  if (!pending || hasMatchingUserMessage(messages, pending)) return messages;
  return [...messages, pending];
}

export function hasMatchingUserMessage(
  messages: ChatMessage[],
  pending: PendingChatUserMessage,
): boolean {
  const afterMessageIndex = pending.afterMessageId
    ? messages.findIndex((message) => message.id === pending.afterMessageId)
    : -1;
  const startIndex = afterMessageIndex >= 0 ? afterMessageIndex + 1 : 0;
  const pendingTimestamp = Date.parse(pending.timestamp);
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.content !== pending.content) continue;
    if (afterMessageIndex >= 0 || !pending.afterMessageId) return true;
    const messageTimestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(pendingTimestamp) || !Number.isFinite(messageTimestamp)) return true;
    if (messageTimestamp >= pendingTimestamp) return true;
  }
  return false;
}

function pendingAttachmentSummaries(attachments: ChatAttachment[]): ChatAttachmentSummary[] {
  return attachments.map(({ contentsBase64: _contentsBase64, text: _text, ...summary }) => summary);
}
