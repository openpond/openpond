import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AppTopBar } from "../apps/web/src/components/app-shell/AppTopBar";

const noop = () => undefined;

function renderTopBar(overrides: Partial<Parameters<typeof AppTopBar>[0]> = {}): string {
  return renderToStaticMarkup(createElement(AppTopBar, {
    sidebarOpen: true,
    title: "Get started",
    workspaceName: null,
    workspaceId: null,
    busy: false,
    workspaceState: null,
    workspaceKind: null,
    selectedApp: null,
    selectedProject: null,
    workspaceDiff: null,
    managedWorkspace: false,
    workspaceBusy: false,
    showDiffControls: false,
    diffPanelOpen: false,
    terminalOpen: false,
    onToggleDiffPanel: noop,
    onOpenSearch: noop,
    onToggleTerminal: noop,
    onOpenInsights: noop,
    onRunTerminalCommand: noop,
    onWorkspaceToolAction: async () => null,
    onOpenCommitDialog: noop,
    connection: null,
    onBootstrap: noop,
    onOpenSandboxWorkspace: noop,
    onShowSidebar: noop,
    ...overrides,
  }));
}

describe("AppTopBar", () => {
  test("keeps the page title without rendering the inert title ellipsis", () => {
    const markup = renderTopBar({ showWorkspaceControls: true });

    expect(markup).toContain("Get started");
    expect(markup).not.toContain('title="More"');
  });

  test("shows the shared right-sidebar control in the top-right actions", () => {
    const markup = renderTopBar({
      onToggleRightSidebar: noop,
      rightSidebarAvailable: true,
      rightSidebarOpen: true,
      showWorkspaceControls: false,
    });

    expect(markup).toContain('aria-label="Hide sidebar"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("topbar-diff-button active");
  });
});
