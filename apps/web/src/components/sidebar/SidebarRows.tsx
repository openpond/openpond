import { useCallback, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { CloudProject, CloudWorkItem, LocalProject, Session, WorkspaceState } from "@openpond/contracts";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Cloud,
  EyeOff,
  Folder,
  FolderGit2,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Pin,
  PinOff,
  SquareTerminal,
  SquarePen,
  X,
} from "../icons";
import { relativeAge } from "../../lib/chat-messages";
import { cloudWorkspaceStateNote, localWorkspaceStateNote } from "../../lib/project-workflow-state";
import { CloudMoveIcon } from "../common/CloudMoveIcon";
import { ProjectKindIcon } from "../common/ProjectKindIcon";
import type { SidebarTerminalIndicator } from "../terminal/terminal-state";
import type { WorkspaceTargetValue } from "../../lib/workspace-location";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import { RenameChatDialog } from "./RenameChatDialog";

const SIDEBAR_RUNNING_PULSE_MS = 2650;
const PROJECT_LOCATIONS_POPOVER_WIDTH = 304;
const PROJECT_LOCATIONS_POPOVER_BOTTOM_RESERVE = 260;

function syncedRunningPulseStyle(): CSSProperties {
  return {
    animationDelay: `${-(Date.now() % SIDEBAR_RUNNING_PULSE_MS)}ms`,
  };
}

export function SidebarSection({
  label,
  actions,
  children,
  collapsed = false,
  titleActive = false,
  onTitleClick,
  onToggleCollapsed,
}: {
  label: string;
  actions?: ReactNode;
  children: ReactNode;
  collapsed?: boolean;
  titleActive?: boolean;
  onTitleClick?: () => void;
  onToggleCollapsed?: () => void;
}) {
  return (
    <section className="sidebar-section">
      <div className="section-header">
        {onTitleClick ? (
          <div className="section-title-combo">
            <button
              type="button"
              className={`section-title-link${titleActive ? " active" : ""}`}
              onClick={onTitleClick}
            >
              <span>{label}</span>
            </button>
            {onToggleCollapsed && (
              <button
                type="button"
                className="section-chevron-button"
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
                aria-expanded={!collapsed}
                onClick={onToggleCollapsed}
              >
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
            )}
          </div>
        ) : onToggleCollapsed ? (
          <button
            type="button"
            className="section-title-button"
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            <span>{label}</span>
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span>{label}</span>
        )}
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {!collapsed && <div className="sidebar-section-body">{children}</div>}
    </section>
  );
}

export function SidebarSectionMenu({
  id,
  open,
  archivedOpen,
  archivedLabel,
  onToggleOpen,
  onToggleArchived,
}: {
  id: string;
  open: boolean;
  archivedOpen: boolean;
  archivedLabel: string;
  onToggleOpen: () => void;
  onToggleArchived: () => void;
}) {
  const menuId = `${id}-section-menu`;
  return (
    <div className="section-menu">
      <button
        type="button"
        className={`section-icon ${open ? "active" : ""}`}
        data-tooltip="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={onToggleOpen}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="section-menu-popover" id={menuId} role="menu">
          <button type="button" role="menuitem" onClick={onToggleArchived}>
            {archivedOpen ? `Hide ${archivedLabel}` : `Show ${archivedLabel}`}
          </button>
        </div>
      )}
    </div>
  );
}

export function SidebarShowMoreButton({
  children,
  expanded = false,
  onClick,
}: {
  children?: ReactNode;
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="sidebar-show-more" onClick={onClick}>
      {children ?? (expanded ? "Show less" : "Show more")}
    </button>
  );
}

export function SidebarSessionRow({
  session,
  selected,
  icon,
  archived = false,
  hideIcon = false,
  nested = false,
  dragging,
  placeholder,
  running,
  goalRuntime,
  subagentRuntime,
  terminalIndicator,
  childSessionCount = 0,
  childSessionsExpanded = false,
  onSelect,
  onToggleChildSessions,
  onTogglePin,
  onDockRight,
  onArchive,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onRename,
}: {
  session: Session;
  selected: boolean;
  icon?: ReactNode;
  archived?: boolean;
  hideIcon?: boolean;
  nested?: boolean;
  dragging?: boolean;
  placeholder?: boolean;
  running?: boolean;
  goalRuntime?: GoalRuntimeStatus | null;
  subagentRuntime?: SubagentRuntimeStatus | null;
  terminalIndicator?: SidebarTerminalIndicator | null;
  childSessionCount?: number;
  childSessionsExpanded?: boolean;
  onSelect: () => void;
  onToggleChildSessions?: () => void;
  onTogglePin: () => void;
  onDockRight?: () => void;
  onArchive: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onRename?: (session: Session, title: string) => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const goalRunning = goalRuntime?.tone === "active";
  const subagentRunning = (subagentRuntime?.activeCount ?? 0) > 0;
  const hasChildSessions = childSessionCount > 0 && Boolean(onToggleChildSessions);
  const effectiveHideIcon = hideIcon && !hasChildSessions;
  const rowRunning = subagentRunning || goalRunning || (running ?? session.status === "active");
  const runningLabel = subagentRunning && subagentRuntime
    ? subagentRuntime.label
    : goalRunning && goalRuntime
      ? sidebarGoalRuntimeTooltip(goalRuntime)
      : "Running";
  const rowClassName = [onDockRight ? "actions-3" : "", rowRunning ? "has-running-dot" : ""]
    .filter(Boolean)
    .join(" ");
  const rowShellRef = useRef<HTMLDivElement | null>(null);
  const runningPopoverId = useId();
  const [runningPopoverStyle, setRunningPopoverStyle] = useState<ProjectLocationsPopoverStyle>({});
  const updateRunningPopoverPosition = useCallback(() => {
    if (typeof window === "undefined") return;
    const rect = rowShellRef.current?.getBoundingClientRect();
    if (!rect) return;

    const maxLeft = Math.max(12, window.innerWidth - PROJECT_LOCATIONS_POPOVER_WIDTH - 12);
    const maxTop = Math.max(12, window.innerHeight - PROJECT_LOCATIONS_POPOVER_BOTTOM_RESERVE);
    const left = Math.max(12, Math.min(rect.right + 10, maxLeft));
    const top = Math.max(12, Math.min(rect.top - 4, maxTop));
    const nextStyle: ProjectLocationsPopoverStyle = {
      "--sidebar-project-locations-left": `${Math.round(left)}px`,
      "--sidebar-project-locations-top": `${Math.round(top)}px`,
    };

    setRunningPopoverStyle((current) => {
      if (
        current["--sidebar-project-locations-left"] === nextStyle["--sidebar-project-locations-left"] &&
        current["--sidebar-project-locations-top"] === nextStyle["--sidebar-project-locations-top"]
      ) {
        return current;
      }
      return nextStyle;
    });
  }, []);
  const runningDotStyle = useMemo(syncedRunningPulseStyle, []);
  const row = (
    <SidebarInteractiveRow
      selected={selected}
      dataSessionId={session.id}
      dragging={dragging}
      iconless={effectiveHideIcon}
      nested={nested}
      placeholder={placeholder}
      className={rowClassName || undefined}
      ariaExpanded={hasChildSessions ? childSessionsExpanded : undefined}
      ariaDescribedBy={rowRunning ? runningPopoverId : undefined}
      onSelect={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDoubleClick={onRename ? () => setRenameOpen(true) : undefined}
    >
      {effectiveHideIcon ? null : hasChildSessions ? (
        <button
          type="button"
          className="sidebar-child-toggle"
          data-tooltip={childSessionsExpanded ? "Hide subagent conversations" : "Show subagent conversations"}
          aria-label={`${childSessionsExpanded ? "Hide" : "Show"} ${childSessionCount} subagent ${
            childSessionCount === 1 ? "conversation" : "conversations"
          }`}
          aria-expanded={childSessionsExpanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggleChildSessions?.();
          }}
        >
          {childSessionsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      ) : (
        icon ?? <MessageSquare size={15} />
      )}
      <span className="row-label-shell">
        <span className="row-label">{session.title}</span>
      </span>
      <div className="row-meta">
        <span className="row-meta-status">
          {terminalIndicator ? <SidebarTerminalStatusIcon indicator={terminalIndicator} /> : null}
          {rowRunning ? (
            <span
              className={`sidebar-running-dot${subagentRunning ? " subagent" : goalRunning ? " goal" : ""}`}
              style={runningDotStyle}
              aria-label={runningLabel}
            />
          ) : (
            <time>{relativeAge(session.updatedAt)}</time>
          )}
        </span>
        <div className="sidebar-row-actions">
          <SidebarRowAction label={session.pinned ? "Unpin chat" : "Pin chat"} onClick={onTogglePin}>
            {session.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </SidebarRowAction>
          {onDockRight ? (
            <SidebarRowAction label="Open in right panel" onClick={onDockRight}>
              <PanelRight size={13} />
            </SidebarRowAction>
          ) : null}
          <SidebarRowAction label={archived ? "Restore chat" : "Archive chat"} onClick={onArchive}>
            {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </SidebarRowAction>
        </div>
      </div>
    </SidebarInteractiveRow>
);

  const renameDialog = renameOpen && onRename ? (
    <RenameChatDialog
      session={session}
      onSave={(title) => onRename(session, title)}
      onClose={() => setRenameOpen(false)}
    />
  ) : null;

  if (!rowRunning) return (<>{row}{renameDialog}</>);

  return (
    <div
      ref={rowShellRef}
      className="sidebar-session-row-shell"
      onFocusCapture={updateRunningPopoverPosition}
      onPointerEnter={updateRunningPopoverPosition}
    >
      {row}
      {renameDialog}
      <SidebarSessionRunningPopover
        goalRuntime={!subagentRunning && goalRunning ? goalRuntime ?? null : null}
        id={runningPopoverId}
        label={runningLabel}
        style={runningPopoverStyle}
        subagentRuntime={subagentRunning ? subagentRuntime ?? null : null}
      />
    </div>
  );
}

function sidebarGoalRuntimeTooltip(goalRuntime: GoalRuntimeStatus): string {
  return goalRuntime.actionLabel;
}

function SidebarSessionRunningPopover({
  goalRuntime,
  id,
  label,
  style,
  subagentRuntime,
}: {
  goalRuntime: GoalRuntimeStatus | null;
  id: string;
  label: string;
  style?: ProjectLocationsPopoverStyle;
  subagentRuntime: SubagentRuntimeStatus | null;
}) {
  const objective = clampGoalObjectiveLines(
    subagentRuntime
      ? subagentRuntime.tooltip
      : goalRuntime?.objective.trim() || "Response in progress",
    5,
  );
  const detail = subagentRuntime
    ? subagentPopoverDetail(subagentRuntime)
    : goalRuntime
      ? `${goalRuntime.timeLabel} · ${goalRuntime.detail}`
      : "Chat response running";
  const rowKind = subagentRuntime ? "subagent" : goalRuntime ? "goal" : "running";
  return (
    <aside
      className="sidebar-project-locations-popover sidebar-session-running-popover"
      id={id}
      role="tooltip"
      aria-label={label}
      style={style}
    >
      <div className="sidebar-project-locations-title">{label}</div>
      <div className="sidebar-project-location-list">
        <div className={`sidebar-project-location-row ${rowKind}`}>
          <span className="sidebar-project-location-icon running" aria-hidden="true">
            <span className={`sidebar-running-popover-dot${subagentRuntime ? " subagent" : goalRuntime ? " goal" : ""}`} />
          </span>
          <span className="sidebar-project-location-copy">
            <span className="sidebar-session-running-objective">{objective}</span>
            <span className="sidebar-session-running-detail">{detail}</span>
          </span>
        </div>
      </div>
    </aside>
  );
}

function subagentPopoverDetail(runtime: SubagentRuntimeStatus): string {
  const parts = [
    runtime.activeCount > 0 ? `${runtime.activeCount} active` : null,
    runtime.blockedCount > 0 ? `${runtime.blockedCount} blocked` : null,
    runtime.completedCount > 0 ? `${runtime.completedCount} completed` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Subagent receipts available";
}

function clampGoalObjectiveLines(value: string, maxLines: number): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length <= maxLines) return value;
  return `${lines.slice(0, maxLines).join("\n")}\n...`;
}

export function SidebarProjectRow({
  kind = "local",
  project,
  pinned = false,
  selected,
  expanded = false,
  workspaceState,
  cloudWorkItems = [],
  cloudLinkTrusted = true,
  cloudLinkWarning = null,
  placeholder,
  terminalIndicator,
  onSelect,
  onNewChat,
  onMoveToCloud,
  onWorkspaceTargetSelect,
  onToggleSystemVisibility,
  onTogglePin,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  kind?: "local" | "cloud";
  project: LocalProject | CloudProject;
  pinned?: boolean;
  selected: boolean;
  expanded?: boolean;
  workspaceState?: WorkspaceState | null;
  cloudWorkItems?: CloudWorkItem[];
  cloudLinkTrusted?: boolean;
  cloudLinkWarning?: string | null;
  placeholder?: boolean;
  terminalIndicator?: SidebarTerminalIndicator | null;
  onSelect: () => void;
  onNewChat: () => void;
  onMoveToCloud?: () => void;
  onWorkspaceTargetSelect?: (target: WorkspaceTargetValue) => void;
  onToggleSystemVisibility?: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rowShellRef = useRef<HTMLDivElement | null>(null);
  const [locationsStyle, setLocationsStyle] = useState<ProjectLocationsPopoverStyle>({});
  const hasMenuActions = Boolean(onMoveToCloud) || Boolean(onToggleSystemVisibility) || Boolean(onRemove);
  const linkedCloud =
    kind === "local" && cloudLinkTrusted !== false && Boolean((project as LocalProject).linkedSandboxProject?.projectId);
  const updateLocationsPosition = useCallback(() => {
    if (typeof window === "undefined") return;
    const rect = rowShellRef.current?.getBoundingClientRect();
    if (!rect) return;

    const maxLeft = Math.max(12, window.innerWidth - PROJECT_LOCATIONS_POPOVER_WIDTH - 12);
    const maxTop = Math.max(12, window.innerHeight - PROJECT_LOCATIONS_POPOVER_BOTTOM_RESERVE);
    const left = Math.max(12, Math.min(rect.right + 10, maxLeft));
    const top = Math.max(12, Math.min(rect.top - 4, maxTop));
    const nextStyle: ProjectLocationsPopoverStyle = {
      "--sidebar-project-locations-left": `${Math.round(left)}px`,
      "--sidebar-project-locations-top": `${Math.round(top)}px`,
    };

    setLocationsStyle((current) => {
      if (
        current["--sidebar-project-locations-left"] === nextStyle["--sidebar-project-locations-left"] &&
        current["--sidebar-project-locations-top"] === nextStyle["--sidebar-project-locations-top"]
      ) {
        return current;
      }
      return nextStyle;
    });
  }, []);
  const handleSelect = useCallback(() => {
    updateLocationsPosition();
    onSelect();
  }, [onSelect, updateLocationsPosition]);

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <div
      ref={rowShellRef}
      className={["sidebar-project-row-shell", menuOpen ? "project-menu-open" : ""].filter(Boolean).join(" ")}
      onFocusCapture={updateLocationsPosition}
      onPointerEnter={updateLocationsPosition}
    >
      <SidebarInteractiveRow
        selected={selected}
        placeholder={placeholder}
        className={["sidebar-project-row", menuOpen ? "project-menu-open" : ""].filter(Boolean).join(" ")}
        ariaExpanded={expanded}
        onSelect={handleSelect}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <ProjectKindIcon
          kind={kind}
          agentSdk={Boolean(project.agentSdk?.detected)}
          linkedCloud={linkedCloud}
          open={kind === "local" && expanded}
          className="sidebar-row-icon"
          baseSize={15}
        />
        <span className="row-label-shell">
          <span className="row-label">{project.name}</span>
          <span className="sidebar-project-caret" aria-hidden="true">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </span>
        <div className="row-meta">
          <span className="row-meta-status">
            {terminalIndicator ? <SidebarTerminalStatusIcon indicator={terminalIndicator} /> : null}
          </span>
          <div className="sidebar-row-actions">
            <SidebarRowAction label={pinned ? "Unpin project" : "Pin project"} onClick={onTogglePin}>
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </SidebarRowAction>
            {hasMenuActions && (
              <SidebarProjectMoreButton
                open={menuOpen}
                onToggleOpen={() => setMenuOpen((open) => !open)}
              />
            )}
            <SidebarRowAction label="New chat" onClick={onNewChat}>
              <SquarePen size={13} />
            </SidebarRowAction>
          </div>
        </div>
      </SidebarInteractiveRow>
      <SidebarProjectLocationsPopover
        kind={kind}
        project={project}
        workspaceState={workspaceState}
        cloudWorkItems={cloudWorkItems}
        cloudLinkTrusted={cloudLinkTrusted}
        cloudLinkWarning={cloudLinkWarning}
        onWorkspaceTargetSelect={onWorkspaceTargetSelect}
        style={locationsStyle}
      />
      {menuOpen && (
        <SidebarProjectMenuPopover
          onClose={closeMenu}
          onMoveToCloud={onMoveToCloud ? () => {
            closeMenu();
            onMoveToCloud();
          } : undefined}
          onToggleSystemVisibility={onToggleSystemVisibility ? () => {
            closeMenu();
            onToggleSystemVisibility();
          } : undefined}
          systemHidden={Boolean("hiddenFromDefaultSidebar" in project && project.hiddenFromDefaultSidebar)}
          onRemove={() => {
            closeMenu();
            onRemove();
          }}
        />
      )}
    </div>
  );
}

export function SidebarCloudWorkItemRow({
  workItem,
  selected,
  hideIcon = false,
  nested = false,
  onSelect,
}: {
  workItem: CloudWorkItem;
  selected: boolean;
  hideIcon?: boolean;
  nested?: boolean;
  onSelect: () => void;
}) {
  const running = workItem.status === "queued" || workItem.status === "running";
  const runningDotStyle = useMemo(syncedRunningPulseStyle, []);
  return (
    <SidebarInteractiveRow selected={selected} iconless={hideIcon} nested={nested} onSelect={onSelect}>
      {hideIcon ? null : (
        <span className="sidebar-row-icon cloud" aria-hidden="true">
          <Cloud size={15} />
        </span>
      )}
      <span className="row-label-shell">
        <span className="row-label">{workItem.title}</span>
        <span className="row-label-detail">{cloudWorkItemDetailNote(workItem)}</span>
      </span>
      <div className="row-meta">
        {running ? (
          <span className="sidebar-running-dot" style={runningDotStyle} data-tooltip={workItem.status} aria-label={workItem.status} />
        ) : (
          <time>{cloudWorkItemMeta(workItem)}</time>
        )}
      </div>
    </SidebarInteractiveRow>
  );
}

function SidebarTerminalStatusIcon({ indicator }: { indicator: SidebarTerminalIndicator }) {
  return (
    <span
      className={`sidebar-terminal-indicator ${indicator.status}`}
      data-tooltip={indicator.label}
      aria-label={indicator.label}
      title={indicator.label}
    >
      <SquareTerminal size={13} />
    </span>
  );
}

function cloudWorkItemMeta(workItem: CloudWorkItem): string {
  if (workItem.status === "needs_review") return "Review";
  if (workItem.status === "failed") return "Failed";
  if (workItem.status === "cancelled") return "Cancelled";
  return relativeAge(workItem.updatedAt);
}

function cloudWorkItemDetailNote(workItem: CloudWorkItem): string {
  const parts = [statusLabelForSidebar(workItem.status)];
  if (workItem.sourceRef) parts.push(workItem.sourceRef);
  if (workItem.latestSandboxId) parts.push("sandbox ready");
  if (workItem.latestTaskRunId && (workItem.status === "queued" || workItem.status === "running")) {
    parts.push("task running");
  }
  if (workItem.status === "needs_review") parts.push("patch ready");
  if (workItem.status === "failed") parts.push("open logs");
  return parts.join(" / ");
}

function statusLabelForSidebar(status: CloudWorkItem["status"]): string {
  if (status === "needs_review") return "review";
  return status.replace(/_/g, " ");
}

type ProjectLocationRow = {
  key: string;
  value: string;
  tone?: "local" | "cloud" | "attention" | "running";
  icon: ReactNode;
  actionTarget?: WorkspaceTargetValue;
  disabled?: boolean;
  disabledReason?: string | null;
};

type ProjectLocationsPopoverStyle = CSSProperties & {
  "--sidebar-project-locations-left"?: string;
  "--sidebar-project-locations-top"?: string;
};

function SidebarProjectLocationsPopover({
  kind,
  project,
  workspaceState,
  cloudWorkItems,
  cloudLinkTrusted,
  cloudLinkWarning,
  onWorkspaceTargetSelect,
  style,
}: {
  kind: "local" | "cloud";
  project: LocalProject | CloudProject;
  workspaceState?: WorkspaceState | null;
  cloudWorkItems?: CloudWorkItem[];
  cloudLinkTrusted?: boolean;
  cloudLinkWarning?: string | null;
  onWorkspaceTargetSelect?: (target: WorkspaceTargetValue) => void;
  style?: ProjectLocationsPopoverStyle;
}) {
  const rows = projectLocationRows(
    kind,
    project,
    workspaceState,
    cloudWorkItems ?? [],
    cloudLinkTrusted,
    cloudLinkWarning,
  );
  return (
    <aside className="sidebar-project-locations-popover" aria-label={`${project.name} status`} style={style}>
      <div className="sidebar-project-locations-title">{project.name}</div>
      <div className="sidebar-project-location-list">
        {rows.map((row) => {
          const className = [
            "sidebar-project-location-row",
            row.tone ?? "",
            row.actionTarget ? "clickable" : "",
          ].filter(Boolean).join(" ");
          const content = (
            <>
              <span className={["sidebar-project-location-icon", row.key].filter(Boolean).join(" ")} aria-hidden="true">
                {row.icon}
              </span>
              <span className="sidebar-project-location-copy">
                <ProjectLocationValue value={row.value} />
              </span>
            </>
          );

          if (row.actionTarget) {
            return (
              <button
                key={row.key}
                type="button"
                className={className}
                data-workspace-target={row.actionTarget}
                disabled={row.disabled || !onWorkspaceTargetSelect}
                title={row.disabledReason ?? undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  if (row.disabled) return;
                  onWorkspaceTargetSelect?.(row.actionTarget!);
                }}
              >
                {content}
              </button>
            );
          }

          return (
            <div key={row.key} className={className}>
              {content}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function ProjectLocationValue({ value }: { value: string }) {
  const parts = splitProjectLocationValue(value);
  return (
    <span className="sidebar-project-location-value" aria-label={value}>
      {parts.branch ? (
        <>
          <span className="sidebar-project-location-branch">{parts.branch}</span>
          <span className="sidebar-project-location-separator" aria-hidden="true">
            /
          </span>
        </>
      ) : null}
      <span className="sidebar-project-location-status">{parts.status}</span>
    </span>
  );
}

function splitProjectLocationValue(value: string): { branch: string | null; status: string } {
  const separator = " / ";
  const separatorIndex = value.indexOf(separator);
  if (separatorIndex === -1) return { branch: null, status: value };
  return {
    branch: value.slice(0, separatorIndex),
    status: value.slice(separatorIndex + separator.length),
  };
}

function projectLocationRows(
  kind: "local" | "cloud",
  project: LocalProject | CloudProject,
  workspaceState?: WorkspaceState | null,
  cloudWorkItems: CloudWorkItem[] = [],
  cloudLinkTrusted: boolean = true,
  cloudLinkWarning: string | null = null,
): ProjectLocationRow[] {
  if (kind === "cloud") return cloudProjectLocationRows(project as CloudProject, cloudWorkItems);
  return localProjectLocationRows(project as LocalProject, workspaceState, cloudWorkItems, cloudLinkTrusted, cloudLinkWarning);
}

function localProjectLocationRows(
  project: LocalProject,
  workspaceState?: WorkspaceState | null,
  cloudWorkItems: CloudWorkItem[] = [],
  cloudLinkTrusted: boolean = true,
  cloudLinkWarning: string | null = null,
): ProjectLocationRow[] {
  const localRepoNote = localRepoStatusNote(project, workspaceState, cloudLinkTrusted);
  const localAttention = workspaceHasUnstagedChanges(workspaceState);
  const cloudStatus = cloudWorkItemsStatus(cloudWorkItems);
  const cloudLinked = localProjectHasCloud(project, cloudLinkTrusted);
  const cloudWarning = cloudLinkTrusted === false && cloudLinkWarning;
  return [
    {
      key: "local",
      value: localRepoNote,
      tone: localAttention ? "attention" : "local",
      icon: project.source === "git" ? <FolderGit2 size={13} /> : <Folder size={13} />,
      actionTarget: "local",
    },
    {
      key: "cloud",
      value: cloudWarning
        ? cloudWarning
        : cloudLinked
          ? cloudProjectStatusValue(project, workspaceState, cloudStatus, cloudLinkTrusted)
          : "not in cloud",
      tone: cloudWarning ? "attention" : cloudStatus?.tone ?? "cloud",
      icon: <Cloud size={13} />,
      actionTarget: cloudLinked ? "cloud" : "upload_cloud",
    },
  ];
}

function cloudProjectLocationRows(project: CloudProject, cloudWorkItems: CloudWorkItem[] = []): ProjectLocationRow[] {
  const cloudStatus = cloudWorkItemsStatus(cloudWorkItems);
  return [
    {
      key: "cloud",
      value: cloudProjectRowStatusValue(project, cloudStatus),
      tone: cloudStatus?.tone ?? (project.syncedAt ? "cloud" : "attention"),
      icon: <Cloud size={13} />,
      actionTarget: "cloud",
    },
  ];
}

function localRepoStatusNote(
  project: LocalProject,
  state: WorkspaceState | null | undefined,
  cloudLinkTrusted: boolean,
): string {
  const fallbackBranch = localProjectBranch(project, state);
  if (!state) return `${fallbackBranch} / available`;
  if (state.error) return `${fallbackBranch} / status unavailable`;
  if (!state.initialized) return `${fallbackBranch} / not checked out`;
  return localWorkspaceStateNote(state, {
    branch: project.linkedSandboxProject?.defaultBranch ?? null,
    linkedCloudSourceKnown: project.linkedSandboxProject?.projectId && cloudLinkTrusted
      ? Boolean(project.linkedSandboxProject.lastUploadedCommit) || !state.headCommit
      : true,
  });
}

function workspaceHasUnstagedChanges(state: WorkspaceState | null | undefined): boolean {
  return Boolean(state?.dirty || (state?.changedFilesCount ?? 0) > 0 || (state?.untrackedFilesCount ?? 0) > 0);
}

function localProjectBranch(project: LocalProject, state: WorkspaceState | null | undefined): string {
  return state?.currentBranch ?? state?.defaultBranch ?? project.linkedSandboxProject?.defaultBranch ?? "local";
}

function localProjectHasCloud(project: LocalProject, cloudLinkTrusted: boolean = true): boolean {
  return Boolean(
    (cloudLinkTrusted && project.linkedSandboxProject?.projectId) ||
      project.linkedOpenPondApp?.appId,
  );
}

function cloudProjectStatusValue(
  project: LocalProject,
  workspaceState: WorkspaceState | null | undefined,
  workItemStatus: CloudWorkItemsStatus | null,
  cloudLinkTrusted: boolean,
): string {
  const branch = project.linkedSandboxProject?.defaultBranch ?? workspaceState?.defaultBranch ?? "main";
  if (workItemStatus) return `${branch} / ${workItemStatus.value}`;
  return cloudWorkspaceStateNote(project, null, workspaceState, { cloudLinkTrusted });
}

function cloudProjectRowStatusValue(project: CloudProject, workItemStatus: CloudWorkItemsStatus | null): string {
  const branch = project.defaultBranch ?? "main";
  const status = workItemStatus?.value ?? (project.syncedAt ? "setup ready" : "needs setup");
  return `${branch} / ${status}`;
}

type CloudWorkItemsStatus = {
  value: string;
  tone: "running" | "attention" | "cloud";
};

function cloudWorkItemsStatus(workItems: CloudWorkItem[]): CloudWorkItemsStatus | null {
  const active = workItems.filter((item) => item.status === "queued" || item.status === "running");
  if (active.length > 0) {
    const running = active.filter((item) => item.status === "running").length;
    const queued = active.length - running;
    const value = running > 0
      ? `${running} running${queued > 0 ? ` / ${queued} queued` : ""}`
      : `${queued} queued`;
    return { value, tone: "running" };
  }

  const review = workItems.find((item) => item.status === "needs_review");
  if (review) return { value: "review ready", tone: "attention" };

  const failed = workItems.find((item) => item.status === "failed");
  if (failed) return { value: "cloud work failed", tone: "attention" };

  return null;
}

function SidebarProjectMoreButton({
  open,
  onToggleOpen,
}: {
  open: boolean;
  onToggleOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar-row-action ${open ? "active" : ""}`}
      data-tooltip="More project actions"
      aria-label="More project actions"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation();
        onToggleOpen();
      }}
    >
      <MoreHorizontal size={13} />
    </button>
  );
}

function SidebarProjectMenuPopover({
  onClose,
  onMoveToCloud,
  onToggleSystemVisibility,
  systemHidden,
  onRemove,
}: {
  onClose: () => void;
  onMoveToCloud?: () => void;
  onToggleSystemVisibility?: () => void;
  systemHidden: boolean;
  onRemove: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="sidebar-project-menu-backdrop"
        aria-label="Close project actions"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      />
      <div className="section-menu-popover sidebar-project-row-popover" role="menu">
        {onMoveToCloud && (
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              onMoveToCloud();
            }}
          >
            <CloudMoveIcon size={13} />
            <span>Move to Cloud</span>
          </button>
        )}
        {onToggleSystemVisibility && (
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              onToggleSystemVisibility();
            }}
          >
            <EyeOff size={13} />
            <span>{systemHidden ? "Show in Local Projects" : "Hide from Local Projects"}</span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={13} />
          <span>Remove from Projects</span>
        </button>
      </div>
    </>
  );
}

function SidebarInteractiveRow({
  children,
  className,
  dataSessionId,
  dragging,
  iconless = false,
  nested = false,
  placeholder = false,
  selected,
  ariaExpanded,
  ariaDescribedBy,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onDoubleClick,
}: {
  children: ReactNode;
  className?: string;
  dataSessionId?: string;
  dragging?: boolean;
  iconless?: boolean;
  nested?: boolean;
  placeholder?: boolean;
  selected: boolean;
  ariaExpanded?: boolean;
  ariaDescribedBy?: string;
  onSelect: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}) {
  const draggable = Boolean(onDragStart);
  return (
    <div
      className={[
        "sidebar-row",
        className ?? "",
        selected ? "selected" : "",
        dragging ? "dragging" : "",
        iconless ? "iconless" : "",
        nested ? "nested" : "",
        placeholder ? "placeholder" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={draggable}
      data-session-id={dataSessionId}
      role="button"
      tabIndex={0}
      aria-expanded={ariaExpanded}
      aria-describedby={ariaDescribedBy}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragEnter={(event) => {
        if (!onDragOver) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOver(event);
      }}
      onDragOver={(event) => {
        if (!onDragOver) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOver(event);
      }}
      onDrop={(event) => {
        if (!onDrop) return;
        event.preventDefault();
        onDrop(event);
      }}
    >
      {children}
    </div>
  );
}

function SidebarRowAction({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="sidebar-row-action"
      data-tooltip={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
