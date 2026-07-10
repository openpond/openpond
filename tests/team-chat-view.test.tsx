import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
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
});

function render(overrides: Partial<TeamChatViewProps>): string {
  return renderToStaticMarkup(createElement(TeamChatView, { ...baseProps(), ...overrides }));
}

function baseProps(): TeamChatViewProps {
  return {
    currentUserId: "user_1",
    members: [],
    detail: null,
    aiThread: null,
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
    onCloseAiThread: noop,
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
