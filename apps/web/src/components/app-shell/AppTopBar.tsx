import { WorkspaceHeaderControls } from "./WorkspaceHeaderControls";
import type {
  BootstrapPayload,
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
  PageChromeTitleTarget,
  PageChromeActionsTarget,
} from "./PageChrome";
import { ArrowLeft, ChevronRight, PanelLeft, PanelRight, Search, SquareTerminal } from "../icons";
import { WindowControls } from "./WindowControls";
import type { CommitNextStep } from "../workspace/WorkspaceGitDialogs";
import type { ClientConnection } from "../../api";

const WorkspaceEnvironmentMenu = lazy(() =>
  import("../chat/WorkspaceEnvironmentMenu").then((module) => ({
    default: module.WorkspaceEnvironmentMenu,
  })),
);

export type TopBarBreadcrumb = {
  label: string;
  onSelect?: () => void;
};

export function AppTopBar({
  sidebarOpen,
  sidebarAvailable = true,
  title,
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
  activityActorId,
  activityProjectId,
  showDiffControls,
  diffPanelOpen,
  terminalOpen,
  rightSidebarAvailable = false,
  rightSidebarOpen = false,
  onToggleDiffPanel,
  onToggleRightSidebar,
  onOpenSearch,
  onToggleTerminal,
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
}: {
  sidebarOpen: boolean;
  sidebarAvailable?: boolean;
  title: string;
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
  activityActorId?: string | null;
  activityProjectId?: string | null;
  showDiffControls: boolean;
  diffPanelOpen: boolean;
  terminalOpen: boolean;
  rightSidebarAvailable?: boolean;
  rightSidebarOpen?: boolean;
  onToggleDiffPanel: () => void;
  onToggleRightSidebar?: () => void;
  onOpenSearch: () => void;
  onToggleTerminal: () => void;
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
  onOpenSandboxWorkspace: (input: {
    sandboxId: string;
    name: string | null;
  }) => Promise<void> | void;
  onShowSidebar: () => void;
  platform?: string | null;
  showWorkspaceControls?: boolean;
}) {
  const filesChanged = workspaceDiff?.filesChanged ?? 0;

  return (
    <header className="app-titlebar">
      <div className="titlebar-left">
        {sidebarAvailable && !sidebarOpen && (
          <button className="titlebar-icon" title="Show sidebar" onClick={onShowSidebar}>
            <PanelLeft size={16} />
          </button>
        )}
        {backAction ? (
          <button
            className="titlebar-icon"
            type="button"
            aria-label={backAction.label}
            title={backAction.label}
            onClick={backAction.onSelect}
          >
            <ArrowLeft size={16} />
          </button>
        ) : null}
        <PageChromeTitleTarget>
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
              <strong>
                {title}
              </strong>
              {workspaceName && <span>{workspaceName}</span>}
            </div>
          )}
        </PageChromeTitleTarget>
      </div>
      <div className="titlebar-right">
          <PageChromeActionsTarget className="page-chrome-actions" />
          <WorkspaceHeaderControls connection={connection} teamId={defaultTeamId ?? null} actorId={activityActorId ?? null} projectId={activityProjectId ?? null}/>
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
                  title={`${rightSidebarOpen ? "Hide" : "Show"} sidebar${
                    filesChanged ? `, ${filesChanged} changed files` : ""
                  }`}
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
    </header>
  );
}
