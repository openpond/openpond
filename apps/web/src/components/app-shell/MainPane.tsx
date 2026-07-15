import {
  Suspense,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ArrowDown, ArrowLeft, ArrowRight, DownloadCloud } from "../icons";
import type {
  BootstrapPayload,
  ChatAttachment,
  ChatProvider,
  CloudProject,
  CloudWorkItem,
  CloudWorkItemDetail,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  InsightItem,
  InsightRun,
  InsightRunTrigger,
  InsightStatus,
  Approval,
  OpenPondApp,
  OpenPondProfileSkill,
  ResolveApprovalRequest,
  RuntimeEvent,
  Session,
  SubagentDelegationMode,
  UsageRequestAttribution,
  WorkspaceDiffSummary,
  WorkspaceKind,
  WorkspaceState,
  TerminalScope,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { normalizePreferences, type AppView, type ChatMessage, type LabsTab } from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { WorkspaceTargetState, WorkspaceTargetValue } from "../../lib/workspace-location";
import { ApprovalRequestCard } from "../chat/ApprovalRequestCard";
import { type ComposerProjectTargetState, type ComposerSubmitOptions } from "../chat/Composer";
import { DraftBoundComposer } from "../chat/DraftBoundComposer";
import { TrainingModelChatHandoffBar } from "../chat/TrainingModelChatHandoffBar";
import type { ComposerCreatePipelineRuntime } from "../chat/ComposerCreatePipelineStrip";
import type { CreatePipelineReviewActionInput } from "../chat/create-pipeline-types";
import { MessageRow, ThinkingIndicator } from "../chat/Messages";
import type { RightPanelMode, ShowAppToast } from "../../app/app-state";
import { openBrowserLink } from "../../lib/browser-sidebar-links";
import { normalizeChatFilePath } from "../../lib/chat-file-links";
import {
  buildChatTimelineRows,
  shouldShowThinkingIndicator,
} from "../../lib/chat-timeline-rows";
import {
  parseComposerSlashCommandPrompt,
  type ComposerSlashCommand,
} from "../../lib/composer-slash-commands";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import type { ComposerDraftStore } from "../../lib/composer-draft-store";
import {
  resolveRightSidebarFileSource,
  type RightSidebarFileSource,
} from "../../lib/right-sidebar-file-source";
import {
  buildSubmitIssueSlashPrompt,
  hasGitHubIssueSubmitConnection,
} from "../../lib/submit-issue-command";
import { isCloudWorkspaceKind } from "../../lib/workspace-location";
import { AppTerminalPanel } from "./AppTerminalPanel";
import { RightChatPanelStack, type RightChatPanelView } from "./RightChatPanelStack";
import { RightSidebarHomePanel } from "./RightSidebarHomePanel";
import { TrainingDraftPanel } from "../training/TrainingDraftPanel";
import { TrainingCreationPanel, TrainingStatusReceipt } from "../training/TrainingCreationPanel";
import { trainingCreationForSession } from "../training/training-flow";
import type { TrainingLaunchRequest } from "../training/TrainingView";
import type { TrainingSidebarSummary } from "../training/TrainingRunSidebarSummary";
import type { TrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import type { TerminalQueuedCommand, TerminalTab } from "../terminal/terminal-overlay-types";
import type {
  WorkspaceDiffPanelViewState,
  WorkspaceDiffTabRequest,
  WorkspaceFileSourceSwitcher,
} from "../workspace-diff/workspace-diff-panel-model";
import type { TeamChatViewProps } from "../team-chat/TeamChatView";
import type { CommunityViewProps } from "../community/CommunityView";
import type { useTraining } from "../../hooks/useTraining";
import {
  CHAT_HISTORY_TOP_THRESHOLD_PX,
  CHAT_USER_MESSAGE_SCROLL_OFFSET_PX,
  EMPTY_USER_MESSAGE_NAVIGATION,
  billingTargetForContext,
  cloudProjectIdFromComposerTarget,
  cloudWorkItemSandboxId,
  easeInOutCubic,
  easedChatScrollDuration,
  insightsSystemSessionId,
  isNearChatBottom,
  latestCreatePipelineRuntime,
  messageScrollTop,
  nextUserMessageTarget,
  promptForAppSlashCommand,
  sandboxIdFromWorkspaceName,
  shouldRunCreatePipelineCommandLocally,
  shouldSubmitComposerSlashCommandToChat,
  usageAttributionForComposerSlashCommand,
  userMessageNavigationState,
  type UserMessageNavigationState,
} from "./main-pane-helpers";
import {
  AppsView,
  BrowserSidebar,
  CloudWorkView,
  GetStartedView,
  LabsRoute,
  TeamAiThreadPanel,
  TeamAgentConversationPanel,
  TeamChatView,
  CommunityView,
  WorkspaceDiffPanel,
} from "./MainPaneLazyViews";

type MainPaneProps = {
  view: AppView;
  labsTab: LabsTab;
  setLabsTab: (tab: LabsTab) => void;
  teamChat: TeamChatViewProps;
  community: CommunityViewProps;
  bootstrap: BootstrapPayload | null;
  runtimeEvents: RuntimeEvent[];
  chatMessages: ChatMessage[];
  contextWindowStatus: ContextWindowStatus;
  goalRuntime: GoalRuntimeStatus | null;
  subagentRuntime: SubagentRuntimeStatus | null;
  selectedSessionId: string | null;
  composerDraftStore: ComposerDraftStore;
  mainComposerFocusRequestId: number;
  steerAutoDispatchBlocked: boolean;
  steerAutoDispatchReady: boolean;
  mentionApps: OpenPondApp[];
  connectedAppMentions: ConnectedAppMentionOption[];
  profileSkills: OpenPondProfileSkill[];
  selectedMentionAppId: string | null;
  busy: boolean;
  turnRunning: boolean;
  activeProvider: ChatProvider;
  activeModel: string;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  subagentDelegationDefaultMode: SubagentDelegationMode;
  subagentDelegationMode: SubagentDelegationMode | null;
  subagentDelegationAvailable: boolean;
  pendingApproval: Approval | null;
  activeWorkspaceAppId: string | null;
  activeWorkspaceId: string | null;
  activeWorkspaceKind: WorkspaceKind | null;
  projectTarget: ComposerProjectTargetState;
  actionCatalog: SandboxActionCatalogEntry[];
  workspaceTarget: WorkspaceTargetState;
  connection: ClientConnection | null;
  workspaceName: string | null;
  workspaceState: WorkspaceState | null;
  workspaceDiff: WorkspaceDiffSummary | null;
  workspaceBusy: boolean;
  diffBusy: boolean;
  forceChatThread?: boolean;
  diffPanelOpen: boolean;
  diffPanelExpanded: boolean;
  rightPanelMode: RightPanelMode;
  rightPanelTabRequest: WorkspaceDiffTabRequest | null;
  rightChatPanels: RightChatPanelView[];
  workspaceDiffPanelViewState: WorkspaceDiffPanelViewState;
  browserConversationId: string;
  terminalScope: TerminalScope;
  terminalTabs: TerminalTab[];
  terminalCwd: string | null;
  pendingTerminalCommand: TerminalQueuedCommand | null;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onWorkspaceDiffPanelViewStateChange: (state: WorkspaceDiffPanelViewState) => void;
  insightsItems: InsightItem[];
  insightsRuns: InsightRun[];
  insightsNextScanAt: string | null;
  insightsScanRunning: boolean;
  insightsScanStartedAt: string | null;
  insightsScanning: boolean;
  insightsError: string | null;
  training: ReturnType<typeof useTraining>;
  trainingSessions: Session[];
  trainingChatHandoff: TrainingModelChatHandoff | null;
  trainingDetailTasksetId: string | null;
  onTrainingDetailTasksetIdChange: (tasksetId: string | null) => void;
  onTrainingChatTaskSelect: (index: number) => void;
  onTrainingChatHandoffDismiss: () => void;
  onRunInsightsScan: (input?: { trigger?: InsightRunTrigger }) => Promise<unknown>;
  onAskInsightsQuestion: (question: string) => Promise<unknown>;
  onPatchInsightStatus: (insightId: string, status: InsightStatus) => Promise<unknown>;
  onOpenInsightsSession: (sessionId: string) => void;
  cloudProjects: CloudProject[];
  cloudWorkItems: CloudWorkItem[];
  selectedCloudWorkItem: CloudWorkItem | null;
  cloudWorkItemDetail: CloudWorkItemDetail | null;
  cloudWorkItemLocalProjectName: string | null;
  cloudLoading: boolean;
  cloudBusy: boolean;
  cloudError: string | null;
  chatHistoryHasMore?: boolean;
  chatHistoryLoading?: boolean;
  onDiffPanelResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  canSyncWorkspace: boolean;
  startMessage: string;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  setView: (view: AppView) => void;
  onOpenProfileSettings: () => void;
  onOpenProviderSettings: () => void;
  changeDraftProvider: (provider: ChatProvider) => void;
  changeProjectTarget: (target: string) => void;
  changeWorkspaceTarget: (target: WorkspaceTargetValue) => Promise<void>;
  setDraftProvider: (provider: ChatProvider) => void;
  setDraftModel: (model: string) => void;
  onBeginNewChatWithModel: (handoff: TrainingModelChatHandoff) => void;
  changeCodexPermissionMode: (mode: CodexPermissionMode) => void;
  changeCodexReasoningEffort: (effort: CodexReasoningEffort) => void;
  changeOpenPondCommandAccessMode: (mode: OpenPondCommandAccessMode, session?: Session | null) => void;
  changeSubagentDelegationMode: (mode: SubagentDelegationMode | null) => void;
  resolveApproval: (
    approvalId: string,
    decision: ResolveApprovalRequest["decision"],
  ) => Promise<void>;
  answerCreatePipelineQuestionTurn: (
    input: CreatePipelineReviewActionInput,
    questionId: string,
    answerValue: string,
  ) => Promise<void>;
  approveCreatePipelineTurn: (input: CreatePipelineReviewActionInput) => Promise<void>;
  cancelCreatePipelineTurn: (input: CreatePipelineReviewActionInput) => Promise<void>;
  reviseCreatePipelineTurn: (
    input: CreatePipelineReviewActionInput,
    revision: string,
  ) => Promise<void>;
  setMentionedAppId: (appId: string | null) => void;
  showToast: ShowAppToast;
  sendPrompt: (
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    promptOverride?: string,
    options?: { clearPrompt?: () => void; displayPrompt?: string; usageAttribution?: UsageRequestAttribution },
  ) => Promise<boolean>;
  stopTurn: () => Promise<boolean>;
  syncWorkspaceLocally: () => Promise<void>;
  refreshWorkspaceDiff: (options?: { silent?: boolean }) => Promise<void>;
  onToggleDiffPanelExpanded: () => void;
  onShowDiffPanel: () => void;
  onShowBrowserPanel: () => void;
  onShowGoalSidebarTab: () => void;
  onShowTrainingDraftPanel: () => void;
  onShowFilesPanel: () => void;
  onShowRightChatPanel: () => void;
  onAddRightChat: () => void;
  onTerminalTabsChange: Dispatch<SetStateAction<TerminalTab[]>>;
  onCloseRightChatPanel: (panelId: string) => void;
  onRightChatModelChange: (panelId: string, model: string) => void;
  onRightChatPromptChange: (panelId: string, prompt: string) => void;
  onRightChatProviderChange: (panelId: string, provider: ChatProvider) => void;
  onSubmitRightChat: (
    panelId: string,
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    command?: ComposerSlashCommand | null,
    options?: ComposerSubmitOptions,
  ) => Promise<boolean>;
  onStopRightChat: (sessionId: string | null) => Promise<boolean>;
  onCloseTerminal: () => void;
  onOpenCloudHome: () => void;
  onSetupCloudProject: (projectId: string) => void;
  onCreateCloudWork: (input: { projectId: string; prompt: string; select?: boolean }) => Promise<boolean>;
  onSelectCloudWorkItem: (workItem: CloudWorkItem) => void;
  onSendCloudWorkItemMessage: (message: string) => Promise<void>;
  onHandleCloudWorkItemBackground: (message: string | null) => Promise<void>;
  onCancelCloudWorkItemCreatePipeline: () => Promise<void>;
  onCancelCloudWorkItemTask: () => Promise<void>;
  onApplyCloudWorkItemPatchLocally: () => Promise<void>;
  onLoadMoreChatHistory?: () => Promise<boolean>;
};

export function MainPane({
  view,
  labsTab,
  setLabsTab,
  teamChat,
  community,
  bootstrap,
  runtimeEvents,
  chatMessages,
  contextWindowStatus,
  goalRuntime,
  subagentRuntime,
  selectedSessionId,
  composerDraftStore,
  mainComposerFocusRequestId,
  steerAutoDispatchBlocked,
  steerAutoDispatchReady,
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
  subagentDelegationDefaultMode,
  subagentDelegationMode,
  subagentDelegationAvailable,
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
  workspaceDiffPanelViewState,
  browserConversationId,
  terminalScope,
  terminalTabs,
  terminalCwd,
  pendingTerminalCommand,
  terminalOpen,
  onToggleTerminal,
  onWorkspaceDiffPanelViewStateChange,
  insightsItems,
  insightsRuns,
  insightsNextScanAt,
  insightsScanRunning,
  insightsScanStartedAt,
  insightsScanning,
  insightsError,
  training,
  trainingSessions,
  trainingChatHandoff,
  trainingDetailTasksetId,
  onTrainingDetailTasksetIdChange,
  onTrainingChatTaskSelect,
  onTrainingChatHandoffDismiss,
  onRunInsightsScan,
  onAskInsightsQuestion,
  onPatchInsightStatus,
  onOpenInsightsSession,
  cloudProjects,
  cloudWorkItems,
  selectedCloudWorkItem,
  cloudWorkItemDetail,
  cloudWorkItemLocalProjectName,
  cloudLoading,
  cloudBusy,
  cloudError,
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
  changeDraftProvider,
  changeProjectTarget,
  changeWorkspaceTarget,
  setDraftProvider,
  setDraftModel,
  onBeginNewChatWithModel,
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
  onTerminalTabsChange,
  onCloseRightChatPanel,
  onRightChatModelChange,
  onRightChatPromptChange,
  onRightChatProviderChange,
  onSubmitRightChat,
  onStopRightChat,
  onCloseTerminal,
  onOpenCloudHome,
  onSetupCloudProject,
  onCreateCloudWork,
  onSelectCloudWorkItem,
  onSendCloudWorkItemMessage,
  onHandleCloudWorkItemBackground,
  onCancelCloudWorkItemCreatePipeline,
  onCancelCloudWorkItemTask,
  onApplyCloudWorkItemPatchLocally,
  onLoadMoreChatHistory,
}: MainPaneProps) {
  const chatThreadRef = useRef<HTMLElement | null>(null);
  const composerStackRef = useRef<HTMLDivElement | null>(null);
  const stickyChatScrollRef = useRef(true);
  const previousConversationKeyRef = useRef<string | null>(null);
  const pendingChatScrollRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const remoteHistoryLoadPendingRef = useRef(false);
  const initialChatScrollPendingRef = useRef(false);
  const autoChatScrollPendingRef = useRef(false);
  const autoChatScrollFrameRef = useRef<number | null>(null);
  const smoothChatScrollFrameRef = useRef<number | null>(null);
  const [initialChatScrollVersion, setInitialChatScrollVersion] = useState(0);
  const [initialChatScrollReadyKey, setInitialChatScrollReadyKey] = useState<string | null>(null);
  const [showScrollToBottomButton, setShowScrollToBottomButton] = useState(false);
  const [chatComposerReservePx, setChatComposerReservePx] = useState(132);
  const [userMessageNavigation, setUserMessageNavigation] = useState<UserMessageNavigationState>(
    EMPTY_USER_MESSAGE_NAVIGATION,
  );
  const [openDiffFileRequest, setOpenDiffFileRequest] = useState<{ id: number; path: string } | null>(null);
  const [rightSidebarSourceOverride, setRightSidebarSourceOverride] = useState<RightSidebarFileSource | null>(null);
  const [trainingLaunchRequest, setTrainingLaunchRequest] = useState<TrainingLaunchRequest | null>(null);
  const [selectedTrainingTasksetId, setSelectedTrainingTasksetId] = useState<string | null>(null);
  const [selectedTrainingJobId, setSelectedTrainingJobId] = useState<string | null>(null);
  const [insightsPreferenceSaving, setInsightsPreferenceSaving] = useState(false);
  const appPreferences = useMemo(
    () => normalizePreferences(bootstrap?.preferences),
    [bootstrap?.preferences],
  );
  const trainingPreferences = appPreferences.training;
  const updateInsightsEnabled = useCallback(async (enabled: boolean) => {
    if (!connection || !bootstrap || insightsPreferenceSaving) return;
    setInsightsPreferenceSaving(true);
    onError(null);
    try {
      const payload = await api.savePreferences(connection, { insightsEnabled: enabled });
      onPayload({ ...bootstrap, preferences: payload.preferences });
      showToast(enabled ? "Observation scanning enabled" : "Observation scanning disabled", "success");
    } catch (preferenceError) {
      onError(preferenceError instanceof Error ? preferenceError.message : String(preferenceError));
    } finally {
      setInsightsPreferenceSaving(false);
    }
  }, [bootstrap, connection, insightsPreferenceSaving, onError, onPayload, showToast]);
  const activeTrainingTasksetId = useMemo(() => {
    const tasksets = training.payload?.tasksets ?? [];
    return tasksets.some((taskset) => taskset.id === selectedTrainingTasksetId)
      ? selectedTrainingTasksetId
      : tasksets[0]?.id ?? null;
  }, [selectedTrainingTasksetId, training.payload?.tasksets]);
  const trainingTasksetRootPath = view === "labs" && (labsTab === "models" || labsTab === "evals") && activeTrainingTasksetId
    ? `profiles/${bootstrap?.profile.activeProfile ?? "default"}/tasksets/${activeTrainingTasksetId}`
    : null;
  const trainingSidebarSummary = useMemo<TrainingSidebarSummary | null>(() => {
    if (view !== "labs" || labsTab !== "models" || !activeTrainingTasksetId || !training.payload) return null;
    const taskset = training.payload.tasksets.find((item) => item.id === activeTrainingTasksetId);
    if (!taskset) return null;
    const plans = training.payload.plans.filter((plan) => plan.tasksetId === taskset.id);
    const planIds = new Set(plans.map((plan) => plan.id));
    const jobs = training.payload.jobs.filter((item) => planIds.has(item.planId)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const job = jobs.find((item) => item.id === selectedTrainingJobId) ?? jobs[0] ?? null;
    const plan = job ? plans.find((item) => item.id === job.planId) ?? null : plans.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    const lineage = job ? training.payload.models.find((item) => item.jobId === job.id) ?? null : null;
    const artifacts = job ? training.payload.artifacts.filter((item) => item.jobId === job.id) : [];
    return { taskset, plan, job, lineage, artifacts };
  }, [activeTrainingTasksetId, labsTab, selectedTrainingJobId, training.payload, view]);
  const selectedTrainingCreation = useMemo(
    () => trainingCreationForSession(training.payload, selectedSessionId),
    [selectedSessionId, training.payload],
  );
  const selectedCloudSandboxId = useMemo(
    () => cloudWorkItemSandboxId(selectedCloudWorkItem, cloudWorkItemDetail),
    [cloudWorkItemDetail, selectedCloudWorkItem],
  );
  const latestCreateRuntime = useMemo(() => latestCreatePipelineRuntime(chatMessages), [chatMessages]);
  const hasGoalDetails = Boolean(goalRuntime) || Boolean(latestCreateRuntime) || Boolean(subagentRuntime);
  const showCloudDiffPanel =
    view === "cloud" &&
    diffPanelOpen &&
    (rightPanelMode === "changes" || (rightPanelMode === "goal" && hasGoalDetails)) &&
    Boolean(selectedCloudWorkItem);
  const showLocalDiffPanel = (view === "chat" || view === "labs") && Boolean(activeWorkspaceAppId);
  const showEmptyRightChatFallbackPanel =
    view === "chat" && diffPanelOpen && rightPanelMode === "chat" && rightChatPanels.length === 0;
  const chatSandboxId = isCloudWorkspaceKind(activeWorkspaceKind)
    ? activeWorkspaceId ?? sandboxIdFromWorkspaceName(workspaceName)
    : null;
  const showChatSandboxDiffPanel = view === "chat" && Boolean(chatSandboxId);
  const rightSidebarSandboxId = showCloudDiffPanel ? selectedCloudSandboxId : chatSandboxId;
  const rightSidebarSandboxSourceAvailable =
    Boolean(rightSidebarSandboxId) ||
    showCloudDiffPanel ||
    workspaceTarget.value === "cloud" ||
    workspaceTarget.value === "hybrid";
  const rightSidebarSourceState = useMemo(
    () =>
      resolveRightSidebarFileSource({
        workspaceTarget: showCloudDiffPanel ? "cloud" : workspaceTarget.value,
        localWorkspaceId: showCloudDiffPanel ? null : activeWorkspaceAppId,
        sandboxSourceAvailable: rightSidebarSandboxSourceAvailable,
        sandboxWorkspaceId: rightSidebarSandboxId,
        override: rightSidebarSourceOverride,
      }),
    [
      activeWorkspaceAppId,
      rightSidebarSandboxSourceAvailable,
      rightSidebarSandboxId,
      rightSidebarSourceOverride,
      showCloudDiffPanel,
      workspaceTarget.value,
    ],
  );
  const rightSidebarSource = rightSidebarSourceState.source;
  const rightSidebarUsesSandbox = rightSidebarSource === "sandbox";
  const rightSidebarSourceSwitcher = useMemo<WorkspaceFileSourceSwitcher | null>(
    () =>
      rightSidebarSource && rightSidebarSourceState.options.length > 1
        ? {
          value: rightSidebarSource,
          options: rightSidebarSourceState.options,
          onChange: setRightSidebarSourceOverride,
        }
        : null,
    [rightSidebarSource, rightSidebarSourceState.options],
  );
  useEffect(() => {
    setRightSidebarSourceOverride(null);
  }, [activeWorkspaceAppId, browserConversationId, rightSidebarSandboxId, showCloudDiffPanel, workspaceTarget.value]);
  const showDiffPanel =
    (showLocalDiffPanel || showCloudDiffPanel || showChatSandboxDiffPanel) &&
    diffPanelOpen &&
    (rightPanelMode === "changes" || (rightPanelMode === "goal" && hasGoalDetails) || showEmptyRightChatFallbackPanel);
  const showBrowserPanel = (view === "chat" || view === "cloud") && diffPanelOpen && rightPanelMode === "browser";
  const showRightChatPanel =
    view === "chat" && diffPanelOpen && rightPanelMode === "chat" && rightChatPanels.length > 0;
  const showTrainingDraftPanel = view === "chat" && diffPanelOpen && rightPanelMode === "training";
  const showTeamAiThreadPanel =
    view === "team" && diffPanelOpen && rightPanelMode === "chat" && Boolean(teamChat.aiThread);
  const showTeamAgentConversationPanel =
    view === "team" &&
    diffPanelOpen &&
    rightPanelMode === "chat" &&
    Boolean(teamChat.agentConversation);
  const showRightHomePanel = shouldShowRightSidebarHomePanel({
    supportedView: view === "chat" || view === "cloud" || view === "labs",
    open: diffPanelOpen,
    hasContentPanel:
      showDiffPanel ||
      showBrowserPanel ||
      showRightChatPanel ||
      showTrainingDraftPanel ||
      showTeamAiThreadPanel ||
      showTeamAgentConversationPanel,
  });
  const showRightPanel =
    showDiffPanel ||
    showBrowserPanel ||
    showRightChatPanel ||
    showTrainingDraftPanel ||
    showTeamAiThreadPanel ||
    showTeamAgentConversationPanel ||
    showRightHomePanel;
  const rightPanelExpanded = showRightPanel && rightPanelMode !== "chat" && diffPanelExpanded;
  const accountBaseUrl = bootstrap?.account.baseUrl ?? bootstrap?.account.activeProfile?.baseUrl ?? null;
  const billingTarget = billingTargetForContext({
    activeWorkspaceId,
    cloudProjects,
    selectedCloudWorkItem,
  });
  const showThinkingIndicator =
    view === "chat" && turnRunning && !pendingApproval && shouldShowThinkingIndicator(chatMessages);
  const showChatThread = forceChatThread || chatMessages.length > 0 || showThinkingIndicator;
  const composerSubmissionScopeKey =
    selectedSessionId ??
    `draft:${view}:${activeWorkspaceKind ?? "none"}:${activeWorkspaceId ?? activeWorkspaceAppId ?? "none"}`;
  const trainingChatHandoffBar =
    trainingChatHandoff?.model.providerId === activeProvider &&
    trainingChatHandoff.model.modelId === activeModel
      ? (
          <TrainingModelChatHandoffBar
            busy={turnRunning}
            handoff={trainingChatHandoff}
            onDismiss={onTrainingChatHandoffDismiss}
            onSelectTask={onTrainingChatTaskSelect}
          />
        )
      : null;
  const createPipelineRuntime = useMemo<ComposerCreatePipelineRuntime | null>(() => {
    return latestCreateRuntime
      ? {
          ...latestCreateRuntime,
          onAnswerQuestion: answerCreatePipelineQuestionTurn,
          onApprove: approveCreatePipelineTurn,
          onCancel: cancelCreatePipelineTurn,
          onRevise: reviseCreatePipelineTurn,
        }
      : null;
  }, [
    answerCreatePipelineQuestionTurn,
    approveCreatePipelineTurn,
    cancelCreatePipelineTurn,
    latestCreateRuntime,
    reviseCreatePipelineTurn,
  ]);
  const viewClass =
    view === "team"
      ? "team-active"
      : view === "community"
        ? "community-active"
      : view === "apps" || view === "get-started" || view === "labs"
      ? "page-active"
      : view === "cloud"
        ? "cloud-active"
      : showChatThread
        ? "chat-active"
        : "chat-start";
  const slashCommandCloudProjectId =
    selectedCloudWorkItem?.projectId ??
    cloudProjectIdFromComposerTarget(projectTarget.value) ??
    (cloudProjects.length === 1 ? cloudProjects[0]?.id ?? null : null);
  const submitComposerPrompt = useCallback(
    async (
      attachments: ChatAttachment[] = [],
      action: SandboxActionCatalogEntry | null = null,
      selectedCommand: ComposerSlashCommand | null = null,
      options: ComposerSubmitOptions = {},
    ) => {
      const promptForSubmit = options.promptOverride ?? composerDraftStore.getSnapshot();
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
          if (command.command === "insights") {
            if (attachments.length > 0) {
              showToast("/insights does not accept attachments.", "error");
              return false;
            }
            clearMainPrompt();
            if (command.args.trim()) {
              const payload = await onAskInsightsQuestion(command.args.trim());
              const sessionId = insightsSystemSessionId(payload);
              if (sessionId) {
                onOpenInsightsSession(sessionId);
              } else {
                setLabsTab("signals");
                setView("labs");
              }
              return true;
            }
            setLabsTab("signals");
            setView("labs");
            const payload = await onRunInsightsScan({ trigger: "slash_command" });
            if (payload && typeof payload === "object" && "summary" in payload) {
              const summary = payload.summary as { activeCount?: number; highestActiveSeverity?: string | null };
              const activeCount = summary.activeCount ?? 0;
              const severity = summary.highestActiveSeverity ? ` Highest severity: ${summary.highestActiveSeverity}.` : "";
              showToast(`${activeCount} active insight${activeCount === 1 ? "" : "s"}.${severity}`, "info");
            }
            return true;
          }
          if (command.command === "train") {
            if (attachments.length > 0) {
              showToast("/train uses the selected chat; add other chats from Lab.", "error");
              return false;
            }
            if (!selectedSessionId) {
              clearMainPrompt();
              setTrainingLaunchRequest({ id: Date.now(), objective: command.args.trim() || null, initialSessionIds: [] });
              setLabsTab("models");
              setView("labs");
              return true;
            }
            clearMainPrompt();
            setTrainingLaunchRequest({ id: Date.now(), objective: command.args.trim() || null, initialSessionIds: [selectedSessionId] });
            setLabsTab("models");
            setView("labs");
            return true;
          }
          if (!command.args && command.command !== "skill" && command.command !== "sync-cloud") {
            showToast(`Add instructions after /${command.command}.`, "info");
            return false;
          }
          if (attachments.length > 0) {
            showToast(`/${command.command} tasks do not accept attachments yet. Add file context in the task thread.`, "error");
            return false;
          }
          if (command.command === "submit-issue") {
            if (!hasGitHubIssueSubmitConnection(connectedAppMentions)) {
              showToast("Connect the GitHub app before using /submit-issue.", "error");
              return false;
            }
            return sendPrompt([], null, buildSubmitIssueSlashPrompt(command.args), {
              clearPrompt: options.preservePrompt ? () => undefined : undefined,
              usageAttribution: usageAttributionForComposerSlashCommand(
                command,
                selectedCommand ? "composer_selection" : "prompt_parse",
              ),
            });
          }
          if (
            shouldSubmitComposerSlashCommandToChat(command) ||
            shouldRunCreatePipelineCommandLocally({
              command,
              profile: bootstrap?.profile,
              activeWorkspaceKind,
              view,
            })
          ) {
            return sendPrompt([], null, promptForAppSlashCommand(command), {
              clearPrompt: options.preservePrompt ? () => undefined : undefined,
              usageAttribution: usageAttributionForComposerSlashCommand(
                command,
                selectedCommand ? "composer_selection" : "prompt_parse",
              ),
            });
          }
          if (!slashCommandCloudProjectId) {
            showToast(`Select a Cloud Project before using /${command.command}.`, "error");
            return false;
          }
          const created = await onCreateCloudWork({
            projectId: slashCommandCloudProjectId,
            prompt: promptForAppSlashCommand(command),
          });
          if (created) {
            clearMainPrompt();
          }
          return created;
        }
      }
      return sendPrompt(attachments, action, options.promptOverride, {
        clearPrompt: options.preservePrompt ? () => undefined : undefined,
        displayPrompt: options.displayPrompt,
      });
    },
    [
      activeModel,
      activeProvider,
      activeWorkspaceKind,
      bootstrap?.profile,
      connectedAppMentions,
      onAskInsightsQuestion,
      onOpenInsightsSession,
      onCreateCloudWork,
      onRunInsightsScan,
      composerDraftStore,
      sendPrompt,
      selectedSessionId,
      setLabsTab,
      setMentionedAppId,
      setView,
      showToast,
      slashCommandCloudProjectId,
      training,
      view,
    ],
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
    ],
  );
  const changeMainComposerProvider = useCallback(
    (provider: ChatProvider) => {
      if (trainingChatHandoff && provider !== trainingChatHandoff.model.providerId) {
        onTrainingChatHandoffDismiss();
      }
      changeDraftProvider(provider);
    }, [changeDraftProvider, onTrainingChatHandoffDismiss, trainingChatHandoff]);
  const chatTimelineRows = useMemo(
    () => buildChatTimelineRows(chatMessages, { showThinkingIndicator }),
    [chatMessages, showThinkingIndicator],
  );
  const chatColumnStyle = useMemo(
    () => ({ "--chat-composer-reserve": `${chatComposerReservePx}px` }) as CSSProperties,
    [chatComposerReservePx],
  );
  const latestChatMessage = chatMessages.at(-1);
  const chatScrollContentKey = [
    chatTimelineRows.length,
    latestChatMessage?.id ?? "",
    latestChatMessage?.content?.length ?? 0,
    latestChatMessage?.timestamp ?? "",
    showThinkingIndicator ? "thinking" : "",
  ].join(":");
  const canLoadOlderChatMessages = chatHistoryHasMore;
  const conversationKey = browserConversationId;
  const chatThreadPreparingInitialScroll =
    view === "chat" &&
    showChatThread &&
    Boolean(conversationKey) &&
    initialChatScrollReadyKey !== conversationKey;
  const setChatAwayFromBottom = useCallback((awayFromBottom: boolean) => {
    setShowScrollToBottomButton((current) => (current === awayFromBottom ? current : awayFromBottom));
  }, []);
  const setUserMessageNavigationState = useCallback((state: UserMessageNavigationState) => {
    setUserMessageNavigation((current) =>
      current.canGoPrevious === state.canGoPrevious && current.canGoNext === state.canGoNext
        ? current
        : state,
    );
  }, []);
  const updateChatScrollControls = useCallback(
    (element: HTMLElement, options: { nearBottom?: boolean } = {}) => {
      const nearBottom = options.nearBottom ?? isNearChatBottom(element);
      setChatAwayFromBottom(!nearBottom);
      setUserMessageNavigationState(userMessageNavigationState(element));
    },
    [setChatAwayFromBottom, setUserMessageNavigationState],
  );
  const finishInitialChatScroll = useCallback((key: string | null) => {
    const wasPending = initialChatScrollPendingRef.current;
    initialChatScrollPendingRef.current = false;
    setInitialChatScrollReadyKey(key);
    setChatAwayFromBottom(false);
    setUserMessageNavigationState(EMPTY_USER_MESSAGE_NAVIGATION);
    if (wasPending) setInitialChatScrollVersion((version) => version + 1);
  }, [setChatAwayFromBottom, setUserMessageNavigationState]);
  const cancelSmoothChatScroll = useCallback(() => {
    if (smoothChatScrollFrameRef.current === null || typeof window === "undefined") return;
    window.cancelAnimationFrame(smoothChatScrollFrameRef.current);
    smoothChatScrollFrameRef.current = null;
  }, []);
  const smoothScrollChatTo = useCallback(
    (element: HTMLElement, targetScrollTop: number | (() => number), onSettled?: () => void) => {
      cancelSmoothChatScroll();
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      const readTarget = () => {
        const nextTarget = typeof targetScrollTop === "function" ? targetScrollTop() : targetScrollTop;
        return Math.max(0, Math.min(nextTarget, Math.max(0, element.scrollHeight - element.clientHeight)));
      };
      const target = Math.max(0, Math.min(readTarget(), maxScrollTop));
      const start = element.scrollTop;
      const distance = target - start;
      const reduceMotion =
        typeof window === "undefined" ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

      if (reduceMotion || Math.abs(distance) < 1) {
        element.scrollTop = target;
        onSettled?.();
        return;
      }

      const duration = easedChatScrollDuration(distance);
      const startTime = window.performance.now();
      const step = (now: number) => {
        if (chatThreadRef.current !== element) {
          smoothChatScrollFrameRef.current = null;
          return;
        }

        const progress = Math.min(1, (now - startTime) / duration);
        const currentTarget = readTarget();
        element.scrollTop = start + (currentTarget - start) * easeInOutCubic(progress);
        if (progress < 1) {
          smoothChatScrollFrameRef.current = window.requestAnimationFrame(step);
          return;
        }

        element.scrollTop = readTarget();
        smoothChatScrollFrameRef.current = null;
        onSettled?.();
      };

      smoothChatScrollFrameRef.current = window.requestAnimationFrame(step);
    },
    [cancelSmoothChatScroll],
  );
  const cancelScheduledChatBottomScroll = useCallback(() => {
    autoChatScrollPendingRef.current = false;
    if (autoChatScrollFrameRef.current === null || typeof window === "undefined") return;
    window.cancelAnimationFrame(autoChatScrollFrameRef.current);
    autoChatScrollFrameRef.current = null;
  }, []);
  const scrollChatToBottom = useCallback(
    (
      element: HTMLElement,
      options: { conversationKey?: string | null; finishInitial?: boolean; settle?: boolean } = {},
    ) => {
      const scrollOnce = () => {
        element.scrollTop = element.scrollHeight;
      };

      scrollOnce();

      if (typeof window === "undefined") {
        if (options.finishInitial) finishInitialChatScroll(options.conversationKey ?? null);
        return;
      }

      cancelScheduledChatBottomScroll();
      autoChatScrollPendingRef.current = true;
      let frameCount = 0;
      let stableBottomFrames = 0;
      let lastScrollHeight = element.scrollHeight;
      const maxFrameCount = options.settle ? 12 : 2;
      const settle = () => {
        const currentElement = chatThreadRef.current;
        if (!currentElement) {
          autoChatScrollFrameRef.current = null;
          autoChatScrollPendingRef.current = false;
          if (options.finishInitial) finishInitialChatScroll(options.conversationKey ?? null);
          return;
        }
        currentElement.scrollTop = currentElement.scrollHeight;

        const distanceFromBottom =
          currentElement.scrollHeight - currentElement.scrollTop - currentElement.clientHeight;
        const scrollHeightStable = Math.abs(currentElement.scrollHeight - lastScrollHeight) <= 1;
        lastScrollHeight = currentElement.scrollHeight;
        stableBottomFrames =
          distanceFromBottom <= 1 && scrollHeightStable ? stableBottomFrames + 1 : 0;
        frameCount += 1;
        if (frameCount < maxFrameCount && stableBottomFrames < 2) {
          autoChatScrollFrameRef.current = window.requestAnimationFrame(settle);
          return;
        }

        autoChatScrollFrameRef.current = null;
        autoChatScrollPendingRef.current = false;
        stickyChatScrollRef.current = true;
        setChatAwayFromBottom(false);
        setUserMessageNavigationState(userMessageNavigationState(currentElement));
        if (options.finishInitial) finishInitialChatScroll(options.conversationKey ?? null);
      };
      autoChatScrollFrameRef.current = window.requestAnimationFrame(settle);
    },
    [cancelScheduledChatBottomScroll, finishInitialChatScroll, setChatAwayFromBottom, setUserMessageNavigationState],
  );
  const jumpToLatestChatMessage = useCallback(() => {
    const element = chatThreadRef.current;
    if (!element) return;
    cancelScheduledChatBottomScroll();
    stickyChatScrollRef.current = true;
    setChatAwayFromBottom(false);
    smoothScrollChatTo(element, () => element.scrollHeight - element.clientHeight, () => {
      if (chatThreadRef.current !== element) return;
      element.scrollTop = element.scrollHeight;
      stickyChatScrollRef.current = true;
      setChatAwayFromBottom(false);
      setUserMessageNavigationState(userMessageNavigationState(element));
    });
  }, [cancelScheduledChatBottomScroll, setChatAwayFromBottom, setUserMessageNavigationState, smoothScrollChatTo]);
  const goToUserMessage = useCallback(
    (direction: "previous" | "next") => {
      const element = chatThreadRef.current;
      if (!element) return;
      const target = nextUserMessageTarget(element, direction);
      if (!target) return;

      cancelScheduledChatBottomScroll();
      const nextScrollTop = () =>
        target.isConnected
          ? Math.max(0, messageScrollTop(element, target) - CHAT_USER_MESSAGE_SCROLL_OFFSET_PX)
          : element.scrollTop;
      smoothScrollChatTo(element, nextScrollTop, () => {
        if (chatThreadRef.current !== element) return;
        const nearBottom = isNearChatBottom(element);
        stickyChatScrollRef.current = nearBottom;
        updateChatScrollControls(element, { nearBottom });
      });
    },
    [cancelScheduledChatBottomScroll, smoothScrollChatTo, updateChatScrollControls],
  );
  const rememberChatScrollPosition = useCallback(() => {
    const element = chatThreadRef.current;
    if (!element) return;
    pendingChatScrollRestoreRef.current = {
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
    stickyChatScrollRef.current = false;
  }, []);
  const loadOlderChatMessages = useCallback(async () => {
    if (!canLoadOlderChatMessages) return;
    if (!onLoadMoreChatHistory || chatHistoryLoading || remoteHistoryLoadPendingRef.current) return;
    rememberChatScrollPosition();
    remoteHistoryLoadPendingRef.current = true;
    try {
      await onLoadMoreChatHistory();
    } finally {
      remoteHistoryLoadPendingRef.current = false;
    }
  }, [
    canLoadOlderChatMessages,
    chatHistoryLoading,
    onLoadMoreChatHistory,
    rememberChatScrollPosition,
  ]);
  const handleChatScroll = useCallback(
    (element: HTMLElement) => {
      if (autoChatScrollPendingRef.current) {
        stickyChatScrollRef.current = true;
        setChatAwayFromBottom(false);
        setUserMessageNavigationState(EMPTY_USER_MESSAGE_NAVIGATION);
        return;
      }
      const nearBottom = isNearChatBottom(element);
      stickyChatScrollRef.current = nearBottom;
      updateChatScrollControls(element, { nearBottom });
      if (
        !initialChatScrollPendingRef.current &&
        element.scrollTop <= CHAT_HISTORY_TOP_THRESHOLD_PX &&
        canLoadOlderChatMessages &&
        !chatHistoryLoading
      ) {
        void loadOlderChatMessages();
      }
    },
    [
      canLoadOlderChatMessages,
      chatHistoryLoading,
      loadOlderChatMessages,
      setChatAwayFromBottom,
      setUserMessageNavigationState,
      updateChatScrollControls,
    ],
  );
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
    [browserConversationId, onShowBrowserPanel],
  );
  const workspaceRootPath = workspaceTarget.value === "local"
    ? workspaceState?.repoPath ?? workspaceTarget.detail
    : workspaceState?.repoPath ?? null;
  const handleOpenFileInSidebar = useCallback(
    (path: string) => {
      const normalizedFile = normalizeChatFilePath(path, { workspaceRootPath });
      onShowDiffPanel();
      setOpenDiffFileRequest({ id: Date.now(), path: normalizedFile?.path ?? path });
    },
    [onShowDiffPanel, workspaceRootPath],
  );
  useLayoutEffect(() => {
    if (view !== "chat" || !showChatThread || typeof window === "undefined") return undefined;
    const element = composerStackRef.current;
    if (!element) return undefined;

    let animationFrame: number | null = null;
    const updateReserve = () => {
      animationFrame = null;
      const nextReserve = Math.max(96, Math.ceil(element.getBoundingClientRect().height + 20));
      setChatComposerReservePx((current) => (current === nextReserve ? current : nextReserve));
    };
    const scheduleUpdate = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(updateReserve);
    };

    scheduleUpdate();
    const resizeObserver =
      typeof window.ResizeObserver === "undefined" ? null : new window.ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [showChatThread, view]);
  useLayoutEffect(() => {
    const element = chatThreadRef.current;
    if (view !== "chat" || !showChatThread || !element || initialChatScrollPendingRef.current) return;
    if (!stickyChatScrollRef.current && !isNearChatBottom(element)) return;
    stickyChatScrollRef.current = true;
    scrollChatToBottom(element, { settle: true });
  }, [chatComposerReservePx, scrollChatToBottom, showChatThread, view]);

  useLayoutEffect(() => {
    pendingChatScrollRestoreRef.current = null;
    remoteHistoryLoadPendingRef.current = false;
    initialChatScrollPendingRef.current = true;
    stickyChatScrollRef.current = true;
    cancelSmoothChatScroll();
    cancelScheduledChatBottomScroll();
    setInitialChatScrollReadyKey(null);
    setChatAwayFromBottom(false);
    setUserMessageNavigationState(EMPTY_USER_MESSAGE_NAVIGATION);
  }, [
    cancelScheduledChatBottomScroll,
    cancelSmoothChatScroll,
    conversationKey,
    setChatAwayFromBottom,
    setUserMessageNavigationState,
  ]);
  useEffect(() => {
    const element = chatThreadRef.current;
    if (
      view !== "chat" ||
      !element ||
      initialChatScrollPendingRef.current ||
      !canLoadOlderChatMessages ||
      chatHistoryLoading
    ) {
      return;
    }
    if (element.scrollTop <= CHAT_HISTORY_TOP_THRESHOLD_PX && element.scrollHeight <= element.clientHeight + CHAT_HISTORY_TOP_THRESHOLD_PX) {
      void loadOlderChatMessages();
    }
  }, [
    canLoadOlderChatMessages,
    chatHistoryLoading,
    initialChatScrollVersion,
    chatTimelineRows.length,
    loadOlderChatMessages,
    view,
  ]);
  useLayoutEffect(() => {
    const restore = pendingChatScrollRestoreRef.current;
    const element = chatThreadRef.current;
    if (!restore || !element || initialChatScrollPendingRef.current) return;
    pendingChatScrollRestoreRef.current = null;
    element.scrollTop = restore.scrollTop + Math.max(0, element.scrollHeight - restore.scrollHeight);
    updateChatScrollControls(element);
  }, [chatTimelineRows.length, updateChatScrollControls]);
  useLayoutEffect(() => {
    const element = chatThreadRef.current;
    if (view !== "chat" || !conversationKey || !element) {
      previousConversationKeyRef.current = conversationKey;
      stickyChatScrollRef.current = true;
      finishInitialChatScroll(conversationKey);
      return;
    }

    const conversationChanged = previousConversationKeyRef.current !== conversationKey;
    previousConversationKeyRef.current = conversationKey;

    if (conversationChanged || initialChatScrollPendingRef.current) {
      stickyChatScrollRef.current = true;
      scrollChatToBottom(element, { conversationKey, finishInitial: true, settle: true });
      return;
    }

    const nearBottom = isNearChatBottom(element);
    if (stickyChatScrollRef.current || nearBottom) {
      stickyChatScrollRef.current = true;
      setChatAwayFromBottom(false);
      setUserMessageNavigationState(userMessageNavigationState(element));
      scrollChatToBottom(element, { settle: true });
      return;
    }
    updateChatScrollControls(element, { nearBottom });
  }, [
    chatScrollContentKey,
    conversationKey,
    finishInitialChatScroll,
    pendingApproval?.id,
    scrollChatToBottom,
    setChatAwayFromBottom,
    setUserMessageNavigationState,
    updateChatScrollControls,
    view,
  ]);
  useEffect(
    () => () => {
      cancelScheduledChatBottomScroll();
      cancelSmoothChatScroll();
    },
    [cancelScheduledChatBottomScroll, cancelSmoothChatScroll],
  );
  const workspaceStatusLoading = workspaceBusy && Boolean(activeWorkspaceAppId) && !workspaceState;
  const diffPanel = showDiffPanel ? (
    <WorkspaceDiffPanel
      appId={rightSidebarUsesSandbox ? null : activeWorkspaceAppId}
      workspaceId={rightSidebarUsesSandbox ? rightSidebarSandboxId : activeWorkspaceAppId}
      workspaceKind={rightSidebarUsesSandbox ? null : "local_project"}
      connection={connection}
      runtimeEvents={runtimeEvents}
      diff={rightSidebarUsesSandbox ? null : workspaceDiff}
      fileRootPath={rightSidebarUsesSandbox ? null : trainingTasksetRootPath}
      editorPreferences={bootstrap?.preferences.editor ?? null}
      loading={rightSidebarUsesSandbox ? cloudLoading : diffBusy || workspaceStatusLoading}
      openFileRequest={openDiffFileRequest}
      sideChatTabs={rightChatPanels.map((panel) => ({ id: panel.id, title: panel.title }))}
      sourceSwitcher={rightSidebarSourceSwitcher}
      tabRequest={rightPanelTabRequest}
      viewState={workspaceDiffPanelViewState}
      workspaceName={rightSidebarUsesSandbox ? selectedCloudWorkItem?.title ?? "Sandbox" : workspaceName}
      workspaceInitialized={rightSidebarUsesSandbox ? Boolean(rightSidebarSandboxId) : Boolean(workspaceState?.initialized)}
      workspaceError={rightSidebarUsesSandbox ? null : workspaceState?.error ?? workspaceDiff?.error ?? null}
      expanded={diffPanelExpanded}
      onResizeStart={onDiffPanelResizeStart}
      onRefresh={(options) => void refreshWorkspaceDiff(options)}
      onToggleExpanded={onToggleDiffPanelExpanded}
      onOpenBrowser={onShowBrowserPanel}
      onOpenBrowserUrl={handleOpenBrowserLink}
      onViewStateChange={onWorkspaceDiffPanelViewStateChange}
      onCloseSideChat={onCloseRightChatPanel}
      onOpenSideChat={view === "chat" ? onAddRightChat : undefined}
      onSelectSideChat={() => onShowRightChatPanel()}
      goalDetails={{
        active: rightPanelMode === "goal",
        createRuntime: createPipelineRuntime
          ? {
              request: createPipelineRuntime.request,
              snapshot: createPipelineRuntime.snapshot,
              turnId: createPipelineRuntime.turnId,
            }
          : null,
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
      busy={busy}
      codexPermissionMode={codexPermissionMode}
      codexReasoningEffort={codexReasoningEffort}
      openPondCommandAccessMode={openPondCommandAccessMode}
      connection={connection}
      connectedAppMentions={connectedAppMentions}
      mentionApps={mentionApps}
      profileSkills={profileSkills}
      projectTarget={projectTarget}
      providerSettings={bootstrap?.providers ?? null}
      accountBaseUrl={accountBaseUrl}
      billingOrganizationSlug={billingTarget.organizationSlug}
      billingTeamId={billingTarget.teamId}
      showToast={showToast}
      workspaceTarget={workspaceTarget}
      onAddChat={onAddRightChat}
      onClosePanel={onCloseRightChatPanel}
      onCodexPermissionModeChange={changeCodexPermissionMode}
      onCodexReasoningEffortChange={changeCodexReasoningEffort}
      onOpenPondCommandAccessModeChange={changeOpenPondCommandAccessMode}
      onModelChange={onRightChatModelChange}
      onOpenFileInSidebar={handleOpenFileInSidebar}
      onOpenProfileSettings={onOpenProfileSettings}
      onOpenSession={onOpenInsightsSession}
      onProviderChange={onRightChatProviderChange}
      onProviderSetupOpen={onOpenProviderSettings}
      onPromptChange={onRightChatPromptChange}
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
      sideChatAvailable={view === "chat"}
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
  const trainingDraftPanel = showTrainingDraftPanel ? (
    <TrainingDraftPanel
      training={training}
      sessionId={selectedSessionId}
      expanded={diffPanelExpanded}
      onOpenTraining={() => { setLabsTab("models"); setView("labs"); }}
      onResizeStart={onDiffPanelResizeStart}
      onToggleExpanded={onToggleDiffPanelExpanded}
    />
  ) : null;
  const rightPanel =
    teamAgentConversationPanel ??
    teamAiThreadPanel ??
    rightChatPanel ??
    diffPanel ??
    browserPanel ??
    trainingDraftPanel ??
    homePanel;
  const terminalPanel = (
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
  );
  const cloudView = (
    <CloudWorkView
      projects={cloudProjects}
      workItems={cloudWorkItems}
      selectedWorkItem={selectedCloudWorkItem}
      detail={cloudWorkItemDetail}
      loading={cloudLoading}
      actionBusy={cloudBusy}
      error={cloudError}
      model={activeModel}
      onBack={onOpenCloudHome}
      connection={connection}
      showToast={showToast}
      onModelChange={changeMainComposerModel}
      onSetupCloudProject={onSetupCloudProject}
      onCreateWork={onCreateCloudWork}
      onSelectWorkItem={onSelectCloudWorkItem}
      onSendMessage={onSendCloudWorkItemMessage}
      onHandleBackground={onHandleCloudWorkItemBackground}
      onCancelCreatePlan={onCancelCloudWorkItemCreatePipeline}
      onCancelTask={onCancelCloudWorkItemTask}
      localProjectName={cloudWorkItemLocalProjectName}
      onApplyLocalPatch={onApplyCloudWorkItemPatchLocally}
      onShowFiles={selectedCloudSandboxId ? onShowFilesPanel : undefined}
    />
  );
  return (
    <main
      className={`main-pane ${viewClass} ${terminalOpen ? "terminal-open" : ""} ${showRightPanel ? "diff-open" : ""} ${
        rightPanelExpanded ? "diff-expanded" : ""
      }`}
    >
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
          <TeamChatView {...teamChat} />
          {showRightPanel ? rightPanel : null}
        </Suspense>
      ) : view === "community" ? (
        <Suspense fallback={null}>
          <CommunityView {...community} />
        </Suspense>
      ) : view === "get-started" ? (
        <Suspense fallback={null}>
          <GetStartedView
            onCreateAgent={() => {
              composerDraftStore.set("/create ");
              setMentionedAppId(null);
              setView("chat");
            }}
            onOpenApps={() => setView("apps")}
            onOpenChat={() => setView("chat")}
            onOpenCloud={() => setView("cloud")}
            onOpenProfile={() => { setLabsTab("profile"); setView("labs"); }}
          />
        </Suspense>
      ) : view === "labs" ? (
        rightPanelExpanded ? (
          <Suspense fallback={null}>{rightPanel}</Suspense>
        ) : (
          <>
            <Suspense fallback={null}>
              <LabsRoute
                activeTab={labsTab}
                onNewModel={() => {
                  setLabsTab("models");
                  setTrainingLaunchRequest({ id: Date.now(), objective: null, initialSessionIds: [] });
                }}
                onTabChange={setLabsTab}
                profileView={{
                  payload: bootstrap,
                  connection,
                  onPayload,
                  onError,
                  onToast: showToast,
                  onSkillCommand: (command) => {
                    composerDraftStore.set(command);
                    setMentionedAppId(null);
                    setView("chat");
                  },
                }}
                insights={{
                  enabled: appPreferences.insightsEnabled,
                  items: insightsItems,
                  runs: insightsRuns,
                  nextScanAt: insightsNextScanAt,
                  scanRunning: insightsScanRunning,
                  scanStartedAt: insightsScanStartedAt,
                  scanning: insightsScanning,
                  savingEnabled: insightsPreferenceSaving,
                  error: insightsError,
                  onEnabledChange: updateInsightsEnabled,
                  onPatchStatus: onPatchInsightStatus,
                  onOpenSession: onOpenInsightsSession,
                }}
                training={{
                  training,
                  sessions: trainingSessions,
                  localProjects: bootstrap?.localProjects ?? [],
                  connection,
                  defaultModel: { providerId: activeProvider, modelId: activeModel },
                  onError,
                  onToast: showToast,
                  onSettingsPreferences: (payload) => {
                    if (bootstrap) onPayload({ ...bootstrap, preferences: payload.preferences });
                  },
                  onOpenChat: onOpenInsightsSession,
                  onChatWithModel: onBeginNewChatWithModel,
                  onOpenTasksetFiles: onShowFilesPanel,
                  launchRequest: trainingLaunchRequest,
                  onLaunchHandled: (id) => setTrainingLaunchRequest((current) => current?.id === id ? null : current),
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
            {showRightPanel ? <Suspense fallback={null}>{rightPanel}</Suspense> : null}
          </>
        )
      ) : view === "cloud" ? (
        <>
          <Suspense fallback={null}>{cloudView}</Suspense>
          {terminalPanel}
          {showRightPanel ? <Suspense fallback={null}>{rightPanel}</Suspense> : null}
        </>
      ) : rightPanelExpanded ? (
        <Suspense fallback={null}>{rightPanel}</Suspense>
      ) : showChatThread ? (
        <>
          <div className={`chat-column ${pendingApproval ? "has-approval" : ""}`} style={chatColumnStyle}>
            <section
              className={`chat-thread${chatThreadPreparingInitialScroll ? " initial-scroll-pending" : ""}`}
              aria-label="Conversation"
              ref={chatThreadRef}
              onScroll={(event) => {
                handleChatScroll(event.currentTarget);
              }}
            >
              {chatTimelineRows.map((row) =>
                row.type === "thinking" ? (
                  <ThinkingIndicator key={row.id} />
                ) : (
                  <MessageRow
                    activeWorkspaceAppId={activeWorkspaceAppId}
                    accountBaseUrl={accountBaseUrl}
                    billingOrganizationSlug={billingTarget.organizationSlug}
                    billingTeamId={billingTarget.teamId}
                    connection={connection}
                    key={row.id}
                    message={row.message}
                    onOpenFileInSidebar={handleOpenFileInSidebar}
                    onOpenBrowserLink={handleOpenBrowserLink}
                    onOpenProfileSettings={onOpenProfileSettings}
                    onOpenSession={onOpenInsightsSession}
                    workspaceRootPath={workspaceRootPath}
                    showFooter={row.showFooter}
                  />
                ),
              )}
              {selectedTrainingCreation ? <TrainingStatusReceipt creation={selectedTrainingCreation} /> : null}
            </section>
            <div className={`composer-stack dock ${pendingApproval ? "has-approval" : ""}`} ref={composerStackRef}>
              {selectedTrainingCreation ? (
                <TrainingCreationPanel
                  compact
                  creation={selectedTrainingCreation}
                  training={training}
                  onOpenTraining={() => { setLabsTab("models"); setView("labs"); }}
                />
              ) : null}
              {trainingChatHandoffBar}
              <ApprovalRequestCard approval={pendingApproval} onResolve={resolveApproval} />
              {showScrollToBottomButton && !chatThreadPreparingInitialScroll ? (
                <div className="chat-scroll-controls" aria-label="Message navigation">
                  <button
                    type="button"
                    className="chat-scroll-control-button"
                    data-tooltip="Go to previous message"
                    aria-label="Go to previous message"
                    aria-disabled={!userMessageNavigation.canGoPrevious}
                    onClick={() => {
                      if (userMessageNavigation.canGoPrevious) goToUserMessage("previous");
                    }}
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <button
                    type="button"
                    className="chat-scroll-control-button primary"
                    data-tooltip="Jump to latest"
                    aria-label="Jump to latest"
                    onClick={jumpToLatestChatMessage}
                  >
                    <ArrowDown size={18} />
                  </button>
                  <button
                    type="button"
                    className="chat-scroll-control-button"
                    data-tooltip="Go to next message"
                    aria-label="Go to next message"
                    aria-disabled={!userMessageNavigation.canGoNext}
                    onClick={() => {
                      if (userMessageNavigation.canGoNext) goToUserMessage("next");
                    }}
                  >
                    <ArrowRight size={17} />
                  </button>
                </div>
              ) : null}
              <DraftBoundComposer
                draftStore={composerDraftStore}
                mode="dock"
                focusRequestId={mainComposerFocusRequestId}
                mentionApps={mentionApps}
                connectedAppMentions={connectedAppMentions}
                profileSkills={profileSkills}
                selectedMentionAppId={selectedMentionAppId}
                contextWindowStatus={contextWindowStatus}
                goalRuntime={goalRuntime}
                subagentRuntime={subagentRuntime}
                createPipelineRuntime={createPipelineRuntime}
                busy={turnRunning}
                running={turnRunning}
                submissionScopeKey={composerSubmissionScopeKey}
                steerAutoDispatchBlocked={steerAutoDispatchBlocked || Boolean(pendingApproval)}
                steerAutoDispatchReady={steerAutoDispatchReady && !pendingApproval}
                showProjectFooter={false}
                connection={connection}
                providerSettings={bootstrap?.providers ?? null}
                provider={activeProvider}
                model={activeModel}
                projectTarget={projectTarget}
                actionCatalog={actionCatalog}
                workspaceTarget={workspaceTarget}
                codexPermissionMode={codexPermissionMode}
                codexReasoningEffort={codexReasoningEffort}
                openPondCommandAccessMode={openPondCommandAccessMode}
                subagentDelegationDefaultMode={subagentDelegationAvailable ? subagentDelegationDefaultMode : undefined}
                subagentDelegationMode={subagentDelegationMode}
                onProviderChange={changeMainComposerProvider}
                onProviderSetupOpen={onOpenProviderSettings}
                onProjectTargetChange={changeProjectTarget}
                onWorkspaceTargetChange={(target) => void changeWorkspaceTarget(target)}
                onModelChange={changeMainComposerModel}
                onCodexPermissionModeChange={changeCodexPermissionMode}
                onCodexReasoningEffortChange={changeCodexReasoningEffort}
                onOpenPondCommandAccessModeChange={changeOpenPondCommandAccessMode}
                onSubagentDelegationModeChange={subagentDelegationAvailable ? changeSubagentDelegationMode : undefined}
                onMentionAppSelect={setMentionedAppId}
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
            <h1>{startMessage}</h1>
            {canSyncWorkspace && (
              <button
                type="button"
                className="sync-local-button"
                disabled={workspaceBusy}
                onClick={() => void syncWorkspaceLocally()}
              >
                <DownloadCloud size={15} />
                <span>{workspaceBusy ? "Syncing locally" : "Sync locally to work on this"}</span>
              </button>
            )}
            <div className="composer-stack start">
              {trainingChatHandoffBar}
              <ApprovalRequestCard approval={pendingApproval} onResolve={resolveApproval} />
              <DraftBoundComposer
                draftStore={composerDraftStore}
                mode="start"
                autoFocus
                focusRequestId={mainComposerFocusRequestId}
                mentionApps={mentionApps}
                connectedAppMentions={connectedAppMentions}
                profileSkills={profileSkills}
                selectedMentionAppId={selectedMentionAppId}
                contextWindowStatus={contextWindowStatus}
                goalRuntime={goalRuntime}
                subagentRuntime={subagentRuntime}
                createPipelineRuntime={createPipelineRuntime}
                busy={turnRunning}
                running={turnRunning}
                submissionScopeKey={composerSubmissionScopeKey}
                steerAutoDispatchBlocked={steerAutoDispatchBlocked || Boolean(pendingApproval)}
                steerAutoDispatchReady={steerAutoDispatchReady && !pendingApproval}
                connection={connection}
                providerSettings={bootstrap?.providers ?? null}
                provider={activeProvider}
                model={activeModel}
                projectTarget={projectTarget}
                actionCatalog={actionCatalog}
                workspaceTarget={workspaceTarget}
                codexPermissionMode={codexPermissionMode}
                codexReasoningEffort={codexReasoningEffort}
                openPondCommandAccessMode={openPondCommandAccessMode}
                subagentDelegationDefaultMode={subagentDelegationAvailable ? subagentDelegationDefaultMode : undefined}
                subagentDelegationMode={subagentDelegationMode}
                onProviderChange={changeMainComposerProvider}
                onProviderSetupOpen={onOpenProviderSettings}
                onProjectTargetChange={changeProjectTarget}
                onWorkspaceTargetChange={(target) => void changeWorkspaceTarget(target)}
                onModelChange={changeMainComposerModel}
                onCodexPermissionModeChange={changeCodexPermissionMode}
                onCodexReasoningEffortChange={changeCodexReasoningEffort}
                onOpenPondCommandAccessModeChange={changeOpenPondCommandAccessMode}
                onSubagentDelegationModeChange={subagentDelegationAvailable ? changeSubagentDelegationMode : undefined}
                onMentionAppSelect={setMentionedAppId}
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

export function shouldShowRightSidebarHomePanel(input: {
  supportedView: boolean;
  open: boolean;
  hasContentPanel: boolean;
}): boolean {
  return input.supportedView && input.open && !input.hasContentPanel;
}
