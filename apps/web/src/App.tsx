import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import type { RuntimeEvent } from "@openpond/contracts";
import { appReducer, createAppSetters, initialAppState, type AppToast, type ShowAppToast } from "./app/app-state";
import { api } from "./api";
import { AppSettingsController, AppShellController } from "./components/app-shell/AppControllers";
import { useProjectConfirmDialog } from "./components/app-shell/ProjectConfirmDialog";
import { isDesktopShell, isMacPlatform } from "./components/app-shell/WindowControls";
import { AppSplash } from "./components/splash/AppSplash";
import type { CloudSetupDialogState } from "./components/workspace/CloudSetupDialog";
import { SIDEBAR_SECTION_LIMIT } from "./lib/app-models";
import {
  CODEX_HISTORY_THREAD_FULL_PAGE_LIMIT,
  CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
  CODEX_HISTORY_THREAD_TAIL_LIMIT,
  loadCodexHistoryThreadPayload,
  prefetchCodexHistoryThreadPayload,
} from "./lib/codex-history-thread-cache";
import { isCodexHistorySessionId } from "./lib/sidebar-session-projects";
import {
  buildRuntimeIndexes,
  runtimeEventsForSession,
} from "./lib/runtime-indexes";
import {
  isCloudWorkspaceKind,
} from "./lib/workspace-location";
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
import { useChatActions } from "./hooks/useChatActions";
import { useAppConversationContext } from "./hooks/useAppConversationContext";
import { useCloudSessionReady } from "./hooks/useCloudSessionReady";
import { useCodexPreferenceActions } from "./hooks/useCodexPreferenceActions";
import { useCloudWorkItems } from "./hooks/useCloudWorkItems";
import { useCloudWorkspaceSetup } from "./hooks/useCloudWorkspaceSetup";
import { useCodexHistoryEvents } from "./hooks/useCodexHistoryEvents";
import { usePinnedSidebarDrag } from "./hooks/usePinnedSidebarDrag";
import { useSidebarData } from "./hooks/useSidebarData";
import { useCommandShortcuts } from "./hooks/useAppEffects";
import { useAppBootstrap } from "./hooks/useAppBootstrap";
import { useGitSetupNotifications } from "./hooks/useGitSetupNotifications";
import { useLayoutPreferences } from "./hooks/useLayoutPreferences";
import { useOpenSandboxWorkspace } from "./hooks/useOpenSandboxWorkspace";
import { useProjectActions } from "./hooks/useProjectActions";
import { useProjectTargetActions } from "./hooks/useProjectTargetActions";
import { useRunningSessionState } from "./hooks/useRunningSessionState";
import { useSandboxActionContext } from "./hooks/useSandboxActionContext";
import { useSidebarExpansion } from "./hooks/useSidebarExpansion";
import { useSidebarMutations } from "./hooks/useSidebarMutations";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { useWorkspaceController } from "./hooks/useWorkspaceController";

type ChatHistoryLoadState = {
  cursorSequence: number | null;
  hasMore: boolean;
  loading: boolean;
  totalMatchingEvents: number | null;
};

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];
const CHAT_HISTORY_PAGE_LIMIT = 500;

export function App() {
  const [appState, appDispatch] = useReducer(appReducer, initialAppState);
  const [pendingTerminalCommand, setPendingTerminalCommand] = useState<{ id: number; command: string } | null>(null);
  const [mentionedAppId, setMentionedAppId] = useState<string | null>(null);
  const [cloudSetupDialog, setCloudSetupDialog] = useState<CloudSetupDialogState | null>(null);
  const [pagedSessionEvents, setPagedSessionEvents] = useState<Record<string, RuntimeEvent[]>>({});
  const [chatHistoryLoadStates, setChatHistoryLoadStates] = useState<Record<string, ChatHistoryLoadState>>({});
  const chatHistoryLoadingSessionIdsRef = useRef<Set<string>>(new Set());
  const {
    confirmProjectAction,
    projectConfirmDialog,
    resolveProjectConfirmDialog,
  } = useProjectConfirmDialog();
  const appSetters = useMemo(() => createAppSetters(appDispatch), [appDispatch]);
  const {
    query,
    searchOpen,
    archivedChatsOpen,
    sectionMenuOpen,
    projectsExpanded,
    cloudProjectsExpanded,
    chatsExpanded,
    sidebarOpen,
    view,
    selectedAppId,
    selectedProjectId,
    selectedSessionId,
    prompt,
    draftProvider,
    draftModel,
    codexPermissionMode,
    codexReasoningEffort,
    busy,
    diffPanelOpen,
    diffPanelExpanded,
    rightPanelMode,
    terminalOpen,
    syncingWorkspaceAppId,
    settingsSection,
    newProjectDialogOpen,
    newProjectMode,
    newProjectName,
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
    setChatsExpanded,
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
    setBusy,
    setDiffPanelOpen,
    setDiffPanelExpanded,
    setRightPanelMode,
    setTerminalOpen,
    setSyncingWorkspaceAppId,
    setSettingsSection,
    setNewProjectDialogOpen,
    setNewProjectMode,
    setNewProjectName,
    setNewProjectBusy,
    setCommitDialogOpen,
    setCommitMessage,
    setCommitIncludeUnstaged,
    setCommitNextStep,
    setCommitDraft,
    setBranchDialogOpen,
    setBranchDialogName,
    setError,
  } = appSetters;
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
    setError,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
  });
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
    setProjectsExpanded(true);
    if (projectsCollapsed) toggleProjectsCollapsed();
  }, [projectsCollapsed, setProjectsExpanded, toggleProjectsCollapsed]);

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
  const runtimeIndexes = useMemo(() => buildRuntimeIndexes(events, approvals), [events, approvals]);
  const { chatMentionApps, cloudProjectIdsByTeam, pendingApproval } = useAppConversationContext({
    bootstrap,
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
    cloudTargetName,
    cloudLinked,
    localTargetName,
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
  const { openPondActionCatalog, selectedActionCatalog } = useSandboxActionContext({
    cloudProjectById,
    cloudProjects: bootstrap?.cloudProjects ?? [],
    connection,
    defaultTeamId: appDefaults.defaultTeamId,
    localProjects: bootstrap?.localProjects ?? [],
    profileActionCatalogEntries: bootstrap?.profile.actionCatalog ?? [],
    selectedCloudProject,
    selectedProject,
  });
  const {
    expandedProjectIds,
    expandProject,
    toggleProjectExpanded,
    setExpandedProjectIds,
  } = useSidebarExpansion({ selectedProjectId });

  useAppShellEffects({
    activeWorkspaceId,
    activeWorkspaceKind,
    appDispatch,
    connection,
    expandProject,
    linkedProjectByAppId,
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

  const showToast = useCallback<ShowAppToast>(
    (
      message: string,
      tone: "success" | "error" | "info" = "info",
      options: Pick<AppToast, "actionLabel" | "onAction" | "persistent"> = {},
    ) => {
      appDispatch({ type: "showToast", toast: { id: Date.now(), message, tone, ...options } });
    },
    [],
  );
  const {
    cloudBusy,
    cloudError,
    cloudLoading,
    cloudWorkItemDetail,
    cloudWorkItems,
    selectedCloudWorkItem,
    selectedCloudWorkItemId,
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
    showToast,
  });

  const { changeCodexPermissionMode, changeCodexReasoningEffort } = useCodexPreferenceActions({
    connection,
    setBootstrap,
    setCodexPermissionMode,
    setCodexReasoningEffort,
    setError,
  });

  const resolveApproval = useApprovalResolver({ connection, setError });
  const beginNewChat = useBeginNewChat({
    appDispatch,
    expandProject,
    linkedProjectByAppId,
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
    setPagedSessionEvents({});
    setChatHistoryLoadStates({});
    chatHistoryLoadingSessionIdsRef.current.clear();
  }, [bootstrap?.server.id]);

  const loadMoreSelectedChatHistory = useCallback(async () => {
    if (!connection || !selectedSessionId) return false;
    if (chatHistoryLoadingSessionIdsRef.current.has(selectedSessionId)) return false;
    const currentState = chatHistoryLoadStates[selectedSessionId];
    if (currentState?.hasMore === false) return false;

    if (isCodexHistorySessionId(selectedSessionId)) {
      const currentLimit = Math.max(
        currentState?.totalMatchingEvents ?? 0,
        codexHistoryEvents.length,
        CODEX_HISTORY_THREAD_TAIL_LIMIT,
      );
      const nextLimit = Math.min(
        CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
        Math.max(CODEX_HISTORY_THREAD_FULL_PAGE_LIMIT, currentLimit * 2),
      );

      chatHistoryLoadingSessionIdsRef.current.add(selectedSessionId);
      setChatHistoryLoadStates((current) => ({
        ...current,
        [selectedSessionId]: {
          cursorSequence: null,
          hasMore: true,
          loading: true,
          totalMatchingEvents: current[selectedSessionId]?.totalMatchingEvents ?? codexHistoryEvents.length,
        },
      }));

      try {
        const payload = await loadCodexHistoryThreadPayload(connection, selectedSessionId, {
          force: true,
          limit: nextLimit,
          tail: false,
        });
        setCodexHistoryEvents(payload.events);
        setCodexHistorySessions((current) =>
          current.some((session) => session.id === payload.session.id)
            ? current.map((session) => (session.id === payload.session.id ? payload.session : session))
            : [payload.session, ...current],
        );
        setChatHistoryLoadStates((current) => ({
          ...current,
          [selectedSessionId]: {
            cursorSequence: null,
            hasMore: payload.events.length >= nextLimit && nextLimit < CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
            loading: false,
            totalMatchingEvents: nextLimit,
          },
        }));
        return payload.events.length > codexHistoryEvents.length;
      } catch (historyError) {
        setError(historyError instanceof Error ? historyError.message : String(historyError));
        setChatHistoryLoadStates((current) => ({
          ...current,
          [selectedSessionId]: {
            cursorSequence: null,
            hasMore: current[selectedSessionId]?.hasMore ?? true,
            loading: false,
            totalMatchingEvents: current[selectedSessionId]?.totalMatchingEvents ?? codexHistoryEvents.length,
          },
        }));
        return false;
      } finally {
        chatHistoryLoadingSessionIdsRef.current.delete(selectedSessionId);
      }
    }

    const currentSessionEvents = mergeRuntimeEventLists(
      pagedSessionEvents[selectedSessionId] ?? EMPTY_RUNTIME_EVENTS,
      runtimeEventsForSession(runtimeIndexes, selectedSessionId),
    );
    const beforeSequence = currentState?.cursorSequence ?? oldestRuntimeEventSequence(currentSessionEvents);
    if (!beforeSequence) return false;

    chatHistoryLoadingSessionIdsRef.current.add(selectedSessionId);
    setChatHistoryLoadStates((current) => ({
      ...current,
      [selectedSessionId]: {
        cursorSequence: current[selectedSessionId]?.cursorSequence ?? beforeSequence,
        hasMore: current[selectedSessionId]?.hasMore ?? true,
        loading: true,
        totalMatchingEvents: current[selectedSessionId]?.totalMatchingEvents ?? null,
      },
    }));

    try {
      const page = await api.runtimeEventsPage(connection, {
        sessionId: selectedSessionId,
        beforeSequence,
        limit: CHAT_HISTORY_PAGE_LIMIT,
      });
      const pageEvents = page.events.map((entry) => entry.event);
      setPagedSessionEvents((current) => ({
        ...current,
        [selectedSessionId]: mergeRuntimeEventLists(pageEvents, current[selectedSessionId] ?? EMPTY_RUNTIME_EVENTS),
      }));
      setChatHistoryLoadStates((current) => ({
        ...current,
        [selectedSessionId]: {
          cursorSequence: page.previousSequence,
          hasMore: page.hasMore,
          loading: false,
          totalMatchingEvents: page.totalMatchingEvents,
        },
      }));
      return pageEvents.length > 0;
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : String(historyError));
      setChatHistoryLoadStates((current) => ({
        ...current,
        [selectedSessionId]: {
          cursorSequence: current[selectedSessionId]?.cursorSequence ?? beforeSequence,
          hasMore: current[selectedSessionId]?.hasMore ?? true,
          loading: false,
          totalMatchingEvents: current[selectedSessionId]?.totalMatchingEvents ?? null,
        },
      }));
      return false;
    } finally {
      chatHistoryLoadingSessionIdsRef.current.delete(selectedSessionId);
    }
  }, [
    chatHistoryLoadStates,
    codexHistoryEvents.length,
    connection,
    pagedSessionEvents,
    runtimeIndexes,
    selectedSessionId,
    setCodexHistoryEvents,
    setCodexHistorySessions,
    setError,
  ]);

  const selectedPagedSessionEvents = selectedSessionId
    ? (pagedSessionEvents[selectedSessionId] ?? EMPTY_RUNTIME_EVENTS)
    : EMPTY_RUNTIME_EVENTS;
  const selectedRuntimeIndexes = useMemo(
    () => {
      if (isCodexHistorySessionId(selectedSessionId)) return buildRuntimeIndexes(codexHistoryEvents, []);
      if (!selectedSessionId || selectedPagedSessionEvents.length === 0) return runtimeIndexes;
      return buildRuntimeIndexes(
        mergeRuntimeEventLists(
          selectedPagedSessionEvents,
          runtimeEventsForSession(runtimeIndexes, selectedSessionId),
        ),
        approvals,
      );
    },
    [approvals, codexHistoryEvents, runtimeIndexes, selectedPagedSessionEvents, selectedSessionId],
  );

  const {
    activeSessions,
    pinnedProjects,
    pinnedSessions,
    pinnedItems,
    projectRows,
    localProjectRows,
    visibleLocalProjectRows,
    cloudProjectRows,
    cloudWorkItemsByProjectId,
    projectSessionRowsByProjectId,
    sidebarProjectIdBySessionId,
    chatRows,
    visibleChatRows,
    chatMessages,
    contextUsage,
    goalRuntime,
  } = useSidebarData({
    localProjects: bootstrap?.localProjects ?? [],
    cloudProjects: bootstrap?.cloudProjects ?? [],
    cloudWorkItems,
    sessions: sidebarSessions,
    runtimeIndexes: selectedRuntimeIndexes,
    appPreferences,
    selectedSessionId,
    archivedChatsOpen,
    projectsExpanded,
    chatsExpanded,
  });
  const codexHistoryPrefetchSessionIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const addSession = (session: { id: string } | null | undefined) => {
      if (!session || session.id === selectedSessionId || !isCodexHistorySessionId(session.id) || seen.has(session.id)) {
        return;
      }
      seen.add(session.id);
      ids.push(session.id);
    };

    for (const item of visibleLocalProjectRows) {
      for (const session of (projectSessionRowsByProjectId[item.id] ?? []).slice(0, 2)) {
        addSession(session);
      }
    }

    for (const projectId of expandedProjectIds) {
      for (const session of (projectSessionRowsByProjectId[projectId] ?? []).slice(0, SIDEBAR_SECTION_LIMIT)) {
        addSession(session);
      }
    }

    for (const session of pinnedSessions) addSession(session);
    for (const session of visibleChatRows) addSession(session);

    return ids.slice(0, 8);
  }, [
    expandedProjectIds,
    pinnedSessions,
    projectSessionRowsByProjectId,
    selectedSessionId,
    visibleChatRows,
    visibleLocalProjectRows,
  ]);
  useEffect(() => {
    if (!connection || codexHistoryPrefetchSessionIds.length === 0) return undefined;
    let cancelled = false;
    const timers: number[] = [];

    codexHistoryPrefetchSessionIds.forEach((sessionId, index) => {
      const prefetch = () => {
        if (!cancelled) prefetchCodexHistoryThreadPayload(connection, sessionId);
      };
      if (index === 0) {
        prefetch();
      } else {
        timers.push(window.setTimeout(prefetch, Math.min(index * 250, 1000)));
      }
    });

    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [codexHistoryPrefetchSessionIds, connection]);
  const { runningSessionIds, selectedSessionRunning } = useRunningSessionState({
    goalRuntime,
    runtimeIndexes,
    selectedSession,
    selectedSessionId,
    sidebarSessions,
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
      contextUsage,
      pinnedItems,
      pinnedPreviewKeys: pinnedPreviewKeys ?? [],
      pinnedProjects,
      projectRows,
      visibleLocalProjectRows,
    });

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
    activeWorkspaceAppId,
    view,
    sidebarWorkspaceAppIds,
    setError,
  });
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
  const { projectTarget, workspaceTarget } = useWorkspaceTargetState({
    accountPending,
    accountSignedOut,
    activeWorkspaceLocation,
    bootstrap,
    busy,
    cloudLinked,
    cloudTargetName,
    localTargetName,
    selectedCloudProject,
    selectedProject,
    selectedSession,
    workspaceBusy,
  });
  const title = view === "apps"
    ? "Apps"
    : view === "profile"
      ? "Profile"
    : view === "cloud"
      ? (selectedCloudWorkItem?.title ?? "Cloud")
      : (selectedSession?.title ?? "New chat");
  const browserConversationId =
    selectedSessionId ??
    `draft:${selectedProjectId ?? selectedAppId ?? selectedCloudProject?.id ?? "general"}`;
  const { addProjectFolder, createCloudProjectFromScratch, createProjectFromScratch, removeProject } = useProjectActions({
    connection,
    defaultTeamId: appDefaults.defaultTeamId,
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
  });
  const { changeProjectTarget, submitNewProjectDialog } = useProjectTargetActions({
    addProjectFolder,
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
    projectTargetValue: projectTarget.value,
    setDiffPanelOpen,
    setDraftModel,
    setDraftProvider,
    setError,
    setNewProjectBusy,
    setNewProjectDialogOpen,
    setNewProjectName,
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
    refreshWorkspaceDiff,
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
    connection,
    localProjectById,
    selectedCloudProject,
    selectedProject,
    setWorkspaceBusy,
    showToast,
    visibleWorkspaceState,
  });
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
    draftModel,
    draftProvider,
    expandProject,
    prompt,
    apps: bootstrap?.apps ?? [],
    mentionedAppId,
    ensureCloudSessionReady,
    refreshWorkspace,
    refreshWorkspaceDiff,
    selectedApp,
    selectedActionCatalog,
    openPondActionCatalog,
    selectedCloudProject,
    selectedProject,
    selectedProjectLinkedOpenPondApp,
    selectedSession,
    sessions,
    setBusy,
    setDraftModel,
    setDraftProvider,
    setError,
    setPrompt,
    setMentionedAppId,
    setCodexHistoryEvents,
    setCodexHistorySessions,
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
    changeWorkspaceTarget,
    moveProjectToCloud,
    openCloudSetupForLocalProject,
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
    setWorkspaceBusy,
    showToast,
    visibleWorkspaceState,
    workspaceBusy,
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
    toggleChangesPanel,
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
  const openProfileSettings = useCallback(() => {
    setSectionMenuOpen(null);
    setView("profile");
    setSidebarOpen(true);
  }, [setSectionMenuOpen, setSidebarOpen, setView]);

  if (!startup.ready) {
    return <AppSplash startup={startup} />;
  }

  if (view === "settings") {
    return (
      <AppSettingsController
        settings={{
          payload: bootstrap,
          connection,
          initialSection: settingsSection,
          onPayload: applyBootstrapPayload,
          onError: setError,
          onToast: showToast,
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
  const terminalCwd = visibleWorkspaceState?.initialized
    ? visibleWorkspaceState.repoPath
    : (selectedSession?.cwd ?? null);
  const appShellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--diff-panel-width": `${diffPanelWidth}px`,
  } as CSSProperties;
  const changesPanelActive = diffPanelOpen && rightPanelMode === "changes";
  const appShellClassName = [
    "app-shell",
    isMac ? "platform-macos" : "",
    sidebarOpen ? "sidebar-open" : "sidebar-closed",
    sidebarResizing ? "sidebar-resizing" : "",
    diffPanelResizing ? "diff-panel-resizing" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const selectedChatHistoryLoadState = selectedSessionId ? chatHistoryLoadStates[selectedSessionId] : null;
  const selectedChatHistoryCursor = selectedSessionId
    ? (
      selectedChatHistoryLoadState?.cursorSequence ??
      oldestRuntimeEventSequence(
        mergeRuntimeEventLists(
          selectedPagedSessionEvents,
          runtimeEventsForSession(runtimeIndexes, selectedSessionId),
        ),
      )
    )
    : null;
  const selectedChatHistoryCanPage =
    Boolean(selectedSessionId) &&
    Boolean(connection) &&
    (
      isCodexHistorySessionId(selectedSessionId)
        ? true
        : Boolean(bootstrap?.eventWindow?.hasMoreBefore) && Boolean(selectedChatHistoryCursor)
    );
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
        account,
        profile: bootstrap?.profile,
        pinnedCollapsed,
        projectsCollapsed,
        cloudProjectsCollapsed,
        chatsCollapsed,
        archivedChatsOpen,
        projectsExpanded,
        cloudProjectsExpanded,
        chatsExpanded,
        sectionMenuOpen,
        dragItem,
        pinnedRows,
        pinnedSessions,
        visibleLocalProjectRows,
        localProjectRows,
        cloudProjectRows,
        cloudWorkItemsByProjectId,
        projectSessionRowsByProjectId,
        sidebarProjectIdBySessionId,
        runningSessionIds,
        visibleChatRows,
        chatRows,
        expandedProjectIds,
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
        setChatsExpanded,
        beginNewChat,
        openCloudHome,
        createCloudEnvironment: createCloudEnvironmentFromSidebar,
        selectCloudWorkItem,
        addProjectFolder: () => void addProjectFolder(),
        startProjectFromScratch: () => {
          setNewProjectMode("local");
          setNewProjectName("");
          setNewProjectDialogOpen(true);
        },
        startCloudProjectFromScratch: openCloudProjectDialog,
        moveProjectToCloud,
        removeProject: (project) => void removeProject(project),
        toggleProjectPinned,
        toggleSessionPinned,
        archiveSession,
        restoreSession,
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
        workspaceName,
        busy,
        workspaceState: visibleWorkspaceState,
        workspaceKind: activeWorkspaceKind,
        selectedApp: selectedProjectLinkedApp ?? selectedApp,
        selectedProject,
        workspaceDiff: visibleWorkspaceDiff,
        managedWorkspace,
        workspaceBusy,
        defaultTeamId: appDefaults.defaultTeamId,
        showDiffControls: view === "chat" || view === "cloud",
        diffPanelOpen: changesPanelActive,
        terminalOpen,
        onToggleDiffPanel: toggleChangesPanel,
        onOpenSearch: () => {
          setSectionMenuOpen(null);
          setSearchOpen(true);
        },
        onToggleTerminal: () => setTerminalOpen((open) => !open),
        onRunTerminalCommand: (command) => {
          setPendingTerminalCommand({ id: Date.now(), command });
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
        showWorkspaceControls: true,
      }}
      mainPane={{
        view,
        bootstrap,
        chatMessages,
        contextWindowStatus,
        goalRuntime,
        prompt,
        mentionApps: chatMentionApps,
        selectedMentionAppId: mentionedAppId,
        busy,
        turnRunning: selectedSessionRunning,
        activeProvider,
        activeModel,
        codexPermissionMode,
        codexReasoningEffort,
        pendingApproval,
        activeWorkspaceAppId,
        activeWorkspaceId,
        activeWorkspaceKind,
        projectTarget,
        actionCatalog: selectedActionCatalog,
        workspaceTarget,
        connection,
        workspaceName,
        workspaceState: visibleWorkspaceState,
        workspaceDiff: visibleWorkspaceDiff,
        workspaceBusy,
        diffBusy,
        forceChatThread: isCodexHistorySessionId(selectedSessionId),
        diffPanelOpen,
        diffPanelExpanded,
        rightPanelMode,
        browserConversationId,
        terminalCwd,
        pendingTerminalCommand,
        terminalOpen,
        cloudProjects: bootstrap?.cloudProjects ?? [],
        cloudWorkItems,
        selectedCloudWorkItem,
        cloudWorkItemDetail,
        cloudLoading,
        cloudBusy,
        cloudError,
        chatHistoryHasMore: selectedChatHistoryHasMore,
        chatHistoryLoading: selectedChatHistoryLoading,
        onDiffPanelResizeStart: startDiffPanelResize,
        onToggleDiffPanelExpanded: () => setDiffPanelExpanded((expanded) => !expanded),
        onShowDiffPanel: showChangesPanel,
        onShowBrowserPanel: showBrowserPanel,
        onShowGoalSidebarTab: showGoalSidebarTab,
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
        onLoadMoreChatHistory: loadMoreSelectedChatHistory,
        canSyncWorkspace: canSyncActiveWorkspace,
        startMessage,
        error,
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
        setDraftModel,
        changeCodexPermissionMode,
        changeCodexReasoningEffort,
        resolveApproval,
        answerCreatePipelineQuestionTurn,
        approveCreatePipelineTurn,
        cancelCreatePipelineTurn,
        reviseCreatePipelineTurn,
        setPrompt,
        setMentionedAppId,
        showToast,
        sendPrompt,
        stopTurn,
        syncWorkspaceLocally,
        refreshWorkspaceDiff: (options) =>
          refreshWorkspaceDiff(activeWorkspaceAppId, options).then(() => undefined),
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

function mergeRuntimeEventLists(first: RuntimeEvent[], second: RuntimeEvent[]): RuntimeEvent[] {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const seen = new Set<string>();
  const merged: RuntimeEvent[] = [];
  for (const event of [...first, ...second]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

function oldestRuntimeEventSequence(events: RuntimeEvent[]): number | null {
  let oldest: number | null = null;
  for (const event of events) {
    if (event.sequence === undefined) continue;
    if (oldest === null || event.sequence < oldest) oldest = event.sequence;
  }
  return oldest;
}
