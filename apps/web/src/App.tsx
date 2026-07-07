import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
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
  WorkspaceState,
  TerminalScope,
} from "@openpond/contracts";
import { buildConnectedAppStatusRows, localPathWorkspaceId } from "@openpond/contracts";
import {
  appReducer,
  createAppSetters,
  initialAppState,
  type AppToast,
  type RightChatPanel,
  type ShowAppToast,
} from "./app/app-state";
import { api, type ClientConnection } from "./api";
import { AppSettingsController, AppShellController } from "./components/app-shell/AppControllers";
import { useProjectConfirmDialog } from "./components/app-shell/ProjectConfirmDialog";
import { isDesktopShell, isMacPlatform } from "./components/app-shell/WindowControls";
import { AppSplash } from "./components/splash/AppSplash";
import type { CloudSetupDialogState } from "./components/workspace/CloudSetupDialog";
import {
  modelRefForTurn,
  normalizeChatModel,
  SIDEBAR_SECTION_LIMIT,
  type SidebarProjectItem,
} from "./lib/app-models";
import { buildCachedChatMessages } from "./lib/chat-messages";
import {
  appendPendingUserChatMessage,
  hasMatchingUserMessage,
  type PendingChatUserMessage,
} from "./lib/pending-chat-messages";
import {
  latestRuntimeEventSequence,
  mergeRuntimeEventLists,
  mergeRuntimeEventsIntoSessionPageCache,
} from "./lib/runtime-event-lists";
import {
  cachedCodexHistoryThreadPayload,
  CODEX_HISTORY_THREAD_FULL_PAGE_LIMIT,
  CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
  CODEX_HISTORY_THREAD_TAIL_LIMIT,
  loadCodexHistoryThreadPayload,
} from "./lib/codex-history-thread-cache";
import {
  activeGoalRuntimeFromSessionMetadata,
  latestGoalRuntimeFromEvents,
  latestKnownActiveGoalRuntimeFromEvents,
} from "./lib/goal-runtime";
import { isCodexHistorySessionId } from "./lib/sidebar-session-projects";
import {
  migrateDraftTerminalTabs,
  terminalScopeForSelection,
  terminalScopesEqual,
  terminalScopeSummaries,
} from "./components/terminal/terminal-state";
import type { TerminalQueuedCommand, TerminalTab } from "./components/terminal/terminal-overlay-types";
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
import {
  buildSubmitIssueSlashPrompt,
  hasGitHubIssueSubmitConnection,
} from "./lib/submit-issue-command";
import type { SandboxActionCatalogEntry } from "./lib/sandbox-types";
import type { WorkspaceDiffTabRequest } from "./components/workspace-diff/workspace-diff-panel-model";
import {
  hybridWorkspaceSessionMetadata,
  isCloudWorkspaceKind,
  isHybridWorkspaceSession,
  type WorkspaceTargetValue,
} from "./lib/workspace-location";
import { queuedCloudWorkSubmission } from "./lib/queued-cloud-work";
import { latestTurnCompletionState } from "./lib/turn-completion-state";
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
import { useCodexPreferenceActions } from "./hooks/useCodexPreferenceActions";
import { useCloudWorkItems } from "./hooks/useCloudWorkItems";
import { useCloudWorkspaceSetup } from "./hooks/useCloudWorkspaceSetup";
import { useCodexHistoryEvents } from "./hooks/useCodexHistoryEvents";
import { usePinnedSidebarDrag } from "./hooks/usePinnedSidebarDrag";
import { useOpenPondCommandAccessActions } from "./hooks/useOpenPondCommandAccessActions";
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
  if (command.id === "skill") return `/skill ${args}`;
  if (command.id === "submit-issue") return buildSubmitIssueSlashPrompt(args);
  return `Goal: ${args}`;
}

export function App() {
  const [appState, appDispatch] = useReducer(appReducer, initialAppState);
  const [pendingTerminalCommand, setPendingTerminalCommand] = useState<TerminalQueuedCommand | null>(null);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [mentionedAppId, setMentionedAppId] = useState<string | null>(null);
  const [connectedAppRows, setConnectedAppRows] = useState<ConnectedAppStatusRow[]>(() =>
    buildConnectedAppStatusRows(),
  );
  const [cloudSetupDialog, setCloudSetupDialog] = useState<CloudSetupDialogState | null>(null);
  const [rightPanelTabRequest, setRightPanelTabRequest] = useState<WorkspaceDiffTabRequest | null>(null);
  const [pagedSessionEvents, setPagedSessionEvents] = useState<Record<string, RuntimeEvent[]>>({});
  const [rightChatHistoryEvents, setRightChatHistoryEvents] = useState<Record<string, RuntimeEvent[]>>({});
  const [codexHistorySidebarEvents, setCodexHistorySidebarEvents] = useState<Record<string, RuntimeEvent[]>>({});
  const [pendingChatUserMessages, setPendingChatUserMessages] = useState<Record<string, PendingChatUserMessage>>({});
  const [chatHistoryLoadStates, setChatHistoryLoadStates] = useState<Record<string, ChatHistoryLoadState>>({});
  const chatHistoryLoadingSessionIdsRef = useRef<Set<string>>(new Set());
  const rememberWorkspaceStateRef = useRef<((state: WorkspaceState) => void) | null>(null);
  const rememberCloudWorkspaceState = useCallback((state: WorkspaceState) => {
    rememberWorkspaceStateRef.current?.(state);
  }, []);
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
    openPondCommandAccessMode,
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
  const latestErrorRef = useRef<string | null>(initialAppState.error);
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
  const { chatMentionApps, cloudProjectIdsByTeam, connectedAppMentions, pendingApproval } = useAppConversationContext({
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
  const activeOpenPondCommandAccessMode =
    selectedSession?.provider === "codex"
      ? openPondCommandAccessMode
      : selectedSession?.openPondCommandAccessMode ?? openPondCommandAccessMode;
  const profileWorkspaceId =
    view === "profile" && bootstrap?.profile?.mode === "local" && bootstrap.profile.repoPath
      ? localPathWorkspaceId(bootstrap.profile.repoPath)
      : null;
  const profileWorkspaceName = profileWorkspaceId
    ? `${bootstrap?.profile?.activeProfile ?? "default"} profile`
    : null;
  const viewWorkspaceAppId = profileWorkspaceId ?? activeWorkspaceAppId;
  const viewWorkspaceId = profileWorkspaceId ?? activeWorkspaceId;
  const viewWorkspaceKind = profileWorkspaceId ? "local_project" as const : activeWorkspaceKind;
  const viewWorkspaceName = profileWorkspaceName ?? workspaceName;
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
    setCodexHistorySidebarEvents({});
    setPendingChatUserMessages({});
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
  const selectedForwardEventSyncKeyRef = useRef<string | null>(null);

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
  useEffect(() => {
    if (!connection || !selectedSessionId || isCodexHistorySessionId(selectedSessionId)) return undefined;
    if (chatHistoryLoadingSessionIdsRef.current.has(selectedSessionId)) return undefined;
    const latestServerSequence = bootstrap?.eventWindow?.latestSequence;
    if (!latestServerSequence) return undefined;

    const selectedEvents = mergeRuntimeEventLists(
      selectedPagedSessionEvents,
      runtimeEventsForSession(runtimeIndexes, selectedSessionId),
    );
    const latestSelectedSequence = latestRuntimeEventSequence(selectedEvents);
    if (!latestSelectedSequence || latestSelectedSequence >= latestServerSequence) return undefined;

    const syncKey = `${selectedSessionId}:${latestSelectedSequence}:${latestServerSequence}`;
    if (selectedForwardEventSyncKeyRef.current === syncKey) return undefined;
    selectedForwardEventSyncKeyRef.current = syncKey;

    let cancelled = false;
    void api
      .runtimeEventsPage(connection, {
        sessionId: selectedSessionId,
        afterSequence: latestSelectedSequence,
        limit: CHAT_HISTORY_PAGE_LIMIT,
      })
      .then((page) => {
        if (cancelled) return;
        const pageEvents = page.events.map((entry) => entry.event);
        if (pageEvents.length === 0) return;
        setPagedSessionEvents((current) =>
          mergeRuntimeEventsIntoSessionPageCache(current, selectedSessionId, pageEvents),
        );
        setEvents((current) => mergeRuntimeEventLists(current, pageEvents));
      })
      .catch((historyError) => {
        if (cancelled) return;
        selectedForwardEventSyncKeyRef.current = null;
        setError(historyError instanceof Error ? historyError.message : String(historyError));
      });

    return () => {
      cancelled = true;
    };
  }, [
    bootstrap?.eventWindow?.latestSequence,
    connection,
    runtimeIndexes,
    selectedPagedSessionEvents,
    selectedSessionId,
    setError,
    setEvents,
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
  const recordPendingChatUserMessage = useCallback((message: PendingChatUserMessage) => {
    setPendingChatUserMessages((current) => ({
      ...current,
      [message.sessionId]: message,
    }));
  }, []);
  const clearPendingChatUserMessage = useCallback((sessionId: string, messageId: string) => {
    setPendingChatUserMessages((current) => {
      if (current[sessionId]?.id !== messageId) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);
  useEffect(() => {
    setPendingChatUserMessages((current) => {
      let next = current;
      for (const [sessionId, pendingMessage] of Object.entries(current)) {
        const realMessages = buildCachedChatMessages(runtimeEventsForSession(runtimeIndexes, sessionId));
        if (!hasMatchingUserMessage(realMessages, pendingMessage)) continue;
        if (next === current) next = { ...current };
        delete next[sessionId];
      }
      return next;
    });
  }, [runtimeIndexes]);
  const visibleChatMessages = useMemo(
    () =>
      appendPendingUserChatMessage(
        chatMessages,
        selectedSessionId ? pendingChatUserMessages[selectedSessionId] : null,
      ),
    [chatMessages, pendingChatUserMessages, selectedSessionId],
  );
  const activeTerminalScope = useMemo<TerminalScope>(
    () => terminalScopeForSelection({ selectedAppId, selectedProjectId, selectedSessionId }),
    [selectedAppId, selectedProjectId, selectedSessionId],
  );
  const previousTerminalScopeRef = useRef<TerminalScope | null>(null);

  useEffect(() => {
    const previousScope = previousTerminalScopeRef.current;
    previousTerminalScopeRef.current = activeTerminalScope;
    if (!previousScope || previousScope.kind !== "draft" || activeTerminalScope.kind !== "session") return;
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
  const codexHistoryPrefetchSessionKey = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const addSession = (session: { id: string } | null | undefined) => {
      if (!session || session.id === selectedSessionId || !isCodexHistorySessionId(session.id) || seen.has(session.id)) {
        return;
      }
      seen.add(session.id);
      ids.push(session.id);
    };

    for (const item of visibleProjectRows) {
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

    return ids.slice(0, 8).join("\n");
  }, [
    expandedProjectIds,
    pinnedSessions,
    projectSessionRowsByProjectId,
    selectedSessionId,
    visibleChatRows,
    visibleProjectRows,
  ]);
  const applySidebarCodexHistoryPayload = useCallback(
    (payload: { session: Session; events: RuntimeEvent[] }) => {
      setCodexHistorySidebarEvents((current) =>
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
  useEffect(() => {
    if (
      !selectedSession ||
      !selectedSessionId ||
      !isCodexHistorySessionId(selectedSessionId) ||
      codexHistoryEvents.length === 0
    ) {
      return;
    }
    applySidebarCodexHistoryPayload({
      session: selectedSession,
      events: codexHistoryEvents,
    });
  }, [applySidebarCodexHistoryPayload, codexHistoryEvents, selectedSession, selectedSessionId]);
  useEffect(() => {
    if (!connection || !codexHistoryPrefetchSessionKey) return undefined;
    let cancelled = false;
    const timers: number[] = [];
    const prefetchConnection = connection;
    const sessionIds = codexHistoryPrefetchSessionKey.split("\n").filter(Boolean);

    const loadSidebarThread = (sessionId: string) => {
      void loadCodexHistoryThreadPayload(prefetchConnection, sessionId)
        .then((payload) => {
          if (cancelled) return;
          applySidebarCodexHistoryPayload(payload);
        })
        .catch(() => undefined);
    };

    sessionIds.forEach((sessionId, index) => {
      const prefetch = () => {
        const cachedPayload = cachedCodexHistoryThreadPayload(prefetchConnection, sessionId);
        if (cachedPayload) applySidebarCodexHistoryPayload(cachedPayload);
        if (!cachedPayload) loadSidebarThread(sessionId);
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
  }, [applySidebarCodexHistoryPayload, codexHistoryPrefetchSessionKey, connection]);
  const sidebarSessionById = useMemo(
    () => new Map(sidebarSessions.map((session) => [session.id, session])),
    [sidebarSessions],
  );
  const sidebarGoalRuntimeBySessionId = useMemo(() => {
    const next = new Map(runtimeIndexes.latestGoalRuntimeBySessionId);
    for (const session of sidebarSessions) {
      const metadataGoalRuntime =
        session.status === "active" ? activeGoalRuntimeFromSessionMetadata(session.metadata) : null;
      if (metadataGoalRuntime) next.set(session.id, metadataGoalRuntime);
    }
    for (const historyEventsBySessionId of [codexHistorySidebarEvents, rightChatHistoryEvents]) {
      for (const [sessionId, historyEvents] of Object.entries(historyEventsBySessionId)) {
        const historySession = sidebarSessionById.get(sessionId);
        const metadataGoalRuntime =
          historySession?.status === "active"
            ? activeGoalRuntimeFromSessionMetadata(historySession.metadata)
            : null;
        const historyGoalRuntime =
          latestGoalRuntimeFromEvents(historyEvents) ??
          (historySession?.status === "active"
            ? latestKnownActiveGoalRuntimeFromEvents(historyEvents) ?? metadataGoalRuntime
            : null);
        if (historyGoalRuntime) {
          next.set(sessionId, historyGoalRuntime);
        } else {
          next.delete(sessionId);
        }
      }
    }
    if (selectedSessionId) {
      if (goalRuntime) {
        next.set(selectedSessionId, goalRuntime);
      } else if (selectedSession?.status === "active" && codexHistoryEvents.length > 0) {
        const knownActiveGoalRuntime =
          latestKnownActiveGoalRuntimeFromEvents(codexHistoryEvents) ??
          activeGoalRuntimeFromSessionMetadata(selectedSession.metadata);
        if (knownActiveGoalRuntime) {
          next.set(selectedSessionId, knownActiveGoalRuntime);
        } else {
          next.delete(selectedSessionId);
        }
      } else if (!isCodexHistorySessionId(selectedSessionId) || codexHistoryEvents.length > 0) {
        next.delete(selectedSessionId);
      }
    }
    return next;
  }, [
    codexHistoryEvents.length,
    codexHistorySidebarEvents,
    goalRuntime,
    rightChatHistoryEvents,
    runtimeIndexes.latestGoalRuntimeBySessionId,
    selectedSession?.status,
    selectedSession?.metadata,
    selectedSessionId,
    sidebarSessionById,
    sidebarSessions,
  ]);
  const sidebarSubagentRuntimeBySessionId = useMemo(() => {
    const next = new Map(runtimeIndexes.latestSubagentRuntimeBySessionId);
    if (selectedSessionId) {
      if (subagentRuntime) {
        next.set(selectedSessionId, subagentRuntime);
      } else {
        next.delete(selectedSessionId);
      }
    }
    return next;
  }, [
    runtimeIndexes.latestSubagentRuntimeBySessionId,
    selectedSessionId,
    subagentRuntime,
  ]);
  const { runningSessionIds, selectedSessionRunning } = useRunningSessionState({
    goalRuntime,
    goalRuntimeBySessionId: sidebarGoalRuntimeBySessionId,
    runtimeIndexes,
    selectedSession,
    selectedSessionId,
    sidebarSessions,
    subagentRuntimeBySessionId: sidebarSubagentRuntimeBySessionId,
  });
  const selectedTurnCompletionState = useMemo(
    () => latestTurnCompletionState(sessionEvents),
    [sessionEvents],
  );
  const selectedSteerAutoDispatchReady =
    selectedTurnCompletionState === "completed" && !pendingApproval && !selectedSessionRunning;
  const selectedSteerAutoDispatchBlocked =
    Boolean(pendingApproval) || selectedTurnCompletionState === "blocked";
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
  const shouldLoadWorkspaceDiff = Boolean(
    viewWorkspaceAppId &&
      (view === "chat" || view === "profile") &&
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
  const [pendingWorkspaceTarget, setPendingWorkspaceTarget] = useState<"queue_cloud" | "hybrid" | null>(null);
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
  const openSessionInChat = useCallback((sessionId: string) => {
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
    openPondCommandAccessMode: activeOpenPondCommandAccessMode,
    draftModel,
    draftProvider,
    expandProject,
    prompt,
    apps: bootstrap?.apps ?? [],
    connectedAppMentions,
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
    workspaceTarget: workspaceTarget.value,
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
          selectedCloudProject?.id ?? selectedProject?.linkedSandboxProject?.projectId ?? null;
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
          selectedCloudProject?.id ?? selectedProject?.linkedSandboxProject?.projectId ?? selectedSession?.cloudProjectId ?? null;
        const linkedCloudTeamId =
          selectedCloudProject?.teamId ?? selectedProject?.linkedSandboxProject?.teamId ?? selectedSession?.cloudTeamId ?? null;
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
              selectedProject?.linkedSandboxProject?.projectName ??
              selectedProject?.name ??
              selectedSession.workspaceName ??
              "Hybrid workspace",
            localProjectId: selectedProject?.id ?? selectedSession.localProjectId ?? null,
            cloudProjectId: linkedCloudProjectId,
            cloudTeamId: linkedCloudTeamId,
            metadata: hybridWorkspaceSessionMetadata(selectedSession.metadata),
            cwd: selectedProject?.workspacePath ?? selectedSession.cwd ?? null,
          });
          setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
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
      selectedProject?.linkedSandboxProject?.projectId,
      selectedProject?.linkedSandboxProject?.projectName,
      selectedProject?.linkedSandboxProject?.teamId,
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
  }, [changeWorkspaceTarget, pendingSidebarWorkspaceTarget, selectedProjectId, selectedSessionId, view]);
  const sendPromptFromMainComposer = useCallback(
    async (
      attachments: ChatAttachment[] = [],
      action: SandboxActionCatalogEntry | null = null,
      promptOverride?: string,
      options: ComposerSubmitOptions = {},
    ) => {
      const promptForSubmission = promptOverride ?? prompt;
      const queuedSubmission = queuedCloudWorkSubmission({
        pendingWorkspaceTarget,
        actionSelected: Boolean(action),
        promptOverrideProvided: promptOverride !== undefined,
        attachmentCount: attachments.length,
        selectedCloudProjectId: selectedCloudProject?.id ?? null,
        selectedProjectCloudProjectId: selectedProject?.linkedSandboxProject?.projectId ?? null,
        selectedLocalProjectId: selectedProject?.id ?? null,
        selectedLocalProjectName: selectedProject?.name ?? null,
        selectedLocalWorkspacePath: selectedProject?.workspacePath ?? selectedProject?.path ?? null,
        selectedProjectCloudSourceRef:
          selectedProject?.linkedSandboxProject?.defaultBranch ??
          visibleWorkspaceState?.currentBranch ??
          null,
        selectedProjectCloudBaseSha: selectedProject?.linkedSandboxProject?.lastUploadedCommit ?? null,
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
      });
    },
    [
      createCloudWork,
      pendingWorkspaceTarget,
      prompt,
      selectedCloudProject?.id,
      selectedProject?.linkedSandboxProject?.projectId,
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
  const browserRevealSessionIds = useMemo(
    () => sessions.map((session) => session.id),
    [sessions],
  );
  useBrowserRevealRequests({
    browserConversationId,
    sessionIds: browserRevealSessionIds,
    onOpenSession: openSessionInChat,
    onShowBrowserPanel: showBrowserPanel,
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
        showRightPanelDiffTab("files");
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
      const panel = rightChatPanels.find((candidate) => candidate.id === panelId);
      if (panel) {
        setDraftProvider(panel.provider);
        setDraftModel(model);
      }
      setRightChatPanels((current) =>
        current.map((panel) => (panel.id === panelId ? { ...panel, model } : panel)),
      );
    },
    [rightChatPanels, setDraftModel, setDraftProvider, setRightChatPanels],
  );
  const updateRightChatProvider = useCallback(
    (panelId: string, provider: RightChatPanel["provider"]) => {
      const panel = rightChatPanels.find((candidate) => candidate.id === panelId);
      const model = normalizeChatModel(provider, panel?.model, bootstrap?.providers ?? null);
      if (panel) {
        setDraftProvider(provider);
        setDraftModel(model);
      }
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
    [bootstrap?.providers, rightChatPanels, setDraftModel, setDraftProvider, setRightChatPanels],
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
      const panelPendingApproval = latestPendingApprovalForSession(panelIndexes, panel.sessionId);
      const panelRunning = session ? runningSessionIds.has(session.id) : false;
      const panelTurnCompletionState = latestTurnCompletionState(panelEvents);
      const contextWindowStatusForPanel = contextWindowStatusFromUsage({
        provider,
        snapshot: latestContextUsageForSession(panelIndexes, panel.sessionId),
        preferences: appDefaults.contextCompaction,
      });
      const workspaceRootPath = session?.cwd ?? null;
      const activeWorkspaceAppIdForPanel =
        session?.appId ??
        (session?.workspaceKind === "local_project" ? session.workspaceId ?? null : null);
      const panelMessages = buildCachedChatMessages(panelEvents);
      return {
        ...panel,
        session,
        title: session?.title ?? "New chat",
        messages: appendPendingUserChatMessage(
          panelMessages,
          panel.sessionId ? pendingChatUserMessages[panel.sessionId] : null,
        ),
        contextWindowStatus: contextWindowStatusForPanel,
        goalRuntime: latestGoalRuntimeForSession(panelIndexes, panel.sessionId),
        pendingApproval: panelPendingApproval,
        running: panelRunning,
        steerAutoDispatchBlocked: Boolean(panelPendingApproval) || panelTurnCompletionState === "blocked",
        steerAutoDispatchReady:
          panelTurnCompletionState === "completed" && !panelPendingApproval && !panelRunning,
        workspaceRootPath,
        activeWorkspaceAppId: activeWorkspaceAppIdForPanel,
      };
    });
  }, [
    codexHistoryEvents,
    rightChatHistoryEvents,
    rightChatPanels,
    pendingChatUserMessages,
    runtimeIndexes,
    runningSessionIds,
    selectedSessionId,
    sidebarSessions,
    appDefaults.contextCompaction,
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
      const panelPromptForSubmit = options.promptOverride ?? panel.prompt;
      if (command?.id === "insights") {
        setView("insights");
        if (!options.preservePrompt) updateRightChatPrompt(panelId, "");
        const payload = await insights.runScan();
        const activeCount = payload?.summary.activeCount ?? insights.summary?.activeCount ?? 0;
        showToast(`${activeCount} active insight${activeCount === 1 ? "" : "s"}.`, "info");
        return true;
      }
      if (command && !panelPromptForSubmit.trim()) {
        showToast(`Add instructions after ${command.command}.`, "info");
        return false;
      }
      if (command && attachments.length > 0) {
        showToast(`${command.command} tasks do not accept attachments yet. Add file context in the task thread.`, "error");
        return false;
      }
      if (command?.id === "submit-issue" && !hasGitHubIssueSubmitConnection(connectedAppMentions)) {
        showToast("Connect the GitHub app before using /submit-issue.", "error");
        return false;
      }
      const session = panel.sessionId
        ? sidebarSessions.find((candidate) => candidate.id === panel.sessionId) ?? null
        : null;
      const panelOpenPondCommandAccessMode =
        session?.provider === "codex"
          ? openPondCommandAccessMode
          : session?.openPondCommandAccessMode ?? openPondCommandAccessMode;
      const promptForTurn = command ? promptForRightChatCommand(command, panelPromptForSubmit) : panelPromptForSubmit;
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
        openPondCommandAccessMode: panelOpenPondCommandAccessMode,
        chatMessages: buildCachedChatMessages(sessionEvents),
        displayPrompt: options.displayPrompt,
        usageAttribution: command?.id === "submit-issue"
          ? {
              surface: "chat",
              workflowKind: "slash_command",
              commandName: command.command,
              commandSource: "composer_selection",
            }
          : undefined,
        onCodexHistoryOptimisticEvent: appendRightCodexHistoryEvent,
        clearPrompt: options.preservePrompt ? () => undefined : () => updateRightChatPrompt(panelId, ""),
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
      connectedAppMentions,
      rightChatHistoryEvents,
      rightChatPanels,
      runtimeIndexes,
      selectedSessionId,
      insights.runScan,
      insights.summary?.activeCount,
      openPondCommandAccessMode,
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
  const diagnosticEvents = useMemo(
    () =>
      mergeRuntimeEventLists(
        bootstrap?.diagnostics ?? EMPTY_RUNTIME_EVENTS,
        events.filter((event) => event.name === "diagnostic"),
      ),
    [bootstrap?.diagnostics, events],
  );

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
  const viewTerminalScope: TerminalScope =
    profileWorkspaceId ? { kind: "project", id: profileWorkspaceId } : activeTerminalScope;
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
        workspaceName: viewWorkspaceName,
        workspaceId: viewWorkspaceId,
        busy,
        workspaceState: visibleWorkspaceState,
        workspaceKind: viewWorkspaceKind,
        selectedApp: profileWorkspaceId ? null : selectedProjectLinkedApp ?? selectedApp,
        selectedProject: profileWorkspaceId ? null : selectedProject,
        workspaceDiff: visibleWorkspaceDiff,
        managedWorkspace,
        workspaceBusy,
        defaultTeamId: appDefaults.defaultTeamId,
        showDiffControls: view === "chat" || view === "cloud" || Boolean(profileWorkspaceId),
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
        showWorkspaceControls: true,
        insightsItems: insights.items,
        insightsSummary: insights.summary,
        insightsScanning: insights.scanRunning,
      }}
      mainPane={{
        view,
        bootstrap,
        runtimeEvents: sessionEvents,
        chatMessages: visibleChatMessages,
        contextWindowStatus,
        goalRuntime,
        subagentRuntime,
        prompt,
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
        browserConversationId,
        terminalScope: viewTerminalScope,
        terminalTabs,
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
        resolveApproval,
        answerCreatePipelineQuestionTurn,
        approveCreatePipelineTurn,
        cancelCreatePipelineTurn,
        reviseCreatePipelineTurn,
        setPrompt,
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
