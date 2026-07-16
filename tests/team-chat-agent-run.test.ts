import { describe, expect, vi, test } from "vitest";

import {
  buildTeamChatAgentContinuationInput,
  buildTeamChatSelectedActionRunInput,
  clearTeamChatDetailUnreadCount,
  clearTeamChatThreadUnreadCount,
  markOpenedTeamChatThreadRead,
} from "../apps/web/src/hooks/useTeamChat";
import { actionMentionMatchesForQuery } from "../apps/web/src/lib/action-mentions";
import { mentionedTeamMemberIds } from "../apps/web/src/lib/team-chat-mentions";

describe("desktop Team Chat agent continuation", () => {
  test("resolves known member tags without treating unknown text as a mention", () => {
    const members = [
      { userId: "user_1", role: "owner" as const, name: "Owner", handle: "owner", image: null },
      {
        userId: "user_2",
        role: "member" as const,
        name: "Member",
        handle: "user-ifu070",
        image: null,
      },
    ];

    expect(mentionedTeamMemberIds("@USER-IFU070 hello @unknown", members)).toEqual(["user_2"]);
  });

  test("marks an opened DM through the hosted read endpoint", async () => {
    const connection = {
      serverUrl: "http://127.0.0.1:17874",
      token: "test",
      platform: "linux",
    };
    const markRead = vi.fn(async () => ({ sequence: 4 }));
    const marked = await markOpenedTeamChatThreadRead(
      {
        connection,
        teamId: "team_1",
        threadId: "dm_1",
        lastMessageSequence: 4,
      },
      markRead,
    );

    expect(marked).toBe(true);
    expect(markRead).toHaveBeenCalledWith(connection, "dm_1", "team_1", 4);
  });

  test("clears the opened thread unread badge in desktop state", () => {
    const threads = [
      { id: "general", unreadCount: 5 },
      { id: "dm_1", unreadCount: 2 },
    ];

    expect(clearTeamChatThreadUnreadCount(threads as never, "general")).toMatchObject([
      { id: "general", unreadCount: 0 },
      { id: "dm_1", unreadCount: 2 },
    ]);
  });

  test("clears unread state on the opened thread detail", () => {
    const detail = {
      thread: { id: "general", unreadCount: 5 },
      messages: [],
      hasMoreBefore: false,
    };

    expect(clearTeamChatDetailUnreadCount(detail as never)).toMatchObject({
      thread: { id: "general", unreadCount: 0 },
    });
  });

  test("matches the hosted workspace agent in the shared desktop composer", () => {
    const action = {
      id: "project_profile:agent_oauth_verifier:read-record",
      label: "OAuth Verifier Agent · Read record",
      description: "Read the deterministic OAuth fixture record.",
      implementation: {
        type: "openpond-agent",
        agentId: "agent_oauth_verifier",
        agentName: "OAuth Verifier Agent",
        actionId: "read-record",
        profileProjectId: "project_profile",
        profileName: "default",
      },
    };

    expect(actionMentionMatchesForQuery([action], "oauth")).toEqual([
      action,
    ]);
  });

  test("submits the exact composer-selected action key", () => {
    expect(
      buildTeamChatSelectedActionRunInput({
        teamId: "team_1",
        body: "  read the deterministic record  ",
        clientRequestId: "request_selected_action",
        selectedActionKey:
          "project_profile:agent_oauth_verifier:read-record",
      }),
    ).toEqual({
      teamId: "team_1",
      body: "read the deterministic record",
      clientRequestId: "request_selected_action",
      selectedActionKey:
        "project_profile:agent_oauth_verifier:read-record",
      approvalId: null,
    });
  });

  test("pins a sidebar follow-up to the open shared agent conversation", () => {
    const request = buildTeamChatAgentContinuationInput({
      teamId: "team_1",
      body: "  continue from the pinned source  ",
      clientRequestId: "request_stable_retry",
      conversation: {
        conversationId: "conversation_oauth_verifier",
        teamId: "team_1",
        title: "OAuth verifier",
        agent: {
          id: "agent_oauth_verifier",
          name: "OAuth Verifier Agent",
          slug: "openpond-profile-oauth-verifier",
        },
        run: {
          id: "run_oauth_verifier",
          status: "succeeded",
          metadata: {},
        },
        messages: [],
        pinnedRouting: {
          profileProjectId: "project_profile",
          sourceCommitSha: "source_sha",
        },
      },
    });

    expect(request).toEqual({
      teamId: "team_1",
      body: "continue from the pinned source",
      clientRequestId: "request_stable_retry",
      selectedAgentId: "agent_oauth_verifier",
      conversationId: "conversation_oauth_verifier",
    });
  });
});
