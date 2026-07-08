import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { BootstrapPayload, CloudProject, LocalProject, Session, WorkspaceKind, WorkspaceState } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { AppAction, ShowAppToast } from "../app/app-state";
import type { CloudSetupDialogState } from "../components/workspace/CloudSetupDialog";
import {
  isLocalSidebarProjectItem,
  projectSelectionKey,
  type SidebarProjectItem,
} from "../lib/app-models";
import {
  buildCloudEnvironmentCreateUrl,
  buildCloudProjectUrl,
} from "../lib/cloud-environment-setup";
import { normalizeOpenPondOrganization } from "../lib/cloud-project-utils";
import { canManageOpenPondOrganization, type OpenPondOrganization } from "../lib/organization-types";
import { implicitOrganization } from "../lib/project-agent-setup";
import {
  isCloudWorkspaceKind,
  type WorkspaceLocation,
  type WorkspaceTargetValue,
} from "../lib/workspace-location";
import { confirmedLinkedCloudProject } from "../lib/cloud-link-trust";

type CloudWorkspaceSetupControls = {
  changeWorkspaceTarget: (target: WorkspaceTargetValue) => Promise<void>;
  moveProjectToCloud: (item: SidebarProjectItem) => void;
  openCloudSetupForLocalProject: (project: LocalProject, branchOverride?: string | null) => void;
  startCloudSetupUpload: () => Promise<void>;
};

export function useCloudWorkspaceSetup({
  account,
  accountPending,
  accountSignedOut,
  activeWorkspaceKind,
  activeWorkspaceLocation,
  appDispatch,
  applyBootstrapPayload,
  busy,
  cloudSetupDialog,
  cloudProjects,
  connection,
  defaultTeamId,
  expandProject,
  localProjectById,
  selectedCloudProject,
  selectedProject,
  selectedSession,
  selectedSessionProjectId,
  setCloudSetupDialog,
  setDiffPanelOpen,
  setError,
  setSessions,
  setWorkspaceBusy,
  showToast,
  visibleWorkspaceState,
  workspaceBusy,
}: {
  account: BootstrapPayload["account"] | null;
  accountPending: boolean;
  accountSignedOut: boolean;
  activeWorkspaceKind: WorkspaceKind | null;
  activeWorkspaceLocation: WorkspaceLocation;
  appDispatch: Dispatch<AppAction>;
  applyBootstrapPayload: (payload: BootstrapPayload) => void;
  busy: boolean;
  cloudSetupDialog: CloudSetupDialogState | null;
  cloudProjects: CloudProject[];
  connection: ClientConnection | null;
  defaultTeamId: string | null;
  expandProject: (projectId: string) => void;
  localProjectById: Map<string, LocalProject>;
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
  selectedSession: Session | null;
  selectedSessionProjectId: string | null;
  setCloudSetupDialog: Dispatch<SetStateAction<CloudSetupDialogState | null>>;
  setDiffPanelOpen: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setWorkspaceBusy: Dispatch<SetStateAction<boolean>>;
  showToast: ShowAppToast;
  visibleWorkspaceState: WorkspaceState | null;
  workspaceBusy: boolean;
}): CloudWorkspaceSetupControls {
  const accountBaseUrl = account?.baseUrl ?? account?.activeProfile?.baseUrl ?? null;
  const loadCloudSourcePreview = useCallback(
    async (project: LocalProject, branch: string) => {
      if (!connection) return;
      try {
        const response = await api.previewLocalProjectCloudSource(connection, project.id, { branch });
        setCloudSetupDialog((current) => {
          if (
            !current ||
            current.status !== "confirm" ||
            current.localProjectId !== project.id ||
            current.branch !== branch
          ) {
            return current;
          }
          return {
            ...current,
            branch: response.preview.branch,
            cloudProjectId: response.preview.targetProjectId,
            preview: response.preview,
            previewLoading: false,
            previewError: null,
          };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCloudSetupDialog((current) => {
          if (
            !current ||
            current.status !== "confirm" ||
            current.localProjectId !== project.id ||
            current.branch !== branch
          ) {
            return current;
          }
          return {
            ...current,
            preview: null,
            previewLoading: false,
            previewError: message,
          };
        });
      }
    },
    [connection, setCloudSetupDialog],
  );
  const startCloudSetupUpload = useCallback(
    async () => {
      const dialog = cloudSetupDialog;
      if (!dialog || dialog.status === "uploading") return;
      if (dialog.projectKind === "cloud") {
        setCloudSetupDialog((current) =>
          current
            ? {
                ...current,
                status: "ready",
                error: null,
              }
            : current,
        );
        return;
      }
      if (!connection) {
        setCloudSetupDialog((current) =>
          current
            ? { ...current, status: "error", error: "OpenPond App server is not connected." }
            : current,
        );
        return;
      }
      const projectId = dialog.localProjectId ?? "";
      const project = localProjectById.get(projectId);
      if (!project) {
        setCloudSetupDialog((current) =>
          current
            ? { ...current, status: "error", error: "Project is no longer available." }
            : current,
        );
        return;
      }
      setWorkspaceBusy(true);
      const confirmedCloudProject = confirmedLinkedCloudProject(project, cloudProjects);
      setCloudSetupDialog((current) =>
        current
          ? {
              ...current,
              status: "uploading",
              error: null,
              previewLoading: false,
            }
          : current,
      );
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
          throw new Error("Add an OpenPond account before creating a Cloud environment.");
        }
        if (!canManageOpenPondOrganization(organization)) {
          throw new Error(`You need owner or admin access to create projects in ${organization.displayName}.`);
        }
        const branch = dialog.branch || project.linkedSandboxProject?.defaultBranch || "main";
        const projectKey = projectSelectionKey("local", project.id);
        const syncSession = await api.createSession(connection, {
          provider: "openpond",
          appId: null,
          appName: null,
          workspaceKind: "local_project",
          workspaceId: project.id,
          workspaceName: project.name,
          localProjectId: project.id,
          cloudProjectId: confirmedCloudProject?.id ?? null,
          cloudTeamId: confirmedCloudProject?.teamId ?? null,
          cwd: project.workspacePath,
          title: `Sync ${project.name} to Cloud`,
        });
        setSessions((current) => [syncSession, ...current]);
        appDispatch({ type: "selectSession", sessionId: syncSession.id, projectId: projectKey });
        expandProject(projectKey);
        const upload = await api.uploadLocalProjectCloudSource(connection, project.id, {
          teamId: organization.teamId,
          projectName: project.name,
          branch,
          chatSessionId: syncSession.id,
          displayPrompt: `/sync-cloud ${project.name}`,
        });
        applyBootstrapPayload(upload.bootstrap);
        expandProject(projectKey);
        expandProject(projectSelectionKey("cloud", upload.project.id));
        const setupUrl = buildCloudEnvironmentCreateUrl({
          accountBaseUrl,
          teamId: upload.project.teamId,
          projectId: upload.project.id,
          projectName: upload.project.name,
          baseBranch: upload.upload.branch,
          localProjectId: project.id,
          source: "openpond-app",
        });
        const projectUrl = buildCloudProjectUrl({
          accountBaseUrl,
          organizationSlug: upload.project.organizationSlug,
          projectSlug: upload.project.slug,
        });
        setCloudSetupDialog({
          status: "ready",
          localProjectId: project.id,
          cloudProjectId: upload.project.id,
          teamId: upload.project.teamId,
          projectName: upload.project.name,
          projectKind: "local",
          projectUrl,
          setupUrl,
          branch: upload.upload.branch,
          preview: dialog.preview ?? null,
          previewLoading: false,
          previewError: null,
          upload: {
            branch: upload.upload.branch,
            headCommit: upload.upload.headCommit,
            fileCount: upload.upload.fileCount,
            byteCount: upload.upload.byteCount,
            skippedCount: upload.upload.skippedCount,
            initializedEmptyProject: upload.upload.initializedEmptyProject,
          },
          error: null,
        });
        showToast("Source uploaded to OpenPond Git. Cloud setup link is ready.", "success");
      } catch (targetError) {
        const message = targetError instanceof Error ? targetError.message : String(targetError);
        const payload = connection ? await api.bootstrap(connection).catch(() => null) : null;
        if (payload) applyBootstrapPayload(payload);
        setError(message);
        setCloudSetupDialog((current) =>
          current
            ? {
                ...current,
                status: "error",
                error: message,
              }
            : current,
        );
      } finally {
        setWorkspaceBusy(false);
      }
    },
    [
      accountBaseUrl,
      appDispatch,
      applyBootstrapPayload,
      cloudSetupDialog,
      cloudProjects,
      connection,
      defaultTeamId,
      expandProject,
      localProjectById,
      setCloudSetupDialog,
      setError,
      setSessions,
      setWorkspaceBusy,
      showToast,
    ],
  );

  const openCloudSetupForLocalProject = useCallback(
    (project: LocalProject, branchOverride?: string | null) => {
      if (!connection) {
        showToast("OpenPond App server is not connected.", "error");
        return;
      }
      if (accountPending) {
        showToast("Checking OpenPond account. Try again in a moment.", "info");
        return;
      }
      if (accountSignedOut) {
        showToast("Add an OpenPond account before using Cloud.", "error");
        return;
      }

      const branch = branchOverride || project.linkedSandboxProject?.defaultBranch || "main";
      setCloudSetupDialog({
        status: "confirm",
        localProjectId: project.id,
        projectName: project.name,
        projectKind: "local",
        projectUrl: null,
        setupUrl: null,
        branch,
        preview: null,
        previewLoading: true,
        previewError: null,
        upload: null,
        error: null,
      });
      void loadCloudSourcePreview(project, branch);
    },
    [accountPending, accountSignedOut, connection, loadCloudSourcePreview, setCloudSetupDialog, showToast],
  );

  const changeWorkspaceTarget = useCallback(
    async (target: WorkspaceTargetValue) => {
      if (target === activeWorkspaceLocation || workspaceBusy || busy) return;
      setError(null);

      if (target === "queue_cloud") {
        const linkedCloudProject =
          selectedCloudProject ??
          confirmedLinkedCloudProject(selectedProject, cloudProjects);
        if (!linkedCloudProject) {
          if (selectedProject) {
            openCloudSetupForLocalProject(selectedProject, visibleWorkspaceState?.currentBranch ?? null);
            return;
          }
          showToast("Select a Project before queueing Cloud work.", "error");
          return;
        }
        showToast(
          `Next Cloud task will use ${linkedCloudProject.name}. Start the message with /goal-remote to queue it while this chat stays local.`,
          "info",
        );
        return;
      }

      if (target === "upload_cloud") {
        if (!selectedProject) {
          showToast("Select a local Project before uploading source.", "error");
          return;
        }
        openCloudSetupForLocalProject(selectedProject, visibleWorkspaceState?.currentBranch ?? null);
        return;
      }

      if (target === "local") {
        const localProjectId =
          selectedSession?.localProjectId ??
          selectedProject?.id ??
          selectedSessionProjectId ??
          null;
        const localProject = localProjectId ? (localProjectById.get(localProjectId) ?? null) : null;
        if (!localProject) {
          showToast("No linked local workspace for this Cloud chat.", "error");
          return;
        }
        if (
          isCloudWorkspaceKind(activeWorkspaceKind) &&
          !window.confirm("Switch to Local? Cloud changes will stay in the hosted workspace until you preserve or export them.")
        ) {
          return;
        }
        const projectKey = projectSelectionKey("local", localProject.id);
        appDispatch({ type: "selectProject", projectId: projectKey });
        expandProject(projectKey);
        setDiffPanelOpen(false);
        showToast(`Switched to Local: ${localProject.name}`, "info");
        return;
      }

      if (!connection) {
        showToast("OpenPond App server is not connected.", "error");
        return;
      }
      if (accountPending) {
        showToast("Checking OpenPond account. Try again in a moment.", "info");
        return;
      }
      if (accountSignedOut) {
        showToast("Add an OpenPond account before using Cloud.", "error");
        return;
      }

      if (selectedCloudProject) {
        setCloudSetupDialog({
          status: "ready",
          cloudProjectId: selectedCloudProject.id,
          teamId: selectedCloudProject.teamId,
          projectName: selectedCloudProject.name,
          projectKind: "cloud",
          projectUrl: buildCloudProjectUrl({
            accountBaseUrl,
            organizationSlug: selectedCloudProject.organizationSlug,
            projectSlug: selectedCloudProject.slug,
          }),
          setupUrl: buildCloudEnvironmentCreateUrl({
            accountBaseUrl,
            teamId: selectedCloudProject.teamId,
            projectId: selectedCloudProject.id,
            projectName: selectedCloudProject.name,
            baseBranch: selectedCloudProject.defaultBranch,
            source: "openpond-app",
          }),
          branch: selectedCloudProject.defaultBranch ?? "main",
          preview: null,
          previewLoading: false,
          previewError: null,
          upload: null,
          error: null,
        });
        return;
      }

      const project = selectedProject;
      if (!project) {
        showToast("Select a Project before Cloud coding.", "error");
        return;
      }
      const branch =
        visibleWorkspaceState?.currentBranch ||
        project.linkedSandboxProject?.defaultBranch ||
        "main";
      openCloudSetupForLocalProject(project, branch);
    },
    [
      accountBaseUrl,
      accountPending,
      accountSignedOut,
      activeWorkspaceKind,
      activeWorkspaceLocation,
      appDispatch,
      busy,
      connection,
      cloudProjects,
      expandProject,
      localProjectById,
      openCloudSetupForLocalProject,
      selectedCloudProject,
      selectedProject,
      selectedSession,
      selectedSessionProjectId,
      setCloudSetupDialog,
      setDiffPanelOpen,
      setError,
      showToast,
      visibleWorkspaceState?.currentBranch,
      workspaceBusy,
    ],
  );

  const moveProjectToCloud = useCallback(
    (item: SidebarProjectItem) => {
      if (!isLocalSidebarProjectItem(item)) return;
      openCloudSetupForLocalProject(item.project);
    },
    [openCloudSetupForLocalProject],
  );

  return {
    changeWorkspaceTarget,
    moveProjectToCloud,
    openCloudSetupForLocalProject,
    startCloudSetupUpload,
  };
}
