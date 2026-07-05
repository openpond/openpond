import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatProvider, CloudProject, LocalProject } from "@openpond/contracts";
import type { AppAction, NewProjectMode, ShowAppToast } from "../app/app-state";
import { normalizeChatModel, projectSelectionKey } from "../lib/app-models";

export function useProjectTargetActions({
  addProjectFolder,
  addProjectFolderPath,
  appDispatch,
  busy,
  cloudProjectById,
  createCloudProjectFromScratch,
  createProjectFromScratch,
  expandProject,
  localProjectById,
  newProjectBusy,
  newProjectMode,
  newProjectName,
  newProjectPath,
  projectTargetValue,
  setDiffPanelOpen,
  setDraftModel,
  setDraftProvider,
  setError,
  setNewProjectBusy,
  setNewProjectDialogOpen,
  setNewProjectName,
  setNewProjectPath,
  showToast,
  workspaceBusy,
}: {
  addProjectFolder: () => void | Promise<void>;
  addProjectFolderPath: (path: string) => Promise<unknown>;
  appDispatch: Dispatch<AppAction>;
  busy: boolean;
  cloudProjectById: Map<string, CloudProject>;
  createCloudProjectFromScratch: (name: string) => Promise<unknown>;
  createProjectFromScratch: (name: string) => Promise<unknown>;
  expandProject: (projectId: string) => void;
  localProjectById: Map<string, LocalProject>;
  newProjectBusy: boolean;
  newProjectMode: NewProjectMode;
  newProjectName: string;
  newProjectPath: string;
  projectTargetValue: string;
  setDiffPanelOpen: Dispatch<SetStateAction<boolean>>;
  setDraftModel: Dispatch<SetStateAction<string>>;
  setDraftProvider: Dispatch<SetStateAction<ChatProvider>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setNewProjectBusy: Dispatch<SetStateAction<boolean>>;
  setNewProjectDialogOpen: Dispatch<SetStateAction<boolean>>;
  setNewProjectName: Dispatch<SetStateAction<string>>;
  setNewProjectPath: Dispatch<SetStateAction<string>>;
  showToast: ShowAppToast;
  workspaceBusy: boolean;
}) {
  const changeProjectTarget = useCallback(
    (target: string) => {
      if (target === projectTargetValue || busy || workspaceBusy) return;
      setError(null);

      if (target === "action:add-local-project") {
        void addProjectFolder();
        return;
      }
      if (target === "none") {
        appDispatch({ type: "beginNewChat", appId: null });
        setDiffPanelOpen(false);
        showToast("Started a chat without project files.", "info");
        return;
      }

      const separatorIndex = target.indexOf(":");
      const kind = separatorIndex >= 0 ? target.slice(0, separatorIndex) : "";
      const projectId = separatorIndex >= 0 ? target.slice(separatorIndex + 1) : "";
      if (kind === "local") {
        const project = localProjectById.get(projectId);
        if (!project) {
          showToast("Project is no longer available.", "error");
          return;
        }
        const projectKey = projectSelectionKey("local", project.id);
        appDispatch({ type: "selectProject", projectId: projectKey });
        expandProject(projectKey);
        setDiffPanelOpen(false);
        showToast(`Selected ${project.name}.`, "info");
        return;
      }
      if (kind === "cloud") {
        const project = cloudProjectById.get(projectId);
        if (!project) {
          showToast("Cloud Project is no longer available.", "error");
          return;
        }
        const projectKey = projectSelectionKey("cloud", project.id);
        appDispatch({ type: "selectProject", projectId: projectKey });
        expandProject(projectKey);
        setDraftProvider("openpond");
        setDraftModel((current) => normalizeChatModel("openpond", current));
        setDiffPanelOpen(false);
        showToast(`Selected Cloud Project: ${project.name}.`, "info");
      }
    },
    [
      addProjectFolder,
      appDispatch,
      busy,
      cloudProjectById,
      expandProject,
      localProjectById,
      projectTargetValue,
      setDiffPanelOpen,
      setDraftModel,
      setDraftProvider,
      setError,
      showToast,
      workspaceBusy,
    ],
  );

  const submitNewProjectDialog = useCallback(async () => {
    const projectName = newProjectName.trim();
    const projectPath = newProjectPath.trim();
    if (newProjectBusy) return;
    if (newProjectMode === "existing-local" ? !projectPath : !projectName) return;
    setNewProjectBusy(true);
    try {
      const created =
        newProjectMode === "cloud"
          ? await createCloudProjectFromScratch(projectName)
          : newProjectMode === "existing-local"
            ? await addProjectFolderPath(projectPath)
          : await createProjectFromScratch(projectName);
      if (created) {
        setNewProjectDialogOpen(false);
        setNewProjectName("");
        setNewProjectPath("");
      }
    } finally {
      setNewProjectBusy(false);
    }
  }, [
    addProjectFolderPath,
    createCloudProjectFromScratch,
    createProjectFromScratch,
    newProjectBusy,
    newProjectMode,
    newProjectName,
    newProjectPath,
    setNewProjectBusy,
    setNewProjectDialogOpen,
    setNewProjectName,
    setNewProjectPath,
  ]);

  return {
    changeProjectTarget,
    submitNewProjectDialog,
  };
}
