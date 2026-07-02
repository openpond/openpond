import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import type { BootstrapPayload, CloudProject, CloudWorkItem } from "@openpond/contracts";
import type { NewProjectMode, RightPanelMode } from "../app/app-state";
import { openBrowserLink } from "../lib/browser-sidebar-links";
import { buildCloudEnvironmentCreateUrl } from "../lib/cloud-environment-setup";

export function useAppPanelActions({
  account,
  browserConversationId,
  cloudProjectById,
  cloudProjects,
  diffPanelOpen,
  rightPanelMode,
  selectedCloudWorkItem,
  selectedProjectId,
  setCloudError,
  setDiffPanelOpen,
  setNewProjectDialogOpen,
  setNewProjectMode,
  setNewProjectName,
  setRightPanelMode,
}: {
  account: BootstrapPayload["account"] | null;
  browserConversationId: string;
  cloudProjectById: Map<string, CloudProject>;
  cloudProjects: CloudProject[];
  diffPanelOpen: boolean;
  rightPanelMode: RightPanelMode;
  selectedCloudWorkItem: CloudWorkItem | null;
  selectedProjectId: string | null;
  setCloudError: Dispatch<SetStateAction<string | null>>;
  setDiffPanelOpen: Dispatch<SetStateAction<boolean>>;
  setNewProjectDialogOpen: Dispatch<SetStateAction<boolean>>;
  setNewProjectMode: Dispatch<SetStateAction<NewProjectMode>>;
  setNewProjectName: Dispatch<SetStateAction<string>>;
  setRightPanelMode: Dispatch<SetStateAction<RightPanelMode>>;
}) {
  const showChangesPanel = useCallback(() => {
    setRightPanelMode("changes");
    setDiffPanelOpen(true);
  }, [setDiffPanelOpen, setRightPanelMode]);

  const toggleChangesPanel = useCallback(() => {
    if (diffPanelOpen && rightPanelMode === "changes") {
      setDiffPanelOpen(false);
      return;
    }
    showChangesPanel();
  }, [diffPanelOpen, rightPanelMode, setDiffPanelOpen, showChangesPanel]);

  const showBrowserPanel = useCallback(() => {
    setRightPanelMode("browser");
    setDiffPanelOpen(true);
  }, [setDiffPanelOpen, setRightPanelMode]);

  const showGoalSidebarTab = useCallback(() => {
    setRightPanelMode("goal");
    setDiffPanelOpen(true);
  }, [setDiffPanelOpen, setRightPanelMode]);

  const openUrlInBrowserPanel = useCallback(
    (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => {
      void openBrowserLink({
        conversationId: browserConversationId,
        href,
        explicitFile: options?.explicitFile,
        newTab: options?.newTab,
      }).then((opened) => {
        if (opened) showBrowserPanel();
      });
    },
    [browserConversationId, showBrowserPanel],
  );

  const openCloudProjectDialog = useCallback(() => {
    setNewProjectMode("cloud");
    setNewProjectName("");
    setNewProjectDialogOpen(true);
  }, [setNewProjectDialogOpen, setNewProjectMode, setNewProjectName]);

  const setupCloudProjectFromCloudView = useCallback(
    (projectId: string) => {
      const project = cloudProjectById.get(projectId);
      if (!project) {
        setCloudError("Select a Cloud Project before setup.");
        return;
      }
      openUrlInBrowserPanel(
        buildCloudEnvironmentCreateUrl({
          accountBaseUrl: account?.baseUrl ?? account?.activeProfile?.baseUrl ?? null,
          teamId: project.teamId,
          projectId: project.id,
          projectName: project.name,
          baseBranch: project.defaultBranch,
          source: "openpond-app",
        }),
        { newTab: true },
      );
    },
    [account, cloudProjectById, openUrlInBrowserPanel, setCloudError],
  );

  const createCloudEnvironmentFromSidebar = useCallback(() => {
    const selectedCloudProjectId = selectedProjectId?.startsWith("cloud:")
      ? selectedProjectId.slice("cloud:".length)
      : (selectedCloudWorkItem?.projectId ?? cloudProjects[0]?.id ?? null);
    if (selectedCloudProjectId) {
      setupCloudProjectFromCloudView(selectedCloudProjectId);
      return;
    }
    openCloudProjectDialog();
  }, [
    cloudProjects,
    openCloudProjectDialog,
    selectedCloudWorkItem,
    selectedProjectId,
    setupCloudProjectFromCloudView,
  ]);

  return {
    createCloudEnvironmentFromSidebar,
    openCloudProjectDialog,
    openUrlInBrowserPanel,
    showBrowserPanel,
    showChangesPanel,
    showGoalSidebarTab,
    toggleChangesPanel,
    setupCloudProjectFromCloudView,
  };
}
