import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_PROVIDER,
  type Experience,
  OpenPondExtension,
  type OutputRef,
  type ProductArea,
  SidebarFileBookmark,
  TerminalScope,
} from "@openpond/contracts";
import { api } from "../api";
import {
  AppSettingsController,
  AppShellController,
} from "../components/app-shell/AppControllers";
import {
  isDesktopShell,
  isMacPlatform,
} from "../components/app-shell/WindowControls";
import { AppSplash } from "../components/splash/AppSplash";
import {
  mergeLiveRuntimeEventLists,
  oldestRuntimeEventSequence,
} from "../lib/runtime-event-lists";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { runtimeEventsForSession } from "../lib/runtime-indexes";
import type { AppPrimaryRuntime } from "./useAppPrimaryRuntime";
import type { AppSecondaryRuntime } from "./useAppSecondaryRuntime";
import {
  defaultModelForProvider,
  projectSelectionKey,
  providerOptionsFromSettings,
} from "../lib/app-models";
import type { SidebarFileOpenRequest } from "../lib/sidebar-files";
import type { SkillSourceDocument } from "../components/app-shell/skill-source-document";
import type { SkillPackageSourceSelection } from "../components/app-shell/skill-package-source";
import { extensionSourceSelection } from "../components/settings/extension-source-selection";
import { AppToastProvider } from "./AppToastContext";
import { composerSkillsForProfile } from "../lib/profile-selection";
import { buildExperienceHandoffMetadata } from "../lib/experience-handoff";
import {
  productAreaForAppView,
  readLastChatTaskModeFromBrowser,
} from "../lib/product-area";

interface AppRuntimeViewProps {
  primary: AppPrimaryRuntime;
  secondary: AppSecondaryRuntime;
}

export function AppRuntimeView({ primary, secondary }: AppRuntimeViewProps) {
  const {
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
    workspaceDiffPanelViewState,
    mainComposerFocusRequestId,
    requestMainComposerFocus,
    projectConfirmDialog,
    resolveProjectConfirmDialog,
    query,
    searchOpen,
    archivedChatsOpen,
    sectionMenuOpen,
    cloudProjectsExpanded,
    sidebarOpen,
    view,
    selectedAppId,
    selectedProjectId,
    selectedSessionId,
    codexPermissionMode,
    codexReasoningEffort,
    busy,
    diffPanelOpen,
    diffPanelExpanded,
    rightPanelMode,
    activeExperience,
    changeNewExperience,
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
    labDetailNavigation,
    setQuery,
    setSearchOpen,
    setArchivedChatsOpen,
    setSectionMenuOpen,
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
    setTerminalOpen,
    setSettingsSection,
    setNewProjectDialogOpen,
    setNewProjectName,
    setNewProjectPath,
    setCommitDialogOpen,
    setCommitMessage,
    setCommitIncludeUnstaged,
    setCommitNextStep,
    setCommitDraft,
    setBranchDialogOpen,
    setBranchDialogName,
    setError,
    showToast,
    applyBootstrapPayload,
    bootstrap,
    connection,
    startup,
    training,
    pinnedCollapsed,
    cloudProjectsCollapsed,
    chatsCollapsed,
    savedForLaterCollapsed,
    sidebarWidth,
    sidebarResizing,
    diffPanelWidth,
    diffPanelResizing,
    togglePinnedCollapsed,
    toggleCloudProjectsCollapsed,
    toggleChatsCollapsed,
    toggleSavedForLaterCollapsed,
    startSidebarResize,
    startDiffPanelResize,
    selectedApp,
    selectedProject,
    selectedProjectLinkedApp,
    selectedSession,
    sidebarSessions,
    runtimeIndexes,
    chatMentionApps,
    connectedAppMentions,
    pendingApproval,
    account,
    activeModel,
    activeProvider,
    appDefaults,
    startMessage,
    teamChatOrganization,
    teamChatTeamId,
    teamChat,
    publishTeamProfileAgent,
    communitySidebar,
    communityView,
    teamAiThreadId,
    toggleTeamAiSidebar,
    activeOpenPondCommandAccessMode,
    viewWorkspaceAppId,
    viewWorkspaceId,
    viewWorkspaceKind,
    viewWorkspaceName,
    selectedActionCatalog,
    expandedProjectIds,
    expandProject,
    toggleProjectExpanded,
    changeCodexPermissionMode,
    changeCodexReasoningEffort,
    changeOpenPondCommandAccessMode,
    resolveApproval,
    beginNewChat,
    beginNewChatWithTrainingModel,
    dismissTrainingChatHandoff,
    trainingChatHandoff,
    selectTrainingChatTaskForComposer,
    chatHistoryLoadStates,
    loadMoreSelectedChatHistory,
    selectedPagedSessionEvents,
    activeSessions,
    archivedSessions,
    pinnedSessions,
    savedForLaterSessions,
    savedForLaterFiles,
    sidebarFileBookmarks,
    setSidebarFileStatus,
    setSessions,
    projectRows,
    localProjectRows,
    cloudProjectRows,
    projectSessionRowsByProjectId,
    childSessionRowsByParentId,
    sidebarProjectIdBySessionId,
    chatRows,
    visibleChatRows,
    chatRowsVisibleCount,
    sessionEvents,
    goalRuntime,
    subagentRuntime,
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
    workspaceBusy,
    diffBusy,
    visibleWorkspaceState,
    visibleWorkspaceDiff,
    refreshVisibleWorkspaceDiff,
    managedWorkspace,
    canSyncActiveWorkspace,
    canPublishOpenPondProject,
    projectTarget,
    workspaceTarget,
  } = primary;
  const {
    title,
    browserConversationId,
    handleWorkspaceDiffPanelViewStateChange,
    openSessionInChat,
    changeProjectTarget,
    submitNewProjectDialog,
    changeWorkspaceBranch,
    openCommitDialog,
    openCreateWorkspaceBranchDialog,
    openDefaultsSettingsFromBranchDialog,
    runWorkspaceTool,
    submitCommitDialog,
    submitCreateWorkspaceBranch,
    syncWorkspaceLocally,
    answerCreateImproveQuestion,
    applyCreateImproveCandidate,
    approveCreateImproveRun,
    cancelCreateImproveRun,
    changeDraftProvider,
    openCreateImprovePullRequest,
    reconcileCreateImprovePullRequest,
    rejectCreateImproveCandidate,
    pauseCreateImproveRun,
    resumeCreateImproveRun,
    reviseCreateImproveRun,
    stopTurn,
    archiveSession,
    restoreSession,
    renameSession,
    toggleSessionPinned,
    toggleSessionSavedForLater,
    startCloudSetupUpload,
    changeWorkspaceTarget,
    sendPromptFromMainComposer,
    openSandboxWorkspace,
    openUrlInBrowserPanel,
    showBrowserPanel,
    showChangesPanel,
    showGoalSidebarTab,
    rightChatTrainingLaunchRequest,
    setRightChatTrainingLaunchRequest,
    closeRightChatPanel,
    openRightChatPanel,
    rightChatPanelViews,
    showRightChatPanel,
    showRightPanelDiffTab,
    submitRightChatPrompt,
    activateRightChatPanel,
    updateRightChatModel,
    updateRightChatPrompt,
    updateRightChatProvider,
    updateRightChatScrollState,
    openProfileSettings,
    diagnosticEvents,
    toggleRightSidebar,
  } = secondary;
  const [nativeSkillSidebar, setNativeSkillSidebar] =
    useState<SkillSourceDocument | null>(null);
  const [extensionSkillSidebar, setExtensionSkillSidebar] =
    useState<SkillPackageSourceSelection | null>(null);
  const harnessSkills = composerSkillsForProfile(
    bootstrap?.profile,
    bootstrap?.extensionCatalog
  );
  const [pendingNativeSkillSidebar, setPendingNativeSkillSidebar] =
    useState<SkillSourceDocument | null>(null);
  const [pendingExtensionSkillSidebar, setPendingExtensionSkillSidebar] =
    useState<SkillPackageSourceSelection | null>(null);
  const [sidebarFileOpenRequest, setSidebarFileOpenRequest] =
    useState<SidebarFileOpenRequest | null>(null);
  const handoffExperience = useCallback(
    async (input: {
      target: Experience;
      sourceSessionId: string;
      sourceMessageIds?: string[];
      sourceContext?: string;
      output?: OutputRef;
      prompt: string;
    }) => {
      if (!connection) throw new Error("OpenPond is not connected.");
      let provider = activeProvider;
      let model = activeModel;
      if (provider === "codex") {
        provider =
          providerOptionsFromSettings(bootstrap?.providers, {
            enabledOnly: true,
          }).find((option) => option.value !== "codex")?.value ??
          DEFAULT_CHAT_PROVIDER;
        model =
          defaultModelForProvider(provider, bootstrap?.providers) ??
          DEFAULT_CHAT_MODEL;
      }
      const sourceSession = sidebarSessions.find(
        (session) => session.id === input.sourceSessionId
      );
      const session = await api.createSession(connection, {
        experience: input.target,
        provider,
        modelRef: { providerId: provider, modelId: model },
        openPondCommandAccessMode: activeOpenPondCommandAccessMode,
        appId: null,
        appName: null,
        workspaceId: null,
        workspaceName: null,
        localProjectId: null,
        cloudProjectId: null,
        cloudTeamId: null,
        cwd: null,
        title: `Continue ${sourceSession?.title ?? "task"}`.slice(0, 120),
        metadata: {
          experienceHandoff: buildExperienceHandoffMetadata({
            sourceTaskId: input.sourceSessionId,
            sourceExperience: sourceSession?.experience ?? null,
            targetExperience: input.target,
            sourceMessageIds: input.sourceMessageIds ?? [],
            sourceContext: input.sourceContext,
            output: input.output,
          }),
        },
      });
      setSessions((current) => [session, ...current]);
      setDraftExperience(input.target);
      setDraftProvider(provider);
      setDraftModel(model);
      composerDraftStore.set(input.prompt);
      appDispatch({
        type: "selectSession",
        sessionId: session.id,
        appId: null,
        projectId: null,
      });
      setSelectedAppId(null);
      setSelectedProjectId(null);
      setTerminalOpen(false);
      setView("chat");
      setRightPanelMode("home");
      setDiffPanelOpen(input.target === "work");
      setDiffPanelExpanded(false);
      return session;
    },
    [
      activeModel,
      activeOpenPondCommandAccessMode,
      activeProvider,
      appDispatch,
      bootstrap?.providers,
      composerDraftStore,
      connection,
      setDiffPanelExpanded,
      setDiffPanelOpen,
      setDraftExperience,
      setDraftModel,
      setDraftProvider,
      setRightPanelMode,
      setSelectedAppId,
      setSelectedProjectId,
      setSessions,
      setTerminalOpen,
      setView,
      sidebarSessions,
    ]
  );
  const openSkillFromSettings = useCallback(
    (skill: SkillSourceDocument) => {
      setPendingNativeSkillSidebar(skill);
      setPendingExtensionSkillSidebar(null);
      beginNewChat(null);
      setSidebarOpen(true);
    },
    [beginNewChat, setSidebarOpen]
  );
  const openExtensionFromSettings = useCallback(
    (extension: OpenPondExtension) => {
      setPendingExtensionSkillSidebar(extensionSourceSelection(extension));
      setPendingNativeSkillSidebar(null);
      beginNewChat(null);
      setSidebarOpen(true);
    },
    [beginNewChat, setSidebarOpen]
  );
  useEffect(() => {
    if (
      (!pendingNativeSkillSidebar && !pendingExtensionSkillSidebar) ||
      view !== "chat" ||
      selectedSessionId ||
      selectedProjectId ||
      selectedAppId
    )
      return;
    setNativeSkillSidebar(pendingNativeSkillSidebar);
    setExtensionSkillSidebar(pendingExtensionSkillSidebar);
    setPendingNativeSkillSidebar(null);
    setPendingExtensionSkillSidebar(null);
    setRightPanelMode("home");
    setDiffPanelExpanded(false);
    setDiffPanelOpen(true);
  }, [
    pendingNativeSkillSidebar,
    pendingExtensionSkillSidebar,
    selectedAppId,
    selectedProjectId,
    selectedSessionId,
    setDiffPanelExpanded,
    setDiffPanelOpen,
    setRightPanelMode,
    view,
  ]);
  useEffect(() => {
    if (!nativeSkillSidebar && !extensionSkillSidebar) return;
    if (view === "chat" && diffPanelOpen && rightPanelMode === "home") return;
    setNativeSkillSidebar(null);
    setExtensionSkillSidebar(null);
  }, [
    diffPanelOpen,
    extensionSkillSidebar,
    nativeSkillSidebar,
    rightPanelMode,
    view,
  ]);
  const closeNativeSkillSidebar = useCallback(() => {
    setNativeSkillSidebar(null);
    setExtensionSkillSidebar(null);
    setDiffPanelExpanded(false);
    setDiffPanelOpen(false);
  }, [setDiffPanelExpanded, setDiffPanelOpen]);
  const openSidebarFile = useCallback(
    (file: SidebarFileBookmark) => {
      if (file.workspaceKind === "local") {
        const projectId = projectSelectionKey("local", file.workspaceId);
        setSelectedAppId(null);
        setSelectedProjectId(projectId);
        setSelectedSessionId(null);
        expandProject(projectId);
        setView("chat");
      } else {
        const sourceSession = sidebarSessions.find(
          (session) =>
            session.id === file.sourceSessionId ||
            session.workspaceId === file.workspaceId
        );
        if (!sourceSession) {
          showToast(
            "This saved file's cloud chat is no longer available.",
            "error"
          );
          return;
        }
        openSessionInChat(sourceSession.id);
      }
      setRightPanelMode("changes");
      setDiffPanelOpen(true);
      setSidebarFileOpenRequest({ id: Date.now(), file });
      if (!file.available) showToast(`File unavailable: ${file.path}`, "error");
    },
    [
      expandProject,
      openSessionInChat,
      setDiffPanelOpen,
      setRightPanelMode,
      setSelectedAppId,
      setSelectedProjectId,
      setSelectedSessionId,
      setView,
      showToast,
      sidebarSessions,
    ]
  );
  useEffect(() => {
    if (!sidebarFileOpenRequest) return;
    const timer = window.setTimeout(() => {
      setRightPanelMode("changes");
      setDiffPanelOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    selectedProjectId,
    selectedSessionId,
    setDiffPanelOpen,
    setRightPanelMode,
    sidebarFileOpenRequest,
  ]);
  const productArea = productAreaForAppView(view, activeExperience);
  const changeProductArea = useCallback(
    (nextProductArea: ProductArea) => {
      setSectionMenuOpen(null);
      setSelectedAppId(null);
      setSelectedProjectId(null);
      setSelectedSessionId(null);
      if (nextProductArea === "models") {
        setView("labs");
        return;
      }
      changeNewExperience(readLastChatTaskModeFromBrowser());
    },
    [
      changeNewExperience,
      setSectionMenuOpen,
      setSelectedAppId,
      setSelectedProjectId,
      setSelectedSessionId,
      setView,
    ]
  );
  if (!startup.ready) {
    return <AppSplash startup={startup} />;
  }

  if (view === "settings") {
    return (
      <AppToastProvider showToast={showToast}>
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
            onOpenSkill: openSkillFromSettings,
            onOpenExtension: openExtensionFromSettings,
            teamChatCurrentUserId: teamChat.currentUserId,
            teamChatEnabled: teamChatTeamId !== null,
            teamChatNotificationMode: teamChat.notificationMode,
            teamChatThreads: teamChat.threads,
            onTeamChatNotificationModeChange: teamChat.setNotificationMode,
            onTeamChatThreadMuteChange: teamChat.setThreadMuted,
            diffPanelWidth,
            diffPanelResizing,
            diffPanelExpanded,
            onDiffPanelResizeStart: startDiffPanelResize,
            onDiffPanelExpandedChange: setDiffPanelExpanded,
            onBack: () => {
              setView("chat");
              setSidebarOpen(true);
            },
          }}
          toast={{
            toast,
            onDismiss: () =>
              appDispatch({ type: "field", key: "toast", value: null }),
          }}
        />
      </AppToastProvider>
    );
  }

  const desktopShell = isDesktopShell();
  const platform = connection?.platform ?? navigator.platform;
  const isMac = desktopShell && isMacPlatform(platform);
  const viewTerminalScope: TerminalScope = activeTerminalScope;
  const terminalCwd = visibleWorkspaceState?.initialized
    ? visibleWorkspaceState.repoPath
    : selectedSession?.cwd ?? null;
  const appShellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--diff-panel-width": `${diffPanelWidth}px`,
  } as CSSProperties;
  const rightSidebarAvailableForView =
    (view === "chat" && activeExperience !== "chat") ||
    view === "labs" ||
    (view === "team" && Boolean(teamAiThreadId));
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
    ? selectedChatHistoryLoadState?.cursorSequence ??
      oldestRuntimeEventSequence(
        mergeLiveRuntimeEventLists(
          selectedPagedSessionEvents,
          runtimeEventsForSession(runtimeIndexes, selectedSessionId)
        )
      )
    : null;
  const selectedChatHistoryCanPage =
    Boolean(selectedSessionId) &&
    Boolean(connection) &&
    (isCodexHistorySessionId(selectedSessionId)
      ? true
      : Boolean(bootstrap?.eventWindow?.hasMoreBefore) &&
        Boolean(selectedChatHistoryCursor));
  const selectedChatHistoryHasMore =
    selectedChatHistoryCanPage &&
    (selectedChatHistoryLoadState?.hasMore ?? true);
  const selectedChatHistoryLoading = Boolean(
    selectedChatHistoryLoadState?.loading
  );

  return (
    <AppToastProvider showToast={showToast}>
      <AppShellController
        className={appShellClassName}
        style={appShellStyle}
        sidebar={{
          productArea,
          onProductAreaChange: changeProductArea,
          experience: activeExperience,
          view,
          selectedAppId,
          selectedProjectId,
          selectedSessionId,
          selectedTeamThreadId: teamChat.selectedThreadId,
          teamChatEnabled: teamChatTeamId !== null,
          teamChatOrganization,
          teamChatLoading: teamChat.loading,
          currentUserId: teamChat.currentUserId,
          teamMembers: teamChat.members,
          teamThreads: teamChat.threads,
          ...communitySidebar,
          account,
          connection,
          profile: bootstrap?.profile,
          pinnedCollapsed,
          cloudProjectsCollapsed,
          chatsCollapsed,
          savedForLaterCollapsed,
          archivedChatsOpen,
          cloudProjectsExpanded,
          sectionMenuOpen,
          dragItem,
          taskDragSessionId,
          taskPreviewSessionIds,
          activeSessions,
          archivedSessions,
          pinnedRows,
          pinnedSessions,
          savedForLaterSessions,
          savedForLaterFiles,
          projectRows,
          localProjectRows,
          cloudProjectRows,
          projectSessionRowsByProjectId,
          childSessionRowsByParentId,
          sidebarProjectIdBySessionId,
          terminalSummaries,
          runningSessionIds,
          goalRuntimeBySessionId: sidebarGoalRuntimeBySessionId,
          subagentRuntimeBySessionId: sidebarSubagentRuntimeBySessionId,
          visibleChatRows,
          chatRows,
          chatRowsVisibleCount,
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
          onToggleCloudProjectsCollapsed: toggleCloudProjectsCollapsed,
          onToggleChatsCollapsed: toggleChatsCollapsed,
          onToggleSavedForLaterCollapsed: toggleSavedForLaterCollapsed,
          setArchivedChatsOpen,
          setCloudProjectsExpanded,
          setChatRowsVisibleCount,
          beginNewChat,
          dockSessionRight: openRightChatPanel,
          selectTeamThread: (threadId) => {
            setView("team");
            void teamChat.selectThread(threadId);
          },
          openTeamDm: (userId) => {
            setView("team");
            void teamChat.openDm(userId);
          },
          toggleSessionPinned,
          toggleSessionSavedForLater,
          openSidebarFile,
          setSidebarFileStatus: (file, status) =>
            void setSidebarFileStatus(file, status),
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
          startTaskDrag,
          clearTaskDrag,
          previewTaskDrop,
          commitTaskDrop,
          commitTaskPreviewDrop,
        }}
        topBar={{
          sidebarOpen,
          title,
          backAction: labDetailNavigation.backAction,
          breadcrumbs: labDetailNavigation.breadcrumbs,
          conversationId: view === "chat" ? selectedSessionId : null,
          workspaceName: viewWorkspaceName,
          workspaceId: viewWorkspaceId,
          busy,
          workspaceState: visibleWorkspaceState,
          workspaceKind: viewWorkspaceKind,
          selectedApp: selectedProjectLinkedApp ?? selectedApp,
          selectedProject,
          workspaceDiff: visibleWorkspaceDiff,
          managedWorkspace,
          workspaceBusy,
          defaultTeamId: appDefaults.defaultTeamId,
          showDiffControls:
            view === "chat" && activeExperience === "development",
          diffPanelOpen,
          terminalOpen,
          rightSidebarAvailable: rightSidebarAvailableForView,
          rightSidebarOpen: diffPanelOpen,
          onToggleDiffPanel: toggleRightSidebar,
          onToggleRightSidebar:
            view === "team" && Boolean(teamAiThreadId)
              ? toggleTeamAiSidebar
              : toggleRightSidebar,
          onOpenSearch: () => {
            setSectionMenuOpen(null);
            setSearchOpen(true);
          },
          onToggleTerminal: () => setTerminalOpen((open) => !open),
          onRunTerminalCommand: (command) => {
            setPendingTerminalCommand({
              id: Date.now(),
              scope: viewTerminalScope,
              command,
            });
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
          showWorkspaceControls:
            view !== "team" &&
            view !== "community" &&
            view !== "labs" &&
            view !== "scheduled" &&
            view !== "outputs" &&
            (
              activeExperience === "development" ||
              (
                activeExperience === "work" &&
                Boolean(
                  selectedProject ||
                  selectedSession?.localProjectId ||
                  selectedSession?.cloudProjectId ||
                  selectedSession?.workspaceKind === "local_project"
                )
              )
            ),
        }}
        mainPane={{
          experience: activeExperience,
          onNewExperienceChange: changeNewExperience,
          view,
          teamChat: {
            currentUserId: teamChat.currentUserId,
            members: teamChat.members,
            agents: teamChat.agents,
            profile: bootstrap?.profile ?? null,
            teamId: teamChatTeamId,
            teamName: teamChatOrganization?.displayName ?? null,
            detail: teamChat.detail,
            aiThread: teamChat.aiThread,
            agentConversation: teamChat.agentConversation,
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
            onPublishProfileAgent: publishTeamProfileAgent,
            onOpenAiThread: async (conversationId) => {
              await teamChat.openAiThread(conversationId);
              setRightPanelMode("chat");
              setDiffPanelOpen(true);
            },
            onOpenAgentConversation: async (agentRunId) => {
              await teamChat.openAgentConversation(agentRunId);
              setRightPanelMode("chat");
              setDiffPanelOpen(true);
            },
            onCloseAiThread: () => setDiffPanelOpen(false),
            onCloseAgentConversation: () => {
              teamChat.closeAgentConversation();
              setDiffPanelOpen(false);
            },
            onSendAgentTurn: teamChat.sendAgentTurn,
            onSendAiTurn: teamChat.sendAiTurn,
            onStopAiTurn: teamChat.stopAiTurn,
            onEditMessage: teamChat.editMessage,
            onDeleteMessage: teamChat.deleteMessage,
            onRetryMessage: teamChat.retryMessage,
            onDismissFailedMessage: teamChat.dismissFailedMessage,
            onLoadMoreMessages: teamChat.loadMoreMessages,
            onRetryLoad: teamChat.refresh,
          },
          community: communityView,
          bootstrap,
          runtimeEvents: sessionEvents,
          chatMessages: visibleChatMessages,
          contextWindowStatus,
          goalRuntime,
          subagentRuntime,
          selectedSessionId,
          composerDraftStore,
          mainComposerFocusRequestId,
          onRequestComposerFocus: requestMainComposerFocus,
          labCloseDetailRequestId: labDetailNavigation.closeDetailRequestId,
          labCloseDetailKind: labDetailNavigation.closeDetailKind,
          sideChatTrainingLaunchRequest: rightChatTrainingLaunchRequest,
          onSideChatTrainingLaunchHandled: (id) =>
            setRightChatTrainingLaunchRequest((current) =>
              current?.id === id ? null : current
            ),
          steerAutoDispatchBlocked: selectedSteerAutoDispatchBlocked,
          steerAutoDispatchReady: selectedSteerAutoDispatchReady,
          mentionApps: chatMentionApps,
          connectedAppMentions,
          profileSkills: harnessSkills,
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
          nativeSkillSidebar,
          extensionSkillSidebar,
          workspaceDiffPanelViewState,
          sidebarFileOpenRequest,
          sidebarFileBookmarks,
          onSetSidebarFileStatus: (file, status) =>
            void setSidebarFileStatus(file, status),
          browserConversationId,
          terminalScope: viewTerminalScope,
          terminalTabs,
          terminalCwd,
          pendingTerminalCommand,
          terminalOpen,
          onToggleTerminal: () => setTerminalOpen((open) => !open),
          onWorkspaceDiffPanelViewStateChange:
            handleWorkspaceDiffPanelViewStateChange,
          training,
          trainingSessions: sidebarSessions,
          trainingChatHandoff,
          trainingDetailTasksetId,
          onTrainingDetailTasksetIdChange: setTrainingDetailTasksetId,
          onTrainingChatTaskSelect: selectTrainingChatTaskForComposer,
          onTrainingChatHandoffDismiss: dismissTrainingChatHandoff,
          onOpenSession: openSessionInChat,
          onExperienceHandoff: handoffExperience,
          cloudProjects: bootstrap?.cloudProjects ?? [],
          chatHistoryHasMore: selectedChatHistoryHasMore,
          chatHistoryLoading: selectedChatHistoryLoading,
          onDiffPanelResizeStart: startDiffPanelResize,
          onToggleDiffPanelExpanded: () =>
            setDiffPanelExpanded((expanded) => !expanded),
          onShowDiffPanel: showChangesPanel,
          onShowBrowserPanel: showBrowserPanel,
          onShowFilesPanel: () => showRightPanelDiffTab("files"),
          onShowGoalSidebarTab: showGoalSidebarTab,
          onShowTrainingDraftPanel: () => {
            setRightPanelMode("training");
            setDiffPanelOpen(true);
          },
          onShowRightChatPanel: showRightChatPanel,
          onAddRightChat: () => openRightChatPanel(null),
          onOpenRightChatForSession: (sessionId, providedSession) => {
            const session =
              providedSession ??
              sidebarSessions.find((candidate) => candidate.id === sessionId) ??
              null;
            if (session) openRightChatPanel(session, { preserveView: true });
          },
          onLabDetailOpenChange: labDetailNavigation.onDetailOpenChange,
          onTerminalTabsChange: setTerminalTabs,
          onCloseRightChatPanel: closeRightChatPanel,
          onCloseNativeSkillSidebar: closeNativeSkillSidebar,
          onActivateRightChatPanel: activateRightChatPanel,
          onRightChatModelChange: updateRightChatModel,
          onRightChatPromptChange: updateRightChatPrompt,
          onRightChatScrollStateChange: updateRightChatScrollState,
          onRightChatProviderChange: updateRightChatProvider,
          onSubmitRightChat: submitRightChatPrompt,
          onStopRightChat: (sessionId) => stopTurn(sessionId),
          onCloseTerminal: () => setTerminalOpen(false),
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
          onOpenComputeSettings: () => {
            setSettingsSection("compute");
            setView("settings");
          },
          onOpenDatasetStorageSettings: () => {
            setSettingsSection("dataset-storage");
            setView("settings");
          },
          changeDraftProvider,
          changeProjectTarget,
          changeWorkspaceTarget,
          setDraftProvider,
          setDraftModel,
          onBeginNewChatWithModel: beginNewChatWithTrainingModel,
          changeCodexPermissionMode,
          changeCodexReasoningEffort,
          changeOpenPondCommandAccessMode,
          resolveApproval,
          answerCreateImproveQuestion,
          applyCreateImproveCandidate,
          approveCreateImproveRun,
          cancelCreateImproveRun,
          openCreateImprovePullRequest,
          reconcileCreateImprovePullRequest,
          rejectCreateImproveCandidate,
          pauseCreateImproveRun,
          resumeCreateImproveRun,
          reviseCreateImproveRun,
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
          onDismiss: () =>
            appDispatch({ type: "field", key: "toast", value: null }),
        }}
      />
    </AppToastProvider>
  );
}
