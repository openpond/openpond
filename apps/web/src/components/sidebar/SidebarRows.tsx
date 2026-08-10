import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  CloudProject,
  LocalProject,
  Session,
  SidebarFileBookmark,
  WorkspaceState,
} from "@openpond/contracts";
import {
  ArchiveRestore,
  Bookmark,
  BookmarkX,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CircleAlert,
  Folder,
  FolderGit2,
  FileText,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Pin,
  PinOff,
  SquareTerminal,
  SquarePen,
  X,
} from "../icons";
import {
  cloudWorkspaceStateNote,
  localWorkspaceStateNote,
} from "../../lib/project-workflow-state";
import { CloudMoveIcon } from "../common/CloudMoveIcon";
import { ProjectKindIcon } from "../common/ProjectKindIcon";
import type { SidebarTerminalIndicator } from "../terminal/terminal-state";
import type { WorkspaceTargetValue } from "../../lib/workspace-location";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import { RenameChatDialog } from "./RenameChatDialog";
import { isTaskDraftSession } from "../../lib/task-drafts";

const SIDEBAR_RUNNING_PULSE_MS = 2650;
const PROJECT_LOCATIONS_POPOVER_WIDTH = 304;
const PROJECT_LOCATIONS_POPOVER_BOTTOM_RESERVE = 260;
const sidebarUpdatedDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const sidebarUpdatedTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});
const sidebarUpdatedDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function syncedRunningPulseStyle(): CSSProperties {
  return {
    animationDelay: `${-(Date.now() % SIDEBAR_RUNNING_PULSE_MS)}ms`,
  };
}

function prepareSidebarTitleTicker(event: ReactPointerEvent<HTMLSpanElement>) {
  const viewport = event.currentTarget;
  const title = viewport.firstElementChild;
  if (!(title instanceof HTMLElement)) return;
  const overflow = Math.max(0, title.scrollWidth - viewport.clientWidth);
  const overflowing = overflow > 2;
  viewport.dataset.overflowing = String(overflowing);
  viewport.style.setProperty(
    "--sidebar-title-ticker-distance",
    `${-overflow}px`,
  );
  viewport.style.setProperty(
    "--sidebar-title-ticker-duration",
    `${Math.min(6.5, Math.max(2.8, overflow / 42 + 2.4))}s`,
  );
}

export function SidebarSection({
  label,
  actions,
  actionsVisible = false,
  className,
  titleAccessory,
  children,
  collapsed = false,
  titleActive = false,
  onTitleClick,
  onToggleCollapsed,
}: {
  label: string;
  actions?: ReactNode;
  actionsVisible?: boolean;
  className?: string;
  titleAccessory?: ReactNode;
  children: ReactNode;
  collapsed?: boolean;
  titleActive?: boolean;
  onTitleClick?: () => void;
  onToggleCollapsed?: () => void;
}) {
  return (
    <section
      className={[
        "sidebar-section",
        className,
        actionsVisible ? "actions-visible" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="section-header">
        <div className="section-title-row">
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
                  {collapsed ? (
                    <ChevronRight size={13} />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                </button>
              )}
            </div>
          ) : onToggleCollapsed ? (
            <button
              type="button"
              className="section-title-button"
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              <span>{label}</span>
              {collapsed ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}
            </button>
          ) : (
            <span>{label}</span>
          )}
          {titleAccessory}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {!collapsed && <div className="sidebar-section-body">{children}</div>}
    </section>
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
  projectLabel,
  childSessionCount = 0,
  childSessionsExpanded = false,
  onSelect,
  onToggleChildSessions,
  onTogglePin,
  onToggleSaveForLater,
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
  projectLabel?: string | null;
  childSessionCount?: number;
  childSessionsExpanded?: boolean;
  onSelect: () => void;
  onToggleChildSessions?: () => void;
  onTogglePin: () => void;
  onToggleSaveForLater?: () => void;
  onDockRight?: () => void;
  onArchive: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onRename?: (session: Session, title: string) => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const goalQueued = goalRuntime?.status === "queued";
  const goalRunning = goalRuntime?.tone === "active" && !goalQueued;
  const subagentRunning = (subagentRuntime?.activeCount ?? 0) > 0;
  const hasChildSessions =
    childSessionCount > 0 && Boolean(onToggleChildSessions);
  const effectiveHideIcon = hideIcon && !hasChildSessions;
  const rowRunning =
    subagentRunning ||
    goalRunning ||
    (!goalQueued && (running ?? session.status === "active"));
  const runningLabel =
    subagentRunning && subagentRuntime
      ? subagentRuntime.label
      : goalRunning && goalRuntime
      ? sidebarGoalRuntimeTooltip(goalRuntime)
      : "Running";
  const rowClassName = [
    "sidebar-task-row",
    isTaskDraftSession(session) ? "is-draft" : "",
    onDockRight ? "actions-4" : onToggleSaveForLater ? "actions-3" : "",
    rowRunning ? "has-running-dot" : "",
    projectLabel ? "has-project-detail" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const runningDotStyle = useMemo(syncedRunningPulseStyle, []);
  const taskActions = (
    <div
      className={`sidebar-row-actions${
        projectLabel ? " sidebar-task-inline-actions" : ""
      }`}
    >
      {onDockRight ? (
        <SidebarRowAction label="Open in right panel" onClick={onDockRight}>
          <PanelRight size={13} />
        </SidebarRowAction>
      ) : null}
      <SidebarRowAction
        label={session.pinned ? "Unpin chat" : "Pin chat"}
        onClick={onTogglePin}
      >
        {session.pinned ? <PinOff size={13} /> : <Pin size={13} />}
      </SidebarRowAction>
      {onToggleSaveForLater ? (
        <SidebarRowAction
          label={session.savedForLater ? "Return to active" : "Save for later"}
          onClick={onToggleSaveForLater}
        >
          {session.savedForLater ? (
            <BookmarkX size={13} />
          ) : (
            <Bookmark size={13} />
          )}
        </SidebarRowAction>
      ) : null}
      <SidebarRowAction
        label={archived ? "Reopen" : "Mark done"}
        onClick={onArchive}
      >
        {archived ? <ArchiveRestore size={13} /> : <Check size={13} />}
      </SidebarRowAction>
    </div>
  );
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
          data-tooltip={
            childSessionsExpanded
              ? "Hide subagent conversations"
              : "Show subagent conversations"
          }
          aria-label={`${
            childSessionsExpanded ? "Hide" : "Show"
          } ${childSessionCount} subagent ${
            childSessionCount === 1 ? "conversation" : "conversations"
          }`}
          aria-expanded={childSessionsExpanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggleChildSessions?.();
          }}
        >
          {childSessionsExpanded ? (
            <ChevronDown size={13} />
          ) : (
            <ChevronRight size={13} />
          )}
        </button>
      ) : (
        icon ?? <MessageSquare size={15} />
      )}
      <span
        className={`row-label-shell${projectLabel ? " has-detail" : ""}`}
      >
        <span className="sidebar-session-title-line">
          <span
            className="row-label sidebar-task-title"
            data-overflowing="false"
            onPointerEnter={prepareSidebarTitleTicker}
          >
            <span className="sidebar-task-title-text">{session.title}</span>
          </span>
          {projectLabel ? null : <SidebarUpdatedAt value={session.updatedAt} />}
        </span>
        {projectLabel ? (
          <span className="sidebar-session-detail-line">
            <span className="sidebar-session-project-label">{projectLabel}</span>
            {taskActions}
            <SidebarUpdatedAt value={session.updatedAt} />
          </span>
        ) : null}
      </span>
      <div className="row-meta">
        <span className="row-meta-status">
          {terminalIndicator ? (
            <SidebarTerminalStatusIcon indicator={terminalIndicator} />
          ) : null}
          {rowRunning ? (
            <span
              className={`sidebar-running-dot${
                subagentRunning ? " subagent" : goalRunning ? " goal" : ""
              }`}
              style={runningDotStyle}
              aria-label={runningLabel}
            />
          ) : null}
        </span>
        {projectLabel ? null : taskActions}
      </div>
    </SidebarInteractiveRow>
  );

  const renameDialog =
    renameOpen && onRename ? (
      <RenameChatDialog
        session={session}
        onSave={(title) => onRename(session, title)}
        onClose={() => setRenameOpen(false)}
      />
    ) : null;

  return (
    <>
      {row}
      {renameDialog}
    </>
  );
}

export function SidebarFileRow({
  file,
  selected = false,
  placeholder,
  onSelect,
  onTogglePin,
  onToggleSaveForLater,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  file: SidebarFileBookmark;
  selected?: boolean;
  placeholder?: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onToggleSaveForLater: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const filename = file.path.split("/").at(-1) ?? file.path;
  const location = `${file.workspaceName} · ${file.path}`;
  return (
    <SidebarInteractiveRow
      selected={selected}
      placeholder={placeholder}
      className={`sidebar-file-row actions-2${
        file.available ? "" : " unavailable"
      }`}
      onSelect={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {file.available ? <FileText size={15} /> : <CircleAlert size={15} />}
      <span className="row-label-shell" title={location}>
        <span className="row-label">{filename}</span>
      </span>
      <div className="row-meta">
        <div className="sidebar-row-actions">
          <SidebarRowAction
            label={file.status === "pinned" ? "Unpin file" : "Pin file"}
            onClick={onTogglePin}
          >
            {file.status === "pinned" ? (
              <PinOff size={13} />
            ) : (
              <Pin size={13} />
            )}
          </SidebarRowAction>
          <SidebarRowAction
            label={
              file.status === "saved_for_later"
                ? "Remove from Save for later"
                : "Save file for later"
            }
            onClick={onToggleSaveForLater}
          >
            {file.status === "saved_for_later" ? (
              <BookmarkX size={13} />
            ) : (
              <Bookmark size={13} />
            )}
          </SidebarRowAction>
        </div>
      </div>
    </SidebarInteractiveRow>
  );
}

function sidebarGoalRuntimeTooltip(goalRuntime: GoalRuntimeStatus): string {
  return goalRuntime.actionLabel;
}

export function SidebarProjectRow({
  kind = "local",
  project,
  pinned = false,
  selected,
  expanded = false,
  disclosure = true,
  workspaceState,
  cloudLinkTrusted = true,
  cloudLinkWarning = null,
  placeholder,
  terminalIndicator,
  onSelect,
  onNewChat,
  onMoveToCloud,
  onWorkspaceTargetSelect,
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
  disclosure?: boolean;
  workspaceState?: WorkspaceState | null;
  cloudLinkTrusted?: boolean;
  cloudLinkWarning?: string | null;
  placeholder?: boolean;
  terminalIndicator?: SidebarTerminalIndicator | null;
  onSelect: () => void;
  onNewChat: () => void;
  onMoveToCloud?: () => void;
  onWorkspaceTargetSelect?: (target: WorkspaceTargetValue) => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rowShellRef = useRef<HTMLDivElement | null>(null);
  const [locationsStyle, setLocationsStyle] =
    useState<ProjectLocationsPopoverStyle>({});
  const hasMenuActions = Boolean(onMoveToCloud) || Boolean(onRemove);
  const linkedCloud =
    kind === "local" &&
    cloudLinkTrusted !== false &&
    Boolean((project as LocalProject).linkedSandboxProject?.projectId);
  const updateLocationsPosition = useCallback(() => {
    if (typeof window === "undefined") return;
    const rect = rowShellRef.current?.getBoundingClientRect();
    if (!rect) return;

    const maxLeft = Math.max(
      12,
      window.innerWidth - PROJECT_LOCATIONS_POPOVER_WIDTH - 12
    );
    const maxTop = Math.max(
      12,
      window.innerHeight - PROJECT_LOCATIONS_POPOVER_BOTTOM_RESERVE
    );
    const left = Math.max(12, Math.min(rect.right + 10, maxLeft));
    const top = Math.max(12, Math.min(rect.top - 4, maxTop));
    const nextStyle: ProjectLocationsPopoverStyle = {
      "--sidebar-project-locations-left": `${Math.round(left)}px`,
      "--sidebar-project-locations-top": `${Math.round(top)}px`,
    };

    setLocationsStyle((current) => {
      if (
        current["--sidebar-project-locations-left"] ===
          nextStyle["--sidebar-project-locations-left"] &&
        current["--sidebar-project-locations-top"] ===
          nextStyle["--sidebar-project-locations-top"]
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
      className={[
        "sidebar-project-row-shell",
        menuOpen ? "project-menu-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onFocusCapture={updateLocationsPosition}
      onPointerEnter={updateLocationsPosition}
    >
      <SidebarInteractiveRow
        selected={selected}
        placeholder={placeholder}
        className={[
          "sidebar-project-row",
          menuOpen ? "project-menu-open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        ariaExpanded={disclosure ? expanded : undefined}
        onSelect={handleSelect}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <ProjectKindIcon
          kind={kind}
          linkedCloud={linkedCloud}
          open={kind === "local" && expanded}
          className="sidebar-row-icon"
          baseSize={15}
        />
        <span className="row-label-shell">
          <span className="sidebar-project-title-line">
            <span className="row-label">{project.name}</span>
            <SidebarUpdatedAt value={project.updatedAt} />
            {disclosure ? (
              <span className="sidebar-project-caret" aria-hidden="true">
                {expanded ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </span>
            ) : null}
          </span>
        </span>
        <div className="row-meta">
          <span className="row-meta-status">
            {terminalIndicator ? (
              <SidebarTerminalStatusIcon indicator={terminalIndicator} />
            ) : null}
          </span>
          <div className="sidebar-row-actions">
            <SidebarRowAction
              label={pinned ? "Unpin project" : "Pin project"}
              onClick={onTogglePin}
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </SidebarRowAction>
            {hasMenuActions && (
              <SidebarProjectMoreButton
                open={menuOpen}
                onToggleOpen={() => setMenuOpen((open) => !open)}
              />
            )}
            <SidebarRowAction label="New task" onClick={onNewChat}>
              <SquarePen size={13} />
            </SidebarRowAction>
          </div>
        </div>
      </SidebarInteractiveRow>
      <SidebarProjectLocationsPopover
        kind={kind}
        project={project}
        workspaceState={workspaceState}
        cloudLinkTrusted={cloudLinkTrusted}
        cloudLinkWarning={cloudLinkWarning}
        onWorkspaceTargetSelect={onWorkspaceTargetSelect}
        style={locationsStyle}
      />
      {menuOpen && (
        <SidebarProjectMenuPopover
          onClose={closeMenu}
          onMoveToCloud={
            onMoveToCloud
              ? () => {
                  closeMenu();
                  onMoveToCloud();
                }
              : undefined
          }
          onRemove={() => {
            closeMenu();
            onRemove();
          }}
        />
      )}
    </div>
  );
}

function SidebarUpdatedAt({
  value,
}: {
  value: string | null | undefined;
}) {
  const label = formatSidebarUpdatedDate(value);
  if (!label || !value) return null;

  const date = new Date(value);
  return (
    <time
      className="sidebar-row-updated-at"
      dateTime={value}
      title={`Last updated ${sidebarUpdatedDateTimeFormatter.format(date)}`}
    >
      {label}
    </time>
  );
}

function formatSidebarUpdatedDate(
  value: string | null | undefined,
  now = new Date(),
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const time = sidebarUpdatedTimeFormatter.format(date);
  const updatedToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return updatedToday
    ? time
    : `${sidebarUpdatedDateFormatter.format(date)} ${time}`;
}

function SidebarTerminalStatusIcon({
  indicator,
}: {
  indicator: SidebarTerminalIndicator;
}) {
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
  cloudLinkTrusted,
  cloudLinkWarning,
  onWorkspaceTargetSelect,
  style,
}: {
  kind: "local" | "cloud";
  project: LocalProject | CloudProject;
  workspaceState?: WorkspaceState | null;
  cloudLinkTrusted?: boolean;
  cloudLinkWarning?: string | null;
  onWorkspaceTargetSelect?: (target: WorkspaceTargetValue) => void;
  style?: ProjectLocationsPopoverStyle;
}) {
  const rows = projectLocationRows(
    kind,
    project,
    workspaceState,
    cloudLinkTrusted,
    cloudLinkWarning
  );
  return (
    <aside
      className="sidebar-project-locations-popover"
      aria-label={`${project.name} status`}
      style={style}
    >
      <div className="sidebar-project-locations-title">{project.name}</div>
      <div className="sidebar-project-location-list">
        {rows.map((row) => {
          const className = [
            "sidebar-project-location-row",
            row.tone ?? "",
            row.actionTarget ? "clickable" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const content = (
            <>
              <span
                className={["sidebar-project-location-icon", row.key]
                  .filter(Boolean)
                  .join(" ")}
                aria-hidden="true"
              >
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
          <span className="sidebar-project-location-branch">
            {parts.branch}
          </span>
          <span
            className="sidebar-project-location-separator"
            aria-hidden="true"
          >
            /
          </span>
        </>
      ) : null}
      <span className="sidebar-project-location-status">{parts.status}</span>
    </span>
  );
}

function splitProjectLocationValue(value: string): {
  branch: string | null;
  status: string;
} {
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
  cloudLinkTrusted: boolean = true,
  cloudLinkWarning: string | null = null
): ProjectLocationRow[] {
  if (kind === "cloud")
    return cloudProjectLocationRows(project as CloudProject);
  return localProjectLocationRows(
    project as LocalProject,
    workspaceState,
    cloudLinkTrusted,
    cloudLinkWarning
  );
}

function localProjectLocationRows(
  project: LocalProject,
  workspaceState?: WorkspaceState | null,
  cloudLinkTrusted: boolean = true,
  cloudLinkWarning: string | null = null
): ProjectLocationRow[] {
  const localRepoNote = localRepoStatusNote(
    project,
    workspaceState,
    cloudLinkTrusted
  );
  const localAttention = workspaceHasUnstagedChanges(workspaceState);
  const cloudLinked = localProjectHasCloud(project, cloudLinkTrusted);
  const cloudWarning = cloudLinkTrusted === false && cloudLinkWarning;
  return [
    {
      key: "local",
      value: localRepoNote,
      tone: localAttention ? "attention" : "local",
      icon:
        project.source === "git" ? (
          <FolderGit2 size={13} />
        ) : (
          <Folder size={13} />
        ),
      actionTarget: "local",
    },
    {
      key: "cloud",
      value: cloudWarning
        ? cloudWarning
        : cloudLinked
        ? cloudProjectStatusValue(project, workspaceState, cloudLinkTrusted)
        : "not in cloud",
      tone: cloudWarning ? "attention" : "cloud",
      icon: <Cloud size={13} />,
      actionTarget: cloudLinked ? "cloud" : "upload_cloud",
    },
  ];
}

function cloudProjectLocationRows(project: CloudProject): ProjectLocationRow[] {
  return [
    {
      key: "cloud",
      value: cloudProjectRowStatusValue(project),
      tone: project.syncedAt ? "cloud" : "attention",
      icon: <Cloud size={13} />,
      actionTarget: "cloud",
    },
  ];
}

function localRepoStatusNote(
  project: LocalProject,
  state: WorkspaceState | null | undefined,
  cloudLinkTrusted: boolean
): string {
  const fallbackBranch = localProjectBranch(project, state);
  if (!state) return `${fallbackBranch} / available`;
  if (state.error) return `${fallbackBranch} / status unavailable`;
  if (!state.initialized) return `${fallbackBranch} / not checked out`;
  return localWorkspaceStateNote(state, {
    branch: project.linkedSandboxProject?.defaultBranch ?? null,
    linkedCloudSourceKnown:
      project.linkedSandboxProject?.projectId && cloudLinkTrusted
        ? Boolean(project.linkedSandboxProject.lastUploadedCommit) ||
          !state.headCommit
        : true,
  });
}

function workspaceHasUnstagedChanges(
  state: WorkspaceState | null | undefined
): boolean {
  return Boolean(
    state?.dirty ||
      (state?.changedFilesCount ?? 0) > 0 ||
      (state?.untrackedFilesCount ?? 0) > 0
  );
}

function localProjectBranch(
  project: LocalProject,
  state: WorkspaceState | null | undefined
): string {
  return (
    state?.currentBranch ??
    state?.defaultBranch ??
    project.linkedSandboxProject?.defaultBranch ??
    "local"
  );
}

function localProjectHasCloud(
  project: LocalProject,
  cloudLinkTrusted: boolean = true
): boolean {
  return Boolean(
    (cloudLinkTrusted && project.linkedSandboxProject?.projectId) ||
      project.linkedOpenPondApp?.appId
  );
}

function cloudProjectStatusValue(
  project: LocalProject,
  workspaceState: WorkspaceState | null | undefined,
  cloudLinkTrusted: boolean
): string {
  return cloudWorkspaceStateNote(project, null, workspaceState, {
    cloudLinkTrusted,
  });
}

function cloudProjectRowStatusValue(project: CloudProject): string {
  const branch = project.defaultBranch ?? "main";
  const status = project.syncedAt ? "setup ready" : "needs setup";
  return `${branch} / ${status}`;
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
  onRemove,
}: {
  onClose: () => void;
  onMoveToCloud?: () => void;
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
      <div
        className="section-menu-popover sidebar-project-row-popover"
        role="menu"
      >
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
