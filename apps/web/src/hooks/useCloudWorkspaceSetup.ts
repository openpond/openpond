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
import { isCloudWorkspaceKind, type WorkspaceLocation } from "../lib/workspace-location";

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
  setWorkspaceBusy: Dispatch<SetStateAction<boolean>>;
  showToast: ShowAppToast;
  visibleWorkspaceState: WorkspaceState | null;
  workspaceBusy: boolean;
}) {
  const accountBaseUrl = account?.baseUrl ?? account?.activeProfile?.baseUrl ?? null;
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
      setCloudSetupDialog((current) =>
        current
          ? {
              ...current,
              status: "uploading",
              error: null,
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
        const upload = await api.uploadLocalProjectCloudSource(connection, project.id, {
          teamId: organization.teamId,
          projectName: project.name,
          branch,
        });
        applyBootstrapPayload(upload.bootstrap);
        expandProject(projectSelectionKey("local", project.id));
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
          upload: {
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
      applyBootstrapPayload,
      cloudSetupDialog,
      connection,
      defaultTeamId,
      expandProject,
      localProjectById,
      setCloudSetupDialog,
      setError,
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
        upload: null,
        error: null,
      });
    },
    [accountPending, accountSignedOut, connection, setCloudSetupDialog, showToast],
  );

  const changeWorkspaceTarget = useCallback(
    async (target: WorkspaceLocation) => {
      if (target === activeWorkspaceLocation || workspaceBusy || busy) return;
      setError(null);

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
