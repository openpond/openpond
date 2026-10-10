import { SidebarNewThreadButton } from "./SidebarNavigation";
import { SidebarTeamAvatars } from "./SidebarTeamAvatars";
import { OPENPOND_ICON_URL } from "../../lib/public-assets";
import { SidebarWorkflowGroups } from "./SidebarWorkflowGroups";
import { Inbox, List } from "../icons";
import { clientChoiceStorage } from "../../lib/client-choice-storage";
import { orderSidebarInbox, sidebarInboxDateGroups, sidebarInboxTime } from "../../lib/sidebar-inbox";
import { useHydratedClientChoice } from "../../lib/client-choice-storage";
import type { Session } from "@openpond/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  SIDEBAR_CHAT_PAGE_SIZE,
  SIDEBAR_TASK_INITIAL_LIMIT,
  type SidebarProjectItem,
} from "../../lib/app-models";
import { isTaskDraftSession } from "../../lib/task-drafts";
import { sessionTaskset } from "../../lib/session-tasksets";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import {
  isSidebarTaskVisible,
  isSidebarTaskPinned,
  sidebarTaskEmptyLabel,
  sidebarTaskRows,
  type SidebarTaskFilter,
  type SidebarTaskSort,
  type SidebarTasksetFilterOption,
} from "../../lib/sidebar-task-list";
import {
  readSidebarTaskVisibilityPreferences,
  writeSidebarTaskVisibilityPreferences,
} from "../../lib/sidebar-task-visibility-preferences";
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
import { SidebarProjectsHeaderActions } from "./SidebarProjectsHeaderActions";
import {
  SidebarTaskDetailPopover,
  sidebarTaskDetailPosition,
  type SidebarTaskDetail,
} from "./SidebarTaskDetailPopover";
import {
  SidebarTaskProjectGroup,
  type SidebarTaskGroupKind,
} from "./SidebarTaskProjectGroup";
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import { isDesktopShell } from "../app-shell/WindowControls";

const EMPTY_TERMINAL_SUMMARIES: Record<string, TerminalScopeSummary> = {};
const EMPTY_GOAL_RUNTIME_BY_SESSION_ID = new Map<string, GoalRuntimeStatus>();
const EMPTY_SUBAGENT_RUNTIME_BY_SESSION_ID = new Map<
  string,
  SubagentRuntimeStatus
>();

function readSidebarPresentation(): "inbox" | "grouped" {
  const saved = clientChoiceStorage.getItem("openpond.sidebar.presentation.v1");
  if (saved === "inbox" || saved === "grouped") return saved;
  return isDesktopShell() ? "inbox" : "grouped";
}

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
  beginNewChat,
  account,
  teamChatEnabled,
  teamChatOrganization,
  selectedTeamId,
  teamMembers,
  currentUserId,
  openTeamDm,
  onOpenPonder,
  workflowGroups = [],
  workflowSessions = [],
  activityTimes = {},
  onSelectSession,
  archiveSession,
  archivedSessions,
  chatRowsVisibleCount,
  childSessionRowsByParentId = {},
  cloudProjectRows,
  beginProjectChat,
  onAddProject,
  commitTaskDrop,
  commitTaskPreviewDrop,
  dockSessionRight,
  goalRuntimeBySessionId = EMPTY_GOAL_RUNTIME_BY_SESSION_ID,
  localProjectRows,
  openSidebarFile,
  pinnedRows,
  previewTaskDrop,
  previewPinnedDrop,
  projectRows,
  renameSession,
  restoreSession,
  runningSessionIds,
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
  setSidebarFileStatus,
  commitPinnedDrop,
  commitPinnedPreviewDrop,
  clearSidebarDrag,
  dragItem,
}: SidebarProps) {
  const [presentation, setPresentation] = useState(readSidebarPresentation);
  useHydratedClientChoice(() => setPresentation(readSidebarPresentation()));
  const inboxView = presentation === "inbox";
  const [taskFilter, setTaskFilter] = useState<SidebarTaskFilter>("active");
  const [taskSort, setTaskSort] = useState<SidebarTaskSort>("recent");
  const [groupByProject, setGroupByProject] = useState(true);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [ordinaryCollapsed, setOrdinaryCollapsed] = useState(false);
  const [taskVisibility, setTaskVisibility] = useState(
    readSidebarTaskVisibilityPreferences,
  );
  useHydratedClientChoice(() => setTaskVisibility(readSidebarTaskVisibilityPreferences()));
  const { onlyRunningTasks, showCodexChats } = taskVisibility;
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
  useEffect(() => {
    if (!selectedProjectId) return;
    setProjectsCollapsed(false);
  }, [selectedProjectId]);
  const taskNoun = "threads";
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
    for (const session of [...activeSessions, ...Object.values(childSessionRowsByParentId).flat()]) {
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
    childSessionRowsByParentId,
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
        onlyRunningTasks,
        selectedTasksetId,
        previewSessionIds: taskPreviewSessionIds,
        showCodexChats,
        sort: taskSort,
      }),
    [
      activeSessions,
      archivedSessions,
      inProgressSessionIds,
      onlyRunningTasks,
      selectedTasksetId,
      showCodexChats,
      taskFilter,
      taskPreviewSessionIds,
      taskSort,
    ]
  );
  const tasksetOptions = useMemo<SidebarTasksetFilterOption[]>(
    () => {
      const byId = new Map<string, SidebarTasksetFilterOption>();
      for (const session of [...activeSessions, ...archivedSessions]) {
        if (
          !isSidebarTaskVisible(session, {
            inProgressSessionIds,
            onlyRunningTasks,
            showCodexChats,
          })
        ) {
          continue;
        }
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
    [
      activeSessions,
      archivedSessions,
      inProgressSessionIds,
      onlyRunningTasks,
      showCodexChats,
    ]
  );
  const visiblePinnedRows = useMemo(
    () =>
      pinnedRows.filter(
        (row) =>
          row.type !== "session" ||
          isSidebarTaskVisible(row.session, {
            inProgressSessionIds,
            onlyRunningTasks,
            showCodexChats,
          })
      ),
    [inProgressSessionIds, onlyRunningTasks, pinnedRows, showCodexChats],
  );
  const workflowTaskRows = sidebarTaskRows({ activeSessions: workflowSessions.filter(session => !session.archived && !session.hiddenFromDefaultSidebar),
    doneSessions: workflowSessions.filter(session => session.archived && !session.hiddenFromDefaultSidebar),
    filter: taskFilter, inProgressSessionIds, onlyRunningTasks, selectedTasksetId, showCodexChats, sort: taskSort });
  const workflowSessionIds = useMemo(() => new Set(workflowGroups.flatMap(group => [group.prerequisite.sessionId, group.successor.sessionId,
    group.workflow?.preparationSessionId].filter((id): id is string => Boolean(id)))), [workflowGroups]);
  const ordinaryFilteredTaskRows = useMemo(
    () => filteredTaskRows.filter((session) => !isSidebarTaskPinned(session) && !workflowSessionIds.has(session.id)),
    [filteredTaskRows, workflowSessionIds],
  );
  const visibleTaskRows = useMemo(
    () =>
      ordinaryFilteredTaskRows.slice(0, Math.max(SIDEBAR_TASK_INITIAL_LIMIT, chatRowsVisibleCount)),
    [chatRowsVisibleCount, ordinaryFilteredTaskRows],
  );
  const groupedTaskRows = useMemo(
    () => {
      const groups = groupSidebarTaskRows(visibleTaskRows, (session) => {
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
        const label = projectLabelForSession(session) ?? "Work";
        return {
          key: projectId ? `project:${projectId}` : `projectless:${label}`,
          label,
          projectId: projectId ?? null,
          project: projectId ? (projectRowById.get(projectId) ?? null) : null,
          kind: projectId ? ("project" as const) : ("projectless" as const),
        };
      });
      for (const project of projectsSectionRows) {
          if (!groups.some((group) => group.projectId === project.id)) {
            groups.push({ key: `project:${project.id}`, label: project.project.name, projectId: project.id, project, kind: "project", sessions: [] });
          }
      }
      return groups;
    },
    [projectsSectionRows, projectLabelById, projectRowById, sidebarProjectIdBySessionId, visibleTaskRows],
  );
  const canShowMoreTasks = visibleTaskRows.length < ordinaryFilteredTaskRows.length;
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
          childSessions.some((child) => !child.archived) &&
          (subagentRuntimeBySessionId.get(parentSessionId)?.activeCount ?? 0) >
            0
      )
      .flatMap(([parentSessionId, childSessions]) =>
        childSessions.filter((child) => !child.archived).map(
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
    return null;
  }

  function selectSession(session: Session) {
    if (onSelectSession) { onSelectSession(session); return; }
    navigateDesktopRoute({ kind: "chat", sessionId: session.id });
    setSelectedSessionId(session.id);
    const projectId = sidebarProjectIdBySessionId[session.id] ?? null;
    setSelectedAppId(projectId ? null : session.appId);
    setSelectedProjectId(projectId);
    setView("chat");
  }

  function childSessionsFor(session: Session): Session[] {
    return (childSessionRowsByParentId[session.id] ?? []).filter((child) =>
      !child.archived &&
      isSidebarTaskVisible(child, {
        inProgressSessionIds,
        onlyRunningTasks,
        showCodexChats,
      })
    );
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
    target: HTMLElement,
  ) {
    if (typeof window === "undefined") return;
    const folderName = isSidebarTaskPinned(session) ? projectLabelForSession(session) : null;
    setActiveTaskDetail({
      descriptionId: `sidebar-task-detail-${session.id}`,
      sessionId: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      folderName,
      style: sidebarTaskDetailPosition(target.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }, Boolean(folderName)),
    });
  }

  function renderTaskSession(
    session: Session,
    options: {
      metadataPresentation?: "inline" | "hover-detail" | "flyout";
      projectLabel?: string | null;
      pinnedRow?: { key: string; dragProps: ReturnType<typeof pinnedDragProps>; placeholder: boolean };
    } = {},
  ) {
    const archived = session.archived;
    const isDragged = options.pinnedRow?.placeholder ?? taskDragSessionId === session.id;
    const childSessions = childSessionsFor(session);
    const groupClassName = "sidebar-session-group";
    const dragProps = options.pinnedRow?.dragProps ?? (
      !inboxView && taskSort === "manual"
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
        : {});

    return (
      <div
        key={options.pinnedRow?.key ?? session.id}
        className={groupClassName}
        onPointerEnter={(event) => showTaskDetail(session, event.currentTarget)}
        onPointerLeave={() => setActiveTaskDetail(null)}
        onFocusCapture={(event) => showTaskDetail(session, event.currentTarget)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setActiveTaskDetail(null);
          }
        }}
      >
        <SidebarSessionRow
          session={session}
          selected={
            !archived && view === "chat" && selectedSessionId === session.id
          }
          archived={archived}
          inbox={inboxView}
          activityAt={sidebarInboxTime(session, activityTimes)}
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
        {!inboxView && !isDragged ? renderChildSessionRows(session) : null}
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
      nextSidebarChatVisibleCount(count, ordinaryFilteredTaskRows.length)
    );
  }

  function showLessTasks() {
    setChatRowsVisibleCount((count) =>
      previousSidebarChatVisibleCount(count, ordinaryFilteredTaskRows.length)
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
    return renderTaskSession(row.session, {
      projectLabel: inboxView && !sidebarProjectIdBySessionId[row.session.id]
        ? null
        : projectLabelForSession(row.session),
      pinnedRow: { key: row.key, dragProps, placeholder },
    });
  }

  function renderTaskGroup(group: SidebarTaskGroup) {
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
  }

  const listControls = <SidebarTaskListControls
            activityOrder={inboxView}
            filter={taskFilter}
            groupByProject={groupByProject}
            noun={taskNoun}
            onFilterChange={changeTaskFilter}
            onGroupByProjectChange={setGroupByProject}
            onOnlyRunningTasksChange={(nextValue) => {
              setTaskVisibility((current) => {
                const next = { ...current, onlyRunningTasks: nextValue };
                writeSidebarTaskVisibilityPreferences(next);
                return next;
              });
              setChatRowsVisibleCount(SIDEBAR_TASK_INITIAL_LIMIT);
            }}
            onShowCodexChatsChange={(nextValue) => {
              setTaskVisibility((current) => {
                const next = { ...current, showCodexChats: nextValue };
                writeSidebarTaskVisibilityPreferences(next);
                return next;
              });
              setChatRowsVisibleCount(SIDEBAR_TASK_INITIAL_LIMIT);
            }}
            onTasksetChange={changeTasksetFilter}
            onSortChange={changeTaskSort}
            onlyRunningTasks={onlyRunningTasks}
            openMenu={sectionMenuOpen}
            setOpenMenu={setSectionMenuOpen}
            showCodexChats={showCodexChats}
            sort={taskSort}
            selectedTasksetId={selectedTasksetId}
            tasksets={tasksetOptions}
          />;
  const inboxChildren = sidebarTaskRows({ activeSessions: Object.values(childSessionRowsByParentId).flat().filter((session) => !session.archived), doneSessions: Object.values(childSessionRowsByParentId).flat().filter((session) => session.archived), filter: taskFilter, inProgressSessionIds, onlyRunningTasks, selectedTasksetId, showCodexChats, sort: "recent" });
  const inboxRows = orderSidebarInbox([...ordinaryFilteredTaskRows, ...inboxChildren].filter((session) => !isSidebarTaskPinned(session)), activityTimes, inProgressSessionIds);

  return (
    <div className="sidebar-sections">
      <div className="sidebar-threads-header">
        <span>Threads</span>
        <div className="sidebar-threads-header-actions">
          {teamChatEnabled && teamChatOrganization?.teamId === selectedTeamId ? (
            <SidebarTeamAvatars
              key={`${account?.activeProfile ?? ""}:${selectedTeamId}`}
              members={teamMembers}
              currentUserId={currentUserId}
              teamName={teamChatOrganization.displayName}
              onOpenDm={(userId) => {
                void (async () => {
                  if (await navigateDesktopRoute({ kind: "view", view: "team" })) openTeamDm(userId);
                })();
              }}
            />
          ) : null}
          {inboxView ? listControls : null}
          <button type="button" className={`sidebar-icon${inboxView ? " active" : ""}`}
            aria-label={inboxView ? "Show grouped threads" : "Show thread inbox"}
            title={inboxView ? "Grouped threads" : "Thread inbox"} aria-pressed={inboxView}
            onClick={() => { const next = inboxView ? "grouped" : "inbox"; setPresentation(next); clientChoiceStorage.setItem("openpond.sidebar.presentation.v1", next); }}>
            {inboxView ? <List size={16} /> : <Inbox size={16} />}
          </button>
          <SidebarNewThreadButton beginNewChat={beginNewChat} />
        </div>
      </div>
      {account?.activeProfile && onOpenPonder ? (
        <button type="button" className="sidebar-row sidebar-task-row sidebar-ponder-entry" onClick={onOpenPonder}>
          <span className="conversation-source-icon" aria-hidden="true"><img src={OPENPOND_ICON_URL} alt="" /></span>
          <span>Ponder Pal</span>
        </button>
      ) : null}
      {visiblePinnedRows.length > 0 ? (
        <div className="sidebar-pinned-rows">
          {visiblePinnedRows.map(renderPinnedRow)}
        </div>
      ) : null}
      <SidebarWorkflowGroups groups={workflowGroups} sessions={workflowTaskRows}
        renderSession={session => renderTaskSession(session, { projectLabel: projectLabelForSession(session) })} />
      {inboxView ? <section className="sidebar-thread-inbox" aria-label="Thread inbox">
        {sidebarInboxDateGroups(inboxRows, activityTimes, inProgressSessionIds).map((group) => <div key={group.key}>
          {group.label ? <h3 className="sidebar-inbox-date">{group.label}</h3> : null}
          {group.sessions.map((session) => renderTaskSession(session, { projectLabel: sidebarProjectIdBySessionId[session.id] ? projectLabelForSession(session) : null }))}
        </div>)}
        {inboxRows.length === 0 && visiblePinnedRows.length === 0 ? <div className="empty-row">{sidebarTaskEmptyLabel(taskFilter, taskNoun)}</div> : null}
      </section> : <>
      <SidebarSection
        label="Projects"
        className="sidebar-projects-section development"
        collapsed={projectsCollapsed}
        onToggleCollapsed={() => setProjectsCollapsed((current) => !current)}
        actions={
          <SidebarProjectsHeaderActions
            onAddProject={onAddProject}
            onViewProjects={() => {
              void (async () => {
                if (!await navigateDesktopRoute({ kind: "view", view: "projects" })) return;
                setSelectedAppId(null);
                setSelectedProjectId(null);
                setSelectedSessionId(null);
                setView("projects");
              })();
            }}
          />
        }
      >
        {groupedTaskRows
          .filter((group) => group.kind === "project")
          .map((group) => renderTaskGroup(
            !groupByProject ? { ...group, sessions: [] } : group,
          ))}
      </SidebarSection>
      <SidebarSection
        label="Threads"
        className="sidebar-task-section sidebar-ordinary-section"
        collapsed={ordinaryCollapsed}
        onToggleCollapsed={() => setOrdinaryCollapsed((current) => !current)}
        actionsVisible={sectionMenuOpen === "tasks-filter" || taskFilter !== "active" || onlyRunningTasks || !showCodexChats}
        actions={listControls}
      >
        {(!groupByProject
          ? visibleTaskRows
          : visibleTaskRows.filter((session) => !sidebarProjectIdBySessionId[session.id])
        ).map((session) => renderTaskSession(session))}
        {ordinaryFilteredTaskRows.length === 0 && visiblePinnedRows.length === 0 ? (
          <div className="empty-row">
            {sidebarTaskEmptyLabel(taskFilter, taskNoun)}
          </div>
        ) : null}
        {ordinaryFilteredTaskRows.length > SIDEBAR_TASK_INITIAL_LIMIT &&
          (canShowMoreTasks || canShowLessTasks) ? (
            <div
              className="sidebar-pagination-controls"
              aria-label={`Showing ${visibleTaskRows.length} of ${ordinaryFilteredTaskRows.length} ${taskNoun}`}
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
      </>}
      <SidebarTaskDetailPopover
        detail={activeTaskDetail}
        onClose={() => setActiveTaskDetail(null)}
      />
    </div>
  );
}
