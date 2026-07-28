import type {
  Approval,
  BootstrapPayload,
  ChatAttachment,
  ChatProvider,
  CloudProject,
  CodexPermissionMode,
  CodexReasoningEffort,
  Experience,
  OpenPondApp,
  OpenPondCommandAccessMode,
  OpenPondProfileSkill,
  OutputRef,
  ResolveApprovalRequest,
  RuntimeEvent,
  Session,
  SidebarFileBookmark,
  TerminalScope,
  UsageRequestAttribution,
  WorkspaceDiffSummary,
  WorkspaceKind,
  WorkspaceState,
} from "@openpond/contracts";
import type {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from "react";
import type { ClientConnection } from "../../api";
import type { useTraining } from "../../hooks/useTraining";
import type { AppView, ChatMessage } from "../../lib/app-models";
import type { ComposerDraftStore } from "../../lib/composer-draft-store";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import type { TrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import type {
  WorkspaceTargetState,
  WorkspaceTargetValue,
} from "../../lib/workspace-location";
import type { RightPanelMode, ShowAppToast } from "../../app/app-state";
import type {
  ComposerProjectTargetState,
  ComposerSubmitOptions,
} from "../chat/Composer";
import type { ComposerSlashCommand } from "../../lib/composer-slash-commands";
import type { CreateImproveReviewActionInput } from "../chat/create-pipeline-types";
import type { CommunityViewProps } from "../community/CommunityView";
import type { LabDetailLocation } from "../labs/lab-detail-navigation";
import type { TeamChatViewProps } from "../team-chat/TeamChatView";
import type {
  TerminalQueuedCommand,
  TerminalTab,
} from "../terminal/terminal-overlay-types";
import type { TrainingLaunchRequest } from "../training/training-workspace-types";
import type {
  WorkspaceDiffPanelViewState,
  WorkspaceDiffTabRequest,
} from "../workspace-diff/workspace-diff-panel-model";
import type { RightChatPanelView } from "./RightChatPanelStack";
import type { SidebarFileOpenRequest } from "../../lib/sidebar-files";
import type { SkillSourceDocument } from "./skill-source-document";
import type { SkillPackageSourceSelection } from "./skill-package-source";

export type MainPaneProps = {
  experience: Experience;
  view: AppView;
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
  labCloseDetailRequestId: number;
  labCloseDetailKind: LabDetailLocation["kind"] | null;
  sideChatTrainingLaunchRequest: TrainingLaunchRequest | null;
  onSideChatTrainingLaunchHandled: (id: number) => void;
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
  nativeSkillSidebar: SkillSourceDocument | null;
  extensionSkillSidebar: SkillPackageSourceSelection | null;
  workspaceDiffPanelViewState: WorkspaceDiffPanelViewState;
  sidebarFileOpenRequest: SidebarFileOpenRequest | null;
  sidebarFileBookmarks: SidebarFileBookmark[];
  onSetSidebarFileStatus: (
    file: SidebarFileBookmark,
    status: "pinned" | "saved_for_later" | "none"
  ) => void;
  browserConversationId: string;
  terminalScope: TerminalScope;
  terminalTabs: TerminalTab[];
  terminalCwd: string | null;
  pendingTerminalCommand: TerminalQueuedCommand | null;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onWorkspaceDiffPanelViewStateChange: (
    state: WorkspaceDiffPanelViewState
  ) => void;
  training: ReturnType<typeof useTraining>;
  trainingSessions: Session[];
  trainingChatHandoff: TrainingModelChatHandoff | null;
  trainingDetailTasksetId: string | null;
  onTrainingDetailTasksetIdChange: (tasksetId: string | null) => void;
  onTrainingChatTaskSelect: (index: number) => void;
  onTrainingChatHandoffDismiss: () => void;
  onOpenSession: (sessionId: string) => void;
  onExperienceHandoff: (input: {
    target: Experience;
    sourceSessionId: string;
    sourceMessageIds?: string[];
    sourceContext?: string;
    output?: OutputRef;
    prompt: string;
  }) => Promise<Session>;
  cloudProjects: CloudProject[];
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
  onOpenComputeSettings: () => void;
  onOpenDatasetStorageSettings: () => void;
  changeDraftProvider: (provider: ChatProvider) => void;
  changeProjectTarget: (target: string) => void;
  changeWorkspaceTarget: (target: WorkspaceTargetValue) => Promise<void>;
  setDraftProvider: (provider: ChatProvider) => void;
  setDraftModel: (model: string) => void;
  onBeginNewChatWithModel: (handoff: TrainingModelChatHandoff) => void;
  changeCodexPermissionMode: (mode: CodexPermissionMode) => void;
  changeCodexReasoningEffort: (effort: CodexReasoningEffort) => void;
  changeOpenPondCommandAccessMode: (
    mode: OpenPondCommandAccessMode,
    session?: Session | null
  ) => void;
  resolveApproval: (
    approvalId: string,
    decision: ResolveApprovalRequest["decision"]
  ) => Promise<void>;
  answerCreateImproveQuestion: (
    input: CreateImproveReviewActionInput,
    questionId: string,
    answerValue: string
  ) => Promise<void>;
  approveCreateImproveRun: (
    input: CreateImproveReviewActionInput
  ) => Promise<void>;
  applyCreateImproveCandidate: (
    input: CreateImproveReviewActionInput,
    candidateId: string
  ) => Promise<void>;
  cancelCreateImproveRun: (
    input: CreateImproveReviewActionInput
  ) => Promise<void>;
  openCreateImprovePullRequest: (
    input: CreateImproveReviewActionInput,
    candidateId: string
  ) => Promise<void>;
  pauseCreateImproveRun: (
    input: CreateImproveReviewActionInput
  ) => Promise<void>;
  reconcileCreateImprovePullRequest: (
    input: CreateImproveReviewActionInput,
    candidateId: string
  ) => Promise<void>;
  rejectCreateImproveCandidate: (
    input: CreateImproveReviewActionInput,
    candidateId: string
  ) => Promise<void>;
  resumeCreateImproveRun: (
    input: CreateImproveReviewActionInput
  ) => Promise<void>;
  reviseCreateImproveRun: (
    input: CreateImproveReviewActionInput,
    revision: string
  ) => Promise<void>;
  setMentionedAppId: (appId: string | null) => void;
  showToast: ShowAppToast;
  sendPrompt: (
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    promptOverride?: string,
    options?: {
      clearPrompt?: () => void;
      displayPrompt?: string;
      usageAttribution?: UsageRequestAttribution;
      turnMetadata?: Record<string, unknown>;
    }
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
  onOpenRightChatForSession: (sessionId: string, session?: Session) => void;
  onLabDetailOpenChange: (location: LabDetailLocation | null) => void;
  onTerminalTabsChange: Dispatch<SetStateAction<TerminalTab[]>>;
  onCloseRightChatPanel: (panelId: string) => void;
  onCloseNativeSkillSidebar: () => void;
  onActivateRightChatPanel: (panelId: string) => void;
  onRightChatModelChange: (panelId: string, model: string) => void;
  onRightChatPromptChange: (panelId: string, prompt: string) => void;
  onRightChatScrollStateChange: (
    panelId: string,
    state: { scrollTop: number; stickyToBottom: boolean }
  ) => void;
  onRightChatProviderChange: (panelId: string, provider: ChatProvider) => void;
  onSubmitRightChat: (
    panelId: string,
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    command?: ComposerSlashCommand | null,
    options?: ComposerSubmitOptions
  ) => Promise<boolean>;
  onStopRightChat: (sessionId: string | null) => Promise<boolean>;
  onCloseTerminal: () => void;
  onLoadMoreChatHistory?: () => Promise<boolean>;
};
