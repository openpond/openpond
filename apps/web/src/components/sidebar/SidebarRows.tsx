import { useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { CloudProject, CloudWorkItem, LocalProject, Session, WorkspaceState } from "@openpond/contracts";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Cloud,
  EyeOff,
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
import { projectCapabilityNote } from "../../lib/project-workflow-state";
import { CloudMoveIcon } from "../common/CloudMoveIcon";
import { ProjectKindIcon } from "../common/ProjectKindIcon";
import type { SidebarTerminalIndicator } from "../terminal/terminal-state";

const SIDEBAR_RUNNING_PULSE_MS = 2650;

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
  terminalIndicator,
  onSelect,
  onTogglePin,
  onDockRight,
  onArchive,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
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
  terminalIndicator?: SidebarTerminalIndicator | null;
  onSelect: () => void;
  onTogglePin: () => void;
  onDockRight?: () => void;
  onArchive: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const rowRunning = running ?? session.status === "active";
  const runningDotStyle = useMemo(syncedRunningPulseStyle, []);
  return (
    <SidebarInteractiveRow
      selected={selected}
      dataSessionId={session.id}
      dragging={dragging}
      iconless={hideIcon}
      nested={nested}
      placeholder={placeholder}
      className={onDockRight ? "actions-3" : undefined}
      onSelect={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {hideIcon ? null : (icon ?? <MessageSquare size={15} />)}
      <span className="row-label-shell">
        <span className="row-label">{session.title}</span>
      </span>
      <div className="row-meta">
        <span className="row-meta-status">
          {terminalIndicator ? <SidebarTerminalStatusIcon indicator={terminalIndicator} /> : null}
          {rowRunning ? (
            <span className="sidebar-running-dot" style={runningDotStyle} data-tooltip="Running" aria-label="Running" />
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
}

export function SidebarProjectRow({
  kind = "local",
  project,
  pinned = false,
  selected,
  expanded = false,
  workspaceState,
  placeholder,
  terminalIndicator,
  onSelect,
  onNewChat,
  onMoveToCloud,
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
  placeholder?: boolean;
  terminalIndicator?: SidebarTerminalIndicator | null;
  onSelect: () => void;
  onNewChat: () => void;
  onMoveToCloud?: () => void;
  onToggleSystemVisibility?: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenuActions = Boolean(onMoveToCloud) || Boolean(onToggleSystemVisibility) || Boolean(onRemove);
  const linkedCloud = kind === "local" && Boolean((project as LocalProject).linkedSandboxProject?.projectId);

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <>
    <SidebarInteractiveRow
      selected={selected}
      placeholder={placeholder}
      className={["sidebar-project-row", menuOpen ? "project-menu-open" : ""].filter(Boolean).join(" ")}
      ariaExpanded={expanded}
      onSelect={onSelect}
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
        <span className="row-label-detail">
          {projectCapabilityNote({
            kind,
            localProject: kind === "local" ? project as LocalProject : null,
            cloudProject: kind === "cloud" ? project as CloudProject : null,
            workspaceState,
          })}
        </span>
        <span className="sidebar-project-caret" aria-hidden="true">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </span>
      <div className="row-meta">
        <span className="row-meta-status">
          {terminalIndicator ? <SidebarTerminalStatusIcon indicator={terminalIndicator} /> : null}
          <time>{projectRowMeta(project, kind)}</time>
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
    </>
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

function projectRowMeta(project: LocalProject | CloudProject, kind: "local" | "cloud"): string {
  if (kind === "cloud") {
    const cloudProject = project as CloudProject;
    return sourceTypeLabel(cloudProject.sourceType);
  }
  const localProject = project as LocalProject;
  return localProject.linkedOpenPondApp ? "OpenPond" : localProject.source === "git" ? "Git" : "Folder";
}

function sourceTypeLabel(sourceType: CloudProject["sourceType"]): string {
  if (sourceType === "github_repo") return "GitHub";
  if (sourceType === "internal_repo") return "Cloud";
  if (sourceType === "template") return "Template";
  return "Cloud";
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
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
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
  onSelect: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
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
      onClick={onSelect}
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
