import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  ChatAttachment,
  ConnectedAppStatusRow,
  RuntimeEvent,
  Session,
  SubagentDelegationMode,
  WorkspaceState,
  TerminalScope,
} from "@openpond/contracts";
import { buildConnectedAppStatusRows, localPathWorkspaceId } from "@openpond/contracts";
import {
  type AppToast,
  type ShowAppToast,
} from "./app/app-state";
import { api, type ClientConnection } from "./api";
import { AppSettingsController, AppShellController } from "./components/app-shell/AppControllers";
import { useProjectConfirmDialog } from "./components/app-shell/ProjectConfirmDialog";
import { isDesktopShell, isMacPlatform } from "./components/app-shell/WindowControls";
import { AppSplash } from "./components/splash/AppSplash";
import type { CloudSetupDialogState } from "./components/workspace/CloudSetupDialog";
import { modelRefForTurn, type SidebarProjectItem } from "./lib/app-models";
import { openPondOrganizationCacheKey } from "./lib/openpond-organization-memory";
import { mergeLiveRuntimeEventLists } from "./lib/runtime-event-lists";
import { isCodexHistorySessionId } from "./lib/sidebar-session-projects";
import {
  migrateDraftTerminalTabs,
  terminalScopeForSelection,
  terminalScopesEqual,
  terminalScopeSummaries,
} from "./components/terminal/terminal-state";
import type { TerminalQueuedCommand, TerminalTab } from "./components/terminal/terminal-overlay-types";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "./lib/session-state";
import { runtimeEventsForSession } from "./lib/runtime-indexes";
import type { ComposerSubmitOptions } from "./components/chat/Composer";
import type { SandboxActionCatalogEntry } from "./lib/sandbox-types";
import {
  defaultWorkspaceDiffPanelViewState,
  type WorkspaceDiffPanelViewState,
  type WorkspaceDiffTabRequest,
} from "./components/workspace-diff/workspace-diff-panel-model";
import {
  hybridWorkspaceSessionMetadata,
  isCloudWorkspaceKind,
  isHybridWorkspaceSession,
  type WorkspaceTargetValue,
} from "./lib/workspace-location";
import { queuedCloudWorkSubmission } from "./lib/queued-cloud-work";
import { openPondAccountScopeKey } from "./lib/account-scope";
import { resolveTeamChatOpenPondOrganization } from "./lib/cloud-project-utils";
import { confirmedLinkedCloudProject } from "./lib/cloud-link-trust";
import {
  useActiveWorkspaceViewState,
  useWorkspaceTargetState,
} from "./hooks/useActiveWorkspaceViewState";
import { useAppPanelActions } from "./hooks/useAppPanelActions";
import { useAppSelectionState } from "./hooks/useAppSelectionState";
import { useAppShellEffects } from "./hooks/useAppShellEffects";
import { useApprovalResolver } from "./hooks/useApprovalResolver";
import { useAppDerivedRows } from "./hooks/useAppDerivedRows";
import { useBeginNewChat } from "./hooks/useBeginNewChat";
import { useBrowserRevealRequests } from "./hooks/useBrowserRevealRequests";
import { useChatActions } from "./hooks/useChatActions";
import { useAppConversationContext } from "./hooks/useAppConversationContext";
import { useCloudSessionReady } from "./hooks/useCloudSessionReady";
import { useConversationSidebarState } from "./hooks/useConversationSidebarState";
import { useCodexPreferenceActions } from "./hooks/useCodexPreferenceActions";
import { useCloudWorkItems } from "./hooks/useCloudWorkItems";
import { useCloudWorkspaceSetup } from "./hooks/useCloudWorkspaceSetup";
import { useCodexHistoryEvents } from "./hooks/useCodexHistoryEvents";
import { usePinnedSidebarDrag } from "./hooks/usePinnedSidebarDrag";
import { usePendingChatMessages } from "./hooks/usePendingChatMessages";
import { useOpenPondCommandAccessActions } from "./hooks/useOpenPondCommandAccessActions";
import { useSidebarData } from "./hooks/useSidebarData";
import { useSidebarRuntimeState } from "./hooks/useSidebarRuntimeState";
import { useCommandShortcuts } from "./hooks/useAppEffects";
import { useAppBootstrap } from "./hooks/useAppBootstrap";
import { useAppState } from "./hooks/useAppState";
import { useGitSetupNotifications } from "./hooks/useGitSetupNotifications";
import { useLayoutPreferences } from "./hooks/useLayoutPreferences";
import { useInsights } from "./hooks/useInsights";
import { useOpenSandboxWorkspace } from "./hooks/useOpenSandboxWorkspace";
import { useProjectActions } from "./hooks/useProjectActions";
import { useProjectTargetActions } from "./hooks/useProjectTargetActions";
import { useRightChatPanels } from "./hooks/useRightChatPanels";
import { useSelectedChatHistory } from "./hooks/useSelectedChatHistory";
import { useRuntimeIndexes } from "./hooks/useRuntimeIndexes";
import { useSandboxActionContext } from "./hooks/useSandboxActionContext";
import { useSidebarExpansion } from "./hooks/useSidebarExpansion";
import { useSidebarMutations } from "./hooks/useSidebarMutations";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { useWorkspaceController } from "./hooks/useWorkspaceController";
import { useTeamChat } from "./hooks/useTeamChat";
import { useOpenPondOrganizations } from "./hooks/useOpenPondOrganizations";
import { teamChatThreadTitle } from "./lib/team-chat-thread";

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];

export function App() {
  const { composerDraftStore, dispatch: appDispatch, setters: appSetters, state: appState } = useAppState();
  const [pendingTerminalCommand, setPendingTerminalCommand] =
    useState<TerminalQueuedCommand | null>(null);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [mentionedAppId, setMentionedAppId] = useState<string | null>(null);
  const [connectedAppRows, setConnectedAppRows] = useState<ConnectedAppStatusRow[]>(() =>
    buildConnectedAppStatusRows(),
  );
  const [cloudSetupDialog, setCloudSetupDialog] = useState<CloudSetupDialogState | null>(null);
  const [rightPanelTabRequest, setRightPanelTabRequest] = useState<WorkspaceDiffTabRequest | null>(
    null,
  );
  const [workspaceDiffPanelViewState, setWorkspaceDiffPanelViewState] =
    useState<WorkspaceDiffPanelViewState>(defaultWorkspaceDiffPanelViewState);
  const [rightChatHistoryEvents, setRightChatHistoryEvents] = useState<
    Record<string, RuntimeEvent[]>
  >({});
  const [mainComposerFocusRequestId, setMainComposerFocusRequestId] = useState(0);
  const [draftSubagentDelegationMode, setDraftSubagentDelegationMode] =
    useState<SubagentDelegationMode | null>(null);
  const rememberWorkspaceStateRef = useRef<((state: WorkspaceState) => void) | null>(null);
  const rememberCloudWorkspaceState = useCallback((state: WorkspaceState) => {
    rememberWorkspaceStateRef.current?.(state);
  }, []);
  const { confirmProjectAction, projectConfirmDialog, resolveProjectConfirmDialog } =
    useProjectConfirmDialog();
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
  const connectionRef = useRef<ClientConnection | null>(null);
  const latestErrorRef = useRef<string | null>(null);
  const errorToastIdRef = useRef<number | null>(null);
  const toastSequenceRef = useRef(0);
  const showToast = useCallback<ShowAppToast>(
    (
      message: string,
      tone: "success" | "error" | "info" = "info",
      options: Pick<AppToast, "actionLabel" | "onAction" | "persistent"> = {},
    ) => {
      const id = Date.now() + ++toastSequenceRef.current;
      appDispatch({ type: "showToast", toast: { id, message, tone, ...options } });
      return id;
    },
    [],
  );
  const openDiagnosticsSettings = useCallback(() => {
    appDispatch({
      type: "patch",
      patch: {
        settingsSection: "diagnostics",
        sidebarOpen: true,
        view: "settings",
      },
    });
  }, []);
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>(
    (value) => {
      const current = latestErrorRef.current;
      const next = typeof value === "function" ? value(current) : value;
      if (Object.is(current, next)) return;

      latestErrorRef.current = next;
      setErrorState(next);
      if (!next) {
        if (errorToastIdRef.current !== null) {
          appDispatch({ type: "clearToast", toastId: errorToastIdRef.current });
          errorToastIdRef.current = null;
        }
        return;
      }

      errorToastIdRef.current = showToast(next, "error", {
        actionLabel: "Settings",
        onAction: openDiagnosticsSettings,
        persistent: true,
      });
      const connection = connectionRef.current;
      if (!connection) return;
      void api
        .recordClientDiagnostic(connection, {
          message: next,
          surface: "app",
          context: {
            href: window.location.href,
          },
        })
        .catch((diagnosticError) => {
          console.warn("Unable to record client diagnostic.", diagnosticError);
        });
    },
    [openDiagnosticsSettings, setErrorState, showToast],
  );
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
    latestErrorRef.current = error;
    if (error || errorToastIdRef.current === null) return;
    appDispatch({ type: "clearToast", toastId: errorToastIdRef.current });
    errorToastIdRef.current = null;
  }, [error]);
  useEffect(() => {
    let active = true;
    if (!connection) {
      setConnectedAppRows(buildConnectedAppStatusRows());
      return () => {
        active = false;
      };
    }
    void api
      .connectedAppStatus(connection, {
        status: "all",
      })
      .then((payload) => {
        if (active) setConnectedAppRows(payload.apps);
      })
      .catch((caught) => {
        console.warn("Unable to load connected app mention status.", caught);
        if (active) setConnectedAppRows(buildConnectedAppStatusRows());
      });
    return () => {
      active = false;
    };
  }, [connection]);
  const insights = useInsights({ connection });
  useEffect(() => {
    const session = insights.systemSession;
    if (!session) return;
    setSessions((current) => {
      const index = current.findIndex((item) => item.id === session.id);
      if (index === -1) return [session, ...current];
      return current.map((item) => (item.id === session.id ? session : item));
    });
  }, [insights.systemSession, setSessions]);
  const {
    pinnedCollapsed,
    projectsCollapsed,
    cloudProjectsCollapsed,
    chatsCollapsed,
    sidebarWidth,
    sidebarResizing,
    diffPanelWidth,
    diffPanelResizing,
    togglePinnedCollapsed,
    toggleProjectsCollapsed,
    toggleCloudProjectsCollapsed,
    toggleChatsCollapsed,
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
  const revealProjectsSection = useCallback(() => {
    if (projectsCollapsed) toggleProjectsCollapsed();
  }, [projectsCollapsed, toggleProjectsCollapsed]);

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
  const runtimeIndexes = useRuntimeIndexes(events, approvals);
  const { chatMentionApps, cloudProjectIdsByTeam, connectedAppMentions, pendingApproval } =
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
    [bootstrap?.account],
  );
  const organizationCacheKey = useMemo(
    () => openPondOrganizationCacheKey(bootstrap?.account ?? null),
    [bootstrap?.account],
  );
  const organizations = useOpenPondOrganizations(organizationCacheKey);
  const teamChatOrganization = useMemo(
    () => resolveTeamChatOpenPondOrganization(organizations, appDefaults.defaultTeamId),
    [appDefaults.defaultTeamId, organizations],
  );
  const teamChatTeamId = teamChatOrganization?.teamId ?? null;
  const teamChat = useTeamChat({
    connection,
    teamId: teamChatTeamId,
    currentUserId: account?.profile?.id ?? null,
  });
  const teamAiThreadId = teamChat.aiThread?.conversationId ?? null;
  const teamAiSidebarOpen =
    view === "team" && Boolean(teamAiThreadId) && diffPanelOpen && rightPanelMode === "chat";
  useEffect(() => {
    if (view !== "team") return;
    if (teamAiThreadId) {
      setRightPanelMode("chat");
      setDiffPanelOpen(true);
      return;
    }
    if (rightPanelMode === "chat") setDiffPanelOpen(false);
  }, [rightPanelMode, setDiffPanelOpen, setRightPanelMode, teamAiThreadId, view]);
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
    () => confirmedLinkedCloudProject(selectedProject, bootstrap?.cloudProjects ?? []),
    [bootstrap?.cloudProjects, selectedProject],
  );
  const activeOpenPondCommandAccessMode =
    selectedSession?.provider === "codex"
      ? openPondCommandAccessMode
      : (selectedSession?.openPondCommandAccessMode ?? openPondCommandAccessMode);
  const profileWorkspaceId =
    view === "profile" && bootstrap?.profile?.mode === "local" && bootstrap.profile.repoPath
      ? localPathWorkspaceId(bootstrap.profile.repoPath)
      : null;
  const profileWorkspaceName = profileWorkspaceId
    ? `${bootstrap?.profile?.activeProfile ?? "default"} profile`
    : null;
  const viewWorkspaceAppId = profileWorkspaceId ?? activeWorkspaceAppId;
  const viewWorkspaceId = profileWorkspaceId ?? activeWorkspaceId;
  const viewWorkspaceKind = profileWorkspaceId ? ("local_project" as const) : activeWorkspaceKind;
  const viewWorkspaceName = profileWorkspaceName ?? workspaceName;
  const { openPondActionCatalog, selectedActionCatalog } = useSandboxActionContext({
    cloudProjectById,
    cloudProjects: bootstrap?.cloudProjects ?? [],
    connection,
    defaultTeamId: appDefaults.defaultTeamId,
    accountScopeKey,
    localProjects: bootstrap?.localProjects ?? [],
    profileActionCatalogEntries: bootstrap?.profile.actionCatalog ?? [],
    selectedCloudProject,
    selectedProject,
  });
  const { expandedProjectIds, expandProject, toggleProjectExpanded, setExpandedProjectIds } =
    useSidebarExpansion({
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

  const {
    cloudBusy,
    cloudError,
    cloudLoading,
    cloudWorkItemDetail,
    cloudWorkItems,
    selectedCloudWorkItem,
    selectedCloudWorkItemId,
    selectedCloudWorkItemLocalProject,
    applyCloudWorkItemPatchLocally,
    cancelCloudWorkItemCreatePipeline,
    cancelCloudWorkItemTask,
    createCloudWork,
    handleCloudWorkItemBackground,
    openCloudHome,
    selectCloudWorkItem,
    sendCloudWorkItemMessage,
    setCloudError,
  } = useCloudWorkItems({
    bootstrap,
    connection,
    cloudProjectById,
    cloudProjectIdsByTeam,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
    setView,
    setError,
    rememberWorkspaceState: rememberCloudWorkspaceState,
    showToast,
  });

  const { changeCodexPermissionMode, changeCodexReasoningEffort } = useCodexPreferenceActions({
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
    pinnedProjects,
    pinnedSessions,
    pinnedItems,
    projectRows,
    localProjectRows,
    visibleProjectRows,
    cloudProjectRows,
    cloudWorkItemsByProjectId,
    projectSessionRowsByProjectId,
    childSessionRowsByParentId,
    sidebarProjectIdBySessionId,
    chatRows,
    visibleChatRows,
    sessionEvents,
    chatMessages,
    contextUsage,
    goalRuntime,
    subagentRuntime,
  } = useSidebarData({
    localProjects: bootstrap?.localProjects ?? [],
    cloudProjects: bootstrap?.cloudProjects ?? [],
    cloudWorkItems,
    sessions: sidebarSessions,
    runtimeIndexes: selectedRuntimeIndexes,
    appPreferences,
    selectedSessionId,
    selectedProjectId,
    archivedChatsOpen,
    projectsExpanded,
    chatRowsVisibleCount,
  });
  const {
    clearPendingChatUserMessage,
    pendingChatUserMessages,
    recordPendingChatUserMessage,
    visibleChatMessages,
  } = usePendingChatMessages({
    chatMessages,
    runtimeIndexes,
    selectedSessionId,
    serverId: bootstrap?.server.id,
  });
  const activeTerminalScope = useMemo<TerminalScope>(
    () => terminalScopeForSelection({ selectedAppId, selectedProjectId, selectedSessionId }),
    [selectedAppId, selectedProjectId, selectedSessionId],
  );
  const previousTerminalScopeRef = useRef<TerminalScope | null>(null);

  useEffect(() => {
    const previousScope = previousTerminalScopeRef.current;
    previousTerminalScopeRef.current = activeTerminalScope;
    if (!previousScope || previousScope.kind !== "draft" || activeTerminalScope.kind !== "session")
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
  const terminalSummaries = useMemo(() => terminalScopeSummaries(terminalTabs), [terminalTabs]);
  const {
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
    goalRuntime,
    pendingApproval,
    pinnedSessions,
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
    setError,
  });
  const { commandProjectRows, contextWindowStatus, pinnedRows, sidebarWorkspaceAppIds } =
    useAppDerivedRows({
      activeProvider,
      contextCompaction: appDefaults.contextCompaction,
      contextUsage,
      pinnedItems,
      pinnedPreviewKeys: pinnedPreviewKeys ?? [],
      pinnedProjects,
      projectRows,
      visibleProjectRows,
    });
  const rightPanelDiffBacked = rightPanelMode === "changes" || rightPanelMode === "goal";
  const shouldLoadWorkspaceDiff = Boolean(
    viewWorkspaceAppId &&
    (view === "chat" || view === "profile") &&
    (commitDialogOpen || (diffPanelOpen && rightPanelDiffBacked)),
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
    [refreshWorkspaceDiff, shouldLoadWorkspaceDiff, viewWorkspaceAppId],
  );
  const refreshVisibleWorkspaceDiff = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!viewWorkspaceAppId || !shouldLoadWorkspaceDiff) return;
      await refreshWorkspaceDiff(viewWorkspaceAppId, options);
    },
    [refreshWorkspaceDiff, shouldLoadWorkspaceDiff, viewWorkspaceAppId],
  );
  const managedWorkspace = false;
  const activeCodexLocalSession = Boolean(
    selectedSession?.provider === "codex" &&
    selectedSession.cwd &&
    !isCloudWorkspaceKind(selectedSession.workspaceKind),
  );
  const canSyncActiveWorkspace = Boolean(
    visibleWorkspaceState &&
    !visibleWorkspaceState.initialized &&
    activeWorkspaceKind !== "local_project" &&
    activeProvider !== "codex" &&
    !activeCodexLocalSession &&
    !selectedCodexHistoryPending,
  );
  const canPublishOpenPondProject =
    activeWorkspaceKind === "local_project" &&
    Boolean(selectedProject?.sandboxTemplate?.detected) &&
    !selectedProject?.linkedOpenPondApp?.appId;
  const [pendingWorkspaceTarget, setPendingWorkspaceTarget] = useState<
    "queue_cloud" | "hybrid" | null
  >(null);
  const [pendingSidebarWorkspaceTarget, setPendingSidebarWorkspaceTarget] = useState<{
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
  const title =
    view === "apps"
      ? "Apps"
      : view === "insights"
        ? "Insights"
        : view === "team"
          ? teamChat.detail
            ? teamChatThreadTitle(teamChat.detail.thread, teamChat.currentUserId)
            : "Team"
          : view === "profile"
            ? "Agents"
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
    answerCreatePipelineQuestionTurn,
    approveCreatePipelineTurn,
    cancelCreatePipelineTurn,
    changeDraftProvider,
    reviseCreatePipelineTurn,
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
  const sendPromptFromMainComposer = useCallback(
    async (
      attachments: ChatAttachment[] = [],
      action: SandboxActionCatalogEntry | null = null,
      promptOverride?: string,
      options: ComposerSubmitOptions = {},
    ) => {
      const promptForSubmission = promptOverride ?? composerDraftStore.getSnapshot();
      const queuedSubmission = queuedCloudWorkSubmission({
        pendingWorkspaceTarget,
        actionSelected: Boolean(action),
        promptOverrideProvided: promptOverride !== undefined,
        attachmentCount: attachments.length,
        selectedCloudProjectId: selectedCloudProject?.id ?? null,
        selectedProjectCloudProjectId: selectedProjectConfirmedCloudProject?.id ?? null,
        selectedLocalProjectId: selectedProject?.id ?? null,
        selectedLocalProjectName: selectedProject?.name ?? null,
        selectedLocalWorkspacePath: selectedProject?.workspacePath ?? selectedProject?.path ?? null,
        selectedProjectCloudSourceRef:
          selectedProject?.linkedSandboxProject?.defaultBranch ??
          visibleWorkspaceState?.currentBranch ??
          null,
        selectedProjectCloudBaseSha:
          selectedProject?.linkedSandboxProject?.lastUploadedCommit ?? null,
        prompt: promptForSubmission,
      });
      if (queuedSubmission.kind !== "not_queued") {
        if (queuedSubmission.kind === "attachments_unsupported") {
          showToast(queuedSubmission.message, "error");
          return false;
        }
        if (queuedSubmission.kind === "missing_cloud_project") {
          showToast(queuedSubmission.message, "error");
          setPendingWorkspaceTarget(null);
          return false;
        }
        if (queuedSubmission.kind === "empty_prompt") return false;
        const created = await createCloudWork(queuedSubmission.request);
        if (created) {
          if (!options.preservePrompt) {
            setPrompt("");
            setMentionedAppId(null);
          }
          setPendingWorkspaceTarget(null);
        }
        return created;
      }
      return sendPrompt(attachments, action, promptOverride, {
        clearPrompt: options.preservePrompt ? () => undefined : undefined,
        displayPrompt: options.displayPrompt,
        onSessionCreated: () => setDraftSubagentDelegationMode(null),
      });
    },
    [
      createCloudWork,
      pendingWorkspaceTarget,
      composerDraftStore,
      selectedCloudProject?.id,
      selectedProjectConfirmedCloudProject?.id,
      selectedProject?.linkedSandboxProject?.defaultBranch,
      selectedProject?.linkedSandboxProject?.lastUploadedCommit,
      selectedProject?.id,
      selectedProject?.name,
      selectedProject?.path,
      selectedProject?.workspacePath,
      sendPrompt,
      setMentionedAppId,
      setPrompt,
      showToast,
      visibleWorkspaceState?.currentBranch,
    ],
  );

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
    setView("profile");
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
    setRightPanelMode("home");
    setDiffPanelOpen(true);
  }, [diffPanelOpen, setDiffPanelOpen, setRightPanelMode]);

  if (!startup.ready) {
    return <AppSplash startup={startup} />;
  }

  if (view === "settings") {
    return (
      <AppSettingsController
        settings={{
          payload: bootstrap,
          connection,
          diagnostics: diagnosticEvents,
          initialSection: settingsSection,
          onPayload: applyBootstrapPayload,
          onError: setError,
          onToast: showToast,
          onOpenSourceSession: openSessionInChat,
          onBack: () => {
            setView("chat");
            setSidebarOpen(true);
          },
        }}
        toast={{
          toast,
          onDismiss: () => appDispatch({ type: "field", key: "toast", value: null }),
        }}
      />
    );
  }

  const desktopShell = isDesktopShell();
  const platform = connection?.platform ?? navigator.platform;
  const isMac = desktopShell && isMacPlatform(platform);
  const viewTerminalScope: TerminalScope = profileWorkspaceId
    ? { kind: "project", id: profileWorkspaceId }
    : activeTerminalScope;
  const terminalCwd = visibleWorkspaceState?.initialized
    ? visibleWorkspaceState.repoPath
    : (selectedSession?.cwd ?? null);
  const appShellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--diff-panel-width": `${diffPanelWidth}px`,
  } as CSSProperties;
  const rightSidebarAvailableForView =
    view === "chat" || view === "cloud" || view === "profile" || view === "team";
  const appShellClassName = [
    "app-shell",
    isMac ? "platform-macos" : "",
    sidebarOpen ? "sidebar-open" : "sidebar-closed",
    sidebarResizing ? "sidebar-resizing" : "",
    diffPanelResizing ? "diff-panel-resizing" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const selectedChatHistoryLoadState = selectedSessionId
    ? chatHistoryLoadStates[selectedSessionId]
    : null;
  const selectedChatHistoryCursor = selectedSessionId
    ? (selectedChatHistoryLoadState?.cursorSequence ??
      oldestRuntimeEventSequence(
        mergeLiveRuntimeEventLists(
          selectedPagedSessionEvents,
          runtimeEventsForSession(runtimeIndexes, selectedSessionId),
        ),
      ))
    : null;
  const selectedChatHistoryCanPage =
    Boolean(selectedSessionId) &&
    Boolean(connection) &&
    (isCodexHistorySessionId(selectedSessionId)
      ? true
      : Boolean(bootstrap?.eventWindow?.hasMoreBefore) && Boolean(selectedChatHistoryCursor));
  const selectedChatHistoryHasMore =
    selectedChatHistoryCanPage && (selectedChatHistoryLoadState?.hasMore ?? true);
  const selectedChatHistoryLoading = Boolean(selectedChatHistoryLoadState?.loading);

  return (
    <AppShellController
      className={appShellClassName}
      style={appShellStyle}
      sidebar={{
        view,
        selectedAppId,
        selectedProjectId,
        selectedSessionId,
        selectedCloudWorkItemId,
        selectedTeamThreadId: teamChat.selectedThreadId,
        teamChatEnabled: teamChatTeamId !== null,
        teamChatOrganization,
        teamChatLoading: teamChat.loading,
        currentUserId: teamChat.currentUserId,
        teamMembers: teamChat.members,
        teamThreads: teamChat.threads,
        account,
        profile: bootstrap?.profile,
        pinnedCollapsed,
        projectsCollapsed,
        cloudProjectsCollapsed,
        chatsCollapsed,
        archivedChatsOpen,
        projectsExpanded,
        cloudProjectsExpanded,
        sectionMenuOpen,
        dragItem,
        pinnedRows,
        pinnedSessions,
        projectRows,
        visibleProjectRows,
        localProjectRows,
        insightsSystemProjectHidden,
        cloudProjectRows,
        workspaceStates,
        cloudWorkItemsByProjectId,
        projectSessionRowsByProjectId,
        childSessionRowsByParentId,
        sidebarProjectIdBySessionId,
        terminalSummaries,
        runningSessionIds,
        goalRuntimeBySessionId: sidebarGoalRuntimeBySessionId,
        subagentRuntimeBySessionId: sidebarSubagentRuntimeBySessionId,
        visibleChatRows,
        chatRows,
        expandedProjectIds,
        currentVersion: bootstrap?.server.version ?? null,
        platform,
        arch: connection?.arch ?? null,
        onSidebarResizeStart: startSidebarResize,
        setSidebarOpen,
        setView,
        setSelectedAppId,
        setSelectedProjectId,
        setSelectedSessionId,
        setSearchOpen,
        setSectionMenuOpen,
        setSettingsSection,
        onTogglePinnedCollapsed: togglePinnedCollapsed,
        onToggleProjectsCollapsed: toggleProjectsCollapsed,
        onToggleCloudProjectsCollapsed: toggleCloudProjectsCollapsed,
        onToggleChatsCollapsed: toggleChatsCollapsed,
        setArchivedChatsOpen,
        setProjectsExpanded,
        setCloudProjectsExpanded,
        setChatRowsVisibleCount,
        beginNewChat,
        dockSessionRight: openRightChatPanel,
        openCloudHome,
        createCloudEnvironment: createCloudEnvironmentFromSidebar,
        selectCloudWorkItem,
        selectTeamThread: (threadId) => {
          setView("team");
          void teamChat.selectThread(threadId);
        },
        openTeamDm: (userId) => {
          setView("team");
          void teamChat.openDm(userId);
        },
        addProjectFolder: () => void addProjectFolder(),
        startExistingProjectFromPath: openExistingProjectPathDialog,
        startProjectFromScratch: () => {
          setNewProjectMode("local");
          setNewProjectName("");
          setNewProjectPath("");
          setNewProjectDialogOpen(true);
        },
        startCloudProjectFromScratch: openCloudProjectDialog,
        moveProjectToCloud,
        switchProjectWorkspaceTarget,
        removeProject: (project) => void removeProject(project),
        toggleInsightsSystemProjectVisibility: () => void toggleInsightsSystemProjectVisibility(),
        toggleProjectPinned,
        toggleSystemProjectVisibility,
        toggleSessionPinned,
        archiveSession,
        restoreSession,
        renameSession,
        expandProject,
        toggleProjectExpanded,
        startPinnedDrag,
        clearSidebarDrag,
        previewPinnedDrop,
        commitPinnedDrop,
        commitPinnedPreviewDrop,
      }}
      topBar={{
        sidebarOpen,
        title,
        conversationId: view === "chat" ? selectedSessionId : null,
        workspaceName: viewWorkspaceName,
        workspaceId: viewWorkspaceId,
        busy,
        workspaceState: visibleWorkspaceState,
        workspaceKind: viewWorkspaceKind,
        selectedApp: profileWorkspaceId ? null : (selectedProjectLinkedApp ?? selectedApp),
        selectedProject: profileWorkspaceId ? null : selectedProject,
        workspaceDiff: visibleWorkspaceDiff,
        managedWorkspace,
        workspaceBusy,
        defaultTeamId: appDefaults.defaultTeamId,
        showDiffControls: view === "chat" || view === "cloud" || Boolean(profileWorkspaceId),
        diffPanelOpen,
        terminalOpen,
        rightSidebarAvailable: rightSidebarAvailableForView,
        rightSidebarOpen: diffPanelOpen,
        onToggleDiffPanel: toggleRightSidebar,
        onToggleRightSidebar: view === "team" && Boolean(teamAiThreadId) ? toggleTeamAiSidebar : toggleRightSidebar,
        onOpenSearch: () => {
          setSectionMenuOpen(null);
          setSearchOpen(true);
        },
        onToggleTerminal: () => setTerminalOpen((open) => !open),
        onOpenInsights: () => {
          setSectionMenuOpen(null);
          setView("insights");
        },
        onRunTerminalCommand: (command) => {
          setPendingTerminalCommand({ id: Date.now(), scope: viewTerminalScope, command });
          setTerminalOpen(true);
        },
        onWorkspaceToolAction: runWorkspaceTool,
        onOpenCommitDialog: openCommitDialog,
        onWorkspaceBranchChange: changeWorkspaceBranch,
        onWorkspaceBranchCreate: openCreateWorkspaceBranchDialog,
        connection,
        onBootstrap: applyBootstrapPayload,
        onOpenSandboxWorkspace: openSandboxWorkspace,
        onShowSidebar: () => setSidebarOpen(true),
        platform,
        showWorkspaceControls: view !== "team",
        insightsItems: insights.items,
        insightsSummary: insights.summary,
        insightsScanning: insights.scanRunning,
      }}
      mainPane={{
        view,
        teamChat: {
          currentUserId: teamChat.currentUserId,
          members: teamChat.members,
          detail: teamChat.detail,
          aiThread: teamChat.aiThread,
          loading: teamChat.loading,
          busy: teamChat.busy,
          error: teamChat.error,
          connection,
          providerSettings: bootstrap?.providers ?? null,
          provider: activeProvider,
          model: activeModel,
          codexPermissionMode,
          codexReasoningEffort,
          openPondCommandAccessMode: activeOpenPondCommandAccessMode,
          contextWindowStatus,
          showToast,
          onProviderChange: changeDraftProvider,
          onModelChange: setDraftModel,
          onCodexPermissionModeChange: changeCodexPermissionMode,
          onCodexReasoningEffortChange: changeCodexReasoningEffort,
          onOpenPondCommandAccessModeChange: changeOpenPondCommandAccessMode,
          onOpenProviderSettings: () => {
            setSettingsSection("providers");
            setView("settings");
          },
          onSendMessage: teamChat.sendMessage,
          onOpenAiThread: teamChat.openAiThread,
          onCloseAiThread: () => setDiffPanelOpen(false),
          onSendAiTurn: teamChat.sendAiTurn,
          onStopAiTurn: teamChat.stopAiTurn,
          onEditMessage: teamChat.editMessage,
          onDeleteMessage: teamChat.deleteMessage,
          onRetryMessage: teamChat.retryMessage,
          onDismissFailedMessage: teamChat.dismissFailedMessage,
          onLoadMoreMessages: teamChat.loadMoreMessages,
          onRetryLoad: teamChat.refresh,
        },
        bootstrap,
        runtimeEvents: sessionEvents,
        chatMessages: visibleChatMessages,
        contextWindowStatus,
        goalRuntime,
        subagentRuntime,
        selectedSessionId,
        composerDraftStore,
        mainComposerFocusRequestId,
        steerAutoDispatchBlocked: selectedSteerAutoDispatchBlocked,
        steerAutoDispatchReady: selectedSteerAutoDispatchReady,
        mentionApps: chatMentionApps,
        connectedAppMentions,
        profileSkills: bootstrap?.profile?.skills ?? [],
        selectedMentionAppId: mentionedAppId,
        busy,
        turnRunning: selectedSessionRunning,
        activeProvider,
        activeModel,
        codexPermissionMode,
        codexReasoningEffort,
        openPondCommandAccessMode: activeOpenPondCommandAccessMode,
        subagentDelegationDefaultMode,
        subagentDelegationMode,
        subagentDelegationAvailable,
        pendingApproval,
        activeWorkspaceAppId: viewWorkspaceAppId,
        activeWorkspaceId: viewWorkspaceId,
        activeWorkspaceKind: viewWorkspaceKind,
        projectTarget,
        actionCatalog: selectedActionCatalog,
        workspaceTarget,
        connection,
        workspaceName: viewWorkspaceName,
        workspaceState: visibleWorkspaceState,
        workspaceDiff: visibleWorkspaceDiff,
        workspaceBusy,
        diffBusy,
        forceChatThread: isCodexHistorySessionId(selectedSessionId),
        diffPanelOpen,
        diffPanelExpanded,
        rightPanelMode,
        rightPanelTabRequest,
        rightChatPanels: rightChatPanelViews,
        workspaceDiffPanelViewState,
        browserConversationId,
        terminalScope: viewTerminalScope,
        terminalTabs,
        terminalCwd,
        pendingTerminalCommand,
        terminalOpen,
        onToggleTerminal: () => setTerminalOpen((open) => !open),
        onWorkspaceDiffPanelViewStateChange: handleWorkspaceDiffPanelViewStateChange,
        insightsItems: insights.items,
        insightsRuns: insights.runs,
        insightsNextScanAt: insights.nextScanAt,
        insightsScanRunning: insights.scanRunning,
        insightsScanStartedAt: insights.scanStartedAt,
        insightsScanning: insights.scanning,
        insightsError: insights.error,
        onRunInsightsScan: insights.runScan,
        onAskInsightsQuestion: insights.askQuestion,
        onPatchInsightStatus: insights.patchStatus,
        onOpenInsightsSession: openSessionInChat,
        cloudProjects: bootstrap?.cloudProjects ?? [],
        cloudWorkItems,
        selectedCloudWorkItem,
        cloudWorkItemDetail,
        cloudWorkItemLocalProjectName: selectedCloudWorkItemLocalProject?.name ?? null,
        cloudLoading,
        cloudBusy,
        cloudError,
        chatHistoryHasMore: selectedChatHistoryHasMore,
        chatHistoryLoading: selectedChatHistoryLoading,
        onDiffPanelResizeStart: startDiffPanelResize,
        onToggleDiffPanelExpanded: () => setDiffPanelExpanded((expanded) => !expanded),
        onShowDiffPanel: showChangesPanel,
        onShowBrowserPanel: showBrowserPanel,
        onShowFilesPanel: () => showRightPanelDiffTab("files"),
        onShowGoalSidebarTab: showGoalSidebarTab,
        onShowRightChatPanel: showRightChatPanel,
        onAddRightChat: () => openRightChatPanel(null),
        onTerminalTabsChange: setTerminalTabs,
        onCloseRightChatPanel: closeRightChatPanel,
        onRightChatModelChange: updateRightChatModel,
        onRightChatPromptChange: updateRightChatPrompt,
        onRightChatProviderChange: updateRightChatProvider,
        onSubmitRightChat: submitRightChatPrompt,
        onStopRightChat: (sessionId) => stopTurn(sessionId),
        onCloseRightPanel: () => setDiffPanelOpen(false),
        onCloseTerminal: () => setTerminalOpen(false),
        onOpenCloudHome: openCloudHome,
        onSetupCloudProject: setupCloudProjectFromCloudView,
        onCreateCloudWork: createCloudWork,
        onSelectCloudWorkItem: selectCloudWorkItem,
        onSendCloudWorkItemMessage: sendCloudWorkItemMessage,
        onHandleCloudWorkItemBackground: handleCloudWorkItemBackground,
        onCancelCloudWorkItemCreatePipeline: cancelCloudWorkItemCreatePipeline,
        onCancelCloudWorkItemTask: cancelCloudWorkItemTask,
        onApplyCloudWorkItemPatchLocally: applyCloudWorkItemPatchLocally,
        onLoadMoreChatHistory: loadMoreSelectedChatHistory,
        canSyncWorkspace: canSyncActiveWorkspace,
        startMessage,
        onPayload: applyBootstrapPayload,
        onError: setError,
        setView,
        onOpenProfileSettings: openProfileSettings,
        onOpenProviderSettings: () => {
          setSettingsSection("providers");
          setView("settings");
        },
        changeDraftProvider,
        changeProjectTarget,
        changeWorkspaceTarget,
        setDraftProvider,
        setDraftModel,
        changeCodexPermissionMode,
        changeCodexReasoningEffort,
        changeOpenPondCommandAccessMode,
        changeSubagentDelegationMode,
        resolveApproval,
        answerCreatePipelineQuestionTurn,
        approveCreatePipelineTurn,
        cancelCreatePipelineTurn,
        reviseCreatePipelineTurn,
        setMentionedAppId,
        showToast,
        sendPrompt: sendPromptFromMainComposer,
        stopTurn,
        syncWorkspaceLocally,
        refreshWorkspaceDiff: refreshVisibleWorkspaceDiff,
      }}
      cloudSetup={{
        state: cloudSetupDialog,
        onClose: () => setCloudSetupDialog(null),
        onOpenBrowserUrl: openUrlInBrowserPanel,
        onStart: () => void startCloudSetupUpload(),
      }}
      projectConfirm={{
        state: projectConfirmDialog,
        onResolve: resolveProjectConfirmDialog,
      }}
      lazyPanels={{
        activeSessions,
        branchDialogName,
        branchDialogOpen,
        commitDialogOpen,
        commitDraft,
        commitIncludeUnstaged,
        commitMessage,
        commitNextStep,
        canPublishOpenPondProject,
        connection,
        expandProject,
        newProjectBusy,
        newProjectDialogOpen,
        newProjectDirectory: appDefaults.defaultNewProjectDirectory,
        newProjectMode,
        newProjectName,
        newProjectPath,
        projectRows: commandProjectRows,
        query,
        searchOpen,
        visibleWorkspaceDiff,
        visibleWorkspaceState,
        workspaceBusy,
        appDispatch,
        beginNewChat: () => beginNewChat(null),
        openDefaultsSettingsFromBranchDialog,
        setBranchDialogName,
        setBranchDialogOpen,
        setCommitDialogOpen,
        setCommitDraft,
        setCommitIncludeUnstaged,
        setCommitMessage,
        setCommitNextStep,
        setNewProjectDialogOpen,
        setNewProjectName,
        setNewProjectPath,
        setPrompt,
        setQuery,
        setSearchOpen,
        submitCommitDialog,
        submitCreateWorkspaceBranch,
        submitNewProjectDialog,
      }}
      toast={{
        toast,
        onDismiss: () => appDispatch({ type: "field", key: "toast", value: null }),
      }}
    />
  );
}

function oldestRuntimeEventSequence(events: RuntimeEvent[]): number | null {
  let oldest: number | null = null;
  for (const event of events) {
    if (event.sequence === undefined) continue;
    if (oldest === null || event.sequence < oldest) oldest = event.sequence;
  }
  return oldest;
}
