import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatProvider, CloudProject, LocalProject, Session } from "@openpond/contracts";
import type { AppAction, NewProjectMode, ShowAppToast } from "../app/app-state";
import { api, type ClientConnection } from "../api";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { sessionProjectAssignment } from "../lib/session-project-assignment";
import { normalizeChatModel, projectSelectionKey } from "../lib/app-models";

export function useProjectTargetActions({
  appDispatch,
  connection,
  selectedSession,
  setSessions,
  setWorkspaceBusy,
  busy,
  cloudProjectById,
  createCloudProjectFromScratch,
  createProjectFromScratch,
  createProjectCollection,
  expandProject,
  localProjectById,
  onCreateCloudEnvironment,
  onNewCloudProject,
  onNewLocalProject,
  onUseExistingFolderPath,
  newProjectBusy,
  newProjectMode,
  newProjectName,
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
  appDispatch: Dispatch<AppAction>;
  connection: ClientConnection | null;
  selectedSession: Session | null;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setWorkspaceBusy: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  cloudProjectById: Map<string, CloudProject>;
  createCloudProjectFromScratch: (name: string) => Promise<unknown>;
  createProjectFromScratch: (name: string) => Promise<unknown>;
  createProjectCollection: (input: { name: string; sourceFolders: string[]; primaryFolder: string }) => Promise<boolean>;
  expandProject: (projectId: string) => void;
  localProjectById: Map<string, LocalProject>;
  onCreateCloudEnvironment: () => void;
  onNewCloudProject: () => void;
  onNewLocalProject: () => void;
  onUseExistingFolderPath: () => void;
  newProjectBusy: boolean;
  newProjectMode: NewProjectMode;
  newProjectName: string;
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
  const assignmentScope = useRef({ connection, sessionId: selectedSession?.id });
  assignmentScope.current = { connection, sessionId: selectedSession?.id };
  const changeProjectTarget = useCallback(
    async (target: string) => {
      const needsNativeFolderRepair = selectedSession?.nativeAgent && selectedSession.nativeAgent.cwd !== selectedSession.cwd;
      if ((target === projectTargetValue && !needsNativeFolderRepair) || busy || workspaceBusy) return;
      setError(null);

      if (target === "action:new-local-project") {
        onNewLocalProject();
        return;
      }
      if (target === "action:add-local-project") {
        onUseExistingFolderPath();
        return;
      }
      if (target === "action:add-local-project-path") {
        onUseExistingFolderPath();
        return;
      }
      if (target === "action:new-cloud-project") {
        onNewCloudProject();
        return;
      }
      if (target === "action:create-cloud-environment") {
        onCreateCloudEnvironment();
        return;
      }
      if (target === "none") {
        appDispatch({ type: "selectProject", projectId: null });
        setDiffPanelOpen(false);
        showToast("Started a chat without project files.", "info");
        return;
      }

      const separatorIndex = target.indexOf(":");
      const kind = separatorIndex >= 0 ? target.slice(0, separatorIndex) : "";
      const projectId = separatorIndex >= 0 ? target.slice(separatorIndex + 1) : "";
      if (selectedSession && (kind === "local" || kind === "cloud")) {
        const project = kind === "local" ? localProjectById.get(projectId) : cloudProjectById.get(projectId);
        if (!project || !connection) return;
        if (isCodexHistorySessionId(selectedSession.id)) {
          showToast("Imported native history cannot change its project. Start a new task in that project.", "error");
          return;
        }
        setWorkspaceBusy(true);
        try {
          const updated = await api.patchSession(connection, selectedSession.id,
            sessionProjectAssignment(selectedSession, project, kind, [...cloudProjectById.values()]));
          setSessions(current => current.map(session => session.id === updated.id ? updated : session));
          if (assignmentScope.current.connection !== connection || assignmentScope.current.sessionId !== selectedSession.id) return;
          const projectKey = projectSelectionKey(kind, project.id);
          appDispatch({ type: "selectSession", sessionId: updated.id, appId: updated.appId, projectId: projectKey });
          expandProject(projectKey);
          showToast(`Attached this chat to ${project.name}.`, "success");
        } catch (error) {
          if (assignmentScope.current.sessionId === selectedSession.id) showToast(error instanceof Error ? error.message : "Could not attach this chat.", "error");
        } finally {
          setWorkspaceBusy(false);
        }
        return;
      }
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
      }
    },
    [
      appDispatch,
      connection,
      selectedSession,
      setSessions,
      setWorkspaceBusy,
      busy,
      cloudProjectById,
      expandProject,
      localProjectById,
      onCreateCloudEnvironment,
      onNewCloudProject,
      onNewLocalProject,
      onUseExistingFolderPath,
      projectTargetValue,
      setDiffPanelOpen,
      setDraftModel,
      setDraftProvider,
      setError,
      showToast,
      workspaceBusy,
    ],
  );

  const submitNewProjectDialog = useCallback(async (collection?: { name: string; sourceFolders: string[]; primaryFolder: string }) => {
    const projectName = newProjectName.trim();
    if (newProjectBusy) return;
    if (newProjectMode === "existing-local" ? !collection?.name.trim() || !collection.sourceFolders.length : !projectName) return false;
    setNewProjectBusy(true);
    try {
      const created =
        newProjectMode === "cloud"
          ? await createCloudProjectFromScratch(projectName)
          : newProjectMode === "existing-local"
            ? await createProjectCollection(collection!)
          : await createProjectFromScratch(projectName);
      if (created) {
        setNewProjectDialogOpen(false);
        setNewProjectName("");
        setNewProjectPath("");
      }
      return Boolean(created);
    } finally {
      setNewProjectBusy(false);
    }
  }, [
    createCloudProjectFromScratch,
    createProjectFromScratch,
    createProjectCollection,
    newProjectBusy,
    newProjectMode,
    newProjectName,
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
