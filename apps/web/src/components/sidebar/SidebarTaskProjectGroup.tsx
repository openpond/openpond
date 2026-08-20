import type { ReactNode } from "react";
import type { SidebarProjectItem } from "../../lib/app-models";
import { ChevronDown, ChevronRight, FileText, MessageSquare } from "../icons";
import { ProjectKindIcon } from "../common/ProjectKindIcon";

export type SidebarTaskGroupKind = "project" | "draft" | "projectless";

export function SidebarTaskProjectGroup({
  children,
  expanded,
  groupKey,
  kind,
  label,
  onToggle,
  project,
}: {
  children: ReactNode;
  expanded: boolean;
  groupKey: string;
  kind: SidebarTaskGroupKind;
  label: string;
  onToggle: () => void;
  project?: SidebarProjectItem | null;
}) {
  const contentId = `sidebar-task-group-${groupKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const FallbackIcon = kind === "draft" ? FileText : MessageSquare;

  return (
    <section className="sidebar-task-project-group">
      <button
        type="button"
        className="sidebar-task-project-group-header"
        aria-controls={contentId}
        aria-expanded={expanded}
        onClick={onToggle}
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
      {expanded ? (
        <div id={contentId} className="sidebar-task-project-group-content">
          {children}
        </div>
      ) : null}
    </section>
  );
}
