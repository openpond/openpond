import { useMemo, useRef } from "react";
import type { BootstrapPayload, CloudProject, Session } from "@openpond/contracts";
import { sandboxMentionApps } from "../lib/chat-app-mentions";
import { currentOpenPondAppIds, currentOpenPondProjectLink } from "../lib/project-links";
import {
  buildSidebarProjectPathIndex,
  sidebarProjectIdForSession,
} from "../lib/sidebar-session-projects";
import { parseProjectSelection } from "../lib/app-models";

export function useAppSelectionState({
  bootstrap,
  codexHistorySessions,
  selectedProjectId,
  selectedSessionId,
  selectedAppId,
  sessions,
}: {
  bootstrap: BootstrapPayload | null;
  codexHistorySessions: Session[];
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  selectedAppId: string | null;
  sessions: Session[];
}) {
  const selectedApp = useMemo(
    () => bootstrap?.apps.find((app) => app.id === selectedAppId) ?? null,
    [bootstrap?.apps, selectedAppId],
  );
  const localProjectById = useMemo(
    () => new Map((bootstrap?.localProjects ?? []).map((project) => [project.id, project])),
    [bootstrap?.localProjects],
  );
  const cloudProjectById = useMemo(
    () => new Map((bootstrap?.cloudProjects ?? []).map((project) => [project.id, project])),
    [bootstrap?.cloudProjects],
  );
  const selectedProjectSelection = useMemo(
    () => parseProjectSelection(selectedProjectId),
    [selectedProjectId],
  );
  const selectedProjectFromSelection = useMemo(
    () =>
      selectedProjectSelection?.kind === "local"
        ? (localProjectById.get(selectedProjectSelection.id) ?? null)
        : null,
    [localProjectById, selectedProjectSelection],
  );
  const selectedCloudProjectFromSelection = useMemo(
    () =>
      selectedProjectSelection?.kind === "cloud"
        ? (cloudProjectById.get(selectedProjectSelection.id) ?? null)
        : null,
    [cloudProjectById, selectedProjectSelection],
  );
  const currentAppIds = useMemo(
    () => currentOpenPondAppIds(bootstrap?.apps ?? []),
    [bootstrap?.apps],
  );
  const mentionableSandboxApps = useMemo(
    () => sandboxMentionApps(bootstrap?.apps ?? []),
    [bootstrap?.apps],
  );
  const linkedProjectByAppId = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const project of bootstrap?.localProjects ?? []) {
      const link = currentOpenPondProjectLink(project, currentAppIds);
      if (link) entries.push([link.appId, project.id]);
    }
    return new Map(entries);
  }, [bootstrap?.localProjects, currentAppIds]);
  const localProjectIds = useMemo(
    () => new Set((bootstrap?.localProjects ?? []).map((project) => project.id)),
    [bootstrap?.localProjects],
  );
  const projectPathIndex = useMemo(
    () => buildSidebarProjectPathIndex(bootstrap?.localProjects ?? []),
    [bootstrap?.localProjects],
  );
  const sidebarSessionOrderKeysRef = useRef<string[]>([]);
  const sidebarSessions = useMemo(
    () => mergedSidebarSessions(sessions, codexHistorySessions, sidebarSessionOrderKeysRef.current),
    [codexHistorySessions, sessions],
  );
  const selectedSession = useMemo(
    () => sidebarSessions.find((session) => session.id === selectedSessionId) ?? null,
    [sidebarSessions, selectedSessionId],
  );
  const selectedSessionLinkedProject = useMemo(() => {
    if (!selectedSession) return null;
    if (selectedSession.localProjectId) {
      return localProjectById.get(selectedSession.localProjectId) ?? null;
    }
    if (selectedSession.workspaceKind === "local_project") {
      return selectedSession.workspaceId ? (localProjectById.get(selectedSession.workspaceId) ?? null) : null;
    }
    const inferredProjectId = sidebarProjectIdForSession(
      selectedSession,
      localProjectIds,
      projectPathIndex,
    );
    if (inferredProjectId) return localProjectById.get(inferredProjectId) ?? null;
    if (!selectedSession.appId) return null;
    const linkedProjectId = linkedProjectByAppId.get(selectedSession.appId);
    return linkedProjectId ? (localProjectById.get(linkedProjectId) ?? null) : null;
  }, [linkedProjectByAppId, localProjectById, localProjectIds, projectPathIndex, selectedSession]);
  const selectedSessionCloudProject = useMemo<CloudProject | null>(() => {
    if (!selectedSession?.cloudProjectId) return null;
    return cloudProjectById.get(selectedSession.cloudProjectId) ?? null;
  }, [cloudProjectById, selectedSession]);
  const selectedProject = selectedProjectFromSelection ?? selectedSessionLinkedProject;
  const selectedCloudProject = selectedCloudProjectFromSelection ?? selectedSessionCloudProject;
  const selectedProjectLinkedOpenPondApp = useMemo(
    () => currentOpenPondProjectLink(selectedProject, currentAppIds),
    [currentAppIds, selectedProject],
  );
  const selectedProjectLinkedApp = useMemo(
    () =>
      selectedProjectLinkedOpenPondApp
        ? (bootstrap?.apps.find((app) => app.id === selectedProjectLinkedOpenPondApp.appId) ?? null)
        : null,
    [bootstrap?.apps, selectedProjectLinkedOpenPondApp],
  );

  return {
    cloudProjectById,
    currentAppIds,
    linkedProjectByAppId,
    localProjectById,
    mentionableSandboxApps,
    selectedApp,
    selectedCloudProject,
    selectedProject,
    selectedProjectLinkedApp,
    selectedProjectLinkedOpenPondApp,
    selectedSession,
    selectedSessionLinkedProject,
    sidebarSessions,
  };
}

export function mergedSidebarSessions(
  sessions: Session[],
  codexHistorySessions: Session[],
  previousOrderKeys?: string[],
): Session[] {
  const rowsByKey = new Map<string, Session>();
  for (const session of sessions) {
    const key = sidebarSessionOrderKey(session);
    rowsByKey.set(key, session);
  }
  for (const session of codexHistorySessions) {
    const key = sidebarSessionOrderKey(session);
    const current = rowsByKey.get(key);
    rowsByKey.set(key, current ? mergeCodexHistorySessionIntoLiveSession(current, session) : session);
  }

  const entries = Array.from(rowsByKey.entries());
  if (!previousOrderKeys) {
    return entries
      .sort((left, right) => compareSidebarSessionsForNewRows(left[1], right[1]))
      .map((entry) => entry[1]);
  }

  const orderedEntries: Array<[string, Session]> = [];
  const usedKeys = new Set<string>();
  for (const key of previousOrderKeys) {
    const row = rowsByKey.get(key);
    if (!row) continue;
    orderedEntries.push([key, row]);
    usedKeys.add(key);
  }

  const newEntries = entries
    .filter(([key]) => !usedKeys.has(key))
    .sort((left, right) => compareSidebarSessionsForNewRows(left[1], right[1]));
  const nextEntries = [...newEntries, ...orderedEntries];
  previousOrderKeys.splice(0, previousOrderKeys.length, ...nextEntries.map(([key]) => key));
  return nextEntries.map((entry) => entry[1]);
}

function mergeCodexHistorySessionIntoLiveSession(liveSession: Session, historySession: Session): Session {
  return {
    ...liveSession,
    metadata: mergedSessionMetadata(liveSession.metadata, historySession.metadata),
    status: liveSession.status === "active" || historySession.status === "active" ? "active" : liveSession.status,
    updatedAt: newerIso(liveSession.updatedAt, historySession.updatedAt),
  };
}

function sidebarSessionOrderKey(session: Session): string {
  return session.codexThreadId ? `codex:${session.codexThreadId}` : `session:${session.id}`;
}

function compareSidebarSessionsForNewRows(left: Session, right: Session): number {
  const updatedDelta = sessionTime(right) - sessionTime(left);
  if (updatedDelta !== 0) return updatedDelta;
  return left.title.localeCompare(right.title);
}

function mergedSessionMetadata(
  liveMetadata: Session["metadata"] | undefined,
  historyMetadata: Session["metadata"] | undefined,
): Session["metadata"] | undefined {
  const merged = {
    ...(liveMetadata ?? {}),
    ...(historyMetadata ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function newerIso(left: string, right: string): string {
  const leftMs = Date.parse(left);
  if (!Number.isFinite(leftMs)) return right;
  const rightMs = Date.parse(right);
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

function sessionTime(session: Session): number {
  const updatedAt = Date.parse(session.updatedAt);
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(session.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}
