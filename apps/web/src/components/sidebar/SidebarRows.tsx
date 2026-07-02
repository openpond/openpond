import { useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { CloudProject, CloudWorkItem, LocalProject, Session } from "@openpond/contracts";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Cloud,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  SquarePen,
  X,
} from "../icons";
import { relativeAge } from "../../lib/chat-messages";
import { CloudMoveIcon } from "../common/CloudMoveIcon";
import { ProjectKindIcon } from "../common/ProjectKindIcon";

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

export function SidebarShowMoreButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return (
    <button type="button" className="sidebar-show-more" onClick={onClick}>
      {expanded ? "Show less" : "Show more"}
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
  onSelect,
  onTogglePin,
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
  onSelect: () => void;
  onTogglePin: () => void;
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
      dragging={dragging}
      iconless={hideIcon}
      nested={nested}
      placeholder={placeholder}
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
        {rowRunning ? (
          <span className="sidebar-running-dot" style={runningDotStyle} data-tooltip="Running" aria-label="Running" />
        ) : (
          <time>{relativeAge(session.updatedAt)}</time>
        )}
        <div className="sidebar-row-actions">
          <SidebarRowAction label={session.pinned ? "Unpin chat" : "Pin chat"} onClick={onTogglePin}>
            {session.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </SidebarRowAction>
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
  placeholder,
  onSelect,
  onNewChat,
  onMoveToCloud,
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
  placeholder?: boolean;
  onSelect: () => void;
  onNewChat: () => void;
  onMoveToCloud?: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenuActions = Boolean(onMoveToCloud) || Boolean(onRemove);

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
        <time>{projectRowMeta(project, kind)}</time>
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
        {workItem.sourceRef ? <span className="row-label-detail">{workItem.sourceRef}</span> : null}
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

function cloudWorkItemMeta(workItem: CloudWorkItem): string {
  if (workItem.status === "needs_review") return "Review";
  if (workItem.status === "failed") return "Failed";
  if (workItem.status === "cancelled") return "Cancelled";
  return relativeAge(workItem.updatedAt);
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
