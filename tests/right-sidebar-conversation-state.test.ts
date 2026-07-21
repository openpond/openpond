import { describe, expect, test } from "vitest";
import type { RightChatPanel } from "../apps/web/src/app/app-state";
import {
  cloneRightSidebarConversationState,
  defaultOpenRightSidebarConversationState,
  defaultRightSidebarConversationState,
  defaultRightSidebarConversationStateForSwitch,
  rightSidebarConversationState,
  rightSidebarConversationStatesEqual,
  rightSidebarWorkspacePanelStateKey,
} from "../apps/web/src/lib/right-sidebar-conversation-state";
import {
  cloneWorkspaceDiffPanelViewState,
  defaultWorkspaceDiffPanelViewState,
  nextRovingTabIndex,
  normalizeWorkspaceDiffPanelViewState,
  workspaceDiffPanelViewStatesEqual,
} from "../apps/web/src/components/workspace-diff/workspace-diff-panel-model";
import { shouldShowRightSidebarHomePanel } from "../apps/web/src/components/app-shell/MainPane";

function panel(overrides: Partial<RightChatPanel> = {}): RightChatPanel {
  return {
    id: "panel_1",
    activationVersion: 1,
    sessionId: "session_1",
    prompt: "Check this",
    provider: "openai",
    model: "gpt-5.5",
    scrollTop: 0,
    stickyToBottom: true,
    ...overrides,
  };
}

describe("right sidebar conversation state", () => {
  test("moves Files-plus-chat tabs with arrows, Home, and End", () => {
    expect(nextRovingTabIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextRovingTabIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextRovingTabIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(nextRovingTabIndex(1, 3, "Home")).toBe(0);
    expect(nextRovingTabIndex(1, 3, "End")).toBe(2);
  });

  test("uses Workspace as the fallback for an open sidebar with no content panel", () => {
    expect(
      shouldShowRightSidebarHomePanel({
        supportedView: true,
        open: true,
        hasContentPanel: false,
      }),
    ).toBe(true);
    expect(
      shouldShowRightSidebarHomePanel({
        supportedView: true,
        open: true,
        hasContentPanel: true,
      }),
    ).toBe(false);
  });

  test("defaults to a closed changes sidebar", () => {
    expect(defaultRightSidebarConversationState()).toEqual({
      diffPanelOpen: false,
      diffPanelExpanded: false,
      rightPanelMode: "changes",
      rightChatPanels: [],
    });
  });

  test("uses a home panel when switching into uncached chats from an open sidebar", () => {
    expect(defaultOpenRightSidebarConversationState()).toEqual({
      diffPanelOpen: true,
      diffPanelExpanded: false,
      rightPanelMode: "home",
      rightChatPanels: [],
    });
    expect(defaultRightSidebarConversationStateForSwitch({ keepOpen: true })).toEqual(
      defaultOpenRightSidebarConversationState(),
    );
    expect(defaultRightSidebarConversationStateForSwitch({ keepOpen: false })).toEqual(
      defaultRightSidebarConversationState(),
    );
  });

  test("compares and clones side chat panels", () => {
    const state = rightSidebarConversationState({
      diffPanelOpen: true,
      diffPanelExpanded: false,
      rightPanelMode: "chat",
      rightChatPanels: [panel()],
    });
    const cloned = cloneRightSidebarConversationState(state);

    expect(rightSidebarConversationStatesEqual(state, cloned)).toBe(true);
    expect(cloned.rightChatPanels[0]).not.toBe(state.rightChatPanels[0]);
    expect(
      rightSidebarConversationStatesEqual(state, {
        ...cloned,
        rightChatPanels: [panel({ prompt: "Different prompt" })],
      }),
    ).toBe(false);
    expect(
      rightSidebarConversationStatesEqual(state, {
        ...cloned,
        rightChatPanels: [panel({ scrollTop: 240, stickyToBottom: false })],
      }),
    ).toBe(false);
    expect(
      rightSidebarConversationStatesEqual(state, {
        ...cloned,
        rightChatPanels: [panel({ activationVersion: 2 })],
      }),
    ).toBe(false);
  });

  test("compares and clones workspace file panel view state", () => {
    const state = {
      activeTab: "file" as const,
      openFilePaths: ["docs/notes.md", "apps/web/src/App.tsx"],
      selectedPath: "docs/notes.md",
    };
    const cloned = cloneWorkspaceDiffPanelViewState(state);

    expect(defaultWorkspaceDiffPanelViewState()).toEqual({
      activeTab: "files",
      openFilePaths: [],
      selectedPath: null,
    });
    expect(workspaceDiffPanelViewStatesEqual(state, cloned)).toBe(true);
    expect(cloned.openFilePaths).not.toBe(state.openFilePaths);
    expect(
      workspaceDiffPanelViewStatesEqual(state, {
        ...cloned,
        selectedPath: "apps/web/src/App.tsx",
      }),
    ).toBe(false);
  });

  test("normalizes absolute workspace file panel paths", () => {
    expect(
      normalizeWorkspaceDiffPanelViewState(
        {
          activeTab: "file",
          openFilePaths: [
            "/home/glu/Projects/all/openpond/docs/notes.md",
            "openpond/apps/web/src/App.tsx",
            "/home/glu/Projects/all/openpond/docs/notes.md",
          ],
          selectedPath: "/home/glu/Projects/all/openpond/docs/notes.md",
        },
        "/home/glu/Projects/all/openpond",
      ),
    ).toEqual({
      activeTab: "file",
      openFilePaths: ["docs/notes.md", "apps/web/src/App.tsx"],
      selectedPath: "docs/notes.md",
    });
  });

  test("scopes workspace file panel state by conversation and workspace source", () => {
    expect(
      rightSidebarWorkspacePanelStateKey({
        conversationId: "session_1",
        workspaceSourceKey: "cwd:/tmp/project-a",
      }),
    ).not.toBe(
      rightSidebarWorkspacePanelStateKey({
        conversationId: "session_1",
        workspaceSourceKey: "cwd:/tmp/project-b",
      }),
    );
    expect(
      rightSidebarWorkspacePanelStateKey({
        conversationId: "session_1",
        workspaceSourceKey: "cwd:/tmp/project-a",
      }),
    ).not.toBe(
      rightSidebarWorkspacePanelStateKey({
        conversationId: "session_2",
        workspaceSourceKey: "cwd:/tmp/project-a",
      }),
    );
  });
});
