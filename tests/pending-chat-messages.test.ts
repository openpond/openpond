import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../apps/web/src/lib/app-models";
import {
  appendPendingUserChatMessage,
  createPendingUserChatMessage,
  hasMatchingUserMessage,
} from "../apps/web/src/lib/pending-chat-messages";

describe("pending chat user messages", () => {
  test("appends a pending user row until the real user message arrives", () => {
    const pending = createPendingUserChatMessage({
      attachments: [],
      content: "Build the dashboard",
      sessionId: "session_1",
    });
    pending.timestamp = "2026-07-01T10:00:00.000Z";

    expect(appendPendingUserChatMessage([], pending)).toEqual([pending]);

    const realMessages = [
      userMessage("turn_started", "Build the dashboard", "2026-07-01T10:00:01.000Z"),
    ];
    expect(hasMatchingUserMessage(realMessages, pending)).toBe(true);
    expect(appendPendingUserChatMessage(realMessages, pending)).toBe(realMessages);
  });

  test("keeps a repeated pending prompt when only an older real message matches", () => {
    const realMessages = [
      userMessage("turn_old", "Try again", "2026-07-01T10:00:00.000Z"),
      assistantMessage("assistant_old", "Still failing", "2026-07-01T10:00:01.000Z"),
    ];
    const pending = createPendingUserChatMessage({
      afterMessageId: "assistant_old",
      attachments: [],
      content: "Try again",
      sessionId: "session_1",
    });
    pending.timestamp = "2026-07-01T10:05:00.000Z";

    expect(hasMatchingUserMessage(realMessages, pending)).toBe(false);
    expect(appendPendingUserChatMessage(realMessages, pending)).toEqual([
      realMessages[0],
      realMessages[1],
      pending,
    ]);

    expect(
      hasMatchingUserMessage(
        [
          ...realMessages,
          userMessage("turn_new", "Try again", "2026-07-01T10:05:01.000Z"),
        ],
        pending,
      ),
    ).toBe(true);
  });

  test("summarizes pending attachments without carrying file contents", () => {
    const pending = createPendingUserChatMessage({
      attachments: [
        {
          id: "attachment_1",
          name: "notes.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
          kind: "text",
          text: "hello world",
          contentsBase64: "aGVsbG8gd29ybGQ=",
        },
      ],
      content: "Review this",
      sessionId: "session_1",
    });

    expect(pending.attachments).toEqual([
      {
        id: "attachment_1",
        name: "notes.txt",
        mediaType: "text/plain",
        sizeBytes: 12,
        kind: "text",
      },
    ]);
  });
});

function userMessage(id: string, content: string, timestamp: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    timestamp,
    turnId: id,
  };
}

function assistantMessage(id: string, content: string, timestamp: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    timestamp,
    turnId: id,
  };
}
