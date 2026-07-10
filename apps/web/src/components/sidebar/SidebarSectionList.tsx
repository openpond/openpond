import type { Session, TeamChatMember, TeamChatThread } from "@openpond/contracts";
import { useEffect, useState } from "react";
import "../../styles/sidebar/team-sidebar.css";
import {
  Cloud,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  ListFilter,
  MoreHorizontal,
  Plus,
  Settings,
  SquarePen,
} from "../icons";
import type { AppView, SidebarProjectItem } from "../../lib/app-models";
import { SIDEBAR_CHAT_PAGE_SIZE, SIDEBAR_SECTION_LIMIT } from "../../lib/app-models";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import { sidebarTerminalIndicator, terminalScopeKey, type TerminalScopeSummary } from "../terminal/terminal-state";
import type { SidebarProps } from "./Sidebar.types";
import type { OpenPondOrganization } from "../../lib/organization-types";
import {
  SidebarCloudWorkItemRow,
  SidebarProjectRow,
  SidebarSection,
  SidebarSectionMenu,
  SidebarSessionRow,
  SidebarShowMoreButton,
} from "./SidebarRows";

const EMPTY_TERMINAL_SUMMARIES: Record<string, TerminalScopeSummary> = {};
const EMPTY_GOAL_RUNTIME_BY_SESSION_ID = new Map<string, GoalRuntimeStatus>();
const EMPTY_SUBAGENT_RUNTIME_BY_SESSION_ID = new Map<string, SubagentRuntimeStatus>();

export type SidebarProjectClickAction = "select_draft_project" | "toggle_project";

export function sidebarProjectClickAction(input: {
  selectedSessionId: string | null;
  view: AppView;
}): SidebarProjectClickAction {
  return input.view === "chat" && !input.selectedSessionId ? "select_draft_project" : "toggle_project";
}

export function nextSidebarChatVisibleCount(currentCount: number, totalCount: number): number {
  return Math.min(Math.max(currentCount, SIDEBAR_SECTION_LIMIT) + SIDEBAR_CHAT_PAGE_SIZE, totalCount);
}

export function previousSidebarChatVisibleCount(currentCount: number, totalCount: number): number {
  const boundedCount = Math.max(SIDEBAR_SECTION_LIMIT, Math.min(currentCount, totalCount));
  if (boundedCount <= SIDEBAR_SECTION_LIMIT) return SIDEBAR_SECTION_LIMIT;
  const pageCount = Math.ceil((boundedCount - SIDEBAR_SECTION_LIMIT) / SIDEBAR_CHAT_PAGE_SIZE);
  return Math.max(SIDEBAR_SECTION_LIMIT, SIDEBAR_SECTION_LIMIT + (pageCount - 1) * SIDEBAR_CHAT_PAGE_SIZE);
}

export function SidebarSectionList({
  addProjectFolder,
  archivedChatsOpen,
  account,
  archiveSession,
  beginNewChat,
  chatsCollapsed,
  chatRows,
  cloudProjectRows,
  workspaceStates = {},
  cloudWorkItemsByProjectId,
  childSessionRowsByParentId = {},
  clearSidebarDrag,
  commitPinnedDrop,
  commitPinnedPreviewDrop,
  dragItem,
  dockSessionRight,
  expandedProjectIds,
  expandProject,
  insightsSystemProjectHidden,
  onToggleChatsCollapsed,
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
  projectRows,
  projectSessionRowsByProjectId,
  moveProjectToCloud,
  removeProject,
  restoreSession,
  renameSession,
  runningSessionIds,
  goalRuntimeBySessionId = EMPTY_GOAL_RUNTIME_BY_SESSION_ID,
  subagentRuntimeBySessionId = EMPTY_SUBAGENT_RUNTIME_BY_SESSION_ID,
  sectionMenuOpen,
  selectCloudWorkItem,
  selectTeamThread,
  openTeamDm,
  selectedCloudWorkItemId,
  selectedTeamThreadId,
  teamChatEnabled,
  teamChatOrganization,
  teamChatLoading = false,
  currentUserId,
  teamMembers = [],
  teamThreads = [],
  selectedProjectId,
  selectedSessionId,
  sidebarProjectIdBySessionId,
  startExistingProjectFromPath,
  terminalSummaries = EMPTY_TERMINAL_SUMMARIES,
  setArchivedChatsOpen,
  setChatRowsVisibleCount,
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
  switchProjectWorkspaceTarget,
  toggleInsightsSystemProjectVisibility,
  toggleProjectPinned,
  toggleSystemProjectVisibility,
  toggleProjectExpanded,
  toggleSessionPinned,
  visibleChatRows,
  visibleProjectRows,
  view,
}: SidebarProps) {
  const [projectChatVisibleCounts, setProjectChatVisibleCounts] = useState<Record<string, number>>({});
  const [expandedCloudProjectWorkItemIds, setExpandedCloudProjectWorkItemIds] = useState<Set<string>>(() => new Set());
  const [expandedChildSessionParentIds, setExpandedChildSessionParentIds] = useState<Set<string>>(() => new Set());
  const activeChildSessionExpansionKey = JSON.stringify(
    Object.entries(childSessionRowsByParentId)
      .filter(
        ([parentSessionId, childSessions]) =>
          childSessions.length > 0 && (subagentRuntimeBySessionId.get(parentSessionId)?.activeCount ?? 0) > 0
      )
      .flatMap(([parentSessionId, childSessions]) =>
        childSessions.map((childSession) => [parentSessionId, childSession.id] as const)
      )
      .sort(
        ([leftParent, leftChild], [rightParent, rightChild]) =>
          leftParent.localeCompare(rightParent) || leftChild.localeCompare(rightChild)
      )
  );

  useEffect(() => {
    const activeChildren = JSON.parse(activeChildSessionExpansionKey) as Array<[string, string]>;
    if (activeChildren.length === 0) return;
    const parentSessionIds = new Set(activeChildren.map(([parentSessionId]) => parentSessionId));
    setExpandedChildSessionParentIds((current) => {
      if ([...parentSessionIds].every((parentSessionId) => current.has(parentSessionId))) return current;
      return new Set([...current, ...parentSessionIds]);
    });
  }, [activeChildSessionExpansionKey]);
  const projectsSectionRows = projectRows ?? [...localProjectRows, ...cloudProjectRows].filter((item) => !item.pinned);

  function showMoreProjectChats(projectId: string, totalCount: number) {
    setProjectChatVisibleCounts((current) => {
      const currentCount = current[projectId] ?? SIDEBAR_SECTION_LIMIT;
      const nextCount = nextSidebarChatVisibleCount(currentCount, totalCount);
      if (nextCount === currentCount) return current;
      return { ...current, [projectId]: nextCount };
    });
  }

  function showLessProjectChats(projectId: string, totalCount: number) {
    setProjectChatVisibleCounts((current) => {
      const currentCount = current[projectId] ?? SIDEBAR_SECTION_LIMIT;
      const previousCount = previousSidebarChatVisibleCount(currentCount, totalCount);
      if (previousCount === currentCount) return current;
      if (previousCount <= SIDEBAR_SECTION_LIMIT) {
        const next = { ...current };
        delete next[projectId];
        return next;
      }
      return { ...current, [projectId]: previousCount };
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
    if (projectId) expandProject(projectId);
    setSelectedAppId(projectId ? null : session.appId);
    setSelectedProjectId(projectId);
    setView("chat");
  }

  const generalThread = teamThreads.find((thread) => thread.kind === "general") ?? null;
  const dmThreadByUserId = new Map<string, TeamChatThread>();
  for (const thread of teamThreads) {
    if (thread.kind !== "dm") continue;
    const other = thread.participants.find((participant) => participant.userId !== currentUserId);
    if (other) dmThreadByUserId.set(other.userId, thread);
  }

  function childSessionsFor(session: Session): Session[] {
    return childSessionRowsByParentId[session.id] ?? [];
  }

  function childSessionsExpanded(parentSession: Session, childSessions: Session[]): boolean {
    return (
      expandedChildSessionParentIds.has(parentSession.id) ||
      childSessions.some((session) => session.id === selectedSessionId)
    );
  }

  function toggleChildSessions(parentSessionId: string) {
    setExpandedChildSessionParentIds((current) => {
      const next = new Set(current);
      if (next.has(parentSessionId)) {
        next.delete(parentSessionId);
      } else {
        next.add(parentSessionId);
      }
      return next;
    });
  }

  function terminalIndicatorForSession(sessionId: string) {
    return sidebarTerminalIndicator(terminalSummaries[terminalScopeKey({ kind: "session", id: sessionId })]);
  }

  function terminalIndicatorForProject(projectId: string) {
    return sidebarTerminalIndicator(terminalSummaries[terminalScopeKey({ kind: "project", id: projectId })]);
  }

  function renderProjectChildren(item: SidebarProjectItem) {
    if (item.kind === "cloud") return renderCloudProjectChildren(item);
    if (!expandedProjectIds.has(item.id)) return null;
    const sessions = projectSessionRowsByProjectId[item.id] ?? [];
    const workItems = cloudWorkItemsByProjectId[item.id] ?? [];
    if (sessions.length === 0 && workItems.length === 0) return null;
    const visibleCount = Math.max(SIDEBAR_SECTION_LIMIT, projectChatVisibleCounts[item.id] ?? SIDEBAR_SECTION_LIMIT);
    const visibleSessions = sessions.slice(0, visibleCount);
    const canShowMoreProjectChats = visibleSessions.length < sessions.length;
    const canShowLessProjectChats = visibleSessions.length > SIDEBAR_SECTION_LIMIT;
    const hasSelectedWorkItem = workItems.some((workItem) => workItem.id === selectedCloudWorkItemId);
    const workItemsExpandedForProject = hasSelectedWorkItem || expandedCloudProjectWorkItemIds.has(item.id);
    const visibleWorkItems = workItemsExpandedForProject ? workItems : workItems.slice(0, SIDEBAR_SECTION_LIMIT);

    return (
      <div className="sidebar-project-children">
        {visibleSessions.map((session) => (
          <div key={session.id} className="sidebar-session-group">
            <SidebarSessionRow
              session={session}
              selected={view === "chat" && selectedSessionId === session.id}
              hideIcon
              nested
              running={runningSessionIds.has(session.id)}
              goalRuntime={goalRuntimeBySessionId.get(session.id) ?? null}
              subagentRuntime={subagentRuntimeBySessionId.get(session.id) ?? null}
              terminalIndicator={terminalIndicatorForSession(session.id)}
              childSessionCount={childSessionsFor(session).length}
              childSessionsExpanded={childSessionsExpanded(session, childSessionsFor(session))}
              onToggleChildSessions={() => toggleChildSessions(session.id)}
              onSelect={() => selectSession(session)}
              onTogglePin={() => toggleSessionPinned(session)}
              onDockRight={() => dockSessionRight(session)}
              onArchive={() => archiveSession(session)}
              onRename={renameSession}
            />
            {renderChildSessionRows(session, { nested: true })}
          </div>
        ))}
        {sessions.length > SIDEBAR_SECTION_LIMIT && (canShowMoreProjectChats || canShowLessProjectChats) && (
          <div
            className="sidebar-pagination-controls"
            aria-label={`Showing ${visibleSessions.length} of ${sessions.length} project chats`}
          >
            {canShowMoreProjectChats ? (
              <SidebarShowMoreButton onClick={() => showMoreProjectChats(item.id, sessions.length)}>
                Show more
              </SidebarShowMoreButton>
            ) : null}
            {canShowLessProjectChats ? (
              <SidebarShowMoreButton onClick={() => showLessProjectChats(item.id, sessions.length)}>
                Show less
              </SidebarShowMoreButton>
            ) : null}
          </div>
        )}
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

  const canShowMoreChats = visibleChatRows.length < chatRows.length;
  const canShowLessChats = visibleChatRows.length > SIDEBAR_SECTION_LIMIT;

  function showMoreChats() {
    setChatRowsVisibleCount((count) => nextSidebarChatVisibleCount(count, chatRows.length));
  }

  function showLessChats() {
    setChatRowsVisibleCount((count) => previousSidebarChatVisibleCount(count, chatRows.length));
  }

  function renderChildSessionRows(parentSession: Session, options: { nested?: boolean } = {}) {
    const childSessions = childSessionsFor(parentSession);
    if (childSessions.length === 0 || !childSessionsExpanded(parentSession, childSessions)) return null;
    const groupClassName = ["sidebar-child-session-group", options.nested ? "nested" : ""].filter(Boolean).join(" ");

    return (
      <div className={groupClassName}>
        {childSessions.map((session) => (
          <SidebarSessionRow
            key={session.id}
            session={session}
            selected={view === "chat" && selectedSessionId === session.id}
            hideIcon
            nested
            running={runningSessionIds.has(session.id)}
            goalRuntime={goalRuntimeBySessionId.get(session.id) ?? null}
            subagentRuntime={subagentRuntimeBySessionId.get(session.id) ?? null}
            terminalIndicator={terminalIndicatorForSession(session.id)}
            onSelect={() => selectSession(session)}
            onTogglePin={() => toggleSessionPinned(session)}
            onDockRight={() => dockSessionRight(session)}
            onArchive={() => archiveSession(session)}
            onRename={renameSession}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="sidebar-scroll">
      {teamChatEnabled ? (
        <SidebarSection
          label={teamChatOrganization?.displayName ?? "Team"}
          actions={
            teamChatOrganization ? (
              <button
                type="button"
                className="section-icon"
                data-tooltip={teamChatOrganization.canManageBilling ? "Workspace billing" : "Workspace usage"}
                aria-label={teamChatOrganization.canManageBilling ? "Open workspace billing" : "Open workspace usage"}
                onClick={() => void openTeamWorkspaceSettings(account, teamChatOrganization)}
              >
                <Settings size={14} />
              </button>
            ) : null
          }
        >
          {teamChatOrganization ? (
            <div className="team-sidebar-workspace-meta">
              <span>{teamPlanLabel(teamChatOrganization.planKey)}</span>
              <span>{teamRoleLabel(teamChatOrganization.role)}</span>
              {teamChatOrganization.effectiveAccessState && teamChatOrganization.effectiveAccessState !== "active" ? (
                <span>{teamAccessLabel(teamChatOrganization.effectiveAccessState)}</span>
              ) : null}
            </div>
          ) : null}
          {generalThread ? (
            <TeamSidebarRow
              label="general"
              selected={view === "team" && selectedTeamThreadId === generalThread.id}
              unreadCount={generalThread.unreadCount}
              onSelect={() => selectTeamThread(generalThread.id)}
            />
          ) : null}
          {teamMembers
            .filter((member) => member.userId !== currentUserId)
            .map((member) => {
              const thread = dmThreadByUserId.get(member.userId) ?? null;
              return (
                <TeamSidebarRow
                  key={member.userId}
                  member={member}
                  label={member.name}
                  selected={view === "team" && selectedTeamThreadId === thread?.id}
                  unreadCount={thread?.unreadCount ?? 0}
                  onSelect={() => openTeamDm(member.userId)}
                />
              );
            })}
          {!generalThread && teamMembers.length === 0 ? (
            <div className="empty-row">
              {teamChatLoading ? "Loading team..." : "Team unavailable"}
            </div>
          ) : null}
        </SidebarSection>
      ) : null}

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
                  workspaceState={row.item.kind === "local" ? workspaceStates[row.item.project.id] ?? null : null}
                  cloudWorkItems={cloudWorkItemsByProjectId[row.item.id] ?? []}
                  cloudLinkTrusted={row.item.cloudLinkTrusted}
                  cloudLinkWarning={row.item.cloudLinkWarning}
                  placeholder={isDraggedRow}
                  terminalIndicator={terminalIndicatorForProject(row.item.id)}
                  onSelect={() => selectProjectRow(row.item)}
                  onNewChat={() => beginProjectChat(row.item)}
                  onMoveToCloud={row.item.kind === "local" ? () => moveProjectToCloud(row.item) : undefined}
                  onWorkspaceTargetSelect={(target) => switchProjectWorkspaceTarget(row.item.id, target)}
                  onTogglePin={() => toggleProjectPinned(row.item)}
                  onToggleSystemVisibility={
                    row.item.kind === "local" && row.item.project.systemKind
                      ? () => toggleSystemProjectVisibility(row.item)
                      : undefined
                  }
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
            <div key={row.key} className="sidebar-session-group">
              <SidebarSessionRow
                session={row.session}
                selected={view === "chat" && selectedSessionId === row.id}
                hideIcon
                placeholder={isDraggedRow}
                running={runningSessionIds.has(row.session.id)}
                goalRuntime={goalRuntimeBySessionId.get(row.session.id) ?? null}
                subagentRuntime={subagentRuntimeBySessionId.get(row.session.id) ?? null}
                terminalIndicator={terminalIndicatorForSession(row.session.id)}
                childSessionCount={childSessionsFor(row.session).length}
                childSessionsExpanded={childSessionsExpanded(row.session, childSessionsFor(row.session))}
                onToggleChildSessions={() => toggleChildSessions(row.session.id)}
                onSelect={() => selectSession(row.session)}
                onTogglePin={() => toggleSessionPinned(row.session)}
                onDockRight={() => dockSessionRight(row.session)}
                onArchive={() => archiveSession(row.session)}
                onRename={renameSession}
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
              {!isDraggedRow && renderChildSessionRows(row.session)}
            </div>
          );
        })}
      </SidebarSection>

      <SidebarSection
        label="Projects"
        collapsed={projectsCollapsed}
        onToggleCollapsed={onToggleProjectsCollapsed}
        actions={
          <>
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
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSectionMenuOpen(null);
                      startExistingProjectFromPath();
                    }}
                  >
                    <FolderOpen size={13} />
                    <span>Use existing folder path</span>
                  </button>
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
                    <span>New Cloud task</span>
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
            <div className="section-menu">
              <button
                type="button"
                className={`section-icon ${sectionMenuOpen === "projects-options" ? "active" : ""}`}
                data-tooltip="Projects options"
                aria-label="Projects options"
                aria-haspopup="menu"
                aria-expanded={sectionMenuOpen === "projects-options"}
                onClick={() =>
                  setSectionMenuOpen((current) => (current === "projects-options" ? null : "projects-options"))
                }
              >
                <MoreHorizontal size={14} />
              </button>
              {sectionMenuOpen === "projects-options" && (
                <div className="section-menu-popover" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={insightsSystemProjectHidden === null}
                    onClick={() => {
                      setSectionMenuOpen(null);
                      toggleInsightsSystemProjectVisibility();
                    }}
                  >
                    {insightsSystemProjectHidden === false ? <EyeOff size={13} /> : <Eye size={13} />}
                    <span>
                      {insightsSystemProjectHidden === false ? "Hide Insights folder" : "Show Insights folder"}
                    </span>
                  </button>
                </div>
              )}
            </div>
          </>
        }
      >
        {visibleProjectRows.map((item) => (
          <div key={item.id} className="sidebar-project-group">
            <SidebarProjectRow
              kind={item.kind}
              project={item.project}
              pinned={item.pinned}
              selected={view === "chat" && selectedProjectId === item.id && !selectedSessionId}
              expanded={expandedProjectIds.has(item.id)}
              workspaceState={item.kind === "local" ? workspaceStates[item.project.id] ?? null : null}
              cloudWorkItems={cloudWorkItemsByProjectId[item.id] ?? []}
              cloudLinkTrusted={item.cloudLinkTrusted}
              cloudLinkWarning={item.cloudLinkWarning}
              terminalIndicator={terminalIndicatorForProject(item.id)}
              onSelect={() => selectProjectRow(item)}
              onNewChat={() => beginProjectChat(item)}
              onMoveToCloud={item.kind === "local" ? () => moveProjectToCloud(item) : undefined}
              onWorkspaceTargetSelect={(target) => switchProjectWorkspaceTarget(item.id, target)}
              onTogglePin={() => toggleProjectPinned(item)}
              onToggleSystemVisibility={
                item.kind === "local" && item.project.systemKind ? () => toggleSystemProjectVisibility(item) : undefined
              }
              onRemove={() => removeProject(item)}
            />
            {renderProjectChildren(item)}
          </div>
        ))}
        {visibleProjectRows.length === 0 && localProjectRows.length === 0 && cloudProjectRows.length === 0 && (
          <div className="empty-row">No projects</div>
        )}
        {projectsSectionRows.length > SIDEBAR_SECTION_LIMIT && (
          <SidebarShowMoreButton
            expanded={projectsExpanded}
            onClick={() => setProjectsExpanded((expanded) => !expanded)}
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
            <button
              className="section-icon"
              data-tooltip="New task"
              aria-label="New task"
              onClick={() => beginNewChat(null)}
            >
              <SquarePen size={14} />
            </button>
          </>
        }
      >
        {visibleChatRows.map((session) =>
          session.archived ? (
            <div key={session.id} className="sidebar-session-group">
              <SidebarSessionRow
                session={session}
                selected={false}
                archived
                hideIcon
                running={runningSessionIds.has(session.id)}
                goalRuntime={goalRuntimeBySessionId.get(session.id) ?? null}
                subagentRuntime={subagentRuntimeBySessionId.get(session.id) ?? null}
                terminalIndicator={terminalIndicatorForSession(session.id)}
                childSessionCount={childSessionsFor(session).length}
                childSessionsExpanded={childSessionsExpanded(session, childSessionsFor(session))}
                onToggleChildSessions={() => toggleChildSessions(session.id)}
                onSelect={() => {
                  restoreSession(session);
                  selectSession(session);
                }}
                onTogglePin={() => toggleSessionPinned(session)}
                onDockRight={() => dockSessionRight(session)}
                onArchive={() => restoreSession(session)}
                onRename={renameSession}
              />
              {renderChildSessionRows(session)}
            </div>
          ) : (
            <div key={session.id} className="sidebar-session-group">
              <SidebarSessionRow
                session={session}
                selected={view === "chat" && selectedSessionId === session.id}
                hideIcon
                running={runningSessionIds.has(session.id)}
                goalRuntime={goalRuntimeBySessionId.get(session.id) ?? null}
                subagentRuntime={subagentRuntimeBySessionId.get(session.id) ?? null}
                terminalIndicator={terminalIndicatorForSession(session.id)}
                childSessionCount={childSessionsFor(session).length}
                childSessionsExpanded={childSessionsExpanded(session, childSessionsFor(session))}
                onToggleChildSessions={() => toggleChildSessions(session.id)}
                onSelect={() => selectSession(session)}
                onTogglePin={() => toggleSessionPinned(session)}
                onDockRight={() => dockSessionRight(session)}
                onArchive={() => archiveSession(session)}
                onRename={renameSession}
              />
              {renderChildSessionRows(session)}
            </div>
          )
        )}
        {chatRows.length === 0 && <div className="empty-row">No chats</div>}
        {chatRows.length > SIDEBAR_SECTION_LIMIT && (canShowMoreChats || canShowLessChats) && (
          <div
            className="sidebar-pagination-controls"
            aria-label={`Showing ${visibleChatRows.length} of ${chatRows.length} chats`}
          >
            {canShowMoreChats ? <SidebarShowMoreButton onClick={showMoreChats}>Show more</SidebarShowMoreButton> : null}
            {canShowLessChats ? <SidebarShowMoreButton onClick={showLessChats}>Show less</SidebarShowMoreButton> : null}
          </div>
        )}
      </SidebarSection>
    </div>
  );
}

function TeamSidebarRow({
  label,
  member,
  selected,
  unreadCount,
  onSelect,
}: {
  label: string;
  member?: TeamChatMember;
  selected: boolean;
  unreadCount: number;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`team-sidebar-row${selected ? " selected" : ""}`} onClick={onSelect}>
      {member ? <TeamSidebarAvatar member={member} /> : <span className="team-sidebar-channel">#</span>}
      <span className="team-sidebar-label">{label}</span>
      {unreadCount > 0 ? (
        <span className="team-sidebar-unread" aria-label={`${unreadCount} unread`}>
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
    </button>
  );
}

function TeamSidebarAvatar({ member }: { member: TeamChatMember }) {
  if (member.image) return <img className="team-sidebar-avatar" src={member.image} alt="" />;
  const initials = member.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return <span className="team-sidebar-avatar fallback">{initials || "?"}</span>;
}

function teamPlanLabel(planKey: string | null | undefined): string {
  if (!planKey) return "Workspace";
  return `${planKey.charAt(0).toUpperCase()}${planKey.slice(1)}`;
}

function teamRoleLabel(role: OpenPondOrganization["role"]): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

function teamAccessLabel(state: NonNullable<OpenPondOrganization["effectiveAccessState"]>): string {
  if (state === "checkout_pending") return "Checkout pending";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

async function openTeamWorkspaceSettings(
  account: SidebarProps["account"],
  organization: OpenPondOrganization,
): Promise<void> {
  const baseUrl = (account?.activeProfile?.baseUrl ?? account?.baseUrl ?? "https://openpond.ai").replace(/\/+$/, "");
  const tab = organization.canManageBilling ? "billing" : "usage";
  const url = `${baseUrl}/sandboxes/${encodeURIComponent(organization.slug)}/billing?tab=${tab}`;
  const browser = window.openpond?.browser;
  if (browser?.openExternal) {
    const result = await browser.openExternal({
      conversationId: `team-workspace-${organization.teamId}`,
      url,
    });
    if (result.ok) return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
