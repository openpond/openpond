import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RightChatPanelStack,
  type RightChatPanelView,
} from "../apps/web/src/components/app-shell/RightChatPanelStack";
import type { ContextWindowStatus } from "../apps/web/src/lib/context-window";
import type { WorkspaceTargetState } from "../apps/web/src/lib/workspace-location";
import { COMPOSER_SLASH_COMMANDS } from "../apps/web/src/lib/composer-slash-commands";
import { rightChatCommandPolicy } from "../apps/web/src/lib/right-chat-command-policy";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";

const noop = () => undefined;
const noopAsync = async () => undefined;
const noopAsyncBoolean = async () => true;

describe("Right chat panel stack", () => {
  test("adapts every slash command explicitly without Goal fallthrough", () => {
    const policies = Object.fromEntries(COMPOSER_SLASH_COMMANDS.map((command) => [
      command.id,
      rightChatCommandPolicy(command, "Review account health"),
    ]));

    expect(policies).toMatchObject({
      create: { kind: "send_prompt", prompt: "/create Review account health" },
      edit: { kind: "send_prompt", prompt: "/edit Review account health" },
      skill: { kind: "send_prompt", prompt: "/skill Review account health" },
      goal: { kind: "send_prompt", prompt: "Goal: Review account health" },
      "goal-remote": { kind: "send_prompt", prompt: "/goal-remote Review account health" },
      "goal-local": { kind: "send_prompt", prompt: "Goal: Review account health" },
      train: { kind: "open_training", objective: "Review account health" },
      insights: { kind: "open_insights" },
      "sync-cloud": { kind: "send_prompt", prompt: "/sync-cloud Review account health" },
    });
    expect(policies["submit-issue"]).toMatchObject({ kind: "send_prompt" });
    expect(JSON.stringify(policies["submit-issue"])).toContain("GitHub issue in openpond/openpond");
    expect(JSON.stringify(policies["submit-issue"])).toContain("Review account health");
  });

  test("keeps Files and every side chat in a selectable right-sidebar tab strip", () => {
    const markup = renderRightChatStack({
      panels: [
        rightChatPanel("panel_top", "Top chat"),
        rightChatPanel("panel_middle", "Middle chat"),
        rightChatPanel("panel_bottom", "Bottom chat"),
      ],
    });

    expect(markup).toContain("right-chat-topbar");
    expect(markup).toContain("Files");
    expect(markup).toContain("right-chat-tab active");
    expect(markup).toContain("Top chat");
    expect(markup).toContain("Middle chat");
    expect(markup).toContain("Bottom chat");
    expect(markup).toContain("aria-label=\"Close Top chat\"");
    expect(markup).toContain("aria-label=\"Add to right sidebar\"");
    expect(markup).toContain("right-chat-stack-body panes-1");
    expect(markup).toContain('id="right-chat-panel-panel_bottom"');
    expect(markup).toContain('id="right-sidebar-files-tab"');
    expect(markup).toContain('aria-controls="right-sidebar-files-panel"');
    expect(markup).toContain('id="right-chat-tab-panel_bottom"');
    expect(markup).toContain('aria-controls="right-chat-panel-panel_bottom"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-selected="false"');
    expect(markup).not.toContain("right-chat-splitter");
    expect(markup).not.toContain("right-chat-empty");
    expect(markup).not.toContain("right-chat-pane-header");
    expect(markup).not.toContain("right-chat-status-dot");
    expect(markup).not.toContain("titlebar-add-menu");
    expect(markup).not.toContain("Summary");
    expect(markup).not.toContain("Changes");
    expect(markup).not.toContain("Review");
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
    expect(markup).not.toContain('aria-label="Steer"');
  });

  test("shows steer controls for a running side-chat with a drafted follow-up", () => {
    const markup = renderRightChatStack({
      panels: [{ ...rightChatPanel("panel_running", "Running chat"), prompt: "new idea", running: true }],
    });

    expect(markup.toLowerCase()).toContain('contenteditable="true"');
    expect(markup).toContain('aria-label="Steer"');
    expect(markup).toContain('aria-label="Queue steer draft"');
    expect(markup).not.toContain('aria-label="Stop response"');
  });

  test("projects the canonical Create run into the side-chat composer", () => {
    const run = createImproveRunFixture({ state: "awaiting_plan_approval" });
    const markup = renderRightChatStack({
      panels: [{ ...rightChatPanel("panel_create", "Account Health Agent"), createImproveRun: run }],
    });

    expect(markup).toContain("has-create-runtime");
    expect(markup).toContain("Account Health Agent");
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
      createImproveActions: {},
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
      onActivatePanel: noop,
      onClosePanel: noop,
      onCodexPermissionModeChange: noop,
      onCodexReasoningEffortChange: noop,
      onModelChange: noop,
      onOpenFileInSidebar: noop,
      onOpenProfileSettings: noop,
      onProviderChange: noop,
      onProviderSetupOpen: noop,
      onPromptChange: noop,
      onScrollStateChange: noop,
      onProjectTargetChange: noop,
      onResolveApproval: noopAsync,
      onResizeStart: noop,
      onSelectFiles: noop,
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
    activationVersion: 1,
    sessionId: null,
    prompt: "",
    provider: "openpond",
    model: "openpond-chat",
    scrollTop: 148,
    stickyToBottom: false,
    session: null,
    title,
    messages: [],
    contextWindowStatus: contextWindowStatus(),
    goalRuntime: null,
    createImproveRun: null,
    pendingApproval: null,
    running: false,
    steerAutoDispatchBlocked: false,
    steerAutoDispatchReady: false,
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
