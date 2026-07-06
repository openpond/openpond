import { Buffer } from "node:buffer";

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Session } from "@openpond/contracts";
import {
  parseClientMessage,
  parseTerminalIntegrationOutput,
  terminalScopesCompatibleForAttach,
} from "../apps/server/src/runtime/terminal-sessions";
import { SidebarSessionRow } from "../apps/web/src/components/sidebar/SidebarRows";
import {
  migrateDraftTerminalTabs,
  terminalQueuedCommandAppliesToScope,
  sidebarTerminalIndicator,
  terminalScopeForProject,
  terminalScopeForSelection,
  terminalScopeForSession,
  terminalScopeKey,
  terminalScopeSummaries,
  terminalTabsForScope,
} from "../apps/web/src/components/terminal/terminal-state";
import type { TerminalTab } from "../apps/web/src/components/terminal/terminal-overlay-types";

describe("terminal scope state", () => {
  test("selects separate terminal tabs when switching between conversations", () => {
    const sessionAScope = terminalScopeForSelection({
      selectedSessionId: "session_a",
      selectedProjectId: null,
      selectedAppId: null,
    });
    const sessionBScope = terminalScopeForSelection({
      selectedSessionId: "session_b",
      selectedProjectId: null,
      selectedAppId: null,
    });
    const tabs = [
      terminalTab("terminal_a_1", sessionAScope),
      terminalTab("terminal_b_1", sessionBScope),
      terminalTab("terminal_a_2", sessionAScope),
    ];

    expect(terminalTabsForScope(tabs, sessionAScope).map((tab) => tab.id)).toEqual([
      "terminal_a_1",
      "terminal_a_2",
    ]);
    expect(terminalTabsForScope(tabs, sessionBScope).map((tab) => tab.id)).toEqual([
      "terminal_b_1",
    ]);
  });

  test("migrates draft terminal tabs to the created session scope", () => {
    const draftScope = terminalScopeForSelection({
      selectedSessionId: null,
      selectedProjectId: null,
      selectedAppId: null,
    });
    const createdSessionScope = terminalScopeForSelection({
      selectedSessionId: "session_created",
      selectedProjectId: null,
      selectedAppId: null,
    });
    const projectScope = terminalScopeForProject("local:project_1");
    const migrated = migrateDraftTerminalTabs({
      tabs: [
        terminalTab("draft_terminal", draftScope, { updatedAt: 1 }),
        terminalTab("project_terminal", projectScope, { updatedAt: 1 }),
      ],
      previousScope: draftScope,
      activeScope: createdSessionScope,
      now: 2,
    });

    expect(migrated[0]).toMatchObject({
      id: "draft_terminal",
      scope: createdSessionScope,
      updatedAt: 2,
    });
    expect(migrated[1]).toMatchObject({
      id: "project_terminal",
      scope: projectScope,
      updatedAt: 1,
    });
  });

  test("removes scope summaries when the final tab for a scope is closed", () => {
    const sessionScope = terminalScopeForSession("session_1");
    const projectScope = terminalScopeForProject("local:project_1");
    const tabs = [
      terminalTab("session_terminal", sessionScope),
      terminalTab("project_terminal", projectScope),
    ];
    const remainingTabs = tabs.filter((tab) => tab.id !== "session_terminal");
    const summaries = terminalScopeSummaries(remainingTabs);

    expect(summaries[terminalScopeKey(sessionScope)]).toBeUndefined();
    expect(summaries[terminalScopeKey(projectScope)]).toMatchObject({
      tabCount: 1,
    });
  });

  test("groups terminal summaries by session and project scope with status precedence", () => {
    const sessionScope = terminalScopeForSession("session_1");
    const projectScope = terminalScopeForProject("local:project_1");
    const summaries = terminalScopeSummaries([
      terminalTab("tab_session_idle", sessionScope, { commandStatus: "idle" }),
      terminalTab("tab_session_running", sessionScope, { commandStatus: "running" }),
      terminalTab("tab_project_failed", projectScope, { commandStatus: "failed", lastExitCode: 1 }),
      terminalTab("tab_project_success", projectScope, { commandStatus: "success", lastExitCode: 0 }),
    ]);

    expect(summaries[terminalScopeKey(sessionScope)]).toMatchObject({
      tabCount: 2,
      runningCount: 1,
      status: "running",
    });
    expect(sidebarTerminalIndicator(summaries[terminalScopeKey(sessionScope)])).toEqual({
      status: "running",
      label: "Terminal running",
    });
    expect(summaries[terminalScopeKey(projectScope)]).toMatchObject({
      tabCount: 2,
      failedCount: 1,
      lastExitCode: 0,
      status: "failed",
    });
    expect(sidebarTerminalIndicator(summaries[terminalScopeKey(projectScope)])).toEqual({
      status: "failed",
      label: "Terminal last command failed",
    });
  });

  test("keeps queued terminal commands bound to their original conversation scope", () => {
    const sessionAScope = terminalScopeForSession("session_a");
    const sessionBScope = terminalScopeForSession("session_b");
    const queuedCommand = {
      id: 1,
      scope: sessionAScope,
      command: "bun test",
    };

    expect(terminalQueuedCommandAppliesToScope(queuedCommand, sessionAScope)).toBe(true);
    expect(terminalQueuedCommandAppliesToScope(queuedCommand, sessionBScope)).toBe(false);
    expect(terminalQueuedCommandAppliesToScope(null, sessionAScope)).toBe(false);
  });
});

describe("terminal shell integration parser", () => {
  test("strips shell markers and emits command lifecycle events", () => {
    const command = Buffer.from("bun test").toString("base64url");
    const parsed = parseTerminalIntegrationOutput(
      `before\x1b]1337;OpenPond;command_start;sequence=1;command=${command}\x07middle` +
        `\x1b]1337;OpenPond;command_end;sequence=2;exitCode=0\x07after` +
        `\x1b]1337;OpenPond;prompt_ready;sequence=3\x07`,
    );

    expect(parsed.output).toBe("beforemiddleafter");
    expect(parsed.pending).toBe("");
    expect(parsed.events).toEqual([
      { type: "command_start", sequence: 1, command: "bun test" },
      { type: "command_end", sequence: 2, exitCode: 0 },
      { type: "prompt_ready", sequence: 3 },
    ]);
  });

  test("holds partial markers until the next chunk", () => {
    const first = parseTerminalIntegrationOutput("left\x1b]1337;OpenPond;command_end;sequence=4");
    expect(first.output).toBe("left");
    expect(first.pending).toBe("\x1b]1337;OpenPond;command_end;sequence=4");
    expect(first.events).toEqual([]);

    const second = parseTerminalIntegrationOutput(`${first.pending};exitCode=7\x07right`);
    expect(second.output).toBe("right");
    expect(second.pending).toBe("");
    expect(second.events).toEqual([{ type: "command_end", sequence: 4, exitCode: 7 }]);
  });

  test("passes through ordinary PTY output when integration markers are absent", () => {
    expect(parseTerminalIntegrationOutput("plain shell output")).toEqual({
      output: "plain shell output",
      pending: "",
      events: [],
    });
  });
});

describe("terminal websocket scope validation", () => {
  test("requires valid scope on start messages", () => {
    expect(parseClientMessage(Buffer.from(JSON.stringify({ type: "start", terminalId: "terminal_1" })), false)).toBeNull();
    expect(
      parseClientMessage(
        Buffer.from(JSON.stringify({ type: "start", terminalId: "terminal_1", scope: { kind: "session", id: "session_1" } })),
        false,
      ),
    ).toMatchObject({
      type: "start",
      terminalId: "terminal_1",
      scope: { kind: "session", id: "session_1" },
    });
  });

  test("allows draft terminals to migrate to a created session but rejects unrelated scopes", () => {
    expect(
      terminalScopesCompatibleForAttach(
        { kind: "session", id: "session_1" },
        { kind: "session", id: "session_1" },
      ),
    ).toBe(true);
    expect(
      terminalScopesCompatibleForAttach(
        { kind: "draft", id: "new-chat" },
        { kind: "session", id: "session_1" },
      ),
    ).toBe(true);
    expect(
      terminalScopesCompatibleForAttach(
        { kind: "session", id: "session_1" },
        { kind: "session", id: "session_2" },
      ),
    ).toBe(false);
    expect(
      terminalScopesCompatibleForAttach(
        { kind: "project", id: "local:project_1" },
        { kind: "session", id: "session_1" },
      ),
    ).toBe(false);
  });
});

describe("sidebar terminal indicators", () => {
  test("renders accessible terminal state on chat rows", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarSessionRow, {
        session: sessionFixture(),
        selected: false,
        hideIcon: true,
        terminalIndicator: { status: "running", label: "Terminal running" },
        onSelect: () => undefined,
        onTogglePin: () => undefined,
        onArchive: () => undefined,
      }),
    );

    expect(markup).toContain("sidebar-terminal-indicator running");
    expect(markup).toContain("aria-label=\"Terminal running\"");
  });

  test("renders goal running state with objective tooltip on chat rows", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarSessionRow, {
        session: sessionFixture(),
        selected: false,
        hideIcon: true,
        running: true,
        goalRuntime: {
          objective: "Review command access doc",
          status: "active",
          timeUsedSeconds: 12,
          tokensUsed: null,
          tokenBudget: null,
          actionLabel: "Pursuing goal",
          timeLabel: "12s",
          label: "Goal 12s",
          detail: "Active",
          tooltip: "Goal runtime: 12 seconds. Active. Review command access doc",
          tone: "active",
        },
        onSelect: () => undefined,
        onTogglePin: () => undefined,
        onArchive: () => undefined,
      }),
    );

    expect(markup).toContain("sidebar-row has-running-dot");
    expect(markup).toContain("sidebar-running-dot goal");
    expect(markup).toContain("sidebar-project-locations-popover sidebar-session-running-popover");
    expect(markup).toContain("Pursuing goal");
    expect(markup).toContain("Review command access doc");
    expect(markup).not.toContain("Pursuing goal: Review command access doc");
    expect(markup).not.toContain('data-tooltip="Pursuing goal: Review command access doc"');
  });

  test("truncates long goal objectives in the running tooltip body", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarSessionRow, {
        session: sessionFixture(),
        selected: false,
        hideIcon: true,
        running: true,
        goalRuntime: {
          objective: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"),
          status: "active",
          timeUsedSeconds: 12,
          tokensUsed: null,
          tokenBudget: null,
          actionLabel: "Pursuing goal",
          timeLabel: "12s",
          label: "Goal 12s",
          detail: "Active",
          tooltip: "Goal runtime: 12 seconds. Active.",
          tone: "active",
        },
        onSelect: () => undefined,
        onTogglePin: () => undefined,
        onArchive: () => undefined,
      }),
    );

    expect(markup).toContain("line 5");
    expect(markup).toContain("...");
    expect(markup).not.toContain("line 6");
  });
});

function terminalTab(
  id: string,
  scope: TerminalTab["scope"],
  overrides: Partial<TerminalTab> = {},
): TerminalTab {
  return {
    id,
    scope,
    title: id,
    cwd: "/workspace",
    appId: null,
    status: "running",
    commandStatus: "unknown",
    lastExitCode: null,
    lastCommand: null,
    shell: "bash",
    detail: null,
    updatedAt: 1,
    ...overrides,
  };
}

function sessionFixture(): Session {
  return {
    id: "session_1",
    provider: "openpond",
    modelRef: null,
    title: "Terminal session",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: "local_project_1",
    workspaceName: "Project",
    localProjectId: "local_project_1",
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/workspace",
    codexThreadId: null,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}
