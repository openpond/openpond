import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Experience,
  RuntimeEvent,
  SidebarFileBookmark,
  SubagentDelegationMode,
  WorkspaceState,
  TerminalScope,
} from "@openpond/contracts";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_PROVIDER,
} from "@openpond/contracts";
import { useProjectConfirmDialog } from "../components/app-shell/ProjectConfirmDialog";
import type { CloudSetupDialogState } from "../components/workspace/CloudSetupDialog";
import {
  defaultModelForProvider,
  projectSelectionKey,
  providerOptionsFromSettings,
} from "../lib/app-models";
import { openPondOrganizationCacheKey } from "../lib/openpond-organization-memory";
import { sidebarSessionsForExperience } from "../lib/experience-sessions";
import {
  migrateDraftTerminalTabs,
  terminalScopeForSelection,
  terminalScopesEqual,
  terminalScopeSummaries,
} from "../components/terminal/terminal-state";
import type {
  TerminalQueuedCommand,
  TerminalTab,
} from "../components/terminal/terminal-overlay-types";
import {
  defaultWorkspaceDiffPanelViewState,
  type WorkspaceDiffPanelViewState,
  type WorkspaceDiffTabRequest,
} from "../components/workspace-diff/workspace-diff-panel-model";
import {
  isCloudWorkspaceKind,
  type WorkspaceTargetValue,
} from "../lib/workspace-location";
import { openPondAccountScopeKey } from "../lib/account-scope";
import { resolveTeamChatOpenPondOrganization } from "../lib/cloud-project-utils";
import { confirmedLinkedCloudProject } from "../lib/cloud-link-trust";
import {
  useActiveWorkspaceViewState,
  useWorkspaceTargetState,
} from "../hooks/useActiveWorkspaceViewState";
import { useAppSelectionState } from "../hooks/useAppSelectionState";
import { useAppShellEffects } from "../hooks/useAppShellEffects";
import { useApprovalResolver } from "../hooks/useApprovalResolver";
import { useAppDerivedRows } from "../hooks/useAppDerivedRows";
import { useBeginNewChat } from "../hooks/useBeginNewChat";
import { useAppConversationContext } from "../hooks/useAppConversationContext";
import { useCodexPreferenceActions } from "../hooks/useCodexPreferenceActions";
import { useCodexHistoryEvents } from "../hooks/useCodexHistoryEvents";
import { usePinnedSidebarDrag } from "../hooks/usePinnedSidebarDrag";
import { useSidebarTaskOrder } from "../hooks/useSidebarTaskOrder";
import { usePendingChatMessages } from "../hooks/usePendingChatMessages";
import { useOpenPondCommandAccessActions } from "../hooks/useOpenPondCommandAccessActions";
import { useSidebarData } from "../hooks/useSidebarData";
import { useSidebarRuntimeState } from "../hooks/useSidebarRuntimeState";
import { useCommandShortcuts } from "../hooks/useAppEffects";
import { useAppBootstrap } from "../hooks/useAppBootstrap";
import { useAppErrorReporter } from "../hooks/useAppErrorReporter";
import { useAppState } from "../hooks/useAppState";
import { useGitSetupNotifications } from "../hooks/useGitSetupNotifications";
import { useLayoutPreferences } from "../hooks/useLayoutPreferences";
import { useLabDetailNavigation } from "../hooks/useLabDetailNavigation";
import { useTraining } from "../hooks/useTraining";
import { useTrainingModelChatHandoff } from "../hooks/useTrainingModelChatHandoff";
import { useSelectedChatHistory } from "../hooks/useSelectedChatHistory";
import { useRuntimeIndexes } from "../hooks/useRuntimeIndexes";
import { useSandboxActionContext } from "../hooks/useSandboxActionContext";
import { useSidebarExpansion } from "../hooks/useSidebarExpansion";
import { useWorkspaceController } from "../hooks/useWorkspaceController";
import { useTeamChat } from "../hooks/useTeamChat";
import { useTeamProfileAgentPublisher } from "../hooks/useTeamProfileAgentPublisher";
import { useTeamChatIncomingToast } from "../hooks/useTeamChatIncomingToast";
import { useCommunityController } from "../hooks/useCommunityController";
import { useOpenPondOrganizations } from "../hooks/useOpenPondOrganizations";
import { useConnectedAppStatusRows } from "../hooks/useConnectedAppStatusRows";
import { api } from "../api";

export function useAppPrimaryRuntime() {
  const {
    composerDraftStore,
    dispatch: appDispatch,
    setters: appSetters,
    state: appState,
  } = useAppState();
  const [pendingTerminalCommand, setPendingTerminalCommand] =
    useState<TerminalQueuedCommand | null>(null);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [trainingDetailTasksetId, setTrainingDetailTasksetId] = useState<
    string | null
  >(null);
  const [mentionedAppId, setMentionedAppId] = useState<string | null>(null);
  const [sidebarFileBookmarks, setSidebarFileBookmarks] = useState<
    SidebarFileBookmark[]
  >([]);
  const [cloudSetupDialog, setCloudSetupDialog] =
    useState<CloudSetupDialogState | null>(null);
  const [rightPanelTabRequest, setRightPanelTabRequest] =
    useState<WorkspaceDiffTabRequest | null>(null);
  const [workspaceDiffPanelViewState, setWorkspaceDiffPanelViewState] =
    useState<WorkspaceDiffPanelViewState>(defaultWorkspaceDiffPanelViewState);
  const [rightChatHistoryEvents, setRightChatHistoryEvents] = useState<
    Record<string, RuntimeEvent[]>
  >({});
  const [
    locallyActiveCodexHistorySessionIds,
    setLocallyActiveCodexHistorySessionIds,
  ] = useState<ReadonlySet<string>>(() => new Set());
  const setCodexHistoryTurnLocallyActive = useCallback(
    (sessionId: string, active: boolean) => {
      setLocallyActiveCodexHistorySessionIds((current) => {
        if (current.has(sessionId) === active) return current;
        const next = new Set(current);
        if (active) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    },
    []
  );
  const [mainComposerFocusRequestId, setMainComposerFocusRequestId] =
    useState(0);
  const [draftSubagentDelegationMode, setDraftSubagentDelegationMode] =
    useState<SubagentDelegationMode | null>(null);
  const rememberWorkspaceStateRef = useRef<
    ((state: WorkspaceState) => void) | null
  >(null);
  const {
    confirmProjectAction,
    projectConfirmDialog,
    resolveProjectConfirmDialog,
  } = useProjectConfirmDialog();
  const {
    query,
    searchOpen,
    archivedChatsOpen,
    sectionMenuOpen,
    projectsExpanded,
    cloudProjectsExpanded,
    chatRowsVisibleCount,
    sidebarOpen,
    view,
    selectedAppId,
    selectedProjectId,
    selectedSessionId,
    draftProvider,
    draftModel,
    draftExperience,
    codexPermissionMode,
    codexReasoningEffort,
    openPondCommandAccessMode,
    busy,
    diffPanelOpen,
    diffPanelExpanded,
    rightPanelMode,
    rightChatPanels,
    terminalOpen,
    settingsSection,
    newProjectDialogOpen,
    newProjectMode,
    newProjectName,
    newProjectPath,
    newProjectBusy,
    commitDialogOpen,
    commitMessage,
    commitIncludeUnstaged,
    commitNextStep,
    commitDraft,
    branchDialogOpen,
    branchDialogName,
    toast,
    error,
  } = appState;
  const labDetailNavigation = useLabDetailNavigation(view === "labs");
  const {
    setQuery,
    setSearchOpen,
    setArchivedChatsOpen,
    setSectionMenuOpen,
    setProjectsExpanded,
    setCloudProjectsExpanded,
    setChatRowsVisibleCount,
    setSidebarOpen,
    setView,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
    setPrompt,
    setDraftProvider,
    setDraftModel,
    setDraftExperience,
    setCodexPermissionMode,
    setCodexReasoningEffort,
    setOpenPondCommandAccessMode,
    setDiffPanelOpen,
    setDiffPanelExpanded,
    setRightPanelMode,
    setRightChatPanels,
    setTerminalOpen,
    setSyncingWorkspaceAppId,
    setSettingsSection,
    setNewProjectDialogOpen,
    setNewProjectMode,
    setNewProjectName,
    setNewProjectPath,
    setNewProjectBusy,
    setCommitDialogOpen,
    setCommitMessage,
    setCommitIncludeUnstaged,
    setCommitNextStep,
    setCommitDraft,
    setBranchDialogOpen,
    setBranchDialogName,
    setError: setErrorState,
  } = appSetters;
  const { connectionRef, setError, showToast } = useAppErrorReporter({
    appDispatch,
    error,
    setErrorState,
  });
  const {
    appPreferences,
    applyBootstrapPayload,
    bootstrap,
    codexHistorySessions,
    connection,
    events,
    approvals,
    sessions,
    startup,
    setAppPreferences,
    setBootstrap,
    setCodexHistorySessions,
    setEvents,
    setSessions,
  } = useAppBootstrap({
    setDraftModel,
    setDraftProvider,
    setCodexPermissionMode,
    setCodexReasoningEffort,
    setOpenPondCommandAccessMode,
    setError,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
  });
  connectionRef.current = connection;
  useEffect(() => {
    if (bootstrap)
      setSidebarFileBookmarks(bootstrap.sidebarFileBookmarks ?? []);
  }, [bootstrap?.sidebarFileBookmarks]);
  const latestSidebarFileToolEvent = useMemo(
    () =>
      [...events]
        .reverse()
        .find(
          (item) =>
            item.name === "tool.completed" &&
            item.action === "manage_sidebar_file"
        ) ?? null,
    [events]
  );
  const refreshedSidebarFileToolEventRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !connection ||
      !latestSidebarFileToolEvent ||
      refreshedSidebarFileToolEventRef.current === latestSidebarFileToolEvent.id
    )
      return;
    refreshedSidebarFileToolEventRef.current = latestSidebarFileToolEvent.id;
    void api
      .sidebarFiles(connection)
      .then((response) => setSidebarFileBookmarks(response.items))
      .catch((refreshError) =>
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : String(refreshError)
        )
      );
  }, [connection, latestSidebarFileToolEvent, setError]);
  const setSidebarFileStatus = useCallback(
    async (
      file: SidebarFileBookmark,
      status: "pinned" | "saved_for_later" | "none"
    ) => {
      if (!connection) return;
      const previous = sidebarFileBookmarks;
      setSidebarFileBookmarks((current) =>
        status === "none"
          ? current.filter((item) => item.id !== file.id)
          : current.some((item) => item.id === file.id)
          ? current.map((item) =>
              item.id === file.id ? { ...item, status } : item
            )
          : [...current, { ...file, status }]
      );
      try {
        const response = await api.patchSidebarFile(connection, {
          workspaceKind: file.workspaceKind,
          workspaceId: file.workspaceId,
          workspaceName: file.workspaceName,
          path: file.path,
          status,
          sourceSessionId: file.sourceSessionId,
        });
        setSidebarFileBookmarks(response.items);
      } catch (patchError) {
        setSidebarFileBookmarks(previous);
        setError(
          patchError instanceof Error ? patchError.message : String(patchError)
        );
      }
    },
    [connection, setError, sidebarFileBookmarks]
  );
  const connectedAppRows = useConnectedAppStatusRows(connection);
  const training = useTraining({
    connection,
    profileId: bootstrap?.profile?.activeProfile ?? "default",
  });
  const {
    pinnedCollapsed,
    projectsCollapsed,
    cloudProjectsCollapsed,
    chatsCollapsed,
    savedForLaterCollapsed,
    sidebarWidth,
    sidebarResizing,
    diffPanelWidth,
    diffPanelResizing,
    togglePinnedCollapsed,
    toggleProjectsCollapsed,
    toggleCloudProjectsCollapsed,
    toggleChatsCollapsed,
    toggleSavedForLaterCollapsed,
    startSidebarResize,
    startDiffPanelResize,
  } = useLayoutPreferences({
    connection,
    preferences: bootstrap?.preferences,
    sidebarOpen,
    diffPanelOpen,
    diffPanelExpanded,
    setBootstrap,
    setError,
  });
  const {
    cloudProjectById,
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
  } = useAppSelectionState({
    bootstrap,
    codexHistorySessions,
    selectedAppId,
    selectedProjectId,
    selectedSessionId,
    sessions,
  });
  const activeExperience = selectedSession?.experience ?? draftExperience;
  const experienceSidebarSessions = useMemo(
    () => sidebarSessionsForExperience(sidebarSessions, activeExperience),
    [activeExperience, sidebarSessions]
  );
  const runtimeIndexes = useRuntimeIndexes(events, approvals);
  const { chatMentionApps, connectedAppMentions, pendingApproval } =
    useAppConversationContext({
      bootstrap,
      connectedAppRows,
      mentionableSandboxApps,
      runtimeIndexes,
      selectedApp,
      selectedCloudProject,
      selectedProject,
      selectedSession,
      selectedSessionId,
    });
  const { codexHistoryEvents, setCodexHistoryEvents } = useCodexHistoryEvents({
    connection,
    selectedSessionId,
    selectedSessionLocallyActive: Boolean(
      selectedSessionId &&
        locallyActiveCodexHistorySessionIds.has(selectedSessionId)
    ),
    selectedSessionStatus: selectedSession?.status,
    setCodexHistorySessions,
    setError,
  });
  const {
    account,
    accountPending,
    accountSignedOut,
    activeModel,
    activeProvider,
    activeWorkspaceAppId,
    activeWorkspaceId,
    activeWorkspaceKind,
    activeWorkspaceLocation,
    appDefaults,
    cloudLinked,
    selectedCodexHistoryPending,
    selectedSessionProjectId,
    startMessage,
    workspaceName,
  } = useActiveWorkspaceViewState({
    bootstrap,
    draftModel,
    draftProvider,
    selectedApp,
    selectedAppId,
    selectedCloudProject,
    selectedProject,
    selectedSession,
    selectedSessionId,
    selectedSessionLinkedProject,
  });
  const accountScopeKey = useMemo(
    () => openPondAccountScopeKey(bootstrap?.account ?? null),
    [bootstrap?.account]
  );
  const organizationCacheKey = useMemo(
    () => openPondOrganizationCacheKey(bootstrap?.account ?? null),
    [bootstrap?.account]
  );
  const organizations = useOpenPondOrganizations(organizationCacheKey);
  const teamChatOrganization = useMemo(
    () =>
      resolveTeamChatOpenPondOrganization(
        organizations,
        appDefaults.defaultTeamId
      ),
    [appDefaults.defaultTeamId, organizations]
  );
  const teamChatTeamId = teamChatOrganization?.teamId ?? null;
  const teamChat = useTeamChat({
    connection,
    teamId: teamChatTeamId,
    currentUserId: account?.profile?.id ?? null,
    refreshToken: bootstrap?.accountMeta.asOf ?? null,
  });
  const publishTeamProfileAgent = useTeamProfileAgentPublisher({
    connection,
    teamId: teamChatTeamId,
    applyBootstrapPayload,
    refreshDirectory: teamChat.refreshDirectory,
  });
  useTeamChatIncomingToast({
    notification: teamChat.incomingNotification,
    dismiss: teamChat.dismissIncomingNotification,
    selectThread: teamChat.selectThread,
    setView,
    showToast,
  });
  const {
    communities,
    sidebar: communitySidebar,
    view: communityView,
  } = useCommunityController({
    connection,
    currentUserId: account?.profile?.id ?? null,
    refreshToken: bootstrap?.accountMeta.asOf ?? null,
    setView,
    showToast,
  });
  const teamAiThreadId = teamChat.aiThread?.conversationId ?? null;
  const teamAiSidebarOpen =
    view === "team" &&
    Boolean(teamAiThreadId) &&
    diffPanelOpen &&
    rightPanelMode === "chat";
  useEffect(() => {
    if (view !== "team") return;
    if (teamAiThreadId) {
      setRightPanelMode("chat");
      setDiffPanelOpen(true);
      return;
    }
    if (rightPanelMode === "chat") setDiffPanelOpen(false);
  }, [
    rightPanelMode,
    setDiffPanelOpen,
    setRightPanelMode,
    teamAiThreadId,
    view,
  ]);
  const toggleTeamAiSidebar = useCallback(() => {
    if (!teamAiThreadId) return;
    if (teamAiSidebarOpen) {
      setDiffPanelOpen(false);
      return;
    }
    setRightPanelMode("chat");
    setDiffPanelOpen(true);
  }, [setDiffPanelOpen, setRightPanelMode, teamAiSidebarOpen, teamAiThreadId]);
  const selectedProjectConfirmedCloudProject = useMemo(
    () =>
      confirmedLinkedCloudProject(
        selectedProject,
        bootstrap?.cloudProjects ?? []
      ),
    [bootstrap?.cloudProjects, selectedProject]
  );
  const activeOpenPondCommandAccessMode =
    selectedSession?.provider === "codex"
      ? openPondCommandAccessMode
      : selectedSession?.openPondCommandAccessMode ?? openPondCommandAccessMode;
  const viewWorkspaceAppId = activeWorkspaceAppId;
  const viewWorkspaceId = activeWorkspaceId;
  const viewWorkspaceKind = activeWorkspaceKind;
  const viewWorkspaceName = workspaceName;
  const { openPondActionCatalog, selectedActionCatalog } =
    useSandboxActionContext({
      cloudProjectById,
      cloudProjects: bootstrap?.cloudProjects ?? [],
      connection,
      defaultTeamId: appDefaults.defaultTeamId,
      accountScopeKey,
      localProjects: bootstrap?.localProjects ?? [],
      profile: bootstrap?.profile,
      selectedCloudProject,
      selectedProject,
    });
  const {
    expandedProjectIds,
    expandProject,
    toggleProjectExpanded,
    setExpandedProjectIds,
  } = useSidebarExpansion({
    selectedProjectId,
  });

  useAppShellEffects({
    activeWorkspaceId,
    activeWorkspaceKind,
    appDispatch,
    connection,
    expandProject,
    linkedProjectByAppId,
    providerSettings: bootstrap?.providers ?? null,
    selectedAppId,
    selectedSession,
    selectedSessionId,
    selectedSessionProjectId,
    setDiffPanelExpanded,
    setDraftModel,
    setDraftProvider,
    setError,
    setSelectedAppId,
    setSelectedProjectId,
    setSessions,
    setTerminalOpen,
    toast,
  });

  const { changeCodexPermissionMode, changeCodexReasoningEffort } =
    useCodexPreferenceActions({
      connection,
      setBootstrap,
      setCodexPermissionMode,
      setCodexReasoningEffort,
      setError,
    });
  const { changeOpenPondCommandAccessMode } = useOpenPondCommandAccessActions({
    connection,
    selectedSession,
    setBootstrap,
    setError,
    setOpenPondCommandAccessMode,
    setSessions,
  });

  const resolveApproval = useApprovalResolver({ connection, setError });
  const requestMainComposerFocus = useCallback(() => {
    setMainComposerFocusRequestId((current) => current + 1);
  }, []);
  const beginNewChat = useBeginNewChat({
    appDispatch,
    expandProject,
    linkedProjectByAppId,
    requestComposerFocus: requestMainComposerFocus,
    onBeginNewChat: () => setDraftSubagentDelegationMode(null),
    setMentionedAppId,
  });
  const selectLocalProjectForTrainingChat = useCallback(
    (projectId: string) => {
      const projectKey = projectSelectionKey("local", projectId);
      appDispatch({ type: "selectProject", projectId: projectKey });
      expandProject(projectKey);
    },
    [appDispatch, expandProject]
  );
  const {
    advanceAfterTurn: advanceTrainingModelChatAfterTurn,
    begin: beginNewChatWithTrainingModel,
    bindSession: bindTrainingModelChatSession,
    dismiss: dismissTrainingChatHandoff,
    handoff: trainingChatHandoff,
    prepareTurn: prepareTrainingModelChatTurn,
    selectTask: selectTrainingChatTaskForComposer,
  } = useTrainingModelChatHandoff({
    activeModel,
    activeProvider,
    applyBootstrapPayload,
    beginNewChat,
    composerDraftStore,
    connection,
    requestComposerFocus: requestMainComposerFocus,
    selectedLocalProjectId: selectedProject?.id ?? null,
    selectedSessionId,
    selectLocalProject: selectLocalProjectForTrainingChat,
    setDraftModel,
    setDraftProvider,
    setError,
    view,
  });

  useGitSetupNotifications({ connection, events, showToast });

  useCommandShortcuts({
    searchOpen,
    sectionMenuOpen,
    setSectionMenuOpen,
    setSearchOpen,
    setQuery,
  });
  useEffect(() => {
    setRightChatHistoryEvents({});
  }, [bootstrap?.server.id]);

  const {
    chatHistoryLoadStates,
    loadMoreSelectedChatHistory,
    selectedPagedSessionEvents,
    selectedRuntimeIndexes,
  } = useSelectedChatHistory({
    approvals,
    codexHistoryEvents,
    connection,
    latestServerSequence: bootstrap?.eventWindow?.latestSequence,
    runtimeIndexes,
    selectedSessionId,
    serverId: bootstrap?.server.id,
    setCodexHistoryEvents,
    setCodexHistorySessions,
    setError,
    setEvents,
  });

  const {
    activeSessions,
    archivedSessions,
    pinnedProjects,
    pinnedSessions,
    savedForLaterSessions,
    pinnedFiles,
    savedForLaterFiles,
    pinnedItems,
    projectRows,
    localProjectRows,
    visibleProjectRows,
    cloudProjectRows,
    projectSessionRowsByProjectId,
    childSessionRowsByParentId,
    sidebarProjectIdBySessionId,
    chatRows,
    visibleChatRows,
    sessionEvents,
    chatMessages,
    contextUsage,
    goalRuntime: indexedGoalRuntime,
    subagentRuntime,
  } = useSidebarData({
    localProjects: bootstrap?.localProjects ?? [],
    cloudProjects: bootstrap?.cloudProjects ?? [],
    sessions: experienceSidebarSessions,
    runtimeIndexes: selectedRuntimeIndexes,
    appPreferences,
    selectedSessionId,
    selectedProjectId,
    archivedChatsOpen,
    projectsExpanded,
    chatRowsVisibleCount,
    sidebarFileBookmarks,
  });
  const changeExperience = useCallback(
    (experience: Experience) => {
      setDraftExperience(experience);
      const nextSession =
        [...experienceSidebarSessions]
          .filter((session) => session.experience === experience)
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt)
          )[0] ??
        [...sidebarSessions]
          .filter((session) => session.experience === experience)
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt)
          )[0] ??
        null;
      if (nextSession) {
        appDispatch({
          type: "selectSession",
          sessionId: nextSession.id,
          appId: experience === "development" ? nextSession.appId : null,
          projectId:
            experience === "development"
              ? sidebarProjectIdBySessionId[nextSession.id] ?? null
              : null,
        });
      } else {
        appDispatch({ type: "beginNewChat", appId: null });
        if (experience !== "development" && activeProvider === "codex") {
          const provider =
            providerOptionsFromSettings(bootstrap?.providers, {
              enabledOnly: true,
            }).find((option) => option.value !== "codex")?.value ??
            DEFAULT_CHAT_PROVIDER;
          setDraftProvider(provider);
          setDraftModel(
            defaultModelForProvider(provider, bootstrap?.providers) ??
              DEFAULT_CHAT_MODEL
          );
        }
      }
      if (experience !== "development") {
        setTerminalOpen(false);
        setDiffPanelExpanded(false);
        setRightPanelMode("home");
      }
      setView("chat");
    },
    [
      appDispatch,
      activeProvider,
      bootstrap?.providers,
      experienceSidebarSessions,
      setDiffPanelExpanded,
      setDraftExperience,
      setDraftModel,
      setDraftProvider,
      setRightPanelMode,
      setTerminalOpen,
      setView,
      sidebarProjectIdBySessionId,
      sidebarSessions,
    ]
  );
  const {
    pendingChatUserMessages,
    recordPendingChatUserMessage,
    visibleChatMessages,
  } = usePendingChatMessages({
    chatMessages,
    runtimeIndexes: selectedRuntimeIndexes,
    selectedSessionId,
  });
  const activeTerminalScope = useMemo<TerminalScope>(
    () =>
      terminalScopeForSelection({
        selectedAppId,
        selectedProjectId,
        selectedSessionId,
      }),
    [selectedAppId, selectedProjectId, selectedSessionId]
  );
  const previousTerminalScopeRef = useRef<TerminalScope | null>(null);

  useEffect(() => {
    const previousScope = previousTerminalScopeRef.current;
    previousTerminalScopeRef.current = activeTerminalScope;
    if (
      !previousScope ||
      previousScope.kind !== "draft" ||
      activeTerminalScope.kind !== "session"
    )
      return;
    if (terminalScopesEqual(previousScope, activeTerminalScope)) return;
    setTerminalTabs((current) => {
      const next = migrateDraftTerminalTabs({
        tabs: current,
        previousScope,
        activeScope: activeTerminalScope,
      });
      const changed = next.some((tab, index) => tab !== current[index]);
      return changed ? next : current;
    });
  }, [activeTerminalScope]);
  const terminalSummaries = useMemo(
    () => terminalScopeSummaries(terminalTabs),
    [terminalTabs]
  );
  const {
    goalRuntime,
    runningSessionIds,
    selectedSessionRunning,
    selectedSteerAutoDispatchBlocked,
    selectedSteerAutoDispatchReady,
    sidebarGoalRuntimeBySessionId,
    sidebarSubagentRuntimeBySessionId,
  } = useSidebarRuntimeState({
    codexHistoryEvents,
    codexHistorySessions,
    connection,
    expandedProjectIds,
    goalRuntime: indexedGoalRuntime,
    locallyActiveCodexHistorySessionIds,
    pendingApproval,
    pinnedSessions,
    savedForLaterSessions,
    projectSessionRowsByProjectId,
    rightChatHistoryEvents,
    runtimeIndexes,
    selectedSession,
    selectedSessionId,
    serverId: bootstrap?.server.id,
    sessionEvents,
    setCodexHistorySessions,
    setError,
    sidebarSessions,
    subagentRuntime,
    visibleChatRows,
    visibleProjectRows,
  });
  const {
    dragItem,
    pinnedPreviewKeys,
    startPinnedDrag,
    clearSidebarDrag,
    previewPinnedDrop,
    commitPinnedDrop,
    commitPinnedPreviewDrop,
  } = usePinnedSidebarDrag({
    connection,
    appPreferences,
    sessions: sidebarSessions,
    pinnedItems,
    setAppPreferences,
    setCodexHistorySessions,
    setSessions,
    sidebarFileBookmarks,
    setSidebarFileBookmarks,
    setError,
  });
  const {
    clearTaskDrag,
    commitTaskDrop,
    commitTaskPreviewDrop,
    previewTaskDrop,
    startTaskDrag,
    taskDragSessionId,
    taskPreviewSessionIds,
  } = useSidebarTaskOrder({
    connection,
    sessions: sidebarSessions,
    setCodexHistorySessions,
    setError,
    setSessions,
  });
  const {
    commandProjectRows,
    contextWindowStatus,
    pinnedRows,
    sidebarWorkspaceAppIds,
  } = useAppDerivedRows({
    activeProvider,
    contextCompaction: appDefaults.contextCompaction,
    contextUsage,
    pinnedItems,
    pinnedPreviewKeys: pinnedPreviewKeys ?? [],
    pinnedProjects,
    projectRows,
    visibleProjectRows,
  });
  const rightPanelDiffBacked =
    rightPanelMode === "changes" || rightPanelMode === "goal";
  const shouldLoadWorkspaceDiff = Boolean(
    viewWorkspaceAppId &&
      (view === "chat" || view === "labs") &&
      (commitDialogOpen || (diffPanelOpen && rightPanelDiffBacked))
  );

  const {
    workspaceStates,
    workspaceBusy,
    diffBusy,
    visibleWorkspaceState,
    visibleWorkspaceDiff,
    rememberWorkspaceState,
    refreshWorkspace,
    refreshWorkspaceDiff,
    setWorkspaceBusy,
  } = useWorkspaceController({
    connection,
    activeWorkspaceAppId: viewWorkspaceAppId,
    view,
    shouldLoadWorkspaceDiff,
    sidebarWorkspaceAppIds,
    setError,
  });
  rememberWorkspaceStateRef.current = rememberWorkspaceState;
  const refreshWorkspaceDiffWhenNeeded = useCallback(
    (appId: string | null | undefined = viewWorkspaceAppId) => {
      if (!appId || appId !== viewWorkspaceAppId || !shouldLoadWorkspaceDiff) {
        return Promise.resolve(null);
      }
      return refreshWorkspaceDiff(appId);
    },
    [refreshWorkspaceDiff, shouldLoadWorkspaceDiff, viewWorkspaceAppId]
  );
  const refreshVisibleWorkspaceDiff = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!viewWorkspaceAppId || !shouldLoadWorkspaceDiff) return;
      await refreshWorkspaceDiff(viewWorkspaceAppId, options);
    },
    [refreshWorkspaceDiff, shouldLoadWorkspaceDiff, viewWorkspaceAppId]
  );
  const managedWorkspace = false;
  const activeCodexLocalSession = Boolean(
    selectedSession?.provider === "codex" &&
      selectedSession.cwd &&
      !isCloudWorkspaceKind(selectedSession.workspaceKind)
  );
  const canSyncActiveWorkspace = Boolean(
    visibleWorkspaceState &&
      !visibleWorkspaceState.initialized &&
      activeWorkspaceKind !== "local_project" &&
      activeProvider !== "codex" &&
      !activeCodexLocalSession &&
      !selectedCodexHistoryPending
  );
  const canPublishOpenPondProject =
    activeWorkspaceKind === "local_project" &&
    Boolean(selectedProject?.sandboxTemplate?.detected) &&
    !selectedProject?.linkedOpenPondApp?.appId;
  const [pendingWorkspaceTarget, setPendingWorkspaceTarget] = useState<
    "hybrid" | null
  >(null);
  const [pendingSidebarWorkspaceTarget, setPendingSidebarWorkspaceTarget] =
    useState<{
      projectId: string;
      target: WorkspaceTargetValue;
    } | null>(null);
  const { projectTarget, workspaceTarget } = useWorkspaceTargetState({
    accountPending,
    accountSignedOut,
    activeWorkspaceLocation,
    bootstrap,
    busy,
    cloudLinked,
    selectedCloudProject,
    selectedProject,
    selectedSession,
    pendingWorkspaceTarget,
    workspaceStates,
    workspaceBusy,
  });
  useEffect(() => {
    setPendingWorkspaceTarget(null);
  }, [selectedCloudProject?.id, selectedProject?.id, selectedSession?.id]);
  return {
    composerDraftStore,
    appDispatch,
    pendingTerminalCommand,
    setPendingTerminalCommand,
    terminalTabs,
    setTerminalTabs,
    trainingDetailTasksetId,
    setTrainingDetailTasksetId,
    mentionedAppId,
    setMentionedAppId,
    cloudSetupDialog,
    setCloudSetupDialog,
    rightPanelTabRequest,
    setRightPanelTabRequest,
    workspaceDiffPanelViewState,
    setWorkspaceDiffPanelViewState,
    rightChatHistoryEvents,
    setRightChatHistoryEvents,
    locallyActiveCodexHistorySessionIds,
    setCodexHistoryTurnLocallyActive,
    mainComposerFocusRequestId,
    requestMainComposerFocus,
    draftSubagentDelegationMode,
    setDraftSubagentDelegationMode,
    confirmProjectAction,
    projectConfirmDialog,
    resolveProjectConfirmDialog,
    query,
    searchOpen,
    archivedChatsOpen,
    sectionMenuOpen,
    projectsExpanded,
    cloudProjectsExpanded,
    sidebarOpen,
    view,
    selectedAppId,
    selectedProjectId,
    selectedSessionId,
    draftProvider,
    draftModel,
    draftExperience,
    activeExperience,
    changeExperience,
    codexPermissionMode,
    codexReasoningEffort,
    openPondCommandAccessMode,
    busy,
    diffPanelOpen,
    diffPanelExpanded,
    rightPanelMode,
    rightChatPanels,
    terminalOpen,
    settingsSection,
    newProjectDialogOpen,
    newProjectMode,
    newProjectName,
    newProjectPath,
    newProjectBusy,
    commitDialogOpen,
    commitMessage,
    commitIncludeUnstaged,
    commitNextStep,
    commitDraft,
    branchDialogOpen,
    branchDialogName,
    toast,
    error,
    labDetailNavigation,
    setQuery,
    setSearchOpen,
    setArchivedChatsOpen,
    setSectionMenuOpen,
    setProjectsExpanded,
    setCloudProjectsExpanded,
    setChatRowsVisibleCount,
    setSidebarOpen,
    setView,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
    setPrompt,
    setDraftProvider,
    setDraftModel,
    setDraftExperience,
    setDiffPanelOpen,
    setDiffPanelExpanded,
    setRightPanelMode,
    setRightChatPanels,
    setTerminalOpen,
    setSyncingWorkspaceAppId,
    setSettingsSection,
    setNewProjectDialogOpen,
    setNewProjectMode,
    setNewProjectName,
    setNewProjectPath,
    setNewProjectBusy,
    setCommitDialogOpen,
    setCommitMessage,
    setCommitIncludeUnstaged,
    setCommitNextStep,
    setCommitDraft,
    setBranchDialogOpen,
    setBranchDialogName,
    setError,
    showToast,
    appPreferences,
    applyBootstrapPayload,
    bootstrap,
    connection,
    events,
    sessions,
    startup,
    setAppPreferences,
    setCodexHistorySessions,
    setEvents,
    setSessions,
    training,
    pinnedCollapsed,
    projectsCollapsed,
    cloudProjectsCollapsed,
    chatsCollapsed,
    savedForLaterCollapsed,
    sidebarWidth,
    sidebarResizing,
    diffPanelWidth,
    diffPanelResizing,
    togglePinnedCollapsed,
    toggleProjectsCollapsed,
    toggleCloudProjectsCollapsed,
    toggleChatsCollapsed,
    toggleSavedForLaterCollapsed,
    startSidebarResize,
    startDiffPanelResize,
    cloudProjectById,
    localProjectById,
    selectedApp,
    selectedCloudProject,
    selectedProject,
    selectedProjectLinkedApp,
    selectedProjectLinkedOpenPondApp,
    selectedSession,
    sidebarSessions,
    runtimeIndexes,
    chatMentionApps,
    connectedAppMentions,
    pendingApproval,
    codexHistoryEvents,
    setCodexHistoryEvents,
    account,
    accountPending,
    accountSignedOut,
    activeModel,
    activeProvider,
    activeWorkspaceAppId,
    activeWorkspaceId,
    activeWorkspaceKind,
    activeWorkspaceLocation,
    appDefaults,
    selectedSessionProjectId,
    startMessage,
    workspaceName,
    accountScopeKey,
    teamChatOrganization,
    teamChatTeamId,
    teamChat,
    publishTeamProfileAgent,
    communities,
    communitySidebar,
    communityView,
    teamAiThreadId,
    toggleTeamAiSidebar,
    selectedProjectConfirmedCloudProject,
    activeOpenPondCommandAccessMode,
    viewWorkspaceAppId,
    viewWorkspaceId,
    viewWorkspaceKind,
    viewWorkspaceName,
    openPondActionCatalog,
    selectedActionCatalog,
    expandedProjectIds,
    expandProject,
    toggleProjectExpanded,
    setExpandedProjectIds,
    changeCodexPermissionMode,
    changeCodexReasoningEffort,
    changeOpenPondCommandAccessMode,
    resolveApproval,
    beginNewChat,
    advanceTrainingModelChatAfterTurn,
    beginNewChatWithTrainingModel,
    bindTrainingModelChatSession,
    dismissTrainingChatHandoff,
    trainingChatHandoff,
    prepareTrainingModelChatTurn,
    selectTrainingChatTaskForComposer,
    chatHistoryLoadStates,
    loadMoreSelectedChatHistory,
    selectedPagedSessionEvents,
    activeSessions,
    archivedSessions,
    pinnedSessions,
    savedForLaterSessions,
    pinnedFiles,
    savedForLaterFiles,
    sidebarFileBookmarks,
    setSidebarFileStatus,
    projectRows,
    localProjectRows,
    visibleProjectRows,
    cloudProjectRows,
    projectSessionRowsByProjectId,
    childSessionRowsByParentId,
    sidebarProjectIdBySessionId,
    chatRows,
    visibleChatRows,
    chatRowsVisibleCount,
    sessionEvents,
    chatMessages,
    goalRuntime,
    subagentRuntime,
    pendingChatUserMessages,
    recordPendingChatUserMessage,
    visibleChatMessages,
    activeTerminalScope,
    terminalSummaries,
    runningSessionIds,
    selectedSessionRunning,
    selectedSteerAutoDispatchBlocked,
    selectedSteerAutoDispatchReady,
    sidebarGoalRuntimeBySessionId,
    sidebarSubagentRuntimeBySessionId,
    taskDragSessionId,
    taskPreviewSessionIds,
    startTaskDrag,
    clearTaskDrag,
    previewTaskDrop,
    commitTaskDrop,
    commitTaskPreviewDrop,
    dragItem,
    startPinnedDrag,
    clearSidebarDrag,
    previewPinnedDrop,
    commitPinnedDrop,
    commitPinnedPreviewDrop,
    commandProjectRows,
    contextWindowStatus,
    pinnedRows,
    workspaceStates,
    workspaceBusy,
    diffBusy,
    visibleWorkspaceState,
    visibleWorkspaceDiff,
    rememberWorkspaceState,
    refreshWorkspace,
    refreshWorkspaceDiff,
    setWorkspaceBusy,
    refreshWorkspaceDiffWhenNeeded,
    refreshVisibleWorkspaceDiff,
    managedWorkspace,
    canSyncActiveWorkspace,
    canPublishOpenPondProject,
    pendingWorkspaceTarget,
    setPendingWorkspaceTarget,
    pendingSidebarWorkspaceTarget,
    setPendingSidebarWorkspaceTarget,
    projectTarget,
    workspaceTarget,
  };
}

export type AppPrimaryRuntime = ReturnType<typeof useAppPrimaryRuntime>;
