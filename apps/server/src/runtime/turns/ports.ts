import type {
  Approval,
  AppPreferences,
  ChatProvider,
  ConnectedAppConnectionLike,
  CreateImproveRun,
  CreateImproveRunAction,
  ModelUsageRecord,
  OpenPondActionCatalogEntry,
  OpenPondApp,
  OpenPondProfileSkill,
  OpenPondProfileState,
  ProviderSettings,
  RuntimeEvent,
  SendTurnRequest,
  Session,
  SubagentLifecycleActionResponse,
  SubagentMessage,
  SubagentRun,
  Turn,
  WorkspaceDiffSummary,
  WorkspaceToolResult,
} from "@openpond/contracts";
import type {
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
  HostedChatContinuation,
  ProfileSkillCommandResult,
  ProfileSkillGoalCommandInput,
} from "@openpond/cloud";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { BrowserHarnessToolExecutor } from "../../openpond/browser-tool-registry.js";
import type { OpenPondCommandExecutionInput, OpenPondCommandRunResult } from "../../openpond/command-access.js";
import type { ConnectedAppToolExecutor } from "../../openpond/connected-app-tool-registry.js";
import type { ResolvedConnectedAppContext } from "../../openpond/connected-app-context.js";
import type { HostedToolInstructionMode } from "../../openpond/hosted-tool-protocol.js";
import type { HostedProfileSkillBody, ProfileSkillInstructionMode } from "../../openpond/hosted-turn-helpers.js";
import type { buildChatMessagesForProvider } from "../../openpond/hosted-chat.js";
import type { ProfileSkillReadResult } from "../../openpond/model-tool-registry.js";
import type { NativeModelToolResult } from "../../openpond/native-tool-calls.js";
import type { WebSearchExecutor } from "../../openpond/web-search.js";
import type { RuntimeCodexSession } from "../../types.js";
import type { BackgroundWorkerQueue } from "../background-worker-queue.js";
import type { CreateImprovePlanner } from "../create-pipeline-planner.js";
import type { LocalCreatePipelineCheckInput, LocalCreatePipelineCheckResult } from "../local-create-pipeline.js";
import type { HostedToolRolloutFlags } from "../hosted-turn/rollout.js";

export type HostedMessages = ReturnType<typeof buildChatMessagesForProvider>;

export type HostedToolLoopDelta = {
  text?: string;
  reasoningText?: string;
  continuation?: HostedChatContinuation;
  toolCalls?: HostedChatToolCall[];
  finishReason?: string | null;
  raw?: unknown;
  usage?: unknown;
};

export type CodexTurnInput = Pick<
  SendTurnRequest,
  "approvalPolicy" | "sandbox" | "model" | "codexPermissionMode" | "codexReasoningEffort"
>;

export type SubagentSandboxForkRequest = {
  sandboxId: string;
  payload: Record<string, unknown>;
  parentSession: Session;
  role: AppPreferences["subagents"]["roles"][number];
  runId: string;
};

export type SubagentSandboxCleanupRequest = {
  sandboxId: string;
  run: SubagentRun;
};

export type TurnRepository = {
  runtimeEventsForSession(
    sessionId: string,
    query?: {
      afterSequence?: number | null;
      names?: readonly RuntimeEvent["name"][];
      limit?: number | null;
    },
  ): Promise<RuntimeEvent[]>;
  latestAssistantTextForSession(sessionId: string): Promise<string | null>;
  currentOpenPondThreadGoal(sessionId: string): Promise<Record<string, unknown> | null>;
  openPondThreadGoalById(sessionId: string, goalId: string): Promise<Record<string, unknown> | null>;
  latestTurnForSession(sessionId: string, status?: Turn["status"]): Promise<Turn | null>;
  countTurnsForSession(sessionId: string): Promise<number>;
  hasSubagentParentWakeTurn(sessionId: string, messageId: string): Promise<boolean>;
  countSubagentParentWakeTurns(sessionId: string, fromRunId: string): Promise<number>;
  getTurn(turnId: string): Promise<Turn | null>;
  insertTurn(turn: Turn): Promise<void>;
  updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null>;
  getCreateImproveRun(runId: string): Promise<CreateImproveRun | null>;
  listCreateImproveRuns(query?: {
    profileId?: string | null;
    conversationId?: string | null;
    targetKind?: CreateImproveRun["target"]["kind"] | null;
    targetId?: string | null;
    state?: CreateImproveRun["state"] | readonly CreateImproveRun["state"][] | null;
    limit?: number;
  }): Promise<CreateImproveRun[]>;
  upsertCreateImproveRun(run: CreateImproveRun): Promise<CreateImproveRun>;
  mutateCreateImproveRun(
    action: CreateImproveRunAction,
    updater: (run: CreateImproveRun) => CreateImproveRun,
  ): Promise<{ run: CreateImproveRun; replayed: boolean }>;
  getApproval(approvalId: string): Promise<Approval | null>;
  upsertModelUsageRecord?(record: ModelUsageRecord): Promise<ModelUsageRecord>;
  listModelUsageRecords?(query?: {
    sessionId?: string | null;
    turnId?: string | null;
    startedAtFrom?: string | null;
    startedAtTo?: string | null;
    visibility?: ModelUsageRecord["visibility"] | "all" | null;
    status?: ModelUsageRecord["status"] | "missing" | "all" | null;
    limit?: number;
  }): Promise<ModelUsageRecord[]>;
  upsertSubagentRun?(run: SubagentRun): Promise<SubagentRun>;
  getSubagentRun?(runId: string): Promise<SubagentRun | null>;
  listSubagentRuns?(query?: SubagentRunQuery): Promise<SubagentRun[]>;
  listActiveSubagentRuns?(query?: SubagentRunQuery): Promise<SubagentRun[]>;
  listStaleSubagentRuns?(query: SubagentRunQuery & {
    olderThanMs: number;
    nowIso?: string | null;
  }): Promise<SubagentRun[]>;
  appendSubagentMessage?(message: SubagentMessage): Promise<SubagentMessage>;
  listSubagentMessages?(query?: {
    parentGoalId?: string | null;
    fromRunId?: string | null;
    toRunId?: string | null;
    toRole?: string | null;
    limit?: number;
  }): Promise<SubagentMessage[]>;
  claimOpenPondThreadGoal?(input: {
    sessionId: string;
    goalId: string;
    status: string;
    updatedAt: string;
  }): Promise<void>;
  releaseOpenPondThreadGoalClaim?(sessionId: string, goalId: string): Promise<void>;
};

export type SubagentRunQuery = {
  parentSessionId?: string | null;
  parentGoalId?: string | null;
  childSessionId?: string | null;
  status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
  limit?: number;
};

export type TurnEventSink = {
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  appendAssistantText(session: Session, turnId: string, text: string): Promise<void>;
  appendHostedContextUsage(input: {
    session: Session;
    turnId: string;
    provider: ChatProvider;
    model: string;
    messages: HostedMessages;
    maxContextTokens?: number | null;
    usage?: unknown;
    includeCompletion?: boolean;
  }): Promise<void>;
};

export type SessionWorkspaceResolver = {
  defaultSessionCwd(appId?: string | null): string;
  findOpenPondApp(appId: string): Promise<OpenPondApp>;
  resolveSessionWorkspaceCwd(
    session: Pick<Session, "appId" | "cwd" | "metadata" | "subagentRunId" | "workspaceId" | "workspaceKind">,
    options?: { ensureOpenPond?: boolean },
  ): Promise<string | null>;
  maybeCreateScaffoldForTurn(session: Session, turnId: string, prompt: string): Promise<Session>;
  workspaceDiffBaseline(session: Session): Promise<WorkspaceDiffSummary | null>;
  appendWorkspaceDiffEvent(
    session: Session,
    turnId: string,
    options?: { baseline?: WorkspaceDiffSummary | null },
  ): Promise<void>;
};

export type ProviderRuntime = {
  ensureCodexRuntime(session: Session, turnInput: CodexTurnInput): Promise<RuntimeCodexSession>;
  streamLocalByokChatTurn?: (input: {
    providerId: ChatProvider;
    modelId?: string | null;
    messages: HostedMessages;
    tools?: HostedChatTool[];
    toolChoice?: HostedChatToolChoice;
    requestId: string;
    signal: AbortSignal;
  }) => AsyncGenerator<HostedToolLoopDelta, void, unknown>;
  streamOpenPondHostedChatTurn?: typeof streamOpenPondHostedChatTurn;
};

export type WorkspaceToolExecutorPort = {
  executeWorkspaceTool(
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null },
  ): Promise<WorkspaceToolResult>;
};

export type SubagentRepository = Pick<
  TurnRepository,
  | "upsertSubagentRun"
  | "getSubagentRun"
  | "listSubagentRuns"
  | "listActiveSubagentRuns"
  | "listStaleSubagentRuns"
  | "appendSubagentMessage"
  | "listSubagentMessages"
>;

export type SubagentWorkspacePort = {
  forkSandboxForSubagent?(input: SubagentSandboxForkRequest): Promise<unknown>;
  cleanupSandboxForSubagent?(input: SubagentSandboxCleanupRequest): Promise<unknown>;
};

export type GoalRepository = Pick<
  TurnRepository,
  "claimOpenPondThreadGoal" | "releaseOpenPondThreadGoalClaim"
>;

export type CreatePipelineRepository = Pick<
  TurnRepository,
  "getTurn" | "updateTurn" | "getApproval"
> & {
  upsertApproval(approval: Approval): Promise<void>;
};

export type TurnDispatcherPort = {
  sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
};

export type TurnRunnerDependencies = {
  attachmentRootDir: string;
  store: TurnRepository;
  resolveCreateImproveTaskset?: (tasksetId: string, revision: number, contentHash: string) => Promise<import("@openpond/contracts").Taskset | null>;
  gradeCreateImproveTaskAttempt?: (input: { tasksetId: string; taskId: string; attempt: import("@openpond/contracts").TaskAttemptResult }) => Promise<import("@openpond/contracts").GradeResult>;
  upsertApproval: (approval: Approval) => Promise<void>;
  createSession?: (payload: unknown) => Promise<Session>;
  getSession: (sessionId: string) => Promise<Session>;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
  completeTurn: (sessionId: string, turnId: string, providerTurnId?: string | null) => Promise<Turn>;
  failTurn: (session: Session, turnId: string, message: string) => Promise<Turn>;
  interruptTurn: (session: Session, turnId: string, message?: string) => Promise<Turn>;
  defaultSessionCwd: SessionWorkspaceResolver["defaultSessionCwd"];
  findOpenPondApp: SessionWorkspaceResolver["findOpenPondApp"];
  resolveSessionWorkspaceCwd: SessionWorkspaceResolver["resolveSessionWorkspaceCwd"];
  ensureCodexRuntime: ProviderRuntime["ensureCodexRuntime"];
  appendWorkspaceDiffEvent: SessionWorkspaceResolver["appendWorkspaceDiffEvent"];
  workspaceDiffBaseline: SessionWorkspaceResolver["workspaceDiffBaseline"];
  appendRuntimeEvent: TurnEventSink["appendRuntimeEvent"];
  executeWorkspaceTool: WorkspaceToolExecutorPort["executeWorkspaceTool"];
  forkSandboxForSubagent?: SubagentWorkspacePort["forkSandboxForSubagent"];
  cleanupSandboxForSubagent?: SubagentWorkspacePort["cleanupSandboxForSubagent"];
  executeOpenPondCommand?: (input: OpenPondCommandExecutionInput) => Promise<OpenPondCommandRunResult>;
  executeProfileAction?: (payload: unknown) => Promise<unknown>;
  executeCrossSystemTool?: (input: {
    modelId: string;
    localProjectId: string | null;
    turnId: string;
    callId: string;
    name: string;
    args: Record<string, unknown>;
    userPrompt: string;
    taskId?: string;
    signal: AbortSignal;
  }) => Promise<NativeModelToolResult>;
  finalizeCrossSystemTurn?: (input: {
    modelId: string;
    localProjectId: string | null;
    sessionId: string;
    turnId: string;
    userPrompt: string;
    taskId: string;
    startedAt: string;
    completedAt: string;
    terminalFailure?: {
      message: string;
      failureClass: "policy_failure" | "infrastructure_failure";
    } | null;
  }) => Promise<{ attemptId: string; gradeId: string; generatedTaskId: string } | null>;
  loadOpenPondProfileState?: () => Promise<OpenPondProfileState>;
  readOpenPondProfileSkill?: (input: { profileSourcePath: string; name: string }) => Promise<ProfileSkillReadResult>;
  executeProfileSkillCommand?: (input: { prompt: string }) => Promise<ProfileSkillCommandResult | null>;
  executeProfileSkillGoal?: (input: ProfileSkillGoalCommandInput) => Promise<ProfileSkillCommandResult>;
  executeWebSearch?: WebSearchExecutor;
  executeConnectedAppTool?: ConnectedAppToolExecutor;
  browserToolExecutor?: BrowserHarnessToolExecutor;
  listIntegrationConnections?: (input: {
    teamId?: string;
    status?: "active" | "revoked" | "error" | "all";
  }) => Promise<{ teamId: string | null; connections: ConnectedAppConnectionLike[] }>;
  loadPersonalizationSoul: () => Promise<string>;
  loadAppPreferences?: () => Promise<AppPreferences>;
  loadProviderSettings?: () => Promise<ProviderSettings>;
  maybeCreateScaffoldForTurn: SessionWorkspaceResolver["maybeCreateScaffoldForTurn"];
  hostedSystemPrompt: (
    basePrompt: string,
    personalizationSoul: string,
    session: Session,
    options?: {
      mentionedApps?: OpenPondApp[];
      openPondActionCatalog?: OpenPondActionCatalogEntry[];
      openPondProfileSkills?: OpenPondProfileSkill[];
      loadedProfileSkills?: HostedProfileSkillBody[];
      connectedApps?: ResolvedConnectedAppContext[];
      toolInstructionMode?: HostedToolInstructionMode;
      actionCatalogInstructionMode?: "text_fallback" | "native_tool" | "none";
      profileSkillInstructionMode?: ProfileSkillInstructionMode;
      browserControlAvailable?: boolean;
      extraSystemContext?: string | null;
    },
  ) => Promise<string>;
  appendAssistantText: TurnEventSink["appendAssistantText"];
  appendHostedContextUsage: TurnEventSink["appendHostedContextUsage"];
  streamLocalByokChatTurn?: ProviderRuntime["streamLocalByokChatTurn"];
  streamOpenPondHostedChatTurn?: ProviderRuntime["streamOpenPondHostedChatTurn"];
  runLocalCreatePipelineChecks?: (input: LocalCreatePipelineCheckInput) => Promise<LocalCreatePipelineCheckResult>;
  planCreateImprove?: CreateImprovePlanner;
  turnFollowUpQueue: BackgroundWorkerQueue;
  subagentQueue?: BackgroundWorkerQueue;
  notifySubagentRunStateChanged?: (run: SubagentRun) => void;
  enableGoalContinuations?: boolean;
  maxHostedWorkspaceToolRounds: number;
  maxRepeatedInvalidToolRequests: number;
  hostedToolFlags?: Partial<HostedToolRolloutFlags>;
};

export type TurnRunner = TurnDispatcherPort & {
  isSessionTurnActive(sessionId: string): boolean;
  interruptSessionTurn(sessionId: string, reason?: string): Promise<Turn>;
  interruptAll(reason?: string): Promise<Turn[]>;
  close(): Promise<void>;
  applyCreateImproveAction(runId: string, payload: unknown): Promise<CreateImproveRun>;
  getCreateImproveRun(runId: string): Promise<CreateImproveRun | null>;
  listCreateImproveRuns(query?: {
    profileId?: string | null;
    conversationId?: string | null;
    targetKind?: CreateImproveRun["target"]["kind"] | null;
    targetId?: string | null;
    state?: CreateImproveRun["state"] | readonly CreateImproveRun["state"][] | null;
    limit?: number;
  }): Promise<CreateImproveRun[]>;
  resolveCreateImproveApproval(approvalId: string, payload: unknown): Promise<Approval | null>;
  resolveSubagentPatchApplyApproval(approvalId: string, payload: unknown): Promise<Approval | null>;
  runSubagentLifecycleAction(runId: string, payload: unknown): Promise<SubagentLifecycleActionResponse>;
  cleanupExpiredRetainedSubagentWorkspace(
    runId: string,
    payload?: unknown,
  ): Promise<SubagentLifecycleActionResponse>;
};

export type ActiveTurn = {
  session: Session;
  turn: Turn;
  controller: AbortController;
  settled: Promise<void>;
  settle(): void;
  interruptionReason?: string;
  codexRuntime?: RuntimeCodexSession;
  codexTurnId?: string;
};

export type CreatePipelineStatePort = {
  snapshot: CreateImproveRun;
};
