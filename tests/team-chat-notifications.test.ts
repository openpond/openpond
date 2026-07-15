import { describe, expect, test } from "bun:test";
import type { TeamChatMessage, TeamChatThread } from "@openpond/contracts";
import {
  readTeamChatNotificationMode,
  shouldNotifyForTeamChatMessage,
  teamChatIncomingNotification,
  writeTeamChatNotificationMode,
} from "../apps/web/src/lib/team-chat-notifications";

describe("team chat notifications", () => {
  test("persists the compact notification policy", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readTeamChatNotificationMode(storage)).toBe("all");
    writeTeamChatNotificationMode("direct_mentions", storage);
    expect(readTeamChatNotificationMode(storage)).toBe("direct_mentions");
    writeTeamChatNotificationMode("none", storage);
    expect(readTeamChatNotificationMode(storage)).toBe("none");
  });

  test("honors global policy, mentions, direct messages, and thread mute", () => {
    const channel = thread();
    const direct = thread({ kind: "dm", title: null });
    const message = teamMessage();

    expect(
      shouldNotifyForTeamChatMessage({
        mode: "all",
        currentUserId: "user_1",
        message,
        thread: channel,
      }),
    ).toBe(true);
    expect(
      shouldNotifyForTeamChatMessage({
        mode: "direct_mentions",
        currentUserId: "user_1",
        message,
        thread: channel,
      }),
    ).toBe(false);
    expect(
      shouldNotifyForTeamChatMessage({
        mode: "direct_mentions",
        currentUserId: "user_1",
        message: teamMessage({ metadata: { mentionUserIds: ["user_1"] } }),
        thread: channel,
      }),
    ).toBe(true);
    expect(
      shouldNotifyForTeamChatMessage({
        mode: "direct_mentions",
        currentUserId: "user_1",
        message,
        thread: direct,
      }),
    ).toBe(true);
    expect(
      shouldNotifyForTeamChatMessage({
        mode: "all",
        currentUserId: "user_1",
        message,
        thread: thread({ mutedAt: "2026-07-14T12:00:00.000Z" }),
      }),
    ).toBe(false);
  });

  test("builds a bounded, useful toast", () => {
    expect(
      teamChatIncomingNotification({
        eventId: 42,
        message: teamMessage({ body: "Hello from the team" }),
        thread: thread(),
        members: [
          { userId: "user_2", role: "member", name: "Adam", handle: null, image: null },
        ],
      }),
    ).toEqual({
      eventId: 42,
      threadId: "thread_1",
      title: "Adam in #general",
      body: "Hello from the team",
    });
  });
});

function teamMessage(overrides: Partial<TeamChatMessage> = {}): TeamChatMessage {
  return {
    id: "message_1",
    threadId: "thread_1",
    teamId: "team_1",
    clientRequestId: null,
    authorType: "user",
    authorUserId: "user_2",
    authorAgentId: null,
    sequence: 1,
    kind: "text",
    body: "Message",
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-07-14T12:00:00.000Z",
    refs: [],
    attachments: [],
    ...overrides,
  };
}

function thread(overrides: Partial<TeamChatThread> = {}): TeamChatThread {
  return {
    id: "thread_1",
    teamId: "team_1",
    kind: "general",
    title: "general",
    createdByUserId: "user_1",
    lastMessageId: null,
    lastMessageSequence: 0,
    lastMessageAt: "2026-07-14T12:00:00.000Z",
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
    unreadCount: 0,
    pinnedAt: null,
    mutedAt: null,
    archivedAt: null,
    participants: [],
    lastMessage: null,
    ...overrides,
  };
}
