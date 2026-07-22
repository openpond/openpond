import { useMemo } from "react";
import "../../styles/command/command-menu.css";
import type { ReactNode } from "react";
import type { Session } from "@openpond/contracts";
import { Bookmark, Cloud, Folder, MessageSquare, Pin, Search, SquarePen } from "../icons";
import { isCloudSidebarProjectItem, isLocalSidebarProjectItem, type SidebarProjectItem } from "../../lib/app-models";
import { relativeAge } from "../../lib/chat-messages";

export function CommandMenu({
  open,
  query,
  projects,
  sessions,
  onQueryChange,
  onClose,
  onNewChat,
  onOpenProject,
  onOpenSession,
}: {
  open: boolean;
  query: string;
  projects: SidebarProjectItem[];
  sessions: Session[];
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onNewChat: () => void;
  onOpenProject: (project: SidebarProjectItem) => void;
  onOpenSession: (session: Session) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const sessionMatches = useMemo(
    () => firstMatchingSessions(sessions, normalizedQuery, 10),
    [normalizedQuery, sessions]
  );
  const projectMatches = useMemo(
    () => firstMatchingProjects(projects, normalizedQuery, 8),
    [normalizedQuery, projects]
  );

  if (!open) return null;

  const openFirstResult = () => {
    const firstProject = projectMatches[0];
    if (firstProject) {
      onOpenProject(firstProject);
      return;
    }
    const firstSession = sessionMatches[0];
    if (firstSession) onOpenSession(firstSession);
  };

  return (
    <div className="command-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="command-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Search chats and projects"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-input-row">
          <Search size={17} />
          <input
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                openFirstResult();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Search chats and projects"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-results">
          <button className="command-result command-create" onClick={onNewChat}>
            <SquarePen size={15} />
            <span>New local task</span>
            <small>General</small>
          </button>
          <CommandResultGroup label="Projects">
            {projectMatches.map((item) => (
              <button className="command-result" key={item.project.id} onClick={() => onOpenProject(item)}>
                {isCloudSidebarProjectItem(item) ? <Cloud size={15} /> : <Folder size={15} />}
                <span>{item.project.name}</span>
                <small>{projectResultLabel(item)}</small>
              </button>
            ))}
            {projectMatches.length === 0 && <div className="command-empty">No projects found</div>}
          </CommandResultGroup>
          <CommandResultGroup label="Chats">
            {sessionMatches.map((session) => (
              <button className="command-result" key={session.id} onClick={() => onOpenSession(session)}>
                {session.pinned ? <Pin size={15} /> : session.savedForLater ? <Bookmark size={15} /> : <MessageSquare size={15} />}
                <span>{session.title}</span>
                <small>{session.appName ?? relativeAge(session.updatedAt)}</small>
              </button>
            ))}
            {sessionMatches.length === 0 && <div className="command-empty">No chats found</div>}
          </CommandResultGroup>
        </div>
      </section>
    </div>
  );
}

function firstMatchingSessions(sessions: Session[], normalizedQuery: string, limit: number): Session[] {
  const matches: Session[] = [];
  for (const session of sessions) {
    if (!normalizedQuery || `${session.title} ${session.appName ?? ""}`.toLowerCase().includes(normalizedQuery)) {
      matches.push(session);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function firstMatchingProjects(
  projects: SidebarProjectItem[],
  normalizedQuery: string,
  limit: number,
): SidebarProjectItem[] {
  const matches: SidebarProjectItem[] = [];
  for (const item of projects) {
    if (!normalizedQuery || projectSearchText(item).toLowerCase().includes(normalizedQuery)) {
      matches.push(item);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function projectSearchText(item: SidebarProjectItem): string {
  if (isLocalSidebarProjectItem(item)) {
    return `${item.project.name} ${item.project.path} ${item.project.workspacePath}`;
  }
  return `${item.project.name} ${item.project.sourceLabel ?? ""} ${item.project.organizationName ?? ""}`;
}

function projectResultLabel(item: SidebarProjectItem): string {
  if (isCloudSidebarProjectItem(item)) {
    return item.project.organizationName ?? "Cloud Project";
  }
  if (item.project.linkedOpenPondApp) return "OpenPond project";
  return item.project.source === "git" ? "Local Git" : "Local folder";
}

function CommandResultGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="command-group">
      <div className="command-group-label">{label}</div>
      {children}
    </div>
  );
}
