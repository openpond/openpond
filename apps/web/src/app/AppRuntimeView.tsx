import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ConnectedAppIntegrationSkill, TerminalScope } from "@openpond/contracts";
import { AppSettingsController, AppShellController } from "../components/app-shell/AppControllers";
import { isDesktopShell, isMacPlatform } from "../components/app-shell/WindowControls";
import { AppSplash } from "../components/splash/AppSplash";
import { mergeLiveRuntimeEventLists, oldestRuntimeEventSequence } from "../lib/runtime-event-lists";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { runtimeEventsForSession } from "../lib/runtime-indexes";
import type { AppPrimaryRuntime } from "./useAppPrimaryRuntime";
import type { AppSecondaryRuntime } from "./useAppSecondaryRuntime";
import { AppToastProvider } from "./AppToastContext";
import {
  POST_TRAINING_LESSONS,
  type PostTrainingCourseState,
} from "../components/get-started/post-training-lessons";
import {
  getPostTrainingProgress,
  startingPostTrainingLessonIndex,
} from "../components/get-started/post-training-progress";
import type { MakeAgentTutorialState } from "../components/get-started/make-agent-tutorial";

interface AppRuntimeViewProps {
  primary: AppPrimaryRuntime;
  secondary: AppSecondaryRuntime;
}

export function AppRuntimeView({ primary, secondary }: AppRuntimeViewProps) {
  const {
    composerDraftStore, appDispatch, pendingTerminalCommand, setPendingTerminalCommand, terminalTabs, setTerminalTabs,
    trainingDetailTasksetId, setTrainingDetailTasksetId, mentionedAppId, setMentionedAppId, cloudSetupDialog, setCloudSetupDialog,
    rightPanelTabRequest, workspaceDiffPanelViewState, mainComposerFocusRequestId, labSuggestionsRequestId, projectConfirmDialog, resolveProjectConfirmDialog,
    query, searchOpen, archivedChatsOpen, sectionMenuOpen, projectsExpanded, cloudProjectsExpanded,
    sidebarOpen, view, selectedAppId, selectedProjectId, selectedSessionId, codexPermissionMode,
    codexReasoningEffort, busy, diffPanelOpen, diffPanelExpanded, rightPanelMode,
    terminalOpen, settingsSection, newProjectDialogOpen, newProjectMode, newProjectName,
    newProjectPath, newProjectBusy, commitDialogOpen, commitMessage, commitIncludeUnstaged, commitNextStep,
    commitDraft, branchDialogOpen, branchDialogName, toast, labDetailNavigation,
    setQuery, setSearchOpen, setArchivedChatsOpen, setSectionMenuOpen, setProjectsExpanded, setCloudProjectsExpanded,
    setChatRowsVisibleCount, setSidebarOpen, setView, setSelectedAppId, setSelectedProjectId, setSelectedSessionId,
    setPrompt, setDraftProvider, setDraftModel, setDiffPanelOpen, setDiffPanelExpanded, setRightPanelMode,
    setTerminalOpen, setSettingsSection, setNewProjectDialogOpen, setNewProjectMode, setNewProjectName, setNewProjectPath,
    setCommitDialogOpen, setCommitMessage, setCommitIncludeUnstaged, setCommitNextStep, setCommitDraft, setBranchDialogOpen,
    setBranchDialogName, setError, showToast, applyBootstrapPayload, bootstrap, connection,
    startup, insights, training, pinnedCollapsed, projectsCollapsed, cloudProjectsCollapsed,
    chatsCollapsed, sidebarWidth, sidebarResizing, diffPanelWidth, diffPanelResizing, togglePinnedCollapsed,
    toggleProjectsCollapsed, toggleCloudProjectsCollapsed, toggleChatsCollapsed, startSidebarResize, startDiffPanelResize, selectedApp,
    selectedProject, selectedProjectLinkedApp, selectedSession, sidebarSessions, runtimeIndexes, chatMentionApps,
    connectedAppMentions, pendingApproval, account, activeModel, activeProvider,
    appDefaults, startMessage, teamChatOrganization,
    teamChatTeamId, teamChat, publishTeamProfileAgent, communitySidebar, communityView, teamAiThreadId,
    toggleTeamAiSidebar, activeOpenPondCommandAccessMode, profileWorkspaceId, viewWorkspaceAppId, viewWorkspaceId, viewWorkspaceKind,
    viewWorkspaceName, selectedActionCatalog, expandedProjectIds, expandProject, toggleProjectExpanded, cloudBusy,
    cloudError, cloudLoading, cloudWorkItemDetail, cloudWorkItems, selectedCloudWorkItem, selectedCloudWorkItemId,
    selectedCloudWorkItemLocalProject, applyCloudWorkItemPatchLocally, cancelCloudWorkItemCreatePipeline, cancelCloudWorkItemTask, createCloudWork, handleCloudWorkItemBackground,
    openCloudHome, selectCloudWorkItem, sendCloudWorkItemMessage, changeCodexPermissionMode, changeCodexReasoningEffort, changeOpenPondCommandAccessMode,
    resolveApproval, beginNewChat, beginNewChatWithTrainingModel, dismissTrainingChatHandoff, trainingChatHandoff, selectTrainingChatTaskForComposer,
    chatHistoryLoadStates, loadMoreSelectedChatHistory, selectedPagedSessionEvents, activeSessions, pinnedSessions, projectRows,
    localProjectRows, visibleProjectRows, cloudProjectRows, cloudWorkItemsByProjectId, projectSessionRowsByProjectId, childSessionRowsByParentId,
    sidebarProjectIdBySessionId, chatRows, visibleChatRows, sessionEvents, goalRuntime,
    subagentRuntime, visibleChatMessages, activeTerminalScope, terminalSummaries, runningSessionIds, selectedSessionRunning,
    selectedSteerAutoDispatchBlocked, selectedSteerAutoDispatchReady, sidebarGoalRuntimeBySessionId, sidebarSubagentRuntimeBySessionId, dragItem, startPinnedDrag,
    clearSidebarDrag, previewPinnedDrop, commitPinnedDrop, commitPinnedPreviewDrop, commandProjectRows, contextWindowStatus,
    pinnedRows, workspaceStates, workspaceBusy, diffBusy, visibleWorkspaceState, visibleWorkspaceDiff,
    refreshVisibleWorkspaceDiff, managedWorkspace, canSyncActiveWorkspace, canPublishOpenPondProject, projectTarget,
    workspaceTarget,
  } = primary;
  const {
    title, browserConversationId, handleWorkspaceDiffPanelViewStateChange, openSessionInChat, insightsSystemProjectHidden,
    toggleInsightsSystemProjectVisibility, toggleSystemProjectVisibility, openExistingProjectPathDialog, addProjectFolder, removeProject,
    changeProjectTarget, submitNewProjectDialog, changeWorkspaceBranch, openCommitDialog, openCreateWorkspaceBranchDialog,
    openDefaultsSettingsFromBranchDialog, runWorkspaceTool, submitCommitDialog, submitCreateWorkspaceBranch, syncWorkspaceLocally,
    subagentDelegationDefaultMode, subagentDelegationMode, subagentDelegationAvailable, changeSubagentDelegationMode, answerCreateImproveQuestion,
    applyCreateImproveCandidate, approveCreateImproveRun, cancelCreateImproveRun, changeDraftProvider, openCreateImprovePullRequest,
    reconcileCreateImprovePullRequest, rejectCreateImproveCandidate, pauseCreateImproveRun, resumeCreateImproveRun, reviseCreateImproveRun,
    pauseGoal, stopTurn, archiveSession, restoreSession, renameSession,
    toggleProjectPinned, toggleSessionPinned, moveProjectToCloud, startCloudSetupUpload, changeWorkspaceTarget,
    switchProjectWorkspaceTarget, sendPromptFromMainComposer, openSandboxWorkspace, createCloudEnvironmentFromSidebar, openCloudProjectDialog,
    openUrlInBrowserPanel, showBrowserPanel, showChangesPanel, showGoalSidebarTab, setupCloudProjectFromCloudView,
    openLabSuggestions, rightChatTrainingLaunchRequest, setRightChatTrainingLaunchRequest,
    closeRightChatPanel, openRightChatPanel, rightChatPanelViews, showRightChatPanel,
    showRightPanelDiffTab, submitRightChatPrompt, activateRightChatPanel,
    updateRightChatModel, updateRightChatPrompt, updateRightChatProvider, updateRightChatScrollState,
    openProfileSettings, diagnosticEvents, toggleRightSidebar,
  } = secondary;
  const [nativeSkillSidebar, setNativeSkillSidebar] = useState<ConnectedAppIntegrationSkill | null>(null);
  const [pendingNativeSkillSidebar, setPendingNativeSkillSidebar] = useState<ConnectedAppIntegrationSkill | null>(null);
  const [postTrainingCourse, setPostTrainingCourse] = useState<PostTrainingCourseState | null>(null);
  const [makeAgentTutorial, setMakeAgentTutorial] = useState<MakeAgentTutorialState | null>(null);
  const preCourseSidebarOpenRef = useRef<boolean | null>(null);
  const openPostTrainingCourse = useCallback(() => {
    if (preCourseSidebarOpenRef.current === null) {
      preCourseSidebarOpenRef.current = diffPanelOpen;
    }
    setPostTrainingCourse({
      autoplay: true,
      lessonIndex: startingPostTrainingLessonIndex(
        getPostTrainingProgress(),
        POST_TRAINING_LESSONS.map((lesson) => lesson.id),
      ),
      panelView: "lessons",
      playRequestId: 0,
      scriptLessonIndex: null,
    });
    setMakeAgentTutorial(null);
    setDiffPanelOpen(true);
  }, [diffPanelOpen, setDiffPanelOpen]);
  const closePostTrainingCourse = useCallback(() => {
    const previousSidebarOpen = preCourseSidebarOpenRef.current;
    preCourseSidebarOpenRef.current = null;
    setPostTrainingCourse(null);
    if (previousSidebarOpen !== null) setDiffPanelOpen(previousSidebarOpen);
  }, [setDiffPanelOpen]);
  const selectPostTrainingLesson = useCallback((lessonIndex: number) => {
    setPostTrainingCourse((current) => current
      ? {
          ...current,
          lessonIndex,
          playRequestId: current.playRequestId + 1,
        }
      : current);
  }, []);
  const setPostTrainingAutoplay = useCallback((autoplay: boolean) => {
    setPostTrainingCourse((current) => current ? { ...current, autoplay } : current);
  }, []);
  const openPostTrainingScript = useCallback((lessonIndex: number) => {
    setPostTrainingCourse((current) => current
      ? { ...current, panelView: "script", scriptLessonIndex: lessonIndex }
      : current);
  }, []);
  const showPostTrainingLessons = useCallback(() => {
    setPostTrainingCourse((current) => current ? { ...current, panelView: "lessons" } : current);
  }, []);
  const openMakeAgentTutorial = useCallback(() => {
    if (preCourseSidebarOpenRef.current === null) {
      preCourseSidebarOpenRef.current = diffPanelOpen;
    }
    setPostTrainingCourse(null);
    setMakeAgentTutorial({ panelView: "steps" });
    setDiffPanelOpen(true);
  }, [diffPanelOpen, setDiffPanelOpen]);
  const closeMakeAgentTutorial = useCallback(() => {
    const previousSidebarOpen = preCourseSidebarOpenRef.current;
    preCourseSidebarOpenRef.current = null;
    setMakeAgentTutorial(null);
    if (previousSidebarOpen !== null) setDiffPanelOpen(previousSidebarOpen);
  }, [setDiffPanelOpen]);
  const showMakeAgentTutorialSteps = useCallback(() => {
    setMakeAgentTutorial((current) => current ? { ...current, panelView: "steps" } : current);
  }, []);
  const showMakeAgentTutorialScript = useCallback(() => {
    setMakeAgentTutorial((current) => current ? { ...current, panelView: "script" } : current);
  }, []);
  useEffect(() => {
    if (view === "get-started") return;
    if (postTrainingCourse) closePostTrainingCourse();
    else if (makeAgentTutorial) closeMakeAgentTutorial();
  }, [closeMakeAgentTutorial, closePostTrainingCourse, makeAgentTutorial, postTrainingCourse, view]);
  const openNativeSkillFromSettings = useCallback((skill: ConnectedAppIntegrationSkill) => {
    setPendingNativeSkillSidebar(skill);
    beginNewChat(null);
    setSidebarOpen(true);
  }, [beginNewChat, setSidebarOpen]);
  useEffect(() => {
    if (
      !pendingNativeSkillSidebar ||
      view !== "chat" ||
      selectedSessionId ||
      selectedProjectId ||
      selectedAppId
    ) return;
    setNativeSkillSidebar(pendingNativeSkillSidebar);
    setPendingNativeSkillSidebar(null);
    setRightPanelMode("home");
    setDiffPanelExpanded(false);
    setDiffPanelOpen(true);
  }, [
    pendingNativeSkillSidebar,
    selectedAppId,
    selectedProjectId,
    selectedSessionId,
    setDiffPanelExpanded,
    setDiffPanelOpen,
    setRightPanelMode,
    view,
  ]);
  useEffect(() => {
    if (!nativeSkillSidebar) return;
    if (view === "chat" && diffPanelOpen && rightPanelMode === "home") return;
    setNativeSkillSidebar(null);
  }, [diffPanelOpen, nativeSkillSidebar, rightPanelMode, view]);
  const closeNativeSkillSidebar = useCallback(() => {
    setNativeSkillSidebar(null);
    setDiffPanelExpanded(false);
    setDiffPanelOpen(false);
  }, [setDiffPanelExpanded, setDiffPanelOpen]);
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
            onOpenNativeSkill: openNativeSkillFromSettings,
            teamChatCurrentUserId: teamChat.currentUserId,
            teamChatEnabled: teamChatTeamId !== null,
            teamChatNotificationMode: teamChat.notificationMode,
            teamChatThreads: teamChat.threads,
            onTeamChatNotificationModeChange: teamChat.setNotificationMode,
            onTeamChatThreadMuteChange: teamChat.setThreadMuted,
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
      </AppToastProvider>
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
    view === "chat" ||
    view === "cloud" ||
    view === "labs" ||
    (view === "get-started" && Boolean(postTrainingCourse || makeAgentTutorial)) ||
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
    <AppToastProvider showToast={showToast}>
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
        ...communitySidebar,
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
        addSessionToTraining: (session) => {
          void training.actions.addSource(session.id).then((source) => {
            if (!source) return;
            setView("labs");
            showToast("Added chat to training sources.", "info");
          });
        },
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
        backAction: labDetailNavigation.backAction,
        breadcrumbs: labDetailNavigation.breadcrumbs,
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
        showDiffControls: view === "chat" || view === "cloud",
        diffPanelOpen,
        terminalOpen,
        rightSidebarAvailable: rightSidebarAvailableForView,
        rightSidebarOpen: view === "get-started"
          ? Boolean(postTrainingCourse || makeAgentTutorial) && diffPanelOpen
          : diffPanelOpen,
        onToggleDiffPanel: toggleRightSidebar,
        onToggleRightSidebar: view === "get-started"
          ? () => setDiffPanelOpen((open) => !open)
          : view === "team" && Boolean(teamAiThreadId)
            ? toggleTeamAiSidebar
            : toggleRightSidebar,
        onOpenSearch: () => {
          setSectionMenuOpen(null);
          setSearchOpen(true);
        },
        onToggleTerminal: () => setTerminalOpen((open) => !open),
        onOpenInsights: () => {
          setSectionMenuOpen(null);
          openLabSuggestions();
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
        showWorkspaceControls: view !== "team" && view !== "community" && view !== "labs",
        insightsItems: insights.items,
        insightsSummary: insights.summary,
        insightsScanning: insights.scanRunning,
      }}
      mainPane={{
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
        labCloseDetailRequestId: labDetailNavigation.closeDetailRequestId,
        labCloseDetailKind: labDetailNavigation.closeDetailKind,
        labSuggestionsRequestId,
        sideChatTrainingLaunchRequest: rightChatTrainingLaunchRequest,
        onSideChatTrainingLaunchHandled: (id) => setRightChatTrainingLaunchRequest((current) =>
          current?.id === id ? null : current),
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
        nativeSkillSidebar,
        makeAgentTutorial,
        postTrainingCourse,
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
        training,
        trainingSessions: sidebarSessions,
        trainingChatHandoff,
        trainingDetailTasksetId,
        onTrainingDetailTasksetIdChange: setTrainingDetailTasksetId,
        onTrainingChatTaskSelect: selectTrainingChatTaskForComposer,
        onTrainingChatHandoffDismiss: dismissTrainingChatHandoff,
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
        onOpenPostTrainingCourse: openPostTrainingCourse,
        onClosePostTrainingCourse: closePostTrainingCourse,
        onOpenPostTrainingScript: openPostTrainingScript,
        onSelectPostTrainingLesson: selectPostTrainingLesson,
        onSetPostTrainingAutoplay: setPostTrainingAutoplay,
        onShowPostTrainingLessons: showPostTrainingLessons,
        onOpenMakeAgentTutorial: openMakeAgentTutorial,
        onCloseMakeAgentTutorial: closeMakeAgentTutorial,
        onShowMakeAgentTutorialSteps: showMakeAgentTutorialSteps,
        onShowMakeAgentTutorialScript: showMakeAgentTutorialScript,
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
          const session = providedSession
            ?? sidebarSessions.find((candidate) => candidate.id === sessionId)
            ?? null;
          if (session) openRightChatPanel(session, { preserveView: true });
        },
        onOpenLabSuggestions: openLabSuggestions,
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
        changeSubagentDelegationMode,
        resolveApproval,
        answerCreateImproveQuestion,
        applyCreateImproveCandidate,
        approveCreateImproveRun,
        cancelCreateImproveRun,
        openCreateImprovePullRequest, reconcileCreateImprovePullRequest, rejectCreateImproveCandidate,
        pauseCreateImproveRun,
        resumeCreateImproveRun,
        reviseCreateImproveRun,
        setMentionedAppId,
        showToast,
        sendPrompt: sendPromptFromMainComposer,
        pauseGoal,
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
    </AppToastProvider>
  );
}
