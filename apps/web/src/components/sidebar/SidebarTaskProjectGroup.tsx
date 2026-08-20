import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, MessageSquare } from "../icons";

export type SidebarTaskGroupKind = "project" | "draft" | "projectless";

export function SidebarTaskProjectGroup({
  children,
  count,
  expanded,
  groupKey,
  kind,
  label,
  onToggle,
}: {
  children: ReactNode;
  count: number;
  expanded: boolean;
  groupKey: string;
  kind: SidebarTaskGroupKind;
  label: string;
  onToggle: () => void;
}) {
  const contentId = `sidebar-task-group-${groupKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const Icon =
    kind === "draft"
      ? FileText
      : kind === "projectless"
        ? MessageSquare
        : expanded
          ? FolderOpen
          : Folder;

  return (
    <section className="sidebar-task-project-group">
      <button
        type="button"
        className="sidebar-task-project-group-header"
        aria-controls={contentId}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <Icon className="sidebar-task-project-group-icon" size={14} aria-hidden="true" />
        <span className="sidebar-task-project-group-name">{label}</span>
        <span className="sidebar-task-project-group-count" aria-label={`${count} ${count === 1 ? "task" : "tasks"}`}>
          {count}
        </span>
        <span className="sidebar-task-project-group-caret" aria-hidden="true">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded ? (
        <div id={contentId} className="sidebar-task-project-group-content">
          {children}
        </div>
      ) : null}
    </section>
  );
}
