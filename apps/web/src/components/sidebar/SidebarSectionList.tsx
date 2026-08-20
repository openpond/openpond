import type { Session } from "@openpond/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  SIDEBAR_CHAT_PAGE_SIZE,
  SIDEBAR_TASK_INITIAL_LIMIT,
  type SidebarProjectItem,
} from "../../lib/app-models";
import { projectlessSidebarSessionLabel } from "../../lib/experience-sessions";
import { isTaskDraftSession } from "../../lib/task-drafts";
import { sessionTaskset } from "../../lib/session-tasksets";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import {
  isSidebarTaskPinned,
  sidebarTaskEmptyLabel,
  sidebarTaskRows,
  sidebarTaskShortcutState,
  type SidebarTaskFilter,
  type SidebarTaskSort,
  type SidebarTasksetFilterOption,
} from "../../lib/sidebar-task-list";
import {
  sidebarTerminalIndicator,
  terminalScopeKey,
  type TerminalScopeSummary,
} from "../terminal/terminal-state";
import type { SidebarProps } from "./Sidebar.types";
import {
  SidebarFileRow,
  SidebarProjectRow,
  SidebarSection,
  SidebarSessionRow,
  SidebarShowMoreButton,
} from "./SidebarRows";
import { SidebarTaskListControls } from "./SidebarTaskListControls";
import {
  SidebarTaskDetailPopover,
  sidebarTaskDetailPosition,
  type SidebarTaskDetail,
} from "./SidebarTaskDetailPopover";
import {
  SidebarTaskProjectGroup,
  type SidebarTaskGroupKind,
} from "./SidebarTaskProjectGroup";

const EMPTY_TERMINAL_SUMMARIES: Record<string, TerminalScopeSummary> = {};
const EMPTY_GOAL_RUNTIME_BY_SESSION_ID = new Map<string, GoalRuntimeStatus>();
const EMPTY_SUBAGENT_RUNTIME_BY_SESSION_ID = new Map<
  string,
  SubagentRuntimeStatus
>();

export function nextSidebarChatVisibleCount(
  currentCount: number,
  totalCount: number
): number {
  return Math.min(
    Math.max(currentCount, SIDEBAR_TASK_INITIAL_LIMIT) +
      SIDEBAR_CHAT_PAGE_SIZE,
    totalCount
  );
}

export function previousSidebarChatVisibleCount(
  currentCount: number,
  totalCount: number
): number {
  const boundedCount = Math.max(
    SIDEBAR_TASK_INITIAL_LIMIT,
    Math.min(currentCount, totalCount)
  );
  if (boundedCount <= SIDEBAR_TASK_INITIAL_LIMIT)
    return SIDEBAR_TASK_INITIAL_LIMIT;
  const pageCount = Math.ceil(
    (boundedCount - SIDEBAR_TASK_INITIAL_LIMIT) / SIDEBAR_CHAT_PAGE_SIZE
  );
  return Math.max(
    SIDEBAR_TASK_INITIAL_LIMIT,
    SIDEBAR_TASK_INITIAL_LIMIT + (pageCount - 1) * SIDEBAR_CHAT_PAGE_SIZE
  );
}

export type SidebarTaskGroup = {
  key: string;
  label: string;
  projectId: string | null;
  project: SidebarProjectItem | null;
  kind: SidebarTaskGroupKind;
  sessions: Session[];
};

export function groupSidebarTaskRows(
  sessions: Session[],
  resolveGroup: (session: Session) => Omit<SidebarTaskGroup, "sessions">,
): SidebarTaskGroup[] {
  const groups = new Map<string, SidebarTaskGroup>();
  for (const session of sessions) {
    const resolved = resolveGroup(session);
    const current = groups.get(resolved.key);
    if (current) current.sessions.push(session);
    else groups.set(resolved.key, { ...resolved, sessions: [session] });
  }
  return [...groups.values()];
}

export function SidebarSectionList({
  activeSessions,
  archiveSession,
  archivedSessions,
  chatRowsVisibleCount,
  childSessionRowsByParentId = {},
  cloudProjectRows,
  beginProjectChat,
  commitTaskDrop,
  commitTaskPreviewDrop,
  dockSessionRight,
  experience = "work",
  goalRuntimeBySessionId = EMPTY_GOAL_RUNTIME_BY_SESSION_ID,
  localProjectRows,
  openSidebarFile,
  pinnedCollapsed,
  pinnedRows,
  previewTaskDrop,
  previewPinnedDrop,
  projectRows,
  renameSession,
  restoreSession,
  runningSessionIds,
  savedForLaterSessions,
  sectionMenuOpen,
  selectedProjectId,
  selectedSessionId,
  setChatRowsVisibleCount,
  setSectionMenuOpen,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setView,
  sidebarProjectIdBySessionId,
  startTaskDrag,
  startPinnedDrag,
  subagentRuntimeBySessionId = EMPTY_SUBAGENT_RUNTIME_BY_SESSION_ID,
  taskDragSessionId,
  taskPreviewSessionIds,
  terminalSummaries = EMPTY_TERMINAL_SUMMARIES,
  toggleSessionPinned,
  toggleSessionSavedForLater,
  view,
  clearTaskDrag,
  removeProject,
  toggleProjectPinned,
  onTogglePinnedCollapsed,
  setSidebarFileStatus,
  commitPinnedDrop,
  commitPinnedPreviewDrop,
  clearSidebarDrag,
  dragItem,
}: SidebarProps) {
  const [taskFilter, setTaskFilter] = useState<SidebarTaskFilter>("active");
  const [taskSort, setTaskSort] = useState<SidebarTaskSort>("recent");
  const [groupByProject, setGroupByProject] = useState(experience !== "chat");
  const [selectedTasksetId, setSelectedTasksetId] = useState<string | null>(
    null
  );
  const [expandedChildSessionParentIds, setExpandedChildSessionParentIds] =
    useState<Set<string>>(() => new Set());
  const [taskGroupExpansion, setTaskGroupExpansion] = useState<
    Map<string, boolean>
  >(() => new Map());
  const [activeTaskDetail, setActiveTaskDetail] =
    useState<SidebarTaskDetail | null>(null);
  const taskNoun = experience === "chat" ? "chats" : "tasks";
  const taskSectionLabel = experience === "chat" ? "Chats" : "Tasks";
  const regularActiveSessions = useMemo(
    () => activeSessions.filter((session) => sessionTaskset(session) === null),
    [activeSessions],
  );
  const regularSavedForLaterSessions = useMemo(
    () => savedForLaterSessions.filter((session) => sessionTaskset(session) === null),
    [savedForLaterSessions],
  );
  const activeTaskCount = Math.max(
    0,
    regularActiveSessions.length - regularSavedForLaterSessions.length
  );
  const taskShortcut = sidebarTaskShortcutState({
    activeCount: activeTaskCount,
    filter: taskFilter,
    savedForLaterCount: regularSavedForLaterSessions.length,
  });
  const projectsSectionRows = projectRows ?? [
    ...localProjectRows,
    ...cloudProjectRows,
  ];
  const projectLabelById = useMemo(
    () =>
      new Map(
        projectsSectionRows.map((item) => [item.id, item.project.name] as const)
      ),
    [projectsSectionRows]
  );
  const projectRowById = useMemo(
    () => new Map(projectsSectionRows.map((item) => [item.id, item] as const)),
    [projectsSectionRows],
  );
  const inProgressSessionIds = useMemo(() => {
    const next = new Set(runningSessionIds);
    for (const session of activeSessions) {
      const goalRuntime = goalRuntimeBySessionId.get(session.id);
      const subagentRuntime = subagentRuntimeBySessionId.get(session.id);
      if (
        (goalRuntime?.tone === "active" && goalRuntime.status !== "queued") ||
        (subagentRuntime?.activeCount ?? 0) > 0 ||
        terminalIndicatorForSession(session.id)?.status === "running"
      ) {
        next.add(session.id);
      }
    }
    return next;
  }, [
    activeSessions,
    goalRuntimeBySessionId,
    runningSessionIds,
    subagentRuntimeBySessionId,
    terminalSummaries,
  ]);
  const allManualTaskRows = useMemo(
    () =>
      sidebarTaskRows({
        activeSessions,
        doneSessions: archivedSessions,
        filter: "all",
        inProgressSessionIds,
        sort: "manual",
      }),
    [activeSessions, archivedSessions, inProgressSessionIds]
  );
  const filteredTaskRows = useMemo(
    () =>
      sidebarTaskRows({
        activeSessions,
        doneSessions: archivedSessions,
        filter: taskFilter,
        inProgressSessionIds,
        selectedTasksetId,
        previewSessionIds: taskPreviewSessionIds,
        sort: taskSort,
      }),
    [
      activeSessions,
      archivedSessions,
      inProgressSessionIds,
      selectedTasksetId,
      taskFilter,
      taskPreviewSessionIds,
      taskSort,
    ]
  );
  const tasksetOptions = useMemo<SidebarTasksetFilterOption[]>(
    () => {
      const byId = new Map<string, SidebarTasksetFilterOption>();
      for (const session of [...activeSessions, ...archivedSessions]) {
        const taskset = sessionTaskset(session);
        if (!taskset) continue;
        const current = byId.get(taskset.id);
        if (current) current.chatCount += 1;
        else byId.set(taskset.id, { ...taskset, chatCount: 1 });
      }
      return [...byId.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
      );
    },
    [activeSessions, archivedSessions]
  );
  const visibleTaskRows = useMemo(
    () =>
      filteredTaskRows
        .filter((session) => !isSidebarTaskPinned(session))
        .slice(0, Math.max(SIDEBAR_TASK_INITIAL_LIMIT, chatRowsVisibleCount)),
    [chatRowsVisibleCount, filteredTaskRows],
  );
  const groupedTaskRows = useMemo(
    () =>
      groupSidebarTaskRows(visibleTaskRows, (session) => {
        if (isTaskDraftSession(session)) {
          return {
            key: "draft",
            label: "Drafts",
            projectId: null,
            project: null,
            kind: "draft" as const,
          };
        }
        const projectId = sidebarProjectIdBySessionId[session.id];
        const label = projectLabelForSession(session) ?? "No project";
        return {
          key: projectId ? `project:${projectId}` : `projectless:${label}`,
          label,
          projectId: projectId ?? null,
          project: projectId ? (projectRowById.get(projectId) ?? null) : null,
          kind: projectId ? ("project" as const) : ("projectless" as const),
        };
      }),
    [projectLabelById, projectRowById, sidebarProjectIdBySessionId, visibleTaskRows],
  );
  const canShowMoreTasks = visibleTaskRows.length < filteredTaskRows.length;
  const canShowLessTasks =
    visibleTaskRows.length > SIDEBAR_TASK_INITIAL_LIMIT;
  const forcedExpandedTaskGroupKeys = useMemo(
    () =>
      new Set(
        groupedTaskRows
          .filter((group) =>
            group.sessions.some(
              (session) =>
                session.id === selectedSessionId ||
                inProgressSessionIds.has(session.id),
            ),
          )
          .map((group) => group.key),
      ),
    [groupedTaskRows, inProgressSessionIds, selectedSessionId],
  );
  const allManualTaskIds = allManualTaskRows
    .filter((session) => !isSidebarTaskPinned(session))
    .map((session) => session.id);
  const filteredTaskIds = visibleTaskRows.map((session) => session.id);
  const activeChildSessionExpansionKey = JSON.stringify(
    Object.entries(childSessionRowsByParentId)
      .filter(
        ([parentSessionId, childSessions]) =>
          childSessions.length > 0 &&
          (subagentRuntimeBySessionId.get(parentSessionId)?.activeCount ?? 0) >
            0
      )
      .flatMap(([parentSessionId, childSessions]) =>
        childSessions.map(
          (childSession) => [parentSessionId, childSession.id] as const
        )
      )
      .sort(
        ([leftParent, leftChild], [rightParent, rightChild]) =>
          leftParent.localeCompare(rightParent) ||
          leftChild.localeCompare(rightChild)
      )
  );

  useEffect(() => {
    const activeChildren = JSON.parse(activeChildSessionExpansionKey) as Array<
      [string, string]
    >;
    if (activeChildren.length === 0) return;
    const parentSessionIds = new Set(
      activeChildren.map(([parentSessionId]) => parentSessionId)
    );
    setExpandedChildSessionParentIds((current) => {
      if (
        [...parentSessionIds].every((parentSessionId) =>
          current.has(parentSessionId)
        )
      ) {
        return current;
      }
      return new Set([...current, ...parentSessionIds]);
    });
  }, [activeChildSessionExpansionKey]);

  function terminalIndicatorForSession(sessionId: string) {
    return sidebarTerminalIndicator(
      terminalSummaries[terminalScopeKey({ kind: "session", id: sessionId })]
    );
  }

  function projectLabelForSession(session: Session): string | null {
    if (isTaskDraftSession(session)) return "Draft";
    const projectId = sidebarProjectIdBySessionId[session.id];
    if (projectId) {
      return (
        projectLabelById.get(projectId) ?? session.workspaceName ?? "Project"
      );
    }
    return projectlessSidebarSessionLabel(session);
  }

  function selectSession(session: Session) {
    setSelectedSessionId(session.id);
    const projectId = sidebarProjectIdBySessionId[session.id] ?? null;
    setSelectedAppId(projectId ? null : session.appId);
    setSelectedProjectId(projectId);
    setView("chat");
  }

  function childSessionsFor(session: Session): Session[] {
    return childSessionRowsByParentId[session.id] ?? [];
  }

  function childSessionsExpanded(
    parentSession: Session,
    childSessions: Session[]
  ): boolean {
    return (
      expandedChildSessionParentIds.has(parentSession.id) ||
      childSessions.some((session) => session.id === selectedSessionId)
    );
  }

  function toggleChildSessions(parentSessionId: string) {
    setExpandedChildSessionParentIds((current) => {
      const next = new Set(current);
      if (next.has(parentSessionId)) next.delete(parentSessionId);
      else next.add(parentSessionId);
      return next;
    });
  }

  function renderChildSessionRows(parentSession: Session) {
    const childSessions = childSessionsFor(parentSession);
    if (
      childSessions.length === 0 ||
      !childSessionsExpanded(parentSession, childSessions)
    ) {
      return null;
    }

    return (
      <div className="sidebar-child-session-group">
        {childSessions.map((session) => (
          <SidebarSessionRow
            key={session.id}
            session={session}
            selected={view === "chat" && selectedSessionId === session.id}
            hideIcon
            nested
            running={inProgressSessionIds.has(session.id)}
            goalRuntime={goalRuntimeBySessionId.get(session.id) ?? null}
            subagentRuntime={subagentRuntimeBySessionId.get(session.id) ?? null}
            terminalIndicator={terminalIndicatorForSession(session.id)}
            projectLabel={projectLabelForSession(parentSession)}
            onSelect={() => selectSession(session)}
            onTogglePin={() => toggleSessionPinned(session)}
            onToggleSaveForLater={() => toggleSessionSavedForLater(session)}
            onDockRight={() => dockSessionRight(session)}
            onArchive={() =>
              session.archived
                ? restoreSession(session)
                : archiveSession(session)
            }
            onRename={renameSession}
          />
        ))}
      </div>
    );
  }

  function showTaskDetail(
    session: Session,
    projectLabel: string,
    target: HTMLElement,
  ) {
    if (typeof window === "undefined") return;
    setActiveTaskDetail({
      descriptionId: `sidebar-task-detail-${session.id}`,
      projectLabel,
      sessionId: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      style: sidebarTaskDetailPosition(target.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    });
  }

  function renderTaskSession(
    session: Session,
    options: {
      metadataPresentation?: "inline" | "hover-detail" | "flyout";
      projectLabel?: string | null;
    } = {},
  ) {
    const archived = session.archived;
    const isDragged = taskDragSessionId === session.id;
    const childSessions = childSessionsFor(session);
    const groupClassName = "sidebar-session-group";
    const dragProps =
      taskSort === "manual"
        ? {
            onDragStart: (event: React.DragEvent<HTMLDivElement>) =>
              startTaskDrag(event, {
                allSessionIds: allManualTaskIds,
                visibleSessionIds: filteredTaskIds,
                sessionId: session.id,
              }),
            onDragEnd: clearTaskDrag,
            onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
              if (!isDragged) previewTaskDrop(event, session.id);
            },
            onDrop: (event: React.DragEvent<HTMLDivElement>) => {
              if (isDragged) commitTaskPreviewDrop();
              else commitTaskDrop(event, session.id);
            },
          }
        : {};

    return (
      <div
        key={session.id}
        className={groupClassName}
        onPointerEnter={
          options.metadataPresentation === "flyout" && options.projectLabel
            ? (event) => showTaskDetail(session, options.projectLabel!, event.currentTarget)
            : undefined
        }
        onPointerLeave={
          options.metadataPresentation === "flyout"
            ? () => setActiveTaskDetail(null)
            : undefined
        }
        onFocusCapture={
          options.metadataPresentation === "flyout" && options.projectLabel
            ? (event) => showTaskDetail(session, options.projectLabel!, event.currentTarget)
            : undefined
        }
        onBlurCapture={
          options.metadataPresentation === "flyout"
            ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setActiveTaskDetail(null);
                }
              }
            : undefined
        }
      >
        <SidebarSessionRow
          session={session}
          selected={
            !archived && view === "chat" && selectedSessionId === session.id
          }
          archived={archived}
          hideIcon
          placeholder={isDragged}
          running={inProgressSessionIds.has(session.id)}
          goalRuntime={goalRuntimeBySessionId.get(session.id) ?? null}
          subagentRuntime={subagentRuntimeBySessionId.get(session.id) ?? null}
          terminalIndicator={terminalIndicatorForSession(session.id)}
          projectLabel={
            options.projectLabel === undefined
              ? projectLabelForSession(session)
              : options.projectLabel
          }
          metadataPresentation={options.metadataPresentation}
          ariaDescribedBy={
            options.metadataPresentation === "flyout" &&
            activeTaskDetail?.sessionId === session.id
              ? activeTaskDetail.descriptionId
              : undefined
          }
          childSessionCount={childSessions.length}
          childSessionsExpanded={childSessionsExpanded(session, childSessions)}
          onToggleChildSessions={() => toggleChildSessions(session.id)}
          onSelect={() => {
            setActiveTaskDetail(null);
            if (archived) restoreSession(session);
            selectSession(session);
          }}
          onTogglePin={() => toggleSessionPinned(session)}
          onToggleSaveForLater={() => toggleSessionSavedForLater(session)}
          onDockRight={() => dockSessionRight(session)}
          onArchive={() =>
            archived ? restoreSession(session) : archiveSession(session)
          }
          onRename={renameSession}
          {...dragProps}
        />
        {!isDragged ? renderChildSessionRows(session) : null}
      </div>
    );
  }

  function changeTaskFilter(nextFilter: SidebarTaskFilter) {
    if (nextFilter !== "tasksets") setSelectedTasksetId(null);
    setTaskFilter(nextFilter);
    setChatRowsVisibleCount(SIDEBAR_TASK_INITIAL_LIMIT);
  }

  function changeTasksetFilter(tasksetId: string | null) {
    setSelectedTasksetId(tasksetId);
    setTaskFilter("tasksets");
    setChatRowsVisibleCount(SIDEBAR_TASK_INITIAL_LIMIT);
  }

  function changeTaskSort(nextSort: SidebarTaskSort) {
    setTaskSort(nextSort);
    setChatRowsVisibleCount(SIDEBAR_TASK_INITIAL_LIMIT);
  }

  function showMoreTasks() {
    setChatRowsVisibleCount((count) =>
      nextSidebarChatVisibleCount(count, filteredTaskRows.length)
    );
  }

  function showLessTasks() {
    setChatRowsVisibleCount((count) =>
      previousSidebarChatVisibleCount(count, filteredTaskRows.length)
    );
  }

  function pinnedDragProps(item: {
    id: string;
    type: "file" | "project" | "session";
  }) {
    const dragTarget = { id: item.id, type: item.type } as const;
    return {
      onDragStart: (event: React.DragEvent<HTMLDivElement>) =>
        startPinnedDrag(event, dragTarget),
      onDragEnd: clearSidebarDrag,
      onDragOver: (event: React.DragEvent<HTMLDivElement>) =>
        previewPinnedDrop(event, dragTarget),
      onDrop: (event: React.DragEvent<HTMLDivElement>) => {
        if (dragItem?.id === item.id && dragItem.type === item.type) {
          commitPinnedPreviewDrop();
        } else {
          commitPinnedDrop(event, dragTarget);
        }
      },
    };
  }

  function renderPinnedRow(row: (typeof pinnedRows)[number]) {
    const dragProps = pinnedDragProps(row);
    const placeholder = dragItem?.id === row.id && dragItem.type === row.type;
    if (row.type === "project") {
      const project = row.item;
      return (
        <SidebarProjectRow
          key={row.key}
          kind={project.kind}
          project={project.project}
          pinned
          selected={view === "chat" && selectedProjectId === project.id}
          expanded={false}
          disclosure={false}
          placeholder={placeholder}
          onSelect={() => {
            setSelectedAppId(null);
            setSelectedProjectId(project.id);
            setSelectedSessionId(null);
            setView("chat");
          }}
          onNewChat={() => beginProjectChat(project.id)}
          onTogglePin={() => toggleProjectPinned(project)}
          onRemove={() => removeProject(project)}
          {...dragProps}
        />
      );
    }
    if (row.type === "file") {
      return (
        <SidebarFileRow
          key={row.key}
          file={row.file}
          placeholder={placeholder}
          onSelect={() => openSidebarFile(row.file)}
          onTogglePin={() => setSidebarFileStatus(row.file, "none")}
          onToggleSaveForLater={() =>
            setSidebarFileStatus(row.file, "saved_for_later")
          }
          {...dragProps}
        />
      );
    }
    const session = row.session;
    return (
      <SidebarSessionRow
        key={row.key}
        session={session}
        selected={view === "chat" && selectedSessionId === session.id}
        hideIcon
        placeholder={placeholder}
        running={inProgressSessionIds.has(session.id)}
        goalRuntime={goalRuntimeBySessionId.get(session.id) ?? null}
        subagentRuntime={subagentRuntimeBySessionId.get(session.id) ?? null}
        terminalIndicator={terminalIndicatorForSession(session.id)}
        projectLabel={projectLabelForSession(session)}
        metadataPresentation="flyout"
        onSelect={() => selectSession(session)}
        onTogglePin={() => toggleSessionPinned(session)}
        onToggleSaveForLater={() => toggleSessionSavedForLater(session)}
        onDockRight={() => dockSessionRight(session)}
        onArchive={() => archiveSession(session)}
        onRename={renameSession}
        {...dragProps}
      />
    );
  }

  return (
    <div className="sidebar-scroll">
      <SidebarSection
        label={taskSectionLabel}
        className={`sidebar-task-section${
          experience !== "chat" ? " development" : ""
        }`}
        titleAccessory={
          experience !== "chat" ? (
            <div className="sidebar-task-mode-buttons">
              <button
                type="button"
                className={`section-icon sidebar-task-count-bubble${
                  taskFilter === "saved_for_later" ? " active" : ""
                }`}
                aria-label={`Show ${taskShortcut.count} ${
                  taskShortcut.targetLabel
                } ${taskShortcut.count === 1 ? "task" : "tasks"}`}
                onClick={() => changeTaskFilter(taskShortcut.targetFilter)}
              >
                <span>{taskShortcut.label}</span>
                <span className="sidebar-task-count-badge" aria-hidden="true">
                  {taskShortcut.count > 99 ? "99+" : taskShortcut.count}
                </span>
              </button>
            </div>
          ) : null
        }
        actionsVisible={
          sectionMenuOpen === "chats" || sectionMenuOpen === "tasks-filter"
        }
        actions={
          <SidebarTaskListControls
            filter={taskFilter}
            groupByProject={groupByProject}
            noun={taskNoun}
            onFilterChange={changeTaskFilter}
            onGroupByProjectChange={setGroupByProject}
            onTasksetChange={changeTasksetFilter}
            onSortChange={changeTaskSort}
            openMenu={sectionMenuOpen}
            setOpenMenu={setSectionMenuOpen}
            sort={taskSort}
            selectedTasksetId={selectedTasksetId}
            tasksets={tasksetOptions}
          />
        }
      >
        {pinnedRows.length > 0 ? (
          <SidebarSection
            label="Pinned"
            className="sidebar-pinned-section"
            collapsed={pinnedCollapsed}
            onToggleCollapsed={onTogglePinnedCollapsed}
          >
            {pinnedRows.map(renderPinnedRow)}
          </SidebarSection>
        ) : null}
        {groupByProject && experience !== "chat"
          ? groupedTaskRows.map((group) => {
              const expanded =
                forcedExpandedTaskGroupKeys.has(group.key) ||
                taskGroupExpansion.get(group.key) !== false;
              return (
                <SidebarTaskProjectGroup
                  key={group.key}
                  expanded={expanded}
                  groupKey={group.key}
                  kind={group.kind}
                  label={group.label}
                  onToggle={() => {
                    setTaskGroupExpansion((current) => {
                      const next = new Map(current);
                      next.set(group.key, !expanded);
                      return next;
                    });
                  }}
                  onNewTask={group.project ? () => beginProjectChat(group.project!.id) : undefined}
                  onOpenProject={group.project ? () => {
                    setSelectedAppId(null);
                    setSelectedProjectId(group.project!.id);
                    setSelectedSessionId(null);
                    setView("chat");
                  } : undefined}
                  onRemoveProject={group.project ? () => removeProject(group.project!) : undefined}
                  project={group.project}
                >
                  {group.sessions.map((session) =>
                    renderTaskSession(session, {
                      metadataPresentation: "flyout",
                      projectLabel: group.label,
                    }),
                  )}
                </SidebarTaskProjectGroup>
              );
            })
          : visibleTaskRows.map((session) => renderTaskSession(session))}
        {filteredTaskRows.length === 0 ? (
          <div className="empty-row">
            {sidebarTaskEmptyLabel(taskFilter, taskNoun)}
          </div>
        ) : null}
        {filteredTaskRows.length > SIDEBAR_TASK_INITIAL_LIMIT &&
        (canShowMoreTasks || canShowLessTasks) ? (
          <div
            className="sidebar-pagination-controls"
            aria-label={`Showing ${visibleTaskRows.length} of ${filteredTaskRows.length} ${taskNoun}`}
          >
            {canShowMoreTasks ? (
              <SidebarShowMoreButton onClick={showMoreTasks}>
                Show more
              </SidebarShowMoreButton>
            ) : null}
            {canShowLessTasks ? (
              <SidebarShowMoreButton onClick={showLessTasks}>
                Show less
              </SidebarShowMoreButton>
            ) : null}
          </div>
        ) : null}
      </SidebarSection>
      <SidebarTaskDetailPopover
        detail={activeTaskDetail}
        onClose={() => setActiveTaskDetail(null)}
      />
    </div>
  );
}
