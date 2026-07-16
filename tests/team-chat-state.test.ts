import { describe, expect, test } from "vitest";
import type {
  TeamChatAttachment,
  TeamChatMessage,
  TeamChatThread,
  TeamChatThreadDetail,
} from "@openpond/contracts";

import {
  applyCanonicalMessage,
  applyOptimisticMessage,
  applySelectedTeamChatAiThread,
  applyTeamChatEvent,
  clearCanonicalPendingMessages,
  createOptimisticMessage,
  mergePendingThreadDetail,
  removeOptimisticMessage,
  teamChatImageInputs,
  updateOptimisticDeliveryStatus,
  updatePendingMessageDelivery,
  uniqueMessages,
  type PendingAttachmentState,
  type TeamChatState,
} from "../apps/web/src/hooks/team-chat-state";

describe("team chat optimistic state", () => {
  test("keeps background AI conversation updates out of the selected panel", () => {
    const current = {
      ...state(),
      aiThread: { conversationId: "conversation_selected" },
    } as TeamChatState;
    const background = {
      conversationId: "conversation_background",
    } as NonNullable<TeamChatState["aiThread"]>;

    expect(
      applySelectedTeamChatAiThread(
        current,
        background,
        "conversation_selected",
      ),
    ).toBe(current);
    expect(
      applySelectedTeamChatAiThread(
        current,
        background,
        "conversation_background",
      ).aiThread,
    ).toBe(background);
  });

  test("validates hosted image inputs before optimistic insertion", () => {
    const image = imageInput();
    expect(teamChatImageInputs([image])).toEqual([image]);
    expect(teamChatImageInputs([{ ...image, mediaType: "image/svg+xml" }])).toBeNull();
    expect(teamChatImageInputs([{ ...image, kind: "file" }])).toBeNull();
    expect(teamChatImageInputs(Array.from({ length: 11 }, () => image))).toBeNull();
  });

  test("keeps a failed image row across hosted detail refreshes", () => {
    const optimistic = optimisticMessage();
    const pending = new Map([[optimistic.clientRequestId!, optimistic]]);
    updatePendingMessageDelivery(pending, optimistic.clientRequestId!, "failed");

    const merged = mergePendingThreadDetail(detail(), pending);

    expect(merged.messages.map((message) => message.id)).toEqual(["message_1", optimistic.id]);
    expect(merged.messages.at(-1)?.metadata.deliveryStatus).toBe("failed");
    expect(merged.thread.lastMessageId).toBe(optimistic.id);
  });

  test("reconciles the optimistic row with one canonical message", () => {
    const optimistic = optimisticMessage();
    const current = applyOptimisticMessage(state(), optimistic);
    const canonical = message({
      id: "message_2",
      clientRequestId: optimistic.clientRequestId,
      sequence: 2,
      body: optimistic.body,
      attachments: [hostedAttachment()],
    });

    const reconciled = applyCanonicalMessage(current, canonical, "user_1");

    expect(reconciled.detail?.messages.map((item) => item.id)).toEqual(["message_1", "message_2"]);
    expect(reconciled.detail?.thread.lastMessageId).toBe("message_2");
    expect(reconciled.threads[0]?.lastMessageId).toBe("message_2");
  });

  test("includes reply context in the optimistic message and preserves it on failure", () => {
    const target = message({ authorUserId: "user_2", body: "Original message" });
    const optimistic = createOptimisticMessage({
      clientRequestId: "request_reply",
      threadId: "thread_1",
      teamId: "team_1",
      userId: "user_1",
      body: "Reply body",
      mentionUserIds: [],
      attachments: [],
      replyToMessage: target,
      sequence: 2,
    });

    expect(optimistic.refs).toEqual([
      expect.objectContaining({
        refType: "message_reply",
        refId: target.id,
        preview: expect.objectContaining({
          authorUserId: "user_2",
          body: "Original message",
        }),
      }),
    ]);
    expect(
      updateOptimisticDeliveryStatus(
        applyOptimisticMessage(state(), optimistic),
        optimistic.clientRequestId!,
        "failed",
      ).detail?.messages.at(-1)?.refs,
    ).toEqual(optimistic.refs);
  });

  test("removing a failed row restores both detail and sidebar thread summaries", () => {
    const optimistic = optimisticMessage();
    const failed = updateOptimisticDeliveryStatus(
      applyOptimisticMessage(state(), optimistic),
      optimistic.clientRequestId!,
      "failed",
    );

    const removed = removeOptimisticMessage(failed, optimistic.id);

    expect(removed.detail?.messages.map((item) => item.id)).toEqual(["message_1"]);
    expect(removed.detail?.thread.lastMessageId).toBe("message_1");
    expect(removed.threads[0]?.lastMessageId).toBe("message_1");
  });

  test("clears staged bytes when a canonical retry is observed", () => {
    const optimistic = optimisticMessage();
    const messages = new Map([[optimistic.clientRequestId!, optimistic]]);
    const attachments = new Map<string, PendingAttachmentState>([
      [
        optimistic.clientRequestId!,
        { inputs: teamChatImageInputs([imageInput()])!, uploaded: null },
      ],
    ]);

    clearCanonicalPendingMessages(
      [message({ id: "message_2", clientRequestId: optimistic.clientRequestId })],
      messages,
      attachments,
    );

    expect(messages.size).toBe(0);
    expect(attachments.size).toBe(0);
  });

  test("increments unread only for incoming messages outside the selected thread", () => {
    const incoming = message({
      id: "message_2",
      authorUserId: "user_2",
      sequence: 2,
    });
    const event = {
      id: 2,
      teamId: "team_1",
      threadId: "thread_1",
      conversationId: null,
      type: "message.created" as const,
      payload: { message: incoming },
      createdAt: incoming.createdAt,
    };

    const background = applyTeamChatEvent(
      { ...state(), selectedThreadId: "thread_2", detail: null },
      event,
      "user_1",
    );
    const selected = applyTeamChatEvent(state(), event, "user_1");

    expect(background.threads[0]?.unreadCount).toBe(1);
    expect(selected.threads[0]?.unreadCount).toBe(0);
  });

  test("orders canonical and optimistic messages by sequence without duplicates", () => {
    const later = message({ id: "message_3", clientRequestId: "request_3", sequence: 3 });
    const middle = message({ id: "message_2", clientRequestId: "request_2", sequence: 2 });

    expect(uniqueMessages([later, message(), middle, later]).map((item) => item.id)).toEqual([
      "message_1",
      "message_2",
      "message_3",
    ]);
  });
});

function imageInput() {
  return {
    id: "client_attachment_1",
    name: "image.png",
    mediaType: "image/png",
    sizeBytes: 3,
    kind: "image" as const,
    contentsBase64: "AQID",
  };
}

function optimisticMessage(): TeamChatMessage {
  return createOptimisticMessage({
    clientRequestId: "request_2",
    threadId: "thread_1",
    teamId: "team_1",
    userId: "user_1",
    body: "photo",
    mentionUserIds: [],
    attachments: teamChatImageInputs([imageInput()])!,
    sequence: 2,
  });
}

function state(): TeamChatState {
  const currentDetail = detail();
  return {
    members: [],
    threads: [currentDetail.thread],
    selectedThreadId: "thread_1",
    detail: currentDetail,
    aiThread: null,
    loading: false,
    busy: false,
    error: null,
  };
}

function detail(): TeamChatThreadDetail {
  const firstMessage = message();
  return {
    thread: thread(firstMessage),
    messages: [firstMessage],
    hasMoreBefore: false,
  };
}

function thread(lastMessage: TeamChatMessage): TeamChatThread {
  return {
    id: "thread_1",
    teamId: "team_1",
    kind: "dm",
    title: null,
    createdByUserId: "user_1",
    lastMessageId: lastMessage.id,
    lastMessageSequence: lastMessage.sequence,
    lastMessageAt: lastMessage.createdAt,
    createdAt: "2026-07-09T11:00:00.000Z",
    updatedAt: lastMessage.createdAt,
    unreadCount: 0,
    pinnedAt: null,
    mutedAt: null,
    archivedAt: null,
    participants: [
      {
        userId: "user_1",
        role: "member",
        name: "User One",
        handle: "one",
        image: null,
        lastReadSequence: 1,
      },
      {
        userId: "user_2",
        role: "member",
        name: "User Two",
        handle: "two",
        image: null,
        lastReadSequence: 1,
      },
    ],
    lastMessage,
  };
}

function message(overrides: Partial<TeamChatMessage> = {}): TeamChatMessage {
  return {
    id: "message_1",
    threadId: "thread_1",
    teamId: "team_1",
    clientRequestId: "request_1",
    authorType: "user",
    authorUserId: "user_1",
    authorAgentId: null,
    sequence: 1,
    kind: "text",
    body: "hello",
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-07-09T12:00:00.000Z",
    refs: [],
    attachments: [],
    ...overrides,
  };
}

function hostedAttachment(): TeamChatAttachment {
  return {
    id: "attachment_1",
    messageId: "message_2",
    clientAttachmentId: "client_attachment_1",
    kind: "image",
    name: "image.png",
    mediaType: "image/png",
    sizeBytes: 3,
    status: "ready",
    createdAt: "2026-07-09T12:01:00.000Z",
    readyAt: "2026-07-09T12:01:01.000Z",
  };
}
