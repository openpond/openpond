import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TeamAgentConversationPanel,
  TeamAiThreadPanel,
  TeamChatView,
  type TeamChatViewProps,
} from "../apps/web/src/components/team-chat/TeamChatView";

const noop = () => undefined;
const noopAsync = async () => undefined;
const noopBoolean = async () => true;

describe("team chat view", () => {
  test("renders accessible loading and failure states with a reload action", () => {
    const loading = render({ loading: true });
    expect(loading).toContain('role="log"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Loading messages...");

    const failed = render({ error: "Could not load messages" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Could not load messages");
    expect(failed).toContain("Retry");
  });

  test("renders the empty state and keeps the team composer available", () => {
    const markup = render({ detail: emptyDetail() });
    expect(markup).toContain("No messages yet");
    expect(markup).toContain('contentEditable="true"');
    expect(markup).toContain('aria-label="# general"');
    expect(markup).not.toContain("team-chat-header");
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
