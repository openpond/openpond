import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TeamAgentConversationPanel,
  TeamAiThreadPanel,
  TeamChatView,
  restoreFailedTeamChatPrompt,
  type TeamChatViewProps,
} from "../apps/web/src/components/team-chat/TeamChatView";
import {
  TeamChatComposerReply,
  teamChatReplyMenuPosition,
} from "../apps/web/src/components/team-chat/TeamChatReply";
import { teamChatReplyTargetFromMessage } from "../apps/web/src/lib/team-chat-reply";

const noop = () => undefined;
const noopAsync = async () => undefined;
const noopBoolean = async () => true;

describe("team chat view", () => {
  test("restores a failed optimistic submission without discarding a newer draft", () => {
    expect(restoreFailedTeamChatPrompt("", "First message")).toBe("First message");
    expect(restoreFailedTeamChatPrompt("Second message", "First message")).toBe(
      "First message\n\nSecond message",
    );
    expect(restoreFailedTeamChatPrompt("First message", "First message")).toBe("First message");
  });

  test("renders an accessible loading state without placing request failures in the thread", () => {
    const loading = render({ loading: true });
    expect(loading).toContain('role="log"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Loading messages...");

    const failed = render({ error: "Could not load messages" });
    expect(failed).not.toContain('role="alert"');
    expect(failed).not.toContain("Could not load messages");
    expect(failed).toContain('role="log"');
  });

  test("renders the empty state and keeps the team composer available", () => {
    const markup = render({ detail: emptyDetail() });
    expect(markup).toContain("No messages yet");
    expect(markup).toContain('contentEditable="true"');
    expect(markup).toContain('aria-label="Add photos and files"');
    expect(markup).toContain('aria-label="# general"');
    expect(markup).not.toContain("team-chat-header");
  });

  test("renders persisted reply context and exposes a reply action on messages", () => {
    const detail = emptyDetail();
    const original = teamMessage({
      id: "message_original",
      authorUserId: "user_2",
      body: "Original message",
      sequence: 1,
    });
    const reply = teamMessage({
      id: "message_reply",
      body: "Reply body",
      sequence: 2,
      refs: [
        {
          id: "ref_reply",
          messageId: "message_reply",
          refType: "message_reply",
          refId: "message_original",
          preview: {
            authorType: "user",
            authorUserId: "user_2",
            authorAgentId: null,
            body: "Original message",
          },
          createdAt: "2026-07-14T12:01:00.000Z",
        },
      ],
    });
    detail.messages = [original, reply];
    detail.thread.lastMessage = reply;
    detail.thread.lastMessageId = reply.id;
    detail.thread.lastMessageSequence = reply.sequence;

    const markup = render({
      detail,
      members: [
        {
          userId: "user_2",
          role: "member",
          name: "Adam Elmhammamy",
          handle: "adam",
          image: null,
        },
      ],
    });

    expect(markup).toContain("Original message");
    expect(markup).toContain("Adam Elmhammamy");
    expect(markup).toContain('aria-label="Reply to message"');
    expect(markup).toContain('aria-label="Jump to replied message from Adam Elmhammamy"');
  });

  test("renders the selected reply above the composer and clamps context menus onscreen", () => {
    const original = teamMessage({ body: "Original message" });
    const markup = renderToStaticMarkup(
      createElement(TeamChatComposerReply, {
        authorLabel: "Adam Elmhammamy",
        target: teamChatReplyTargetFromMessage(original),
        onCancel: noop,
        onJump: noop,
      }),
    );

    expect(markup).toContain("Replying to Adam Elmhammamy");
    expect(markup).toContain("Original message");
    expect(markup).toContain('aria-label="Cancel reply"');
    expect(
      teamChatReplyMenuPosition({
        clientX: 999,
        clientY: 999,
        fallbackX: 0,
        fallbackY: 0,
        viewportWidth: 800,
        viewportHeight: 600,
      }),
    ).toEqual({ x: 642, y: 550 });
  });

  test("renders interrupted AI state and an accessible close control", () => {
    const props = baseProps();
    props.aiThread = {
      conversationId: "conversation_1",
      parentThreadId: "thread_1",
      parentMessageId: "message_1",
      teamId: "team_1",
      kind: "team_ai_thread",
      visibility: "team",
      messages: [],
      turns: [
        {
          id: "turn_1",
          conversationId: "conversation_1",
          requestedByUserId: "user_1",
          executorUserId: "user_1",
          providerId: "codex",
          modelId: "gpt-5.6-sol",
          clientRequestId: "request_1",
          baseMessageSequence: 0,
          status: "interrupted",
          partialBody: null,
          errorCode: "executor_interrupted",
          leaseExpiresAt: null,
          heartbeatAt: null,
          createdAt: "2026-07-09T12:00:00.000Z",
          updatedAt: "2026-07-09T12:01:00.000Z",
        },
      ],
      activeTurn: null,
    };

    const markup = renderToStaticMarkup(createElement(TeamAiThreadPanel, props));
    expect(markup).toContain("Model response was interrupted");
    expect(markup).toContain('aria-label="Close thread"');
    expect(markup).toContain('role="log"');
  });

  test("renders a canonical agent-run message ref in the team transcript", () => {
    const detail = emptyDetail();
    detail.messages = [
      {
        id: "message_agent_run",
        threadId: detail.thread.id,
        teamId: detail.thread.teamId,
        clientRequestId: "request_agent_run",
        authorType: "user",
        authorUserId: "user_1",
        authorAgentId: null,
        sequence: 1,
        kind: "text",
        body: "Read the deterministic record",
        metadata: {},
        editedAt: null,
        deletedAt: null,
        createdAt: "2026-07-11T12:00:00.000Z",
        attachments: [],
        refs: [
          {
            id: "ref_agent_run",
            messageId: "message_agent_run",
            refType: "agent_run",
            refId: "run_oauth_verifier",
            preview: { status: "running" },
            createdAt: "2026-07-11T12:00:00.000Z",
          },
        ],
      },
    ];

    const markup = render({ detail });

    expect(markup).toContain("Agent run");
    expect(markup).toContain("Responding");
  });

  test("renders the shared agent conversation in the existing right sidebar", () => {
    const props = baseProps();
    props.agentConversation = {
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
        metadata: {
          profileProjectId: "project_profile",
          sourceCommitSha: "source_sha",
        },
      },
      messages: [
        {
          id: "agent_message_user",
          sequence: 1,
          role: "user",
          body: "Read the deterministic record",
          createdByUserId: "user_1",
          createdAt: "2026-07-11T12:00:00.000Z",
        },
        {
          id: "agent_message_assistant",
          sequence: 2,
          role: "assistant",
          body: "Record read successfully.",
          createdByUserId: null,
          createdAt: "2026-07-11T12:00:01.000Z",
        },
      ],
      pinnedRouting: {
        profileProjectId: "project_profile",
        sourceCommitSha: "source_sha",
      },
    };

    const markup = renderToStaticMarkup(
      createElement(TeamAgentConversationPanel, props),
    );

    expect(markup).toContain('aria-label="OAuth Verifier Agent run"');
    expect(markup).toContain("Read the deterministic record");
    expect(markup).toContain("Record read successfully.");
    expect(markup).toContain('aria-label="Close agent run"');
    expect(markup).toContain('role="log"');
    expect(markup).toContain('contentEditable="true"');
  });
});

function render(overrides: Partial<TeamChatViewProps>): string {
  return renderToStaticMarkup(createElement(TeamChatView, { ...baseProps(), ...overrides }));
}

function baseProps(): TeamChatViewProps {
  return {
    currentUserId: "user_1",
    members: [],
    agents: [],
    profile: null,
    teamId: "team_1",
    teamName: "OpenPond",
    detail: null,
    aiThread: null,
    agentConversation: null,
    loading: false,
    busy: false,
    error: null,
    connection: null,
    providerSettings: null,
    provider: "codex",
    model: "gpt-5.6-sol",
    codexPermissionMode: "default",
    codexReasoningEffort: "medium",
    openPondCommandAccessMode: "full",
    contextWindowStatus: {
      usedTokens: 0,
      maxTokens: 128_000,
      percent: 0,
      summary: "0% full",
      tokensLabel: "0 / 128k tokens used",
      detail: null,
      tooltip: "Context window: 0% full.",
      tone: "low",
    },
    showToast: noop,
    onProviderChange: noop,
    onModelChange: noop,
    onCodexPermissionModeChange: noop,
    onCodexReasoningEffortChange: noop,
    onOpenPondCommandAccessModeChange: noop,
    onOpenProviderSettings: noop,
    onSendMessage: noopBoolean,
    onPublishProfileAgent: async () => {
      throw new Error("Unexpected profile agent publication");
    },
    onOpenAiThread: noopAsync,
    onOpenAgentConversation: noopAsync,
    onCloseAiThread: noop,
    onCloseAgentConversation: noop,
    onSendAgentTurn: noopBoolean,
    onSendAiTurn: noopBoolean,
    onStopAiTurn: noopBoolean,
    onEditMessage: noopBoolean,
    onDeleteMessage: noopBoolean,
    onRetryMessage: noopBoolean,
    onDismissFailedMessage: noop,
    onLoadMoreMessages: noopBoolean,
    onRetryLoad: noopAsync,
  };
}

function emptyDetail(): NonNullable<TeamChatViewProps["detail"]> {
  return {
    thread: {
      id: "thread_1",
      teamId: "team_1",
      kind: "general",
      title: "general",
      createdByUserId: "user_1",
      lastMessageId: null,
      lastMessageSequence: 0,
      lastMessageAt: "2026-07-09T12:00:00.000Z",
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
      unreadCount: 0,
      pinnedAt: null,
      mutedAt: null,
      archivedAt: null,
      participants: [],
      lastMessage: null,
    },
    messages: [],
    hasMoreBefore: false,
  };
}

function teamMessage(
  overrides: Partial<NonNullable<TeamChatViewProps["detail"]>["messages"][number]> = {},
): NonNullable<TeamChatViewProps["detail"]>["messages"][number] {
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
