import type { TerminalCommandStatus, TerminalScope, TerminalScopeSummaryStatus } from "@openpond/contracts";
import type { TerminalQueuedCommand, TerminalTab } from "./terminal-overlay-types";

export type TerminalScopeSummary = {
  scope: TerminalScope;
  tabCount: number;
  runningCount: number;
  failedCount: number;
  lastExitCode: number | null;
  status: TerminalScopeSummaryStatus;
};

export type SidebarTerminalIndicator = {
  status: Exclude<TerminalScopeSummaryStatus, "none">;
  label: string;
};

export type TerminalSelection = {
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  selectedAppId: string | null;
};

export function terminalScopeKey(scope: TerminalScope): string {
  return `${scope.kind}:${scope.id}`;
}

export function terminalScopesEqual(left: TerminalScope | null | undefined, right: TerminalScope | null | undefined): boolean {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id);
}

export function terminalScopeForSession(sessionId: string): TerminalScope {
  return { kind: "session", id: sessionId };
}

export function terminalScopeForProject(projectSelectionId: string): TerminalScope {
  return { kind: "project", id: projectSelectionId };
}

export function terminalScopeForDraft(id: string): TerminalScope {
  return { kind: "draft", id };
}

export function terminalScopeForSelection(selection: TerminalSelection): TerminalScope {
  if (selection.selectedSessionId) return terminalScopeForSession(selection.selectedSessionId);
  if (selection.selectedProjectId) return terminalScopeForProject(selection.selectedProjectId);
  return terminalScopeForDraft(selection.selectedAppId ? `app:${selection.selectedAppId}` : "new-chat");
}

export function migrateDraftTerminalTabs(input: {
  tabs: readonly TerminalTab[];
  previousScope: TerminalScope | null;
  activeScope: TerminalScope;
  now?: number;
}): TerminalTab[] {
  if (!input.previousScope || input.previousScope.kind !== "draft" || input.activeScope.kind !== "session") {
    return [...input.tabs];
  }
  if (terminalScopesEqual(input.previousScope, input.activeScope)) return [...input.tabs];
  const updatedAt = input.now ?? Date.now();
  return input.tabs.map((tab) =>
    terminalScopesEqual(tab.scope, input.previousScope)
      ? {
          ...tab,
          scope: input.activeScope,
          updatedAt,
        }
      : tab
  );
}

export function terminalTabsForScope(tabs: readonly TerminalTab[], scope: TerminalScope): TerminalTab[] {
  return tabs.filter((tab) => terminalScopesEqual(tab.scope, scope));
}

export function terminalQueuedCommandAppliesToScope(
  command: Pick<TerminalQueuedCommand, "scope"> | null | undefined,
  scope: TerminalScope,
): boolean {
  return Boolean(command && terminalScopesEqual(command.scope, scope));
}

export function terminalScopeSummaries(tabs: readonly TerminalTab[]): Record<string, TerminalScopeSummary> {
  const summaries: Record<string, TerminalScopeSummary> = {};
  for (const tab of tabs) {
    const key = terminalScopeKey(tab.scope);
    const current =
      summaries[key] ??
      {
        scope: tab.scope,
        tabCount: 0,
        runningCount: 0,
        failedCount: 0,
        lastExitCode: null,
        status: "none" as TerminalScopeSummaryStatus,
      };
    current.tabCount += 1;
    if (tab.commandStatus === "running") current.runningCount += 1;
    if (tab.commandStatus === "failed" || tab.status === "error") current.failedCount += 1;
    if (tab.lastExitCode !== null) current.lastExitCode = tab.lastExitCode;
    current.status = terminalSummaryStatus(current.status, tab.status, tab.commandStatus);
    summaries[key] = current;
  }
  return summaries;
}

export function sidebarTerminalIndicator(summary: TerminalScopeSummary | null | undefined): SidebarTerminalIndicator | null {
  if (!summary || summary.status === "none" || summary.tabCount === 0) return null;
  if (summary.status === "running") return { status: "running", label: "Terminal running" };
  if (summary.status === "failed") return { status: "failed", label: "Terminal last command failed" };
  if (summary.status === "success") return { status: "success", label: "Terminal last command succeeded" };
  if (summary.status === "idle") return { status: "idle", label: "Terminal idle" };
  return { status: "unknown", label: "Terminal open" };
}

function terminalSummaryStatus(
  current: TerminalScopeSummaryStatus,
  ptyStatus: TerminalTab["status"],
  commandStatus: TerminalCommandStatus,
): TerminalScopeSummaryStatus {
  if (commandStatus === "running") return "running";
  if (current === "running") return current;
  if (commandStatus === "failed" || ptyStatus === "error") return "failed";
  if (current === "failed") return current;
  if (commandStatus === "success") return current === "none" || current === "unknown" || current === "idle" ? "success" : current;
  if (commandStatus === "idle") return current === "none" || current === "unknown" ? "idle" : current;
  if (ptyStatus === "running" || ptyStatus === "connecting") return current === "none" ? "unknown" : current;
  if (ptyStatus === "exited") return current === "none" ? "unknown" : current;
  return current === "none" ? "unknown" : current;
}
