import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RightChatPanelStack,
  type RightChatPanelView,
} from "../apps/web/src/components/app-shell/RightChatPanelStack";
import type { ContextWindowStatus } from "../apps/web/src/lib/context-window";
import type { WorkspaceTargetState } from "../apps/web/src/lib/workspace-location";

const noop = () => undefined;
const noopAsync = async () => undefined;
const noopAsyncBoolean = async () => true;

describe("Right chat panel stack", () => {
  test("keeps Summary and Review in the right-sidebar chrome above side chats", () => {
    const markup = renderRightChatStack({
      panels: [rightChatPanel("panel_top", "Top chat"), rightChatPanel("panel_bottom", "Bottom chat")],
    });

    expect(markup).toContain("right-chat-topbar");
    expect(markup).toContain("Summary");
    expect(markup).toContain("Review");
    expect(markup).toContain("right-chat-tab active");
    expect(markup).toContain("Top chat");
    expect(markup).toContain("Bottom chat");
    expect(markup).toContain("aria-label=\"Close Top chat\"");
    expect(markup).toContain("aria-label=\"Add side chat\"");
    expect(markup).toContain("right-chat-stack-body panes-2");
    expect(markup).toContain("right-chat-splitter");
    expect(markup).not.toContain("right-chat-empty");
    expect(markup).not.toContain("right-chat-pane-header");
    expect(markup).not.toContain("right-chat-status-dot");
    expect(markup).not.toContain("titlebar-add-menu");
  });

  test("keeps an idle side-chat composer editable while another chat is busy", () => {
    const markup = renderRightChatStack({
      busy: true,
      panels: [{ ...rightChatPanel("panel_idle", "Idle chat"), prompt: "hello" }],
    });

    expect(markup.toLowerCase()).toContain('contenteditable="true"');
    expect(markup).toContain('aria-label="Send"');
    expect(markup).not.toContain('aria-label="Stop response"');
  });

  test("keeps a running side-chat composer editable while the stop control is visible", () => {
    const markup = renderRightChatStack({
      panels: [{ ...rightChatPanel("panel_running", "Running chat"), running: true }],
    });

    expect(markup.toLowerCase()).toContain('contenteditable="true"');
    expect(markup).toContain('aria-label="Stop response"');
    expect(markup).not.toContain('aria-label="Interrupt and send"');
  });

  test("shows interrupt send for a running side-chat with a drafted follow-up", () => {
    const markup = renderRightChatStack({
      panels: [{ ...rightChatPanel("panel_running", "Running chat"), prompt: "new idea", running: true }],
    });

    expect(markup.toLowerCase()).toContain('contenteditable="true"');
    expect(markup).toContain('aria-label="Interrupt and send"');
    expect(markup).not.toContain('aria-label="Stop response"');
  });
});

function renderRightChatStack({
  busy = false,
  panels,
}: {
  busy?: boolean;
  panels: RightChatPanelView[];
}): string {
  return renderToStaticMarkup(
    createElement(RightChatPanelStack, {
      panels,
      busy,
      codexPermissionMode: "default",
      codexReasoningEffort: "medium",
      connection: null,
      mentionApps: [],
      projectTarget: {
        value: "none",
        label: "No project",
        detail: "General chat",
        options: [{ value: "none", label: "No project", detail: "General chat", kind: "none" }],
        busy: false,
      },
      providerSettings: null,
      showToast: noop,
      workspaceTarget: workspaceTargetState(),
      onAddChat: noop,
      onClosePanel: noop,
      onCodexPermissionModeChange: noop,
      onCodexReasoningEffortChange: noop,
      onModelChange: noop,
      onOpenFileInSidebar: noop,
      onOpenProfileSettings: noop,
      onProviderChange: noop,
      onProviderSetupOpen: noop,
      onPromptChange: noop,
      onProjectTargetChange: noop,
      onResolveApproval: noopAsync,
      onResizeStart: noop,
      onSelectReview: noop,
      onSelectSummary: noop,
      onShowBrowserPanel: noop,
      onStop: noopAsyncBoolean,
      onSubmit: async () => true,
      onWorkspaceTargetChange: noop,
    }),
  );
}

function rightChatPanel(id: string, title: string): RightChatPanelView {
  return {
    id,
    sessionId: null,
    prompt: "",
    provider: "openpond",
    model: "openpond-chat",
    session: null,
    title,
    messages: [],
    contextWindowStatus: contextWindowStatus(),
    goalRuntime: null,
    pendingApproval: null,
    running: false,
    workspaceRootPath: null,
    activeWorkspaceAppId: null,
  };
}

function contextWindowStatus(): ContextWindowStatus {
  return {
    usedTokens: 2400,
    maxTokens: 128000,
    percent: 2,
    summary: "2% full",
    tokensLabel: "2.4k / 128k tokens used",
    detail: null,
    tooltip: "Context window: 2% full.",
    tone: "low",
  };
}

function workspaceTargetState(): WorkspaceTargetState {
  return {
    value: "local",
    label: "Local",
    detail: "Use local workspace",
    options: [
      { value: "local", label: "Local", detail: "Use local workspace", disabled: false },
      { value: "cloud", label: "Cloud", detail: "Use cloud workspace", disabled: false },
    ],
    action: { value: "cloud", label: "Move to Cloud", detail: "Create a cloud workspace", disabled: false },
    busy: false,
  };
}
