import type { Session } from "@openpond/contracts";
import { useState } from "react";
import {
  Cloud,
  FolderOpen,
  FolderPlus,
  ListFilter,
  Plus,
  Settings,
  SquarePen,
} from "../icons";
import type { AppView, SidebarProjectItem } from "../../lib/app-models";
import { SIDEBAR_SECTION_LIMIT } from "../../lib/app-models";
import type { SidebarProps } from "./Sidebar.types";
import {
  SidebarCloudWorkItemRow,
  SidebarProjectRow,
  SidebarSection,
  SidebarSectionMenu,
  SidebarSessionRow,
  SidebarShowMoreButton,
} from "./SidebarRows";

export type SidebarProjectClickAction = "select_draft_project" | "toggle_project";

export function sidebarProjectClickAction(input: {
  selectedSessionId: string | null;
  view: AppView;
}): SidebarProjectClickAction {
  return input.view === "chat" && !input.selectedSessionId
    ? "select_draft_project"
    : "toggle_project";
}

export function SidebarSectionList({
  addProjectFolder,
  archivedChatsOpen,
  archiveSession,
  beginNewChat,
  chatsCollapsed,
  chatsExpanded,
  chatRows,
  cloudProjectsCollapsed,
  cloudProjectsExpanded,
  cloudProjectRows,
  cloudWorkItemsByProjectId,
  clearSidebarDrag,
  commitPinnedDrop,
  commitPinnedPreviewDrop,
  dragItem,
  dockSessionRight,
  expandedProjectIds,
  expandProject,
  onToggleChatsCollapsed,
  onToggleCloudProjectsCollapsed,
  onTogglePinnedCollapsed,
  onToggleProjectsCollapsed,
  openCloudHome,
  createCloudEnvironment,
  pinnedCollapsed,
  pinnedRows,
  pinnedSessions,
  previewPinnedDrop,
  localProjectRows,
  projectsCollapsed,
  projectsExpanded,
  projectSessionRowsByProjectId,
  moveProjectToCloud,
  removeProject,
  restoreSession,
  runningSessionIds,
  sectionMenuOpen,
  selectCloudWorkItem,
  selectedCloudWorkItemId,
  selectedProjectId,
  selectedSessionId,
  sidebarProjectIdBySessionId,
  setArchivedChatsOpen,
  setCloudProjectsExpanded,
  setChatsExpanded,
  setProjectsExpanded,
  setSearchOpen,
  setSectionMenuOpen,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setView,
  startPinnedDrag,
  startCloudProjectFromScratch,
  startProjectFromScratch,
  toggleProjectPinned,
  toggleProjectExpanded,
  toggleSessionPinned,
  visibleChatRows,
  visibleLocalProjectRows,
  view,
}: SidebarProps) {
  const [expandedProjectChatIds, setExpandedProjectChatIds] = useState<Set<string>>(() => new Set());
  const [expandedCloudProjectWorkItemIds, setExpandedCloudProjectWorkItemIds] = useState<Set<string>>(() => new Set());

  function toggleProjectChatRows(projectId: string) {
    setExpandedProjectChatIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function toggleCloudProjectWorkItems(projectId: string) {
    setExpandedCloudProjectWorkItemIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function selectDraftProject(item: SidebarProjectItem) {
    setSelectedAppId(null);
    setSelectedProjectId(item.id);
    setSelectedSessionId(null);
    setView("chat");
    if (selectedProjectId === item.id && !selectedSessionId) {
      toggleProjectExpanded(item.id);
    } else {
      expandProject(item.id);
    }
  }

  function selectProjectRow(item: SidebarProjectItem) {
    if (sidebarProjectClickAction({ selectedSessionId, view }) === "select_draft_project") {
      selectDraftProject(item);
      return;
    }
    toggleProjectExpanded(item.id);
  }

  function beginProjectChat(item: SidebarProjectItem) {
    setSelectedAppId(null);
    setSelectedProjectId(item.id);
    setSelectedSessionId(null);
    setView("chat");
    expandProject(item.id);
  }

  function selectSession(session: Session) {
    setSelectedSessionId(session.id);
    const projectId = sidebarProjectIdBySessionId[session.id] ?? null;
    setSelectedAppId(projectId ? null : session.appId);
    setSelectedProjectId(projectId);
    setView("chat");
  }

  function renderProjectChildren(item: SidebarProjectItem) {
    if (item.kind === "cloud") return renderCloudProjectChildren(item);
    if (!expandedProjectIds.has(item.id)) return null;
    const sessions = projectSessionRowsByProjectId[item.id] ?? [];
    if (sessions.length === 0) return null;
    const chatsExpandedForProject = expandedProjectChatIds.has(item.id);
    const visibleSessions = chatsExpandedForProject ? sessions : sessions.slice(0, SIDEBAR_SECTION_LIMIT);

    return (
      <div className="sidebar-project-children">
        {visibleSessions.map((session) => (
          <SidebarSessionRow
            key={session.id}
            session={session}
            selected={view === "chat" && selectedSessionId === session.id}
            hideIcon
            nested
            running={runningSessionIds.has(session.id)}
            onSelect={() => selectSession(session)}
            onTogglePin={() => toggleSessionPinned(session)}
            onDockRight={() => dockSessionRight(session)}
            onArchive={() => archiveSession(session)}
          />
        ))}
        {sessions.length > SIDEBAR_SECTION_LIMIT && (
          <SidebarShowMoreButton
            expanded={chatsExpandedForProject}
            onClick={() => toggleProjectChatRows(item.id)}
          />
        )}
      </div>
    );
  }

  function renderCloudProjectChildren(item: SidebarProjectItem) {
    if (!expandedProjectIds.has(item.id)) return null;
    const workItems = cloudWorkItemsByProjectId[item.id] ?? [];
    if (workItems.length === 0) return <div className="empty-row nested">No tasks</div>;
    const hasSelectedWorkItem = workItems.some((workItem) => workItem.id === selectedCloudWorkItemId);
    const workItemsExpandedForProject = hasSelectedWorkItem || expandedCloudProjectWorkItemIds.has(item.id);
    const visibleWorkItems = workItemsExpandedForProject ? workItems : workItems.slice(0, SIDEBAR_SECTION_LIMIT);

    return (
      <div className="sidebar-project-children">
        {visibleWorkItems.map((workItem) => (
          <SidebarCloudWorkItemRow
            key={workItem.id}
            workItem={workItem}
            selected={view === "cloud" && selectedCloudWorkItemId === workItem.id}
            hideIcon
            nested
            onSelect={() => selectCloudWorkItem(workItem)}
          />
        ))}
        {workItems.length > SIDEBAR_SECTION_LIMIT && (
          <SidebarShowMoreButton
            expanded={workItemsExpandedForProject}
            onClick={() => toggleCloudProjectWorkItems(item.id)}
          />
        )}
      </div>
    );
  }

  const visibleCloudProjectRows = cloudProjectsExpanded
    ? cloudProjectRows
    : cloudProjectRows.slice(0, SIDEBAR_SECTION_LIMIT);

  return (
    <div className="sidebar-scroll">
      <SidebarSection label="Pinned" collapsed={pinnedCollapsed} onToggleCollapsed={onTogglePinnedCollapsed}>
        {pinnedRows.map((row) => {
          const isDraggedRow = dragItem?.type === row.type && dragItem.id === row.id;
          if (row.type === "project") {
            return (
              <div key={row.key} className="sidebar-project-group">
                <SidebarProjectRow
                  kind={row.item.kind}
                  project={row.item.project}
                  pinned={row.item.pinned}
                  selected={view === "chat" && selectedProjectId === row.id && !selectedSessionId}
                  expanded={expandedProjectIds.has(row.id)}
                  placeholder={isDraggedRow}
                  onSelect={() => selectProjectRow(row.item)}
                  onNewChat={() => beginProjectChat(row.item)}
                  onMoveToCloud={row.item.kind === "local" ? () => moveProjectToCloud(row.item) : undefined}
                  onTogglePin={() => toggleProjectPinned(row.item)}
                  onRemove={() => removeProject(row.item)}
                  onDragStart={(event) => startPinnedDrag(event, { type: "project", id: row.id })}
                  onDragEnd={clearSidebarDrag}
                  onDragOver={(event) => {
                    if (isDraggedRow) return;
                    previewPinnedDrop(event, { type: "project", id: row.id });
                  }}
                  onDrop={(event) => {
                    if (isDraggedRow) {
                      commitPinnedPreviewDrop();
                      return;
                    }
                    commitPinnedDrop(event, { type: "project", id: row.id });
                  }}
                />
                {!isDraggedRow && renderProjectChildren(row.item)}
              </div>
            );
          }
          return (
            <SidebarSessionRow
              key={row.key}
              session={row.session}
              selected={view === "chat" && selectedSessionId === row.id}
              hideIcon
              placeholder={isDraggedRow}
              running={runningSessionIds.has(row.session.id)}
              onSelect={() => selectSession(row.session)}
              onTogglePin={() => toggleSessionPinned(row.session)}
              onDockRight={() => dockSessionRight(row.session)}
              onArchive={() => archiveSession(row.session)}
              onDragStart={(event) => startPinnedDrag(event, { type: "session", id: row.id })}
              onDragEnd={clearSidebarDrag}
              onDragOver={(event) => {
                if (isDraggedRow) return;
                previewPinnedDrop(event, { type: "session", id: row.id });
              }}
              onDrop={(event) => {
                if (isDraggedRow) {
                  commitPinnedPreviewDrop();
                  return;
                }
                commitPinnedDrop(event, { type: "session", id: row.id });
              }}
            />
          );
        })}
        {pinnedRows.length === 0 && <div className="empty-row">No pinned items</div>}
      </SidebarSection>

      <SidebarSection
        label="Local Projects"
        collapsed={projectsCollapsed}
        onToggleCollapsed={onToggleProjectsCollapsed}
        actions={
          <div className="section-menu">
            <button
              type="button"
              className={`section-icon ${sectionMenuOpen === "projects" ? "active" : ""}`}
              data-tooltip="Add project"
              aria-label="Add project"
              aria-haspopup="menu"
              aria-expanded={sectionMenuOpen === "projects"}
              onClick={() => setSectionMenuOpen((current) => (current === "projects" ? null : "projects"))}
            >
              <Plus size={14} />
            </button>
            {sectionMenuOpen === "projects" && (
              <div className="section-menu-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSectionMenuOpen(null);
                    startProjectFromScratch();
                  }}
                >
                  <FolderPlus size={13} />
                  <span>New Local Project</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSectionMenuOpen(null);
                    addProjectFolder();
                  }}
                >
                  <FolderOpen size={13} />
                  <span>Use existing folder</span>
                </button>
              </div>
            )}
          </div>
        }
      >
        {visibleLocalProjectRows.map((item) => (
          <div key={item.id} className="sidebar-project-group">
            <SidebarProjectRow
              kind={item.kind}
              project={item.project}
              pinned={item.pinned}
              selected={view === "chat" && selectedProjectId === item.id && !selectedSessionId}
              expanded={expandedProjectIds.has(item.id)}
              onSelect={() => selectProjectRow(item)}
              onNewChat={() => beginProjectChat(item)}
              onMoveToCloud={() => moveProjectToCloud(item)}
              onTogglePin={() => toggleProjectPinned(item)}
              onRemove={() => removeProject(item)}
            />
            {renderProjectChildren(item)}
          </div>
        ))}
        {localProjectRows.length === 0 && <div className="empty-row">No local projects</div>}
        {localProjectRows.length > SIDEBAR_SECTION_LIMIT && (
          <SidebarShowMoreButton
            expanded={projectsExpanded}
            onClick={() => setProjectsExpanded((expanded) => !expanded)}
          />
        )}
      </SidebarSection>

      <SidebarSection
        label="Cloud Projects"
        collapsed={cloudProjectsCollapsed}
        titleActive={view === "cloud" && !selectedCloudWorkItemId}
        onTitleClick={openCloudHome}
        onToggleCollapsed={onToggleCloudProjectsCollapsed}
        actions={
          <div className="section-menu">
            <button
              type="button"
              className={`section-icon ${sectionMenuOpen === "cloud" ? "active" : ""}`}
              data-tooltip="New Cloud task"
              aria-label="New Cloud task"
              aria-haspopup="menu"
              aria-expanded={sectionMenuOpen === "cloud"}
              onClick={() => {
                openCloudHome();
                setSectionMenuOpen((current) => (current === "cloud" ? null : "cloud"));
              }}
            >
              <Plus size={14} />
            </button>
            {sectionMenuOpen === "cloud" && (
              <div className="section-menu-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSectionMenuOpen(null);
                    startCloudProjectFromScratch();
                  }}
                >
                  <Cloud size={13} />
                  <span>New Cloud Project</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSectionMenuOpen(null);
                    openCloudHome();
                  }}
                >
                  <Cloud size={13} />
                  <span>New task</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSectionMenuOpen(null);
                    createCloudEnvironment();
                  }}
                >
                  <Settings size={13} />
                  <span>Create environment</span>
                </button>
              </div>
            )}
          </div>
        }
      >
        {visibleCloudProjectRows.map((item) => (
          <div key={item.id} className="sidebar-project-group">
            <SidebarProjectRow
              kind={item.kind}
              project={item.project}
              pinned={item.pinned}
              selected={view === "chat" && selectedProjectId === item.id && !selectedSessionId}
              expanded={expandedProjectIds.has(item.id)}
              onSelect={() => selectProjectRow(item)}
              onNewChat={() => beginProjectChat(item)}
              onTogglePin={() => toggleProjectPinned(item)}
              onRemove={() => removeProject(item)}
            />
            {renderCloudProjectChildren(item)}
          </div>
        ))}
        {cloudProjectRows.length === 0 && <div className="empty-row">No Cloud projects</div>}
        {cloudProjectRows.length > SIDEBAR_SECTION_LIMIT && (
          <SidebarShowMoreButton
            expanded={cloudProjectsExpanded}
            onClick={() => setCloudProjectsExpanded((expanded) => !expanded)}
          />
        )}
      </SidebarSection>

      <SidebarSection
        label="Chats"
        collapsed={chatsCollapsed}
        onToggleCollapsed={onToggleChatsCollapsed}
        actions={
          <>
            <SidebarSectionMenu
              id="chats"
              open={sectionMenuOpen === "chats"}
              archivedOpen={archivedChatsOpen}
              archivedLabel="archived chats"
              onToggleOpen={() => setSectionMenuOpen((current) => (current === "chats" ? null : "chats"))}
              onToggleArchived={() => {
                setArchivedChatsOpen((open) => !open);
                setSectionMenuOpen(null);
              }}
            />
            <button
              className="section-icon"
              data-tooltip="Filter chats"
              aria-label="Filter chats"
              onClick={() => {
                setSectionMenuOpen(null);
                setSearchOpen(true);
              }}
            >
              <ListFilter size={14} />
            </button>
            <button className="section-icon" data-tooltip="New chat" aria-label="New chat" onClick={() => beginNewChat(null)}>
              <SquarePen size={14} />
            </button>
          </>
        }
      >
        {visibleChatRows.map((session) =>
          session.archived ? (
            <SidebarSessionRow
              key={session.id}
              session={session}
              selected={false}
              archived
              hideIcon
              running={runningSessionIds.has(session.id)}
              onSelect={() => {
                restoreSession(session);
                selectSession(session);
              }}
              onTogglePin={() => toggleSessionPinned(session)}
              onDockRight={() => dockSessionRight(session)}
              onArchive={() => restoreSession(session)}
            />
          ) : (
            <SidebarSessionRow
              key={session.id}
              session={session}
              selected={view === "chat" && selectedSessionId === session.id}
              hideIcon
              running={runningSessionIds.has(session.id)}
              onSelect={() => selectSession(session)}
              onTogglePin={() => toggleSessionPinned(session)}
              onDockRight={() => dockSessionRight(session)}
              onArchive={() => archiveSession(session)}
            />
          )
        )}
        {chatRows.length === 0 && <div className="empty-row">No chats</div>}
        {chatRows.length > SIDEBAR_SECTION_LIMIT && (
          <SidebarShowMoreButton expanded={chatsExpanded} onClick={() => setChatsExpanded((expanded) => !expanded)} />
        )}
      </SidebarSection>
    </div>
  );
}
