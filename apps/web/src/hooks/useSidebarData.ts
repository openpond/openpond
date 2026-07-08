import { useMemo } from "react";
import type {
  CloudProject,
  CloudWorkItem,
  LocalProject,
  Session,
  SidebarAppPreferences,
} from "@openpond/contracts";
import { buildCachedChatMessages } from "../lib/chat-messages";
import {
  SIDEBAR_SECTION_LIMIT,
  sidebarDragKey,
  projectSelectionKey,
  type PinnedSidebarItem,
  type SidebarProjectItem,
} from "../lib/app-models";
import {
  buildSidebarProjectPathIndex,
  isSidebarCloudWorkSession,
  sidebarProjectKeyForSession,
} from "../lib/sidebar-session-projects";
import {
  latestContextUsageForSession,
  latestGoalRuntimeForSession,
  latestSubagentRuntimeForSession,
  runtimeEventsForSession,
  type RuntimeIndexes,
} from "../lib/runtime-indexes";
import {
  confirmedLinkedCloudProject,
  localProjectCloudLinkWarning,
} from "../lib/cloud-link-trust";

type UseSidebarDataInput = {
  localProjects: LocalProject[];
  cloudProjects: CloudProject[];
  cloudWorkItems: CloudWorkItem[];
  sessions: Session[];
  runtimeIndexes: RuntimeIndexes;
  appPreferences: SidebarAppPreferences;
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  archivedChatsOpen: boolean;
  projectsExpanded: boolean;
  chatRowsVisibleCount: number;
};

export function useSidebarData({
  localProjects,
  cloudProjects,
  cloudWorkItems,
  sessions,
  runtimeIndexes,
  appPreferences,
  selectedSessionId,
  selectedProjectId,
  archivedChatsOpen,
  projectsExpanded,
  chatRowsVisibleCount,
}: UseSidebarDataInput) {
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );
  const visibleLocalProjects = useMemo(
    () =>
      localProjects.filter(
        (project) =>
          !project.hiddenFromDefaultSidebar ||
          (project.systemKind && selectedSession?.localProjectId === project.id),
      ),
    [localProjects, selectedSession?.localProjectId],
  );
  const visibleLocalProjectIds = useMemo(
    () => new Set(visibleLocalProjects.map((project) => project.id)),
    [visibleLocalProjects],
  );
  const activeSessions = useMemo(
    () =>
      sessions.filter(
        (session) => !session.archived && isVisibleActiveSidebarSession(session, visibleLocalProjectIds),
      ),
    [sessions, visibleLocalProjectIds],
  );
  const pinnedSessions = useMemo(() => activeSessions.filter((session) => session.pinned), [activeSessions]);
  const archivedSessions = useMemo(
    () => sessions.filter((session) => session.archived && !session.hiddenFromDefaultSidebar),
    [sessions],
  );
  const localProjectIds = useMemo(() => new Set(localProjects.map((project) => project.id)), [localProjects]);
  const cloudProjectIds = useMemo(
    () => new Set(cloudProjects.map((project) => project.id)),
    [cloudProjects],
  );
  const projectPathIndex = useMemo(() => buildSidebarProjectPathIndex(localProjects), [localProjects]);
  const cloudWorkSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) {
      if (isSidebarCloudWorkSession(session, cloudProjectIds)) ids.add(session.id);
    }
    return ids;
  }, [cloudProjectIds, sessions]);
  const sidebarProjectIdBySessionId = useMemo(() => {
    const rows: Record<string, string> = {};
    for (const session of activeSessions) {
      if (cloudWorkSessionIds.has(session.id)) continue;
      const projectKey = sidebarProjectKeyForSession(session, localProjectIds, projectPathIndex, cloudProjectIds);
      if (projectKey) rows[session.id] = projectKey;
    }
    return rows;
  }, [activeSessions, cloudProjectIds, cloudWorkSessionIds, localProjectIds, projectPathIndex]);
  const chatSessions = useMemo(
    () =>
      activeSessions.filter(
        (session) =>
          !cloudWorkSessionIds.has(session.id) &&
          !session.pinned &&
          !session.appId &&
          !sidebarProjectIdBySessionId[session.id]
      ),
    [activeSessions, cloudWorkSessionIds, sidebarProjectIdBySessionId]
  );
  const archivedChatSessions = useMemo(
    () =>
      archivedSessions.filter(
        (session) =>
          !cloudWorkSessionIds.has(session.id) &&
          !session.appId &&
          !sidebarProjectKeyForSession(session, localProjectIds, projectPathIndex, cloudProjectIds)
      ),
    [archivedSessions, cloudProjectIds, cloudWorkSessionIds, localProjectIds, projectPathIndex]
  );
  const projectSessionRowsByProjectId = useMemo(() => {
    const rows: Record<string, Session[]> = {};
    for (const session of activeSessions) {
      if (session.pinned) continue;
      const projectId = sidebarProjectIdBySessionId[session.id];
      if (!projectId) continue;
      const projectRows = rows[projectId];
      if (projectRows) {
        projectRows.push(session);
      } else {
        rows[projectId] = [session];
      }
    }
    return rows;
  }, [activeSessions, sidebarProjectIdBySessionId]);
  const childSessionRowsByParentId = useMemo(() => {
    const rows: Record<string, Session[]> = {};
    for (const session of sessions) {
      if (session.archived || !isSubagentChildSession(session)) continue;
      const parentRows = rows[session.parentSessionId];
      if (parentRows) {
        parentRows.push(session);
      } else {
        rows[session.parentSessionId] = [session];
      }
    }
    for (const parentRows of Object.values(rows)) {
      parentRows.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    }
    return rows;
  }, [sessions]);
  const localProjectRows = useMemo<SidebarProjectItem[]>(
    () =>
      visibleLocalProjects
        .map((project, index) => {
          const id = projectSelectionKey("local", project.id);
          const cloudLinkWarning = localProjectCloudLinkWarning(project, cloudProjects);
          return {
            id,
            kind: "local" as const,
            project,
            pinned: Boolean(appPreferences[id]?.pinned),
            order: appPreferences[id]?.order ?? index,
            cloudLinkTrusted: !cloudLinkWarning,
            cloudLinkWarning,
          };
        })
        .sort(sortSidebarProjectRows),
    [appPreferences, cloudProjects, visibleLocalProjects],
  );
  const cloudProjectRows = useMemo<SidebarProjectItem[]>(
    () =>
      cloudProjects
        .map((project, index) => {
          const id = projectSelectionKey("cloud", project.id);
          return {
            id,
            kind: "cloud" as const,
            project,
            pinned: Boolean(appPreferences[id]?.pinned),
            order: appPreferences[id]?.order ?? index,
            cloudLinkTrusted: true,
            cloudLinkWarning: null,
          };
        })
        .sort(sortSidebarProjectRows),
    [appPreferences, cloudProjects]
  );
  const localProjectKeyByLinkedCloudProjectId = useMemo(() => {
    const rows = new Map<string, string>();
    for (const project of visibleLocalProjects) {
      const cloudProject = confirmedLinkedCloudProject(project, cloudProjects);
      if (cloudProject) rows.set(cloudProject.id, projectSelectionKey("local", project.id));
    }
    return rows;
  }, [cloudProjects, visibleLocalProjects]);
  const cloudOnlyProjectRows = useMemo(
    () => cloudProjectRows.filter((item) => !localProjectKeyByLinkedCloudProjectId.has(item.project.id)),
    [cloudProjectRows, localProjectKeyByLinkedCloudProjectId],
  );
  const allProjectRows = useMemo<SidebarProjectItem[]>(
    () => [...localProjectRows, ...cloudOnlyProjectRows].sort(sortSidebarProjectRows),
    [cloudOnlyProjectRows, localProjectRows],
  );
  const pinnedProjects = useMemo(() => allProjectRows.filter((item) => item.pinned), [allProjectRows]);
  const projectRows = useMemo(() => allProjectRows.filter((item) => !item.pinned), [allProjectRows]);
  const visibleProjectRows = useMemo(
    () => visibleSidebarProjectRows(projectRows, projectsExpanded, selectedProjectId),
    [projectRows, projectsExpanded, selectedProjectId]
  );
  const cloudWorkItemsByProjectId = useMemo(() => {
    const rows: Record<string, CloudWorkItem[]> = {};
    const addWorkItem = (projectKey: string, workItem: CloudWorkItem) => {
      const projectRows = rows[projectKey];
      if (projectRows) {
        projectRows.push(workItem);
      } else {
        rows[projectKey] = [workItem];
      }
    };
    for (const workItem of cloudWorkItems) {
      if (workItem.archivedAt) continue;
      const projectKey = projectSelectionKey("cloud", workItem.projectId);
      addWorkItem(projectKey, workItem);
      const linkedLocalProjectKey = localProjectKeyByLinkedCloudProjectId.get(workItem.projectId);
      if (linkedLocalProjectKey) addWorkItem(linkedLocalProjectKey, workItem);
    }
    for (const [projectKey, items] of Object.entries(rows)) {
      rows[projectKey] = items.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    }
    return rows;
  }, [cloudWorkItems, localProjectKeyByLinkedCloudProjectId]);
  const pinnedItems = useMemo<PinnedSidebarItem[]>(
    () =>
      [
        ...pinnedProjects.map((item) => ({
          type: "project" as const,
          key: sidebarDragKey({ type: "project", id: item.id }),
          id: item.id,
          item,
          order: item.order,
        })),
        ...pinnedSessions.map((session) => ({
          type: "session" as const,
          key: sidebarDragKey({ type: "session", id: session.id }),
          id: session.id,
          session,
          order: session.order,
        })),
      ].sort((left, right) => {
        if (left.order !== right.order) return left.order - right.order;
        if (left.type !== right.type) {
          const priority = { project: 0, session: 1 };
          return priority[left.type] - priority[right.type];
        }
        const leftLabel =
          left.type === "project" ? left.item.project.name : left.session.title;
        const rightLabel =
          right.type === "project" ? right.item.project.name : right.session.title;
        return leftLabel.localeCompare(rightLabel);
      }),
    [pinnedProjects, pinnedSessions]
  );
  const chatRows = useMemo(
    () => (archivedChatsOpen ? [...chatSessions, ...archivedChatSessions] : chatSessions),
    [archivedChatsOpen, archivedChatSessions, chatSessions]
  );
  const visibleChatRows = useMemo(
    () => chatRows.slice(0, Math.max(SIDEBAR_SECTION_LIMIT, chatRowsVisibleCount)),
    [chatRows, chatRowsVisibleCount]
  );
  const sessionEvents = useMemo(
    () => runtimeEventsForSession(runtimeIndexes, selectedSessionId),
    [runtimeIndexes, selectedSessionId]
  );
  const chatMessages = useMemo(() => buildCachedChatMessages(sessionEvents), [sessionEvents]);
  const contextUsage = latestContextUsageForSession(runtimeIndexes, selectedSessionId);
  const goalRuntime = latestGoalRuntimeForSession(runtimeIndexes, selectedSessionId);
  const subagentRuntime = latestSubagentRuntimeForSession(runtimeIndexes, selectedSessionId);

  return {
    activeSessions,
    pinnedSessions,
    chatSessions,
    archivedSessions,
    pinnedProjects,
    pinnedItems,
    projectRows,
    localProjectRows,
    visibleProjectRows,
    cloudProjectRows: cloudOnlyProjectRows,
    cloudWorkItemsByProjectId,
    projectSessionRowsByProjectId,
    childSessionRowsByParentId,
    sidebarProjectIdBySessionId,
    chatRows,
    visibleChatRows,
    sessionEvents,
    chatMessages,
    contextUsage,
    goalRuntime,
    subagentRuntime,
  };
}

function isVisibleActiveSidebarSession(session: Session, visibleLocalProjectIds: ReadonlySet<string>): boolean {
  if (isSubagentChildSession(session)) return false;
  if (!session.hiddenFromDefaultSidebar) return true;
  return Boolean(session.systemKind && session.localProjectId && visibleLocalProjectIds.has(session.localProjectId));
}

function isSubagentChildSession(session: Session): session is Session & { parentSessionId: string; subagentRunId: string } {
  return Boolean(session.parentSessionId && session.subagentRunId);
}

function sortSidebarProjectRows(left: SidebarProjectItem, right: SidebarProjectItem): number {
  if (left.order !== right.order) return left.order - right.order;
  return left.project.name.localeCompare(right.project.name);
}

export function visibleSidebarProjectRows(
  projectRows: SidebarProjectItem[],
  projectsExpanded: boolean,
  selectedProjectId: string | null,
): SidebarProjectItem[] {
  if (projectsExpanded || projectRows.length <= SIDEBAR_SECTION_LIMIT) return projectRows;

  const visibleRows = projectRows.slice(0, SIDEBAR_SECTION_LIMIT);
  if (!selectedProjectId || visibleRows.some((item) => item.id === selectedProjectId)) {
    return visibleRows;
  }

  const selectedProject = projectRows.find((item) => item.id === selectedProjectId);
  if (!selectedProject) return visibleRows;

  return [...visibleRows.slice(0, SIDEBAR_SECTION_LIMIT - 1), selectedProject];
}
