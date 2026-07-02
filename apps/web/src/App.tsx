import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import type { ChatAttachment, RuntimeEvent, Session } from "@openpond/contracts";
import {
  appReducer,
  createAppSetters,
  initialAppState,
  type AppToast,
  type RightChatPanel,
  type ShowAppToast,
} from "./app/app-state";
import { api } from "./api";
import { AppSettingsController, AppShellController } from "./components/app-shell/AppControllers";
import { useProjectConfirmDialog } from "./components/app-shell/ProjectConfirmDialog";
import { isDesktopShell, isMacPlatform } from "./components/app-shell/WindowControls";
import { AppSplash } from "./components/splash/AppSplash";
import type { CloudSetupDialogState } from "./components/workspace/CloudSetupDialog";
import { normalizeChatModel, SIDEBAR_SECTION_LIMIT, type SidebarProjectItem } from "./lib/app-models";
import { buildCachedChatMessages } from "./lib/chat-messages";
import {
  cachedCodexHistoryThreadPayload,
  CODEX_HISTORY_THREAD_FULL_PAGE_LIMIT,
  CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
  CODEX_HISTORY_THREAD_TAIL_LIMIT,
  loadCodexHistoryThreadPayload,
  prefetchCodexHistoryThreadPayload,
} from "./lib/codex-history-thread-cache";
import { latestGoalRuntimeFromEvents } from "./lib/goal-runtime";
import { isCodexHistorySessionId } from "./lib/sidebar-session-projects";
import {
  upsertSessionPreservingLocalSidebarState,
  upsertSessionPreservingLocalSidebarStateAndRecency,
} from "./lib/session-state";
import {
  buildRuntimeIndexes,
  latestContextUsageForSession,
  latestGoalRuntimeForSession,
  latestPendingApprovalForSession,
  runtimeEventsForSession,
} from "./lib/runtime-indexes";
import { contextWindowStatusFromUsage } from "./lib/context-window";
import type { ComposerSubmitOptions } from "./components/chat/Composer";
import type { ComposerSlashCommand } from "./lib/composer-slash-commands";
import type { SandboxActionCatalogEntry } from "./lib/sandbox-types";
import type { WorkspaceDiffTabRequest } from "./components/workspace-diff/workspace-diff-panel-model";
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
import { useInsights } from "./hooks/useInsights";
import { useOpenSandboxWorkspace } from "./hooks/useOpenSandboxWorkspace";
import { useProjectActions } from "./hooks/useProjectActions";
import { useProjectTargetActions } from "./hooks/useProjectTargetActions";
import { useRunningSessionState } from "./hooks/useRunningSessionState";
import { useRuntimeIndexes } from "./hooks/useRuntimeIndexes";
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
const RIGHT_CHAT_PANEL_LIMIT = 2;

function createRightChatPanel(input: {
  sessionId: string | null;
  provider: RightChatPanel["provider"];
  model: string;
}): RightChatPanel {
  return {
    id: `right-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: input.sessionId,
    prompt: "",
    provider: input.provider,
    model: input.model,
  };
}

function promptForRightChatCommand(command: ComposerSlashCommand, prompt: string): string {
  const args = prompt.trim();
  if (command.id === "create") return `/create ${args}`;
  if (command.id === "edit") return `/edit ${args}`;
  return `Goal: ${args}`;
}

export function App() {
  const [appState, appDispatch] = useReducer(appReducer, initialAppState);
  const [pendingTerminalCommand, setPendingTerminalCommand] = useState<{ id: number; command: string } | null>(null);
  const [mentionedAppId, setMentionedAppId] = useState<string | null>(null);
  const [cloudSetupDialog, setCloudSetupDialog] = useState<CloudSetupDialogState | null>(null);
  const [rightPanelTabRequest, setRightPanelTabRequest] = useState<WorkspaceDiffTabRequest | null>(null);
  const [pagedSessionEvents, setPagedSessionEvents] = useState<Record<string, RuntimeEvent[]>>({});
  const [rightChatHistoryEvents, setRightChatHistoryEvents] = useState<Record<string, RuntimeEvent[]>>({});
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
    chatRowsVisibleCount,
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
    rightChatPanels,
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
    setBusy,
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
  const runtimeIndexes = useRuntimeIndexes(events, approvals);
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
    setRightChatHistoryEvents({});
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
          upsertSessionPreservingLocalSidebarStateAndRecency(current, payload.session),
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
  const selectedRuntimeEventCount = useMemo(
    () => runtimeEventsForSession(runtimeIndexes, selectedSessionId).length,
    [runtimeIndexes, selectedSessionId],
  );

  useEffect(() => {
    if (!connection || !selectedSessionId || isCodexHistorySessionId(selectedSessionId)) return undefined;
    if (chatHistoryLoadingSessionIdsRef.current.has(selectedSessionId)) return undefined;
    if (selectedPagedSessionEvents.length > 0 || selectedRuntimeEventCount > 0) return undefined;

    const latestSequence = bootstrap?.eventWindow?.latestSequence;
    if (!latestSequence) return undefined;

    const historySessionId = selectedSessionId;
    const beforeSequence = latestSequence + 1;
    chatHistoryLoadingSessionIdsRef.current.add(historySessionId);
    setChatHistoryLoadStates((current) => ({
      ...current,
      [historySessionId]: {
        cursorSequence: current[historySessionId]?.cursorSequence ?? beforeSequence,
        hasMore: current[historySessionId]?.hasMore ?? true,
        loading: true,
        totalMatchingEvents: current[historySessionId]?.totalMatchingEvents ?? null,
      },
    }));

    void api
      .runtimeEventsPage(connection, {
        sessionId: historySessionId,
        beforeSequence,
        limit: CHAT_HISTORY_PAGE_LIMIT,
      })
      .then((page) => {
        const pageEvents = page.events.map((entry) => entry.event);
        setPagedSessionEvents((current) => ({
          ...current,
          [historySessionId]: mergeRuntimeEventLists(pageEvents, current[historySessionId] ?? EMPTY_RUNTIME_EVENTS),
        }));
        setChatHistoryLoadStates((current) => ({
          ...current,
          [historySessionId]: {
            cursorSequence: page.previousSequence,
            hasMore: page.hasMore,
            loading: false,
            totalMatchingEvents: page.totalMatchingEvents,
          },
        }));
      })
      .catch((historyError) => {
        setError(historyError instanceof Error ? historyError.message : String(historyError));
        setChatHistoryLoadStates((current) => ({
          ...current,
          [historySessionId]: {
            cursorSequence: current[historySessionId]?.cursorSequence ?? beforeSequence,
            hasMore: current[historySessionId]?.hasMore ?? true,
            loading: false,
            totalMatchingEvents: current[historySessionId]?.totalMatchingEvents ?? null,
          },
        }));
      })
      .finally(() => {
        chatHistoryLoadingSessionIdsRef.current.delete(historySessionId);
      });

    return undefined;
  }, [
    bootstrap?.eventWindow?.latestSequence,
    connection,
    selectedPagedSessionEvents.length,
    selectedRuntimeEventCount,
    selectedSessionId,
    setError,
  ]);
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
    chatRowsVisibleCount,
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
  const shouldLoadWorkspaceDiff = Boolean(
    activeWorkspaceAppId &&
      view === "chat" &&
      (commitDialogOpen || (diffPanelOpen && rightPanelMode !== "browser")),
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
    activeWorkspaceAppId,
    view,
    shouldLoadWorkspaceDiff,
    sidebarWorkspaceAppIds,
    setError,
  });
  const refreshWorkspaceDiffWhenNeeded = useCallback(
    (appId: string | null | undefined = activeWorkspaceAppId) => {
      if (!appId || appId !== activeWorkspaceAppId || !shouldLoadWorkspaceDiff) {
        return Promise.resolve(null);
      }
      return refreshWorkspaceDiff(appId);
    },
    [activeWorkspaceAppId, refreshWorkspaceDiff, shouldLoadWorkspaceDiff],
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
    : view === "insights"
      ? "Insights"
    : view === "profile"
      ? "Agents"
    : view === "cloud"
      ? (selectedCloudWorkItem?.title ?? "Cloud")
      : (selectedSession?.title ?? "New chat");
  const browserConversationId =
    selectedSessionId ??
    `draft:${selectedProjectId ?? selectedAppId ?? selectedCloudProject?.id ?? "general"}`;
  const openInsightsSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setView("chat");
  }, [setSelectedAppId, setSelectedProjectId, setSelectedSessionId, setView]);
  const insightsSystemProject = useMemo(
    () => (bootstrap?.localProjects ?? []).find((project) => project.systemKind === "openpond.insights") ?? null,
    [bootstrap?.localProjects],
  );
  const insightsSystemProjectId = insightsSystemProject?.id ?? insights.systemSession?.localProjectId ?? null;
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
  const toggleSystemProjectVisibility = useCallback(async (item: SidebarProjectItem) => {
    if (!connection || item.kind !== "local" || !item.project.systemKind) return;
    try {
      const payload = await api.updateLocalProjectAgentSetup(connection, item.project.id, {
        hiddenFromDefaultSidebar: !item.project.hiddenFromDefaultSidebar,
      });
      applyBootstrapPayload(payload.bootstrap);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [applyBootstrapPayload, connection, setError]);
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
    connection,
    localProjectById,
    selectedCloudProject,
    selectedProject,
    setWorkspaceBusy,
    showToast,
    visibleWorkspaceState,
  });
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
    draftModel,
    draftProvider,
    expandProject,
    prompt,
    apps: bootstrap?.apps ?? [],
    mentionedAppId,
    ensureCloudSessionReady,
    refreshWorkspace,
    refreshWorkspaceDiff: refreshWorkspaceDiffWhenNeeded,
    selectedApp,
    selectedActionCatalog,
    openPondActionCatalog,
    selectedCloudProject,
    selectedProject,
    selectedProjectLinkedOpenPondApp,
    selectedSession,
    sessions,
    setDraftModel,
    setDraftProvider,
    setError,
    setPrompt,
    setMentionedAppId,
    setCodexHistoryEvents,
    setCodexHistorySessions,
    onCodexHistoryTurnPayload: applyRightCodexHistoryPayload,
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
  const showRightPanelDiffTab = useCallback(
    (tab: WorkspaceDiffTabRequest["tab"]) => {
      setRightPanelTabRequest((current) => ({ id: (current?.id ?? 0) + 1, tab }));
      showChangesPanel();
    },
    [showChangesPanel],
  );
  const openRightChatPanel = useCallback(
    (session: Session | null = null) => {
      const nextPanel = createRightChatPanel({
        sessionId: session?.id ?? null,
        provider: session?.provider ?? activeProvider,
        model: session?.modelRef?.modelId ?? activeModel,
      });
      setRightChatPanels((current) => {
        if (session?.id && current.some((panel) => panel.sessionId === session.id)) return current;
        const next = [...current, nextPanel];
        if (next.length <= RIGHT_CHAT_PANEL_LIMIT) return next;
        return [next[0]!, nextPanel];
      });
      setDiffPanelOpen(true);
      setRightPanelMode("chat");
      setView("chat");
    },
    [activeModel, activeProvider, setDiffPanelOpen, setRightChatPanels, setRightPanelMode, setView],
  );
  const showRightChatPanel = useCallback(() => {
    if (rightChatPanels.length === 0) {
      openRightChatPanel(null);
      return;
    }
    setDiffPanelOpen(true);
    setRightPanelMode("chat");
    setView("chat");
  }, [openRightChatPanel, rightChatPanels.length, setDiffPanelOpen, setRightPanelMode, setView]);
  const closeRightChatPanel = useCallback(
    (panelId: string) => {
      const closesLastPanel = rightChatPanels.length <= 1 && rightChatPanels.some((panel) => panel.id === panelId);
      const removePanel = () => {
        setRightChatPanels((current) => current.filter((panel) => panel.id !== panelId));
      };
      if (closesLastPanel && rightPanelMode === "chat") {
        showRightPanelDiffTab("summary");
        if (typeof window === "undefined") {
          removePanel();
          return;
        }
        window.requestAnimationFrame(removePanel);
        return;
      }
      removePanel();
    },
    [rightChatPanels, rightPanelMode, setRightChatPanels, showRightPanelDiffTab],
  );
  const updateRightChatPrompt = useCallback(
    (panelId: string, nextPrompt: string) => {
      setRightChatPanels((current) =>
        current.map((panel) => (panel.id === panelId ? { ...panel, prompt: nextPrompt } : panel)),
      );
    },
    [setRightChatPanels],
  );
  const updateRightChatModel = useCallback(
    (panelId: string, model: string) => {
      setRightChatPanels((current) =>
        current.map((panel) => (panel.id === panelId ? { ...panel, model } : panel)),
      );
    },
    [setRightChatPanels],
  );
  const updateRightChatProvider = useCallback(
    (panelId: string, provider: RightChatPanel["provider"]) => {
      setRightChatPanels((current) =>
        current.map((panel) =>
          panel.id === panelId
            ? {
                ...panel,
                provider,
                model: normalizeChatModel(provider, panel.model, bootstrap?.providers ?? null),
              }
            : panel,
        ),
      );
    },
    [bootstrap?.providers, setRightChatPanels],
  );
  const rightCodexHistorySessionKey = useMemo(() => {
    const seen = new Set<string>();
    const sessionIds: string[] = [];
    for (const panel of rightChatPanels) {
      if (!isCodexHistorySessionId(panel.sessionId) || !panel.sessionId || seen.has(panel.sessionId)) continue;
      seen.add(panel.sessionId);
      sessionIds.push(panel.sessionId);
    }
    return sessionIds.join("\n");
  }, [rightChatPanels]);

  useEffect(() => {
    if (!connection || !rightCodexHistorySessionKey) return undefined;

    const historyConnection = connection;
    let cancelled = false;
    const refreshTimers: number[] = [];
    const sessionIds = rightCodexHistorySessionKey.split("\n").filter(Boolean);

    function scheduleRefresh(sessionId: string) {
      const timer = window.setTimeout(() => {
        loadThread(sessionId, true);
      }, 2500);
      refreshTimers.push(timer);
    }

    function loadThread(sessionId: string, force: boolean) {
      void loadCodexHistoryThreadPayload(historyConnection, sessionId, { force })
        .then((payload) => {
          if (cancelled) return;
          applyRightCodexHistoryPayload(payload);
          if (payload.session.status === "active" || latestGoalRuntimeFromEvents(payload.events)?.tone === "active") {
            scheduleRefresh(sessionId);
          }
        })
        .catch((historyError) => {
          if (!cancelled) setError(historyError instanceof Error ? historyError.message : String(historyError));
        });
    }

    for (const sessionId of sessionIds) {
      const cachedPayload = cachedCodexHistoryThreadPayload(historyConnection, sessionId);
      if (cachedPayload) applyRightCodexHistoryPayload(cachedPayload);
      loadThread(sessionId, Boolean(cachedPayload));
    }

    return () => {
      cancelled = true;
      for (const timer of refreshTimers) window.clearTimeout(timer);
    };
  }, [applyRightCodexHistoryPayload, connection, rightCodexHistorySessionKey, setError]);

  const rightChatPanelViews = useMemo(() => {
    const sessionById = new Map(sidebarSessions.map((session) => [session.id, session]));
    return rightChatPanels.map((panel) => {
      const session = panel.sessionId ? (sessionById.get(panel.sessionId) ?? null) : null;
      const provider = session?.provider ?? panel.provider;
      const isHistoryPanel = isCodexHistorySessionId(panel.sessionId);
      const panelEvents = isHistoryPanel
        ? (
            (panel.sessionId ? rightChatHistoryEvents[panel.sessionId] : undefined) ??
            (panel.sessionId === selectedSessionId ? codexHistoryEvents : EMPTY_RUNTIME_EVENTS)
          )
        : runtimeEventsForSession(runtimeIndexes, panel.sessionId);
      const panelIndexes = isHistoryPanel ? buildRuntimeIndexes(panelEvents, []) : runtimeIndexes;
      const contextWindowStatusForPanel = contextWindowStatusFromUsage({
        provider,
        snapshot: latestContextUsageForSession(panelIndexes, panel.sessionId),
      });
      const workspaceRootPath = session?.cwd ?? null;
      const activeWorkspaceAppIdForPanel =
        session?.appId ??
        (session?.workspaceKind === "local_project" ? session.workspaceId ?? null : null);
      return {
        ...panel,
        session,
        title: session?.title ?? "New chat",
        messages: buildCachedChatMessages(panelEvents),
        contextWindowStatus: contextWindowStatusForPanel,
        goalRuntime: latestGoalRuntimeForSession(panelIndexes, panel.sessionId),
        pendingApproval: latestPendingApprovalForSession(panelIndexes, panel.sessionId),
        running: session ? runningSessionIds.has(session.id) : false,
        workspaceRootPath,
        activeWorkspaceAppId: activeWorkspaceAppIdForPanel,
      };
    });
  }, [
    codexHistoryEvents,
    rightChatHistoryEvents,
    rightChatPanels,
    runtimeIndexes,
    runningSessionIds,
    selectedSessionId,
    sidebarSessions,
  ]);
  const submitRightChatPrompt = useCallback(
    async (
      panelId: string,
      attachments: ChatAttachment[] = [],
      action: SandboxActionCatalogEntry | null = null,
      command: ComposerSlashCommand | null = null,
      options: ComposerSubmitOptions = {},
    ) => {
      const panel = rightChatPanels.find((candidate) => candidate.id === panelId);
      if (!panel) return false;
      if (command?.id === "insights") {
        setView("insights");
        updateRightChatPrompt(panelId, "");
        const payload = await insights.runScan();
        const activeCount = payload?.summary.activeCount ?? insights.summary?.activeCount ?? 0;
        showToast(`${activeCount} active insight${activeCount === 1 ? "" : "s"}.`, "info");
        return true;
      }
      if (command && !panel.prompt.trim()) {
        showToast(`Add instructions after ${command.command}.`, "info");
        return false;
      }
      if (command && attachments.length > 0) {
        showToast(`${command.command} tasks do not accept attachments yet. Add file context in the task thread.`, "error");
        return false;
      }
      const session = panel.sessionId
        ? sidebarSessions.find((candidate) => candidate.id === panel.sessionId) ?? null
        : null;
      const promptForTurn = command ? promptForRightChatCommand(command, panel.prompt) : panel.prompt;
      const sessionEvents = isCodexHistorySessionId(panel.sessionId)
        ? (
            (panel.sessionId ? rightChatHistoryEvents[panel.sessionId] : undefined) ??
            (panel.sessionId === selectedSessionId ? codexHistoryEvents : EMPTY_RUNTIME_EVENTS)
          )
        : runtimeEventsForSession(runtimeIndexes, panel.sessionId);
      const appendRightCodexHistoryEvent = isCodexHistorySessionId(panel.sessionId) && panel.sessionId
        ? (event: RuntimeEvent) => {
            const historySessionId = panel.sessionId!;
            setRightChatHistoryEvents((current) => ({
              ...current,
              [historySessionId]: mergeRuntimeEventLists(
                current[historySessionId] ?? sessionEvents,
                [event],
              ),
            }));
          }
        : undefined;
      return sendPrompt(attachments, action, promptForTurn, {
        session,
        selectSession: false,
        provider: panel.provider,
        model: panel.model,
        chatMessages: buildCachedChatMessages(sessionEvents),
        displayPrompt: options.displayPrompt,
        onCodexHistoryOptimisticEvent: appendRightCodexHistoryEvent,
        clearPrompt: () => updateRightChatPrompt(panelId, ""),
        onSessionCreated: (createdSession) => {
          setRightChatPanels((current) =>
            current.map((candidate) =>
              candidate.id === panelId
                ? {
                    ...candidate,
                    sessionId: createdSession.id,
                    provider: createdSession.provider,
                    model: createdSession.modelRef?.modelId ?? candidate.model,
                  }
                : candidate,
            ),
          );
        },
      });
    },
    [
      codexHistoryEvents,
      rightChatHistoryEvents,
      rightChatPanels,
      runtimeIndexes,
      selectedSessionId,
      insights.runScan,
      insights.summary?.activeCount,
      sendPrompt,
      setRightChatPanels,
      sidebarSessions,
      showToast,
      updateRightChatPrompt,
    ],
  );
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
        sectionMenuOpen,
        dragItem,
        pinnedRows,
        pinnedSessions,
        visibleLocalProjectRows,
        localProjectRows,
        insightsSystemProjectHidden,
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
        setChatRowsVisibleCount,
        beginNewChat,
        dockSessionRight: openRightChatPanel,
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
        toggleInsightsSystemProjectVisibility: () => void toggleInsightsSystemProjectVisibility(),
        toggleProjectPinned,
        toggleSystemProjectVisibility,
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
        onOpenInsights: () => {
          setSectionMenuOpen(null);
          setView("insights");
        },
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
        insightsItems: insights.items,
        insightsSummary: insights.summary,
        insightsScanning: insights.scanRunning,
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
        rightPanelTabRequest,
        rightChatPanels: rightChatPanelViews,
        browserConversationId,
        terminalCwd,
        pendingTerminalCommand,
        terminalOpen,
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
        onOpenInsightsSession: openInsightsSession,
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
        onShowReviewPanel: () => showRightPanelDiffTab("review"),
        onShowRightChatPanel: showRightChatPanel,
        onShowSummaryPanel: () => showRightPanelDiffTab("summary"),
        onAddRightChat: () => openRightChatPanel(null),
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
