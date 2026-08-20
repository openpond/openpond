import { useState, type ReactNode } from "react";
import type { SidebarProjectItem } from "../../lib/app-models";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  MessageSquare,
  MoreHorizontal,
  SquarePen,
  X,
} from "../icons";
import { ProjectKindIcon } from "../common/ProjectKindIcon";

export type SidebarTaskGroupKind = "project" | "draft" | "projectless";

export function SidebarTaskProjectGroup({
  children,
  expanded,
  groupKey,
  kind,
  label,
  onToggle,
  onNewTask,
  onOpenProject,
  onRemoveProject,
  project,
}: {
  children: ReactNode;
  expanded: boolean;
  groupKey: string;
  kind: SidebarTaskGroupKind;
  label: string;
  onToggle: () => void;
  onNewTask?: () => void;
  onOpenProject?: () => void;
  onRemoveProject?: () => void;
  project?: SidebarProjectItem | null;
}) {
  const contentId = `sidebar-task-group-${groupKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const FallbackIcon = kind === "draft" ? FileText : MessageSquare;
  const [menuOpen, setMenuOpen] = useState(false);
  const hasProjectActions = Boolean(onNewTask || onOpenProject || onRemoveProject);

  return (
    <section className="sidebar-task-project-group">
      <div className={`sidebar-task-project-group-header-shell${menuOpen ? " menu-open" : ""}`}>
        <button
          type="button"
          className="sidebar-task-project-group-header"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => {
            setMenuOpen(false);
            onToggle();
          }}
        >
          {project ? (
            <ProjectKindIcon
              kind={project.kind}
              linkedCloud={Boolean(
                project.kind === "local" && project.project.linkedSandboxProject?.projectId,
              )}
              open={project.kind === "local" && expanded}
              className="sidebar-task-project-group-icon"
              baseSize={14}
            />
          ) : (
            <FallbackIcon className="sidebar-task-project-group-icon" size={14} aria-hidden="true" />
          )}
          <span className="sidebar-task-project-group-name">{label}</span>
          <span className="sidebar-task-project-group-caret" aria-hidden="true">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </button>
        {project && hasProjectActions ? (
          <div className="sidebar-task-project-group-actions">
            {(onOpenProject || onRemoveProject) ? (
              <button
                type="button"
                className={`sidebar-row-action${menuOpen ? " active" : ""}`}
                data-tooltip="More project actions"
                aria-label="More project actions"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <MoreHorizontal size={13} />
              </button>
            ) : null}
            {onNewTask ? (
              <button
                type="button"
                className="sidebar-row-action"
                data-tooltip="New task"
                aria-label="New task"
                onClick={onNewTask}
              >
                <SquarePen size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
        {menuOpen ? (
          <>
            <button
              type="button"
              className="sidebar-task-project-group-menu-backdrop"
              aria-label="Close project actions"
              onClick={() => setMenuOpen(false)}
            />
            <div className="section-menu-popover sidebar-task-project-group-menu" role="menu">
              {onOpenProject ? (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenProject(); }}>
                  <span>Open project</span>
                </button>
              ) : null}
              {onRemoveProject ? (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRemoveProject(); }}>
                  <X size={13} />
                  <span>Remove from Projects</span>
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      {expanded ? (
        <div id={contentId} className="sidebar-task-project-group-content">
          {children}
        </div>
      ) : null}
    </section>
  );
}
