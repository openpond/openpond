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
import { lazy, Suspense, useEffect, useState, type MouseEvent } from "react";
import "../../styles/app-shell/topbar-insights.css";
import {
  ArrowLeft,
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
import { copyToClipboard } from "../../lib/clipboard";

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
  conversationId,
  breadcrumbs,
  backAction,
  workspaceName,
  workspaceId,
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
  rightSidebarAvailable = false,
  rightSidebarOpen = false,
  onToggleDiffPanel,
  onToggleRightSidebar,
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
  conversationId?: string | null;
  breadcrumbs?: TopBarBreadcrumb[];
  backAction?: { label: string; onSelect: () => void } | null;
  workspaceName: string | null;
  workspaceId: string | null;
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
  rightSidebarAvailable?: boolean;
  rightSidebarOpen?: boolean;
  onToggleDiffPanel: () => void;
  onToggleRightSidebar?: () => void;
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
  const showRightControls = showWorkspaceControls || rightSidebarAvailable || showWindowControls;
  const activeInsightCount = insightsSummary?.activeCount ?? 0;
  const activeInsights = insightsItems.filter((item) => item.status === "active");
  const [titleMenu, setTitleMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!titleMenu) return;
    const closeMenu = () => setTitleMenu(null);
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [titleMenu]);

  const openTitleMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 190;
    const menuHeight = conversationId ? 76 : 42;
    setTitleMenu({
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
    });
  };

  const copyTitleValue = (value: string) => {
    void copyToClipboard(value);
    setTitleMenu(null);
  };

  return (
    <header className="app-titlebar">
      <div className="titlebar-left">
        {!sidebarOpen && (
          <button className="titlebar-icon" title="Show sidebar" onClick={onShowSidebar}>
            <PanelLeft size={16} />
          </button>
        )}
        {backAction ? (
          <button className="titlebar-icon" type="button" aria-label={backAction.label} title={backAction.label} onClick={backAction.onSelect}>
            <ArrowLeft size={16} />
          </button>
        ) : null}
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
            <strong
              className="titlebar-copy-target"
              title="Double-click to select; right-click for copy options"
              onContextMenu={openTitleMenu}
            >
              {title}
            </strong>
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
                  workspaceId={workspaceId}
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
                  <span className="topbar-insights-count">
                    {activeInsightCount > 99 ? "99+" : activeInsightCount}
                  </span>
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
                  className={`topbar-diff-button ${rightSidebarOpen ? "active" : ""}`}
                  title={`${rightSidebarOpen ? "Hide" : "Show"} sidebar${filesChanged ? `, ${filesChanged} changed files` : ""}`}
                  aria-label={`${rightSidebarOpen ? "Hide" : "Show"} sidebar`}
                  aria-pressed={rightSidebarOpen}
                  onClick={onToggleDiffPanel}
                >
                  <PanelRight size={16} />
                </button>
              )}
            </div>
          )}
          {rightSidebarAvailable && onToggleRightSidebar && !showDiffControls ? (
            <div className="titlebar-actions">
              <button
                type="button"
                className={`topbar-diff-button ${rightSidebarOpen ? "active" : ""}`}
                title={`${rightSidebarOpen ? "Hide" : "Show"} sidebar`}
                aria-label={`${rightSidebarOpen ? "Hide" : "Show"} sidebar`}
                aria-pressed={rightSidebarOpen}
                onClick={onToggleRightSidebar}
              >
                <PanelRight size={16} />
              </button>
            </div>
          ) : null}
          <WindowControls platform={platform} />
        </div>
      )}
      {titleMenu && (
        <div
          className="titlebar-copy-menu"
          role="menu"
          aria-label="Conversation title actions"
          style={{ left: titleMenu.x, top: titleMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => copyTitleValue(title)}>
            Copy title
          </button>
          {conversationId && (
            <button type="button" role="menuitem" onClick={() => copyTitleValue(conversationId)}>
              Copy conversation ID
            </button>
          )}
        </div>
      )}
    </header>
  );
}
