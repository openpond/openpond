import { useMemo } from "react";
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
  const sidebarSessions = useMemo<Session[]>(() => {
    const liveCodexThreadIds = new Set<string>();
    const rows = sessions.slice();
    for (const session of sessions) {
      if (session.codexThreadId) liveCodexThreadIds.add(session.codexThreadId);
    }
    for (const session of codexHistorySessions) {
      if (session.codexThreadId && liveCodexThreadIds.has(session.codexThreadId)) continue;
      rows.push(session);
    }
    return rows.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [codexHistorySessions, sessions]);
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
