import {
  CHAT_ATTACHMENT_LIMITS,
  TeamChatMessageSchema,
  type ChatAttachment,
  type TeamChatAgentCatalogEntry,
  type TeamChatAgentConversation,
  type TeamChatAttachment,
  type TeamChatEvent,
  type TeamChatHostedAiThread,
  type TeamChatMember,
  type TeamChatMessage,
  type TeamChatThread,
  type TeamChatThreadDetail,
} from "@openpond/contracts";

export type TeamChatState = {
  members: TeamChatMember[];
  agents: TeamChatAgentCatalogEntry[];
  threads: TeamChatThread[];
  selectedThreadId: string | null;
  detail: TeamChatThreadDetail | null;
  aiThread: TeamChatHostedAiThread | null;
  agentConversation: TeamChatAgentConversation | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
};

export type TeamChatImageInput = ChatAttachment & {
  kind: "image";
  mediaType: TeamChatAttachment["mediaType"];
  contentsBase64: string;
};

export type PendingAttachmentState = {
  inputs: TeamChatImageInput[];
  uploaded: TeamChatAttachment[] | null;
};

export function mergeThreadDetail(
  current: TeamChatThreadDetail | null,
  incoming: TeamChatThreadDetail,
): TeamChatThreadDetail {
  if (!current || current.thread.id !== incoming.thread.id) return incoming;
  return {
    ...incoming,
    messages: uniqueMessages([...current.messages, ...incoming.messages]),
    hasMoreBefore:
      current.messages.length > incoming.messages.length
        ? current.hasMoreBefore
        : incoming.hasMoreBefore,
  };
}

export function mergePendingThreadDetail(
  detail: TeamChatThreadDetail,
  pendingMessages: Map<string, TeamChatMessage>,
): TeamChatThreadDetail {
  const pending = Array.from(pendingMessages.values()).filter(
    (message) => message.threadId === detail.thread.id,
  );
  if (pending.length === 0) return detail;
  let thread = detail.thread;
  for (const message of pending) {
    thread = updateThreadFromMessage(
      thread,
      message,
      "message.created",
      true,
      message.authorUserId,
    );
  }
  return {
    ...detail,
    thread,
    messages: uniqueMessages([...detail.messages, ...pending]),
  };
}

export function mergePendingThreadList(
  threads: TeamChatThread[],
  pendingMessages: Map<string, TeamChatMessage>,
): TeamChatThread[] {
  const canonicalRequestIds = new Set(
    threads
      .map((thread) => thread.lastMessage?.clientRequestId)
      .filter((id): id is string => Boolean(id)),
  );
  const pendingByThread = new Map<string, TeamChatMessage[]>();
  for (const message of pendingMessages.values()) {
    if (message.clientRequestId && canonicalRequestIds.has(message.clientRequestId)) continue;
    const list = pendingByThread.get(message.threadId) ?? [];
    list.push(message);
    pendingByThread.set(message.threadId, list);
  }
  return threads
    .map((thread) => {
      let merged = thread;
      for (const message of pendingByThread.get(thread.id) ?? []) {
        merged = updateThreadFromMessage(
          merged,
          message,
          "message.created",
          true,
          message.authorUserId,
        );
      }
      return merged;
    })
    .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
}

export function clearCanonicalPendingMessages(
  messages: TeamChatMessage[],
  pendingMessages: Map<string, TeamChatMessage>,
  pendingAttachments: Map<string, PendingAttachmentState>,
): void {
  for (const message of messages) {
    if (!message.clientRequestId || message.id.startsWith("pending:")) continue;
    pendingMessages.delete(message.clientRequestId);
    pendingAttachments.delete(message.clientRequestId);
  }
}

export function updatePendingMessageDelivery(
  pendingMessages: Map<string, TeamChatMessage>,
  clientRequestId: string,
  deliveryStatus: "sending" | "failed",
): void {
  const message = pendingMessages.get(clientRequestId);
  if (!message) return;
  pendingMessages.set(clientRequestId, {
    ...message,
    metadata: { ...message.metadata, deliveryStatus },
  });
}

export function updatePendingMessageUploadProgress(
  pendingMessages: Map<string, TeamChatMessage>,
  clientRequestId: string,
  uploadProgress: string,
): void {
  const message = pendingMessages.get(clientRequestId);
  if (!message) return;
  pendingMessages.set(clientRequestId, {
    ...message,
    metadata: { ...message.metadata, uploadProgress },
  });
}

export function uniqueMessages(messages: TeamChatMessage[]): TeamChatMessage[] {
  const byId = new Map<string, TeamChatMessage>();
  const canonicalRequestIds = new Set(
    messages
      .filter((message) => !message.id.startsWith("pending:"))
      .map((message) => message.clientRequestId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const message of messages) {
    if (
      message.id.startsWith("pending:") &&
      message.clientRequestId &&
      canonicalRequestIds.has(message.clientRequestId)
    ) {
      continue;
    }
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function messageFromEvent(event: TeamChatEvent): TeamChatMessage | null {
  if (
    event.type !== "message.created" &&
    event.type !== "message.updated" &&
    event.type !== "message.deleted"
  ) {
    return null;
  }
  return TeamChatMessageSchema.safeParse(event.payload.message).data ?? null;
}

export function applyTeamChatEvent(
  current: TeamChatState,
  event: TeamChatEvent,
  currentUserId: string | null,
): TeamChatState {
  const message = messageFromEvent(event);
  if (message) {
    const selected = current.selectedThreadId === message.threadId;
    const detail =
      current.detail?.thread.id === message.threadId
        ? {
            ...current.detail,
            thread: updateThreadFromMessage(
              current.detail.thread,
              message,
              event.type,
              selected,
              currentUserId,
            ),
            messages: uniqueMessages([...current.detail.messages, message]),
          }
        : current.detail;
    const hasThread = current.threads.some((thread) => thread.id === message.threadId);
    const threads = hasThread
      ? current.threads
          .map((thread) =>
            thread.id === message.threadId
              ? updateThreadFromMessage(thread, message, event.type, selected, currentUserId)
              : thread,
          )
          .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
      : current.threads;
    return { ...current, detail, threads, error: null };
  }

  if (event.type === "read.updated") {
    const userId = typeof event.payload.userId === "string" ? event.payload.userId : null;
    const sequence = Number(event.payload.sequence);
    if (!userId || !Number.isSafeInteger(sequence) || sequence < 0) return current;
    const updateParticipants = (thread: TeamChatThread): TeamChatThread => ({
      ...thread,
      participants: thread.participants.map((participant) =>
        participant.userId === userId
          ? { ...participant, lastReadSequence: Math.max(participant.lastReadSequence, sequence) }
          : participant,
      ),
    });
    return {
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === event.threadId ? updateParticipants(thread) : thread,
      ),
      detail:
        current.detail?.thread.id === event.threadId
          ? { ...current.detail, thread: updateParticipants(current.detail.thread) }
          : current.detail,
    };
  }
  return current;
}

export function updateThreadFromMessage(
  thread: TeamChatThread,
  message: TeamChatMessage,
  eventType: TeamChatEvent["type"],
  selected: boolean,
  currentUserId: string | null,
): TeamChatThread {
  const isCreated = eventType === "message.created";
  const isNewest = message.sequence >= thread.lastMessageSequence;
  return {
    ...thread,
    lastMessageId: isNewest ? message.id : thread.lastMessageId,
    lastMessageSequence: Math.max(thread.lastMessageSequence, message.sequence),
    lastMessageAt: isNewest ? message.createdAt : thread.lastMessageAt,
    updatedAt: isNewest ? message.createdAt : thread.updatedAt,
    lastMessage: isNewest ? message : thread.lastMessage,
    unreadCount:
      selected || message.authorUserId === currentUserId
        ? 0
        : isCreated
          ? thread.unreadCount + 1
          : thread.unreadCount,
  };
}

export function createOptimisticMessage(input: {
  clientRequestId: string;
  threadId: string;
  teamId: string;
  userId: string | null;
  body: string;
  mentionUserIds: string[];
  attachments: TeamChatImageInput[];
  sequence: number;
}): TeamChatMessage {
  const createdAt = new Date().toISOString();
  return {
    id: `pending:${input.clientRequestId}`,
    threadId: input.threadId,
    teamId: input.teamId,
    clientRequestId: input.clientRequestId,
    authorType: "user",
    authorUserId: input.userId,
    authorAgentId: null,
    sequence: input.sequence,
    kind: "text",
    body: input.body,
    metadata: {
      deliveryStatus: "sending",
      mentionUserIds: input.mentionUserIds,
      localAttachmentPreviews: input.attachments.map((attachment) => ({
        id: attachment.id,
        url: `data:${attachment.mediaType};base64,${attachment.contentsBase64}`,
      })),
    },
    editedAt: null,
    deletedAt: null,
    createdAt,
    refs: [],
    attachments: input.attachments.map((attachment) => ({
      id: attachment.id,
      messageId: null,
      clientAttachmentId: attachment.id,
      kind: "image",
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      status: "pending",
      createdAt,
      readyAt: null,
    })),
  };
}

export function applyOptimisticMessage(
  current: TeamChatState,
  message: TeamChatMessage,
): TeamChatState {
  const detail =
    current.detail?.thread.id === message.threadId
      ? {
          ...current.detail,
          thread: updateThreadFromMessage(
            current.detail.thread,
            message,
            "message.created",
            true,
            message.authorUserId,
          ),
          messages: uniqueMessages([...current.detail.messages, message]),
        }
      : current.detail;
  return {
    ...current,
    detail,
    threads: current.threads
      .map((thread) =>
        thread.id === message.threadId
          ? updateThreadFromMessage(thread, message, "message.created", true, message.authorUserId)
          : thread,
      )
      .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt)),
    error: null,
  };
}

export function applyCanonicalMessage(
  current: TeamChatState,
  message: TeamChatMessage,
  currentUserId: string | null,
): TeamChatState {
  return applyTeamChatEvent(
    current,
    {
      id: 0,
      teamId: message.teamId,
      threadId: message.threadId,
      conversationId: null,
      type: "message.created",
      payload: { message },
      createdAt: message.createdAt,
    },
    currentUserId,
  );
}

export function markOptimisticMessageFailed(
  current: TeamChatState,
  clientRequestId: string,
): TeamChatState {
  return updateOptimisticDeliveryStatus(current, clientRequestId, "failed");
}

export function updateOptimisticDeliveryStatus(
  current: TeamChatState,
  clientRequestId: string,
  deliveryStatus: "sending" | "failed",
): TeamChatState {
  const mark = (message: TeamChatMessage): TeamChatMessage =>
    message.clientRequestId === clientRequestId && message.id.startsWith("pending:")
      ? { ...message, metadata: { ...message.metadata, deliveryStatus } }
      : message;
  return {
    ...current,
    detail: current.detail
      ? {
          ...current.detail,
          thread: {
            ...current.detail.thread,
            lastMessage: current.detail.thread.lastMessage
              ? mark(current.detail.thread.lastMessage)
              : null,
          },
          messages: current.detail.messages.map(mark),
        }
      : null,
    threads: current.threads.map((thread) => ({
      ...thread,
      lastMessage: thread.lastMessage ? mark(thread.lastMessage) : null,
    })),
  };
}

export function updateOptimisticUploadProgress(
  current: TeamChatState,
  clientRequestId: string,
  uploadProgress: string,
): TeamChatState {
  const update = (message: TeamChatMessage): TeamChatMessage =>
    message.clientRequestId === clientRequestId && message.id.startsWith("pending:")
      ? { ...message, metadata: { ...message.metadata, uploadProgress } }
      : message;
  return {
    ...current,
    detail: current.detail
      ? {
          ...current.detail,
          thread: {
            ...current.detail.thread,
            lastMessage: current.detail.thread.lastMessage
              ? update(current.detail.thread.lastMessage)
              : null,
          },
          messages: current.detail.messages.map(update),
        }
      : null,
    threads: current.threads.map((thread) => ({
      ...thread,
      lastMessage: thread.lastMessage ? update(thread.lastMessage) : null,
    })),
  };
}

export function removeOptimisticMessage(current: TeamChatState, messageId: string): TeamChatState {
  const remainingMessages =
    current.detail?.messages.filter((message) => message.id !== messageId) ?? [];
  const fallbackLastMessage = remainingMessages.at(-1) ?? null;
  const detail = current.detail
    ? {
        ...current.detail,
        thread:
          current.detail.thread.lastMessageId === messageId
            ? threadWithoutOptimisticLastMessage(current.detail.thread, fallbackLastMessage)
            : current.detail.thread,
        messages: remainingMessages,
      }
    : null;
  return {
    ...current,
    detail,
    threads: current.threads.map((thread) =>
      thread.lastMessageId === messageId
        ? threadWithoutOptimisticLastMessage(thread, fallbackLastMessage)
        : thread,
    ),
  };
}

export function teamChatImageInputs(attachments: ChatAttachment[]): TeamChatImageInput[] | null {
  if (attachments.length > CHAT_ATTACHMENT_LIMITS.maxAttachments) return null;
  const images: TeamChatImageInput[] = [];
  for (const attachment of attachments) {
    if (
      attachment.kind !== "image" ||
      !isTeamChatImageMediaType(attachment.mediaType) ||
      !attachment.contentsBase64 ||
      attachment.sizeBytes <= 0 ||
      attachment.sizeBytes > CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes
    ) {
      return null;
    }
    images.push({
      ...attachment,
      kind: "image",
      mediaType: attachment.mediaType,
      contentsBase64: attachment.contentsBase64,
    });
  }
  return images;
}

function threadWithoutOptimisticLastMessage(
  thread: TeamChatThread,
  fallbackLastMessage: TeamChatMessage | null,
): TeamChatThread {
  return {
    ...thread,
    lastMessageId: fallbackLastMessage?.id ?? null,
    lastMessageSequence: fallbackLastMessage?.sequence ?? 0,
    lastMessageAt: fallbackLastMessage?.createdAt ?? thread.createdAt,
    updatedAt: fallbackLastMessage?.createdAt ?? thread.createdAt,
    lastMessage: fallbackLastMessage,
  };
}

function isTeamChatImageMediaType(value: string): value is TeamChatAttachment["mediaType"] {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
  );
}
