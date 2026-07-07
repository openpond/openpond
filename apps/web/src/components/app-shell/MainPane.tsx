import {
  lazy,
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
  UsageRequestAttribution,
  WorkspaceDiffSummary,
  WorkspaceKind,
  WorkspaceState,
  TerminalScope,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { AppView, ChatMessage } from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { WorkspaceTargetState, WorkspaceTargetValue } from "../../lib/workspace-location";
import { ApprovalRequestCard } from "../chat/ApprovalRequestCard";
import { Composer, type ComposerProjectTargetState, type ComposerSubmitOptions } from "../chat/Composer";
import type { ComposerCreatePipelineRuntime } from "../chat/ComposerCreatePipelineStrip";
import type { CreatePipelineReviewActionInput } from "../chat/create-pipeline-types";
import { MessageRow, ThinkingIndicator } from "../chat/Messages";
import type { RightPanelMode, ShowAppToast } from "../../app/app-state";
import { openBrowserLink } from "../../lib/browser-sidebar-links";
import {
  buildChatTimelineRows,
  shouldShowThinkingIndicator,
} from "../../lib/chat-timeline-rows";
import {
  parseComposerSlashCommandPrompt,
  type ComposerSlashCommand,
  type ParsedComposerSlashCommand,
} from "../../lib/composer-slash-commands";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
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
import type { TerminalQueuedCommand, TerminalTab } from "../terminal/terminal-overlay-types";
import type { WorkspaceDiffTabRequest, WorkspaceFileSourceSwitcher } from "../workspace-diff/workspace-diff-panel-model";

const WorkspaceDiffPanel = lazy(() =>
  import("../workspace-diff/WorkspaceDiffPanel").then((module) => ({ default: module.WorkspaceDiffPanel })),
);
const AppsView = lazy(() =>
  import("../apps/AppsView").then((module) => ({ default: module.AppsView })),
);
const GetStartedView = lazy(() =>
  import("../get-started/GetStartedView").then((module) => ({ default: module.GetStartedView })),
);
const ProfileView = lazy(() =>
  import("../profile/ProfileView").then((module) => ({ default: module.ProfileView })),
);
const BrowserSidebar = lazy(() =>
  import("../browser/BrowserSidebar").then((module) => ({ default: module.BrowserSidebar })),
);
const CloudWorkView = lazy(() =>
  import("../cloud/CloudWorkView").then((module) => ({ default: module.CloudWorkView })),
);
const InsightsView = lazy(() =>
  import("../insights/InsightsView").then((module) => ({ default: module.InsightsView })),
);

type MainPaneProps = {
  view: AppView;
  bootstrap: BootstrapPayload | null;
  runtimeEvents: RuntimeEvent[];
  chatMessages: ChatMessage[];
  contextWindowStatus: ContextWindowStatus;
  goalRuntime: GoalRuntimeStatus | null;
  subagentRuntime: SubagentRuntimeStatus | null;
  prompt: string;
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
  browserConversationId: string;
  terminalScope: TerminalScope;
  terminalTabs: TerminalTab[];
  terminalCwd: string | null;
  pendingTerminalCommand: TerminalQueuedCommand | null;
  terminalOpen: boolean;
  insightsItems: InsightItem[];
  insightsRuns: InsightRun[];
  insightsNextScanAt: string | null;
  insightsScanRunning: boolean;
  insightsScanStartedAt: string | null;
  insightsScanning: boolean;
  insightsError: string | null;
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
  changeCodexPermissionMode: (mode: CodexPermissionMode) => void;
  changeCodexReasoningEffort: (effort: CodexReasoningEffort) => void;
  changeOpenPondCommandAccessMode: (mode: OpenPondCommandAccessMode, session?: Session | null) => void;
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
  setPrompt: (prompt: string) => void;
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
  onCloseRightPanel: () => void;
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

const CHAT_AUTOSCROLL_THRESHOLD_PX = 72;
const CHAT_HISTORY_TOP_THRESHOLD_PX = 120;
const CHAT_USER_MESSAGE_SCROLL_OFFSET_PX = 24;
const CHAT_NAVIGATION_SCROLL_MIN_DURATION_MS = 280;
const CHAT_NAVIGATION_SCROLL_MAX_DURATION_MS = 460;

function isNearChatBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_AUTOSCROLL_THRESHOLD_PX;
}

function insightsSystemSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { systemSessionId?: unknown }).systemSessionId;
  return typeof value === "string" && value.trim() ? value : null;
}

type UserMessageNavigationState = {
  canGoPrevious: boolean;
  canGoNext: boolean;
};

const EMPTY_USER_MESSAGE_NAVIGATION: UserMessageNavigationState = {
  canGoPrevious: false,
  canGoNext: false,
};

function userMessageRows(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>(".message-row.user")).filter(
    (row) => row.parentElement === element,
  );
}

function billingTargetForContext({
  activeWorkspaceId,
  cloudProjects,
  selectedCloudWorkItem,
}: {
  activeWorkspaceId: string | null;
  cloudProjects: CloudProject[];
  selectedCloudWorkItem: CloudWorkItem | null;
}): { organizationSlug: string | null; teamId: string | null } {
  const selectedProject = cloudProjects.find((project) =>
    project.id === activeWorkspaceId ||
    project.id === selectedCloudWorkItem?.projectId ||
    project.teamId === selectedCloudWorkItem?.teamId
  );
  const fallbackProject = cloudProjects.find((project) => project.organizationSlug || project.teamId);
  const project = selectedProject ?? fallbackProject ?? null;
  return {
    organizationSlug: project?.organizationSlug ?? null,
    teamId: project?.teamId ?? selectedCloudWorkItem?.teamId ?? null,
  };
}

function messageScrollTop(element: HTMLElement, message: HTMLElement): number {
  return message.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
}

function messageScrollBottom(element: HTMLElement, message: HTMLElement): number {
  return messageScrollTop(element, message) + message.getBoundingClientRect().height;
}

function userMessageNavigationAnchor(element: HTMLElement): number {
  return element.scrollTop + CHAT_USER_MESSAGE_SCROLL_OFFSET_PX;
}

function previousUserMessageThreshold(element: HTMLElement): number {
  return element.scrollTop + 8;
}

function userMessageNavigationState(element: HTMLElement): UserMessageNavigationState {
  const anchor = userMessageNavigationAnchor(element);
  const previousThreshold = previousUserMessageThreshold(element);
  let canGoPrevious = false;
  let canGoNext = false;
  for (const row of userMessageRows(element)) {
    const top = messageScrollTop(element, row);
    if (messageScrollBottom(element, row) < previousThreshold) canGoPrevious = true;
    if (top > anchor + 8) canGoNext = true;
    if (canGoPrevious && canGoNext) break;
  }
  return { canGoPrevious, canGoNext };
}

function nextUserMessageTarget(
  element: HTMLElement,
  direction: "previous" | "next",
): HTMLElement | null {
  const rows = userMessageRows(element);
  const anchor = userMessageNavigationAnchor(element);
  if (direction === "previous") {
    const previousThreshold = previousUserMessageThreshold(element);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (messageScrollBottom(element, row) < previousThreshold) return row;
    }
    return null;
  }

  for (const row of rows) {
    if (messageScrollTop(element, row) > anchor + 8) return row;
  }
  return null;
}

function easedChatScrollDuration(distance: number): number {
  return Math.min(
    CHAT_NAVIGATION_SCROLL_MAX_DURATION_MS,
    Math.max(CHAT_NAVIGATION_SCROLL_MIN_DURATION_MS, Math.abs(distance) / 5),
  );
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function latestCreatePipelineRuntime(
  messages: ChatMessage[],
): Pick<ComposerCreatePipelineRuntime, "request" | "snapshot" | "turnId"> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!message.createPipelineRequest) continue;
    if (message.createPipeline?.state === "cancelled") continue;
    return {
      turnId: message.turnId ?? null,
      request: message.createPipelineRequest,
      snapshot: message.createPipeline ?? null,
    };
  }
  return null;
}

function cloudProjectIdFromComposerTarget(value: string): string | null {
  return value.startsWith("cloud:") ? value.slice("cloud:".length) || null : null;
}

function promptForAppSlashCommand(command: ParsedComposerSlashCommand): string {
  if (command.command === "create") return `/create ${command.args}`;
  if (command.command === "edit") return `/edit ${command.args}`;
  if (command.command === "skill") return command.args ? `/skill ${command.args}` : "/skill";
  if (command.command === "sync-cloud") return command.args ? `/sync-cloud ${command.args}` : "/sync-cloud";
  if (command.command === "goal-local") return `Goal: ${command.args}`;
  return `Goal: ${command.args}`;
}

function usageAttributionForComposerSlashCommand(
  command: ParsedComposerSlashCommand,
  commandSource: UsageRequestAttribution["commandSource"],
): UsageRequestAttribution {
  return {
    surface: "chat",
    workflowKind: "slash_command",
    commandName: `/${command.command}`,
    commandSource,
  };
}

function isLocalComposerSlashCommand(command: ParsedComposerSlashCommand): boolean {
  return command.command === "goal-local" || command.command === "skill" || command.command === "sync-cloud";
}

export function shouldRunCreatePipelineCommandLocally(input: {
  command: ParsedComposerSlashCommand;
  profile: BootstrapPayload["profile"] | null | undefined;
  activeWorkspaceKind: WorkspaceKind | null;
  view: AppView;
}): boolean {
  if (input.command.command !== "create" && input.command.command !== "edit") {
    return false;
  }
  if (input.profile?.mode !== "local") return false;
  if (input.view === "cloud") return false;
  return !isCloudWorkspaceKind(input.activeWorkspaceKind);
}

function cloudWorkItemSandboxId(
  workItem: CloudWorkItem | null,
  detail: CloudWorkItemDetail | null,
): string | null {
  if (!workItem) return null;
  const detailApplies = detail?.workItem.id === workItem.id;
  return (
    (detailApplies ? detail.workItem.latestSandboxId : null) ??
    workItem.latestSandboxId ??
    (detailApplies
      ? detail.runtimeSessions.find((session) => session.sandboxId && !session.endedAt)?.sandboxId ??
        detail.runtimeSessions.find((session) => session.sandboxId)?.sandboxId ??
        null
      : null)
  );
}

export function sandboxIdFromWorkspaceName(workspaceName: string | null): string | null {
  const trimmed = workspaceName?.trim() ?? "";
  return /^[a-z0-9]{24}$/.test(trimmed) ? trimmed : null;
}

export function MainPane({
  view,
  bootstrap,
  runtimeEvents,
  chatMessages,
  contextWindowStatus,
  goalRuntime,
  subagentRuntime,
  prompt,
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
  browserConversationId,
  terminalScope,
  terminalTabs,
  terminalCwd,
  pendingTerminalCommand,
  terminalOpen,
  insightsItems,
  insightsRuns,
  insightsNextScanAt,
  insightsScanRunning,
  insightsScanStartedAt,
  insightsScanning,
  insightsError,
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
  sendPrompt,
  stopTurn,
  syncWorkspaceLocally,
  refreshWorkspaceDiff,
  onToggleDiffPanelExpanded,
  onShowDiffPanel,
  onShowBrowserPanel,
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
  onCloseRightPanel,
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
  const showLocalDiffPanel = (view === "chat" || view === "profile") && Boolean(activeWorkspaceAppId);
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
  const showRightPanel = showDiffPanel || showBrowserPanel || showRightChatPanel;
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
    view === "apps" || view === "get-started" || view === "insights" || view === "profile"
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
      const promptForSubmit = options.promptOverride ?? prompt;
      const clearMainPrompt = () => {
        if (options.preservePrompt) return;
        setPrompt("");
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
                setView("insights");
              }
              return true;
            }
            setView("insights");
            const payload = await onRunInsightsScan({ trigger: "slash_command" });
            if (payload && typeof payload === "object" && "summary" in payload) {
              const summary = payload.summary as { activeCount?: number; highestActiveSeverity?: string | null };
              const activeCount = summary.activeCount ?? 0;
              const severity = summary.highestActiveSeverity ? ` Highest severity: ${summary.highestActiveSeverity}.` : "";
              showToast(`${activeCount} active insight${activeCount === 1 ? "" : "s"}.${severity}`, "info");
            }
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
            isLocalComposerSlashCommand(command) ||
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
            setView("cloud");
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
      activeWorkspaceKind,
      bootstrap?.profile,
      connectedAppMentions,
      onAskInsightsQuestion,
      onOpenInsightsSession,
      onCreateCloudWork,
      onRunInsightsScan,
      prompt,
      sendPrompt,
      setMentionedAppId,
      setPrompt,
      setView,
      showToast,
      slashCommandCloudProjectId,
      view,
    ],
  );
  const changeMainComposerModel = useCallback(
    (model: string) => {
      setDraftProvider(activeProvider);
      setDraftModel(model);
    },
    [activeProvider, setDraftModel, setDraftProvider],
  );
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
  const handleOpenFileInSidebar = useCallback(
    (path: string) => {
      onShowDiffPanel();
      setOpenDiffFileRequest({ id: Date.now(), path });
    },
    [onShowDiffPanel],
  );
  const workspaceRootPath = workspaceTarget.value === "local" ? workspaceTarget.detail : null;
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
      editorPreferences={bootstrap?.preferences.editor ?? null}
      loading={rightSidebarUsesSandbox ? cloudLoading : diffBusy || workspaceStatusLoading}
      openFileRequest={openDiffFileRequest}
      sideChatTabs={rightChatPanels.map((panel) => ({ id: panel.id, title: panel.title }))}
      sourceSwitcher={rightSidebarSourceSwitcher}
      tabRequest={rightPanelTabRequest}
      workspaceName={rightSidebarUsesSandbox ? selectedCloudWorkItem?.title ?? "Sandbox" : workspaceName}
      workspaceInitialized={rightSidebarUsesSandbox ? Boolean(rightSidebarSandboxId) : Boolean(workspaceState?.initialized)}
      workspaceError={rightSidebarUsesSandbox ? null : workspaceState?.error ?? workspaceDiff?.error ?? null}
      expanded={diffPanelExpanded}
      onResizeStart={onDiffPanelResizeStart}
      onRefresh={(options) => void refreshWorkspaceDiff(options)}
      onToggleExpanded={onToggleDiffPanelExpanded}
      onOpenBrowser={onShowBrowserPanel}
      onOpenBrowserUrl={handleOpenBrowserLink}
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
    />
  ) : null;
  const browserPanel = showBrowserPanel ? (
    <BrowserSidebar
      conversationId={browserConversationId}
      expanded={diffPanelExpanded}
      onClose={onCloseRightPanel}
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
  const rightPanel = rightChatPanel ?? diffPanel ?? browserPanel;
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
      ) : view === "get-started" ? (
        <Suspense fallback={null}>
          <GetStartedView
            onCreateAgent={() => {
              setPrompt("/create ");
              setMentionedAppId(null);
              setView("chat");
            }}
            onOpenApps={() => setView("apps")}
            onOpenChat={() => setView("chat")}
            onOpenCloud={() => setView("cloud")}
            onOpenProfile={() => setView("profile")}
          />
        </Suspense>
      ) : view === "profile" ? (
        rightPanelExpanded ? (
          <Suspense fallback={null}>{rightPanel}</Suspense>
        ) : (
          <>
            <Suspense fallback={null}>
              <ProfileView
                payload={bootstrap}
                connection={connection}
                onPayload={onPayload}
                onError={onError}
                onToast={showToast}
                onSkillCommand={(command) => {
                  setPrompt(command);
                  setMentionedAppId(null);
                  setView("chat");
                }}
              />
            </Suspense>
            {terminalPanel}
            {showRightPanel ? <Suspense fallback={null}>{rightPanel}</Suspense> : null}
          </>
        )
      ) : view === "insights" ? (
        <Suspense fallback={null}>
          <InsightsView
            items={insightsItems}
            runs={insightsRuns}
            nextScanAt={insightsNextScanAt}
            scanRunning={insightsScanRunning}
            scanStartedAt={insightsScanStartedAt}
            scanning={insightsScanning}
            error={insightsError}
            onRunScan={onRunInsightsScan}
            onPatchStatus={onPatchInsightStatus}
            onOpenSession={onOpenInsightsSession}
          />
        </Suspense>
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
            </section>
            <div className={`composer-stack dock ${pendingApproval ? "has-approval" : ""}`} ref={composerStackRef}>
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
              <Composer
                mode="dock"
                prompt={prompt}
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
                onProviderChange={changeDraftProvider}
                onProviderSetupOpen={onOpenProviderSettings}
                onProjectTargetChange={changeProjectTarget}
                onWorkspaceTargetChange={(target) => void changeWorkspaceTarget(target)}
                onModelChange={changeMainComposerModel}
                onCodexPermissionModeChange={changeCodexPermissionMode}
                onCodexReasoningEffortChange={changeCodexReasoningEffort}
                onOpenPondCommandAccessModeChange={changeOpenPondCommandAccessMode}
                onPromptChange={setPrompt}
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
              <ApprovalRequestCard approval={pendingApproval} onResolve={resolveApproval} />
              <Composer
                mode="start"
                prompt={prompt}
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
                onProviderChange={changeDraftProvider}
                onProviderSetupOpen={onOpenProviderSettings}
                onProjectTargetChange={changeProjectTarget}
                onWorkspaceTargetChange={(target) => void changeWorkspaceTarget(target)}
                onModelChange={changeMainComposerModel}
                onCodexPermissionModeChange={changeCodexPermissionMode}
                onCodexReasoningEffortChange={changeCodexReasoningEffort}
                onOpenPondCommandAccessModeChange={changeOpenPondCommandAccessMode}
                onPromptChange={setPrompt}
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
