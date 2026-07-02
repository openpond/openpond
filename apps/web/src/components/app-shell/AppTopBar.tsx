import type {
  BootstrapPayload,
  InsightItem,
  InsightSummary,
  LocalProject,
  OpenPondApp,
  WorkspaceDiffSummary,
  WorkspaceKind,
  WorkspaceState,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { lazy, Suspense } from "react";
import {
  ChevronRight,
  Lightbulb,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Search,
  SquareTerminal,
} from "../icons";
import { WindowControls, isDesktopShell, isMacPlatform } from "./WindowControls";
import type { CommitNextStep } from "../workspace/WorkspaceGitDialogs";
import type { ClientConnection } from "../../api";

const WorkspaceEnvironmentMenu = lazy(() =>
  import("../chat/WorkspaceEnvironmentMenu").then((module) => ({ default: module.WorkspaceEnvironmentMenu })),
);

export type TopBarBreadcrumb = {
  label: string;
  onSelect?: () => void;
};

export function AppTopBar({
  sidebarOpen,
  title,
  breadcrumbs,
  workspaceName,
  busy,
  workspaceState,
  workspaceKind,
  selectedApp,
  selectedProject,
  workspaceDiff,
  managedWorkspace,
  workspaceBusy,
  defaultTeamId,
  showDiffControls,
  diffPanelOpen,
  terminalOpen,
  onToggleDiffPanel,
  onOpenSearch,
  onToggleTerminal,
  onOpenInsights,
  onRunTerminalCommand,
  onWorkspaceToolAction,
  onOpenCommitDialog,
  onWorkspaceBranchChange,
  onWorkspaceBranchCreate,
  connection,
  onBootstrap,
  onOpenSandboxWorkspace,
  onShowSidebar,
  platform,
  showWorkspaceControls = true,
  insightsItems = [],
  insightsSummary,
  insightsScanning = false,
}: {
  sidebarOpen: boolean;
  title: string;
  breadcrumbs?: TopBarBreadcrumb[];
  workspaceName: string | null;
  busy: boolean;
  workspaceState: WorkspaceState | null;
  workspaceKind: WorkspaceKind | null;
  selectedApp: OpenPondApp | null;
  selectedProject: LocalProject | null;
  workspaceDiff: WorkspaceDiffSummary | null;
  managedWorkspace: boolean;
  workspaceBusy: boolean;
  defaultTeamId?: string | null;
  showDiffControls: boolean;
  diffPanelOpen: boolean;
  terminalOpen: boolean;
  onToggleDiffPanel: () => void;
  onOpenSearch: () => void;
  onToggleTerminal: () => void;
  onOpenInsights: () => void;
  onRunTerminalCommand: (command: string) => void;
  onWorkspaceToolAction: (
    action: WorkspaceToolRequest["action"],
    args?: Record<string, unknown>,
  ) => Promise<WorkspaceToolResult | null>;
  onOpenCommitDialog: (nextStep?: CommitNextStep) => void;
  onWorkspaceBranchChange?: (branch: string) => void;
  onWorkspaceBranchCreate?: () => void;
  connection: ClientConnection | null;
  onBootstrap: (payload: BootstrapPayload) => void;
  onOpenSandboxWorkspace: (input: { sandboxId: string; name: string | null }) => Promise<void> | void;
  onShowSidebar: () => void;
  platform?: string | null;
  showWorkspaceControls?: boolean;
  insightsItems?: InsightItem[];
  insightsSummary?: InsightSummary | null;
  insightsScanning?: boolean;
}) {
  const filesChanged = workspaceDiff?.filesChanged ?? 0;
  const showWindowControls = isDesktopShell() && !isMacPlatform(platform);
  const showRightControls = showWorkspaceControls || showWindowControls;
  const activeInsightCount = insightsSummary?.activeCount ?? 0;
  const activeInsights = insightsItems.filter((item) => item.status === "active");
  return (
    <header className="app-titlebar">
      <div className="titlebar-left">
        {!sidebarOpen && (
          <button className="titlebar-icon" title="Show sidebar" onClick={onShowSidebar}>
            <PanelLeft size={16} />
          </button>
        )}
        {breadcrumbs?.length ? (
          <nav className="titlebar-breadcrumbs" aria-label="Breadcrumb">
            {breadcrumbs.map((item, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <div className="titlebar-breadcrumb-item" key={`${item.label}-${index}`}>
                  {item.onSelect && !isLast ? (
                    <button type="button" onClick={item.onSelect}>
                      {item.label}
                    </button>
                  ) : (
                    <strong>{item.label}</strong>
                  )}
                  {!isLast && <ChevronRight size={14} />}
                </div>
              );
            })}
          </nav>
        ) : (
          <div className="titlebar-title">
            <strong>{title}</strong>
            {workspaceName && <span>{workspaceName}</span>}
            {showWorkspaceControls && (
              <button className="titlebar-icon" title="More">
                <MoreHorizontal size={17} />
              </button>
            )}
          </div>
        )}
      </div>
      {showRightControls && (
        <div className="titlebar-right">
          {showWorkspaceControls && (
            <div className="titlebar-actions">
              <Suspense fallback={null}>
                <WorkspaceEnvironmentMenu
                  mode="topbar"
                  busy={busy}
                  workspaceState={workspaceState}
                  workspaceKind={workspaceKind}
                  selectedApp={selectedApp}
                  selectedProject={selectedProject}
                  workspaceBusy={workspaceBusy}
                  defaultTeamId={defaultTeamId}
                  workspaceDiff={workspaceDiff}
                  managedWorkspace={managedWorkspace}
                  showDiffControls={showDiffControls}
                  diffPanelOpen={diffPanelOpen}
                  onToggleDiffPanel={onToggleDiffPanel}
                  onRunTerminalCommand={onRunTerminalCommand}
                  onWorkspaceToolAction={onWorkspaceToolAction}
                  onOpenCommitDialog={onOpenCommitDialog}
                  onWorkspaceBranchChange={onWorkspaceBranchChange}
                  onWorkspaceBranchCreate={onWorkspaceBranchCreate}
                  connection={connection}
                  onBootstrap={onBootstrap}
                  onOpenSandboxWorkspace={onOpenSandboxWorkspace}
                />
              </Suspense>
              <div className={`topbar-insights ${insightsScanning ? "scanning" : ""}`}>
                <button
                  type="button"
                  className="topbar-insights-button"
                  title={`${activeInsightCount} active Insights`}
                  aria-label={`${activeInsightCount} active Insights`}
                  aria-haspopup={activeInsights.length ? "menu" : undefined}
                  onClick={onOpenInsights}
                >
                  <Lightbulb size={16} />
                  <span className="topbar-insights-count">{activeInsightCount}</span>
                </button>
                {activeInsights.length ? (
                  <div className="topbar-insights-dropdown" role="menu" aria-label="Active Insights">
                    {activeInsights.map((item) => (
                      <button
                        type="button"
                        className="topbar-insights-dropdown-row"
                        key={item.id}
                        role="menuitem"
                        onClick={onOpenInsights}
                      >
                        <span className="topbar-insights-dropdown-meta">{item.severity}</span>
                        <span className="topbar-insights-dropdown-copy">
                          <strong>{item.title}</strong>
                          <span>{item.summary}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="titlebar-icon"
                title="Search chats and projects"
                aria-label="Search chats and projects"
                onClick={onOpenSearch}
              >
                <Search size={16} />
              </button>
              <button
                type="button"
                className={`titlebar-icon ${terminalOpen ? "active" : ""}`}
                title={`${terminalOpen ? "Hide" : "Show"} terminal`}
                aria-label={`${terminalOpen ? "Hide" : "Show"} terminal`}
                aria-pressed={terminalOpen}
                onClick={onToggleTerminal}
              >
                <SquareTerminal size={16} />
              </button>
              {showDiffControls && (
                <button
                  type="button"
                  className={`topbar-diff-button ${diffPanelOpen ? "active" : ""}`}
                  title={`${diffPanelOpen ? "Hide" : "Show"} changes sidebar, ${filesChanged} changed files`}
                  aria-label={`${diffPanelOpen ? "Hide" : "Show"} changes sidebar`}
                  aria-pressed={diffPanelOpen}
                  onClick={onToggleDiffPanel}
                >
                  <PanelRight size={16} />
                </button>
              )}
            </div>
          )}
          <WindowControls platform={platform} />
        </div>
      )}
    </header>
  );
}
