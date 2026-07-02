import type { Dispatch, SetStateAction } from "react";
import type { BootstrapPayload, LocalProject, Session } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import {
  isCloudSidebarProjectItem,
  isLocalSidebarProjectItem,
  projectSelectionKey,
  type AppView,
  type SidebarProjectItem,
} from "../lib/app-models";
import { normalizeOpenPondOrganization, slugifyCloudProjectName, utf8ToBase64 } from "../lib/cloud-project-utils";
import { canManageOpenPondOrganization, type OpenPondOrganization } from "../lib/organization-types";
import { implicitOrganization } from "../lib/project-agent-setup";

type ShowToast = (
  message: string,
  tone?: "success" | "error" | "info",
  options?: {
    actionLabel?: string;
    onAction?: () => void;
    persistent?: boolean;
  }
) => void;

type UseProjectActionsInput = {
  connection: ClientConnection | null;
  defaultTeamId?: string | null;
  sessions: Session[];
  selectedProjectId: string | null;
  confirmProjectAction?: (request: {
    title: string;
    body: string;
    confirmLabel: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  applyBootstrapPayload: (payload: BootstrapPayload) => void;
  expandProject: (projectId: string) => void;
  revealProjectsSection: () => void;
  setExpandedProjectIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setView: Dispatch<SetStateAction<AppView>>;
  showToast: ShowToast;
};

export function useProjectActions({
  connection,
  defaultTeamId,
  sessions,
  selectedProjectId,
  confirmProjectAction,
  applyBootstrapPayload,
  expandProject,
  revealProjectsSection,
  setExpandedProjectIds,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setError,
  setView,
  showToast,
}: UseProjectActionsInput) {
  function openProject(project: LocalProject) {
    const projectKey = projectSelectionKey("local", project.id);
    setSelectedAppId(null);
    setSelectedProjectId(projectKey);
    setSelectedSessionId(null);
    setView("chat");
    revealProjectsSection();
    expandProject(projectKey);
  }

  async function addProjectFolder() {
    if (!connection) return;
    setError(null);
    let folderPath: string | null = null;
    if (window.openpond?.selectFolder) {
      const result = await window.openpond.selectFolder();
      if (result.canceled) return;
      folderPath = result.path;
    } else {
      folderPath = window.prompt("Project folder path");
    }
    if (!folderPath?.trim()) return;
    try {
      const result = await api.createLocalProject(connection, { path: folderPath.trim() });
      applyBootstrapPayload(result.bootstrap);
      openProject(result.project);
      showToast(result.created === false ? `Opened ${result.project.name}` : `Added ${result.project.name}`, "success");
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : String(projectError));
      showToast("Project folder could not be added", "error");
    }
  }

  async function createProjectFromScratch(projectName: string): Promise<boolean> {
    if (!connection) return false;
    const trimmedName = projectName.trim();
    if (!trimmedName) return false;
    setError(null);
    try {
      const result = await api.createLocalProject(connection, {
        createNew: true,
        name: trimmedName,
      });
      applyBootstrapPayload(result.bootstrap);
      openProject(result.project);
      showToast(`Created ${result.project.name}`, "success");
      return true;
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : String(projectError));
      showToast("Project could not be created", "error");
      return false;
    }
  }

  async function createCloudProjectFromScratch(projectName: string): Promise<boolean> {
    if (!connection) return false;
    const trimmedName = projectName.trim();
    if (!trimmedName) return false;
    setError(null);
    try {
      const organizationPayload = await api.organizations(connection);
      const organization = implicitOrganization(
        organizationPayload.organizations
          .map(normalizeOpenPondOrganization)
          .filter((candidate): candidate is OpenPondOrganization => Boolean(candidate))
          .filter((candidate) => candidate.status === "active"),
        defaultTeamId,
      );
      if (!organization) {
        throw new Error("Add an OpenPond account before creating a Cloud Project.");
      }
      if (!canManageOpenPondOrganization(organization)) {
        throw new Error(`You need owner or admin access to create projects in ${organization.displayName}.`);
      }
      const sourceIdentity = `${slugifyCloudProjectName(trimmedName)}-${Date.now().toString(36)}`;
      let project = (
        await api.upsertSandboxProject(connection, {
          teamId: organization.teamId,
          name: trimmedName,
          sourceType: "internal_repo",
          normalizedSourceIdentity: sourceIdentity,
          internalRepoPath: sourceIdentity,
          defaultBranch: "main",
          sourceConfig: {
            sourceType: "internal_repo",
            sourceValue: sourceIdentity,
          },
          metadata: { source: "openpond-app-new-cloud-project" },
        })
      ).project;
      project = (
        await api.uploadSandboxProjectSource(connection, project.id, {
          teamId: organization.teamId,
          branch: "main",
          commitMessage: "Initialize cloud project",
          entries: [
            {
              path: "README.md",
              type: "file",
              contentsBase64: utf8ToBase64(`# ${trimmedName}\n\nCreated in OpenPond Cloud.\n`),
            },
          ],
        })
      ).project;
      const payload = await api.bootstrap(connection);
      applyBootstrapPayload(payload);
      const projectKey = projectSelectionKey("cloud", project.id);
      setSelectedAppId(null);
      setSelectedProjectId(projectKey);
      setSelectedSessionId(null);
      setView("chat");
      revealProjectsSection();
      expandProject(projectKey);
      showToast(`Created Cloud Project: ${project.name}`, "success");
      return true;
    } catch (projectError) {
      const message = projectError instanceof Error ? projectError.message : String(projectError);
      setError(message);
      showToast(message, "error");
      return false;
    }
  }

  async function removeProject(item: SidebarProjectItem) {
    if (!connection) return;
    if (isCloudSidebarProjectItem(item)) {
      const message = `Archive ${item.project.name} in OpenPond Cloud?`;
      const confirmed = confirmProjectAction
        ? await confirmProjectAction({
          title: "Archive Cloud Project",
          body: `${item.project.name} will be archived in OpenPond Cloud. Existing task history stays available through Cloud history.`,
          confirmLabel: "Archive project",
        })
        : window.confirm(message);
      if (!confirmed) return;
      setError(null);
      try {
        await api.archiveSandboxProject(connection, item.project.id, { teamId: item.project.teamId });
        applyBootstrapPayload(await api.bootstrap(connection));
        setExpandedProjectIds((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
        if (selectedProjectId === item.id) {
          setSelectedProjectId(null);
          setSelectedSessionId(null);
        }
        showToast(`Archived ${item.project.name}`, "success");
      } catch (projectError) {
        setError(projectError instanceof Error ? projectError.message : String(projectError));
        showToast("Cloud Project could not be archived", "error");
      }
      return;
    }
    if (!isLocalSidebarProjectItem(item)) return;
    const project: LocalProject = item.project;
    const message = `Remove ${project.name} from Projects? The folder will not be deleted.`;
    const confirmed = confirmProjectAction
      ? await confirmProjectAction({
        title: "Remove Project",
        body: `${project.name} will be removed from the sidebar. The folder and files on disk will not be deleted.`,
        confirmLabel: "Remove project",
      })
      : window.confirm(message);
    if (!confirmed) return;
    setError(null);
    try {
      const payload = await api.deleteLocalProject(connection, project.id);
      applyBootstrapPayload(payload);
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      if (selectedProjectId === item.id) {
        setSelectedProjectId(null);
        setSelectedSessionId((current) => {
          const currentSession = sessions.find((session) => session.id === current);
          return currentSession?.workspaceKind === "local_project" && currentSession.workspaceId === project.id ? null : current;
        });
      }
      showToast(`Removed ${project.name}`, "success");
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : String(projectError));
      showToast("Project could not be removed", "error");
    }
  }

  return {
    addProjectFolder,
    createCloudProjectFromScratch,
    createProjectFromScratch,
    removeProject,
  };
}
