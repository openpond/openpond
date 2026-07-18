import { useCallback, useEffect, useMemo } from "react";
import type { RuntimeEvent, Session, SubagentDelegationMode } from "@openpond/contracts";
import { api } from "../api";
import { modelRefForTurn, type SidebarProjectItem } from "../lib/app-models";
import { mergeLiveRuntimeEventLists } from "../lib/runtime-event-lists";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "../lib/session-state";
import { hybridWorkspaceSessionMetadata, isHybridWorkspaceSession, type WorkspaceTargetValue } from "../lib/workspace-location";
import { useAppPanelActions } from "../hooks/useAppPanelActions";
import { useBrowserRevealRequests } from "../hooks/useBrowserRevealRequests";
import { useChatActions } from "../hooks/useChatActions";
import { useCloudSessionReady } from "../hooks/useCloudSessionReady";
import { useConversationSidebarState } from "../hooks/useConversationSidebarState";
import { useCloudWorkspaceSetup } from "../hooks/useCloudWorkspaceSetup";
import { useMainComposerSubmit } from "../hooks/useMainComposerSubmit";
import { useOpenSandboxWorkspace } from "../hooks/useOpenSandboxWorkspace";
import { useProjectActions } from "../hooks/useProjectActions";
import { useProjectTargetActions } from "../hooks/useProjectTargetActions";
import { useRightChatPanels } from "../hooks/useRightChatPanels";
import { useSidebarMutations } from "../hooks/useSidebarMutations";
import { useWorkspaceActions } from "../hooks/useWorkspaceActions";
import { teamChatThreadTitle } from "../lib/team-chat-thread";
import type { AppPrimaryRuntime } from "./useAppPrimaryRuntime";

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];

export function useAppSecondaryRuntime(primary: AppPrimaryRuntime) {
  const {
    composerDraftStore, appDispatch, mentionedAppId, setMentionedAppId, cloudSetupDialog, setCloudSetupDialog,
    setRightPanelTabRequest, workspaceDiffPanelViewState, setWorkspaceDiffPanelViewState, rightChatHistoryEvents, setRightChatHistoryEvents, locallyActiveCodexHistorySessionIds,
    setCodexHistoryTurnLocallyActive, setLabSuggestionsRequestId, draftSubagentDelegationMode, setDraftSubagentDelegationMode, confirmProjectAction, view,
    selectedAppId, selectedProjectId, selectedSessionId, draftProvider, draftModel, codexPermissionMode,
    codexReasoningEffort, openPondCommandAccessMode, busy, diffPanelOpen, diffPanelExpanded, rightPanelMode,
    rightChatPanels, newProjectMode, newProjectName, newProjectPath, newProjectBusy, commitMessage,
    commitIncludeUnstaged, commitNextStep, branchDialogName, setSectionMenuOpen, setSidebarOpen,
    setView, setSelectedAppId, setSelectedProjectId, setSelectedSessionId, setPrompt, setDraftProvider,
    setDraftModel, setDiffPanelOpen, setRightPanelMode, setRightChatPanels, setSyncingWorkspaceAppId, setSettingsSection,
    setNewProjectDialogOpen, setNewProjectMode, setNewProjectName, setNewProjectPath, setNewProjectBusy, setCommitDialogOpen,
    setBranchDialogOpen, setError, showToast, appPreferences, applyBootstrapPayload, bootstrap,
    connection, events, sessions, startup, setAppPreferences, setCodexHistorySessions,
    setEvents, setSessions, insights, revealProjectsSection, cloudProjectById, localProjectById,
    selectedApp, selectedCloudProject, selectedProject, selectedProjectLinkedOpenPondApp, selectedSession, sidebarSessions,
    runtimeIndexes, connectedAppMentions, codexHistoryEvents, setCodexHistoryEvents, account, accountPending,
    accountSignedOut, activeModel, activeProvider, activeWorkspaceAppId, activeWorkspaceKind, activeWorkspaceLocation,
    appDefaults, selectedSessionProjectId, workspaceName, accountScopeKey, teamChat, communities,
    selectedProjectConfirmedCloudProject, activeOpenPondCommandAccessMode, viewWorkspaceAppId, viewWorkspaceId, viewWorkspaceKind, openPondActionCatalog,
    selectedActionCatalog, expandProject, setExpandedProjectIds, selectedCloudWorkItem, createCloudWork, setCloudError,
    advanceTrainingModelChatAfterTurn, bindTrainingModelChatSession, prepareTrainingModelChatTurn, chatMessages, clearPendingChatUserMessage, pendingChatUserMessages,
    recordPendingChatUserMessage, runningSessionIds, workspaceBusy, visibleWorkspaceState, visibleWorkspaceDiff, rememberWorkspaceState,
    refreshWorkspace, setWorkspaceBusy, refreshWorkspaceDiffWhenNeeded, pendingWorkspaceTarget, setPendingWorkspaceTarget,
    pendingSidebarWorkspaceTarget, setPendingSidebarWorkspaceTarget, projectTarget, workspaceTarget,
  } = primary;
const title =
    view === "apps"
      ? "Apps"
      : view === "labs"
        ? "Lab"
        : view === "team"
          ? teamChat.detail
            ? teamChatThreadTitle(teamChat.detail.thread, teamChat.currentUserId)
            : "Team"
          : view === "community"
            ? communities.preview?.displayName ?? "Communities"
          : view === "cloud"
              ? (selectedCloudWorkItem?.title ?? "Cloud")
              : (selectedSession?.title ?? "New task");
  const {
    browserConversationId,
    handleWorkspaceDiffPanelViewStateChange,
  } = useConversationSidebarState({
    appDispatch,
    diffPanelExpanded,
    diffPanelOpen,
    rightChatPanels,
    rightPanelMode,
    selectedAppId,
    selectedCloudProject,
    selectedCloudWorkItem,
    selectedProjectId,
    selectedSession,
    selectedSessionId,
    setWorkspaceDiffPanelViewState,
    view,
    viewWorkspaceAppId,
    viewWorkspaceId,
    viewWorkspaceKind,
    workspaceDiffPanelViewState,
  });
  const openSessionInChat = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setSelectedAppId(null);
      setSelectedProjectId(null);
      setView("chat");
    },
    [setSelectedAppId, setSelectedProjectId, setSelectedSessionId, setView],
  );
  const insightsSystemProject = useMemo(
    () =>
      (bootstrap?.localProjects ?? []).find(
        (project) => project.systemKind === "openpond.insights",
      ) ?? null,
    [bootstrap?.localProjects],
  );
  const insightsSystemProjectId =
    insightsSystemProject?.id ?? insights.systemSession?.localProjectId ?? null;
  const insightsSystemProjectHidden = insightsSystemProjectId
    ? insightsSystemProject
      ? Boolean(insightsSystemProject.hiddenFromDefaultSidebar)
      : true
    : null;
  const toggleInsightsSystemProjectVisibility = useCallback(async () => {
    if (!connection || !insightsSystemProjectId) return;
    const hiddenFromDefaultSidebar = !(insightsSystemProjectHidden ?? true);
    try {
      const payload = await api.updateLocalProjectAgentSetup(connection, insightsSystemProjectId, {
        hiddenFromDefaultSidebar,
      });
      applyBootstrapPayload(payload.bootstrap);
      if (!hiddenFromDefaultSidebar) revealProjectsSection();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [
    applyBootstrapPayload,
    connection,
    insightsSystemProjectHidden,
    insightsSystemProjectId,
    revealProjectsSection,
    setError,
  ]);
  const toggleSystemProjectVisibility = useCallback(
    async (item: SidebarProjectItem) => {
      if (!connection || item.kind !== "local" || !item.project.systemKind) return;
      try {
        const payload = await api.updateLocalProjectAgentSetup(connection, item.project.id, {
          hiddenFromDefaultSidebar: !item.project.hiddenFromDefaultSidebar,
        });
        applyBootstrapPayload(payload.bootstrap);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    [applyBootstrapPayload, connection, setError],
  );
  const openExistingProjectPathDialog = useCallback(() => {
    setNewProjectMode("existing-local");
    setNewProjectName("");
    setNewProjectPath("");
    setNewProjectDialogOpen(true);
  }, [setNewProjectDialogOpen, setNewProjectMode, setNewProjectName, setNewProjectPath]);
  const {
    addProjectFolder,
    addProjectFolderPath,
    createCloudProjectFromScratch,
    createProjectFromScratch,
    removeProject,
  } = useProjectActions({
    connection,
    defaultTeamId: appDefaults.defaultTeamId,
    sessions,
    selectedProjectId,
    confirmProjectAction,
    openExistingProjectDialog: openExistingProjectPathDialog,
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
  });
  const { changeProjectTarget, submitNewProjectDialog } = useProjectTargetActions({
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
    projectTargetValue: projectTarget.value,
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
  });
  const {
    changeWorkspaceBranch,
    openCommitDialog,
    openCreateWorkspaceBranchDialog,
    openDefaultsSettingsFromBranchDialog,
    runWorkspaceTool,
    submitCommitDialog,
    submitCreateWorkspaceBranch,
    syncWorkspaceLocally,
  } = useWorkspaceActions({
    connection,
    activeWorkspaceAppId,
    appDefaults,
    bootstrap,
    branchDialogName,
    commitIncludeUnstaged,
    commitMessage,
    commitNextStep,
    draftModel,
    draftProvider,
    cloudProjects: bootstrap?.cloudProjects ?? [],
    selectedApp,
    selectedProject,
    selectedProjectLinkedOpenPondApp,
    selectedSession,
    sessions,
    title,
    visibleWorkspaceDiff,
    visibleWorkspaceState,
    workspaceBusy,
    workspaceName,
    appDispatch,
    applyBootstrapPayload,
    expandProject,
    refreshWorkspace,
    refreshWorkspaceDiff: refreshWorkspaceDiffWhenNeeded,
    rememberWorkspaceState,
    setBranchDialogOpen,
    setCommitDialogOpen,
    setError,
    setSessions,
    setSettingsSection,
    setSyncingWorkspaceAppId,
    setView,
    setWorkspaceBusy,
    showToast,
  });
  const ensureCloudSessionReady = useCloudSessionReady({
    applyBootstrapPayload,
    cloudProjects: bootstrap?.cloudProjects ?? [],
    connection,
    localProjectById,
    selectedCloudProject,
    selectedProject,
    setWorkspaceBusy,
    showToast,
    visibleWorkspaceState,
  });
  const subagentDelegationDefaultMode =
    bootstrap?.preferences.subagents.delegationMode ?? "balanced";
  const subagentDelegationMode =
    selectedSession?.subagentDelegationMode ?? draftSubagentDelegationMode;
  const subagentDelegationAvailable = Boolean(
    bootstrap?.preferences.subagents.enabled &&
    activeProvider !== "codex" &&
    !isCodexHistorySessionId(selectedSessionId) &&
    !selectedSession?.subagentRunId,
  );
  const changeSubagentDelegationMode = useCallback(
    (mode: SubagentDelegationMode | null) => {
      if (!selectedSession) {
        setDraftSubagentDelegationMode(mode);
        return;
      }
      if (
        !connection ||
        isCodexHistorySessionId(selectedSession.id) ||
        selectedSession.subagentRunId
      )
        return;
      const sessionId = selectedSession.id;
      const previousMode = selectedSession.subagentDelegationMode ?? null;
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, subagentDelegationMode: mode } : session,
        ),
      );
      void api
        .patchSession(connection, sessionId, { subagentDelegationMode: mode })
        .then((updated) => {
          setSessions((current) =>
            current.map((session) => (session.id === updated.id ? updated : session)),
          );
        })
        .catch((caught) => {
          setSessions((current) =>
            current.map((session) =>
              session.id === sessionId
                ? { ...session, subagentDelegationMode: previousMode }
                : session,
            ),
          );
          setError(caught instanceof Error ? caught.message : String(caught));
        });
    },
    [connection, selectedSession, setError, setSessions],
  );
  const applyRightCodexHistoryPayload = useCallback(
    (payload: { session: Session; events: RuntimeEvent[] }) => {
      setRightChatHistoryEvents((current) =>
        current[payload.session.id] === payload.events
          ? current
          : { ...current, [payload.session.id]: payload.events },
      );
      setCodexHistorySessions((current) =>
        upsertSessionPreservingLocalSidebarStateAndRecency(current, payload.session),
      );
    },
    [setCodexHistorySessions],
  );
  const {
    answerCreateImproveQuestion,
    applyCreateImproveCandidate,
    approveCreateImproveRun,
    cancelCreateImproveRun,
    changeDraftProvider,
    openCreateImprovePullRequest, reconcileCreateImprovePullRequest, rejectCreateImproveCandidate,
    pauseCreateImproveRun,
    resumeCreateImproveRun,
    reviseCreateImproveRun,
    sendPrompt,
    stopTurn,
  } = useChatActions({
    applyBootstrapPayload,
    bootstrap,
    chatMessages,
    connection,
    codexPermissionMode,
    codexReasoningEffort,
    openPondCommandAccessMode: activeOpenPondCommandAccessMode,
    draftModel,
    draftProvider,
    expandProject,
    getPrompt: composerDraftStore.getSnapshot,
    apps: bootstrap?.apps ?? [],
    connectedAppMentions,
    mentionedAppId,
    ensureCloudSessionReady,
    refreshWorkspace,
    refreshWorkspaceDiff: refreshWorkspaceDiffWhenNeeded,
    selectedApp,
    selectedActionCatalog,
    openPondActionCatalog,
    cloudProjects: bootstrap?.cloudProjects ?? [],
    accountScopeKey,
    selectedCloudProject,
    selectedProject,
    selectedProjectLinkedOpenPondApp,
    selectedSession,
    sessions,
    workspaceTarget: workspaceTarget.value,
    subagentDelegationMode: selectedSession?.subagentDelegationMode ?? draftSubagentDelegationMode,
    setDraftModel,
    setDraftProvider,
    setError,
    setPrompt,
    setMentionedAppId,
    setCodexHistoryEvents,
    setCodexHistorySessions,
    onCodexHistoryTurnActivityChange: setCodexHistoryTurnLocallyActive,
    onCodexHistoryTurnPayload: applyRightCodexHistoryPayload,
    onPendingUserMessage: recordPendingChatUserMessage,
    onClearPendingUserMessage: clearPendingChatUserMessage,
    setEvents,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
    setSessions,
    setView,
    setWorkspaceBusy,
  });
  const {
    archiveSession,
    restoreSession,
    renameSession,
    toggleProjectPinned,
    toggleSessionPinned,
  } = useSidebarMutations({
    appPreferences,
    connection,
    selectedSessionId,
    setAppPreferences,
    setCodexHistorySessions,
    setError,
    setSelectedSessionId,
    setSessions,
  });
  const {
    changeWorkspaceTarget: changeWorkspaceTargetBase,
    moveProjectToCloud,
    startCloudSetupUpload,
  } = useCloudWorkspaceSetup({
    account,
    accountPending,
    accountSignedOut,
    activeWorkspaceKind,
    activeWorkspaceLocation,
    appDispatch,
    applyBootstrapPayload,
    busy,
    cloudSetupDialog,
    cloudProjects: bootstrap?.cloudProjects ?? [],
    connection,
    defaultTeamId: appDefaults.defaultTeamId,
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
  });
  const changeWorkspaceTarget = useCallback(
    async (target: WorkspaceTargetValue) => {
      if (target === "queue_cloud") {
        const linkedCloudProjectId =
          selectedCloudProject?.id ?? selectedProjectConfirmedCloudProject?.id ?? null;
        if (!linkedCloudProjectId) {
          setPendingWorkspaceTarget(null);
          await changeWorkspaceTargetBase(target);
          return;
        }
        setPendingWorkspaceTarget("queue_cloud");
        showToast("Next message will queue a Cloud work item and keep this chat local.", "info");
        return;
      }
      if (target === "hybrid") {
        const linkedCloudProjectId =
          selectedCloudProject?.id ??
          selectedProjectConfirmedCloudProject?.id ??
          selectedSession?.cloudProjectId ??
          null;
        const linkedCloudTeamId =
          selectedCloudProject?.teamId ??
          selectedProjectConfirmedCloudProject?.teamId ??
          selectedSession?.cloudTeamId ??
          null;
        if (accountPending) {
          showToast("Checking OpenPond account. Try again in a moment.", "info");
          return;
        }
        if (accountSignedOut) {
          showToast("Add an OpenPond account before using Hybrid.", "error");
          return;
        }
        if (!linkedCloudProjectId || !linkedCloudTeamId) {
          setPendingWorkspaceTarget(null);
          showToast("Upload/sync this Project to Cloud before using Hybrid.", "error");
          return;
        }
        if (selectedSession && !isCodexHistorySessionId(selectedSession.id)) {
          if (isHybridWorkspaceSession(selectedSession)) return;
          if (!connection) {
            showToast("OpenPond App server is not connected.", "error");
            return;
          }
          const updated = await api.patchSession(connection, selectedSession.id, {
            provider: draftProvider,
            modelRef: modelRefForTurn(draftProvider, draftModel, bootstrap?.providers ?? null),
            appId: null,
            appName: null,
            workspaceKind: "sandbox",
            workspaceId: null,
            workspaceName:
              selectedCloudProject?.name ??
              selectedProjectConfirmedCloudProject?.name ??
              selectedProject?.name ??
              selectedSession.workspaceName ??
              "Hybrid workspace",
            localProjectId: selectedProject?.id ?? selectedSession.localProjectId ?? null,
            cloudProjectId: linkedCloudProjectId,
            cloudTeamId: linkedCloudTeamId,
            metadata: hybridWorkspaceSessionMetadata(selectedSession.metadata),
            cwd: selectedProject?.workspacePath ?? selectedSession.cwd ?? null,
          });
          setSessions((current) =>
            current.map((session) => (session.id === updated.id ? updated : session)),
          );
          setPendingWorkspaceTarget(null);
          showToast("Hybrid will use your selected model with hosted sandbox edits.", "info");
          return;
        }
        setPendingWorkspaceTarget("hybrid");
        showToast("Next message will use Hybrid with a hosted sandbox.", "info");
        return;
      }
      setPendingWorkspaceTarget(null);
      await changeWorkspaceTargetBase(target);
    },
    [
      accountPending,
      accountSignedOut,
      bootstrap?.providers,
      changeWorkspaceTargetBase,
      connection,
      draftModel,
      draftProvider,
      selectedCloudProject?.id,
      selectedCloudProject?.name,
      selectedCloudProject?.teamId,
      selectedProject?.id,
      selectedProjectConfirmedCloudProject?.id,
      selectedProjectConfirmedCloudProject?.name,
      selectedProjectConfirmedCloudProject?.teamId,
      selectedProject?.name,
      selectedProject?.workspacePath,
      selectedSession,
      setSessions,
      showToast,
    ],
  );
  const switchProjectWorkspaceTarget = useCallback(
    (projectId: string, target: WorkspaceTargetValue) => {
      setSelectedAppId(null);
      setSelectedProjectId(projectId);
      setSelectedSessionId(null);
      setView("chat");
      expandProject(projectId);
      setPendingSidebarWorkspaceTarget({ projectId, target });
    },
    [expandProject, setSelectedAppId, setSelectedProjectId, setSelectedSessionId, setView],
  );
  useEffect(() => {
    if (!pendingSidebarWorkspaceTarget) return;
    if (
      view !== "chat" ||
      selectedProjectId !== pendingSidebarWorkspaceTarget.projectId ||
      selectedSessionId !== null
    ) {
      return;
    }
    const target = pendingSidebarWorkspaceTarget.target;
    setPendingSidebarWorkspaceTarget(null);
    void changeWorkspaceTarget(target);
  }, [
    changeWorkspaceTarget,
    pendingSidebarWorkspaceTarget,
    selectedProjectId,
    selectedSessionId,
    view,
  ]);
  const sendPromptFromMainComposer = useMainComposerSubmit({
    advanceTrainingTurn: advanceTrainingModelChatAfterTurn,
    bindTrainingSession: bindTrainingModelChatSession,
    composerDraftStore,
    createCloudWork,
    onSessionCreated: () => setDraftSubagentDelegationMode(null),
    pendingWorkspaceTarget,
    prepareTrainingTurn: prepareTrainingModelChatTurn,
    selectedCloudProjectId: selectedCloudProject?.id ?? null,
    selectedLocalProjectId: selectedProject?.id ?? null,
    selectedLocalProjectName: selectedProject?.name ?? null,
    selectedLocalWorkspacePath: selectedProject?.workspacePath ?? selectedProject?.path ?? null,
    selectedProjectCloudBaseSha: selectedProject?.linkedSandboxProject?.lastUploadedCommit ?? null,
    selectedProjectCloudProjectId: selectedProjectConfirmedCloudProject?.id ?? null,
    selectedProjectCloudSourceRef:
      selectedProject?.linkedSandboxProject?.defaultBranch ??
      visibleWorkspaceState?.currentBranch ??
      null,
    sendPrompt,
    setMentionedAppId,
    setPendingWorkspaceTarget,
    setPrompt,
    showToast,
  });

  const openSandboxWorkspace = useOpenSandboxWorkspace({
    appDispatch,
    connection,
    sessions,
    setDiffPanelOpen,
    setRightPanelMode,
    setSessions,
    setView,
  });

  const {
    createCloudEnvironmentFromSidebar,
    openCloudProjectDialog,
    openUrlInBrowserPanel,
    showBrowserPanel,
    showChangesPanel,
    showGoalSidebarTab,
    setupCloudProjectFromCloudView,
  } = useAppPanelActions({
    account,
    browserConversationId,
    cloudProjectById,
    cloudProjects: bootstrap?.cloudProjects ?? [],
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
  });
  const browserRevealSessionIds = useMemo(() => sessions.map((session) => session.id), [sessions]);
  useBrowserRevealRequests({
    browserConversationId,
    sessionIds: browserRevealSessionIds,
    onOpenSession: openSessionInChat,
    onShowBrowserPanel: showBrowserPanel,
  });
  const openLabSuggestions = useCallback(() => {
    setView("labs");
    setLabSuggestionsRequestId((requestId) => requestId + 1);
  }, [setView]);
  const {
    closeRightChatPanel,
    openRightChatPanel,
    rightChatPanelViews,
    showRightChatPanel,
    showRightPanelDiffTab,
    submitRightChatPrompt,
    updateRightChatModel,
    updateRightChatPrompt,
    updateRightChatProvider,
  } = useRightChatPanels({
    activeModel,
    activeProvider,
    applyRightCodexHistoryPayload,
    codexHistoryEvents,
    connectedAppMentions,
    connection,
    contextCompaction: appDefaults.contextCompaction,
    insights,
    openLabSuggestions,
    locallyActiveCodexHistorySessionIds,
    openPondCommandAccessMode,
    pendingChatUserMessages,
    providerSettings: bootstrap?.providers ?? null,
    rightChatHistoryEvents,
    rightChatPanels,
    rightPanelMode,
    runtimeIndexes,
    runningSessionIds,
    selectedSession,
    selectedSessionId,
    sendPrompt,
    setDiffPanelOpen,
    setDraftModel,
    setDraftProvider,
    setError,
    setRightChatHistoryEvents,
    setRightChatPanels,
    setRightPanelMode,
    setRightPanelTabRequest,
    setView,
    showChangesPanel,
    showToast,
    sidebarSessions,
    startupReady: startup.ready,
  });
  const openProfileSettings = useCallback(() => {
    setSectionMenuOpen(null);
    setView("labs");
    setSidebarOpen(true);
  }, [setSectionMenuOpen, setSidebarOpen, setView]);
  const diagnosticEvents = useMemo(
    () =>
      mergeLiveRuntimeEventLists(
        bootstrap?.diagnostics ?? EMPTY_RUNTIME_EVENTS,
        events.filter((event) => event.name === "diagnostic"),
      ),
    [bootstrap?.diagnostics, events],
  );
  const toggleRightSidebar = useCallback(() => {
    if (diffPanelOpen) {
      setDiffPanelOpen(false);
      return;
    }
    if (view === "labs") {
      setRightPanelMode("changes");
      setRightPanelTabRequest({ id: Date.now(), tab: "summary" });
      setDiffPanelOpen(true);
      return;
    }
    setRightPanelMode("home");
    setDiffPanelOpen(true);
  }, [diffPanelOpen, setDiffPanelOpen, setRightPanelMode, setRightPanelTabRequest, view]);
  return {
    title, browserConversationId, handleWorkspaceDiffPanelViewStateChange, openSessionInChat, insightsSystemProjectHidden,
    toggleInsightsSystemProjectVisibility, toggleSystemProjectVisibility, openExistingProjectPathDialog, addProjectFolder, removeProject,
    changeProjectTarget, submitNewProjectDialog, changeWorkspaceBranch, openCommitDialog, openCreateWorkspaceBranchDialog,
    openDefaultsSettingsFromBranchDialog, runWorkspaceTool, submitCommitDialog, submitCreateWorkspaceBranch, syncWorkspaceLocally,
    subagentDelegationDefaultMode, subagentDelegationMode, subagentDelegationAvailable, changeSubagentDelegationMode, answerCreateImproveQuestion,
    applyCreateImproveCandidate, approveCreateImproveRun, cancelCreateImproveRun, changeDraftProvider, openCreateImprovePullRequest,
    reconcileCreateImprovePullRequest, rejectCreateImproveCandidate, pauseCreateImproveRun, resumeCreateImproveRun, reviseCreateImproveRun,
    sendPrompt, stopTurn, archiveSession, restoreSession, renameSession,
    toggleProjectPinned, toggleSessionPinned, moveProjectToCloud, startCloudSetupUpload, changeWorkspaceTarget,
    switchProjectWorkspaceTarget, sendPromptFromMainComposer, openSandboxWorkspace, createCloudEnvironmentFromSidebar, openCloudProjectDialog,
    openUrlInBrowserPanel, showBrowserPanel, showChangesPanel, showGoalSidebarTab, setupCloudProjectFromCloudView,
    openLabSuggestions, closeRightChatPanel, openRightChatPanel, rightChatPanelViews, showRightChatPanel,
    showRightPanelDiffTab, submitRightChatPrompt, updateRightChatModel, updateRightChatPrompt, updateRightChatProvider,
    openProfileSettings, diagnosticEvents, toggleRightSidebar,
  };
}

export type AppSecondaryRuntime = ReturnType<typeof useAppSecondaryRuntime>;
