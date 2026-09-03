import {
  lazy,
  Suspense,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChatAttachment,
  ChatAttachmentSummary,
  ChatProvider,
  SidebarFileBookmark,
  WorkspaceDiffFile,
} from "@openpond/contracts";
import { api } from "../../api";
import { normalizePreferences } from "../../lib/app-models";
import { isCodexHistorySessionId } from "../../lib/sidebar-session-projects";
import { IncrementalChatProjector } from "../../lib/incremental-chat-projector";
import { mergeRuntimeEventLists } from "../../lib/runtime-event-lists";
import { appendPendingUserChatMessage } from "../../lib/pending-chat-messages";
import { useRuntimeEventSession } from "../../hooks/useRuntimeEventSession";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { ComposerSubmitOptions } from "../chat/Composer";
import { DraftBoundComposer } from "../chat/DraftBoundComposer";
import type {
  ComposerCreateImproveActions,
  ComposerCreateImproveRuntime,
} from "../chat/ComposerCreateImproveStrip";
import { ApprovalRequestCard } from "../chat/ApprovalRequestCard";
import type { CreateImproveReviewActionInput } from "../chat/create-pipeline-types";
import { openBrowserLink } from "../../lib/browser-sidebar-links";
import {
  normalizeChatFilePath,
  resolveChatWorkspaceRootPath,
} from "../../lib/chat-file-links";
import { absoluteLocalVideoPath } from "../../lib/local-video";
import { shouldShowThinkingIndicator } from "../../lib/chat-timeline-rows";
import {
  composerSlashCommandAllowedInExperience,
  parseComposerSlashCommandPrompt,
  type ComposerSlashCommand,
} from "../../lib/composer-slash-commands";
import {
  buildOpenPondProfileActionCatalog,
  buildOpenPondProfileActionCommand,
  isOpenPondProfileAction,
} from "../../lib/openpond-action-run";
import {
  resolveRightSidebarFileSource,
  type RightSidebarFileSource,
} from "../../lib/right-sidebar-file-source";
import {
  buildSubmitIssueSlashPrompt,
  hasGitHubIssueSubmitConnection,
} from "../../lib/submit-issue-command";
import { isCloudWorkspaceKind } from "../../lib/workspace-location";
import { skillPromptForComposer } from "../../lib/profile-skill-composer";
import {
  composerSkillsForProfile,
  openPondProfileRefFromKey,
  profileStateForRef,
} from "../../lib/profile-selection";
import { selectComposerProfileTransaction } from "../../lib/profile-selection-transaction";
import { trainingCreationForSession } from "../training/training-flow";
import type { TrainingLaunchRequest } from "../training/training-workspace-types";
import type { TrainingSidebarSummary } from "../training/TrainingRunSidebarSummary";
import type {
  WorkspaceDiffOpenFileRequest,
  WorkspaceFileSourceSwitcher,
} from "../workspace-diff/workspace-diff-panel-model";
import { useLabCandidateReview } from "../../hooks/useLabCandidateReview";
import { useLabAgentAuthoring } from "../../hooks/useLabAgentAuthoring";
import {
  billingTargetForContext,
  latestCreatePipelineRuntime,
  promptForAppSlashCommand,
  sandboxIdFromWorkspaceName,
  shouldSubmitComposerSlashCommandToChat,
  usageAttributionForComposerSlashCommand,
} from "./main-pane-helpers";
import {
  ActiveTrainingChatHandoffBar,
  MessageNavigationControls,
  WorkspaceSyncButton,
  mainPaneViewClass,
  shouldShowRightSidebarHomePanel,
} from "./MainPaneControls";
import type { MainPaneProps } from "./main-pane-types";
import {
  sidebarFileOpenRequestMatchesConversation,
  type ComposerAttachmentRequest,
} from "../../lib/sidebar-files";
import type { LabSkillSourceSelection } from "../labs/lab-skill-source";
import { outputHandoffPrompt } from "../../lib/experience-handoff";
import { useMainPaneChatScroll } from "./useMainPaneChatScroll";

import {
  AppsView,
  AppTerminalPanel,
  BrowserSidebar,
  GetStartedView,
  LabsRoute,
  LabSkillSidebar,
  NativeSkillSidebar,
  NewExperienceSwitcher,
  OutputsPage,
  ProjectsPage,
  RightSidebarHomePanel,
  ScheduledWorkPage,
  RightChatPanelStack,
  TeamAiThreadPanel,
  TeamAgentConversationPanel,
  TeamChatProView,
  TeamChatView,
  CollaborationTabs,
  WorkSidebarPanel,
  CommunityView,
  WorkspaceDiffPanel,
} from "./MainPaneLazyViews";

const TrainingDraftPanel = lazy(() =>
  import("../training/TrainingDraftPanel").then((module) => ({
    default: module.TrainingDraftPanel,
  }))
);
const MainChatThread = lazy(() =>
  import("./MainChatThread").then((module) => ({
    default: module.MainChatThread,
  }))
);
const TrainingCreationPanel = lazy(() =>
  import("../training/TrainingCreationPanel").then((module) => ({
    default: module.TrainingCreationPanel,
  }))
);
export function MainPane({
  experience,
  onNewExperienceChange,
  view,
  teamChat,
  community,
  bootstrap,
  runtimeEvents: suppliedRuntimeEvents,
  chatMessages: suppliedChatMessages,
  pendingUserMessage,
  contextWindowStatus,
  goalRuntime,
  subagentRuntime,
  selectedSessionId,
  composerDraftStore,
  mainComposerFocusRequestId,
  labCloseDetailRequestId,
  labCloseDetailKind,
  sideChatTrainingLaunchRequest,
  onSideChatTrainingLaunchHandled,
  mentionApps,
  connectedAppMentions,
  profileSkills,
  selectedMentionAppId,
  busy,
  turnRunning,
  activeProvider,
  activeModel,
  codexPermissionMode,
  codexReasoningEffort,
  openPondCommandAccessMode,
  pendingApproval,
  activeWorkspaceAppId,
  activeWorkspaceId,
  activeWorkspaceKind,
  projectTarget,
  actionCatalog,
  workspaceTarget,
  connection,
  workspaceName,
  workspaceState,
  workspaceDiff,
  workspaceBusy,
  diffBusy,
  forceChatThread = false,
  diffPanelOpen,
  diffPanelExpanded,
  rightPanelMode,
  rightPanelTabRequest,
  rightChatPanels,
  runtimeEventStore,
  nativeSkillSidebar,
  extensionSkillSidebar,
  workspaceDiffPanelViewState,
  sidebarFileOpenRequest,
  sidebarFileBookmarks,
  onSetSidebarFileStatus,
  browserConversationId,
  terminalScope,
  terminalTabs,
  terminalCwd,
  pendingTerminalCommand,
  terminalOpen,
  onToggleTerminal,
  onWorkspaceDiffPanelViewStateChange,
  training,
  trainingSessions,
  trainingChatHandoff,
  trainingDetailTasksetId,
  onTrainingDetailTasksetIdChange,
  onTrainingChatTaskSelect,
  onTrainingChatHandoffDismiss,
  onOpenSession,
  onExperienceHandoff,
  cloudProjects,
  projects,
  projectsAccountBaseUrl,
  projectsTeamName,
  projectTaskCounts,
  onNewCloudProject,
  onNewProjectTask,
  onToggleProjectPinned,
  onUploadLocalProject,
  chatHistoryHasMore = false,
  chatHistoryLoading = false,
  onDiffPanelResizeStart,
  canSyncWorkspace,
  startMessage,
  onPayload,
  onError,
  setView,
  onOpenProfileSettings,
  onOpenProviderSettings,
  onOpenTrainingSettings,
  onOpenDatasetStorageSettings,
  changeDraftProvider,
  changeProjectTarget,
  changeWorkspaceTarget,
  setDraftProvider,
  setDraftModel,
  onBeginNewChatWithModel,
  changeCodexPermissionMode,
  changeCodexReasoningEffort,
  changeOpenPondCommandAccessMode,
  resolveApproval,
  answerCreateImproveQuestion,
  approveCreateImproveRun,
  applyCreateImproveCandidate,
  cancelCreateImproveRun,
  openCreateImprovePullRequest,
  pauseCreateImproveRun,
  reconcileCreateImprovePullRequest,
  rejectCreateImproveCandidate,
  resumeCreateImproveRun,
  reviseCreateImproveRun,
  setMentionedAppId,
  showToast,
  onSaveTaskDraft,
  sendPrompt,
  stopTurn,
  syncWorkspaceLocally,
  refreshWorkspaceDiff,
  onToggleDiffPanelExpanded,
  onShowDiffPanel,
  onShowBrowserPanel,
  onShowTrainingDraftPanel,
  onShowFilesPanel,
  onShowRightChatPanel,
  onAddRightChat,
  onOpenRightChatForSession,
  onLabDetailOpenChange,
  scheduledDetailOpen,
  onScheduledDetailOpenChange,
  onTerminalTabsChange,
  onCloseRightChatPanel,
  onCloseNativeSkillSidebar,
  onActivateRightChatPanel,
  onRightChatModelChange,
  onRightChatPromptChange,
  onRightChatScrollStateChange,
  onRightChatProviderChange,
  onSubmitRightChat,
  onStopRightChat,
  onCloseTerminal,
  onLoadMoreChatHistory,
}: MainPaneProps) {
  const [chatProjector] = useState(() => new IncrementalChatProjector());
  const liveSessionId = selectedSessionId && !isCodexHistorySessionId(selectedSessionId)
    ? selectedSessionId
    : null;
  const liveSessionSnapshot = useRuntimeEventSession(runtimeEventStore, liveSessionId);
  const runtimeEvents = useMemo(
    () => liveSessionId
      ? mergeRuntimeEventLists(suppliedRuntimeEvents, liveSessionSnapshot.events)
      : suppliedRuntimeEvents,
    [liveSessionId, liveSessionSnapshot.events, suppliedRuntimeEvents],
  );
  const chatMessages = useMemo(
    () => liveSessionId
      ? appendPendingUserChatMessage(
          chatProjector.project(runtimeEvents),
          pendingUserMessage,
        )
      : suppliedChatMessages,
    [chatProjector, liveSessionId, pendingUserMessage, runtimeEvents, suppliedChatMessages],
  );
  const [composerAttachmentRequest, setComposerAttachmentRequest] =
    useState<ComposerAttachmentRequest | null>(null);
  const [chatSubmissionVersion, setChatSubmissionVersion] = useState(0);
  const currentComposerSubmissionScopeKeyRef = useRef("");
  const getCurrentComposerSubmissionScopeKey = useCallback(
    () => currentComposerSubmissionScopeKeyRef.current,
    [],
  );
  const [openDiffFileRequest, setOpenDiffFileRequest] =
    useState<WorkspaceDiffOpenFileRequest | null>(null);
  const [rightSidebarSourceOverride, setRightSidebarSourceOverride] =
    useState<RightSidebarFileSource | null>(null);
  const [labSkillSource, setLabSkillSource] =
    useState<LabSkillSourceSelection | null>(null);
  const [trainingLaunchRequest, setTrainingLaunchRequest] =
    useState<TrainingLaunchRequest | null>(null);
  const [selectedTrainingTasksetId, setSelectedTrainingTasksetId] = useState<
    string | null
  >(null);
  const [selectedTrainingJobId, setSelectedTrainingJobId] = useState<
    string | null
  >(null);
  const [requestedComposerAction, setRequestedComposerAction] = useState<{
    actionId: string;
    requestId: number;
  } | null>(null);
  const [profileActionCatalogOverride, setProfileActionCatalogOverride] =
    useState<SandboxActionCatalogEntry[]>([]);
  useEffect(() => {
    setOpenDiffFileRequest(null);
  }, [browserConversationId]);
  const selectedProfileSession = useMemo(
    () =>
      bootstrap?.sessions.find((session) => session.id === selectedSessionId) ??
      null,
    [bootstrap?.sessions, selectedSessionId]
  );
  const selectedProfileRef =
    selectedProfileSession?.currentProfile ??
    bootstrap?.profileLibrary?.lastUsed ??
    null;
  const selectedProfileState =
    profileStateForRef(
      bootstrap?.profileLibrary ?? { lastUsed: null, profiles: [] },
      selectedProfileRef
    ) ??
    bootstrap?.profile ??
    null;
  const selectedProfileSkills = useMemo(
    () =>
      composerSkillsForProfile(
        selectedProfileState,
        bootstrap?.extensionCatalog
      ),
    [bootstrap?.extensionCatalog, selectedProfileState]
  );
  const selectedProfileActionCatalog = useMemo(
    () => buildOpenPondProfileActionCatalog(selectedProfileState),
    [selectedProfileState]
  );
  const changeComposerProfile = useCallback(
    async (
      value: string,
      targetSessionId: string | null = selectedSessionId
    ) => {
      if (!connection || !bootstrap) return;
      const ref = openPondProfileRefFromKey(
        bootstrap.profileLibrary ?? { lastUsed: null, profiles: [] },
        value
      );
      if (!ref) return;
      try {
        const targetSession =
          targetSessionId && !isCodexHistorySessionId(targetSessionId)
            ? bootstrap.sessions.find(
                (session) => session.id === targetSessionId
              ) ?? null
            : null;
        const result = await selectComposerProfileTransaction({
          ref,
          session: targetSession,
          selectProfile: (nextRef) => api.profileSelect(connection, nextRef),
          patchSession: (sessionId, currentProfile) =>
            api.patchSession(connection, sessionId, { currentProfile }),
        });
        let sessions = bootstrap.sessions;
        if (result.session) {
          sessions = sessions.map((session) =>
            session.id === result.session!.id ? result.session! : session
          );
        }
        onPayload({
          ...bootstrap,
          profile: result.selected.profile,
          profileLibrary: result.selected.library,
          sessions,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(message);
        showToast(message, "error");
      }
    },
    [bootstrap, connection, onError, onPayload, selectedSessionId, showToast]
  );
  useEffect(() => {
    if (!sidebarFileOpenRequestMatchesConversation(
      sidebarFileOpenRequest,
      browserConversationId,
    )) {
      return;
    }
    const { file, id } = sidebarFileOpenRequest;
    setOpenDiffFileRequest({ id, path: file.path });
    if (!connection) return;
    let cancelled = false;
    const loadFile =
      file.workspaceKind === "local"
        ? api
            .workspaceFile(connection, file.workspaceId, file.path)
            .then((response) => response.content ?? "")
        : api
            .sandboxDownloadFile(connection, file.workspaceId, file.path)
            .then((response) => {
              if (response.file.isBinary)
                throw new Error("Binary files cannot be attached to chat.");
              return response.contents;
            });
    void loadFile
      .then((contents) => {
        if (cancelled) return;
        const filename = file.path.split("/").at(-1) ?? file.path;
        setComposerAttachmentRequest({
          id,
          file: new File([contents], filename, {
            type: sidebarFileMediaType(file),
          }),
        });
      })
      .catch((fileError) => {
        if (!cancelled) {
          showToast(
            fileError instanceof Error ? fileError.message : String(fileError),
            "error"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [browserConversationId, connection, showToast, sidebarFileOpenRequest]);
  const repositoryWork =
    experience === "development" ||
    (experience === "work" && projectTarget.value !== "none");
  const composerActionCatalog = useMemo(() => {
    if (experience === "chat") return selectedProfileActionCatalog;
    if (!repositoryWork) return [];
    const byId = new Map(
      actionCatalog
        .filter((action) => !isOpenPondProfileAction(action))
        .map((action) => [action.id, action])
    );
    for (const action of selectedProfileActionCatalog)
      byId.set(action.id, action);
    for (const action of profileActionCatalogOverride)
      byId.set(action.id, action);
    return [...byId.values()];
  }, [
    actionCatalog,
    experience,
    repositoryWork,
    profileActionCatalogOverride,
    selectedProfileActionCatalog,
  ]);
  const labCandidateReview = useLabCandidateReview(connection);
  const handleLabCandidateReviewChange = useCallback(
    (
      input: {
        run: CreateImproveReviewActionInput["run"];
        candidate: CreateImproveReviewActionInput["run"]["candidates"][number];
        fileRootPath: string | null;
        initialPath: string | null;
      } | null
    ) => {
      if (!input) {
        labCandidateReview.activate(null);
        return;
      }
      labCandidateReview.activate({
        runId: input.run.id,
        candidateId: input.candidate.id,
        title: input.run.objective,
        fileRootPath: input.fileRootPath,
        initialPath: input.initialPath,
      });
    },
    [labCandidateReview.activate]
  );
  const handleOpenLabCandidateFiles = useCallback(() => {
    if (labCandidateReview.selection?.initialPath) {
      labCandidateReview.openFile(labCandidateReview.selection.initialPath);
    }
    onShowDiffPanel();
  }, [
    labCandidateReview.openFile,
    labCandidateReview.selection?.initialPath,
    onShowDiffPanel,
  ]);
  const handleLabSkillSelectionChange = useCallback(
    (selection: LabSkillSourceSelection | null) => {
      setLabSkillSource(selection);
      if (selection) onShowDiffPanel();
    },
    [onShowDiffPanel]
  );
  const handleCloseLabSkillSource = useCallback(() => {
    setLabSkillSource(null);
    if (diffPanelExpanded) onToggleDiffPanelExpanded();
  }, [diffPanelExpanded, onToggleDiffPanelExpanded]);
  useEffect(() => {
    if (view !== "labs") setLabSkillSource(null);
  }, [view]);
  const handleUseAgent = useCallback(
    (actionId: string, agentName: string) => {
      const requestId = Date.now();
      const existingAction =
        actionCatalog.find((action) => action.id === actionId) ?? null;
      composerDraftStore.set("");
      setMentionedAppId(null);
      setView("chat");

      const selectActionAfterCatalogCommit = (
        actions: SandboxActionCatalogEntry[]
      ) => {
        const selected =
          actions.find((action) => action.id === actionId) ?? null;
        if (!selected) return false;
        const labeledActions = actions.map((action) =>
          action.id === actionId ? { ...action, label: agentName } : action
        );
        setProfileActionCatalogOverride(labeledActions);
        window.requestAnimationFrame(() => {
          setRequestedComposerAction({
            actionId,
            requestId: Math.max(Date.now(), requestId + 1),
          });
        });
        return true;
      };

      if (!connection) {
        if (existingAction) {
          selectActionAfterCatalogCommit([existingAction]);
        } else {
          showToast(
            "The Agent action catalog is still loading. Try Use again.",
            "error"
          );
        }
        return;
      }

      void api
        .profileCurrent(connection)
        .then((profile) => {
          const freshActions = profile.actionCatalog.map((action) =>
            buildOpenPondProfileActionCommand(action)
          );
          if (!selectActionAfterCatalogCommit(freshActions) && existingAction) {
            selectActionAfterCatalogCommit([existingAction]);
          } else if (!freshActions.some((action) => action.id === actionId)) {
            showToast(
              "This Agent is ready, but its default chat action is unavailable.",
              "error"
            );
          }
        })
        .catch((error) => {
          if (!existingAction) {
            showToast(
              error instanceof Error ? error.message : String(error),
              "error"
            );
          }
        });
    },
    [
      actionCatalog,
      composerDraftStore,
      connection,
      setMentionedAppId,
      setView,
      showToast,
    ]
  );
  const openProfileSkillCommand = useCallback(
    (command: string, provider?: ChatProvider) => {
      composerDraftStore.set(command);
      setMentionedAppId(null);
      if (provider) changeDraftProvider(provider);
      setView("chat");
    },
    [
      changeDraftProvider,
      composerDraftStore,
      setMentionedAppId,
      setView,
    ]
  );
  const appPreferences = useMemo(
    () => normalizePreferences(bootstrap?.preferences),
    [bootstrap?.preferences]
  );
  const trainingPreferences = appPreferences.training;
  const { createAgentFromLab, improveAgentFromLab } = useLabAgentAuthoring({
    activeModel,
    activeProvider,
    bootstrap,
    codexPermissionMode,
    codexReasoningEffort,
    connection,
    onOpenRightChatForSession,
    onPayload,
  });
  const activeTrainingTasksetId = useMemo(() => {
    const tasksets = training.payload?.tasksets ?? [];
    return tasksets.some((taskset) => taskset.id === selectedTrainingTasksetId)
      ? selectedTrainingTasksetId
      : tasksets[0]?.id ?? null;
  }, [selectedTrainingTasksetId, training.payload?.tasksets]);
  const trainingTasksetRootPath =
    view === "labs" && activeTrainingTasksetId
      ? `profiles/${
          bootstrap?.profile.activeProfile ?? "default"
        }/tasksets/${activeTrainingTasksetId}`
      : null;
  const trainingSidebarSummary = useMemo<TrainingSidebarSummary | null>(() => {
    if (view !== "labs" || !activeTrainingTasksetId || !training.payload)
      return null;
    const taskset = training.payload.tasksets.find(
      (item) => item.id === activeTrainingTasksetId
    );
    if (!taskset) return null;
    const plans = training.payload.plans.filter(
      (plan) => plan.tasksetId === taskset.id
    );
    const planIds = new Set(plans.map((plan) => plan.id));
    const jobs = training.payload.jobs
      .filter((item) => planIds.has(item.planId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const job =
      jobs.find((item) => item.id === selectedTrainingJobId) ?? jobs[0] ?? null;
    const plan = job
      ? plans.find((item) => item.id === job.planId) ?? null
      : plans.sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
        )[0] ?? null;
    const lineage = job
      ? training.payload.models.find((item) => item.jobId === job.id) ?? null
      : null;
    const artifacts = job
      ? training.payload.artifacts.filter((item) => item.jobId === job.id)
      : [];
    return { taskset, plan, job, lineage, artifacts };
  }, [activeTrainingTasksetId, selectedTrainingJobId, training.payload, view]);
  const selectedTrainingCreation = useMemo(
    () => trainingCreationForSession(training.payload, selectedSessionId),
    [selectedSessionId, training.payload]
  );
  const latestCreateRuntime = useMemo(
    () => latestCreatePipelineRuntime(chatMessages),
    [chatMessages]
  );
  const hasGoalDetails =
    Boolean(goalRuntime) ||
    Boolean(latestCreateRuntime) ||
    Boolean(subagentRuntime);
  const showLabCandidateDiffPanel =
    view === "labs" && Boolean(labCandidateReview.selection);
  const showLabSkillPanel =
    view === "labs" &&
    diffPanelOpen &&
    rightPanelMode === "changes" &&
    Boolean(labSkillSource);
  const showLocalDiffPanel =
    (view === "chat" || view === "labs") && Boolean(activeWorkspaceAppId);
  const showEmptyRightChatFallbackPanel =
    view === "chat" &&
    diffPanelOpen &&
    rightPanelMode === "chat" &&
    rightChatPanels.length === 0;
  const chatSandboxId = isCloudWorkspaceKind(activeWorkspaceKind)
    ? activeWorkspaceId ?? sandboxIdFromWorkspaceName(workspaceName)
    : null;
  const showChatSandboxDiffPanel = view === "chat" && Boolean(chatSandboxId);
  const rightSidebarSandboxId = chatSandboxId;
  const rightSidebarSandboxSourceAvailable =
    Boolean(rightSidebarSandboxId) ||
    workspaceTarget.value === "cloud" ||
    workspaceTarget.value === "hybrid";
  const rightSidebarSourceState = useMemo(
    () =>
      resolveRightSidebarFileSource({
        workspaceTarget: workspaceTarget.value,
        localWorkspaceId: activeWorkspaceAppId,
        sandboxSourceAvailable: rightSidebarSandboxSourceAvailable,
        sandboxWorkspaceId: rightSidebarSandboxId,
        override: rightSidebarSourceOverride,
      }),
    [
      activeWorkspaceAppId,
      rightSidebarSandboxSourceAvailable,
      rightSidebarSandboxId,
      rightSidebarSourceOverride,
      workspaceTarget.value,
    ]
  );
  const rightSidebarSource = rightSidebarSourceState.source;
  const rightSidebarUsesSandbox = rightSidebarSource === "sandbox";
  const rightSidebarSourceSwitcher =
    useMemo<WorkspaceFileSourceSwitcher | null>(
      () =>
        rightSidebarSource && rightSidebarSourceState.options.length > 1
          ? {
              value: rightSidebarSource,
              options: rightSidebarSourceState.options,
              onChange: setRightSidebarSourceOverride,
            }
          : null,
      [rightSidebarSource, rightSidebarSourceState.options]
    );
  useEffect(() => {
    setRightSidebarSourceOverride(null);
  }, [
    activeWorkspaceAppId,
    browserConversationId,
    rightSidebarSandboxId,
    workspaceTarget.value,
  ]);
  const showDiffPanel =
    !showLabSkillPanel &&
    (showLabCandidateDiffPanel ||
      showLocalDiffPanel ||
      showChatSandboxDiffPanel) &&
    diffPanelOpen &&
    (rightPanelMode === "changes" ||
      (rightPanelMode === "goal" && hasGoalDetails) ||
      showEmptyRightChatFallbackPanel);
  const showBrowserPanel =
    view === "chat" && diffPanelOpen && rightPanelMode === "browser";
  const showRightChatPanel =
    (view === "chat" || view === "labs") &&
    diffPanelOpen &&
    rightPanelMode === "chat" &&
    rightChatPanels.length > 0;
  const showTrainingDraftPanel =
    view === "chat" && diffPanelOpen && rightPanelMode === "training";
  const showNativeSkillPanel =
    view === "chat" && diffPanelOpen && Boolean(nativeSkillSidebar);
  const showExtensionSkillPanel =
    view === "chat" && diffPanelOpen && Boolean(extensionSkillSidebar);
  const showTeamAiThreadPanel =
    view === "team" &&
    diffPanelOpen &&
    rightPanelMode === "chat" &&
    Boolean(teamChat.aiThread);
  const showTeamAgentConversationPanel =
    view === "team" &&
    diffPanelOpen &&
    rightPanelMode === "chat" &&
    Boolean(teamChat.agentConversation);
  const showWorkPanel =
    experience === "work" &&
    view === "chat" &&
    diffPanelOpen &&
    rightPanelMode === "home";
  const showRightHomePanel = shouldShowRightSidebarHomePanel({
    supportedView:
      (view === "chat" && repositoryWork) || view === "labs",
    open: diffPanelOpen,
    hasContentPanel:
      showDiffPanel ||
      showLabSkillPanel ||
      showBrowserPanel ||
      showRightChatPanel ||
      showTrainingDraftPanel ||
      showNativeSkillPanel ||
      showTeamAiThreadPanel ||
      showTeamAgentConversationPanel ||
      showWorkPanel,
  });
  const showRightPanel =
    showDiffPanel ||
    showLabSkillPanel ||
    showBrowserPanel ||
    showRightChatPanel ||
    showTrainingDraftPanel ||
    showNativeSkillPanel ||
    showTeamAiThreadPanel ||
    showTeamAgentConversationPanel ||
    showWorkPanel ||
    showRightHomePanel;
  const rightPanelExpanded =
    showRightPanel && rightPanelMode !== "chat" && diffPanelExpanded;
  const accountBaseUrl =
    bootstrap?.account.baseUrl ??
    bootstrap?.account.activeProfile?.baseUrl ??
    null;
  const billingTarget = billingTargetForContext({
    activeWorkspaceId,
    cloudProjects,
  });
  const showThinkingIndicator =
    view === "chat" &&
    turnRunning &&
    !pendingApproval &&
    shouldShowThinkingIndicator(chatMessages);
  const showChatThread =
    forceChatThread || chatMessages.length > 0 || showThinkingIndicator;
  const composerSubmissionScopeKey =
    selectedSessionId ??
    `draft:${view}:${activeWorkspaceKind ?? "none"}:${
      activeWorkspaceId ?? activeWorkspaceAppId ?? "none"
    }`;
  currentComposerSubmissionScopeKeyRef.current = composerSubmissionScopeKey;
  const trainingChatHandoffBar = (
    <ActiveTrainingChatHandoffBar
      activeModel={activeModel}
      activeProvider={activeProvider}
      busy={turnRunning}
      handoff={trainingChatHandoff}
      onDismiss={onTrainingChatHandoffDismiss}
      onSelectTask={onTrainingChatTaskSelect}
    />
  );
  const createImproveActions = useMemo<ComposerCreateImproveActions>(
    () => ({
      onAnswerQuestion: answerCreateImproveQuestion,
      onApprove: approveCreateImproveRun,
      onApplyCandidate: applyCreateImproveCandidate,
      onCancel: cancelCreateImproveRun,
      onOpenPullRequest: openCreateImprovePullRequest,
      onPause: pauseCreateImproveRun,
      onReconcilePullRequest: reconcileCreateImprovePullRequest,
      onRejectCandidate: rejectCreateImproveCandidate,
      onResume: resumeCreateImproveRun,
      onRevise: reviseCreateImproveRun,
    }),
    [
      answerCreateImproveQuestion,
      approveCreateImproveRun,
      applyCreateImproveCandidate,
      cancelCreateImproveRun,
      openCreateImprovePullRequest,
      pauseCreateImproveRun,
      reconcileCreateImprovePullRequest,
      rejectCreateImproveCandidate,
      resumeCreateImproveRun,
      reviseCreateImproveRun,
    ]
  );
  const createImproveRuntime =
    useMemo<ComposerCreateImproveRuntime | null>(() => {
      return latestCreateRuntime
        ? {
            ...latestCreateRuntime,
            ...createImproveActions,
          }
        : null;
    }, [createImproveActions, latestCreateRuntime]);
  const viewClass = mainPaneViewClass(view, showChatThread);
  const submitComposerPrompt = useCallback(
    async (
      attachments: ChatAttachment[] = [],
      action: SandboxActionCatalogEntry | null = null,
      selectedCommand: ComposerSlashCommand | null = null,
      options: ComposerSubmitOptions = {}
    ) => {
      const promptForSubmit =
        options.promptOverride ?? composerDraftStore.getSnapshot();
      const clearMainPrompt = () => {
        if (options.preservePrompt) return;
        composerDraftStore.set("");
        setMentionedAppId(null);
      };
      if (!action) {
        const command = selectedCommand
          ? { command: selectedCommand.id, args: promptForSubmit.trim() }
          : parseComposerSlashCommandPrompt(promptForSubmit);
        if (command) {
          const commandAllowed = composerSlashCommandAllowedInExperience(
            { id: command.command },
            experience,
          );
          if (!commandAllowed) {
            showToast(
              `/${command.command} isn't available in ${experience}.`,
              "info"
            );
            return false;
          }
          if (command.command === "train") {
            if (attachments.length > 0) {
              showToast(
                "/train uses the selected chat; add other chats from Models.",
                "error"
              );
              return false;
            }
            if (!selectedSessionId) {
              clearMainPrompt();
              setTrainingLaunchRequest({
                id: Date.now(),
                objective: command.args.trim() || null,
                initialSessionIds: [],
              });
              setView("labs");
              return true;
            }
            clearMainPrompt();
            setTrainingLaunchRequest({
              id: Date.now(),
              objective: command.args.trim() || null,
              initialSessionIds: [selectedSessionId],
            });
            setView("labs");
            return true;
          }
          if (
            !command.args &&
            command.command !== "skill" &&
            command.command !== "sync-cloud"
          ) {
            showToast(`Add instructions after /${command.command}.`, "info");
            return false;
          }
          if (attachments.length > 0) {
            showToast(
              `/${command.command} tasks do not accept attachments yet. Add file context in the task thread.`,
              "error"
            );
            return false;
          }
          if (command.command === "submit-issue") {
            if (!hasGitHubIssueSubmitConnection(connectedAppMentions)) {
              showToast(
                "Connect the GitHub app before using /submit-issue.",
                "error"
              );
              return false;
            }
            setChatSubmissionVersion((version) => version + 1);
            return sendPrompt(
              [],
              null,
              buildSubmitIssueSlashPrompt(command.args),
              {
                clearPrompt: options.preservePrompt
                  ? () => undefined
                  : undefined,
                usageAttribution: usageAttributionForComposerSlashCommand(
                  command,
                  selectedCommand ? "composer_selection" : "prompt_parse"
                ),
              }
            );
          }
          if (shouldSubmitComposerSlashCommandToChat(command)) {
            const skillPrompt =
              command.command === "skill"
                ? skillPromptForComposer(
                    command.args,
                    activeProvider,
                    bootstrap?.profile.sourcePath ?? null
                  )
                : promptForAppSlashCommand(command);
            setChatSubmissionVersion((version) => version + 1);
            return sendPrompt([], null, skillPrompt, {
              clearPrompt: options.preservePrompt ? () => undefined : undefined,
              usageAttribution: usageAttributionForComposerSlashCommand(
                command,
                selectedCommand ? "composer_selection" : "prompt_parse"
              ),
            });
          }
          setChatSubmissionVersion((version) => version + 1);
          return sendPrompt([], null, promptForAppSlashCommand(command), {
            clearPrompt: options.preservePrompt ? () => undefined : undefined,
            usageAttribution: usageAttributionForComposerSlashCommand(
              command,
              selectedCommand ? "composer_selection" : "prompt_parse"
            ),
          });
        }
      }
      setChatSubmissionVersion((version) => version + 1);
      return sendPrompt(attachments, action, options.promptOverride, {
        clearPrompt: options.preservePrompt ? () => undefined : undefined,
        displayPrompt: options.displayPrompt,
        turnMetadata: options.turnMetadata,
      });
    },
    [
      activeModel,
      activeProvider,
      activeWorkspaceKind,
      bootstrap?.profile,
      connectedAppMentions,
      composerDraftStore,
      experience,
      sendPrompt,
      selectedSessionId,
      setMentionedAppId,
      setView,
      showToast,
      training,
      view,
    ]
  );
  const changeMainComposerModel = useCallback(
    (model: string) => {
      if (trainingChatHandoff && model !== trainingChatHandoff.model.modelId) {
        onTrainingChatHandoffDismiss();
      }
      setDraftProvider(activeProvider);
      setDraftModel(model);
    },
    [
      activeProvider,
      onTrainingChatHandoffDismiss,
      setDraftModel,
      setDraftProvider,
      trainingChatHandoff,
    ]
  );
  const changeMainComposerProvider = useCallback(
    (provider: ChatProvider) => {
      if (
        trainingChatHandoff &&
        provider !== trainingChatHandoff.model.providerId
      ) {
        onTrainingChatHandoffDismiss();
      }
      changeDraftProvider(provider);
    },
    [changeDraftProvider, onTrainingChatHandoffDismiss, trainingChatHandoff]
  );
  const {
    chatColumnStyle,
    chatThreadPreparingInitialScroll,
    chatThreadRef,
    chatTimelineRows,
    composerStackRef,
    goToUserMessage,
    handleChatScroll,
    jumpToLatestChatMessage,
    showScrollToBottomButton,
    userMessageNavigation,
  } = useMainPaneChatScroll({
    browserConversationId,
    chatSubmissionVersion,
    chatHistoryHasMore,
    chatHistoryLoading,
    chatMessages,
    onLoadMoreChatHistory,
    pendingApproval,
    showChatThread,
    showThinkingIndicator,
    view,
  });
  const handleOpenBrowserLink = useCallback(
    (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => {
      void openBrowserLink({
        conversationId: browserConversationId,
        href,
        explicitFile: options?.explicitFile,
        newTab: options?.newTab,
      }).then((opened) => {
        if (opened) onShowBrowserPanel();
      });
    },
    [browserConversationId, onShowBrowserPanel]
  );
  const workspaceRootPath = resolveChatWorkspaceRootPath({
    projectTargetDetail: projectTarget.detail,
    projectTargetValue: projectTarget.value,
    workspaceRepoPath: workspaceState?.repoPath,
    workspaceTargetValue: workspaceTarget.value,
  });
  const handleOpenFileInSidebar = useCallback(
    (path: string) => {
      const videoPath = absoluteLocalVideoPath(path, workspaceRootPath);
      if (videoPath && connection) {
        void api
          .signLocalVideoUrl(connection, { path: videoPath })
          .then(({ url }) => handleOpenBrowserLink(url))
          .catch((error) => {
            showToast(
              error instanceof Error
                ? error.message
                : "Could not open this video.",
              "error"
            );
          });
        return;
      }
      const normalizedFile = normalizeChatFilePath(path, { workspaceRootPath });
      onShowDiffPanel();
      setOpenDiffFileRequest({
        id: Date.now(),
        path: normalizedFile?.path ?? path,
      });
    },
    [
      connection,
      handleOpenBrowserLink,
      onShowDiffPanel,
      showToast,
      workspaceRootPath,
    ]
  );
  const handleOpenAttachmentInSidebar = useCallback(
    async (attachment: ChatAttachmentSummary) => {
      if (
        !connection ||
        (!attachment.filePreview && !attachment.imagePreview)
      ) {
        showToast("File content is not available for this attachment.", "error");
        return;
      }
      try {
        const displayName =
          attachment.name.trim().replace(/[\\/]+/g, "-") || "attachment.txt";
        const attachmentId = attachment.id.replace(/[^a-zA-Z0-9._-]+/g, "-");
        const path = `Attachments/${attachmentId || "file"}/${displayName}`;
        const file: WorkspaceDiffFile = {
          path,
          status: "",
          additions: 0,
          deletions: 0,
          patch: "",
          content: null,
        };
        let imageUrl: string | undefined;
        if (attachment.filePreview) {
          const payload = await api.chatAttachmentFile(
            connection,
            attachment.filePreview,
          );
          file.content = payload.content;
        } else if (attachment.imagePreview) {
          const payload = await api.signChatAttachmentImageUrl(
            connection,
            attachment.imagePreview,
          );
          imageUrl = payload.url;
        }
        onShowDiffPanel();
        setOpenDiffFileRequest({
          id: Date.now(),
          path,
          file,
          ...(imageUrl ? { imageUrl } : {}),
        });
      } catch (error) {
        showToast(
          error instanceof Error
            ? error.message
            : "Could not open this attachment.",
          "error",
        );
      }
    },
    [connection, onShowDiffPanel, showToast],
  );
  const workspaceStatusLoading =
    workspaceBusy && Boolean(activeWorkspaceAppId) && !workspaceState;
  const candidateSidebarId = labCandidateReview.selection
    ? `candidate:${labCandidateReview.selection.runId}:${labCandidateReview.selection.candidateId}`
    : null;
  const diffPanel = showDiffPanel ? (
    <WorkspaceDiffPanel
      appId={
        showLabCandidateDiffPanel
          ? candidateSidebarId
          : rightSidebarUsesSandbox
          ? null
          : activeWorkspaceAppId
      }
      workspaceId={
        showLabCandidateDiffPanel
          ? candidateSidebarId
          : rightSidebarUsesSandbox
          ? rightSidebarSandboxId
          : activeWorkspaceAppId
      }
      workspaceKind={
        showLabCandidateDiffPanel
          ? "local_project"
          : rightSidebarUsesSandbox
          ? null
          : "local_project"
      }
      connection={connection}
      runtimeEvents={runtimeEvents}
      diff={
        showLabCandidateDiffPanel
          ? labCandidateReview.diff
          : rightSidebarUsesSandbox
          ? null
          : workspaceDiff
      }
      fileRootPath={
        showLabCandidateDiffPanel
          ? labCandidateReview.selection?.fileRootPath ?? null
          : rightSidebarUsesSandbox
          ? null
          : trainingTasksetRootPath
      }
      filesWithPreview={showLabCandidateDiffPanel}
      editorPreferences={bootstrap?.preferences.editor ?? null}
      loading={
        showLabCandidateDiffPanel
          ? labCandidateReview.loading
          : rightSidebarUsesSandbox
          ? workspaceBusy
          : diffBusy || workspaceStatusLoading
      }
      openFileRequest={
        showLabCandidateDiffPanel
          ? labCandidateReview.openFileRequest
          : openDiffFileRequest
      }
      sidebarFileBookmarks={sidebarFileBookmarks}
      sidebarFileSourceSessionId={selectedSessionId}
      onSetSidebarFileStatus={onSetSidebarFileStatus}
      readOnly={showLabCandidateDiffPanel}
      sideChatTabs={rightChatPanels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        running: panel.running,
      }))}
      sourceSwitcher={
        showLabCandidateDiffPanel ? null : rightSidebarSourceSwitcher
      }
      tabRequest={rightPanelTabRequest}
      viewState={workspaceDiffPanelViewState}
      workspaceName={
        showLabCandidateDiffPanel
          ? labCandidateReview.selection?.title ?? "Change"
          : rightSidebarUsesSandbox
          ? workspaceName ?? "Sandbox"
          : workspaceName
      }
      workspaceInitialized={
        showLabCandidateDiffPanel
          ? true
          : rightSidebarUsesSandbox
          ? Boolean(rightSidebarSandboxId)
          : Boolean(workspaceState?.initialized)
      }
      workspaceError={
        showLabCandidateDiffPanel
          ? labCandidateReview.error
          : rightSidebarUsesSandbox
          ? null
          : workspaceState?.error ?? workspaceDiff?.error ?? null
      }
      expanded={diffPanelExpanded}
      onResizeStart={onDiffPanelResizeStart}
      onRefresh={(options) =>
        void (showLabCandidateDiffPanel
          ? labCandidateReview.refresh(options)
          : refreshWorkspaceDiff(options))
      }
      onToggleExpanded={onToggleDiffPanelExpanded}
      onOpenBrowser={onShowBrowserPanel}
      onOpenBrowserUrl={handleOpenBrowserLink}
      onViewStateChange={onWorkspaceDiffPanelViewStateChange}
      onCloseSideChat={onCloseRightChatPanel}
      onOpenSideChat={view === "chat" ? onAddRightChat : undefined}
      onSelectSideChat={(panelId) => {
        onActivateRightChatPanel(panelId);
        onShowRightChatPanel();
      }}
      goalDetails={{
        active: rightPanelMode === "goal",
        createRuntime: createImproveRuntime,
        goalRuntime,
        subagentRuntime,
      }}
      sandboxFileSource={
        rightSidebarUsesSandbox
          ? {
              sandboxId: rightSidebarSandboxId,
              emptyMessage: "No sandbox filesystem yet.",
            }
          : null
      }
      trainingSummary={trainingSidebarSummary}
    />
  ) : null;
  const browserPanel = showBrowserPanel ? (
    <BrowserSidebar
      conversationId={browserConversationId}
      expanded={diffPanelExpanded}
      onResizeStart={onDiffPanelResizeStart}
    />
  ) : null;
  const teamAiThreadPanel = showTeamAiThreadPanel ? (
    <TeamAiThreadPanel
      {...teamChat}
      key={teamChat.aiThread?.conversationId}
      onResizeStart={onDiffPanelResizeStart}
    />
  ) : null;
  const teamAgentConversationPanel = showTeamAgentConversationPanel ? (
    <TeamAgentConversationPanel
      {...teamChat}
      key={teamChat.agentConversation?.run.id}
      onResizeStart={onDiffPanelResizeStart}
    />
  ) : null;
  const rightChatPanel = showRightChatPanel ? (
    <RightChatPanelStack
      panels={rightChatPanels}
      runtimeEventStore={runtimeEventStore}
      actionCatalog={composerActionCatalog}
      createImproveActions={createImproveActions}
      contextCompaction={appPreferences.contextCompaction}
      busy={busy}
      codexPermissionMode={codexPermissionMode}
      codexReasoningEffort={codexReasoningEffort}
      openPondCommandAccessMode={openPondCommandAccessMode}
      connection={connection}
      connectedAppMentions={connectedAppMentions}
      mentionApps={mentionApps}
      codexPersonalSkills={bootstrap?.codexPersonalSkills ?? []}
      profileSkills={profileSkills}
      profileLibrary={
        bootstrap?.profileLibrary ?? { lastUsed: null, profiles: [] }
      }
      extensionCatalog={bootstrap?.extensionCatalog ?? null}
      projectTarget={projectTarget}
      providerSettings={bootstrap?.providers ?? null}
      accountBaseUrl={accountBaseUrl}
      billingOrganizationSlug={billingTarget.organizationSlug}
      billingTeamId={billingTarget.teamId}
      showToast={showToast}
      workspaceTarget={workspaceTarget}
      onAddChat={onAddRightChat}
      onActivatePanel={onActivateRightChatPanel}
      onClosePanel={onCloseRightChatPanel}
      onCodexPermissionModeChange={changeCodexPermissionMode}
      onCodexReasoningEffortChange={changeCodexReasoningEffort}
      onOpenPondCommandAccessModeChange={changeOpenPondCommandAccessMode}
      onModelChange={onRightChatModelChange}
      onOpenAttachmentInSidebar={handleOpenAttachmentInSidebar}
      onOpenFileInSidebar={handleOpenFileInSidebar}
      onOpenProfileSettings={onOpenProfileSettings}
      onOpenSession={onOpenSession}
      onProviderChange={onRightChatProviderChange}
      onProviderSetupOpen={onOpenProviderSettings}
      onPromptChange={onRightChatPromptChange}
      onProfileTargetChange={(sessionId, value) =>
        void changeComposerProfile(value, sessionId)
      }
      onScrollStateChange={onRightChatScrollStateChange}
      onProjectTargetChange={changeProjectTarget}
      onResolveApproval={resolveApproval}
      onResizeStart={onDiffPanelResizeStart}
      onSelectFiles={onShowFilesPanel}
      onShowBrowserPanel={onShowBrowserPanel}
      onStop={onStopRightChat}
      onSubmit={onSubmitRightChat}
      onWorkspaceTargetChange={(target) => void changeWorkspaceTarget(target)}
    />
  ) : null;
  const homePanel = showRightHomePanel ? (
    <RightSidebarHomePanel
      expanded={diffPanelExpanded}
      terminalOpen={terminalOpen}
      sideChatAvailable={view === "chat" || view === "labs"}
      onOpenBrowser={onShowBrowserPanel}
      onOpenFiles={onShowFilesPanel}
      onOpenReview={onShowDiffPanel}
      onOpenSideChat={onAddRightChat}
      onOpenTrainingDraft={onShowTrainingDraftPanel}
      trainingDraftAvailable={Boolean(selectedSessionId)}
      onResizeStart={onDiffPanelResizeStart}
      onToggleExpanded={onToggleDiffPanelExpanded}
      onToggleTerminal={onToggleTerminal}
    />
  ) : null;
  const workPanel = showWorkPanel ? (
    <WorkSidebarPanel
      chatMessages={chatMessages}
      connection={connection}
      contextWindowStatus={contextWindowStatus}
      expanded={diffPanelExpanded}
      runtimeEvents={runtimeEvents}
      sessionId={selectedSessionId}
      showToast={showToast}
      onResizeStart={onDiffPanelResizeStart}
      onToggleExpanded={onToggleDiffPanelExpanded}
      onUseOutput={(file) =>
        setComposerAttachmentRequest({ id: Date.now(), file })
      }
      onHandoffOutput={async (target, output, file) => {
        await onExperienceHandoff({
          target,
          sourceSessionId: selectedSessionId!,
          output,
          prompt: outputHandoffPrompt(output, target),
        });
        if (file) {
          setComposerAttachmentRequest({ id: Date.now(), file });
        }
      }}
      onReviseOutput={(output, file, annotation) => {
        setComposerAttachmentRequest({ id: Date.now(), file });
        composerDraftStore.set(
          `Create revision ${output.revision + 1} of "${
            output.title
          }" from the attached revision ${
            output.revision
          }. Apply only this requested change:\n\n${annotation}`
        );
      }}
      onAgentPackageInstalled={async () => {
        if (!connection) return;
        onPayload(await api.bootstrap(connection));
      }}
    />
  ) : null;
  const trainingDraftPanel = showTrainingDraftPanel ? (
    <Suspense fallback={null}>
      <TrainingDraftPanel
        training={training}
        sessionId={selectedSessionId}
        expanded={diffPanelExpanded}
        onOpenTraining={() => setView("labs")}
        onResizeStart={onDiffPanelResizeStart}
        onToggleExpanded={onToggleDiffPanelExpanded}
      />
    </Suspense>
  ) : null;
  const nativeSkillPanel =
    showNativeSkillPanel && nativeSkillSidebar ? (
      <NativeSkillSidebar
        expanded={diffPanelExpanded}
        skill={nativeSkillSidebar}
        onClose={onCloseNativeSkillSidebar}
        onResizeStart={onDiffPanelResizeStart}
        onToggleExpanded={onToggleDiffPanelExpanded}
      />
    ) : null;
  const extensionSkillPanel =
    showExtensionSkillPanel && extensionSkillSidebar ? (
      <LabSkillSidebar
        connection={connection}
        expanded={diffPanelExpanded}
        selection={extensionSkillSidebar}
        onClose={onCloseNativeSkillSidebar}
        onResizeStart={onDiffPanelResizeStart}
        onToggleExpanded={onToggleDiffPanelExpanded}
      />
    ) : null;
  const labSkillPanel =
    showLabSkillPanel && labSkillSource ? (
      <LabSkillSidebar
        connection={connection}
        expanded={diffPanelExpanded}
        selection={labSkillSource}
        onClose={handleCloseLabSkillSource}
        onResizeStart={onDiffPanelResizeStart}
        onToggleExpanded={onToggleDiffPanelExpanded}
      />
    ) : null;
  const rightPanel =
    teamAgentConversationPanel ??
    teamAiThreadPanel ??
    rightChatPanel ??
    nativeSkillPanel ??
    extensionSkillPanel ??
    labSkillPanel ??
    diffPanel ??
    browserPanel ??
    trainingDraftPanel ??
    workPanel ??
    homePanel;
  const terminalPanel = (
    <Suspense fallback={null}>
      <AppTerminalPanel
        open={terminalOpen}
        connection={connection}
        scope={terminalScope}
        tabs={terminalTabs}
        onTabsChange={onTerminalTabsChange}
        cwd={terminalCwd}
        appId={activeWorkspaceAppId}
        workspaceName={workspaceName}
        queuedCommand={pendingTerminalCommand}
        onClose={onCloseTerminal}
      />
    </Suspense>
  );
  return (
    <main
      className={`main-pane ${viewClass} ${
        terminalOpen ? "terminal-open" : ""
      } ${showRightPanel ? "diff-open" : ""} ${
        rightPanelExpanded ? "diff-expanded" : ""
      }`}
    >
      {view === "team" || view === "community" ? (
        <Suspense fallback={null}>
          <CollaborationTabs onSelect={setView} view={view} />
        </Suspense>
      ) : null}
      {view === "apps" ? (
        <Suspense fallback={null}>
          <AppsView
            account={bootstrap?.account ?? null}
            connection={connection}
            defaultTeamId={bootstrap?.preferences.defaultTeamId ?? null}
            onToast={showToast}
          />
        </Suspense>
      ) : view === "team" ? (
        <Suspense fallback={null}>
          {teamChat.teamId ? (
            <TeamChatView {...teamChat} />
          ) : (
            <TeamChatProView />
          )}
          {showRightPanel ? rightPanel : null}
        </Suspense>
      ) : view === "community" ? (
        <Suspense fallback={null}>
          <CommunityView {...community} />
        </Suspense>
      ) : view === "get-started" ? (
        <Suspense fallback={null}>
          <GetStartedView />
        </Suspense>
      ) : view === "scheduled" ? (
        <Suspense fallback={null}>
          <ScheduledWorkPage
            connection={connection}
            detailOpen={scheduledDetailOpen}
            detailExpanded={diffPanelExpanded}
            onDetailOpenChange={onScheduledDetailOpenChange}
            onDetailResizeStart={onDiffPanelResizeStart}
            onToggleDetailExpanded={onToggleDiffPanelExpanded}
          />
        </Suspense>
      ) : view === "outputs" ? (
        <Suspense fallback={null}>
          <OutputsPage connection={connection} onViewChat={onOpenSession} />
        </Suspense>
      ) : view === "projects" ? (
        <Suspense fallback={null}>
          <ProjectsPage
            accountBaseUrl={projectsAccountBaseUrl}
            connection={connection}
            onNewCloudProject={onNewCloudProject}
            onNewTask={onNewProjectTask}
            onTogglePinned={onToggleProjectPinned}
            onUploadLocalProject={onUploadLocalProject}
            projects={projects}
            taskCountByProjectId={projectTaskCounts}
            teamName={projectsTeamName}
          />
        </Suspense>
      ) : view === "labs" ? (
        rightPanelExpanded ? (
          <Suspense fallback={null}>{rightPanel}</Suspense>
        ) : (
          <>
            <Suspense fallback={null}>
              <LabsRoute
                account={bootstrap?.account ?? null}
                closeDetailRequestId={labCloseDetailRequestId}
                closeDetailKind={labCloseDetailKind}
                onNewModel={(initialTasksetId, learnedPreferenceReward) => {
                  setTrainingLaunchRequest({
                    id: Date.now(),
                    objective: null,
                    initialSessionIds: [],
                    initialTasksetId,
                    learnedPreferenceReward,
                  });
                }}
                onUseAgent={handleUseAgent}
                onCreateAgent={createAgentFromLab}
                onImproveAgent={improveAgentFromLab}
                onDetailOpenChange={onLabDetailOpenChange}
                onSkillSelectionChange={handleLabSkillSelectionChange}
                onOpenRunConversation={onOpenRightChatForSession}
                onAnswerQuestion={answerCreateImproveQuestion}
                onApplyCandidate={applyCreateImproveCandidate}
                onApprove={approveCreateImproveRun}
                onCancel={cancelCreateImproveRun}
                candidateReview={{
                  diff: labCandidateReview.diff,
                  error: labCandidateReview.error,
                  loading: labCandidateReview.loading,
                }}
                onCandidateReviewChange={handleLabCandidateReviewChange}
                onOpenPullRequest={openCreateImprovePullRequest}
                onOpenCandidateFiles={handleOpenLabCandidateFiles}
                onPause={pauseCreateImproveRun}
                onReconcilePullRequest={reconcileCreateImprovePullRequest}
                onRejectCandidate={rejectCreateImproveCandidate}
                onResume={resumeCreateImproveRun}
                onRevise={reviseCreateImproveRun}
                profileView={{
                  payload: bootstrap,
                  connection,
                  onPayload,
                  onError,
                  onToast: showToast,
                  onSkillCommand: openProfileSkillCommand,
                }}
                training={{
                  training,
                  sessions: trainingSessions,
                  localProjects: bootstrap?.localProjects ?? [],
                  connection,
                  defaultModel: {
                    providerId: activeProvider,
                    modelId: activeModel,
                  },
                  onError,
                  onToast: showToast,
                  onSettingsPreferences: (payload) => {
                    if (bootstrap)
                      onPayload({
                        ...bootstrap,
                        preferences: payload.preferences,
                      });
                  },
                  onOpenTrainingSettings,
                  onOpenProviderSettings,
                  onOpenDatasetStorageSettings,
                  onOpenChat: onOpenSession,
                  onChatWithModel: onBeginNewChatWithModel,
                  onOpenTasksetFiles: onShowFilesPanel,
                  launchRequest:
                    sideChatTrainingLaunchRequest ?? trainingLaunchRequest,
                  onLaunchHandled: (id) => {
                    if (sideChatTrainingLaunchRequest?.id === id) {
                      onSideChatTrainingLaunchHandled(id);
                      return;
                    }
                    setTrainingLaunchRequest((current) =>
                      current?.id === id ? null : current
                    );
                  },
                  preferences: trainingPreferences,
                  settingsPreferences: appPreferences,
                  providerSettings: bootstrap?.providers ?? null,
                  reasoningEffort: codexReasoningEffort,
                  selectedTasksetId: activeTrainingTasksetId,
                  onSelectedTasksetIdChange: setSelectedTrainingTasksetId,
                  onSelectedTrainingJobIdChange: setSelectedTrainingJobId,
                  detailTasksetId: trainingDetailTasksetId,
                  onDetailTasksetIdChange: onTrainingDetailTasksetIdChange,
                }}
              />
            </Suspense>
            {terminalPanel}
            {showRightPanel ? (
              <Suspense fallback={null}>{rightPanel}</Suspense>
            ) : null}
          </>
        )
      ) : rightPanelExpanded ? (
        <Suspense fallback={null}>{rightPanel}</Suspense>
      ) : showChatThread ? (
        <>
          <div
            className={`chat-column ${pendingApproval ? "has-approval" : ""}`}
            style={chatColumnStyle}
          >
            <Suspense fallback={null}>
              <MainChatThread
                accountBaseUrl={accountBaseUrl}
                activeWorkspaceAppId={activeWorkspaceAppId}
                billingOrganizationSlug={billingTarget.organizationSlug}
                billingTeamId={billingTarget.teamId}
                connection={connection}
                conversationKey={browserConversationId ?? "draft"}
                creation={selectedTrainingCreation}
                onOpenBrowserLink={handleOpenBrowserLink}
                onOpenAttachmentInSidebar={handleOpenAttachmentInSidebar}
                onOpenFileInSidebar={handleOpenFileInSidebar}
                onOpenProfileSettings={onOpenProfileSettings}
                onResolveUserQuestion={async (_question, resolution) => {
                  const displayPrompt =
                    resolution.action === "answer"
                      ? resolution.text
                      : "Dismiss this question";
                  const sent = await sendPrompt([], null, displayPrompt, {
                    displayPrompt,
                    turnMetadata: { userQuestionResolution: resolution },
                  });
                  if (!sent)
                    throw new Error("The question response could not be sent.");
                }}
                onOpenSession={onOpenSession}
                onScroll={(event) => handleChatScroll(event.currentTarget)}
                rows={chatTimelineRows}
                sessionId={browserConversationId}
                turnRunning={turnRunning}
                userAttachmentDisplay={
                  activeProvider === "codex" ? "compact" : "full"
                }
                threadRef={chatThreadRef}
                workspaceRootPath={workspaceRootPath}
              />
            </Suspense>
            <div
              className={`composer-stack dock ${
                pendingApproval ? "has-approval" : ""
              }`}
              ref={composerStackRef}
            >
              {selectedTrainingCreation ? (
                <Suspense fallback={null}>
                  <TrainingCreationPanel
                    compact
                    creation={selectedTrainingCreation}
                    training={training}
                    onOpenTraining={() => setView("labs")}
                  />
                </Suspense>
              ) : null}
              {trainingChatHandoffBar}
              <ApprovalRequestCard
                approval={pendingApproval}
                onResolve={resolveApproval}
              />
              {showScrollToBottomButton && !chatThreadPreparingInitialScroll ? (
                <MessageNavigationControls
                  canGoNext={userMessageNavigation.canGoNext}
                  canGoPrevious={userMessageNavigation.canGoPrevious}
                  onJumpToLatest={jumpToLatestChatMessage}
                  onNext={() => {
                    if (userMessageNavigation.canGoNext)
                      goToUserMessage("next");
                  }}
                  onPrevious={() => {
                    if (userMessageNavigation.canGoPrevious)
                      goToUserMessage("previous");
                  }}
                />
              ) : null}
              <DraftBoundComposer
                experience={experience}
                draftStore={composerDraftStore}
                attachmentRequest={composerAttachmentRequest}
                mode="dock"
                focusRequestId={mainComposerFocusRequestId}
                mentionApps={repositoryWork ? mentionApps : []}
                connectedAppMentions={connectedAppMentions}
                profileSkills={
                  activeProvider === "codex"
                    ? bootstrap?.codexPersonalSkills ?? []
                    : selectedProfileSkills
                }
                selectedMentionAppId={selectedMentionAppId}
                contextWindowStatus={contextWindowStatus}
                goalRuntime={experience !== "chat" ? goalRuntime : null}
                subagentRuntime={
                  experience !== "chat" ? subagentRuntime : null
                }
                createImproveRuntime={
                  repositoryWork ? createImproveRuntime : null
                }
                busy={turnRunning}
                running={turnRunning}
                submissionScopeKey={composerSubmissionScopeKey}
                getCurrentSubmissionScopeKey={
                  getCurrentComposerSubmissionScopeKey
                }
                voiceInputChannelKey={`main-composer:${composerSubmissionScopeKey}`}
                showProjectFooter={false}
                connection={connection}
                providerSettings={bootstrap?.providers ?? null}
                provider={activeProvider}
                model={activeModel}
                projectTarget={projectTarget}
                profileTarget={null}
                actionCatalog={composerActionCatalog}
                requestedAction={requestedComposerAction}
                workspaceTarget={workspaceTarget}
                codexPermissionMode={codexPermissionMode}
                codexReasoningEffort={codexReasoningEffort}
                openPondCommandAccessMode={openPondCommandAccessMode}
                onProviderChange={changeMainComposerProvider}
                onProviderSetupOpen={onOpenProviderSettings}
                onProjectTargetChange={changeProjectTarget}
                onProfileTargetChange={(value) =>
                  void changeComposerProfile(value)
                }
                onWorkspaceTargetChange={(target) =>
                  void changeWorkspaceTarget(target)
                }
                onModelChange={changeMainComposerModel}
                onCodexPermissionModeChange={changeCodexPermissionMode}
                onCodexReasoningEffortChange={changeCodexReasoningEffort}
                onOpenPondCommandAccessModeChange={
                  changeOpenPondCommandAccessMode
                }
                onMentionAppSelect={setMentionedAppId}
                onSaveTaskDraft={onSaveTaskDraft}
                showToast={showToast}
                onSubmit={submitComposerPrompt}
                onStop={stopTurn}
              />
            </div>
          </div>
          {terminalPanel}
          <Suspense fallback={null}>{rightPanel}</Suspense>
        </>
      ) : (
        <>
          <section className="start-panel">
            <Suspense fallback={null}>
              <NewExperienceSwitcher
                value={experience === "chat" ? "chat" : "work"}
                onChange={onNewExperienceChange}
              />
            </Suspense>
            <div className="start-welcome">
              <h1>{startMessage}</h1>
              {canSyncWorkspace && (
                <WorkspaceSyncButton
                  busy={workspaceBusy}
                  onSync={() => void syncWorkspaceLocally()}
                />
              )}
            </div>
            <div className="composer-stack start">
              {trainingChatHandoffBar}
              <ApprovalRequestCard
                approval={pendingApproval}
                onResolve={resolveApproval}
              />
              <DraftBoundComposer
                experience={experience}
                draftStore={composerDraftStore}
                attachmentRequest={composerAttachmentRequest}
                mode="start"
                autoFocus
                focusRequestId={mainComposerFocusRequestId}
                mentionApps={repositoryWork ? mentionApps : []}
                connectedAppMentions={connectedAppMentions}
                profileSkills={
                  activeProvider === "codex"
                    ? bootstrap?.codexPersonalSkills ?? []
                    : selectedProfileSkills
                }
                selectedMentionAppId={selectedMentionAppId}
                contextWindowStatus={contextWindowStatus}
                goalRuntime={experience !== "chat" ? goalRuntime : null}
                subagentRuntime={
                  experience !== "chat" ? subagentRuntime : null
                }
                createImproveRuntime={
                  repositoryWork ? createImproveRuntime : null
                }
                busy={turnRunning}
                running={turnRunning}
                submissionScopeKey={composerSubmissionScopeKey}
                getCurrentSubmissionScopeKey={
                  getCurrentComposerSubmissionScopeKey
                }
                voiceInputChannelKey={`main-composer:${composerSubmissionScopeKey}`}
                connection={connection}
                providerSettings={bootstrap?.providers ?? null}
                provider={activeProvider}
                model={activeModel}
                showProjectFooter={experience !== "chat"}
                projectTarget={projectTarget}
                profileTarget={null}
                actionCatalog={composerActionCatalog}
                requestedAction={requestedComposerAction}
                workspaceTarget={workspaceTarget}
                codexPermissionMode={codexPermissionMode}
                codexReasoningEffort={codexReasoningEffort}
                openPondCommandAccessMode={openPondCommandAccessMode}
                onProviderChange={changeMainComposerProvider}
                onProviderSetupOpen={onOpenProviderSettings}
                onProjectTargetChange={changeProjectTarget}
                onProfileTargetChange={(value) =>
                  void changeComposerProfile(value)
                }
                onWorkspaceTargetChange={(target) =>
                  void changeWorkspaceTarget(target)
                }
                onModelChange={changeMainComposerModel}
                onCodexPermissionModeChange={changeCodexPermissionMode}
                onCodexReasoningEffortChange={changeCodexReasoningEffort}
                onOpenPondCommandAccessModeChange={
                  changeOpenPondCommandAccessMode
                }
                onMentionAppSelect={setMentionedAppId}
                onSaveTaskDraft={onSaveTaskDraft}
                showToast={showToast}
                onSubmit={submitComposerPrompt}
                onStop={stopTurn}
              />
            </div>
          </section>
          {terminalPanel}
          <Suspense fallback={null}>{rightPanel}</Suspense>
        </>
      )}
    </main>
  );
}

export { shouldShowRightSidebarHomePanel };

function sidebarFileMediaType(file: SidebarFileBookmark): string {
  const lowerPath = file.path.toLowerCase();
  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".mdx"))
    return "text/markdown";
  if (lowerPath.endsWith(".json")) return "application/json";
  if (lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml"))
    return "application/yaml";
  return "text/plain";
}
