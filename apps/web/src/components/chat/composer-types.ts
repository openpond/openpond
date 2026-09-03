import type {
  ChatAttachment,
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  Experience,
  OpenPondCommandAccessMode,
  OpenPondApp,
  ProviderSettings,
  TeamChatMember,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import type {
  WorkspaceTargetState,
  WorkspaceTargetValue,
} from "../../lib/workspace-location";
import type { ComposerSlashCommand } from "../../lib/composer-slash-commands";
import type { ComposerCreateImproveRuntime } from "./ComposerCreateImproveStrip";
import type {
  ComposerProfileTargetState,
  ComposerProjectTargetState,
} from "./ComposerControls";
import type { ComposerSkillMenuItem } from "./ComposerSkillMenu";
import type { ComposerSteerDraft } from "./composer-steer-queue";

export type ComposerProps = {
  experience?: Experience;
  mode: "dock" | "start";
  surface?: "chat" | "team";
  teamUseModel?: boolean;
  teamUseModelLocked?: boolean;
  teamMentionMembers?: TeamChatMember[];
  onTeamUseModelChange?: (value: boolean) => void;
  prompt: string;
  composeNotice?: ComposerNotice | null;
  mentionApps?: OpenPondApp[];
  connectedAppMentions?: ConnectedAppMentionOption[];
  profileSkills?: ComposerSkillMenuItem[];
  selectedMentionAppId?: string | null;
  contextWindowStatus: ContextWindowStatus;
  goalRuntime?: GoalRuntimeStatus | null;
  subagentRuntime?: SubagentRuntimeStatus | null;
  createImproveRuntime?: ComposerCreateImproveRuntime | null;
  busy: boolean;
  running?: boolean;
  interruptRunningTurnBeforeSteer?: boolean;
  submissionScopeKey?: string;
  getCurrentSubmissionScopeKey?: () => string;
  voiceInputChannelKey?: string;
  initialSteerDrafts?: ComposerSteerDraft[];
  showProjectFooter?: boolean;
  autoFocus?: boolean;
  focusRequestId?: number;
  attachmentRequest?: { id: number; file: File } | null;
  connection: ClientConnection | null;
  providerSettings?: ProviderSettings | null;
  provider: ChatProvider;
  model: string;
  projectTarget: ComposerProjectTargetState;
  profileTarget?: ComposerProfileTargetState | null;
  actionCatalog?: SandboxActionCatalogEntry[];
  requestedAction?: { actionId: string; requestId: number } | null;
  workspaceTarget: WorkspaceTargetState;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  onProviderChange: (value: ChatProvider) => void;
  onProviderSetupOpen?: () => void;
  onProjectTargetChange: (value: string) => void;
  onProfileTargetChange?: (value: string) => void;
  onWorkspaceTargetChange: (value: WorkspaceTargetValue) => void;
  onModelChange: (value: string) => void;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onOpenPondCommandAccessModeChange: (value: OpenPondCommandAccessMode) => void;
  onPromptChange: (value: string) => void;
  onMentionAppSelect?: (appId: string | null) => void;
  onSaveTaskDraft?: (prompt: string) => Promise<boolean>;
  showToast: ShowAppToast;
  onSubmit: (
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    command?: ComposerSlashCommand | null,
    options?: ComposerSubmitOptions
  ) => Promise<boolean>;
  onStop: () => Promise<boolean | void> | boolean | void;
  onPauseGoal?: () => Promise<boolean | void> | boolean | void;
};

export type ComposerSubmitOptions = {
  displayPrompt?: string;
  preservePrompt?: boolean;
  promptOverride?: string;
  turnMetadata?: Record<string, unknown>;
};

export type ComposerNotice = {
  message: string;
  tone: "info" | "warning";
};
