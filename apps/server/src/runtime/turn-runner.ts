import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AppPreferencesSchema,
  ChatProviderSchema,
  DEFAULT_OPENPOND_CHAT_MODEL,
  CreatePipelineRequestSchema,
  CreatePipelineSnapshotSchema,
  ResolveApprovalRequestSchema,
  SendTurnRequestSchema,
  SubagentExplorationSteeringPolicySchema,
  SubagentLifecycleActionRequestSchema,
  SubagentMessageDeliverySchema,
  SubagentMessageSchema,
  SubagentProgressSchema,
  SubagentReviewStateSchema,
  SubagentRunSchema,
  SubagentWorkerBriefSchema,
  UpdateTurnCreatePipelineRequestSchema,
  type Approval,
  type AppPreferences,
  type ChatModelRef,
  type ChatProvider,
  type ConnectedAppConnectionLike,
  type ConnectedAppIntegrationSkill,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
  type MentionedConnectedAppRef,
  type ModelUsageRecord,
  type SendTurnRequest,
  type OpenPondActionCatalogEntry,
  type OpenPondApp,
  type OpenPondProfileSkill,
  type OpenPondProfileState,
  type ProviderSettings,
  type ResolveApprovalRequest,
  type RuntimeEvent,
  type Session,
  type SubagentExplorationSteeringPolicy,
  type SubagentLifecycleActionResponse,
  type SubagentMessage,
  type SubagentMessageDelivery,
  type SubagentMessagePriority,
  type SubagentProgress,
  type SubagentProgressPhase,
  type SubagentRef,
  type SubagentReviewRoutingPolicy,
  type SubagentReviewRoutingReason,
  type SubagentRun,
  type SubagentRoleSettings,
  type SubagentValidationAttempt,
  type SubagentWorkerBrief,
  type Turn,
  type UsageRequestAttribution,
  type WorkspaceDiffSummary,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import {
  executeProfileSkillGoalRequest,
  type HostedChatTool,
  type HostedChatToolCall,
  type HostedChatToolChoice,
  type SandboxIntegrationConnectionStatusFilter,
} from "@openpond/cloud";
import type {
  ProfileSkillCommandResult,
  ProfileSkillGoalCommandInput,
  ProfileSkillGoalExecutionResult,
  ProfileSkillGoalRequest,
} from "@openpond/cloud";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import { HOSTED_CHAT_SYSTEM_PROMPT } from "../constants.js";
import {
  assertCreatePipelineMutationApproved,
  assertCreatePipelineSnapshotLinked,
  isCreatePipelineMutationState,
} from "../create-pipeline-guards.js";
import {
  chatAttachmentContext,
  chatAttachmentSummaries,
  formatPromptWithAttachmentContext,
  materializeChatAttachments,
} from "../chat-attachments.js";
import { resolveContextCompactionAdapter } from "../openpond/context-adapter.js";
import {
  estimateHostedMessageTokens,
  trustedProviderContextLimit,
} from "../openpond/context-usage.js";
import {
  hostedAutoCompactionDecision,
  runHostedContextCompaction,
  type ContextCompactionStreamDelta,
  type HostedCompactionResult,
  type HostedCompactionProvider,
} from "../openpond/context-compaction/index.js";
import { buildChatMessagesForProvider } from "../openpond/hosted-chat.js";
import {
  extractWorkspaceToolRequests,
  extractProfileSkillReadRequests,
  formatWorkspaceToolValidationErrorForModel,
  formatWorkspaceToolResultForModel,
  validateWorkspaceToolRequest,
  type HostedToolInstructionMode,
} from "../openpond/hosted-tool-protocol.js";
import {
  createOpenPondCapabilityModelToolDefinitions,
  type OpenPondCreatePipelineToolInput,
  type OpenPondCreatePipelineToolResult,
  type OpenPondGoalControlToolInput,
  type OpenPondGoalControlToolResult,
  type OpenPondProfileSkillGoalToolInput,
  type OpenPondProfileSkillGoalToolResult,
  type OpenPondSubagentCancelToolInput,
  type OpenPondSubagentJoinToolInput,
  type OpenPondSubagentMessageToolInput,
  type OpenPondSubagentMessageToolResult,
  type OpenPondSubagentReviewToolInput,
  type OpenPondSubagentStartToolInput,
  type OpenPondSubagentStatusToolInput,
  type OpenPondSubagentStatusToolResult,
  type OpenPondSubagentToolResult,
} from "../openpond/capability-tool-registry.js";
import {
  createBrowserModelToolDefinitions,
  redactBrowserToolArguments,
  type BrowserHarnessToolExecutor,
} from "../openpond/browser-tool-registry.js";
import {
  runOpenPondGoalControl,
  type OpenPondGoalControlAction,
  type OpenPondGoalControlGoal,
  type OpenPondGoalSubagentRunSummary,
  type OpenPondGoalSubagentState,
} from "../openpond/goal-control.js";
import {
  createConnectedAppSkillModelToolDefinitions,
  createCommandModelToolDefinition,
  createOpenPondActionModelToolDefinitions,
  createOpenPondProfileSkillModelToolDefinitions,
  createResourceModelToolDefinitions,
  createWebFetchModelToolDefinition,
  createWebSearchModelToolDefinition,
  enabledModelToolDefinitions,
  modelToolDefinitionToHostedTool,
  type ModelToolExecutionContext,
  type ModelToolDefinition,
  type ProfileSkillReadResult,
} from "../openpond/model-tool-registry.js";
import type {
  OpenPondCommandExecutionInput,
  OpenPondCommandRunResult,
} from "../openpond/command-access.js";
import {
  connectedAppProviderToolNames,
  createConnectedAppProviderModelToolDefinitions,
  isConnectedAppProviderToolName,
  redactConnectedAppToolArguments,
  type ConnectedAppToolExecutor,
} from "../openpond/connected-app-tool-registry.js";
import type {
  HostedProfileSkillBody,
  ProfileSkillInstructionMode,
} from "../openpond/hosted-turn-helpers.js";
import {
  mentionedConnectedAppRefsFromPrompt,
  promptMentionsConnectedAppProvider,
  resolveMentionedConnectedAppContexts,
  type ResolvedConnectedAppContext,
} from "../openpond/connected-app-context.js";
import {
  NativeToolCallAccumulator,
  assistantMessageForNativeToolCalls,
  invalidNativeToolArgumentsResult,
  parseNativeToolArguments,
  toolResultMessage,
  unknownNativeToolResult,
  type NativeModelToolCall,
  type NativeModelToolResult,
} from "../openpond/native-tool-calls.js";
import type { WebSearchExecutor } from "../openpond/web-search.js";
import { isOpenAiCompatibleProviderId } from "../openpond/openai-compatible-provider.js";
import type { RuntimeCodexSession } from "../types.js";
import { event, now, textFromUnknown } from "../utils.js";
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "./background-worker-queue.js";
import {
  applyApprovedLocalCreatePipelineSnapshot,
  type LocalCreatePipelineCheckInput,
  type LocalCreatePipelineCheckResult,
} from "./local-create-pipeline.js";
import {
  createBlockedCreatePipelinePlannerSnapshot,
  runModelBackedCreatePipelinePlanner,
  type CreatePipelinePlanner,
} from "./create-pipeline-planner.js";
import { startProviderRequestUsageRecorder } from "./model-usage-recorder.js";
import { requiresWorkspaceToolForPrompt } from "./workspace-tool-requirements.js";
import { resolveWorkspaceExecutionTarget } from "../workspace/workspace-execution-target.js";
import { runWorkspaceCommand, truncatePatch } from "../workspace/workspaces.js";

type HostedToolLoopDelta = {
  text?: string;
  reasoningText?: string;
  toolCalls?: HostedChatToolCall[];
  finishReason?: string | null;
  raw?: unknown;
  usage?: unknown;
};

type SubagentSandboxForkRequest = {
  sandboxId: string;
  payload: Record<string, unknown>;
  parentSession: Session;
  role: SubagentRoleSettings;
  runId: string;
};

type SubagentSandboxCleanupRequest = {
  sandboxId: string;
  run: SubagentRun;
};

type HostedToolLoopStreamOptions = {
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
};

const RESOURCE_TEXT_FALLBACK_ACTIONS = new Set<WorkspaceToolRequest["action"]>([
  "resource_search",
  "resource_read",
]);
const READ_ONLY_SUBAGENT_WORKSPACE_TOOL_ACTIONS = new Set<WorkspaceToolRequest["action"]>([
  "resource_search",
  "resource_read",
  "workspace_status",
  "list_files",
  "read_files",
  "search_files",
  "git_status",
  "git_diff",
  "sandbox_status",
  "sandbox_list_files",
  "sandbox_read_file",
  "sandbox_search_files",
  "sandbox_git_status",
  "sandbox_git_diff",
  "sandbox_git_export_patch",
  "sandbox_snapshot_catalog",
  "sandbox_templates",
  "sandbox_replays",
  "sandbox_replay_get",
  "sandbox_replay_logs",
  "sandbox_replay_artifacts",
  "sandbox_logs",
  "sandbox_receipts",
]);
const SUBAGENT_READ_ACTIONS = new Set<string>([
  "resource_read",
  "read_files",
  "sandbox_read_file",
  "sandbox_list_files",
  "git_status",
  "git_diff",
  "sandbox_git_status",
  "sandbox_git_diff",
  "sandbox_git_export_patch",
  "web_fetch",
]);
const SUBAGENT_SEARCH_ACTIONS = new Set<string>([
  "resource_search",
  "search_files",
  "sandbox_search_files",
  "web_search",
]);
const SUBAGENT_MUTATING_ACTIONS = new Set<string>([
  "write_file",
  "write_files",
  "edit_file",
  "delete_file",
  "sandbox_write_file",
  "sandbox_edit_file",
  "sandbox_delete_file",
  "sandbox_mkdir",
  "sandbox_move_file",
  "sandbox_upload_file",
  "sandbox_git_commit",
  "sandbox_git_apply_patch_local",
]);
const SUBAGENT_COMMAND_ACTIONS = new Set<string>([
  "exec_command",
  "sandbox_exec",
  "sandbox_run_action",
  "run_sandbox_template",
]);
const PARENT_MODEL_VISIBLE_SUBAGENT_EVENTS = new Set<RuntimeEvent["name"]>([
  "subagent.progress",
  "subagent.reported",
  "subagent.submitted",
  "subagent.accepted",
  "subagent.needs_revision",
  "subagent.completed",
  "subagent.failed",
  "subagent.blocked",
  "subagent.cancelled",
  "subagent.workspace_retained",
  "subagent.archived",
  "subagent.superseded",
  "subagent.dismissed",
  "subagent.message",
]);
const SUBAGENT_INTERRUPT_WAKE_MAX_RESUMES = 3;
const SUBAGENT_PARENT_WAKE_MAX_CHAIN = 4;
const GOAL_CONTINUATION_IDLE_WAIT_MS = 10_000;
const SUBAGENT_RETAINED_WORKSPACE_RETENTION_DAYS = 7;
const SUBAGENT_RETAINED_WORKSPACE_RETENTION_MS = SUBAGENT_RETAINED_WORKSPACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

type SubagentWorkspaceRetentionTrigger =
  | "auto_after_acceptance"
  | "cancel_requested"
  | "manual_cleanup"
  | "patch_approval_declined"
  | "patch_approval_cancelled";

type SubagentCleanupPolicy =
  | "auto_after_acceptance"
  | "cancel_requested"
  | "manual_cleanup"
  | "retention_expired";

export type HostedToolMode = "auto" | "native" | "text_fallback" | "disabled";

export type HostedToolRolloutFlags = {
  toolMode: HostedToolMode;
  nativeToolTransport: boolean;
  resourceTools: boolean;
  webSearchTool: boolean;
  dynamicActionTools: boolean;
  textToolFallback: boolean;
  nativeToolProviderAllowlist: readonly ChatProvider[] | "*";
  nativeToolProviderDenylist: readonly ChatProvider[];
};

const VERIFIED_NATIVE_TOOL_PROVIDERS = new Set<ChatProvider>([
  "openpond",
  "openai",
  "xai",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "fireworks",
]);

const DEFAULT_HOSTED_TOOL_ROLLOUT_FLAGS: HostedToolRolloutFlags = {
  toolMode: "auto",
  nativeToolTransport: true,
  resourceTools: true,
  webSearchTool: true,
  dynamicActionTools: true,
  textToolFallback: true,
  nativeToolProviderAllowlist: [],
  nativeToolProviderDenylist: [],
};

export function resolveHostedToolRolloutFlags(
  overrides: Partial<HostedToolRolloutFlags> = {},
): HostedToolRolloutFlags {
  const envFlags = hostedToolRolloutFlagsFromEnv(process.env);
  return {
    ...DEFAULT_HOSTED_TOOL_ROLLOUT_FLAGS,
    ...envFlags,
    ...overrides,
  };
}

function hostedToolRolloutFlagsFromEnv(
  env: NodeJS.ProcessEnv,
): Partial<HostedToolRolloutFlags> {
  const output: Partial<HostedToolRolloutFlags> = {};
  const toolMode = parseToolMode(env.OPENPOND_MODEL_TOOL_MODE);
  if (toolMode) output.toolMode = toolMode;
  const nativeToolTransport = parseBooleanEnv(env.OPENPOND_NATIVE_TOOL_TRANSPORT);
  if (nativeToolTransport !== null) output.nativeToolTransport = nativeToolTransport;
  const resourceTools = parseBooleanEnv(env.OPENPOND_RESOURCE_TOOLS);
  if (resourceTools !== null) output.resourceTools = resourceTools;
  const webSearchTool = parseBooleanEnv(env.OPENPOND_WEB_SEARCH_TOOL);
  if (webSearchTool !== null) output.webSearchTool = webSearchTool;
  const dynamicActionTools = parseBooleanEnv(env.OPENPOND_DYNAMIC_ACTION_TOOLS);
  if (dynamicActionTools !== null) output.dynamicActionTools = dynamicActionTools;
  const textToolFallback = parseBooleanEnv(env.OPENPOND_TEXT_TOOL_FALLBACK);
  if (textToolFallback !== null) output.textToolFallback = textToolFallback;
  const allowlist = parseProviderListEnv(env.OPENPOND_NATIVE_TOOL_PROVIDERS);
  if (allowlist) output.nativeToolProviderAllowlist = allowlist;
  const denylist = parseProviderListEnv(env.OPENPOND_NATIVE_TOOL_PROVIDER_DENYLIST);
  if (denylist && denylist !== "*") output.nativeToolProviderDenylist = denylist;
  return output;
}

function parseToolMode(value: string | undefined): HostedToolMode | null {
  const normalized = value?.trim();
  if (
    normalized === "auto" ||
    normalized === "native" ||
    normalized === "text_fallback" ||
    normalized === "disabled"
  ) {
    return normalized;
  }
  return null;
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
}

function parseProviderListEnv(value: string | undefined): readonly ChatProvider[] | "*" | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized === "*") return "*";
  const providers = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ChatProviderSchema.safeParse(item))
    .filter((result) => result.success)
    .map((result) => result.data);
  return providers.length > 0 ? providers : null;
}

export function nativeToolTransportEnabledForProvider(
  flags: HostedToolRolloutFlags,
  provider: ChatProvider,
): boolean {
  if (!flags.nativeToolTransport) return false;
  if (flags.toolMode === "disabled" || flags.toolMode === "text_fallback") return false;
  if (flags.nativeToolProviderDenylist.includes(provider)) return false;
  if (flags.toolMode === "native") return true;
  if (flags.nativeToolProviderAllowlist === "*") return true;
  if (flags.nativeToolProviderAllowlist.includes(provider)) return true;
  return VERIFIED_NATIVE_TOOL_PROVIDERS.has(provider);
}

export function hostedToolInstructionModeForProvider(
  flags: HostedToolRolloutFlags,
  provider: ChatProvider,
): HostedToolInstructionMode {
  if (!flags.textToolFallback || flags.toolMode === "disabled") return "none";
  if (nativeToolTransportEnabledForProvider(flags, provider) && flags.resourceTools) {
    return "resource_text_fallback";
  }
  return "full_text_fallback";
}

type HostedMessages = ReturnType<typeof buildChatMessagesForProvider>;
type CodexTurnInput = Pick<
  SendTurnRequest,
  "approvalPolicy" | "sandbox" | "model" | "codexPermissionMode" | "codexReasoningEffort"
>;
type SubagentTurnPermissions = Pick<
  SendTurnRequest,
  "approvalPolicy" | "sandbox" | "codexPermissionMode" | "codexReasoningEffort"
>;
type ActiveTurn = {
  session: Session;
  turn: Turn;
  controller: AbortController;
  codexRuntime?: RuntimeCodexSession;
  codexTurnId?: string;
};

type ProfileSkillRuntime = {
  profileSourcePath: string | null;
  skills: OpenPondProfileSkill[];
  readSkill: ((name: string) => Promise<ProfileSkillReadResult>) | null;
};

function isTerminalOneShotTurn(turn: Turn): boolean {
  const metadata = turn.metadata ?? {};
  if (metadata.openpondTerminalMode === "one-shot") return true;
  const terminal = metadata.openpondTerminal;
  return (
    Boolean(terminal) &&
    typeof terminal === "object" &&
    !Array.isArray(terminal) &&
    (terminal as Record<string, unknown>).mode === "one-shot"
  );
}

type ConnectedAppIntegrationConnectionLookup = (input: {
  teamId?: string;
  status?: SandboxIntegrationConnectionStatusFilter;
}) => Promise<{
  teamId: string | null;
  connections: ConnectedAppConnectionLike[];
}>;

export async function resolveConnectedAppContextsForTurn(input: {
  refs: MentionedConnectedAppRef[] | undefined;
  prompt?: string | null;
  cloudTeamId?: string | null;
  listIntegrationConnections: ConnectedAppIntegrationConnectionLookup;
}): Promise<ResolvedConnectedAppContext[]> {
  const explicitRefs = input.refs ?? [];
  if (explicitRefs.length === 0 && !promptMentionsConnectedAppProvider(input.prompt)) return [];
  const cloudTeamId = input.cloudTeamId?.trim() ?? "";
  const primaryResult = await input.listIntegrationConnections({
    ...(cloudTeamId ? { teamId: cloudTeamId } : {}),
    status: "active",
  });
  const primaryRefs = explicitRefs.length > 0
    ? explicitRefs
    : mentionedConnectedAppRefsFromPrompt({
        prompt: input.prompt,
        connections: primaryResult.connections,
      });
  const primaryContexts = withConnectedAppToolNames(
    resolveMentionedConnectedAppContexts({
      mentionedRefs: primaryRefs,
      connections: primaryResult.connections,
    }),
  );
  if (!cloudTeamId || (primaryRefs.length > 0 && mentionedConnectedAppRefsResolved(primaryRefs, primaryContexts))) {
    return primaryContexts;
  }

  try {
    const aggregateResult = await input.listIntegrationConnections({ status: "active" });
    const aggregateRefs = explicitRefs.length > 0
      ? explicitRefs
      : mentionedConnectedAppRefsFromPrompt({
          prompt: input.prompt,
          connections: aggregateResult.connections,
        });
    const aggregateContexts = withConnectedAppToolNames(
      resolveMentionedConnectedAppContexts({
        mentionedRefs: aggregateRefs,
        connections: aggregateResult.connections,
      }),
    );
    return aggregateContexts.length > 0 ? aggregateContexts : primaryContexts;
  } catch (error) {
    if (primaryContexts.length > 0) return primaryContexts;
    throw error;
  }
}

function withConnectedAppToolNames(
  contexts: ResolvedConnectedAppContext[],
): ResolvedConnectedAppContext[] {
  return contexts.map((context) => ({
    ...context,
    toolNames: Array.from(
      new Set([
        ...context.toolNames,
        "connected_app_skill_read",
        ...connectedAppProviderToolNames(context),
      ]),
    ),
  }));
}

function mentionedConnectedAppRefsResolved(
  refs: MentionedConnectedAppRef[],
  contexts: ResolvedConnectedAppContext[],
): boolean {
  const resolvedProviders = new Set(contexts.map((context) => context.provider));
  return refs.every((ref) => resolvedProviders.has(ref.provider));
}

export function createTurnRunner(deps: {
  attachmentRootDir: string;
  store: {
    snapshot(): Promise<{ events: RuntimeEvent[]; turns: Turn[]; approvals?: Approval[] }>;
    getTurn(turnId: string): Promise<Turn | null>;
    insertTurn(turn: Turn): Promise<void>;
    updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null>;
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
    listSubagentRuns?(query?: {
      parentSessionId?: string | null;
      parentGoalId?: string | null;
      childSessionId?: string | null;
      status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
      limit?: number;
    }): Promise<SubagentRun[]>;
    listActiveSubagentRuns?(query?: {
      parentSessionId?: string | null;
      parentGoalId?: string | null;
      childSessionId?: string | null;
      status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
      limit?: number;
    }): Promise<SubagentRun[]>;
    listStaleSubagentRuns?(query: {
      olderThanMs: number;
      nowIso?: string | null;
      parentSessionId?: string | null;
      parentGoalId?: string | null;
      childSessionId?: string | null;
      status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
      limit?: number;
    }): Promise<SubagentRun[]>;
    appendSubagentMessage?(message: SubagentMessage): Promise<SubagentMessage>;
    listSubagentMessages?(query?: {
      parentGoalId?: string | null;
      fromRunId?: string | null;
      toRunId?: string | null;
      toRole?: string | null;
      limit?: number;
    }): Promise<SubagentMessage[]>;
  };
  upsertApproval: (approval: Approval) => Promise<void>;
  createSession?: (payload: unknown) => Promise<Session>;
  getSession: (sessionId: string) => Promise<Session>;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
  completeTurn: (sessionId: string, turnId: string, providerTurnId?: string | null) => Promise<Turn>;
  failTurn: (session: Session, turnId: string, message: string) => Promise<Turn>;
  interruptTurn: (session: Session, turnId: string, message?: string) => Promise<Turn>;
  defaultSessionCwd: (appId?: string | null) => string;
  findOpenPondApp: (appId: string) => Promise<OpenPondApp>;
  resolveSessionWorkspaceCwd: (
    session: Pick<Session, "appId" | "cwd" | "metadata" | "subagentRunId" | "workspaceId" | "workspaceKind">,
    options?: { ensureOpenPond?: boolean }
  ) => Promise<string | null>;
  ensureCodexRuntime: (
    session: Session,
    turnInput: CodexTurnInput
  ) => Promise<RuntimeCodexSession>;
  appendWorkspaceDiffEvent: (
    session: Session,
    turnId: string,
    options?: { baseline?: WorkspaceDiffSummary | null }
  ) => Promise<void>;
  workspaceDiffBaseline: (session: Session) => Promise<WorkspaceDiffSummary | null>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null }
  ) => Promise<WorkspaceToolResult>;
  forkSandboxForSubagent?: (input: SubagentSandboxForkRequest) => Promise<unknown>;
  cleanupSandboxForSubagent?: (input: SubagentSandboxCleanupRequest) => Promise<unknown>;
  executeOpenPondCommand?: (input: OpenPondCommandExecutionInput) => Promise<OpenPondCommandRunResult>;
  executeProfileAction?: (payload: unknown) => Promise<unknown>;
  loadOpenPondProfileState?: () => Promise<OpenPondProfileState>;
  readOpenPondProfileSkill?: (input: {
    profileSourcePath: string;
    name: string;
  }) => Promise<ProfileSkillReadResult>;
  executeProfileSkillCommand?: (input: {
    prompt: string;
  }) => Promise<ProfileSkillCommandResult | null>;
  executeProfileSkillGoal?: (
    input: ProfileSkillGoalCommandInput,
  ) => Promise<ProfileSkillCommandResult>;
  executeWebSearch?: WebSearchExecutor;
  executeConnectedAppTool?: ConnectedAppToolExecutor;
  browserToolExecutor?: BrowserHarnessToolExecutor;
  listIntegrationConnections?: (input: {
    teamId?: string;
    status?: "active" | "revoked" | "error" | "all";
  }) => Promise<{
    teamId: string | null;
    connections: ConnectedAppConnectionLike[];
  }>;
  loadPersonalizationSoul: () => Promise<string>;
  loadAppPreferences?: () => Promise<AppPreferences>;
  loadProviderSettings?: () => Promise<ProviderSettings>;
  maybeCreateScaffoldForTurn: (session: Session, turnId: string, prompt: string) => Promise<Session>;
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
    }
  ) => Promise<string>;
  appendAssistantText: (session: Session, turnId: string, text: string) => Promise<void>;
  appendHostedContextUsage: (input: {
    session: Session;
    turnId: string;
    provider: ChatProvider;
    model: string;
    messages: HostedMessages;
    maxContextTokens?: number | null;
    usage?: unknown;
    includeCompletion?: boolean;
  }) => Promise<void>;
  streamLocalByokChatTurn?: (input: {
    providerId: ChatProvider;
    modelId?: string | null;
    messages: HostedMessages;
    tools?: HostedChatTool[];
    toolChoice?: HostedChatToolChoice;
    requestId: string;
    signal: AbortSignal;
  }) => AsyncGenerator<HostedToolLoopDelta, void, unknown>;
  streamOpenPondHostedChatTurn?: typeof defaultStreamOpenPondHostedChatTurn;
  runLocalCreatePipelineChecks?: (
    input: LocalCreatePipelineCheckInput,
  ) => Promise<LocalCreatePipelineCheckResult>;
  planCreatePipeline?: CreatePipelinePlanner;
  turnFollowUpQueue: BackgroundWorkerQueue;
  subagentQueue?: BackgroundWorkerQueue;
  notifySubagentRunStateChanged?: (run: SubagentRun) => void;
  enableGoalContinuations?: boolean;
  maxHostedWorkspaceToolRounds: number;
  maxRepeatedInvalidToolRequests: number;
  hostedToolFlags?: Partial<HostedToolRolloutFlags>;
}) {
  const {
    attachmentRootDir,
    store,
    upsertApproval,
    createSession,
    getSession,
    updateSession,
    completeTurn,
    failTurn,
    interruptTurn,
    defaultSessionCwd,
    findOpenPondApp,
    resolveSessionWorkspaceCwd,
    ensureCodexRuntime,
    appendWorkspaceDiffEvent,
    workspaceDiffBaseline,
    appendRuntimeEvent,
    executeWorkspaceTool,
    forkSandboxForSubagent,
    cleanupSandboxForSubagent,
    executeOpenPondCommand,
    executeProfileAction,
    loadOpenPondProfileState,
    readOpenPondProfileSkill,
    executeProfileSkillCommand,
    executeProfileSkillGoal,
    executeWebSearch,
    executeConnectedAppTool,
    browserToolExecutor,
    listIntegrationConnections,
    loadPersonalizationSoul,
    loadAppPreferences = async () => AppPreferencesSchema.parse({}),
    loadProviderSettings,
    maybeCreateScaffoldForTurn,
    hostedSystemPrompt,
    appendAssistantText,
    appendHostedContextUsage,
    streamLocalByokChatTurn,
    streamOpenPondHostedChatTurn = defaultStreamOpenPondHostedChatTurn,
    runLocalCreatePipelineChecks,
    planCreatePipeline,
    turnFollowUpQueue,
    subagentQueue,
    notifySubagentRunStateChanged,
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests,
  } = deps;
  const enableGoalContinuations = deps.enableGoalContinuations ?? true;
  const hostedToolFlags = resolveHostedToolRolloutFlags(deps.hostedToolFlags);
  const activeTurns = new Map<string, ActiveTurn>();
  const createPipelineApplyJobs = new Map<string, BackgroundWorkReceipt>();
  const subagentParentWakeJobs = new Map<string, BackgroundWorkReceipt>();
  const goalContinuationJobs = new Map<string, BackgroundWorkReceipt>();

  function interruptedError(): Error {
    const error = new Error("Stopped by user");
    error.name = "AbortError";
    return error;
  }

  function throwIfInterrupted(signal: AbortSignal): void {
    if (signal.aborted) throw interruptedError();
  }

  async function safeUpsertModelUsageRecord(record: ModelUsageRecord): Promise<void> {
    if (!store.upsertModelUsageRecord) return;
    try {
      await store.upsertModelUsageRecord(record);
    } catch (error) {
      await appendRuntimeEvent(
        event({
          sessionId: record.sessionId ?? undefined,
          turnId: record.turnId ?? undefined,
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: textFromUnknown(error) || "Failed to persist model usage record.",
          data: {
            kind: "model_usage_record_failed",
            requestId: record.requestId,
            provider: record.provider,
            model: record.model,
          },
        }),
      ).catch(() => undefined);
    }
  }

  function waitForInterrupt(signal: AbortSignal): Promise<never> {
    if (signal.aborted) return Promise.reject(interruptedError());
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(interruptedError()), { once: true });
    });
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function getStoredTurn(turnId: string): Promise<Turn | null> {
    return store.getTurn(turnId);
  }

  function nativeToolsEnabledForProvider(provider: ChatProvider): boolean {
    return nativeToolTransportEnabledForProvider(hostedToolFlags, provider);
  }

  function browserControlAvailable(session: Session): boolean {
    return browserToolExecutor?.available({ sessionId: session.id, conversationId: session.id }) ?? false;
  }

  async function subagentExplorationSteeringPolicyForSession(
    session: Session,
  ): Promise<SubagentExplorationSteeringPolicy> {
    if (!session.subagentRoleId) return SubagentExplorationSteeringPolicySchema.parse({});
    const preferences = await loadAppPreferences();
    const role = preferences.subagents.roles.find((candidate) => candidate.id === session.subagentRoleId);
    return role?.explorationSteering ?? SubagentExplorationSteeringPolicySchema.parse({});
  }

  function actionCatalogInstructionModeForProvider(
    provider: ChatProvider,
  ): "text_fallback" | "native_tool" | "none" {
    if (nativeToolsEnabledForProvider(provider) && hostedToolFlags.dynamicActionTools) return "native_tool";
    if (hostedToolInstructionModeForProvider(hostedToolFlags, provider) === "full_text_fallback") return "text_fallback";
    return "none";
  }

  function profileSkillInstructionModeForProvider(
    provider: ChatProvider,
    runtime: ProfileSkillRuntime,
  ): ProfileSkillInstructionMode {
    if (runtime.skills.length === 0 || !runtime.readSkill) return "none";
    if (nativeToolsEnabledForProvider(provider)) return "native_tool";
    if (hostedToolInstructionModeForProvider(hostedToolFlags, provider) === "full_text_fallback") return "text_fallback";
    return "none";
  }

  async function loadProfileSkillRuntime(input: {
    session: Session;
    turnId: string;
  }): Promise<ProfileSkillRuntime> {
    if (!loadOpenPondProfileState || !readOpenPondProfileSkill) {
      return { profileSourcePath: null, skills: [], readSkill: null };
    }
    try {
      const profile = await loadOpenPondProfileState();
      if (profile.error || !profile.sourcePath) {
        return { profileSourcePath: profile.sourcePath, skills: [], readSkill: null };
      }
      const skills = profile.skills
        .filter((skill) => skill.enabled && skill.validationStatus === "valid")
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        profileSourcePath: profile.sourcePath,
        skills,
        readSkill: (name) => readOpenPondProfileSkill({ profileSourcePath: profile.sourcePath!, name }),
      };
    } catch (error) {
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turnId,
          name: "diagnostic",
          source: "server",
          appId: input.session.appId,
          status: "failed",
          output: `Failed to load OpenPond profile skills: ${textFromUnknown(error) || "Unknown error"}`,
        }),
      );
      return { profileSourcePath: null, skills: [], readSkill: null };
    }
  }

  async function preloadExplicitProfileSkills(input: {
    session: Session;
    turnId: string;
    prompt: string;
    runtime: ProfileSkillRuntime;
    signal: AbortSignal;
  }): Promise<HostedProfileSkillBody[]> {
    if (!input.runtime.readSkill || input.runtime.skills.length === 0) return [];
    const skillByName = new Map(input.runtime.skills.map((skill) => [skill.name, skill]));
    const names = explicitProfileSkillNames(input.prompt).filter((name) => skillByName.has(name));
    const loaded: HostedProfileSkillBody[] = [];
    for (const name of names.slice(0, 5)) {
      throwIfInterrupted(input.signal);
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.selected",
        status: "completed",
        output: `Selected profile skill ${name}.`,
        skillName: name,
        source: "server",
      });
      try {
        const skill = await input.runtime.readSkill(name);
        loaded.push(profileSkillBodyFromReadResult(skill));
        await appendProfileSkillEvent({
          session: input.session,
          turnId: input.turnId,
          eventName: "skill.loaded",
          status: "completed",
          output: `Loaded profile skill ${name}.`,
          skillName: name,
          skill,
          source: "server",
        });
      } catch (error) {
        await appendProfileSkillEvent({
          session: input.session,
          turnId: input.turnId,
          eventName: "skill.load_failed",
          status: "failed",
          output: textFromUnknown(error) || `Failed to load profile skill ${name}.`,
          skillName: name,
          source: "server",
        });
      }
    }
    return loaded;
  }

  async function insertStoredTurn(turn: Turn): Promise<void> {
    await store.insertTurn(turn);
  }

  async function updateStoredTurn(
    turnId: string,
    updater: (turn: Turn) => Turn,
  ): Promise<Turn | null> {
    return store.updateTurn(turnId, updater);
  }

  function createNativeModelToolDefinitions(
    openPondActionCatalog: OpenPondActionCatalogEntry[],
    runtimeEvents: RuntimeEvent[],
    profileSkillRuntime: ProfileSkillRuntime,
    connectedApps: ResolvedConnectedAppContext[],
    options: { disableWorkflowDelegationTools?: boolean } = {},
  ): ModelToolDefinition[] {
    const definitions: ModelToolDefinition[] = [];
    if (!options.disableWorkflowDelegationTools) {
      definitions.push(
        ...createOpenPondCapabilityModelToolDefinitions({
          startCreatePipeline: startCreatePipelineFromModelTool,
          startGoalControl: (context, input) =>
            startGoalControlFromModelTool(context, input, runtimeEvents),
          ...(executeProfileSkillGoal
            ? { startProfileSkillGoal: startProfileSkillGoalFromModelTool }
            : {}),
          ...(subagentToolsAvailable()
            ? {
                startSubagent: startSubagentFromModelTool,
                statusSubagents: statusSubagentsFromModelTool,
                joinSubagent: joinSubagentFromModelTool,
                cancelSubagent: cancelSubagentFromModelTool,
                reviewSubagent: reviewSubagentFromModelTool,
                sendSubagentMessage: sendSubagentMessageFromModelTool,
              }
            : {}),
        }),
      );
    }
    definitions.push(
      ...createConnectedAppSkillModelToolDefinitions({
        connectedApps: connectedApps.map((app) => ({
          provider: app.provider,
          label: app.label,
        })),
      }),
    );
    definitions.push(
      ...createConnectedAppProviderModelToolDefinitions({
        connectedApps,
        executeConnectedAppTool,
      }),
    );
    definitions.push(...createBrowserModelToolDefinitions(browserToolExecutor));
    if (executeOpenPondCommand) {
      definitions.push(createCommandModelToolDefinition({ executeCommand: executeOpenPondCommand }));
    }
    if (hostedToolFlags.resourceTools) {
      definitions.push(...createResourceModelToolDefinitions({ executeWorkspaceTool, runtimeEvents }));
    }
    if (hostedToolFlags.webSearchTool) {
      definitions.push(createWebFetchModelToolDefinition());
    }
    if (hostedToolFlags.webSearchTool && executeWebSearch) {
      definitions.push(createWebSearchModelToolDefinition({ executeWebSearch }));
    }
    if (profileSkillRuntime.readSkill && profileSkillRuntime.skills.length > 0) {
      definitions.push(
        ...createOpenPondProfileSkillModelToolDefinitions({
          skills: profileSkillRuntime.skills,
          readProfileSkill: profileSkillRuntime.readSkill,
        }),
      );
    }
    if (hostedToolFlags.dynamicActionTools) {
      definitions.push(
        ...createOpenPondActionModelToolDefinitions({
          actionCatalog: openPondActionCatalog,
          executeWorkspaceTool,
          executeProfileAction,
        }),
      );
    }
    return definitions;
  }

  function subagentToolsAvailable(): boolean {
    return Boolean(
      createSession &&
        subagentQueue &&
        store.upsertSubagentRun &&
        store.getSubagentRun &&
        store.listSubagentRuns &&
        store.appendSubagentMessage &&
        store.listModelUsageRecords
    );
  }

  function requireSubagentDeps() {
    if (
      !createSession ||
      !subagentQueue ||
      !store.upsertSubagentRun ||
      !store.getSubagentRun ||
      !store.listSubagentRuns ||
      !store.appendSubagentMessage ||
      !store.listModelUsageRecords
    ) {
      throw new Error("Subagent runtime dependencies are not available.");
    }
    return {
      createSession,
      queue: subagentQueue,
      upsertRun: upsertSubagentRunAndNotify,
      getRun: (runId: string) => store.getSubagentRun!(runId),
      listRuns: (query?: Parameters<NonNullable<typeof store.listSubagentRuns>>[0]) =>
        store.listSubagentRuns!(query),
      appendMessage: (message: SubagentMessage) => store.appendSubagentMessage!(message),
      listUsageRecords: (query?: Parameters<NonNullable<typeof store.listModelUsageRecords>>[0]) =>
        store.listModelUsageRecords!(query),
    };
  }

  async function upsertSubagentRunAndNotify(run: SubagentRun): Promise<SubagentRun> {
    const updated = await store.upsertSubagentRun!(run);
    notifySubagentRunStateChanged?.(updated);
    return updated;
  }

  async function startSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentStartToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    if (context.session.subagentRunId) {
      throw new Error("Child subagents cannot start additional subagents in this version.");
    }
    const deps = requireSubagentDeps();
    const preferences = await loadAppPreferences();
    if (!preferences.subagents.enabled) throw new Error("Subagents are disabled in settings.");
    const role = preferences.subagents.roles.find((candidate) => candidate.id === input.roleId);
    if (!role?.enabled) throw new Error(`Subagent role ${input.roleId} is not enabled.`);
    const parentModelRef = context.model ? { providerId: context.provider, modelId: context.model } : null;
    const modelRef = role.modelRef ?? preferences.subagents.defaultModelRef ?? parentModelRef ?? preferences.defaultChatModelRef ?? {
      providerId: preferences.defaultChatProvider,
      modelId: preferences.defaultChatModel,
    };
    const workspaceTargetKey = await subagentWorkspaceTargetKeyForSession(context.session);
    const activeRuns = await deps.listRuns({
      parentSessionId: context.session.id,
      status: ["queued", "running", "needs_resume"],
      limit: 1000,
    });
    if (activeRuns.length >= preferences.subagents.maxConcurrentRuns) {
      throw new Error(
        `Subagent concurrency limit reached: ${activeRuns.length}/${preferences.subagents.maxConcurrentRuns} active child runs.`,
      );
    }
    const activeRoleRuns = activeRuns.filter((run) => run.roleId === role.id);
    if (activeRoleRuns.length >= role.maxConcurrentRuns) {
      throw new Error(
        `Subagent role ${role.id} concurrency limit reached: ${activeRoleRuns.length}/${role.maxConcurrentRuns} active runs.`,
      );
    }
    const providerLimit = preferences.subagents.maxConcurrentRunsPerProvider;
    if (providerLimit !== null) {
      const activeProviderRuns = activeRuns.filter((run) => run.modelRef?.providerId === modelRef.providerId);
      if (activeProviderRuns.length >= providerLimit) {
        throw new Error(
          `Subagent provider ${modelRef.providerId} concurrency limit reached: ${activeProviderRuns.length}/${providerLimit} active runs.`,
        );
      }
    }
    const workspaceTargetLimit = preferences.subagents.maxConcurrentRunsPerWorkspaceTarget;
    if (workspaceTargetLimit !== null) {
      const activeWorkspaceRuns = activeRuns.filter((run) => subagentWorkspaceTargetKeyFromRun(run) === workspaceTargetKey);
      if (activeWorkspaceRuns.length >= workspaceTargetLimit) {
        throw new Error(
          `Subagent workspace target concurrency limit reached: ${activeWorkspaceRuns.length}/${workspaceTargetLimit} active runs for ${workspaceTargetKey}.`,
        );
      }
    }
    const parentGoalId = activeThreadGoalId((await store.snapshot()).events, context.session.id);
    const budget = await subagentUsageBudgetForParent({
      parentSessionId: context.session.id,
      roleId: role.id,
      preferences,
    });
    assertSubagentBudgetAvailable({ budget, role });
    const runId = randomUUID();
    const createdAt = now();
    const childTurnPermissions = subagentChildTurnPermissions(context.turnPermissions, role);
    const isolation = await prepareSubagentWorkspaceIsolation({
      parentSession: context.session,
      role,
      runId,
    });
    const childSessionWorkspace = isolation.sessionWorkspace ?? {};
    const workerBrief = subagentWorkerBriefForStart({
      role,
      objective: input.objective,
      provided: input.workerBrief ?? null,
    });
    const childSystemContext = subagentChildSystemContext({
      role,
      objective: input.objective,
      parentSession: context.session,
      contextPack: input.context ?? null,
      workerBrief,
    });
    const childSessionMetadata = {
      ...(recordFromUnknown(childSessionWorkspace.metadata) ?? {}),
      subagent: {
        runId,
        roleId: role.id,
        parentSessionId: context.session.id,
        parentTurnId: context.turnId,
        parentGoalId,
        toolPolicy: role.toolPolicy,
        requestedIsolationMode: role.isolationMode,
        effectiveIsolationMode: isolation.effectiveIsolationMode,
        workspace: isolation.workspace,
        workerBrief,
        systemContext: childSystemContext,
      },
    };
    const childSession = await deps.createSession({
      provider: modelRef.providerId,
      modelRef,
      openPondCommandAccessMode: context.session.openPondCommandAccessMode,
      hiddenFromDefaultSidebar: true,
      parentSessionId: context.session.id,
      parentTurnId: context.turnId,
      parentGoalId,
      subagentRunId: runId,
      subagentRoleId: role.id,
      appId: context.session.appId,
      appName: context.session.appName,
      workspaceKind: childSessionWorkspace.workspaceKind ?? context.session.workspaceKind,
      workspaceId: childSessionWorkspace.workspaceId ?? context.session.workspaceId,
      workspaceName: childSessionWorkspace.workspaceName ?? context.session.workspaceName,
      localProjectId: childSessionWorkspace.localProjectId ?? context.session.localProjectId,
      cloudProjectId: childSessionWorkspace.cloudProjectId ?? context.session.cloudProjectId,
      cloudTeamId: childSessionWorkspace.cloudTeamId ?? context.session.cloudTeamId,
      cwd: isolation.cwd ?? context.session.cwd,
      title: `${subagentRoleLabel(role)}: ${input.objective.slice(0, 72)}`,
      metadata: childSessionMetadata,
    });
    const isolationBlocker = isolation.blocker;
    const run = SubagentRunSchema.parse({
      id: runId,
      parentSessionId: context.session.id,
      parentTurnId: context.turnId,
      parentGoalId,
      childSessionId: childSession.id,
      roleId: role.id,
      objective: input.objective,
      modelRef,
      isolationMode: role.isolationMode,
      toolPolicy: role.toolPolicy,
      background: role.background,
      peerMessages: role.peerMessages,
      status: isolationBlocker ? "blocked" : "queued",
      required: input.required ?? true,
      workerBrief,
      progress: SubagentProgressSchema.parse({
        phase: isolationBlocker ? "report" : "orient",
        currentBlocker: isolationBlocker,
        latestMeaningfulActivity: isolationBlocker
          ? "Subagent blocked before execution because isolation is unavailable."
          : "Subagent run created with a structured worker brief.",
        updatedAt: createdAt,
      }),
      review: SubagentReviewStateSchema.parse({
        status: "pending",
      }),
      createdAt,
      startedAt: null,
      completedAt: isolationBlocker ? createdAt : null,
      error: isolationBlocker,
      report: isolationBlocker
        ? {
            summary: "Subagent blocked before execution because write-capable child isolation is not available yet.",
            blockers: [isolationBlocker],
            followUpNeeded: true,
          }
        : null,
      metadata: {
        context: input.context ?? null,
        workerBrief,
        childTurnPermissions,
        tokenBudget: {
          totalMaxTokens: preferences.subagents.maxTokens,
          roleMaxTokens: role.maxTokens,
          roleMaxTurns: role.maxTurns,
          totalTokensUsedBeforeStart: budget.totalTokens,
          roleTokensUsedBeforeStart: budget.roleTokens,
        },
        concurrency: {
          providerId: modelRef.providerId,
          providerMaxConcurrentRuns: providerLimit,
          workspaceTargetKey,
          workspaceTargetMaxConcurrentRuns: workspaceTargetLimit,
        },
        subagentWorkspace: isolation.workspace,
      },
    });
    await deps.upsertRun(run);
    await appendSubagentReceipt({
      parentSession: context.session,
      parentTurnId: context.turnId,
      run,
      eventName: isolationBlocker ? "subagent.blocked" : "subagent.started",
      status: isolationBlocker ? "failed" : "pending",
      output: isolationBlocker
        ? `Subagent ${role.id} blocked: ${isolationBlocker}`
        : `Started ${role.id} subagent.`,
    });
    if (!isolationBlocker && role.background) {
      deps.queue.enqueue(
        {
          label: `${role.id}: ${input.objective.slice(0, 80)}`,
          metadata: { runId, childSessionId: childSession.id, parentSessionId: context.session.id },
        },
        () => runSubagentChildTurn({
          run,
          role,
          childSession,
          parentSession: context.session,
          parentTurnId: context.turnId,
          contextPack: input.context ?? null,
          workerBrief,
          childTurnPermissions,
        }),
      );
    }
    return subagentToolResultFromRun(run, isolationBlocker
      ? "Open the child conversation or wait for workspace isolation support before retrying write-capable work."
      : "Subagent queued in the background. This start call does not wait for completion; continue parent work and use pushed receipts, or call openpond_subagent_join only when an explicit blocking/diagnostic check is needed.");
  }

  async function statusSubagentsFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentStatusToolInput,
  ): Promise<OpenPondSubagentStatusToolResult> {
    const deps = requireSubagentDeps();
    const runs = input.runId
      ? [(await deps.getRun(input.runId))].filter((run): run is SubagentRun => Boolean(run))
      : await deps.listRuns({
          parentSessionId: context.session.id,
          parentGoalId: input.parentGoalId ?? undefined,
          limit: 50,
        });
    for (const run of runs) {
      assertSubagentRunAccessible(context.session, run);
    }
    return {
      runs: runs.map((run) => subagentToolResultFromRun(run, "Subagent status loaded.")),
      nextStep: runs.length === 0 ? "No matching subagent runs." : `Loaded ${runs.length} subagent run${runs.length === 1 ? "" : "s"}.`,
    };
  }

  async function joinSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentJoinToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    return subagentToolResultFromRun(run, subagentRunAccepted(run)
      ? "Subagent accepted; use its report and child conversation as evidence."
      : run.status === "submitted_for_review"
        ? "Subagent submitted a review packet; parent/reviewer should evaluate before treating it as accepted."
        : "Subagent has not been accepted yet; continue parent work, review the packet, or check again later.");
  }

  async function cancelSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentCancelToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    if (subagentRunAccepted(run)) {
      return subagentToolResultFromRun(run, "Subagent already accepted; no cancellation was applied.");
    }
    if (run.status === "cancelled") {
      return subagentToolResultFromRun(run, "Subagent was already cancelled.");
    }
    const reason = input.reason?.trim() || "Subagent cancelled by request.";
    const cancelledAt = now();
    let nextRun = SubagentRunSchema.parse({
      ...run,
      status: "cancelled",
      completedAt: cancelledAt,
      error: reason,
      report: {
        ...(run.report ?? {}),
        summary: run.report?.summary || "Subagent cancelled before completion.",
        blockers: uniqueNonEmptyStrings([...(run.report?.blockers ?? []), reason]),
        followUpNeeded: false,
      },
      metadata: {
        ...(run.metadata ?? {}),
        cancellation: {
          reason,
          cancelledAt,
          requestedBySessionId: context.session.id,
          requestedByTurnId: context.turnId,
        },
      },
    });
    await deps.upsertRun(nextRun);

    let interruptResult: Record<string, unknown> | null = null;
    if (run.childSessionId) {
      try {
        const interrupted = await interruptSessionTurn(run.childSessionId);
        interruptResult = {
          status: interrupted.status,
          turnId: interrupted.id,
        };
      } catch (error) {
        interruptResult = {
          status: "not_active",
          error: textFromUnknown(error) || "No active child turn to interrupt.",
        };
      }
    }
    let cleanupResult: Record<string, unknown> | null = input.cleanupWorkspace === false
      ? { status: "skipped", reason: "cleanupWorkspace was false" }
      : null;
    if (input.cleanupWorkspace !== false) {
      const cleanup = await cleanupSubagentRun({
        run: nextRun,
        parentSession: context.session,
        parentTurnId: context.turnId,
        reason: "cancel_requested",
        policy: "cancel_requested",
      });
      nextRun = cleanup.run;
      cleanupResult = cleanup.workspaceCleanup;
    }
    nextRun = SubagentRunSchema.parse({
      ...nextRun,
      metadata: {
        ...(nextRun.metadata ?? {}),
        cancellation: {
          ...(recordFromUnknown(nextRun.metadata?.cancellation) ?? {}),
          interruptResult,
          workspaceCleanup: cleanupResult,
        },
      },
    });
    await deps.upsertRun(nextRun);
    const parentSession = run.parentSessionId === context.session.id
      ? context.session
      : await getSession(run.parentSessionId).catch(() => context.session);
    await appendSubagentReceipt({
      parentSession,
      parentTurnId: run.parentTurnId ?? context.turnId,
      run: nextRun,
      eventName: "subagent.cancelled",
      status: "failed",
      output: `${run.roleId} subagent cancelled: ${reason}`,
    });
    return subagentToolResultFromRun(
      nextRun,
      cleanupResult?.status === "removed"
        ? "Subagent cancelled and isolated workspace cleanup completed."
        : "Subagent cancelled.",
    );
  }

  async function reviewSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentReviewToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    if (context.session.id === run.childSessionId || context.session.subagentRunId === run.id) {
      throw new Error("Child subagents cannot review their own submission.");
    }
    const dismissed = input.decision === "dismiss";
    if (dismissed) {
      if (!subagentDismissable(run)) {
        throw new Error(`Subagent run ${run.id} is ${run.status}; only blocked, failed, or cancelled runs can be dismissed.`);
      }
    } else if (!subagentReviewable(run)) {
      throw new Error(`Subagent run ${run.id} is ${run.status}; only submitted or revision-state runs can be reviewed.`);
    }

    const decidedAt = now();
    const summary = input.summary?.trim() || run.report?.summary || run.review.summary || null;
    const issues = uniqueNonEmptyStrings([...(run.review.issues ?? []), ...(input.issues ?? [])]);
    const requiredCorrections = input.decision === "needs_revision"
      ? uniqueNonEmptyStrings([
          ...(run.review.requiredCorrections ?? []),
          ...(input.requiredCorrections ?? []),
          ...((input.requiredCorrections?.length ?? 0) === 0 && (input.issues?.length ?? 0) === 0
            ? ["Revise the submitted work and submit a new review packet before acceptance."]
            : []),
        ])
      : run.review.requiredCorrections;
    const accepted = input.decision === "accept";
    const needsRevision = input.decision === "needs_revision";
    const needsUserInput = input.decision === "needs_user_input";
    const latestMeaningfulActivity = accepted
      ? "Parent/reviewer accepted the child review packet."
      : needsRevision
        ? "Parent/reviewer requested child revision."
        : dismissed
          ? "Parent/reviewer dismissed the child run after acknowledgement."
          : "Parent/reviewer requested user input before accepting the child review packet.";
    let nextRun = SubagentRunSchema.parse({
      ...run,
      status: accepted ? "accepted" : needsRevision ? "needs_revision" : needsUserInput ? "needs_user_input" : run.status,
      completedAt: accepted ? decidedAt : dismissed ? run.completedAt ?? decidedAt : null,
      report: run.report
        ? {
            ...run.report,
            followUpNeeded: !accepted && !dismissed,
          }
        : run.report,
      progress: SubagentProgressSchema.parse({
        ...(run.progress ?? {}),
        latestMeaningfulActivity,
        currentBlocker: needsUserInput ? summary ?? latestMeaningfulActivity : null,
        updatedAt: decidedAt,
      }),
      review: SubagentReviewStateSchema.parse({
        ...(run.review ?? {}),
        status: accepted ? "accepted" : needsRevision ? "needs_revision" : needsUserInput ? "needs_user_input" : "dismissed",
        decidedAt,
        reviewerSessionId: context.session.id,
        summary,
        issues,
        requiredCorrections,
        humanReviewRecommended: !accepted && !dismissed,
      }),
      metadata: {
        ...(run.metadata ?? {}),
        reviewDecision: {
          decision: input.decision,
          decidedAt,
          reviewerSessionId: context.session.id,
          reviewerRunId: context.session.subagentRunId ?? null,
          messageChild: needsRevision ? input.messageChild !== false : false,
        },
      },
    });
    await deps.upsertRun(nextRun);

    let correctionMessage: SubagentMessage | null = null;
    if (needsRevision && input.messageChild !== false) {
      correctionMessage = await appendSubagentReviewCorrectionMessage({
        context,
        run: nextRun,
        summary,
        issues,
        requiredCorrections,
        priority: input.priority ?? "interrupt",
      });
    }

    const parentSession = run.parentSessionId === context.session.id
      ? context.session
      : await getSession(run.parentSessionId).catch(() => context.session);
    await appendSubagentReceipt({
      parentSession,
      parentTurnId: run.parentTurnId ?? context.turnId,
      run: nextRun,
      eventName: accepted ? "subagent.accepted" : dismissed ? "subagent.dismissed" : "subagent.needs_revision",
      status: accepted || dismissed ? "completed" : "failed",
      output: accepted
        ? `${run.roleId} subagent review packet accepted.`
        : dismissed
          ? `${run.roleId} subagent run dismissed after parent acknowledgement.`
        : needsRevision
          ? `${run.roleId} subagent needs revision.`
          : `${run.roleId} subagent needs user input before acceptance.`,
    });
    if (accepted) {
      const cleanup = await cleanupSubagentRun({
        run: nextRun,
        parentSession,
        parentTurnId: run.parentTurnId ?? context.turnId,
        reason: "accepted_review",
        policy: "auto_after_acceptance",
      });
      nextRun = cleanup.run;
    }

    return subagentToolResultFromRun(
      nextRun,
      accepted
        ? "Subagent accepted; use its report and child conversation as evidence."
        : dismissed
          ? "Subagent dismissed after explicit parent acknowledgement; it will not count as accepted work."
        : needsRevision
          ? correctionMessage
            ? "Subagent marked needs_revision and corrective message delivered to the child."
            : "Subagent marked needs_revision; corrective message was not delivered."
          : "Subagent marked needs_user_input; ask the user for the missing decision before accepting.",
    );
  }

  async function runSubagentLifecycleAction(
    runId: string,
    payload: unknown,
  ): Promise<SubagentLifecycleActionResponse> {
    const input = SubagentLifecycleActionRequestSchema.parse(payload);
    const deps = requireSubagentDeps();
    const run = await deps.getRun(runId);
    if (!run) throw new Error(`Subagent run ${runId} was not found.`);
    const parentSession = await getSession(run.parentSessionId);
    const reason = input.reason ?? `Manual subagent ${input.action} requested.`;
    let nextRun = run;
    let workspaceCleanup: Record<string, unknown> | null = null;
    let sessionArchive: Record<string, unknown> | null = null;

    if (input.action === "cleanup" || input.action === "cleanup_and_archive") {
      const cleanup = await cleanupSubagentRun({
        run: nextRun,
        parentSession,
        parentTurnId: nextRun.parentTurnId ?? null,
        reason,
        policy: "manual_cleanup",
      });
      nextRun = cleanup.run;
      workspaceCleanup = cleanup.workspaceCleanup;
    }

    if (input.action === "archive" || input.action === "cleanup_and_archive") {
      const archived = await archiveSubagentChildSession({
        parentSession,
        parentTurnId: nextRun.parentTurnId ?? null,
        run: nextRun,
        reason,
        policy: "manual_archive",
      });
      nextRun = archived.run;
      sessionArchive = archived.sessionArchive;
    }

    return {
      action: input.action,
      run: nextRun,
      workspaceCleanup,
      sessionArchive,
      nextStep: subagentLifecycleActionNextStep(input.action, workspaceCleanup, sessionArchive),
    };
  }

  async function cleanupExpiredRetainedSubagentWorkspace(
    runId: string,
    payload: unknown = {},
  ): Promise<SubagentLifecycleActionResponse> {
    const input = recordFromUnknown(payload) ?? {};
    const deps = requireSubagentDeps();
    const run = await deps.getRun(runId);
    if (!run) throw new Error(`Subagent run ${runId} was not found.`);
    const parentSession = await getSession(run.parentSessionId);
    const checkedAt = stringFromRecord(input, "checkedAt") ?? now();
    const reason = stringFromRecord(input, "reason") ??
      `Retained subagent workspace retention expired at ${checkedAt}.`;
    const cleanup = await cleanupSubagentRun({
      run,
      parentSession,
      parentTurnId: run.parentTurnId ?? null,
      reason,
      policy: "retention_expired",
    });
    return {
      action: "cleanup",
      run: cleanup.run,
      workspaceCleanup: cleanup.workspaceCleanup,
      sessionArchive: null,
      nextStep: subagentLifecycleActionNextStep("cleanup", cleanup.workspaceCleanup, null),
    };
  }

  async function sendSubagentMessageFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentMessageToolInput,
  ): Promise<OpenPondSubagentMessageToolResult> {
    const deps = requireSubagentDeps();
    const parentGoalId = activeThreadGoalId((await store.snapshot()).events, context.session.parentSessionId ?? context.session.id);
    const fromRunId = context.session.subagentRunId ?? `parent:${context.session.id}`;
    const priority = input.priority ?? "normal";
    const deliveredParentSessionId = subagentMessageParentDeliveryTarget(context.session, input);
    const recipientRuns = await resolveSubagentMessageRecipients(context, {
      parentGoalId,
      toRunId: input.toRunId ?? null,
      toRole: input.toRole ?? null,
    });
    const deliveredRunIds = recipientRuns.map((run) => run.id);
    const delivered = deliveredRunIds.length > 0 || Boolean(deliveredParentSessionId);
    let delivery: SubagentMessageDelivery = {
      status: delivered ? "delivered" : "undelivered",
      deliveredRunIds,
      acknowledgedRunIds: deliveredRunIds,
      deliveredParentSessionId,
      acknowledgedParentSessionId: deliveredParentSessionId,
      wakeRequestedParentSessionId: null,
      wakeQueuedParentSessionId: null,
      wakeDeferredParentSessionId: null,
      wakeParentReason: null,
      wakeRequestedRunIds: [],
      wakeInterruptedRunIds: [],
      wakeDeferredRunIds: [],
      reason: delivered
        ? null
        : input.toRunId || input.toRole
          ? "No matching active child run was available for delivery."
          : "No target run or role was supplied.",
    };
    let message = SubagentMessageSchema.parse({
      id: randomUUID(),
      parentGoalId,
      fromRunId,
      toRunId: input.toRunId ?? null,
      toRole: input.toRole ?? null,
      kind: input.kind,
      priority,
      body: input.body,
      refs: [],
      delivery,
      createdAt: now(),
    });
    await deliverSubagentMessageToReceivers(context, message, recipientRuns);
    const wake = priority === "interrupt"
      ? await wakeInterruptPrioritySubagentRuns(context, message, recipientRuns)
      : null;
    if (wake) {
      delivery = SubagentMessageSchema.parse({
        ...message,
        delivery: {
          ...delivery,
          wakeRequestedRunIds: wake.requestedRunIds,
          wakeInterruptedRunIds: wake.interruptedRunIds,
          wakeDeferredRunIds: wake.deferredRunIds,
        },
      }).delivery!;
      message = { ...message, delivery };
    }
    delivery = await maybeWakeParentForSubagentMessage(context, message, delivery);
    message = SubagentMessageSchema.parse({ ...message, delivery });
    await deps.appendMessage(message);
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "subagent.message",
        source: "provider",
        appId: context.session.appId,
        status: delivery.status === "delivered" ? "completed" : "pending",
        output: priority === "interrupt"
          ? `Interrupt subagent message sent: ${message.kind}.`
          : `Subagent message sent: ${message.kind}.`,
        data: { message, delivery, deliveredRunIds },
      }),
    );
    if (context.session.parentSessionId && context.session.parentSessionId !== context.session.id) {
      await appendRuntimeEvent(
        event({
          sessionId: context.session.parentSessionId,
          turnId: context.turnId,
          name: "subagent.message",
          source: "server",
          appId: context.session.appId,
          status: "completed",
          output: `Subagent ${fromRunId} sent ${message.kind}.`,
          data: {
            message,
            delivery,
            deliveredRunIds,
            childSessionId: context.session.id,
            roleId: context.session.subagentRoleId ?? null,
          },
        }),
      );
    }
    return {
      messageId: message.id,
      delivery,
      nextStep: subagentMessageDeliveryNextStep({ priority, deliveredRunIds, delivery }),
    };
  }

  function subagentMessageParentDeliveryTarget(
    session: Session,
    input: OpenPondSubagentMessageToolInput,
  ): string | null {
    if (!session.parentSessionId || session.parentSessionId === session.id) return null;
    const toRunId = input.toRunId?.trim() || null;
    const toRole = input.toRole?.trim().toLowerCase() || null;
    if (!toRunId && !toRole) return session.parentSessionId;
    if (toRunId === session.parentSessionId) return session.parentSessionId;
    if (toRole === "parent") return session.parentSessionId;
    return null;
  }

  async function maybeWakeParentForSubagentMessage(
    context: ModelToolExecutionContext,
    message: SubagentMessage,
    delivery: SubagentMessageDelivery,
  ): Promise<SubagentMessageDelivery> {
    const parentSessionId = delivery.deliveredParentSessionId ?? null;
    if (!parentSessionId || !context.session.subagentRunId || context.session.parentSessionId !== parentSessionId) {
      return delivery;
    }

    let nextDelivery = SubagentMessageDeliverySchema.parse({
      ...delivery,
      wakeRequestedParentSessionId: parentSessionId,
      wakeParentReason: "child_to_parent_handoff",
    });

    if (activeTurns.has(parentSessionId)) {
      return SubagentMessageDeliverySchema.parse({
        ...nextDelivery,
        wakeDeferredParentSessionId: parentSessionId,
        wakeParentReason: "parent_turn_active",
      });
    }

    const snapshot = await store.snapshot();
    if (subagentParentWakeJobs.has(message.id) || subagentParentWakeAlreadyTurned(snapshot.turns, message.id)) {
      return SubagentMessageDeliverySchema.parse({
        ...nextDelivery,
        wakeQueuedParentSessionId: parentSessionId,
        wakeParentReason: "parent_wake_already_queued",
      });
    }

    const chainCount = subagentParentWakeChainCount(snapshot.turns, parentSessionId, message.fromRunId);
    if (chainCount >= SUBAGENT_PARENT_WAKE_MAX_CHAIN) {
      return SubagentMessageDeliverySchema.parse({
        ...nextDelivery,
        wakeDeferredParentSessionId: parentSessionId,
        wakeParentReason: `parent_wake_loop_limit:${SUBAGENT_PARENT_WAKE_MAX_CHAIN}`,
      });
    }

    const parentSession = await getSession(parentSessionId).catch(() => null);
    if (!parentSession) {
      return SubagentMessageDeliverySchema.parse({
        ...nextDelivery,
        wakeDeferredParentSessionId: parentSessionId,
        wakeParentReason: "parent_session_missing",
      });
    }

    const requestedAt = now();
    const receipt = turnFollowUpQueue.enqueue(
      {
        label: `Subagent handoff from ${context.session.subagentRoleId ?? context.session.subagentRunId}`,
        metadata: {
          messageId: message.id,
          parentSessionId,
          childSessionId: context.session.id,
          fromRunId: message.fromRunId,
          kind: message.kind,
        },
      },
      async () => {
        try {
          await sendTurn(parentSessionId, {
            prompt: subagentParentWakePrompt({
              parentSession,
              childSession: context.session,
              message,
            }),
            metadata: {
              subagentParentWake: {
                messageId: message.id,
                parentGoalId: message.parentGoalId,
                fromRunId: message.fromRunId,
                childSessionId: context.session.id,
                childRoleId: context.session.subagentRoleId ?? null,
                kind: message.kind,
                requestedAt,
              },
            },
          });
        } catch (error) {
          await appendRuntimeEvent(
            event({
              sessionId: parentSessionId,
              name: "diagnostic",
              source: "server",
              appId: parentSession.appId,
              status: "failed",
              output: textFromUnknown(error) || "Failed to wake parent for subagent handoff.",
              data: {
                kind: "subagent_parent_wake_failed",
                messageId: message.id,
                fromRunId: message.fromRunId,
                childSessionId: context.session.id,
              },
            }),
          ).catch(() => undefined);
        } finally {
          subagentParentWakeJobs.delete(message.id);
        }
      },
    );
    subagentParentWakeJobs.set(message.id, receipt);
    nextDelivery = SubagentMessageDeliverySchema.parse({
      ...nextDelivery,
      wakeQueuedParentSessionId: parentSessionId,
      wakeParentReason: "parent_wake_queued",
    });
    return nextDelivery;
  }

  function subagentParentWakeAlreadyTurned(turns: Turn[], messageId: string): boolean {
    return turns.some((turn) => {
      const metadata = recordFromUnknown(turn.metadata);
      const wake = recordFromUnknown(metadata?.subagentParentWake);
      return wake ? stringFromRecord(wake, "messageId") === messageId : false;
    });
  }

  function subagentParentWakeChainCount(turns: Turn[], parentSessionId: string, fromRunId: string): number {
    return turns.filter((turn) => {
      if (turn.sessionId !== parentSessionId) return false;
      const metadata = recordFromUnknown(turn.metadata);
      const wake = recordFromUnknown(metadata?.subagentParentWake);
      return wake ? stringFromRecord(wake, "fromRunId") === fromRunId : false;
    }).length;
  }

  function subagentParentWakePrompt(input: {
    parentSession: Session;
    childSession: Session;
    message: SubagentMessage;
  }): string {
    const role = input.childSession.subagentRoleId ?? "subagent";
    const refs = input.message.refs.length
      ? input.message.refs.slice(0, 8).map((ref) => `- ${ref.kind}:${ref.id} (${ref.label})`).join("\n")
      : "None.";
    return [
      `A ${role} subagent sent a ${input.message.kind} handoff to this main chat.`,
      "",
      `Child run: ${input.message.fromRunId}`,
      `Child conversation: ${input.childSession.id}`,
      input.message.parentGoalId ? `Goal: ${input.message.parentGoalId}` : null,
      "",
      "Message:",
      input.message.body,
      "",
      "Refs:",
      refs,
      "",
      "Decide the next step as the main agent. You may respond to the user, update the goal, message the child back with openpond_subagent_send_message, route work to another child, join/cancel a child, or continue without action. Do not poll for routine lifecycle status unless a fresh diagnostic snapshot is actually needed.",
    ].filter(Boolean).join("\n");
  }

  async function resolveSubagentMessageRecipients(
    context: ModelToolExecutionContext,
    input: {
      parentGoalId: string | null;
      toRunId: string | null;
      toRole: string | null;
    },
  ): Promise<SubagentRun[]> {
    const deps = requireSubagentDeps();
    const parentSessionId = context.session.parentSessionId ?? context.session.id;
    const recipients = input.toRunId
      ? [(await deps.getRun(input.toRunId))].filter((run): run is SubagentRun => Boolean(run))
      : input.toRole
        ? await deps.listRuns({
            parentSessionId,
            parentGoalId: input.parentGoalId ?? undefined,
            status: ["queued", "running", "needs_resume"],
            limit: 50,
          })
        : [];
    return recipients.filter((run) => {
      if (run.parentSessionId !== parentSessionId) return false;
      if (input.toRole && run.roleId !== input.toRole) return false;
      if (!run.childSessionId) return false;
      return true;
    });
  }

  async function deliverSubagentMessageToReceivers(
    context: ModelToolExecutionContext,
    message: SubagentMessage,
    recipients: SubagentRun[],
  ): Promise<void> {
    for (const run of recipients) {
      const childSessionId = run.childSessionId;
      if (!childSessionId) continue;
      await appendRuntimeEvent(
        event({
          sessionId: childSessionId,
          name: "subagent.message",
          source: "server",
          appId: context.session.appId,
          status: "pending",
          output: message.priority === "interrupt"
            ? `Interrupt subagent message received: ${message.kind}.`
            : `Subagent message received: ${message.kind}.`,
          data: {
            message,
            delivery: message.delivery ?? null,
            deliveredToRunId: run.id,
            acknowledgedRunId: run.id,
            priority: message.priority ?? "normal",
          },
        }),
      );
    }
  }

  async function wakeInterruptPrioritySubagentRuns(
    context: ModelToolExecutionContext,
    message: SubagentMessage,
    recipients: SubagentRun[],
  ): Promise<{ requestedRunIds: string[]; interruptedRunIds: string[]; deferredRunIds: string[] }> {
    const deps = requireSubagentDeps();
    const requestedRunIds: string[] = [];
    const interruptedRunIds: string[] = [];
    const deferredRunIds: string[] = [];
    for (const recipient of recipients) {
      if (!recipient.childSessionId) continue;
      requestedRunIds.push(recipient.id);
      const active = activeTurns.get(recipient.childSessionId);
      const activeTurnId = active?.turn.id ?? null;
      const requestedAt = now();
      let wakeStatus = active ? "interrupting" : "deferred";
      let interruptError: string | null = null;
      const latestRun = (await deps.getRun(recipient.id).catch(() => null)) ?? recipient;
      let updated = SubagentRunSchema.parse({
        ...latestRun,
        metadata: withSubagentInterruptWakeMetadata(latestRun.metadata, {
          messageId: message.id,
          kind: message.kind,
          fromRunId: message.fromRunId,
          priority: message.priority ?? "normal",
          requestedAt,
          activeTurnId,
          status: wakeStatus,
        }),
      });
      await deps.upsertRun(updated);
      if (active) {
        try {
          await interruptActiveTurn(active, `Interrupted for subagent message ${message.id}`);
          wakeStatus = "interrupted";
          interruptedRunIds.push(recipient.id);
        } catch (error) {
          wakeStatus = "deferred";
          interruptError = textFromUnknown(error) || "Failed to interrupt active child turn.";
          deferredRunIds.push(recipient.id);
        }
      } else {
        deferredRunIds.push(recipient.id);
      }
      updated = SubagentRunSchema.parse({
        ...updated,
        metadata: withSubagentInterruptWakeMetadata(updated.metadata, {
          messageId: message.id,
          kind: message.kind,
          fromRunId: message.fromRunId,
          priority: message.priority ?? "normal",
          requestedAt,
          activeTurnId,
          status: wakeStatus,
          ...(interruptError ? { error: interruptError } : {}),
        }),
      });
      await deps.upsertRun(updated);
      const parentSession = await getSession(updated.parentSessionId).catch(() => context.session);
      await appendSubagentReceipt({
        parentSession,
        parentTurnId: updated.parentTurnId ?? context.turnId,
        run: updated,
        eventName: "subagent.progress",
        status: "pending",
        output: active
          ? `${updated.roleId} subagent received interrupt steering and is waking at a fresh model boundary.`
          : `${updated.roleId} subagent received interrupt steering and will read it at the next model boundary.`,
      });
    }
    return { requestedRunIds, interruptedRunIds, deferredRunIds };
  }

  function subagentMessageDeliveryNextStep(input: {
    priority: SubagentMessagePriority;
    deliveredRunIds: string[];
    delivery: SubagentMessageDelivery;
  }): string {
    const deliveredToParent = Boolean(input.delivery.deliveredParentSessionId);
    if (input.deliveredRunIds.length === 0 && !deliveredToParent) {
      return "Message persisted in the goal-scoped subagent mailbox.";
    }
    const prefix = input.priority === "interrupt" ? "Interrupt message" : "Message";
    const childDelivery = input.deliveredRunIds.length > 0
      ? `${input.deliveredRunIds.length} subagent run${input.deliveredRunIds.length === 1 ? "" : "s"}`
      : null;
    const base = childDelivery && deliveredToParent
      ? `${prefix} persisted, delivered and acknowledged by ${childDelivery} and delivered to the parent chat at the runtime boundary.`
      : childDelivery
        ? `${prefix} persisted, delivered, and acknowledged by ${childDelivery} at the runtime boundary.`
        : `${prefix} persisted, delivered to the parent chat at the runtime boundary.`;
    const parentWake = input.delivery.wakeQueuedParentSessionId
      ? " Main agent wake queued for this parent handoff."
      : input.delivery.wakeDeferredParentSessionId
        ? ` Main agent wake deferred (${input.delivery.wakeParentReason ?? "deferred"}).`
        : "";
    if (input.priority !== "interrupt") return `${base}${parentWake}`;
    const interrupted = input.delivery.wakeInterruptedRunIds?.length ?? 0;
    const deferred = input.delivery.wakeDeferredRunIds?.length ?? 0;
    if (interrupted > 0) {
      return `${base}${parentWake} Woke ${interrupted} active child turn${interrupted === 1 ? "" : "s"} for a fresh model boundary.`;
    }
    if (deferred > 0) {
      return `${base}${parentWake} No active child turn needed interruption; delivery is queued for the next child model boundary.`;
    }
    return `${base}${parentWake}`;
  }

  function withSubagentInterruptWakeMetadata(
    metadata: Record<string, unknown> | undefined,
    wake: Record<string, unknown>,
  ): Record<string, unknown> {
    const current = recordFromUnknown(metadata) ?? {};
    const history = Array.isArray(current.interruptWakeHistory)
      ? current.interruptWakeHistory.filter((item) => recordFromUnknown(item)).slice(-19)
      : [];
    const nextWake = {
      ...(recordFromUnknown(current.interruptWake) ?? {}),
      ...wake,
    };
    return {
      ...current,
      interruptWake: nextWake,
      interruptWakeHistory: [...history, nextWake],
    };
  }

  async function runSubagentChildTurn(input: {
    run: SubagentRun;
    role: SubagentRoleSettings;
    childSession: Session;
    parentSession: Session;
    parentTurnId: string;
    contextPack: string | null;
    workerBrief: SubagentWorkerBrief;
    childTurnPermissions: SubagentTurnPermissions;
  }): Promise<void> {
    const deps = requireSubagentDeps();
    const latestBeforeStart = await deps.getRun(input.run.id);
    if (latestBeforeStart?.status === "cancelled") return;
    const startedAt = now();
    let run = SubagentRunSchema.parse({
      ...(latestBeforeStart ?? input.run),
      status: "running",
      startedAt,
      progress: SubagentProgressSchema.parse({
        ...((latestBeforeStart ?? input.run).progress ?? {}),
        phase: "orient",
        latestMeaningfulActivity: "Child subagent turn started.",
        currentBlocker: null,
        updatedAt: startedAt,
      }),
    });
    await deps.upsertRun(run);
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run,
      eventName: "subagent.started",
      status: "started",
      output: `${run.roleId} subagent is running.`,
    });
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run,
      eventName: "subagent.progress",
      status: "pending",
      output: `${run.roleId} subagent is working in child conversation ${run.childSessionId ?? "unknown"}.`,
    });
    try {
      let childPrompt = subagentChildPrompt({
        objective: input.run.objective,
        contextPack: input.contextPack,
        workerBrief: input.workerBrief,
      });
      let wakeResumeCount = 0;
      while (true) {
        const childTurn = await sendTurn(input.childSession.id, {
          prompt: childPrompt,
          modelRef: input.run.modelRef ?? undefined,
          metadata: {
            subagentRunId: input.run.id,
            parentSessionId: input.parentSession.id,
            parentTurnId: input.parentTurnId,
            parentGoalId: input.run.parentGoalId,
            subagentRoleId: input.run.roleId,
            subagentPermissions: input.childTurnPermissions,
            usageAttribution: subagentUsageAttribution(input.run),
          },
          usageAttribution: subagentUsageAttribution(input.run),
          approvalPolicy: input.childTurnPermissions.approvalPolicy,
          sandbox: input.childTurnPermissions.sandbox,
          codexPermissionMode: input.childTurnPermissions.codexPermissionMode,
          codexReasoningEffort: input.childTurnPermissions.codexReasoningEffort,
        });
        const finalizedChildTurn = await finalizedSubagentChildTurn(childTurn);
        const latestAfterChild = await deps.getRun(run.id);
        if (latestAfterChild?.status === "cancelled") return;
        run = latestAfterChild ?? run;
        run = await refreshSubagentRuntimeDerivedProgress({
          run,
          childSessionId: input.childSession.id,
        });
        if (finalizedChildTurn.status === "interrupted") {
          const wake = subagentInterruptWakeForTurn(run, finalizedChildTurn.id);
          if (wake && wakeResumeCount < SUBAGENT_INTERRUPT_WAKE_MAX_RESUMES) {
            wakeResumeCount += 1;
            run = await markSubagentInterruptWakeResuming({
              run,
              interruptedTurnId: finalizedChildTurn.id,
              wake,
              resumeCount: wakeResumeCount,
            });
            await appendSubagentReceipt({
              parentSession: input.parentSession,
              parentTurnId: input.parentTurnId,
              run,
              eventName: "subagent.progress",
              status: "pending",
              output: `${run.roleId} subagent is resuming after interrupt steering.`,
            });
            childPrompt = subagentInterruptWakeResumePrompt({
              run,
              interruptedTurnId: finalizedChildTurn.id,
              wake,
            });
            continue;
          }
        }
        if (finalizedChildTurn.status !== "completed") {
          throw new Error(finalizedChildTurn.error || `Child turn ended with status ${finalizedChildTurn.status}.`);
        }
        break;
      }
      const submittedAt = now();
      const summary = await latestAssistantTextForSession(input.childSession.id);
      const usage = await subagentUsageTotalsForRun(input.run.id);
      const workspaceHandoff = await captureSubagentWorkspaceHandoff(run);
      const derivedProgress = await subagentRuntimeDerivedProgress({
        run,
        childSessionId: input.childSession.id,
        phase: "submitted",
        latestMeaningfulActivity: "Child submitted a final report for parent review.",
        currentBlocker: null,
      });
      const handoffChangedFiles = uniqueNonEmptyStrings([
        ...(derivedProgress.changedFiles ?? []),
        ...(workspaceHandoff?.changedFiles ?? []),
      ]);
      const submittedReport = {
        summary: summary || "Child conversation completed.",
        findings: [],
        artifacts: workspaceHandoff?.artifacts ?? [],
        patchRef: workspaceHandoff?.patchRef ?? null,
        diffRef: workspaceHandoff?.diffRef ?? null,
        testsRun: [],
        blockers: [],
        confidence: null,
        followUpNeeded: workspaceHandoff?.changed ?? false,
      };
      const submittedProgress = SubagentProgressSchema.parse({
        ...derivedProgress,
        phase: "submitted",
        changedFiles: handoffChangedFiles,
        patchRefs: uniqueSubagentRefs([
          ...(derivedProgress.patchRefs ?? []),
          workspaceHandoff?.patchRef ?? null,
          workspaceHandoff?.diffRef ?? null,
        ]),
        latestMeaningfulActivity: "Child submitted a final report for parent review.",
        currentBlocker: derivedProgress.currentBlocker,
        updatedAt: submittedAt,
      });
      const packetQuality = subagentReviewPacketQuality({
        run,
        finalSummary: summary,
        report: submittedReport,
        progress: submittedProgress,
      });
      const submittedReviewReport: NonNullable<SubagentRun["report"]> = {
        ...submittedReport,
        confidence: packetQuality.status === "weak" ? "low" : submittedReport.confidence,
        followUpNeeded: submittedReport.followUpNeeded || packetQuality.status !== "reviewable",
      };
      const reviewRouting = subagentReviewRoutingRecommendation({
        run,
        reviewRoutingPolicy: input.role.reviewRouting,
        packetQuality,
        report: submittedReviewReport,
        progress: submittedProgress,
      });
      const packetIncomplete = packetQuality.status === "incomplete";
      const packetBlocker = packetQuality.issues[0] ?? "Child review packet is incomplete.";
      run = SubagentRunSchema.parse({
        ...run,
        status: packetIncomplete ? "blocked" : "submitted_for_review",
        completedAt: packetIncomplete ? submittedAt : null,
        error: packetIncomplete ? packetBlocker : null,
        report: {
          ...submittedReviewReport,
          blockers: packetIncomplete
            ? uniqueNonEmptyStrings([...submittedReviewReport.blockers, ...packetQuality.issues])
            : submittedReviewReport.blockers,
        },
        progress: SubagentProgressSchema.parse({
          ...submittedProgress,
          phase: packetIncomplete ? "report" : submittedProgress.phase,
          latestMeaningfulActivity: packetIncomplete
            ? "Child finished without a reviewable final report."
            : submittedProgress.latestMeaningfulActivity,
          currentBlocker: packetIncomplete ? packetBlocker : submittedProgress.currentBlocker,
        }),
        review: SubagentReviewStateSchema.parse({
          ...(run.review ?? {}),
          status: packetIncomplete ? "needs_user_input" : "submitted_for_review",
          submittedAt,
          summary: summary || submittedReport.summary,
          issues: packetIncomplete
            ? uniqueNonEmptyStrings([...(run.review?.issues ?? []), ...packetQuality.issues])
            : run.review?.issues ?? [],
          humanReviewRecommended: packetQuality.status !== "reviewable" || (workspaceHandoff?.changed ?? false),
          ...reviewRouting,
          packetQuality,
        }),
        metadata: {
          ...(run.metadata ?? {}),
          usage,
          ...(workspaceHandoff ? { workspaceHandoff: workspaceHandoff.metadata } : {}),
        },
      });
      await deps.upsertRun(run);
      if (workspaceHandoff?.changed && !packetIncomplete) {
        await appendSubagentReceipt({
          parentSession: input.parentSession,
          parentTurnId: input.parentTurnId,
          run,
          eventName: "subagent.reported",
          status: "pending",
          output: `${run.roleId} subagent produced an isolated patch for parent review.`,
        });
        await requestSubagentPatchApplyApproval({
          parentSession: input.parentSession,
          parentTurnId: input.parentTurnId,
          run,
        });
      }
      await appendSubagentReceipt({
        parentSession: input.parentSession,
        parentTurnId: input.parentTurnId,
        run,
        eventName: packetIncomplete ? "subagent.blocked" : "subagent.submitted",
        status: packetIncomplete ? "failed" : "pending",
        output: packetIncomplete
          ? `${run.roleId} subagent submitted an incomplete review packet: ${packetBlocker}`
          : `${run.roleId} subagent submitted a review packet.`,
      });
    } catch (error) {
      const latestAfterError = await deps.getRun(run.id).catch(() => null);
      if (latestAfterError?.status === "cancelled") return;
      const message = textFromUnknown(error) || "Subagent failed.";
      const failedAt = now();
      const workspaceHandoff = await captureSubagentWorkspaceHandoff(run).catch(() => null);
      const failedWithArtifacts = Boolean(workspaceHandoff?.changed || workspaceHandoff?.artifacts.length);
      const derivedProgress = await subagentRuntimeDerivedProgress({
        run,
        childSessionId: input.childSession.id,
        phase: "report",
        latestMeaningfulActivity: failedWithArtifacts
          ? "Child failed after producing recoverable artifacts."
          : "Child failed before producing a final report.",
        currentBlocker: message,
      });
      const validationAttempts = derivedProgress.validationAttempts ?? [];
      const lastValidationAttempt = validationAttempts.at(-1) ?? null;
      const failureBlockers = uniqueNonEmptyStrings([
        message,
        ...(derivedProgress.currentBlocker ? [derivedProgress.currentBlocker] : []),
      ]);
      const handoffChangedFiles = uniqueNonEmptyStrings([
        ...(derivedProgress.changedFiles ?? []),
        ...(workspaceHandoff?.changedFiles ?? []),
      ]);
      const failureHandoff = {
        status: failedWithArtifacts ? "recoverable_artifacts" : "failed_without_artifacts",
        capturedAt: failedAt,
        error: message,
        confidence: "low",
        changedFiles: handoffChangedFiles,
        patchRef: workspaceHandoff?.patchRef ?? null,
        diffRef: workspaceHandoff?.diffRef ?? null,
        artifacts: workspaceHandoff?.artifacts ?? [],
        validationAttempts,
        lastValidationAttempt,
        blockers: failureBlockers,
      };
      const failureReport: NonNullable<SubagentRun["report"]> = {
        summary: failedWithArtifacts
          ? "Child conversation failed after producing recoverable artifacts."
          : "Child conversation failed before producing a final report.",
        findings: [],
        artifacts: workspaceHandoff?.artifacts ?? [],
        patchRef: workspaceHandoff?.patchRef ?? null,
        diffRef: workspaceHandoff?.diffRef ?? null,
        testsRun: uniqueNonEmptyStrings(validationAttempts.map((attempt) => attempt.command)),
        blockers: failureBlockers,
        confidence: "low",
        followUpNeeded: true,
      };
      const failureProgress = SubagentProgressSchema.parse({
        ...derivedProgress,
        phase: "report",
        changedFiles: handoffChangedFiles,
        patchRefs: uniqueSubagentRefs([
          ...(derivedProgress.patchRefs ?? []),
          workspaceHandoff?.patchRef ?? null,
          workspaceHandoff?.diffRef ?? null,
        ]),
        latestMeaningfulActivity: failedWithArtifacts
          ? "Child failed after producing recoverable artifacts."
          : "Child failed before producing a final report.",
        currentBlocker: message,
        updatedAt: failedAt,
      });
      const failureReviewRouting = failedWithArtifacts
        ? subagentReviewRoutingRecommendation({
            run,
            reviewRoutingPolicy: input.role.reviewRouting,
            packetQuality: run.review.packetQuality,
            report: failureReport,
            progress: failureProgress,
            providerFailureAfterChanges: handoffChangedFiles.length > 0,
          })
        : null;
      run = SubagentRunSchema.parse({
        ...run,
        status: failedWithArtifacts ? "failed_with_artifacts" : "failed",
        completedAt: failedAt,
        error: message,
        report: failureReport,
        progress: failureProgress,
        review: failedWithArtifacts
          ? SubagentReviewStateSchema.parse({
              ...(run.review ?? {}),
              status: "failed_with_artifacts",
              submittedAt: failedAt,
              summary: "Child failed after producing recoverable artifacts.",
              issues: failureBlockers,
              humanReviewRecommended: true,
              ...(failureReviewRouting ?? {}),
            })
          : run.review,
        metadata: {
          ...(run.metadata ?? {}),
          ...(workspaceHandoff ? { workspaceHandoff: workspaceHandoff.metadata } : {}),
          failureHandoff,
        },
      });
      await deps.upsertRun(run);
      await appendSubagentReceipt({
        parentSession: input.parentSession,
        parentTurnId: input.parentTurnId,
        run,
        eventName: "subagent.failed",
        status: "failed",
        output: failedWithArtifacts
          ? `${run.roleId} subagent failed after producing recoverable artifacts: ${message}`
          : `${run.roleId} subagent failed: ${message}`,
      });
    }
  }

  async function finalizedSubagentChildTurn(turn: Turn): Promise<Turn> {
    let latest = (await getStoredTurn(turn.id)) ?? turn;
    if (latest.status !== "in_progress") return latest;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await delay(250);
      latest = (await getStoredTurn(turn.id)) ?? latest;
      if (latest.status !== "in_progress") return latest;
    }
    return latest;
  }

  function subagentInterruptWakeForTurn(run: SubagentRun, turnId: string): Record<string, unknown> | null {
    const wake = recordFromUnknown(recordFromUnknown(run.metadata)?.interruptWake);
    if (!wake) return null;
    if (stringFromRecord(wake, "activeTurnId") !== turnId) return null;
    const status = stringFromRecord(wake, "status");
    if (status !== "interrupted" && status !== "interrupting") return null;
    if (!stringFromRecord(wake, "messageId")) return null;
    return wake;
  }

  async function markSubagentInterruptWakeResuming(input: {
    run: SubagentRun;
    interruptedTurnId: string;
    wake: Record<string, unknown>;
    resumeCount: number;
  }): Promise<SubagentRun> {
    const deps = requireSubagentDeps();
    const updated = SubagentRunSchema.parse({
      ...input.run,
      status: "running",
      completedAt: null,
      error: null,
      metadata: withSubagentInterruptWakeMetadata(input.run.metadata, {
        ...input.wake,
        status: "resuming",
        interruptedTurnId: input.interruptedTurnId,
        resumeCount: input.resumeCount,
        resumedAt: now(),
      }),
    });
    await deps.upsertRun(updated);
    return updated;
  }

  function subagentInterruptWakeResumePrompt(input: {
    run: SubagentRun;
    interruptedTurnId: string;
    wake: Record<string, unknown>;
  }): string {
    const messageId = stringFromRecord(input.wake, "messageId") ?? "unknown";
    return [
      "A high-priority subagent mailbox message interrupted your previous child turn.",
      `Message id: ${messageId}`,
      `Interrupted turn: ${input.interruptedTurnId}`,
      `Original assignment: ${input.run.objective}`,
      "Read the Subagent mailbox interrupt in this turn context, apply that steering, and continue the assignment.",
      "If the interrupted work was a wait, sleep, or polling command, do not repeat it unless the updated assignment still requires it.",
    ].join("\n");
  }

  async function appendSubagentReceipt(input: {
    parentSession: Session;
    parentTurnId?: string | null;
    run: SubagentRun;
    eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
    status: RuntimeEvent["status"];
    output: string;
  }): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: input.parentSession.id,
        turnId: input.parentTurnId ?? undefined,
        name: input.eventName,
        source: "server",
        appId: input.parentSession.appId,
        status: input.status,
        output: input.output,
        data: {
          run: input.run,
          childSessionId: input.run.childSessionId,
          parentGoalId: input.run.parentGoalId,
        },
      }),
    );
  }

  async function appendSubagentReviewCorrectionMessage(input: {
    context: ModelToolExecutionContext;
    run: SubagentRun;
    summary: string | null;
    issues: string[];
    requiredCorrections: string[];
    priority: SubagentMessagePriority;
  }): Promise<SubagentMessage | null> {
    const deps = requireSubagentDeps();
    const delivered = Boolean(input.run.childSessionId);
    let delivery: SubagentMessageDelivery = {
      status: delivered ? "delivered" : "undelivered",
      deliveredRunIds: delivered ? [input.run.id] : [],
      acknowledgedRunIds: delivered ? [input.run.id] : [],
      deliveredParentSessionId: null,
      acknowledgedParentSessionId: null,
      wakeRequestedParentSessionId: null,
      wakeQueuedParentSessionId: null,
      wakeDeferredParentSessionId: null,
      wakeParentReason: null,
      wakeRequestedRunIds: [],
      wakeInterruptedRunIds: [],
      wakeDeferredRunIds: [],
      reason: delivered ? null : "The reviewed child run has no child session for correction delivery.",
    };
    let message = SubagentMessageSchema.parse({
      id: randomUUID(),
      parentGoalId: input.run.parentGoalId,
      fromRunId: input.context.session.subagentRunId ?? `parent:${input.context.session.id}`,
      toRunId: input.run.id,
      toRole: input.run.roleId,
      kind: "status",
      priority: input.priority,
      body: subagentReviewCorrectionBody(input),
      refs: [],
      delivery,
      createdAt: now(),
    });
    if (delivered) {
      await deliverSubagentMessageToReceivers(input.context, message, [input.run]);
    }
    const wake = input.priority === "interrupt"
      ? await wakeInterruptPrioritySubagentRuns(input.context, message, [input.run])
      : null;
    if (wake) {
      delivery = SubagentMessageSchema.parse({
        ...message,
        delivery: {
          ...delivery,
          wakeRequestedRunIds: wake.requestedRunIds,
          wakeInterruptedRunIds: wake.interruptedRunIds,
          wakeDeferredRunIds: wake.deferredRunIds,
        },
      }).delivery!;
      message = { ...message, delivery };
    }
    message = SubagentMessageSchema.parse({ ...message, delivery });
    await deps.appendMessage(message);
    await appendRuntimeEvent(
      event({
        sessionId: input.context.session.id,
        turnId: input.context.turnId,
        name: "subagent.message",
        source: "provider",
        appId: input.context.session.appId,
        status: delivery.status === "delivered" ? "completed" : "pending",
        output: input.priority === "interrupt"
          ? "Interrupt subagent review correction sent."
          : "Subagent review correction sent.",
        data: { message, delivery, deliveredRunIds: delivery.deliveredRunIds },
      }),
    );
    return message;
  }

  function subagentReviewCorrectionBody(input: {
    summary: string | null;
    issues: string[];
    requiredCorrections: string[];
  }): string {
    return [
      "Review decision: needs_revision.",
      input.summary ? `Summary: ${input.summary}` : null,
      input.issues.length ? `Issues:\n${input.issues.map((issue) => `- ${issue}`).join("\n")}` : null,
      input.requiredCorrections.length
        ? `Required corrections:\n${input.requiredCorrections.map((correction) => `- ${correction}`).join("\n")}`
        : null,
      "Revise the submission, run relevant validation, and submit a new review packet.",
    ].filter(Boolean).join("\n\n");
  }

  function subagentReviewable(run: SubagentRun): boolean {
    return (
      run.status === "submitted_for_review" ||
      run.status === "needs_revision" ||
      run.status === "needs_user_input" ||
      run.status === "failed_with_artifacts" ||
      run.review.status === "submitted_for_review" ||
      run.review.status === "needs_revision" ||
      run.review.status === "needs_user_input" ||
      run.review.status === "failed_with_artifacts"
    );
  }

  function subagentDismissable(run: SubagentRun): boolean {
    return run.status === "blocked" ||
      run.status === "failed" ||
      run.status === "failed_with_artifacts" ||
      run.status === "cancelled";
  }

  async function requestSubagentPatchApplyApproval(input: {
    parentSession: Session;
    parentTurnId: string;
    run: SubagentRun;
  }): Promise<Approval | null> {
    const handoff = workspaceHandoffFromRun(input.run);
    if (!handoff || !truthyRecordBoolean(handoff, "changed")) return null;
    const patchPath = stringFromRecord(handoff, "patchPath");
    const parentRepoPath = stringFromRecord(handoff, "parentRepoPath");
    if (!patchPath || !parentRepoPath) return null;
    const approvalId = `approval_subagent_patch_${input.run.id}`;
    const existing = await store.getApproval(approvalId);
    if (existing) return existing;
    const approval: Approval = {
      id: approvalId,
      sessionId: input.parentSession.id,
      turnId: input.parentTurnId,
      providerRequestId: input.run.id,
      kind: "subagent_patch_apply",
      title: `Apply ${input.run.roleId} subagent patch: ${truncateApprovalTitle(input.run.objective)}`,
      detail: JSON.stringify(
        {
          runId: input.run.id,
          roleId: input.run.roleId,
          childSessionId: input.run.childSessionId,
          parentGoalId: input.run.parentGoalId,
          objective: input.run.objective,
          summary: input.run.report?.summary ?? null,
          parentRepoPath,
          patchPath,
          branch: handoff.branch ?? null,
          baseCommit: handoff.baseCommit ?? null,
          patchBytes: handoff.patchBytes ?? null,
          patchPreview: handoff.patchPreview ?? null,
          patchTruncated: handoff.patchTruncated ?? null,
        },
        null,
        2,
      ),
      status: "pending",
      createdAt: now(),
    };
    await upsertApproval(approval);
    await appendRuntimeEvent(
      event({
        sessionId: input.parentSession.id,
        turnId: input.parentTurnId,
        name: "approval.requested",
        source: "server",
        action: "subagent_patch_apply",
        appId: input.parentSession.appId,
        status: "pending",
        output: approval.title,
        data: approval,
      }),
    );
    return approval;
  }

  function subagentToolResultFromRun(run: SubagentRun, nextStep: string): OpenPondSubagentToolResult {
    return {
      runId: run.id,
      childSessionId: run.childSessionId,
      roleId: run.roleId,
      status: run.status,
      modelRef: run.modelRef,
      isolationMode: run.isolationMode,
      toolPolicy: run.toolPolicy,
      background: run.background,
      peerMessages: run.peerMessages,
      workerBrief: run.workerBrief,
      progress: run.progress,
      review: run.review,
      report: run.report,
      nextStep,
    };
  }

  function subagentRunAccepted(run: SubagentRun): boolean {
    if (run.status === "superseded") return false;
    return run.status === "accepted" || run.status === "completed" || run.review.status === "accepted";
  }

  function subagentRunDismissed(run: SubagentRun): boolean {
    return run.review.status === "dismissed";
  }

  function subagentRoleLabel(role: SubagentRoleSettings): string {
    return role.id.slice(0, 1).toUpperCase() + role.id.slice(1).replace(/[-_]+/g, " ");
  }

  function uniqueNonEmptyStrings(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }

  function uniqueSubagentRefs(values: readonly (SubagentRef | null | undefined)[]): SubagentRef[] {
    const seen = new Set<string>();
    const result: SubagentRef[] = [];
    for (const value of values) {
      if (!value) continue;
      const key = `${value.kind}:${value.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
    return result;
  }

  async function subagentRuntimeDerivedProgress(input: {
    run: SubagentRun;
    childSessionId: string;
    phase?: SubagentProgressPhase | null;
    latestMeaningfulActivity?: string | null;
    currentBlocker?: string | null;
  }): Promise<SubagentProgress> {
    const snapshot = await store.snapshot();
    return subagentProgressFromRuntimeEvents({
      run: input.run,
      events: snapshot.events.filter((item) => item.sessionId === input.childSessionId),
      phase: input.phase ?? null,
      latestMeaningfulActivity: input.latestMeaningfulActivity ?? null,
      currentBlocker: input.currentBlocker ?? null,
    });
  }

  async function refreshSubagentRuntimeDerivedProgress(input: {
    run: SubagentRun;
    childSessionId: string;
    phase?: SubagentProgressPhase | null;
    latestMeaningfulActivity?: string | null;
    currentBlocker?: string | null;
  }): Promise<SubagentRun> {
    const deps = requireSubagentDeps();
    const progress = await subagentRuntimeDerivedProgress(input);
    if (JSON.stringify(progress) === JSON.stringify(input.run.progress)) return input.run;
    const updated = SubagentRunSchema.parse({
      ...input.run,
      progress,
    });
    await deps.upsertRun(updated);
    return updated;
  }

  function subagentProgressFromRuntimeEvents(input: {
    run: SubagentRun;
    events: RuntimeEvent[];
    phase: SubagentProgressPhase | null;
    latestMeaningfulActivity: string | null;
    currentBlocker: string | null;
  }): SubagentProgress {
    const base = SubagentProgressSchema.parse(input.run.progress ?? {});
    const inspectedFiles: string[] = [...base.inspectedFiles];
    const inspectedResources: string[] = [...base.inspectedResources];
    const changedFiles: string[] = [...base.changedFiles];
    const validationAttempts: SubagentValidationAttempt[] = [...base.validationAttempts];
    const readCounts = new Map<string, number>();
    const searchCounts = new Map<string, number>();
    const commandCounts = new Map<string, number>();
    const startedArgsByToolCallId = new Map<string, Record<string, unknown>>();
    const processedResultIds = new Set<string>();
    const validationCommands = new Set(input.run.workerBrief.validationCommands.map(normalizeCommandKey));
    let latestMeaningfulActivity = input.latestMeaningfulActivity ?? base.latestMeaningfulActivity ?? null;
    let currentBlocker = input.currentBlocker ?? base.currentBlocker ?? null;
    let updatedAt = base.updatedAt;
    let lastInferredPhase: SubagentProgressPhase = base.phase ?? "orient";

    for (const item of input.events) {
      const data = recordFromUnknown(item.data);
      if (item.name === "tool.started") {
        const toolCallId = data ? stringFromRecord(data, "toolCallId") : null;
        if (toolCallId) startedArgsByToolCallId.set(toolCallId, item.args ?? {});
        continue;
      }

      if (
        item.name !== "tool.completed" &&
        item.name !== "workspace_action_result" &&
        item.name !== "command.output"
      ) {
        continue;
      }

      const action = item.action ?? (data ? stringFromRecord(data, "tool") : null);
      if (!action) continue;
      const resultId = subagentProgressResultId(item, data);
      if (processedResultIds.has(resultId)) continue;
      processedResultIds.add(resultId);

      const resultData = subagentProgressResultData(data);
      const args = subagentProgressEventArgs(item, data, startedArgsByToolCallId);
      if (item.timestamp) updatedAt = item.timestamp;

      const resourceRefs = subagentResourceRefsFromEvent(data, resultData);
      inspectedResources.push(...resourceRefs);
      inspectedFiles.push(...resourceRefs.map(filePathFromResourceRef).filter((value): value is string => Boolean(value)));

      if (SUBAGENT_SEARCH_ACTIONS.has(action)) {
        const key = subagentSearchKey(action, args, resultData);
        if (key) incrementCount(searchCounts, key);
        const searchPaths = subagentPathsFromSearchResult(resultData);
        inspectedFiles.push(...searchPaths);
        latestMeaningfulActivity = searchPaths.length
          ? `Searched workspace context and found ${searchPaths.length} file reference${searchPaths.length === 1 ? "" : "s"}.`
          : `Searched workspace context: ${key ?? action}.`;
        lastInferredPhase = "orient";
      }

      if (SUBAGENT_READ_ACTIONS.has(action)) {
        const readTargets = uniqueNonEmptyStrings([
          ...subagentPathsFromArgs(args),
          ...subagentPathsFromReadResult(resultData),
          ...resourceRefs,
        ]);
        inspectedFiles.push(...readTargets.map((value) => filePathFromResourceRef(value) ?? value));
        const key = subagentReadKey(action, args, readTargets);
        if (key) incrementCount(readCounts, key);
        latestMeaningfulActivity = readTargets.length
          ? `Inspected ${readTargets.slice(0, 3).join(", ")}.`
          : `Inspected workspace context with ${action}.`;
        lastInferredPhase = "orient";
      }

      if (SUBAGENT_MUTATING_ACTIONS.has(action)) {
        const paths = uniqueNonEmptyStrings([
          ...subagentPathsFromArgs(args),
          ...subagentChangedPathsFromResult(resultData),
        ]);
        changedFiles.push(...paths);
        if (paths.length > 0) {
          latestMeaningfulActivity = `Changed ${paths.slice(0, 3).join(", ")}.`;
        } else {
          latestMeaningfulActivity = `Ran mutating workspace action ${action}.`;
        }
        lastInferredPhase = "edit";
      }

      if (SUBAGENT_COMMAND_ACTIONS.has(action)) {
        const attempt = subagentValidationAttemptFromEvent({
          action,
          event: item,
          args,
          resultData,
          validationCommands,
        });
        const command = attempt?.command ?? subagentCommandFromEvent(args, resultData);
        if (command) incrementCount(commandCounts, normalizeCommandKey(command));
        if (attempt) {
          validationAttempts.push(attempt);
          latestMeaningfulActivity = `Ran validation command: ${truncateForModelAside(attempt.command, 180)} (${attempt.status}).`;
          currentBlocker = attempt.status === "failed"
            ? `Validation failed: ${truncateForModelAside(attempt.command, 220)}`
            : attempt.status === "passed"
              ? null
              : currentBlocker;
          lastInferredPhase = "validate";
        }
      }

      if (item.status === "failed" && !currentBlocker) {
        currentBlocker = item.error ?? item.output ?? `${action} failed.`;
        latestMeaningfulActivity = `${action} failed.`;
        lastInferredPhase = "report";
      }
    }

    const repeatedSearches = uniqueNonEmptyStrings([
      ...base.repeatedSearches,
      ...repeatedKeys(searchCounts),
    ]);
    const repeatedReads = uniqueNonEmptyStrings([
      ...base.repeatedReads,
      ...repeatedKeys(readCounts),
    ]);
    const repeatedCommands = uniqueNonEmptyStrings([
      ...base.repeatedCommands,
      ...repeatedKeys(commandCounts),
    ]);
    const dedupedValidationAttempts = uniqueValidationAttempts(validationAttempts);
    const inferredPhase = input.phase ?? inferSubagentProgressPhase({
      basePhase: base.phase,
      lastInferredPhase,
      hasValidation: dedupedValidationAttempts.length > 0,
      hasChanges: changedFiles.length > 0 || base.patchRefs.length > 0,
      hasBlocker: Boolean(currentBlocker),
    });

    return SubagentProgressSchema.parse({
      ...base,
      phase: inferredPhase,
      inspectedFiles: uniqueNonEmptyStrings(inspectedFiles).slice(0, 500),
      inspectedResources: uniqueNonEmptyStrings(inspectedResources).slice(0, 500),
      repeatedSearches: repeatedSearches.slice(0, 200),
      repeatedReads: repeatedReads.slice(0, 200),
      repeatedCommands: repeatedCommands.slice(0, 200),
      changedFiles: uniqueNonEmptyStrings(changedFiles).slice(0, 500),
      validationAttempts: dedupedValidationAttempts.slice(-100),
      latestMeaningfulActivity,
      currentBlocker,
      updatedAt,
    });
  }

  function subagentProgressResultId(item: RuntimeEvent, data: Record<string, unknown> | null): string {
    const workspaceToolCallId = data ? stringFromRecord(data, "workspaceToolCallId") : null;
    if (workspaceToolCallId) return `workspace:${workspaceToolCallId}`;
    const toolCallId = data ? stringFromRecord(data, "toolCallId") : null;
    if (toolCallId) return `tool:${toolCallId}`;
    return item.id;
  }

  function subagentProgressResultData(data: Record<string, unknown> | null): Record<string, unknown> | null {
    return recordFromUnknown(data?.result) ?? data;
  }

  function subagentProgressEventArgs(
    item: RuntimeEvent,
    data: Record<string, unknown> | null,
    startedArgsByToolCallId: Map<string, Record<string, unknown>>,
  ): Record<string, unknown> {
    if (item.args) return item.args;
    const toolCallId = data ? stringFromRecord(data, "toolCallId") : null;
    return toolCallId ? startedArgsByToolCallId.get(toolCallId) ?? {} : {};
  }

  function subagentResourceRefsFromEvent(
    data: Record<string, unknown> | null,
    resultData: Record<string, unknown> | null,
  ): string[] {
    const refs: string[] = [];
    refs.push(...stringArrayFromUnknown(data?.resourceRefs));
    const resource = recordFromUnknown(resultData?.resource);
    const resourceRef = resource ? stringFromRecord(resource, "ref") : null;
    if (resourceRef) refs.push(resourceRef);
    const result = recordFromUnknown(resultData?.result);
    const items = Array.isArray(result?.items) ? result.items : Array.isArray(resultData?.items) ? resultData.items : [];
    for (const item of items) {
      const ref = recordFromUnknown(item) ? stringFromRecord(recordFromUnknown(item)!, "ref") : null;
      if (ref) refs.push(ref);
    }
    return uniqueNonEmptyStrings(refs);
  }

  function filePathFromResourceRef(ref: string): string | null {
    const normalized = ref.trim();
    for (const prefix of ["workspace:file:", "sandbox:file:"]) {
      if (normalized.startsWith(prefix)) return normalized.slice(prefix.length).replace(/^\/workspace\//, "");
    }
    return null;
  }

  function subagentPathsFromArgs(args: Record<string, unknown>): string[] {
    const paths: string[] = [];
    paths.push(...stringArrayFromUnknown(args.paths));
    for (const key of ["path", "fromPath", "toPath", "ref"]) {
      const value = stringFromRecord(args, key);
      if (value) paths.push(filePathFromResourceRef(value) ?? value);
    }
    const files = recordFromUnknown(args.files);
    if (files) paths.push(...Object.keys(files));
    return uniqueNonEmptyStrings(paths);
  }

  function subagentPathsFromSearchResult(resultData: Record<string, unknown> | null): string[] {
    const paths: string[] = [];
    const result = recordFromUnknown(resultData?.result);
    for (const item of [
      ...(Array.isArray(result?.items) ? result.items : []),
      ...(Array.isArray(resultData?.items) ? resultData.items : []),
      ...(Array.isArray(resultData?.matches) ? resultData.matches : []),
    ]) {
      const record = recordFromUnknown(item);
      if (!record) continue;
      const ref = stringFromRecord(record, "ref");
      const pathValue = stringFromRecord(record, "path") ?? stringFromRecord(record, "filePath");
      if (ref) paths.push(filePathFromResourceRef(ref) ?? ref);
      if (pathValue) paths.push(pathValue);
    }
    return uniqueNonEmptyStrings(paths);
  }

  function subagentPathsFromReadResult(resultData: Record<string, unknown> | null): string[] {
    const paths: string[] = [];
    const resource = recordFromUnknown(resultData?.resource);
    const resourceRef = resource ? stringFromRecord(resource, "ref") : null;
    if (resourceRef) paths.push(filePathFromResourceRef(resourceRef) ?? resourceRef);
    const file = recordFromUnknown(resultData?.file);
    const filePath = file ? stringFromRecord(file, "path") : null;
    if (filePath) paths.push(filePath);
    for (const item of Array.isArray(resultData?.files) ? resultData.files : []) {
      if (typeof item === "string") {
        paths.push(item);
        continue;
      }
      const record = recordFromUnknown(item);
      const pathValue = record ? stringFromRecord(record, "path") ?? stringFromRecord(record, "filePath") : null;
      if (pathValue) paths.push(pathValue);
    }
    const status = recordFromUnknown(resultData?.status) ?? resultData;
    for (const item of Array.isArray(status?.files) ? status.files : []) {
      const record = recordFromUnknown(item);
      const pathValue = record ? stringFromRecord(record, "path") : null;
      if (pathValue) paths.push(pathValue);
    }
    return uniqueNonEmptyStrings(paths);
  }

  function subagentChangedPathsFromResult(resultData: Record<string, unknown> | null): string[] {
    const paths = subagentPathsFromReadResult(resultData);
    const preview = recordFromUnknown(resultData?.preview);
    for (const key of ["path", "filePath"]) {
      const value = preview ? stringFromRecord(preview, key) : null;
      if (value) paths.push(value);
    }
    return uniqueNonEmptyStrings(paths);
  }

  function subagentSearchKey(
    action: string,
    args: Record<string, unknown>,
    resultData: Record<string, unknown> | null,
  ): string | null {
    const query = stringFromRecord(args, "query")
      ?? stringFromRecord(recordFromUnknown(resultData?.result) ?? {}, "query")
      ?? stringFromRecord(resultData ?? {}, "query");
    return query ? `${action}:${query.trim().toLowerCase()}` : action;
  }

  function subagentReadKey(action: string, args: Record<string, unknown>, readTargets: string[]): string | null {
    const ref = stringFromRecord(args, "ref");
    if (ref) return `${action}:${ref}`;
    if (readTargets.length > 0) return `${action}:${readTargets.join(",")}`;
    return action;
  }

  function subagentValidationAttemptFromEvent(input: {
    action: string;
    event: RuntimeEvent;
    args: Record<string, unknown>;
    resultData: Record<string, unknown> | null;
    validationCommands: Set<string>;
  }): SubagentValidationAttempt | null {
    const command = subagentCommandFromEvent(input.args, input.resultData);
    if (!command || !shouldTrackSubagentValidationCommand(command, input.validationCommands)) return null;
    const commandRecord = subagentCommandRecord(input.resultData);
    const output = subagentCommandOutput(input.event, input.resultData, commandRecord);
    const exitCode = numberFromRecord(input.resultData ?? {}, "exitCode")
      ?? numberFromRecord(commandRecord ?? {}, "exitCode");
    const status = subagentValidationStatus({
      eventStatus: input.event.status ?? null,
      commandStatus: commandRecord ? stringFromRecord(commandRecord, "status") : null,
      exitCode,
      output,
      timedOut: Boolean(booleanFromRecord(input.resultData ?? {}, "timedOut")),
      command,
    });
    const timing = recordFromUnknown(input.resultData?.workspaceToolTiming);
    return {
      command,
      status,
      exitCode,
      outputSummary: summarizeSubagentCommandOutput(output),
      startedAt: timing ? stringFromRecord(timing, "startedAt") : null,
      completedAt: timing ? stringFromRecord(timing, "completedAt") ?? input.event.timestamp : input.event.timestamp,
    };
  }

  function subagentCommandFromEvent(
    args: Record<string, unknown>,
    resultData: Record<string, unknown> | null,
  ): string | null {
    const commandRecord = subagentCommandRecord(resultData);
    return (commandRecord ? stringFromRecord(commandRecord, "command") : null)
      ?? stringFromRecord(resultData ?? {}, "command")
      ?? stringFromRecord(args, "command");
  }

  function subagentCommandRecord(resultData: Record<string, unknown> | null): Record<string, unknown> | null {
    return recordFromUnknown(resultData?.command) ?? recordFromUnknown(resultData?.process);
  }

  function subagentCommandOutput(
    eventItem: RuntimeEvent,
    resultData: Record<string, unknown> | null,
    commandRecord: Record<string, unknown> | null,
  ): string {
    return uniqueNonEmptyStrings([
      eventItem.output ?? "",
      eventItem.error ?? "",
      commandRecord ? stringFromRecord(commandRecord, "output") ?? "" : "",
      stringFromRecord(resultData ?? {}, "output") ?? "",
      stringFromRecord(resultData ?? {}, "stdout") ?? "",
      stringFromRecord(resultData ?? {}, "stderr") ?? "",
    ]).join("\n");
  }

  function shouldTrackSubagentValidationCommand(command: string, validationCommands: Set<string>): boolean {
    const normalized = normalizeCommandKey(command);
    if (validationCommands.has(normalized)) return true;
    return /\b(bun|npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|build|check)\b/i.test(command) ||
      /\b(vitest|jest|pytest|cargo\s+test|go\s+test|tsc|eslint|ruff|mypy)\b/i.test(command) ||
      /\b(test|typecheck|lint|build|check)s?\b/i.test(command);
  }

  function subagentValidationStatus(input: {
    eventStatus: RuntimeEvent["status"] | null;
    commandStatus: string | null;
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    command: string;
  }): SubagentValidationAttempt["status"] {
    const commandStatus = input.commandStatus?.toLowerCase() ?? "";
    if (input.timedOut || commandStatus === "failed" || commandStatus === "timed_out" || commandStatus === "stopped") {
      return "failed";
    }
    if (input.eventStatus === "failed") return "failed";
    if (typeof input.exitCode === "number" && input.exitCode !== 0) return "failed";
    if (subagentValidationOutputLooksFailed(input.output, input.command)) return "failed";
    if (typeof input.exitCode === "number" && input.exitCode === 0) return "passed";
    if (commandStatus === "succeeded" || commandStatus === "completed") return "passed";
    if (subagentValidationOutputLooksPassed(input.output)) return "passed";
    return "unknown";
  }

  function subagentValidationOutputLooksFailed(output: string, command: string): boolean {
    const text = output.toLowerCase();
    if (!text.trim()) return false;
    if (/\b(?:cannot find module|typeerror:|syntaxerror:|referenceerror:|assertionerror|not ok)\b/i.test(output)) {
      return true;
    }
    if (/\b(?:test|tests|suite|suites)\s+failed\b/i.test(output)) return true;
    if (/\b[1-9]\d*\s+(?:fail|failed|failing|errors?)\b/i.test(output)) return true;
    if (/\bfailed:\s*[1-9]\d*\b/i.test(output)) return true;
    return shouldTrackSubagentValidationCommand(command, new Set()) &&
      /\b(fail(?:ed|ure|ing)?|error:|errors?:)\b/i.test(output) &&
      !/\b0\s+(?:fail|failed|failing|errors?)\b/i.test(output);
  }

  function subagentValidationOutputLooksPassed(output: string): boolean {
    return /\b(all tests passed|tests? passed|0 fail|0 errors?|passed)\b/i.test(output);
  }

  function summarizeSubagentCommandOutput(output: string): string | null {
    const trimmed = output.trim();
    if (!trimmed) return null;
    return truncateForModelAside(trimmed.replace(/\n{3,}/g, "\n\n"), 2000);
  }

  function normalizeCommandKey(command: string): string {
    return command.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function uniqueValidationAttempts(attempts: SubagentValidationAttempt[]): SubagentValidationAttempt[] {
    const seen = new Set<string>();
    const result: SubagentValidationAttempt[] = [];
    for (const attempt of attempts) {
      const key = [
        normalizeCommandKey(attempt.command),
        attempt.completedAt ?? "",
        attempt.exitCode ?? "",
        attempt.status,
        attempt.outputSummary ?? "",
      ].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(attempt);
    }
    return result;
  }

  function inferSubagentProgressPhase(input: {
    basePhase: SubagentProgressPhase;
    lastInferredPhase: SubagentProgressPhase;
    hasValidation: boolean;
    hasChanges: boolean;
    hasBlocker: boolean;
  }): SubagentProgressPhase {
    if (input.basePhase === "submitted") return "submitted";
    if (input.hasBlocker) return "report";
    if (input.lastInferredPhase !== "orient") return input.lastInferredPhase;
    if (input.hasValidation) return "validate";
    if (input.hasChanges) return "edit";
    return input.basePhase ?? "orient";
  }

  function incrementCount(map: Map<string, number>, key: string): void {
    const normalized = key.trim();
    if (!normalized) return;
    map.set(normalized, (map.get(normalized) ?? 0) + 1);
  }

  function repeatedKeys(map: Map<string, number>): string[] {
    return [...map.entries()].filter(([, count]) => count > 1).map(([key]) => key);
  }

  function stringArrayFromUnknown(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  }

  type SubagentToolLoopSteeringTracker = {
    policy: SubagentExplorationSteeringPolicy;
    searches: Map<string, number>;
    reads: Map<string, number>;
    commands: Map<string, number>;
    deliveredKeys: Set<string>;
  };

  function createSubagentToolLoopSteeringTracker(
    policy: SubagentExplorationSteeringPolicy,
  ): SubagentToolLoopSteeringTracker {
    return {
      policy,
      searches: new Map(),
      reads: new Map(),
      commands: new Map(),
      deliveredKeys: new Set(),
    };
  }

  function subagentToolLoopSteeringMessagesForNativeResults(input: {
    session: Session;
    toolCalls: NativeModelToolCall[];
    results: NativeModelToolResult[];
    tracker: SubagentToolLoopSteeringTracker;
  }): string[] {
    if (!input.session.subagentRunId) return [];
    const argsByToolCallId = new Map<string, Record<string, unknown>>();
    for (const call of input.toolCalls) {
      try {
        argsByToolCallId.set(call.id, parseNativeToolArguments(call));
      } catch {
        argsByToolCallId.set(call.id, {});
      }
    }
    return input.results.flatMap((result) =>
      subagentToolLoopSteeringMessagesForAction({
        session: input.session,
        action: result.name,
        args: argsByToolCallId.get(result.toolCallId) ?? {},
        resultData: recordFromUnknown(result.data),
        tracker: input.tracker,
      }),
    );
  }

  function subagentToolLoopSteeringMessagesForWorkspaceResult(input: {
    session: Session;
    request: WorkspaceToolRequest;
    result: WorkspaceToolResult;
    tracker: SubagentToolLoopSteeringTracker;
  }): string[] {
    if (!input.session.subagentRunId) return [];
    return subagentToolLoopSteeringMessagesForAction({
      session: input.session,
      action: input.result.action,
      args: input.request.args,
      resultData: recordFromUnknown(input.result.data),
      tracker: input.tracker,
    });
  }

  function subagentToolLoopSteeringMessagesForAction(input: {
    session: Session;
    action: string;
    args: Record<string, unknown>;
    resultData: Record<string, unknown> | null;
    tracker: SubagentToolLoopSteeringTracker;
  }): string[] {
    if (!input.tracker.policy.enabled) return [];
    const repeated: Array<{ kind: "search" | "read" | "command"; key: string }> = [];
    if (SUBAGENT_SEARCH_ACTIONS.has(input.action)) {
      const key = subagentSearchKey(input.action, input.args, input.resultData);
      if (key && incrementSteeringCount(input.tracker.searches, key) >= input.tracker.policy.repeatedSearchThreshold) {
        repeated.push({ kind: "search", key });
      }
    }
    if (SUBAGENT_READ_ACTIONS.has(input.action)) {
      const readTargets = uniqueNonEmptyStrings([
        ...subagentPathsFromArgs(input.args),
        ...subagentPathsFromReadResult(input.resultData),
      ]);
      const key = subagentReadKey(input.action, input.args, readTargets);
      if (key && incrementSteeringCount(input.tracker.reads, key) >= input.tracker.policy.repeatedReadThreshold) {
        repeated.push({ kind: "read", key });
      }
    }
    if (SUBAGENT_COMMAND_ACTIONS.has(input.action)) {
      const command = subagentCommandFromEvent(input.args, input.resultData);
      const key = command ? normalizeCommandKey(command) : null;
      if (key && incrementSteeringCount(input.tracker.commands, key) >= input.tracker.policy.repeatedCommandThreshold) {
        repeated.push({ kind: "command", key });
      }
    }
    const messages: string[] = [];
    for (const item of repeated) {
      const deliveryKey = `${item.kind}:${item.key}`;
      if (input.tracker.deliveredKeys.has(deliveryKey)) continue;
      input.tracker.deliveredKeys.add(deliveryKey);
      messages.push(subagentRepeatedExplorationSteeringMessage({
        roleId: input.session.subagentRoleId ?? "child",
        kind: item.kind,
        key: item.key,
      }));
    }
    return messages;
  }

  function incrementSteeringCount(map: Map<string, number>, key: string): number {
    const count = (map.get(key) ?? 0) + 1;
    map.set(key, count);
    return count;
  }

  function subagentRepeatedExplorationSteeringMessage(input: {
    roleId: string;
    kind: "search" | "read" | "command";
    key: string;
  }): string {
    const label = input.kind === "search"
      ? "search"
      : input.kind === "read"
        ? "read"
        : "command";
    return [
      "Runtime subagent steering:",
      `${input.roleId} subagent repeated the same ${label} pattern: ${truncateForModelAside(input.key, 500)}.`,
      "If this did not produce new information, stop repeating it and move to the next useful boundary: edit the target, run validation, submit a review packet, or report the blocker/question.",
    ].join(" ");
  }

  type SubagentUsageBudgetSnapshot = {
    totalTokens: number;
    roleTokens: number;
    totalMaxTokens: number | null;
    roleMaxTokens: number | null;
  };

  type SubagentContinuationTurnContext = {
    run: SubagentRun;
    role: SubagentRoleSettings;
    usageAttribution: UsageRequestAttribution;
    turnPermissions: SubagentTurnPermissions;
    priorTurnCount: number;
    maxTurns: number | null;
    managedBySubagentRunner: boolean;
  };

  async function subagentUsageBudgetForParent(input: {
    parentSessionId: string;
    roleId: string;
    preferences: AppPreferences;
  }): Promise<SubagentUsageBudgetSnapshot> {
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({ parentSessionId: input.parentSessionId, limit: 10_000 });
    const runIds = new Set(runs.map((run) => run.id));
    const roleRunIds = new Set(runs.filter((run) => run.roleId === input.roleId).map((run) => run.id));
    const records = await deps.listUsageRecords({ status: "completed" });
    const totalTokens = subagentUsageTotal(records, runIds);
    const roleTokens = subagentUsageTotal(records, roleRunIds);
    const role = input.preferences.subagents.roles.find((candidate) => candidate.id === input.roleId) ?? null;
    return {
      totalTokens,
      roleTokens,
      totalMaxTokens: input.preferences.subagents.maxTokens,
      roleMaxTokens: role?.maxTokens ?? null,
    };
  }

  async function subagentUsageTotalsForRun(runId: string): Promise<{
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    requestCount: number;
  }> {
    const deps = requireSubagentDeps();
    const records = await deps.listUsageRecords({ status: "completed" });
    const matching = records.filter((record) => record.attribution.subagentRunId === runId);
    return {
      totalTokens: sumUsageField(matching, "totalTokens"),
      promptTokens: sumUsageField(matching, "promptTokens"),
      completionTokens: sumUsageField(matching, "completionTokens"),
      requestCount: matching.length,
    };
  }

  function assertSubagentBudgetAvailable(input: {
    budget: SubagentUsageBudgetSnapshot;
    role: SubagentRoleSettings;
  }): void {
    const { budget, role } = input;
    if (budget.totalMaxTokens !== null && budget.totalTokens >= budget.totalMaxTokens) {
      throw new Error(
        `Subagent token budget reached: ${budget.totalTokens}/${budget.totalMaxTokens} tokens used across this parent conversation.`,
      );
    }
    if (budget.roleMaxTokens !== null && budget.roleTokens >= budget.roleMaxTokens) {
      throw new Error(
        `Subagent role ${role.id} token budget reached: ${budget.roleTokens}/${budget.roleMaxTokens} tokens used.`,
      );
    }
  }

  async function prepareSubagentContinuationTurn(input: {
    session: Session;
    request: SendTurnRequest;
    requestedTurnPermissions: SubagentTurnPermissions;
  }): Promise<SubagentContinuationTurnContext | null> {
    if (!input.session.subagentRunId) return null;
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.session.subagentRunId);
    if (!run) throw new Error(`Subagent run ${input.session.subagentRunId} was not found.`);
    if (run.childSessionId && run.childSessionId !== input.session.id) {
      throw new Error(`Subagent run ${run.id} is linked to a different child conversation.`);
    }
    const preferences = await loadAppPreferences();
    const role = preferences.subagents.roles.find((candidate) => candidate.id === run.roleId);
    if (!role?.enabled) throw new Error(`Subagent role ${run.roleId} is not enabled.`);
    const budget = await subagentUsageBudgetForParent({
      parentSessionId: run.parentSessionId,
      roleId: run.roleId,
      preferences,
    });
    assertSubagentBudgetAvailable({ budget, role });
    const priorTurnCount = (await store.snapshot()).turns.filter((turn) => turn.sessionId === input.session.id).length;
    const maxTurns = subagentMaxTurnsForRun(role, run);
    if (maxTurns !== null && priorTurnCount >= maxTurns) {
      throw new Error(
        `Subagent role ${role.id} turn budget reached: ${priorTurnCount}/${maxTurns} turns used for run ${run.id}.`,
      );
    }
    const metadata = recordFromUnknown(input.request.metadata);
    const managedBySubagentRunner = stringFromRecord(metadata ?? {}, "subagentRunId") === run.id;
    return {
      run,
      role,
      usageAttribution: input.request.usageAttribution ?? subagentUsageAttribution(run),
      turnPermissions: subagentTurnPermissionsFromRun(run) ??
        subagentChildTurnPermissions(input.requestedTurnPermissions, role),
      priorTurnCount,
      maxTurns,
      managedBySubagentRunner,
    };
  }

  function subagentMaxTurnsForRun(role: SubagentRoleSettings, run: SubagentRun): number | null {
    if (role.maxTurns !== null) return role.maxTurns;
    const tokenBudget = recordFromUnknown(recordFromUnknown(run.metadata)?.tokenBudget);
    const value = tokenBudget?.roleMaxTurns;
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
  }

  function subagentTurnPermissionsFromRun(run: SubagentRun): SubagentTurnPermissions | null {
    const permissions = recordFromUnknown(recordFromUnknown(run.metadata)?.childTurnPermissions);
    if (!permissions) return null;
    const approvalPolicy = stringFromRecord(permissions, "approvalPolicy");
    const sandbox = stringFromRecord(permissions, "sandbox");
    const codexPermissionMode = stringFromRecord(permissions, "codexPermissionMode");
    const codexReasoningEffort = stringFromRecord(permissions, "codexReasoningEffort");
    if (!isApprovalPolicy(approvalPolicy) || !isSandboxMode(sandbox) || !isCodexPermissionMode(codexPermissionMode)) {
      return null;
    }
    return {
      approvalPolicy,
      sandbox,
      codexPermissionMode,
      codexReasoningEffort: isCodexReasoningEffort(codexReasoningEffort) ? codexReasoningEffort : undefined,
    };
  }

  function isApprovalPolicy(value: string | null): value is SendTurnRequest["approvalPolicy"] {
    return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
  }

  function isSandboxMode(value: string | null): value is SendTurnRequest["sandbox"] {
    return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
  }

  function isCodexPermissionMode(value: string | null): value is SendTurnRequest["codexPermissionMode"] {
    return value === "default" || value === "auto-review" || value === "full-access";
  }

  function isCodexReasoningEffort(value: string | null): value is NonNullable<SendTurnRequest["codexReasoningEffort"]> {
    return value === "low" || value === "medium" || value === "high" || value === "xhigh";
  }

  async function markSubagentContinuationRunning(input: {
    context: SubagentContinuationTurnContext | null;
    childTurnId: string;
  }): Promise<void> {
    if (!input.context || input.context.managedBySubagentRunner) return;
    const run = input.context.run;
    if (run.status === "queued" || run.status === "running") return;
    const deps = requireSubagentDeps();
    const updated = SubagentRunSchema.parse({
      ...run,
      status: "running",
      startedAt: run.startedAt ?? now(),
      completedAt: null,
      error: null,
      progress: SubagentProgressSchema.parse({
        ...(run.progress ?? {}),
        phase: "orient",
        latestMeaningfulActivity: "Child follow-up turn started.",
        currentBlocker: null,
        updatedAt: now(),
      }),
      metadata: {
        ...(run.metadata ?? {}),
        lastFollowUpTurnId: input.childTurnId,
        lastFollowUpStartedAt: now(),
        turnBudget: {
          usedBeforeTurn: input.context.priorTurnCount,
          maxTurns: input.context.maxTurns,
        },
      },
    });
    await deps.upsertRun(updated);
    input.context.run = updated;
    const parentSession = await getSession(run.parentSessionId).catch(() => null);
    if (parentSession) {
      await appendSubagentReceipt({
        parentSession,
        parentTurnId: run.parentTurnId ?? input.childTurnId,
        run: updated,
        eventName: "subagent.started",
        status: "started",
        output: `${run.roleId} subagent follow-up is running.`,
      });
    }
  }

  async function finalizeSubagentContinuationTurn(input: {
    context: SubagentContinuationTurnContext | null;
    childSession: Session;
    childTurnId: string;
  }): Promise<void> {
    const context = input.context;
    if (!context || context.managedBySubagentRunner) return;
    const turn = await getStoredTurn(input.childTurnId);
    if (!turn || turn.status === "in_progress") return;
    const deps = requireSubagentDeps();
    const latestRun = await deps.getRun(context.run.id);
    if (!latestRun) return;
    const usage = await subagentUsageTotalsForRun(latestRun.id);
    const summary = await latestAssistantTextForSession(input.childSession.id);
    const completed = turn.status === "completed";
    const interrupted = turn.status === "interrupted";
    const message = turn.error || (completed ? null : "Subagent follow-up failed.");
    const submittedAt = now();
    const derivedProgress = await subagentRuntimeDerivedProgress({
      run: latestRun,
      childSessionId: input.childSession.id,
      phase: completed ? "submitted" : interrupted ? null : "report",
      latestMeaningfulActivity: completed
        ? "Child follow-up submitted a review packet."
        : interrupted
          ? "Child follow-up was interrupted and needs resume."
        : "Child follow-up failed.",
      currentBlocker: completed ? null : message,
    });
    const followUpReport = {
      findings: latestRun.report?.findings ?? [],
      artifacts: latestRun.report?.artifacts ?? [],
      patchRef: latestRun.report?.patchRef ?? null,
      diffRef: latestRun.report?.diffRef ?? null,
      testsRun: latestRun.report?.testsRun ?? [],
      confidence: latestRun.report?.confidence ?? null,
      summary: summary || latestRun.report?.summary || (completed ? "Child conversation completed." : "Subagent follow-up did not complete."),
      blockers: completed
        ? latestRun.report?.blockers ?? []
        : uniqueNonEmptyStrings([...(latestRun.report?.blockers ?? []), message ?? "Subagent follow-up did not complete."]),
      followUpNeeded: !completed,
    };
    const followUpProgress = SubagentProgressSchema.parse({
      ...derivedProgress,
      phase: completed ? "submitted" : interrupted ? latestRun.progress.phase : "report",
      latestMeaningfulActivity: completed
        ? "Child follow-up submitted a review packet."
        : interrupted
          ? "Child follow-up was interrupted and needs resume."
          : "Child follow-up failed.",
      currentBlocker: completed ? derivedProgress.currentBlocker : message,
      updatedAt: submittedAt,
    });
    const packetQuality = completed
      ? subagentReviewPacketQuality({
          run: latestRun,
          finalSummary: summary,
          report: followUpReport,
          progress: followUpProgress,
        })
      : latestRun.review.packetQuality;
    const followUpReviewReport: NonNullable<SubagentRun["report"]> = {
      ...followUpReport,
      confidence: followUpReport.confidence ?? (packetQuality.status === "weak" ? "low" : null),
      followUpNeeded: followUpReport.followUpNeeded || packetQuality.status !== "reviewable",
    };
    const reviewRouting = completed
      ? subagentReviewRoutingRecommendation({
          run: latestRun,
          reviewRoutingPolicy: context.role.reviewRouting,
          packetQuality,
          report: followUpReviewReport,
          progress: followUpProgress,
        })
      : null;
    const packetIncomplete = completed && packetQuality.status === "incomplete";
    const packetBlocker = packetQuality.issues[0] ?? "Child review packet is incomplete.";
    const updated = SubagentRunSchema.parse({
      ...latestRun,
      status: packetIncomplete ? "blocked" : completed ? "submitted_for_review" : interrupted ? "needs_resume" : "failed",
      completedAt: packetIncomplete ? submittedAt : null,
      error: packetIncomplete ? packetBlocker : completed ? null : message,
      report: {
        ...followUpReviewReport,
        blockers: packetIncomplete
          ? uniqueNonEmptyStrings([...(followUpReviewReport.blockers ?? []), ...packetQuality.issues])
          : followUpReviewReport.blockers,
      },
      progress: SubagentProgressSchema.parse({
        ...followUpProgress,
        phase: packetIncomplete ? "report" : followUpProgress.phase,
        latestMeaningfulActivity: packetIncomplete
          ? "Child follow-up finished without a reviewable final report."
          : followUpProgress.latestMeaningfulActivity,
        currentBlocker: packetIncomplete ? packetBlocker : followUpProgress.currentBlocker,
      }),
      review: completed
        ? SubagentReviewStateSchema.parse({
            ...(latestRun.review ?? {}),
            status: packetIncomplete ? "needs_user_input" : "submitted_for_review",
            submittedAt,
            summary: summary || followUpReport.summary,
            issues: packetIncomplete
              ? uniqueNonEmptyStrings([...(latestRun.review?.issues ?? []), ...packetQuality.issues])
              : latestRun.review?.issues ?? [],
            humanReviewRecommended: packetQuality.status !== "reviewable" || Boolean(latestRun.report?.patchRef ?? latestRun.report?.diffRef),
            ...(reviewRouting ?? {}),
            packetQuality,
          })
        : latestRun.review,
      metadata: {
        ...(latestRun.metadata ?? {}),
        usage,
        lastFollowUpTurnId: input.childTurnId,
        lastFollowUpCompletedAt: submittedAt,
        turnBudget: {
          usedTurns: context.priorTurnCount + 1,
          maxTurns: context.maxTurns,
        },
      },
    });
    await deps.upsertRun(updated);
    const parentSession = await getSession(updated.parentSessionId).catch(() => null);
    if (parentSession) {
      await appendSubagentReceipt({
        parentSession,
        parentTurnId: updated.parentTurnId ?? input.childTurnId,
        run: updated,
        eventName: packetIncomplete ? "subagent.blocked" : completed ? "subagent.submitted" : "subagent.failed",
        status: completed && !packetIncomplete ? "pending" : "failed",
        output: packetIncomplete
          ? `${updated.roleId} subagent follow-up submitted an incomplete review packet: ${packetBlocker}`
          : completed
            ? `${updated.roleId} subagent follow-up submitted for review.`
          : `${updated.roleId} subagent follow-up failed: ${message}`,
      });
    }
  }

  function subagentUsageAttribution(run: SubagentRun): UsageRequestAttribution {
    return {
      surface: run.parentGoalId ? "goal" : "chat",
      workflowKind: "subagent",
      goalId: run.parentGoalId,
      subagentRunId: run.id,
      subagentRoleId: run.roleId,
    };
  }

  function subagentUsageTotal(records: ModelUsageRecord[], runIds: ReadonlySet<string>): number {
    if (runIds.size === 0) return 0;
    return sumUsageField(
      records.filter((record) => {
        const runId = record.attribution.subagentRunId;
        return Boolean(runId && runIds.has(runId));
      }),
      "totalTokens",
    );
  }

  function sumUsageField(
    records: ModelUsageRecord[],
    field: "totalTokens" | "promptTokens" | "completionTokens",
  ): number {
    return records.reduce((total, record) => {
      const value = record[field];
      return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0);
  }

  function turnPermissionsFromSendTurnInput(input: SendTurnRequest): SubagentTurnPermissions {
    return {
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
      codexPermissionMode: input.codexPermissionMode,
      codexReasoningEffort: input.codexReasoningEffort,
    };
  }

  function subagentChildTurnPermissions(
    parent: SubagentTurnPermissions,
    role: SubagentRoleSettings,
  ): SubagentTurnPermissions {
    return {
      ...parent,
      sandbox: clampSandboxToRole(parent.sandbox, role.toolPolicy),
    };
  }

  function clampSandboxToRole(
    parentSandbox: SendTurnRequest["sandbox"],
    toolPolicy: SubagentRoleSettings["toolPolicy"],
  ): SendTurnRequest["sandbox"] {
    const roleSandbox = toolPolicy === "read_only"
      ? "read-only"
      : toolPolicy === "workspace_write"
        ? "workspace-write"
        : "danger-full-access";
    return sandboxRank(parentSandbox) <= sandboxRank(roleSandbox) ? parentSandbox : roleSandbox;
  }

  function sandboxRank(sandbox: SendTurnRequest["sandbox"]): number {
    if (sandbox === "read-only") return 0;
    if (sandbox === "workspace-write") return 1;
    return 2;
  }

  function subagentIsolationBlocker(role: SubagentRoleSettings): string | null {
    if (role.toolPolicy === "read_only") return null;
    if (role.isolationMode === "none") {
      return "write-capable subagents require an isolated workspace target.";
    }
    return `${role.isolationMode} isolation is not available for this workspace target.`;
  }

  async function subagentWorkspaceTargetKeyForSession(session: Session): Promise<string> {
    const target = resolveWorkspaceExecutionTarget({ session });
    if (target.target === "sandbox") {
      const sandboxId = session.cloudProjectId ?? session.workspaceId ?? session.cloudTeamId ?? session.id;
      return `sandbox:${sandboxId}`;
    }
    const cwd =
      session.cwd ??
      (await resolveSessionWorkspaceCwd(session, { ensureOpenPond: false }).catch(() => null)) ??
      null;
    if (!cwd) return `session:${session.id}`;
    const rootResult = await runWorkspaceCommand("git", ["rev-parse", "--show-toplevel"], cwd).catch(() => null);
    const repoRoot = rootResult?.code === 0 ? rootResult.stdout.trim() : "";
    return `local:${repoRoot || cwd}`;
  }

  function subagentWorkspaceTargetKeyFromRun(run: SubagentRun): string | null {
    const metadata = recordFromUnknown(run.metadata);
    const concurrency = recordFromUnknown(metadata?.concurrency);
    const storedKey = concurrency ? stringFromRecord(concurrency, "workspaceTargetKey") : null;
    if (storedKey) return storedKey;
    const workspace = subagentWorkspaceFromRun(run);
    if (!workspace) return null;
    const target = stringFromRecord(workspace, "target");
    if (target === "local") {
      const parentRepoPath = stringFromRecord(workspace, "parentRepoPath");
      const workspaceRoot = stringFromRecord(workspace, "workspaceRoot");
      const repoPath = stringFromRecord(workspace, "repoPath");
      return `local:${parentRepoPath ?? workspaceRoot ?? repoPath ?? "unknown"}`;
    }
    if (target === "sandbox") {
      return `sandbox:${stringFromRecord(workspace, "sandboxId") ?? stringFromRecord(workspace, "workspaceId") ?? "unknown"}`;
    }
    return target ? `${target}:unknown` : null;
  }

  type PreparedSubagentWorkspaceIsolation = {
    cwd: string | null;
    effectiveIsolationMode: SubagentRoleSettings["isolationMode"];
    blocker: string | null;
    workspace: Record<string, unknown> | null;
    sessionWorkspace?: Partial<Pick<
      Session,
      | "workspaceKind"
      | "workspaceId"
      | "workspaceName"
      | "localProjectId"
      | "cloudProjectId"
      | "cloudTeamId"
      | "metadata"
    >> | null;
  };

  type LocalSubagentGitWorktree = Record<string, unknown> & {
    repoPath: string;
  };

  type LocalSubagentDependencyLink = {
    path: string;
    sourcePath: string;
    targetPath: string;
    status: "linked" | "missing" | "not_ignored" | "target_exists" | "failed";
    error?: string;
  };

  async function prepareSubagentWorkspaceIsolation(input: {
    parentSession: Session;
    role: SubagentRoleSettings;
    runId: string;
  }): Promise<PreparedSubagentWorkspaceIsolation> {
    if (input.role.toolPolicy === "read_only") {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: "none",
        blocker: null,
        workspace: null,
      };
    }
    const staticBlocker = subagentIsolationBlocker(input.role);
    if (staticBlocker && input.role.isolationMode === "none") {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: "none",
        blocker: staticBlocker,
        workspace: null,
      };
    }

    const target = resolveWorkspaceExecutionTarget({ session: input.parentSession });
    if (target.target === "sandbox") {
      return prepareSandboxSubagentWorkspaceIsolation({
        parentSession: input.parentSession,
        role: input.role,
        runId: input.runId,
        target,
      });
    }

    const parentCwd =
      input.parentSession.cwd ??
      (await resolveSessionWorkspaceCwd(input.parentSession, { ensureOpenPond: false })) ??
      null;
    if (!parentCwd) {
      return {
        cwd: null,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation requires a local git workspace, but this chat has no local workspace cwd.`,
        workspace: null,
      };
    }

    try {
      const workspace = await createLocalSubagentGitWorktree({
        parentCwd,
        role: input.role,
        runId: input.runId,
      });
      return {
        cwd: workspace.repoPath,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: null,
        workspace,
      };
    } catch (error) {
      return {
        cwd: parentCwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation unavailable: ${textFromUnknown(error) || "Unable to create isolated worktree."}`,
        workspace: null,
      };
    }
  }

  async function prepareSandboxSubagentWorkspaceIsolation(input: {
    parentSession: Session;
    role: SubagentRoleSettings;
    runId: string;
    target: Extract<ReturnType<typeof resolveWorkspaceExecutionTarget>, { target: "sandbox" }>;
  }): Promise<PreparedSubagentWorkspaceIsolation> {
    const parentSandboxId = input.target.sandboxId ?? input.target.workspaceId;
    if (!parentSandboxId) {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation requires a sandbox id, but this chat has no sandbox workspace id.`,
        workspace: {
          mode: input.role.isolationMode,
          target: "sandbox",
          unavailableReason: "missing_parent_sandbox_id",
        },
      };
    }
    if (!forkSandboxForSubagent) {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: [
          `${input.role.isolationMode} isolation requires sandbox fork support, but no sandbox fork executor is configured.`,
          "The child stayed on the sandbox target and did not fall back to local files.",
        ].join(" "),
        workspace: {
          mode: input.role.isolationMode,
          target: "sandbox",
          parentSandboxId,
          unavailableReason: "sandbox_fork_executor_unavailable",
        },
      };
    }

    const forkedAt = now();
    const forkPayload = {
      visibility: "private",
      metadata: {
        openpondPurpose: "subagent_copy_on_write",
        subagentRunId: input.runId,
        subagentRoleId: input.role.id,
        parentSessionId: input.parentSession.id,
        parentWorkspaceId: input.target.workspaceId,
        parentSandboxId,
        isolationMode: input.role.isolationMode,
        forkedAt,
      },
    };
    let forkResult: unknown;
    try {
      forkResult = await forkSandboxForSubagent({
        sandboxId: parentSandboxId,
        payload: forkPayload,
        parentSession: input.parentSession,
        role: input.role,
        runId: input.runId,
      });
    } catch (error) {
      const message = textFromUnknown(error) || "Sandbox fork failed.";
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation unavailable: ${message}`,
        workspace: {
          mode: input.role.isolationMode,
          target: "sandbox",
          parentSandboxId,
          unavailableReason: "sandbox_fork_failed",
          error: message,
        },
      };
    }

    const sandbox = sandboxRecordFromForkPayload(forkResult);
    const sandboxId = sandboxIdFromForkPayload(forkResult);
    if (!sandboxId) {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation unavailable: sandbox fork response did not include a sandbox id.`,
        workspace: {
          mode: input.role.isolationMode,
          target: "sandbox",
          parentSandboxId,
          unavailableReason: "sandbox_fork_missing_id",
        },
      };
    }

    const workspaceName =
      (sandbox ? stringFromRecord(sandbox, "name") ?? stringFromRecord(sandbox, "title") : null) ??
      (input.parentSession.workspaceName ? `${input.parentSession.workspaceName} fork` : "Subagent sandbox fork");
    const workspace = {
      mode: input.role.isolationMode,
      implementation: "sandbox_fork",
      target: "sandbox",
      sandboxId,
      workspaceId: sandboxId,
      workspaceKind: input.target.workspaceKind,
      workspaceName,
      parentSandboxId,
      parentWorkspaceId: input.target.workspaceId,
      sourceSandboxId: sourceSandboxIdFromForkPayload(forkResult) ?? parentSandboxId,
      cloudProjectId: input.target.cloudProjectId,
      cloudTeamId: input.target.cloudTeamId,
      localProjectId: input.target.localProjectId,
      forkedAt,
      cleanup: "manual_after_handoff",
    };
    const sessionWorkspace: NonNullable<PreparedSubagentWorkspaceIsolation["sessionWorkspace"]> = {
      workspaceKind: input.target.workspaceKind as Session["workspaceKind"],
      workspaceId: sandboxId,
      workspaceName,
      localProjectId: input.target.localProjectId,
      cloudProjectId: input.target.cloudProjectId,
      cloudTeamId: input.target.cloudTeamId,
      ...(input.target.hybrid ? { metadata: { workspaceTarget: "hybrid" } } : {}),
    };
    return {
      cwd: input.parentSession.cwd,
      effectiveIsolationMode: input.role.isolationMode,
      blocker: null,
      workspace,
      sessionWorkspace,
    };
  }

  function sandboxRecordFromForkPayload(payload: unknown): Record<string, unknown> | null {
    const root = recordFromUnknown(payload);
    const data = recordFromUnknown(root?.data);
    return recordFromUnknown(root?.sandbox) ?? recordFromUnknown(data?.sandbox);
  }

  function sandboxIdFromForkPayload(payload: unknown): string | null {
    const root = recordFromUnknown(payload);
    const sandbox = sandboxRecordFromForkPayload(payload);
    return (
      (sandbox ? stringFromRecord(sandbox, "id") ?? stringFromRecord(sandbox, "sandboxId") : null) ??
      (root ? stringFromRecord(root, "sandboxId") ?? stringFromRecord(root, "id") : null)
    );
  }

  function sourceSandboxIdFromForkPayload(payload: unknown): string | null {
    const root = recordFromUnknown(payload);
    const data = recordFromUnknown(root?.data);
    const sourceSandbox = recordFromUnknown(root?.sourceSandbox) ?? recordFromUnknown(data?.sourceSandbox);
    return sourceSandbox ? stringFromRecord(sourceSandbox, "id") ?? stringFromRecord(sourceSandbox, "sandboxId") : null;
  }

  async function createLocalSubagentGitWorktree(input: {
    parentCwd: string;
    role: SubagentRoleSettings;
    runId: string;
  }): Promise<LocalSubagentGitWorktree> {
    const repoRootResult = await runWorkspaceCommand("git", ["rev-parse", "--show-toplevel"], input.parentCwd);
    const parentRepoPath = repoRootResult.stdout.trim();
    if (repoRootResult.code !== 0 || !parentRepoPath) {
      throw new Error(repoRootResult.stderr.trim() || repoRootResult.stdout.trim() || "Parent workspace is not a git repository.");
    }
    const headResult = await runWorkspaceCommand("git", ["rev-parse", "--verify", "HEAD"], parentRepoPath);
    const baseCommit = headResult.stdout.trim();
    if (headResult.code !== 0 || !baseCommit) {
      throw new Error(headResult.stderr.trim() || headResult.stdout.trim() || "Parent git repository has no HEAD commit.");
    }
    const statusResult = await runWorkspaceCommand("git", ["status", "--porcelain=v1"], parentRepoPath);
    if (statusResult.code !== 0) {
      throw new Error(statusResult.stderr.trim() || statusResult.stdout.trim() || "Unable to inspect parent git status.");
    }

    const safeRunId = safeSubagentPathSegment(input.runId);
    const safeRoleId = safeSubagentPathSegment(input.role.id);
    const workspaceRoot = path.join(
      os.tmpdir(),
      "openpond-subagents",
      safeSubagentPathSegment(path.basename(parentRepoPath) || "repo"),
      `${safeRoleId}-${safeRunId}`,
    );
    const worktreePath = path.join(workspaceRoot, "repo");
    const branch = `openpond/subagent/${safeRoleId}/${safeRunId.slice(0, 24)}`;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
    const addResult = await runWorkspaceCommand(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, baseCommit],
      parentRepoPath,
    );
    if (addResult.code !== 0) {
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(addResult.stderr.trim() || addResult.stdout.trim() || "git worktree add failed");
    }
    const dependencyLinks = await linkLocalSubagentDependencyArtifacts({
      parentRepoPath,
      worktreePath,
    });

    return {
      mode: input.role.isolationMode,
      implementation: "git_worktree",
      target: "local",
      repoPath: worktreePath,
      worktreePath,
      workspaceRoot,
      parentRepoPath,
      branch,
      baseCommit,
      parentDirty: Boolean(statusResult.stdout.trim()),
      dependencyLinks,
      createdAt: now(),
      cleanup: "manual_after_handoff",
    };
  }

  async function linkLocalSubagentDependencyArtifacts(input: {
    parentRepoPath: string;
    worktreePath: string;
  }): Promise<LocalSubagentDependencyLink[]> {
    const links: LocalSubagentDependencyLink[] = [];
    const candidates = await localSubagentDependencyArtifactCandidates(input.parentRepoPath);
    for (const relativePath of candidates) {
      const sourcePath = path.join(input.parentRepoPath, ...relativePath.split("/"));
      const targetPath = path.join(input.worktreePath, ...relativePath.split("/"));
      const sourceStat = await safeLstat(sourcePath);
      if (!sourceStat) {
        links.push({ path: relativePath, sourcePath, targetPath, status: "missing" });
        continue;
      }
      if (!sourceStat.isDirectory()) {
        links.push({ path: relativePath, sourcePath, targetPath, status: "failed", error: "dependency artifact is not a directory" });
        continue;
      }
      if (!(await gitPathIgnored(input.parentRepoPath, relativePath))) {
        links.push({ path: relativePath, sourcePath, targetPath, status: "not_ignored" });
        continue;
      }
      if (await safeLstat(targetPath)) {
        links.push({ path: relativePath, sourcePath, targetPath, status: "target_exists" });
        continue;
      }
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.symlink(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
        links.push({ path: relativePath, sourcePath, targetPath, status: "linked" });
      } catch (error) {
        links.push({
          path: relativePath,
          sourcePath,
          targetPath,
          status: "failed",
          error: textFromUnknown(error) || "Unable to link dependency artifact.",
        });
      }
    }
    return links;
  }

  async function localSubagentDependencyArtifactCandidates(parentRepoPath: string): Promise<string[]> {
    const candidates = new Set<string>(["node_modules"]);
    for (const workspaceDir of await localWorkspacePackageDirs(parentRepoPath)) {
      const relativePath = path.posix.join(workspaceDir, "node_modules");
      const sourcePath = path.join(parentRepoPath, ...relativePath.split("/"));
      if (await safeLstat(sourcePath)) candidates.add(relativePath);
    }
    return [...candidates];
  }

  async function localWorkspacePackageDirs(parentRepoPath: string): Promise<string[]> {
    const packageJson = await readJsonFile(path.join(parentRepoPath, "package.json"));
    const workspaces = workspacePatternsFromPackageJson(packageJson);
    const dirs: string[] = [];
    for (const pattern of workspaces) {
      for (const dir of await expandSimpleWorkspacePattern(parentRepoPath, pattern)) {
        dirs.push(dir);
      }
    }
    return [...new Set(dirs)].slice(0, 80);
  }

  function workspacePatternsFromPackageJson(value: unknown): string[] {
    const record = recordFromUnknown(value);
    const workspaces = record?.workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
    const workspaceRecord = recordFromUnknown(workspaces);
    const packages = workspaceRecord?.packages;
    return Array.isArray(packages)
      ? packages.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  }

  async function expandSimpleWorkspacePattern(parentRepoPath: string, pattern: string): Promise<string[]> {
    const normalized = pattern.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
    if (!normalized || normalized.startsWith("!") || normalized.startsWith("/") || normalized.includes("..")) return [];
    const segments = normalized.split("/").filter(Boolean);
    let relDirs = [""];
    for (const segment of segments) {
      if (segment === "*") {
        const expanded: string[] = [];
        for (const relDir of relDirs) {
          const absoluteDir = path.join(parentRepoPath, ...relDir.split("/").filter(Boolean));
          const entries = await safeReaddir(absoluteDir);
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
            expanded.push(path.posix.join(relDir, entry.name));
          }
        }
        relDirs = expanded;
        continue;
      }
      if (segment.includes("*")) return [];
      relDirs = relDirs.map((relDir) => path.posix.join(relDir, segment));
    }
    const existing: string[] = [];
    for (const relDir of relDirs) {
      const stat = await safeLstat(path.join(parentRepoPath, ...relDir.split("/").filter(Boolean)));
      if (stat?.isDirectory()) existing.push(relDir);
    }
    return existing;
  }

  async function gitPathIgnored(repoPath: string, relativePath: string): Promise<boolean> {
    const result = await runWorkspaceCommand("git", ["check-ignore", "-q", "--", relativePath], repoPath);
    return result.code === 0;
  }

  async function readJsonFile(filePath: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  async function safeLstat(filePath: string): Promise<import("node:fs").Stats | null> {
    try {
      return await fs.lstat(filePath);
    } catch {
      return null;
    }
  }

  async function safeReaddir(dirPath: string): Promise<import("node:fs").Dirent[]> {
    try {
      return await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  function safeSubagentPathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "subagent";
  }

  function changedFilesFromGitPorcelain(statusText: string): string[] {
    return uniqueNonEmptyStrings(statusText
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line && !line.startsWith("##"))
      .map((line) => {
        const entry = line.slice(3).trim();
        const renamedPath = entry.includes(" -> ") ? entry.split(" -> ").at(-1) : entry;
        return renamedPath?.replace(/^"|"$/g, "") ?? "";
      }));
  }

  async function captureSubagentWorkspaceHandoff(run: SubagentRun): Promise<{
    changed: boolean;
    changedFiles: string[];
    artifacts: NonNullable<SubagentRun["report"]>["artifacts"];
    patchRef: NonNullable<SubagentRun["report"]>["patchRef"];
    diffRef: NonNullable<SubagentRun["report"]>["diffRef"];
    metadata: Record<string, unknown>;
  } | null> {
    const workspace = subagentWorkspaceFromRun(run);
    if (!workspace) return null;
    if (workspace.implementation === "sandbox_fork") {
      return captureSubagentSandboxForkHandoff(run, workspace);
    }
    if (workspace.implementation !== "git_worktree") return null;
    const repoPath = typeof workspace.repoPath === "string" ? workspace.repoPath : null;
    const parentRepoPath = typeof workspace.parentRepoPath === "string" ? workspace.parentRepoPath : null;
    const workspaceRoot = typeof workspace.workspaceRoot === "string" ? workspace.workspaceRoot : null;
    if (!repoPath || !workspaceRoot) return null;

    await runWorkspaceCommand("git", ["add", "-N", "."], repoPath).catch(() => null);
    const diffResult = await runWorkspaceCommand("git", ["diff", "--binary", "HEAD"], repoPath);
    if (diffResult.code !== 0) {
      return {
        changed: false,
        changedFiles: [],
        artifacts: [],
        patchRef: null,
        diffRef: null,
        metadata: {
          status: "failed",
          reason: diffResult.stderr.trim() || diffResult.stdout.trim() || "git diff failed",
          repoPath,
          parentRepoPath,
        },
      };
    }
    const statusResult = await runWorkspaceCommand("git", ["status", "--porcelain=v1", "-b"], repoPath);
    const changedFiles = statusResult.code === 0 ? changedFilesFromGitPorcelain(statusResult.stdout) : [];
    const patch = diffResult.stdout;
    const changed = Boolean(patch.trim());
    const patchArtifact = changed ? await durableSubagentPatchArtifact(run) : null;
    const patchPath = patchArtifact?.patchPath ?? path.join(workspaceRoot, "handoff.patch");
    if (changed) await fs.writeFile(patchPath, patch, "utf8");
    const patchPreview = truncatePatch(patch);
    const patchRef = changed
      ? { kind: "file" as const, id: patchPath, label: "Isolated child patch" }
      : null;
    const diffRef = changed
      ? { kind: "diff" as const, id: `subagent-run:${run.id}:diff`, label: "Isolated child diff" }
      : null;
    return {
      changed,
      changedFiles,
      artifacts: patchRef ? [patchRef] : [],
      patchRef,
      diffRef,
      metadata: {
        status: "captured",
        changed,
        repoPath,
        parentRepoPath,
        workspaceRoot,
        patchRootPath: patchArtifact?.rootPath ?? workspaceRoot,
        branch: workspace.branch ?? null,
        baseCommit: workspace.baseCommit ?? null,
        changedFiles,
        patchPath: changed ? patchPath : null,
        patchBytes: Buffer.byteLength(patch, "utf8"),
        patchPreview,
        patchTruncated: patchPreview !== patch,
        statusText: statusResult.code === 0 ? statusResult.stdout : null,
        apply: changed
          ? {
              command: "git",
              args: parentRepoPath ? ["-C", parentRepoPath, "apply", patchPath] : ["apply", patchPath],
              requiresUserReview: true,
            }
          : null,
      },
    };
  }

  async function durableSubagentPatchArtifact(run: SubagentRun): Promise<{
    rootPath: string;
    patchPath: string;
  }> {
    const rootPath = path.join(
      attachmentRootDir,
      "subagents",
      safeSubagentPathSegment(run.parentSessionId),
      safeSubagentPathSegment(run.id),
    );
    await fs.mkdir(rootPath, { recursive: true });
    return {
      rootPath,
      patchPath: path.join(rootPath, "handoff.patch"),
    };
  }

  function captureSubagentSandboxForkHandoff(
    run: SubagentRun,
    workspace: Record<string, unknown>,
  ): {
    changed: boolean;
    changedFiles: string[];
    artifacts: NonNullable<SubagentRun["report"]>["artifacts"];
    patchRef: NonNullable<SubagentRun["report"]>["patchRef"];
    diffRef: NonNullable<SubagentRun["report"]>["diffRef"];
    metadata: Record<string, unknown>;
  } | null {
    const sandboxId = stringFromRecord(workspace, "sandboxId") ?? stringFromRecord(workspace, "workspaceId");
    if (!sandboxId) return null;
    const label = stringFromRecord(workspace, "workspaceName") ?? `${run.roleId} sandbox fork`;
    const sandboxRef = {
      kind: "artifact" as const,
      id: `sandbox:${sandboxId}`,
      label: `Isolated sandbox: ${label}`,
    };
    return {
      changed: true,
      changedFiles: [],
      artifacts: [sandboxRef],
      patchRef: null,
      diffRef: null,
      metadata: {
        status: "captured",
        changed: true,
        changedFiles: [],
        implementation: "sandbox_fork",
        target: "sandbox",
        sandboxId,
        parentSandboxId: stringFromRecord(workspace, "parentSandboxId"),
        sourceSandboxId: stringFromRecord(workspace, "sourceSandboxId"),
        workspaceKind: stringFromRecord(workspace, "workspaceKind"),
        workspaceName: label,
        forkedAt: stringFromRecord(workspace, "forkedAt"),
        artifactRef: sandboxRef,
        merge: {
          strategy: "sandbox_review",
          requiresUserReview: true,
        },
      },
    };
  }

  function subagentWorkspaceFromRun(run: SubagentRun): Record<string, unknown> | null {
    const metadata = recordFromUnknown(run.metadata);
    return recordFromUnknown(metadata?.subagentWorkspace) ?? recordFromUnknown(metadata?.workspace);
  }

  async function cleanupSubagentWorkspace(run: SubagentRun): Promise<Record<string, unknown> | null> {
    const workspace = subagentWorkspaceFromRun(run);
    if (!workspace) return null;
    if (workspace.implementation === "sandbox_fork") return cleanupSubagentSandboxFork(run, workspace);
    if (workspace.implementation !== "git_worktree") return null;
    const workspaceRoot = stringFromRecord(workspace, "workspaceRoot");
    const worktreePath = stringFromRecord(workspace, "worktreePath") ?? stringFromRecord(workspace, "repoPath");
    const parentRepoPath = stringFromRecord(workspace, "parentRepoPath");
    const removedAt = now();
    const result: Record<string, unknown> = {
      status: "removed",
      removedAt,
      workspaceRoot,
      worktreePath,
      parentRepoPath,
    };
    if (parentRepoPath && worktreePath) {
      const removeResult = await runWorkspaceCommand(
        "git",
        ["worktree", "remove", "--force", worktreePath],
        parentRepoPath,
      ).catch((error) => ({
        code: 1,
        stdout: "",
        stderr: textFromUnknown(error) || "git worktree remove failed",
      }));
      result.gitWorktreeRemove = {
        code: removeResult.code,
        stdout: removeResult.stdout.trim() || null,
        stderr: removeResult.stderr.trim() || null,
      };
    }
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch((error) => {
        result.status = "failed";
        result.rmError = textFromUnknown(error) || "Failed to remove isolated workspace root.";
      });
    } else {
      result.status = "skipped";
      result.reason = "workspaceRoot missing";
    }
    return result;
  }

  async function cleanupSubagentSandboxFork(
    run: SubagentRun,
    workspace: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sandboxId = stringFromRecord(workspace, "sandboxId") ?? stringFromRecord(workspace, "workspaceId");
    const deletedAt = now();
    const result: Record<string, unknown> = {
      status: "deleted",
      deletedAt,
      implementation: "sandbox_fork",
      target: "sandbox",
      sandboxId,
      parentSandboxId: stringFromRecord(workspace, "parentSandboxId"),
      sourceSandboxId: stringFromRecord(workspace, "sourceSandboxId"),
      workspaceName: stringFromRecord(workspace, "workspaceName"),
    };
    if (!sandboxId) {
      return {
        ...result,
        status: "skipped",
        reason: "sandboxId missing",
      };
    }
    if (!cleanupSandboxForSubagent) {
      return {
        ...result,
        status: "skipped",
        reason: "sandbox cleanup executor unavailable",
      };
    }
    try {
      const payload = await cleanupSandboxForSubagent({ sandboxId, run });
      return {
        ...result,
        payload: sandboxCleanupPayloadSummary(payload),
      };
    } catch (error) {
      return {
        ...result,
        status: "failed",
        failedAt: now(),
        error: textFromUnknown(error) || "Sandbox fork cleanup failed.",
      };
    }
  }

  function sandboxCleanupPayloadSummary(payload: unknown): Record<string, unknown> | null {
    const record = recordFromUnknown(payload);
    if (!record) return null;
    const sandbox = recordFromUnknown(record.sandbox);
    if (!sandbox) return null;
    return {
      sandboxId: stringFromRecord(sandbox, "id") ?? stringFromRecord(sandbox, "sandboxId"),
      state: stringFromRecord(sandbox, "state"),
      name: stringFromRecord(sandbox, "name") ?? stringFromRecord(sandbox, "title"),
    };
  }

  async function cleanupSubagentRun(input: {
    run: SubagentRun;
    parentSession: Session;
    parentTurnId?: string | null;
    reason: string;
    policy: SubagentCleanupPolicy;
  }): Promise<{ run: SubagentRun; workspaceCleanup: Record<string, unknown> }> {
    const deps = requireSubagentDeps();
    const existingCleanup = recordFromUnknown(input.run.metadata?.lifecycleCleanup);
    const existingWorkspaceCleanup = recordFromUnknown(existingCleanup?.workspaceCleanup);
    if (existingWorkspaceCleanup && subagentWorkspaceCleanupAlreadyDone(existingWorkspaceCleanup)) {
      return { run: input.run, workspaceCleanup: existingWorkspaceCleanup };
    }

    const requestedAt = now();
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run: input.run,
      eventName: "subagent.cleanup",
      status: "started",
      output: `${input.run.roleId} subagent cleanup started.`,
    });

    let workspaceCleanup: Record<string, unknown>;
    const retainReason = subagentCleanupRetainReason(input.run, input.policy);
    if (retainReason) {
      workspaceCleanup = subagentRetainedWorkspaceState({
        retainedAt: now(),
        reason: retainReason,
        trigger: subagentWorkspaceRetentionTriggerForCleanupPolicy(input.policy),
      });
    } else {
      workspaceCleanup = (await cleanupSubagentWorkspace(input.run)) ?? {
        status: "skipped",
        reason: "No cleanable isolated workspace.",
        skippedAt: now(),
      };
    }

    const completedAt = now();
    const nextRun = SubagentRunSchema.parse({
      ...input.run,
      metadata: {
        ...(input.run.metadata ?? {}),
        lifecycleCleanup: {
          reason: input.reason,
          policy: input.policy,
          requestedAt,
          completedAt,
          evidenceRetention: input.run.evidenceRetention,
          ...(existingWorkspaceCleanup ? { previousWorkspaceCleanup: existingWorkspaceCleanup } : {}),
          workspaceCleanup,
        },
      },
    });
    await deps.upsertRun(nextRun);
    const status = stringFromRecord(workspaceCleanup, "status");
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run: nextRun,
      eventName: "subagent.cleanup",
      status: status === "failed" ? "failed" : "completed",
      output: subagentCleanupOutput(nextRun, workspaceCleanup),
    });
    if (status === "retained") {
      await appendSubagentReceipt({
        parentSession: input.parentSession,
        parentTurnId: input.parentTurnId,
        run: nextRun,
        eventName: "subagent.workspace_retained",
        status: "completed",
        output: `${nextRun.roleId} subagent workspace retained for inspection.`,
      });
    }
    return { run: nextRun, workspaceCleanup };
  }

  function subagentCleanupRetainReason(
    run: SubagentRun,
    policy: SubagentCleanupPolicy,
  ): string | null {
    if (policy === "cancel_requested" || policy === "retention_expired") return null;
    const handoff = workspaceHandoffFromRun(run);
    const changed = handoff ? truthyRecordBoolean(handoff, "changed") : false;
    const applyResult = recordFromUnknown(handoff?.applyResult);
    const applied = applyResult ? stringFromRecord(applyResult, "status") === "applied" : false;
    if (changed && !applied) return "Changed child workspace has not been applied; retain for inspection.";
    if (run.status === "failed" || run.status === "failed_with_artifacts") {
      return "Failed child workspace retained for inspection.";
    }
    return null;
  }

  function subagentRetainedWorkspaceState(input: {
    retainedAt: string;
    reason: string;
    trigger: SubagentWorkspaceRetentionTrigger;
  }): Record<string, unknown> {
    return {
      status: "retained",
      reason: input.reason,
      retainedAt: input.retainedAt,
      retentionPolicy: {
        kind: "retain_for_inspection",
        retentionDays: SUBAGENT_RETAINED_WORKSPACE_RETENTION_DAYS,
        expiresAt: addMillisecondsToIso(input.retainedAt, SUBAGENT_RETAINED_WORKSPACE_RETENTION_MS),
        cleanupAfterExpiry: true,
        trigger: input.trigger,
      },
    };
  }

  function subagentWorkspaceRetentionTriggerForCleanupPolicy(
    policy: SubagentCleanupPolicy,
  ): SubagentWorkspaceRetentionTrigger {
    if (policy === "retention_expired") return "manual_cleanup";
    return policy;
  }

  function addMillisecondsToIso(iso: string, ms: number): string {
    const parsed = Date.parse(iso);
    const base = Number.isFinite(parsed) ? parsed : Date.now();
    return new Date(base + ms).toISOString();
  }

  function subagentCleanupOutput(run: SubagentRun, workspaceCleanup: Record<string, unknown>): string {
    const status = stringFromRecord(workspaceCleanup, "status") ?? "unknown";
    if (status === "removed") return `${run.roleId} subagent isolated workspace cleaned up.`;
    if (status === "deleted") return `${run.roleId} subagent isolated sandbox fork deleted.`;
    if (status === "retained") return `${run.roleId} subagent workspace retained for inspection.`;
    if (status === "failed") return `${run.roleId} subagent cleanup failed.`;
    return `${run.roleId} subagent cleanup ${status}.`;
  }

  function subagentWorkspaceCleanupAlreadyDone(workspaceCleanup: Record<string, unknown>): boolean {
    const status = stringFromRecord(workspaceCleanup, "status");
    return status === "removed" || status === "deleted";
  }

  function workspaceHandoffFromRun(run: SubagentRun): Record<string, unknown> | null {
    const metadata = recordFromUnknown(run.metadata);
    return recordFromUnknown(metadata?.workspaceHandoff);
  }

  function truthyRecordBoolean(record: Record<string, unknown>, key: string): boolean {
    return record[key] === true;
  }

  function truncateApprovalTitle(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= 88) return normalized;
    return `${normalized.slice(0, 85)}...`;
  }

  function assertPathInside(input: {
    rootPath: string;
    targetPath: string;
    label: string;
  }): void {
    const rootPath = path.resolve(input.rootPath);
    const targetPath = path.resolve(input.targetPath);
    const relative = path.relative(rootPath, targetPath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
    throw new Error(`${input.label} path must stay inside the isolated subagent workspace.`);
  }

  function assertSubagentRunAccessible(session: Session, run: SubagentRun): void {
    if (
      run.parentSessionId === session.id ||
      run.childSessionId === session.id ||
      (session.parentSessionId && session.parentSessionId === run.parentSessionId)
    ) {
      return;
    }
    throw new Error(`Subagent run ${run.id} is not linked to the current conversation.`);
  }

  function subagentChildSystemContext(input: {
    role: SubagentRoleSettings;
    objective: string;
    parentSession: Session;
    contextPack: string | null;
    workerBrief: SubagentWorkerBrief;
  }): string {
    return [
      `You are an OpenPond ${input.role.id} subagent running in an addressable child conversation.`,
      "Work only on the assignment below. Do not start additional subagents.",
      "The user may open this child conversation and talk to you directly.",
      `Tool policy: ${input.role.toolPolicy}. Isolation: ${input.role.isolationMode}.`,
      `Parent chat: ${input.parentSession.title} (${input.parentSession.id}).`,
      "Use openpond_subagent_send_message to message the parent when you have a blocker, decision request, important finding, or final handoff that should return control to the main agent. Omit target fields or use toRole: parent for parent handoffs.",
      "Use parent or sibling messages sparingly and deliberately; routine progress can stay in your child report unless it changes what the main agent should do now.",
      "",
      "Assignment:",
      input.objective,
      input.contextPack ? ["", "Context:", input.contextPack].join("\n") : "",
      "",
      formatSubagentWorkerBrief(input.workerBrief),
      "",
      "When you decide the assignment is done, stop working and submit a concise review packet.",
      "Your submission is not final acceptance; the parent or a reviewer will decide whether it is accepted, needs revision, or needs user input.",
      "The review packet must include summary, findings, files or artifacts changed/read, tests or checks run, blockers, confidence, and follow-up needed.",
    ].filter(Boolean).join("\n");
  }

  function subagentChildPrompt(input: {
    objective: string;
    contextPack: string | null;
    workerBrief: SubagentWorkerBrief;
  }): string {
    return [
      input.objective,
      input.contextPack ? ["Context:", input.contextPack].join("\n") : null,
      formatSubagentWorkerBrief(input.workerBrief),
    ].filter(Boolean).join("\n\n");
  }

  function subagentWorkerBriefForStart(input: {
    role: SubagentRoleSettings;
    objective: string;
    provided: SubagentWorkerBrief | null;
  }): SubagentWorkerBrief {
    const provided = SubagentWorkerBriefSchema.parse(input.provided ?? {});
    return SubagentWorkerBriefSchema.parse({
      plan: provided.plan.length > 0
        ? provided.plan
        : defaultSubagentBriefPlan(input.role.id),
      targetFiles: provided.targetFiles,
      acceptanceCriteria: provided.acceptanceCriteria.length > 0
        ? provided.acceptanceCriteria
        : defaultSubagentAcceptanceCriteria(input.objective),
      validationCommands: provided.validationCommands,
      stopConditions: provided.stopConditions.length > 0
        ? provided.stopConditions
        : defaultSubagentStopConditions(),
    });
  }

  function defaultSubagentBriefPlan(roleId: string): string[] {
    if (roleId === "coding") {
      return [
        "Orient on the relevant code and existing tests before editing.",
        "Make the smallest scoped implementation that satisfies the assignment.",
        "Run the focused validation commands from the brief, or explain why validation cannot run.",
        "Submit a review packet with changed files, validation evidence, blockers, and risks.",
      ];
    }
    if (roleId === "review") {
      return [
        "Inspect the supplied code, diff, report, or context.",
        "Identify correctness, regression, and test risks before style concerns.",
        "Submit ranked findings with concrete evidence and any required corrections.",
      ];
    }
    if (roleId === "test") {
      return [
        "Inspect the target behavior and existing coverage.",
        "Run or design focused validation for the assignment.",
        "Submit command evidence, failures, gaps, and recommended next checks.",
      ];
    }
    return [
      "Orient on the assignment and supplied context.",
      "Do the bounded specialist work for this role.",
      "Submit a review packet with findings, evidence, blockers, and risks.",
    ];
  }

  function defaultSubagentAcceptanceCriteria(objective: string): string[] {
    return [
      `Submit a reviewable result for: ${objective}`,
      "Attach or cite changed files, artifacts, references, or evidence when relevant.",
      "Report validation performed, or explain why validation is unavailable or not applicable.",
      "List unresolved blockers, risks, and follow-up needed.",
    ];
  }

  function defaultSubagentStopConditions(): string[] {
    return [
      "Stop and report a blocker if required context, permissions, dependencies, or workspace access are unavailable.",
      "Stop and submit for review instead of repeating the same search, read, or command pattern without new information.",
      "Stop and report recoverable artifacts if a provider, tool, or workspace failure occurs after meaningful work.",
    ];
  }

  function formatSubagentWorkerBrief(brief: SubagentWorkerBrief): string {
    return [
      "Structured worker brief:",
      formatSubagentBriefList("Plan", brief.plan),
      formatSubagentBriefList("Target files", brief.targetFiles),
      formatSubagentBriefList("Acceptance criteria", brief.acceptanceCriteria),
      formatSubagentBriefList("Validation commands", brief.validationCommands),
      formatSubagentBriefList("Stop conditions", brief.stopConditions),
    ].filter(Boolean).join("\n");
  }

  function formatSubagentBriefList(label: string, values: readonly string[]): string | null {
    if (values.length === 0) return null;
    return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
  }

  function subagentSystemContextForSession(session: Session): string | null {
    if (!session.subagentRunId) return null;
    const subagent = recordFromUnknown(recordFromUnknown(session.metadata)?.subagent);
    const systemContext = typeof subagent?.systemContext === "string" ? subagent.systemContext.trim() : "";
    return systemContext || null;
  }

  async function latestAssistantTextForSession(sessionId: string): Promise<string | null> {
    const events = (await store.snapshot()).events.filter((item) => item.sessionId === sessionId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const item = events[index];
      if (item?.name === "assistant.delta" && item.output?.trim()) return item.output.trim();
    }
    return null;
  }

  function subagentReviewPacketQuality(input: {
    run: SubagentRun;
    finalSummary: string | null;
    report: NonNullable<SubagentRun["report"]>;
    progress: SubagentProgress;
  }): SubagentRun["review"]["packetQuality"] {
    const issues: string[] = [];
    const warnings: string[] = [];
    const finalSummary = input.finalSummary?.trim() ?? "";
    const requestedValidationCommandCount = input.run.workerBrief.validationCommands.length;
    const validationAttemptCount = input.progress.validationAttempts.length;
    const failedValidationCount = input.progress.validationAttempts.filter((attempt) => attempt.status === "failed").length;
    const testsRunCount = input.report.testsRun?.length ?? 0;
    const changedFileCount = input.progress.changedFiles.length;
    const patchRefPresent = Boolean(input.report.patchRef);
    const diffRefPresent = Boolean(input.report.diffRef);
    const artifactCount = input.report.artifacts?.length ?? 0;
    const findingCount = input.report.findings?.length ?? 0;
    const blockerCount = uniqueNonEmptyStrings([
      ...(input.report.blockers ?? []),
      input.progress.currentBlocker ?? "",
    ]).length;
    const validationAttempted = validationAttemptCount > 0 || testsRunCount > 0;
    const changed = changedFileCount > 0 || patchRefPresent || diffRefPresent;
    const unvalidatedWorkspaceChanges = changed && !validationAttempted;
    if (!finalSummary) {
      issues.push("Final report summary is missing.");
    }
    if (requestedValidationCommandCount > 0 && !validationAttempted) {
      warnings.push("Worker brief requested validation, but no validation attempt was observed.");
    }
    if (unvalidatedWorkspaceChanges) {
      warnings.push("Workspace changes have no observed validation attempt.");
    }
    return {
      status: issues.length > 0 ? "incomplete" : warnings.length > 0 ? "weak" : "reviewable",
      issues,
      warnings,
      evidence: {
        finalSummaryPresent: finalSummary.length > 0,
        finalSummaryLength: finalSummary.length,
        requestedValidationCommandCount,
        validationAttemptCount,
        failedValidationCount,
        testsRunCount,
        changedFileCount,
        patchRefPresent,
        diffRefPresent,
        artifactCount,
        findingCount,
        blockerCount,
        unvalidatedWorkspaceChanges,
      },
    };
  }

  function subagentReviewRoutingRecommendation(input: {
    run: SubagentRun;
    reviewRoutingPolicy: SubagentReviewRoutingPolicy;
    packetQuality: SubagentRun["review"]["packetQuality"];
    report: NonNullable<SubagentRun["report"]>;
    progress: SubagentProgress;
    providerFailureAfterChanges?: boolean;
  }): Pick<
    SubagentRun["review"],
    "independentReviewRecommended" | "reviewerRoutingReasons" | "reviewerRoutingEvidence"
  > {
    const changedFiles = uniqueNonEmptyStrings([
      ...(input.progress.changedFiles ?? []),
      ...(input.report.patchRef ? [input.report.patchRef.label, input.report.patchRef.id] : []),
      ...(input.report.diffRef ? [input.report.diffRef.label, input.report.diffRef.id] : []),
    ]);
    const validationAttemptCount = input.progress.validationAttempts.length + (input.report.testsRun?.length ?? 0);
    const failedValidationCount = input.progress.validationAttempts.filter((attempt) => attempt.status === "failed").length;
    const highRiskFileCount = changedFiles.filter((filePath) =>
      subagentReviewHighRiskPath(filePath, input.reviewRoutingPolicy.highRiskPathPatterns)
    ).length;
    const missingRequestedValidation =
      input.run.workerBrief.validationCommands.length > 0 && validationAttemptCount === 0;
    const changedWithoutValidation = changedFiles.length > 0 && validationAttemptCount === 0;
    const providerFailureAfterChanges = Boolean(input.providerFailureAfterChanges);
    const userRequestedIndependentReview = subagentUserRequestedIndependentReview(input.run);
    const reasons = uniqueSubagentReviewRoutingReasons([
      input.packetQuality.status === "incomplete" ? "packet_quality_incomplete" : "",
      input.packetQuality.status === "weak" ? "packet_quality_weak" : "",
      input.report.confidence === "low" ? "low_confidence" : "",
      failedValidationCount > 0 ? "validation_failed" : "",
      missingRequestedValidation || changedWithoutValidation ? "validation_missing" : "",
      changedFiles.length >= input.reviewRoutingPolicy.broadEditSurfaceFileThreshold ? "broad_edit_surface" : "",
      highRiskFileCount > 0 ? "high_risk_files" : "",
      providerFailureAfterChanges ? "provider_failure_after_changes" : "",
      userRequestedIndependentReview ? "user_requested_independent_review" : "",
    ]);
    return {
      independentReviewRecommended: reasons.length > 0,
      reviewerRoutingReasons: reasons,
      reviewerRoutingEvidence: {
        packetQualityStatus: input.packetQuality.status,
        confidence: input.report.confidence ?? null,
        changedFileCount: changedFiles.length,
        highRiskFileCount,
        validationAttemptCount,
        failedValidationCount,
        missingRequestedValidation,
        providerFailureAfterChanges,
        userRequestedIndependentReview,
      },
    };
  }

  function uniqueSubagentReviewRoutingReasons(
    reasons: Array<SubagentReviewRoutingReason | "" | null | undefined>,
  ): SubagentReviewRoutingReason[] {
    const seen = new Set<SubagentReviewRoutingReason>();
    const result: SubagentReviewRoutingReason[] = [];
    for (const reason of reasons) {
      if (!reason || seen.has(reason)) continue;
      seen.add(reason);
      result.push(reason);
    }
    return result;
  }

  function subagentReviewHighRiskPath(value: string, patterns: readonly string[]): boolean {
    const normalized = value.trim().replace(/\\/g, "/").toLowerCase();
    if (!normalized) return false;
    return patterns.some((pattern) => {
      try {
        return new RegExp(pattern).test(normalized);
      } catch {
        return false;
      }
    });
  }

  function subagentUserRequestedIndependentReview(run: SubagentRun): boolean {
    const text = [
      run.objective,
      ...run.workerBrief.plan,
      ...run.workerBrief.acceptanceCriteria,
      ...run.workerBrief.stopConditions,
    ].join("\n").toLowerCase();
    return /\b(independent review|independent reviewer|separate review|separate reviewer|second reviewer|second pass review)\b/.test(text);
  }

  function activeThreadGoalId(events: RuntimeEvent[], sessionId: string): string | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const item = events[index];
      if (item.sessionId !== sessionId || item.name !== "diagnostic") continue;
      const data = item.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const record = data as Record<string, unknown>;
      if (record.kind === "thread_goal_cleared") return null;
      if (record.kind !== "thread_goal") continue;
      const goal = record.goal;
      if (!goal || typeof goal !== "object" || Array.isArray(goal)) continue;
      const goalRecord = goal as Record<string, unknown>;
      const status = stringFromRecord(goalRecord, "status")?.toLowerCase() ?? "active";
      if (status === "completed" || status === "complete" || status === "failed" || status === "stopped") {
        return null;
      }
      return stringFromRecord(goalRecord, "id");
    }
    return null;
  }

  async function startCreatePipelineFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondCreatePipelineToolInput,
  ): Promise<OpenPondCreatePipelineToolResult> {
    const objective = input.objective.trim();
    if (!objective) throw new Error("objective is required");
    const targetAgentId = input.operation === "edit"
      ? input.targetAgentId?.trim() || context.session.appId || null
      : null;
    if (input.operation === "edit" && !targetAgentId) {
      throw new Error("openpond_create_pipeline edit requires targetAgentId or a selected agent in the current chat.");
    }
    const turn = await getStoredTurn(context.turnId);
    if (!turn) throw new Error("Turn not found");
    const profile = await loadCreatePipelineProfileState();
    const request = buildCreatePipelineRequestFromModelTool({
      session: context.session,
      profile,
      operation: input.operation,
      objective,
      targetAgentId,
      mentionedApps: context.mentionedApps,
      userPrompt: context.userPrompt,
      source: input.source ?? "model_tool",
    });
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "create_pipeline.updated",
        source: "provider",
        appId: context.session.appId,
        status: "pending",
        output: "Create planner is preparing the plan.",
        data: {
          createPipelineRequest: request,
          createPipeline: null,
        },
      }),
    );
    const snapshot = await planCreatePipelineForTurn({
      session: context.session,
      turn,
      request,
      previousSnapshot: null,
      signal: context.signal,
    });
    await persistCreatePipelineSnapshot({
      session: context.session,
      turnId: context.turnId,
      request,
      snapshot,
      source: "provider",
    });
    return {
      requestId: request.id,
      pipelineId: snapshot.id,
      operation: input.operation,
      state: snapshot.state,
      nextStep: createPipelineToolNextStep(snapshot),
    };
  }

  async function loadCreatePipelineProfileState(): Promise<OpenPondProfileState | null> {
    if (!loadOpenPondProfileState) return null;
    return loadOpenPondProfileState();
  }

  function buildCreatePipelineRequestFromModelTool(input: {
    session: Session;
    profile: OpenPondProfileState | null;
    operation: "create" | "edit";
    objective: string;
    targetAgentId: string | null;
    mentionedApps: OpenPondApp[];
    userPrompt: string;
    source: "natural_language" | "model_tool";
  }): CreatePipelineRequest {
    const createdAt = now();
    const executionTarget = resolveWorkspaceExecutionTarget({ session: input.session });
    const localProfileLoaded =
      executionTarget.target !== "sandbox" &&
      input.profile?.mode === "local" &&
      Boolean(input.profile.repoPath) &&
      Boolean(input.profile.sourcePath);
    const hosted = input.profile?.hosted ?? null;
    const command = input.operation === "create" ? "/create" : "/edit";
    return CreatePipelineRequestSchema.parse({
      schemaVersion: "openpond.createPipeline.request.v1",
      id: `create_request_${randomUUID()}`,
      operation: input.operation,
      surface: input.operation === "create" ? "direct_prompt_create" : "direct_prompt_edit",
      command,
      objective: input.objective,
      adapter: localProfileLoaded
        ? {
            kind: "local",
            sourceAuthority: "local_profile",
            activeProfile: input.profile?.activeProfile ?? null,
            repoPath: input.profile?.repoPath ?? null,
            sourcePath: input.profile?.sourcePath ?? null,
            localHead: input.profile?.git?.head ?? null,
            confirmationPolicy: "always_require_plan_approval",
          }
        : {
            kind: "hosted",
            sourceAuthority: "hosted_profile",
            teamId: input.session.cloudTeamId ?? hosted?.teamId ?? null,
            projectId: input.session.cloudProjectId ?? hosted?.projectId ?? null,
            activeProfile: input.profile?.activeProfile ?? "default",
            sourceRef: hosted?.sourceRef ?? null,
            baseSha: hosted?.sourceCommitSha ?? null,
            workItemId: null,
            confirmationPolicy: "always_require_plan_approval",
          },
      actor: {
        id: null,
        kind: "user",
        label: null,
      },
      scope: {
        conversationId: input.session.id,
        workItemId: null,
        projectId: input.session.cloudProjectId ?? input.session.localProjectId ?? null,
        targetProject: input.session.workspaceId
          ? {
              id: input.session.workspaceId,
              name: input.session.workspaceName,
              workspacePath: input.session.cwd,
              sourceRef: null,
              baseSha: null,
            }
          : null,
      },
      context: {
        messageIds: [],
        conversationExcerpts: [
          {
            messageId: null,
            role: "user",
            excerpt: (input.userPrompt || input.objective).slice(0, 1200),
            reason: "Natural-language Create Pipeline tool request",
          },
        ],
        attachments: [],
        apps: capturedCreatePipelineApps(input.mentionedApps, input.session),
        tools: [],
        targetRepoAssumptions: createPipelineTargetRepoAssumptions(input.session),
      },
      targetAgent: {
        agentId: input.targetAgentId,
        displayName:
          input.targetAgentId && input.targetAgentId === input.session.appId
            ? input.session.appName
            : null,
        defaultActionKey: input.targetAgentId ? `${input.targetAgentId}.chat` : "chat",
      },
      metadata: {
        source: "native_model_tool",
        toolName: "openpond_create_pipeline",
        routingSource: input.source,
      },
      createdAt,
    });
  }

  function capturedCreatePipelineApps(apps: OpenPondApp[], session: Session) {
    const byId = new Map<string, { id: string; name: string; connectionId: string | null; required: boolean }>();
    for (const app of apps) {
      byId.set(app.id, {
        id: app.id,
        name: app.name,
        connectionId: null,
        required: true,
      });
    }
    if (session.appId && session.appName) {
      byId.set(session.appId, {
        id: session.appId,
        name: session.appName,
        connectionId: null,
        required: true,
      });
    }
    return [...byId.values()];
  }

  function createPipelineTargetRepoAssumptions(session: Session): string[] {
    const target = resolveWorkspaceExecutionTarget({ session });
    if (target.target === "sandbox") {
      return [
        `${target.hybrid ? "hybrid sandbox" : "sandbox"}: ${target.sandboxId ?? "pending"}`,
        ...(target.cloudProjectId ? [`cloud project: ${target.cloudProjectId}`] : []),
        ...(target.localProjectId ? [`local project: ${target.localProjectId}`] : []),
      ];
    }
    if (target.target === "local" && target.cwd) return [`workspace: ${target.cwd}`];
    if (target.target === "local" && target.localProjectId) return [`local project: ${target.localProjectId}`];
    return [];
  }

  function createPipelineToolNextStep(snapshot: CreatePipelineSnapshot): string {
    if (snapshot.state === "awaiting_questions") {
      return "Create Pipeline is waiting for user answers before planning can continue.";
    }
    if (snapshot.state === "awaiting_plan_approval") {
      return "Create Pipeline plan is ready for review and approval.";
    }
    if (snapshot.state === "blocked" || snapshot.state === "failed") {
      return snapshot.blockedReason ?? "Create Pipeline could not prepare a plan.";
    }
    if (snapshot.state === "cancelled") {
      return "Create Pipeline was cancelled.";
    }
    return `Create Pipeline state: ${snapshot.state}.`;
  }

  async function startProfileSkillGoalFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondProfileSkillGoalToolInput,
  ): Promise<OpenPondProfileSkillGoalToolResult> {
    if (!executeProfileSkillGoal) {
      throw new Error("Profile skill goal execution is not configured for this turn.");
    }
    const executionTarget = resolveWorkspaceExecutionTarget({ session: context.session });
    if (executionTarget.target === "sandbox") {
      throw new Error(
        "Profile skill goals are local profile workspace actions and are not supported while Working in Hybrid or sandbox. Use Create Pipeline for hosted agent/workflow changes, or switch Working in to Local before creating or editing profile skills.",
      );
    }
    const objective = input.objective.trim();
    if (!objective) throw new Error("objective is required");
    const unsupported = profileSkillAgentRequirementReason([
      objective,
      input.changeRequest ?? "",
    ].join(" "));
    if (unsupported) {
      throw new Error(`${unsupported} Create an agent instead of a single-file profile skill.`);
    }
    const command = await executeProfileSkillGoal({
      operation: input.operation,
      objective,
      skillName: input.skillName ?? null,
      changeRequest: input.changeRequest ?? null,
      source: input.source ?? "model_tool",
    });
    if (command.handled || command.action !== "goal") {
      throw new Error("Profile skill goal execution did not produce a goal request.");
    }
    await updateSession(context.session.id, { cwd: command.workspaceCwd });
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "diagnostic",
        source: "provider",
        appId: context.session.appId,
        status: "completed",
        output: "Profile skill goal routed.",
        data: {
          kind: "profile_skill_command",
          action: command.action,
          routing: "goal",
          source: input.source ?? "model_tool",
          goal: command.goal,
          skill: command.skill ?? null,
        },
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "diagnostic",
        source: "provider",
        appId: context.session.appId,
        status: "completed",
        output: command.goal.objective,
        data: {
          kind: "thread_goal",
          provider: "openpond",
          goal: command.goal,
        },
      }),
    );
    const executed = await executeProfileSkillGoalForTurn({
      session: context.session,
      turnId: context.turnId,
      command,
      eventSource: "provider",
    });
    return profileSkillGoalToolResultFromExecution(executed);
  }

  async function executeProfileSkillGoalForTurn(input: {
    session: Session;
    turnId: string;
    command: Extract<ProfileSkillCommandResult, { action: "goal" }>;
    eventSource: RuntimeEvent["source"];
  }): Promise<ProfileSkillGoalExecutionResult> {
    const queuedGoal = input.command.goal;
    await appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: "diagnostic",
        source: input.eventSource,
        appId: input.session.appId,
        status: "completed",
        output: `Creating profile skill: ${queuedGoal.objective}`,
        data: {
          kind: "thread_goal",
          provider: "openpond",
          goal: { ...queuedGoal, status: "running" },
        },
      }),
    );
    try {
      const executed = await executeProfileSkillGoalRequest(queuedGoal as ProfileSkillGoalRequest);
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turnId,
          name: "diagnostic",
          source: input.eventSource,
          appId: input.session.appId,
          status: "completed",
          output: executed.message,
          data: {
            kind: "thread_goal",
            provider: "openpond",
            goal: executed.goal,
          },
        }),
      );
      return executed;
    } catch (error) {
      const message = textFromUnknown(error) || "Profile skill goal failed.";
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turnId,
          name: "diagnostic",
          source: input.eventSource,
          appId: input.session.appId,
          status: "failed",
          output: message,
          error: message,
          data: {
            kind: "thread_goal",
            provider: "openpond",
            goal: { ...queuedGoal, status: "failed" },
          },
        }),
      );
      throw error;
    }
  }

  function profileSkillGoalToolResultFromExecution(
    executed: ProfileSkillGoalExecutionResult,
  ): OpenPondProfileSkillGoalToolResult {
    return {
      goalId: executed.goal.id,
      operation: executed.goal.operation,
      targetSkillName: executed.goal.targetSkillName,
      targetSkillPath: executed.goal.targetSkillPath,
      status: executed.goal.status,
      nextStep: executed.message,
      validationStatus: executed.validationStatus,
      validationMessages: executed.validationMessages,
      invocation: executed.invocation,
    };
  }

  function profileSkillAgentRequirementReason(value: string): string | null {
    const normalized = value.toLowerCase();
    const unsupported = [
      { label: "script", pattern: /\bscripts?\b/g },
      { label: "reference file", pattern: /\breference\s+files?\b/g },
      { label: "references/", pattern: /\breferences\//g },
      { label: "asset", pattern: /\bassets?\b/g },
      { label: "tool dependency", pattern: /\btool\s+dependencies?\b/g },
      { label: "mcp", pattern: /\bmcp\b/g },
      { label: "setup file", pattern: /\bsetup\s+files?\b/g },
      { label: "setup command", pattern: /\bsetup\s+commands?\b/g },
      { label: "eval", pattern: /\bevals?\b/g },
      { label: "external system", pattern: /\bexternal\s+systems?\b/g },
      { label: "webhook", pattern: /\bwebhooks?\b/g },
      { label: "api integration", pattern: /\bapi\s+integrations?\b/g },
    ];
    for (const item of unsupported) {
      item.pattern.lastIndex = 0;
      for (const match of normalized.matchAll(item.pattern)) {
        if (!isNegatedProfileSkillRequirement(normalized, match.index ?? 0)) {
          return `Profile skills are single-file instructions and cannot include ${item.label}.`;
        }
      }
    }
    return null;
  }

  function isNegatedProfileSkillRequirement(value: string, matchIndex: number): boolean {
    const prefix = value.slice(Math.max(0, matchIndex - 36), matchIndex);
    return /\b(?:no|not|without|exclude|excluding|avoid|avoiding|never|cannot|can't|do not|don't)\s+(?:any\s+)?(?:extra\s+|additional\s+)?$/.test(prefix);
  }

  async function startGoalControlFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondGoalControlToolInput,
    runtimeEvents: RuntimeEvent[],
  ): Promise<OpenPondGoalControlToolResult> {
    const result = runOpenPondGoalControl({
      session: context.session,
      events: runtimeEvents,
      request: input,
    });
    await assertGoalSubagentsResolvedForCompletion({
      context,
      goalId: result.goal.id,
      action: result.action,
    });
    const resumedSubagentCount = await markGoalSubagentsNeedsResume({
      context,
      goalId: result.goal.id,
      action: result.action,
    });
    const lifecycleSubagentResult = await applyGoalLifecycleToSubagents({
      context,
      goalId: result.goal.id,
      action: result.action,
    });
    const supersededSubagentCount = await markGoalSubagentsSuperseded({
      context,
      action: result.action,
      previousGoal: result.previousGoal,
      supersededByGoal: result.goal,
    });
    const subagentLifecycle = {
      ...lifecycleSubagentResult,
      supersededCount: supersededSubagentCount,
    };
    const lifecycleNotes = [
      resumedSubagentCount > 0
        ? `${resumedSubagentCount} active ${resumedSubagentCount === 1 ? "subagent needs" : "subagents need"} resume.`
        : null,
      supersededSubagentCount > 0
        ? `${supersededSubagentCount} linked ${supersededSubagentCount === 1 ? "subagent was" : "subagents were"} superseded.`
        : null,
      lifecycleSubagentResult.cancelledCount > 0
        ? `${lifecycleSubagentResult.cancelledCount} linked ${lifecycleSubagentResult.cancelledCount === 1 ? "subagent was" : "subagents were"} cancelled.`
        : null,
      lifecycleSubagentResult.cleanedCount > 0
        ? `${lifecycleSubagentResult.cleanedCount} linked ${lifecycleSubagentResult.cleanedCount === 1 ? "workspace was" : "workspaces were"} cleaned or retained by policy.`
        : null,
      lifecycleSubagentResult.archivedCount > 0
        ? `${lifecycleSubagentResult.archivedCount} linked child ${lifecycleSubagentResult.archivedCount === 1 ? "session was" : "sessions were"} archived.`
        : null,
    ].filter(Boolean);
    const nextStep = lifecycleNotes.length > 0
      ? `${result.nextStep} ${lifecycleNotes.join(" ")}`
      : result.nextStep;
    const goal = await openPondGoalWithDerivedSubagentState({
      context,
      goal: result.goal,
    });
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "diagnostic",
        source: "provider",
        appId: context.session.appId,
        status: "completed",
        output: nextStep,
        data: {
          kind: "goal_control",
          provider: "openpond",
          action: input.action,
          mode: result.mode,
          reason: input.reason,
          goal,
          previousGoal: result.previousGoal,
          subagentLifecycle,
        },
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "diagnostic",
        source: "provider",
        appId: context.session.appId,
        status: "completed",
        output: goal.objective,
        data: {
          kind: "thread_goal",
          provider: "openpond",
          goal,
        },
      }),
    );
    if (shouldQueueOpenPondGoalContinuation(result.action, goal)) {
      queueOpenPondGoalContinuation({
        session: context.session,
        sourceTurnId: context.turnId,
        action: result.action,
        goal,
      });
    }
    return {
      goalId: goal.id,
      action: result.action,
      status: result.status,
      objective: goal.objective,
      mode: result.mode,
      nextStep,
    };
  }

  async function openPondGoalWithDerivedSubagentState(input: {
    context: ModelToolExecutionContext;
    goal: OpenPondGoalControlGoal;
  }): Promise<OpenPondGoalControlGoal> {
    if (!subagentToolsAvailable()) return input.goal;
    const subagents = await derivedGoalSubagentState({
      parentSessionId: input.context.session.id,
      parentGoalId: input.goal.id,
    });
    return {
      ...input.goal,
      subagents,
    };
  }

  async function derivedGoalSubagentState(input: {
    parentSessionId: string;
    parentGoalId: string;
  }): Promise<OpenPondGoalSubagentState> {
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.parentSessionId,
      parentGoalId: input.parentGoalId,
      limit: 1000,
    });
    const requiredRuns = runs.filter((run) => run.required);
    const summaries = runs.map(goalSubagentRunSummary);
    return {
      source: "subagent_runs",
      updatedAt: now(),
      totalCount: runs.length,
      requiredCount: requiredRuns.length,
      optionalCount: runs.length - requiredRuns.length,
      activeCount: runs.filter(goalSubagentRunActive).length,
      submittedForReviewCount: runs.filter((run) => run.status === "submitted_for_review").length,
      needsRevisionCount: runs.filter((run) => run.status === "needs_revision").length,
      needsUserInputCount: runs.filter((run) => run.status === "needs_user_input").length,
      acceptedCount: runs.filter(subagentRunAccepted).length,
      blockingCount: runs.filter(goalSubagentRunBlocking).length,
      terminalCount: runs.filter(goalSubagentRunTerminal).length,
      cleanupNeededCount: runs.filter(goalSubagentRunCleanupNeeded).length,
      archivedCount: runs.filter(goalSubagentRunArchived).length,
      unresolvedCount: runs.filter((run) => !subagentRunResolvedForGoal(run)).length,
      requiredActiveCount: requiredRuns.filter(goalSubagentRunActive).length,
      requiredSubmittedForReviewCount: requiredRuns.filter((run) => run.status === "submitted_for_review").length,
      requiredNeedsRevisionCount: requiredRuns.filter((run) => run.status === "needs_revision").length,
      requiredNeedsUserInputCount: requiredRuns.filter((run) => run.status === "needs_user_input").length,
      requiredAcceptedCount: requiredRuns.filter(subagentRunAccepted).length,
      requiredBlockingCount: requiredRuns.filter(goalSubagentRunBlocking).length,
      requiredArchivedCount: requiredRuns.filter(goalSubagentRunArchived).length,
      requiredUnresolvedCount: requiredRuns.filter((run) => !subagentRunResolvedForGoal(run)).length,
      runs: summaries,
    };
  }

  function goalSubagentRunSummary(run: SubagentRun): OpenPondGoalSubagentRunSummary {
    const cleanup = recordFromUnknown(run.metadata?.lifecycleCleanup);
    const workspaceCleanup = recordFromUnknown(cleanup?.workspaceCleanup);
    const childSessionArchive = recordFromUnknown(run.metadata?.childSessionArchive);
    const archiveStatus = stringFromRecord(childSessionArchive ?? {}, "status");
    return {
      id: run.id,
      childSessionId: run.childSessionId,
      roleId: run.roleId,
      status: run.status,
      required: run.required,
      objective: run.objective,
      reviewStatus: run.review?.status ?? null,
      updatedAt: run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt ?? null,
      cleanupStatus: stringFromRecord(workspaceCleanup ?? cleanup ?? {}, "status"),
      archiveStatus,
      sessionArchived: archiveStatus === "archived" || archiveStatus === "already_archived",
      blockerCount: (run.report?.blockers.length ?? 0) + (run.error ? 1 : 0),
      validationAttemptCount: run.progress?.validationAttempts.length ?? 0,
      changedFileCount: run.progress?.changedFiles.length ?? 0,
      followUpNeeded: run.report?.followUpNeeded ?? false,
    };
  }

  function goalSubagentRunActive(run: SubagentRun): boolean {
    return run.status === "queued" || run.status === "running" || run.status === "needs_resume";
  }

  function goalSubagentRunBlocking(run: SubagentRun): boolean {
    if (subagentRunDismissed(run)) return false;
    return run.status === "blocked" ||
      run.status === "needs_user_input" ||
      run.status === "failed_with_artifacts" ||
      run.status === "failed" ||
      run.status === "cancelled";
  }

  function goalSubagentRunTerminal(run: SubagentRun): boolean {
    return subagentRunAccepted(run) ||
      subagentRunDismissed(run) ||
      run.status === "failed" ||
      run.status === "failed_with_artifacts" ||
      run.status === "cancelled" ||
      run.status === "superseded";
  }

  function subagentRunResolvedForGoal(run: SubagentRun): boolean {
    return subagentRunAccepted(run) || subagentRunDismissed(run) || run.status === "superseded";
  }

  function goalSubagentRunCleanupNeeded(run: SubagentRun): boolean {
    if (!goalSubagentRunTerminal(run)) return false;
    const metadata = recordFromUnknown(run.metadata);
    if (!metadata?.subagentWorkspace && !metadata?.workspaceHandoff) return false;
    const cleanup = recordFromUnknown(run.metadata?.lifecycleCleanup);
    const workspaceCleanup = recordFromUnknown(cleanup?.workspaceCleanup);
    return !workspaceCleanup;
  }

  function goalSubagentRunArchived(run: SubagentRun): boolean {
    const childSessionArchive = recordFromUnknown(run.metadata?.childSessionArchive);
    const archiveStatus = stringFromRecord(childSessionArchive ?? {}, "status");
    return archiveStatus === "archived" || archiveStatus === "already_archived";
  }

  function shouldQueueOpenPondGoalContinuation(
    action: OpenPondGoalControlAction,
    goal: OpenPondGoalControlGoal,
  ): boolean {
    return enableGoalContinuations &&
      (action === "start" || action === "restart" || action === "resume") &&
      goal.status === "queued";
  }

  function queueOpenPondGoalContinuation(input: {
    session: Session;
    sourceTurnId: string;
    action: OpenPondGoalControlAction;
    goal: OpenPondGoalControlGoal;
  }): void {
    const key = `${input.session.id}:${input.goal.id}:${input.sourceTurnId}:${input.action}`;
    if (goalContinuationJobs.has(key)) return;
    const receipt = turnFollowUpQueue.enqueue(
      {
        label: `Continue goal: ${input.goal.objective.slice(0, 80)}`,
        metadata: {
          key,
          sessionId: input.session.id,
          sourceTurnId: input.sourceTurnId,
          goalId: input.goal.id,
          action: input.action,
        },
      },
      async () => {
        try {
          await waitForSessionIdle(input.session.id, GOAL_CONTINUATION_IDLE_WAIT_MS);
          const latestGoal = await latestOpenPondGoalForContinuation(input.session.id);
          if (!latestGoal || latestGoal.id !== input.goal.id || !isContinuableOpenPondGoal(latestGoal)) {
            await appendRuntimeEvent(
              event({
                sessionId: input.session.id,
                turnId: input.sourceTurnId,
                name: "goal.continuation.skipped",
                source: "server",
                appId: input.session.appId,
                status: "completed",
                output: "Goal continuation skipped because the goal is no longer active.",
                data: {
                  goalId: input.goal.id,
                  latestGoalId: latestGoal?.id ?? null,
                  latestStatus: latestGoal?.status ?? null,
                },
              }),
            );
            return;
          }

          await appendRuntimeEvent(
            event({
              sessionId: input.session.id,
              turnId: input.sourceTurnId,
              name: "goal.continuation.started",
              source: "server",
              appId: input.session.appId,
              status: "started",
              output: "Goal continuation queued.",
              data: {
                goalId: latestGoal.id,
                action: input.action,
              },
            }),
          );
          await sendTurn(input.session.id, {
            prompt: openPondGoalContinuationPrompt(latestGoal),
            metadata: {
              goalContinuation: {
                goalId: latestGoal.id,
                sourceTurnId: input.sourceTurnId,
                action: input.action,
              },
              threadGoal: latestGoal,
            },
            usageAttribution: {
              surface: "goal",
              workflowKind: "goal_control",
              goalId: latestGoal.id,
              commandName: "/goal",
              commandSource: "model_tool",
            },
          });
        } catch (error) {
          await appendRuntimeEvent(
            event({
              sessionId: input.session.id,
              turnId: input.sourceTurnId,
              name: "goal.continuation.failed",
              source: "server",
              appId: input.session.appId,
              status: "failed",
              output: textFromUnknown(error) || "Goal continuation failed.",
              error: textFromUnknown(error) || undefined,
              data: {
                goalId: input.goal.id,
                action: input.action,
              },
            }),
          ).catch(() => undefined);
        } finally {
          goalContinuationJobs.delete(key);
        }
      },
    );
    goalContinuationJobs.set(key, receipt);
  }

  async function waitForSessionIdle(sessionId: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while ((await activeInProgressTurn(sessionId)) || (await findInProgressTurn(sessionId))) {
      if (Date.now() - started >= timeoutMs) {
        throw new Error("Timed out waiting for the current turn to finish before continuing the goal.");
      }
      await delay(100);
    }
  }

  async function latestOpenPondGoalForContinuation(sessionId: string): Promise<OpenPondGoalControlGoal | null> {
    const snapshot = await store.snapshot();
    for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
      const item = snapshot.events[index]!;
      if (item.sessionId !== sessionId || item.name !== "diagnostic") continue;
      const data = recordFromUnknown(item.data);
      if (!data) continue;
      if (data.kind === "thread_goal_cleared" && openPondGoalProvider(data, null)) return null;
      if (data.kind !== "thread_goal" || !openPondGoalProvider(data, null)) continue;
      const goal = recordFromUnknown(data.goal);
      if (!goal) continue;
      const id = stringFromRecord(goal, "id");
      const objective = stringFromRecord(goal, "objective");
      const status = stringFromRecord(goal, "status");
      if (!id || !objective || !status) continue;
      return {
        ...(goal as OpenPondGoalControlGoal),
        id,
        objective,
        status: status as OpenPondGoalControlGoal["status"],
        provider: "openpond",
      };
    }
    return null;
  }

  function openPondGoalProvider(data: Record<string, unknown>, fallback: string | null): boolean {
    const provider = stringFromRecord(data, "provider") ?? fallback;
    return provider === null || provider === "openpond";
  }

  function isContinuableOpenPondGoal(goal: OpenPondGoalControlGoal): boolean {
    return goal.provider === "openpond" && (goal.status === "queued" || goal.status === "running");
  }

  function openPondGoalContinuationPrompt(goal: OpenPondGoalControlGoal): string {
    return [
      "<goal_context>",
      "Continue the active OpenPond goal now.",
      "",
      `Goal ID: ${goal.id}`,
      `Objective: ${goal.objective}`,
      "",
      "Make concrete progress in this turn using the available tools and workspace context.",
      "If the goal is complete, call openpond_goal_control with action complete and include the evidence in the reason.",
      "If you cannot continue productively without user input or an external change, explain the blocker clearly and do not start an empty loop.",
      "</goal_context>",
    ].join("\n");
  }

  async function assertGoalSubagentsResolvedForCompletion(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: string;
  }): Promise<void> {
    if (input.action !== "complete" || !subagentToolsAvailable()) return;
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.context.session.id,
      parentGoalId: input.goalId,
      limit: 1000,
    });
    const unresolved = runs.filter((run) => run.required && !subagentRunResolvedForGoal(run));
    if (unresolved.length === 0) return;
    const details = unresolved.slice(0, 8).map((run) => `${run.roleId} ${run.status} (${run.id})`).join(", ");
    const hidden = unresolved.length > 8 ? `, +${unresolved.length - 8} more` : "";
    throw new Error(
      `Cannot complete goal ${input.goalId} while required subagents are unresolved: ${details}${hidden}. Join, resume, or explicitly resolve those child runs first.`,
    );
  }

  async function markGoalSubagentsNeedsResume(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: string;
  }): Promise<number> {
    if (input.action !== "resume" || !subagentToolsAvailable()) return 0;
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.context.session.id,
      parentGoalId: input.goalId,
      status: ["queued", "running"],
      limit: 1000,
    });
    let updatedCount = 0;
    for (const run of runs) {
      const blocker = "Goal resumed; this child conversation needs resume before its required subagent work can finish.";
      const updated = SubagentRunSchema.parse({
        ...run,
        status: "needs_resume",
        report: {
          ...(run.report ?? {}),
          summary: run.report?.summary || "Subagent needs resume after parent goal resumed.",
          blockers: uniqueNonEmptyStrings([...(run.report?.blockers ?? []), blocker]),
          followUpNeeded: true,
        },
        metadata: {
          ...run.metadata,
          needsResumeAt: now(),
          needsResumeReason: "parent_goal_resumed",
        },
      });
      await deps.upsertRun(updated);
      await appendSubagentReceipt({
        parentSession: input.context.session,
        parentTurnId: input.context.turnId,
        run: updated,
        eventName: "subagent.blocked",
        status: "pending",
        output: `${updated.roleId} subagent needs resume after parent goal resumed.`,
      });
      updatedCount += 1;
    }
    return updatedCount;
  }

  async function markGoalSubagentsSuperseded(input: {
    context: ModelToolExecutionContext;
    action: OpenPondGoalControlAction;
    previousGoal: Record<string, unknown> | null;
    supersededByGoal: OpenPondGoalControlGoal;
  }): Promise<number> {
    if (input.action !== "restart" || !subagentToolsAvailable()) return 0;
    const previousGoal = recordFromUnknown(input.previousGoal);
    const previousGoalId = stringFromRecord(previousGoal ?? {}, "id");
    if (!previousGoalId) return 0;
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.context.session.id,
      parentGoalId: previousGoalId,
      limit: 1000,
    });
    const reason = `Parent goal ${previousGoalId} restarted; this child run was superseded.`;
    let supersededCount = 0;
    for (const run of runs) {
      if (run.status === "superseded") continue;
      const supersededAt = now();
      let interruptResult: Record<string, unknown> | null = null;
      if (run.childSessionId && subagentRunMayStillBeWorking(run)) {
        try {
          const interrupted = await interruptSessionTurn(run.childSessionId);
          interruptResult = {
            status: interrupted.status,
            turnId: interrupted.id,
          };
        } catch (error) {
          interruptResult = {
            status: "not_active",
            error: textFromUnknown(error) || "No active child turn to interrupt.",
          };
        }
      }
      const updated = SubagentRunSchema.parse({
        ...run,
        status: "superseded",
        completedAt: supersededAt,
        updatedAt: supersededAt,
        error: null,
        progress: SubagentProgressSchema.parse({
          ...run.progress,
          phase: "report",
          latestMeaningfulActivity: "Parent goal restarted; child run superseded.",
          currentBlocker: null,
          updatedAt: supersededAt,
        }),
        report: {
          ...(run.report ?? {}),
          summary: run.report?.summary || "Subagent superseded by parent goal restart.",
          followUpNeeded: false,
        },
        metadata: {
          ...(run.metadata ?? {}),
          superseded: {
            status: "superseded",
            reason,
            supersededAt,
            previousStatus: run.status,
            previousGoalId,
            supersededByGoalId: input.supersededByGoal.id,
            requestedBySessionId: input.context.session.id,
            requestedByTurnId: input.context.turnId,
            interruptResult,
          },
        },
      });
      await deps.upsertRun(updated);
      await appendSubagentReceipt({
        parentSession: input.context.session,
        parentTurnId: input.context.turnId,
        run: updated,
        eventName: "subagent.superseded",
        status: "completed",
        output: `${updated.roleId} subagent superseded by restarted parent goal.`,
      });
      supersededCount += 1;
    }
    return supersededCount;
  }

  async function applyGoalLifecycleToSubagents(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: OpenPondGoalControlAction;
  }): Promise<{ cancelledCount: number; cleanedCount: number; archivedCount: number }> {
    if (!subagentToolsAvailable() || (input.action !== "stop" && input.action !== "complete")) {
      return { cancelledCount: 0, cleanedCount: 0, archivedCount: 0 };
    }
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.context.session.id,
      parentGoalId: input.goalId,
      limit: 1000,
    });
    let cancelledCount = 0;
    let cleanedCount = 0;
    let archivedCount = 0;
    for (const run of runs) {
      if (input.action === "stop") {
        if (subagentRunAccepted(run) || subagentRunDismissed(run)) {
          const cleanup = await cleanupSubagentRun({
            run,
            parentSession: input.context.session,
            parentTurnId: input.context.turnId,
            reason: subagentRunDismissed(run) ? "goal_stopped_dismissed" : "goal_stopped",
            policy: "auto_after_acceptance",
          });
          const archived = await archiveSubagentChildSession({
            parentSession: input.context.session,
            parentTurnId: input.context.turnId,
            run: cleanup.run,
            reason: "goal_stopped",
            policy: "goal_stopped",
          });
          cleanedCount += 1;
          if (archived.archived) archivedCount += 1;
          continue;
        }
        if (subagentRunTerminalForGoalLifecycle(run)) continue;
        const cancelled = await cancelSubagentRunForGoalLifecycle({
          context: input.context,
          run,
          reason: `Parent goal ${input.goalId} stopped.`,
        });
        const archived = await archiveSubagentChildSession({
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          run: cancelled,
          reason: "goal_stopped",
          policy: "goal_stopped",
        });
        cancelledCount += 1;
        cleanedCount += 1;
        if (archived.archived) archivedCount += 1;
        continue;
      }
      if (subagentRunAccepted(run) || subagentRunDismissed(run)) {
        const cleanup = await cleanupSubagentRun({
          run,
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          reason: subagentRunDismissed(run) ? "goal_completed_dismissed" : "goal_completed",
          policy: "auto_after_acceptance",
        });
        const archived = await archiveSubagentChildSession({
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          run: cleanup.run,
          reason: "goal_completed",
          policy: "goal_completed",
        });
        cleanedCount += 1;
        if (archived.archived) archivedCount += 1;
        continue;
      }
      if (!run.required && !subagentRunTerminalForGoalLifecycle(run)) {
        const cancelled = await cancelSubagentRunForGoalLifecycle({
          context: input.context,
          run,
          reason: `Parent goal ${input.goalId} completed before optional subagent finished.`,
        });
        const archived = await archiveSubagentChildSession({
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          run: cancelled,
          reason: "goal_completed_optional_cancel",
          policy: "goal_completed",
        });
        cancelledCount += 1;
        cleanedCount += 1;
        if (archived.archived) archivedCount += 1;
      }
    }
    return { cancelledCount, cleanedCount, archivedCount };
  }

  async function cancelSubagentRunForGoalLifecycle(input: {
    context: ModelToolExecutionContext;
    run: SubagentRun;
    reason: string;
  }): Promise<SubagentRun> {
    const deps = requireSubagentDeps();
    const cancelledAt = now();
    let interruptResult: Record<string, unknown> | null = null;
    if (input.run.childSessionId) {
      try {
        const interrupted = await interruptSessionTurn(input.run.childSessionId);
        interruptResult = {
          status: interrupted.status,
          turnId: interrupted.id,
        };
      } catch (error) {
        interruptResult = {
          status: "not_active",
          error: textFromUnknown(error) || "No active child turn to interrupt.",
        };
      }
    }
    let nextRun = SubagentRunSchema.parse({
      ...input.run,
      status: "cancelled",
      completedAt: cancelledAt,
      error: input.reason,
      report: {
        ...(input.run.report ?? {}),
        summary: input.run.report?.summary || "Subagent cancelled by parent goal lifecycle.",
        blockers: uniqueNonEmptyStrings([...(input.run.report?.blockers ?? []), input.reason]),
        followUpNeeded: false,
      },
      metadata: {
        ...(input.run.metadata ?? {}),
        goalLifecycle: {
          action: "cancelled_by_parent_goal",
          reason: input.reason,
          cancelledAt,
          interruptResult,
        },
      },
    });
    await deps.upsertRun(nextRun);
    const cleanup = await cleanupSubagentRun({
      run: nextRun,
      parentSession: input.context.session,
      parentTurnId: input.context.turnId,
      reason: "goal_lifecycle_cancel",
      policy: "cancel_requested",
    });
    nextRun = SubagentRunSchema.parse({
      ...cleanup.run,
      metadata: {
        ...(cleanup.run.metadata ?? {}),
        goalLifecycle: {
          ...(recordFromUnknown(cleanup.run.metadata?.goalLifecycle) ?? {}),
          workspaceCleanup: cleanup.workspaceCleanup,
        },
      },
    });
    await deps.upsertRun(nextRun);
    await appendSubagentReceipt({
      parentSession: input.context.session,
      parentTurnId: input.context.turnId,
      run: nextRun,
      eventName: "subagent.cancelled",
      status: "completed",
      output: `${nextRun.roleId} subagent cancelled by parent goal lifecycle.`,
    });
    return nextRun;
  }

  async function archiveSubagentChildSession(input: {
    parentSession: Session;
    parentTurnId?: string | null;
    run: SubagentRun;
    reason: string;
    policy: "goal_completed" | "goal_stopped" | "manual_archive";
  }): Promise<{ run: SubagentRun; sessionArchive: Record<string, unknown>; archived: boolean }> {
    if (!input.run.childSessionId) {
      return {
        run: input.run,
        sessionArchive: {
          status: "skipped",
          reason: "childSessionId missing",
          evidenceRetention: input.run.evidenceRetention,
        },
        archived: false,
      };
    }

    const deps = requireSubagentDeps();
    const archivedAt = now();
    let sessionArchive: Record<string, unknown>;
    try {
      const childSession = await getSession(input.run.childSessionId);
      if (childSession.archived) {
        sessionArchive = {
          status: "already_archived",
          sessionId: childSession.id,
          archivedAt,
          reason: input.reason,
          policy: input.policy,
          evidenceRetention: input.run.evidenceRetention,
        };
      } else {
        const updatedSession = await updateSession(childSession.id, {
          archived: true,
          hiddenFromDefaultSidebar: true,
          status: childSession.status === "active" ? "idle" : childSession.status,
          metadata: {
            ...(childSession.metadata ?? {}),
            subagentArchive: {
              status: "archived",
              archivedAt,
              reason: input.reason,
              policy: input.policy,
              parentSessionId: input.run.parentSessionId,
              parentGoalId: input.run.parentGoalId ?? null,
              runId: input.run.id,
              roleId: input.run.roleId,
              evidenceRetention: input.run.evidenceRetention,
            },
          },
        });
        sessionArchive = {
          status: "archived",
          sessionId: updatedSession.id,
          archivedAt,
          reason: input.reason,
          policy: input.policy,
          hiddenFromDefaultSidebar: updatedSession.hiddenFromDefaultSidebar === true,
          previousStatus: childSession.status,
          evidenceRetention: input.run.evidenceRetention,
        };
      }
    } catch (error) {
      sessionArchive = {
        status: "failed",
        sessionId: input.run.childSessionId,
        failedAt: archivedAt,
        reason: input.reason,
        policy: input.policy,
        error: textFromUnknown(error) || "Failed to archive child session.",
        evidenceRetention: input.run.evidenceRetention,
      };
    }

    const nextRun = SubagentRunSchema.parse({
      ...input.run,
      metadata: {
        ...(input.run.metadata ?? {}),
        childSessionArchive: {
          ...sessionArchive,
          evidenceRetention: input.run.evidenceRetention,
        },
      },
    });
    await deps.upsertRun(nextRun);
    const status = stringFromRecord(sessionArchive, "status");
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId ?? null,
      run: nextRun,
      eventName: "subagent.archived",
      status: status === "failed" ? "failed" : "completed",
      output: subagentArchiveOutput(nextRun, sessionArchive),
    });
    return {
      run: nextRun,
      sessionArchive,
      archived: status === "archived" || status === "already_archived",
    };
  }

  function subagentLifecycleActionNextStep(
    action: SubagentLifecycleActionResponse["action"],
    workspaceCleanup: Record<string, unknown> | null,
    sessionArchive: Record<string, unknown> | null,
  ): string {
    const cleanupStatus = workspaceCleanup ? stringFromRecord(workspaceCleanup, "status") ?? "unknown" : null;
    const archiveStatus = sessionArchive ? stringFromRecord(sessionArchive, "status") ?? "unknown" : null;
    if (action === "cleanup") {
      if (cleanupStatus === "removed" || cleanupStatus === "deleted") return "Subagent workspace cleanup completed.";
      if (cleanupStatus === "retained") return "Subagent workspace retained for inspection.";
      if (cleanupStatus === "failed") return "Subagent workspace cleanup failed.";
      return "Subagent workspace cleanup recorded.";
    }
    if (action === "archive") {
      if (archiveStatus === "archived" || archiveStatus === "already_archived") return "Subagent child session archived.";
      if (archiveStatus === "failed") return "Subagent child session archive failed.";
      return "Subagent child session archive recorded.";
    }
    return `Subagent lifecycle action completed. Cleanup: ${cleanupStatus ?? "not_requested"}. Archive: ${archiveStatus ?? "not_requested"}.`;
  }

  function subagentArchiveOutput(run: SubagentRun, sessionArchive: Record<string, unknown>): string {
    const status = stringFromRecord(sessionArchive, "status") ?? "unknown";
    if (status === "archived") return `${run.roleId} child session archived.`;
    if (status === "already_archived") return `${run.roleId} child session was already archived.`;
    if (status === "failed") return `${run.roleId} child session archive failed.`;
    return `${run.roleId} child session archive ${status}.`;
  }

  function subagentRunTerminalForGoalLifecycle(run: SubagentRun): boolean {
    return run.status === "cancelled" ||
      run.status === "failed" ||
      run.status === "failed_with_artifacts" ||
      run.status === "superseded";
  }

  function subagentRunMayStillBeWorking(run: SubagentRun): boolean {
    return run.status === "queued" ||
      run.status === "running" ||
      run.status === "blocked" ||
      run.status === "submitted_for_review" ||
      run.status === "needs_revision" ||
      run.status === "needs_user_input" ||
      run.status === "needs_resume";
  }

  async function runHostedToolLoop(params: {
    session: Session;
    turn: Turn;
    turnPermissions: SubagentTurnPermissions;
    provider: ChatProvider;
    model: string;
    messages: HostedMessages;
    contextLimitTokens?: number | null;
    resourceEvents: RuntimeEvent[];
    mentionedApps: OpenPondApp[];
    connectedApps: ResolvedConnectedAppContext[];
    openPondActionCatalog: OpenPondActionCatalogEntry[];
    profileSkillRuntime: ProfileSkillRuntime;
    userPrompt: string;
    workspaceDiffBaseline: WorkspaceDiffSummary | null;
    signal: AbortSignal;
    stream: (
      messages: HostedMessages,
      options?: HostedToolLoopStreamOptions,
    ) => AsyncGenerator<HostedToolLoopDelta, void, unknown>;
  }): Promise<Session> {
    let session = params.session;
    const messages = [...params.messages];
    const contextLimitTokens =
      params.contextLimitTokens ?? trustedProviderContextLimit({ provider: params.provider, model: params.model });
    const invalidRequestCounts = new Map<string, number>();
    let workspaceToolResultCount = 0;
    let toolRequiredCorrectionSent = false;
    const nativeToolDefinitions = nativeToolsEnabledForProvider(params.provider)
      ? enabledModelToolDefinitions(createNativeModelToolDefinitions(
          params.openPondActionCatalog,
          params.resourceEvents,
        params.profileSkillRuntime,
        params.connectedApps,
        { disableWorkflowDelegationTools: isTerminalOneShotTurn(params.turn) },
      ), {
          session,
          provider: params.provider,
          model: params.model,
          mentionedApps: params.mentionedApps,
        })
      : [];
    const nativeTools = nativeToolDefinitions.map(modelToolDefinitionToHostedTool);
    const nativeToolDefinitionByName = new Map(nativeToolDefinitions.map((definition) => [definition.name, definition]));
    const textFallbackMode = hostedToolInstructionModeForProvider(hostedToolFlags, params.provider);
    const profileSkillMode = profileSkillInstructionModeForProvider(params.provider, params.profileSkillRuntime);
    const initialEventIds = new Set(params.resourceEvents.map((item) => item.id));
    const deliveredSubagentAsideKeys = new Set<string>();
    const subagentSteeringTracker = createSubagentToolLoopSteeringTracker(
      await subagentExplorationSteeringPolicyForSession(session),
    );
    async function appendContextUsage(input: {
      messages: HostedMessages;
      usage?: unknown;
      includeCompletion?: boolean;
    }): Promise<void> {
      if (!contextLimitTokens) return;
      await appendHostedContextUsage({
        session,
        turnId: params.turn.id,
        provider: params.provider,
        model: params.model,
        messages: input.messages,
        maxContextTokens: contextLimitTokens,
        usage: input.usage,
        includeCompletion: input.includeCompletion,
      });
    }
    async function appendPendingSubagentAsides(): Promise<boolean> {
      if (!subagentToolsAvailable()) return false;
      const snapshot = await store.snapshot();
      const asideMessages = subagentModelAsideMessages({
        session,
        events: snapshot.events,
        initialEventIds,
        deliveredKeys: deliveredSubagentAsideKeys,
      });
      if (asideMessages.length === 0) return false;
      for (const content of asideMessages) {
        messages.push({ role: "user", content });
      }
      return true;
    }
    for (let index = 0; index < maxHostedWorkspaceToolRounds; index += 1) {
      throwIfInterrupted(params.signal);
      await appendPendingSubagentAsides();
      await appendContextUsage({ messages });
      let assistantText = "";
      let reasoningText = "";
      let latestUsage: unknown;
      let finishReason: string | null | undefined;
      const nativeToolAccumulator = new NativeToolCallAccumulator();
      const usageRequestId = `${params.turn.id}:model:${index}`;
      const usageRecorder = await startProviderRequestUsageRecorder({
        session,
        turn: params.turn,
        provider: params.provider,
        model: params.model,
        requestId: usageRequestId,
        requestOrdinal: index,
        upsert: safeUpsertModelUsageRecord,
      });
      try {
        const toolChoice = hostedToolChoiceForLoop({
          connectedApps: params.connectedApps,
          nativeToolDefinitions: nativeToolDefinitionByName,
          roundIndex: index,
        });
        for await (const delta of params.stream(
          messages,
          nativeTools.length > 0 ? { tools: nativeTools, toolChoice } : undefined,
        )) {
          throwIfInterrupted(params.signal);
          usageRecorder.observeDelta(delta);
          if (delta.usage) latestUsage = delta.usage;
          if (delta.text) assistantText += delta.text;
          if (delta.reasoningText) reasoningText += delta.reasoningText;
          if (delta.toolCalls) nativeToolAccumulator.append(delta.toolCalls);
          if (delta.finishReason !== undefined) finishReason = delta.finishReason;
        }
      } catch (error) {
        await usageRecorder.fail(
          error,
          params.signal.aborted || (error instanceof Error && error.name === "AbortError")
            ? "interrupted"
            : "failed",
        );
        throw error;
      }
      await usageRecorder.complete();
      if (reasoningText) {
        await appendRuntimeEvent(
          event({
            sessionId: session.id,
            turnId: params.turn.id,
            name: "assistant.reasoning.delta",
            source: "provider",
            appId: session.appId,
            output: reasoningText,
          }),
        );
      }

      const nativeToolCalls = nativeToolAccumulator.completed();
      if (nativeToolCalls.length > 0) {
        messages.push(assistantMessageForNativeToolCalls(assistantText, nativeToolCalls));
        const nativeResults = await executeNativeToolCalls({
          session,
          turnId: params.turn.id,
          turnPermissions: params.turnPermissions,
          provider: params.provider,
          model: params.model,
          signal: params.signal,
          workspaceDiffBaseline: params.workspaceDiffBaseline,
          mentionedApps: params.mentionedApps,
          userPrompt: params.userPrompt,
          toolDefinitions: nativeToolDefinitionByName,
          invalidRequestCounts,
          toolCalls: nativeToolCalls,
        });
        workspaceToolResultCount += nativeResults.length;
        await applyNativeToolUsageAttribution(params.turn, nativeResults);
        for (const result of nativeResults) {
          messages.push(toolResultMessage(result));
        }
        for (const content of subagentToolLoopSteeringMessagesForNativeResults({
          session,
          toolCalls: nativeToolCalls,
          results: nativeResults,
          tracker: subagentSteeringTracker,
        })) {
          messages.push({ role: "user", content });
        }
        session = await getSession(session.id);
        await appendContextUsage({ messages, usage: latestUsage, includeCompletion: true });
        continue;
      }

      if (finishReason === "tool_calls") {
        await appendRuntimeEvent(
          event({
            sessionId: session.id,
            turnId: params.turn.id,
            name: "diagnostic",
            source: "server",
            appId: session.appId,
            status: "failed",
            output: "Provider finished with tool_calls but did not stream a complete native tool call.",
            data: { provider: params.provider, model: params.model },
          }),
        );
        messages.push({
          role: "user",
          content: [
            "The provider indicated a tool call, but no complete native tool call was received.",
            "Retry with one complete function call and valid JSON arguments, or answer normally if no tool is needed.",
          ].join(" "),
        });
        continue;
      }

      const assistantMessage = {
        role: "assistant" as const,
        content: assistantText.trim() || "Requesting workspace tool execution.",
      };
      const extractedRequests = textFallbackMode === "none" ? [] : extractWorkspaceToolRequests(assistantText);
      const skillReadRequests = profileSkillMode === "text_fallback"
        ? extractProfileSkillReadRequests(assistantText)
        : [];
      const deniedTextFallbackRequests = extractedRequests.filter(
        (request) => textFallbackMode === "resource_text_fallback" && !RESOURCE_TEXT_FALLBACK_ACTIONS.has(request.action),
      );
      const requests = extractedRequests.filter(
        (request) => textFallbackMode !== "resource_text_fallback" || RESOURCE_TEXT_FALLBACK_ACTIONS.has(request.action),
      );
      const deniedSubagentPolicyResults = deniedTextFallbackRequests
        .map((request) => {
          const blocker = subagentWorkspaceToolPolicyBlocker(session, request);
          return blocker
            ? formatWorkspaceToolResultForModel({
                ok: false,
                action: request.action,
                output: blocker,
                data: {
                  code: "subagent_tool_policy_blocked",
                  toolPolicy: "read_only",
                  subagentRunId: session.subagentRunId ?? null,
                  subagentRoleId: session.subagentRoleId ?? null,
                },
              })
            : null;
        })
        .filter((result): result is string => Boolean(result));
      if (skillReadRequests.length > 0) {
        messages.push(assistantMessage);
        await appendContextUsage({ messages, usage: latestUsage, includeCompletion: true });
        const skillResults: string[] = [];
        for (const request of skillReadRequests.slice(0, 3)) {
          throwIfInterrupted(params.signal);
          skillResults.push(await readProfileSkillForModel({
            session,
            turnId: params.turn.id,
            runtime: params.profileSkillRuntime,
            name: request.name,
            source: "provider",
          }));
        }
        messages.push({
          role: "user",
          content: [
            "Profile skill result:",
            skillResults.join("\n\n"),
            "Continue. Follow the loaded skill instructions when relevant. If another profile skill is required, respond with exactly one openpond_skill block. Otherwise answer the user normally without tool JSON.",
          ].join("\n\n"),
        });
        continue;
      }
      if (deniedSubagentPolicyResults.length > 0 && requests.length === 0) {
        messages.push(assistantMessage);
        await appendContextUsage({ messages, usage: latestUsage, includeCompletion: true });
        messages.push({
          role: "user",
          content: [
            "Workspace tool result:",
            deniedSubagentPolicyResults.join("\n\n"),
            "Continue without mutating the workspace. If the assignment requires writes, report the isolation blocker.",
          ].join("\n\n"),
        });
        continue;
      }
      if (deniedTextFallbackRequests.length > 0 && requests.length === 0) {
        messages.push(assistantMessage);
        await appendContextUsage({ messages, usage: latestUsage, includeCompletion: true });
        messages.push({
          role: "user",
          content: [
            "That text fallback tool action is not available in this mode.",
            `Unavailable action${deniedTextFallbackRequests.length === 1 ? "" : "s"}: ${deniedTextFallbackRequests
              .map((request) => request.action)
              .join(", ")}.`,
            "Use native tool calls when available. If text fallback is necessary, only use resource_search or resource_read.",
          ].join(" "),
        });
        continue;
      }
      if (requests.length === 0) {
        messages.push(assistantMessage);
        if (await appendPendingSubagentAsides()) {
          await appendContextUsage({ messages, usage: latestUsage, includeCompletion: true });
          continue;
        }
        if (
          workspaceToolResultCount === 0 &&
          !toolRequiredCorrectionSent &&
          requiresWorkspaceToolForPrompt(session, params.userPrompt)
        ) {
          await appendContextUsage({ messages, usage: latestUsage, includeCompletion: true });
          messages.push({
            role: "user",
            content: workspaceToolCorrectionMessage(textFallbackMode, nativeTools.length > 0),
          });
          toolRequiredCorrectionSent = true;
          continue;
        }
        await appendAssistantText(session, params.turn.id, assistantText);
        await appendContextUsage({
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
        return session;
      }

      messages.push(assistantMessage);
      await appendContextUsage({ messages, usage: latestUsage, includeCompletion: true });

      const toolResults: string[] = [];
      const subagentSteeringMessages: string[] = [];
      for (const request of requests) {
        throwIfInterrupted(params.signal);
        const toolRequest = normalizeMentionedSandboxToolRequest({
          request: {
            ...request,
            source: "chat_action" as const,
          },
          mentionedApps: params.mentionedApps,
          userPrompt: params.userPrompt,
        });
        const validationIssues = validateWorkspaceToolRequest(toolRequest);
        const policyBlocker = subagentWorkspaceToolPolicyBlocker(session, toolRequest);
        if (policyBlocker) {
          toolResults.push(formatWorkspaceToolResultForModel({
            ok: false,
            action: toolRequest.action,
            output: policyBlocker,
            data: {
              code: "subagent_tool_policy_blocked",
              toolPolicy: "read_only",
              subagentRunId: session.subagentRunId ?? null,
              subagentRoleId: session.subagentRoleId ?? null,
            },
          }));
          continue;
        }
        if (validationIssues.length > 0) {
          const key = `${toolRequest.action}:${validationIssues.map((issue) => `${issue.path}:${issue.expected}`).join("|")}`;
          const count = (invalidRequestCounts.get(key) ?? 0) + 1;
          invalidRequestCounts.set(key, count);
          if (count >= maxRepeatedInvalidToolRequests) {
            throw new Error(
              `Hosted workspace tool produced repeated invalid ${toolRequest.action} requests: ${validationIssues
                .map((issue) => `${issue.path} expected ${issue.expected}`)
                .join("; ")}`
            );
          }
          toolResults.push(formatWorkspaceToolValidationErrorForModel(toolRequest, validationIssues));
          continue;
        }
        const result = await executeWorkspaceTool(
          session.id,
          toolRequest,
          { turnId: params.turn.id, workspaceDiffBaseline: params.workspaceDiffBaseline }
        );
        workspaceToolResultCount += 1;
        session = await getSession(session.id);
        toolResults.push(formatWorkspaceToolResultForModel(result));
        subagentSteeringMessages.push(...subagentToolLoopSteeringMessagesForWorkspaceResult({
          session,
          request: toolRequest,
          result,
          tracker: subagentSteeringTracker,
        }));
      }

      messages.push({
        role: "user",
        content: [
          "Workspace tool result:",
          toolResults.join("\n\n"),
          ...subagentSteeringMessages,
          "Continue. If another workspace action is required, respond with exactly one openpond_tool block. Otherwise answer the user normally without tool JSON.",
        ].join("\n\n"),
      });
    }

    const limitLabel = Number.isFinite(maxHostedWorkspaceToolRounds)
      ? `${maxHostedWorkspaceToolRounds}`
      : "configured";
    await appendAssistantText(
      session,
      params.turn.id,
      [
        `I hit the hosted workspace tool iteration limit (${limitLabel}) before I could finish.`,
        "Please send the request again or narrow the workspace target so I can continue from the current context.",
      ].join(" ")
    );
    return session;
  }

  function subagentModelAsideMessages(input: {
    session: Session;
    events: RuntimeEvent[];
    initialEventIds: Set<string>;
    deliveredKeys: Set<string>;
  }): string[] {
    const messages: string[] = [];
    for (const item of input.events) {
      const key = subagentAsideEventKey(item);
      if (input.deliveredKeys.has(key)) continue;
      const content = input.session.subagentRunId
        ? childSubagentMailboxAside(input.session, item)
        : parentSubagentReceiptAside({
            session: input.session,
            event: item,
            initialEventIds: input.initialEventIds,
          });
      if (!content) continue;
      input.deliveredKeys.add(key);
      messages.push(content);
    }
    return messages;
  }

  function parentSubagentReceiptAside(input: {
    session: Session;
    event: RuntimeEvent;
    initialEventIds: Set<string>;
  }): string | null {
    const item = input.event;
    if (item.sessionId !== input.session.id) return null;
    if (input.initialEventIds.has(item.id)) return null;
    if (!PARENT_MODEL_VISIBLE_SUBAGENT_EVENTS.has(item.name)) return null;
    if (item.name === "subagent.message") return parentSubagentMessageAside(input.session, item);
    const run = subagentRunFromRuntimeEvent(item);
    if (!run || run.parentSessionId !== input.session.id) return null;
    const report = run.report;
    const details = [
      "Subagent update:",
      `event: ${item.name}`,
      `run: ${run.id}`,
      `role: ${run.roleId}`,
      `status: ${run.status}`,
      run.childSessionId ? `child session: ${run.childSessionId}` : null,
      item.output ? `receipt: ${item.output}` : null,
      report?.summary ? `summary: ${truncateForModelAside(report.summary, 1200)}` : null,
      report?.blockers.length ? `blockers: ${report.blockers.slice(0, 4).join(" | ")}` : null,
      report?.testsRun.length ? `tests: ${report.testsRun.slice(0, 4).join(" | ")}` : null,
      report?.patchRef ? `patch: ${report.patchRef.kind}:${report.patchRef.id} (${report.patchRef.label})` : null,
      report?.diffRef ? `diff: ${report.diffRef.kind}:${report.diffRef.id} (${report.diffRef.label})` : null,
      "Use this pushed receipt. Do not poll unless you need a fresh diagnostic snapshot.",
    ].filter(Boolean);
    return details.join("\n");
  }

  function parentSubagentMessageAside(session: Session, item: RuntimeEvent): string | null {
    const data = recordFromUnknown(item.data);
    const parsed = SubagentMessageSchema.safeParse(data?.message);
    if (!parsed.success) return null;
    const message = parsed.data;
    const delivery = SubagentMessageDeliverySchema.safeParse(data?.delivery ?? message.delivery).success
      ? SubagentMessageDeliverySchema.parse(data?.delivery ?? message.delivery)
      : null;
    if (delivery?.deliveredParentSessionId !== session.id) return null;
    return [
      "Subagent handoff:",
      `message: ${message.id}`,
      `kind: ${message.kind}`,
      `from: ${message.fromRunId}`,
      message.parentGoalId ? `goal: ${message.parentGoalId}` : null,
      `body: ${truncateForModelAside(message.body, 2000)}`,
      message.refs.length
        ? `refs: ${message.refs.slice(0, 8).map((ref) => `${ref.kind}:${ref.id} (${ref.label})`).join(", ")}`
        : null,
      "Treat this as an active handoff from a child agent. Decide whether to respond, message the child back, route work, join/cancel, update the goal, or continue without action.",
    ].filter(Boolean).join("\n");
  }

  function childSubagentMailboxAside(session: Session, item: RuntimeEvent): string | null {
    if (item.sessionId !== session.id || item.name !== "subagent.message") return null;
    const data = recordFromUnknown(item.data);
    const parsed = SubagentMessageSchema.safeParse(data?.message);
    if (!parsed.success) return null;
    const message = parsed.data;
    const deliveredToRunId = typeof data?.deliveredToRunId === "string" ? data.deliveredToRunId : null;
    if (deliveredToRunId && session.subagentRunId && deliveredToRunId !== session.subagentRunId) return null;
    const priority = message.priority ?? "normal";
    return [
      `Subagent mailbox ${priority === "interrupt" ? "interrupt" : "update"}:`,
      `message: ${message.id}`,
      `kind: ${message.kind}`,
      `from: ${message.fromRunId}`,
      message.toRunId ? `to run: ${message.toRunId}` : null,
      message.toRole ? `to role: ${message.toRole}` : null,
      `body: ${truncateForModelAside(message.body, 2000)}`,
      message.refs.length
        ? `refs: ${message.refs.slice(0, 8).map((ref) => `${ref.kind}:${ref.id} (${ref.label})`).join(", ")}`
        : null,
      priority === "interrupt"
        ? "Treat this as high-priority steering at this safe model boundary."
        : "Use this message as goal-scoped coordination context.",
    ].filter(Boolean).join("\n");
  }

  function subagentRunFromRuntimeEvent(item: RuntimeEvent): SubagentRun | null {
    const data = recordFromUnknown(item.data);
    const parsed = SubagentRunSchema.safeParse(data?.run);
    return parsed.success ? parsed.data : null;
  }

  function subagentAsideEventKey(item: RuntimeEvent): string {
    return typeof item.sequence === "number" ? `seq:${item.sequence}` : `id:${item.id}`;
  }

  function truncateForModelAside(value: string, maxLength: number): string {
    const trimmed = value.trim();
    if (trimmed.length <= maxLength) return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
  }

  function subagentWorkspaceToolPolicyBlocker(session: Session, request: WorkspaceToolRequest): string | null {
    const policy = subagentToolPolicyForSession(session);
    if (policy !== "read_only") return null;
    if (READ_ONLY_SUBAGENT_WORKSPACE_TOOL_ACTIONS.has(request.action)) return null;
    return [
      `Workspace action ${request.action} is blocked by the read_only subagent tool policy.`,
      "Use read/search/status/diff tools only, or report that this child assignment needs a write-capable isolated workspace.",
    ].join(" ");
  }

  function subagentToolPolicyForSession(session: Session): SubagentRoleSettings["toolPolicy"] | null {
    if (!session.subagentRunId) return null;
    const subagent = recordFromUnknown(recordFromUnknown(session.metadata)?.subagent);
    const toolPolicy = typeof subagent?.toolPolicy === "string" ? subagent.toolPolicy : null;
    if (toolPolicy === "read_only" || toolPolicy === "workspace_write" || toolPolicy === "full_tools") return toolPolicy;
    return "read_only";
  }

  function recordFromUnknown(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  function hostedToolChoiceForLoop(input: {
    connectedApps: ResolvedConnectedAppContext[];
    nativeToolDefinitions: Map<string, ModelToolDefinition>;
    roundIndex: number;
  }): HostedChatToolChoice {
    if (
      input.roundIndex === 0 &&
      input.connectedApps.length > 0 &&
      input.nativeToolDefinitions.has("connected_app_skill_read")
    ) {
      return { type: "function", function: { name: "connected_app_skill_read" } };
    }
    return "auto";
  }

  function workspaceToolCorrectionMessage(
    textFallbackMode: HostedToolInstructionMode,
    nativeToolsAvailable: boolean,
  ): string {
    const toolCallInstruction = nativeToolsAvailable
      ? "Call an appropriate native tool now."
      : textFallbackMode === "resource_text_fallback"
        ? "Call a resource_search or resource_read openpond_tool block now."
        : textFallbackMode === "full_text_fallback"
          ? "Call the appropriate openpond_tool block now."
          : "Explain the blocker instead of claiming the workspace changed.";
    return [
      "Your previous response did not call a workspace tool.",
      "The user's request appears to require inspecting or changing the active workspace.",
      toolCallInstruction,
      "Do not claim the workspace changed until a tool result confirms it.",
      "If the request cannot be completed with the available workspace tools, explain the blocker instead of saying it is done.",
    ].join(" ");
  }

  async function executeNativeToolCalls(params: {
    session: Session;
    turnId: string;
    turnPermissions: SubagentTurnPermissions;
    provider: ChatProvider;
    model: string;
    signal: AbortSignal;
    workspaceDiffBaseline: WorkspaceDiffSummary | null;
    mentionedApps: OpenPondApp[];
    userPrompt: string;
    toolDefinitions: Map<string, ModelToolDefinition>;
    invalidRequestCounts: Map<string, number>;
    toolCalls: NativeModelToolCall[];
  }): Promise<NativeModelToolResult[]> {
    const results: NativeModelToolResult[] = [];
    for (const toolCall of params.toolCalls) {
      throwIfInterrupted(params.signal);
      const definition = params.toolDefinitions.get(toolCall.name);
      if (!definition) {
        const result = unknownNativeToolResult(toolCall);
        await appendNativeToolStarted(params.session, params.turnId, toolCall, {});
        await appendNativeToolCompleted(params.session, params.turnId, result);
        results.push(result);
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = parseNativeToolArguments(toolCall);
      } catch (error) {
        const message = textFromUnknown(error) || "Invalid JSON.";
        const key = `${toolCall.name}:native_json:${toolCall.argumentsJson}`;
        const count = (params.invalidRequestCounts.get(key) ?? 0) + 1;
        params.invalidRequestCounts.set(key, count);
        if (count >= maxRepeatedInvalidToolRequests) {
          throw new Error(`Hosted native tool produced repeated invalid ${toolCall.name} arguments: ${message}`);
        }
        const result = invalidNativeToolArgumentsResult(toolCall, message);
        await appendNativeToolStarted(
          params.session,
          params.turnId,
          toolCall,
          nativeToolInvalidArgumentsEventArgs(toolCall.name, toolCall.argumentsJson),
        );
        await appendNativeToolCompleted(params.session, params.turnId, result);
        results.push(result);
        continue;
      }

      const profileSkillName = toolCall.name === "profile_skill_read" ? stringFromRecord(args, "name") : null;
      const connectedAppSkillProvider = toolCall.name === "connected_app_skill_read" ? stringFromRecord(args, "provider") : null;
      if (profileSkillName) {
        await appendProfileSkillEvent({
          session: params.session,
          turnId: params.turnId,
          eventName: "skill.selected",
          status: "completed",
          output: `Selected profile skill ${profileSkillName}.`,
          skillName: profileSkillName,
          source: "provider",
        });
      }
      if (connectedAppSkillProvider) {
        await appendConnectedAppSkillEvent({
          session: params.session,
          turnId: params.turnId,
          eventName: "skill.selected",
          status: "completed",
          output: `Selected connected app instructions for ${connectedAppSkillProvider}.`,
          provider: connectedAppSkillProvider,
          source: "provider",
        });
      }

      await appendNativeToolStarted(
        params.session,
        params.turnId,
        toolCall,
        nativeToolEventArgs(toolCall.name, args),
      );
      try {
        const result = await definition.execute({
          session: params.session,
          turnId: params.turnId,
          turnPermissions: params.turnPermissions,
          provider: params.provider,
          model: params.model,
          callId: toolCall.id,
          args,
          signal: params.signal,
          workspaceDiffBaseline: params.workspaceDiffBaseline,
          mentionedApps: params.mentionedApps,
          userPrompt: params.userPrompt,
        });
        await appendNativeToolCompleted(params.session, params.turnId, result);
        if (profileSkillName) {
          const skill = profileSkillFromNativeResult(result);
          await appendProfileSkillEvent({
            session: params.session,
            turnId: params.turnId,
            eventName: result.ok ? "skill.loaded" : "skill.load_failed",
            status: result.ok ? "completed" : "failed",
            output: result.ok
              ? `Loaded profile skill ${profileSkillName}.`
              : result.contentText,
            skillName: profileSkillName,
            skill,
            source: "provider",
          });
        }
        if (connectedAppSkillProvider) {
          const skill = connectedAppSkillFromNativeResult(result);
          await appendConnectedAppSkillEvent({
            session: params.session,
            turnId: params.turnId,
            eventName: result.ok ? "skill.loaded" : "skill.load_failed",
            status: result.ok ? "completed" : "failed",
            output: result.ok
              ? `Loaded connected app instructions for ${connectedAppSkillProvider}.`
              : result.contentText,
            provider: connectedAppSkillProvider,
            skill,
            source: "provider",
          });
        }
        results.push(result);
      } catch (error) {
        const result = failedNativeToolResult(toolCall, textFromUnknown(error) || "Tool execution failed.");
        await appendNativeToolCompleted(params.session, params.turnId, result);
        if (profileSkillName) {
          await appendProfileSkillEvent({
            session: params.session,
            turnId: params.turnId,
            eventName: "skill.load_failed",
            status: "failed",
            output: result.contentText,
            skillName: profileSkillName,
            source: "provider",
          });
        }
        if (connectedAppSkillProvider) {
          await appendConnectedAppSkillEvent({
            session: params.session,
            turnId: params.turnId,
            eventName: "skill.load_failed",
            status: "failed",
            output: result.contentText,
            provider: connectedAppSkillProvider,
            source: "provider",
          });
        }
        results.push(result);
      }
    }
    return results;
  }

  async function applyNativeToolUsageAttribution(
    turn: Turn,
    results: NativeModelToolResult[],
  ): Promise<void> {
    const attribution = profileSkillGoalUsageAttribution(results);
    if (!attribution) return;
    const metadata = {
      ...(turn.metadata ?? {}),
      usageAttribution: attribution.usageAttribution,
      threadGoal: {
        ...threadGoalRecord(turn.metadata?.threadGoal),
        ...attribution.threadGoal,
      },
    };
    turn.metadata = metadata;
    const updated = await updateStoredTurn(turn.id, (current) => ({
      ...current,
      metadata: {
        ...(current.metadata ?? {}),
        ...metadata,
      },
    }));
    if (updated) Object.assign(turn, updated);
  }

  function profileSkillGoalUsageAttribution(
    results: NativeModelToolResult[],
  ): {
    usageAttribution: UsageRequestAttribution;
    threadGoal: Record<string, unknown>;
  } | null {
    for (const result of results) {
      if (!result.ok || result.name !== "openpond_profile_skill_goal") continue;
      if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) continue;
      const data = result.data as Record<string, unknown>;
      const goalId = stringFromRecord(data, "goalId");
      if (!goalId) continue;
      const operation = stringFromRecord(data, "operation");
      const targetSkillName = stringFromRecord(data, "targetSkillName");
      const targetSkillPath = stringFromRecord(data, "targetSkillPath");
      const status = stringFromRecord(data, "status");
      return {
        usageAttribution: {
          surface: "goal",
          workflowKind: "goal_control",
          goalId,
          commandName: "/skill",
          commandSource: "model_tool",
        },
        threadGoal: {
          id: goalId,
          provider: "openpond",
          kind: operation === "edit" ? "profile_skill_edit" : "profile_skill_create",
          source: "native_model_tool",
          ...(operation ? { operation } : {}),
          ...(targetSkillName ? { targetSkillName } : {}),
          ...(targetSkillPath ? { targetSkillPath } : {}),
          ...(status ? { status } : {}),
        },
      };
    }
    return null;
  }

  function threadGoalRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  async function readProfileSkillForModel(input: {
    session: Session;
    turnId: string;
    runtime: ProfileSkillRuntime;
    name: string;
    source: "provider" | "server";
  }): Promise<string> {
    const name = input.name.trim();
    await appendProfileSkillEvent({
      session: input.session,
      turnId: input.turnId,
      eventName: "skill.selected",
      status: "completed",
      output: `Selected profile skill ${name}.`,
      skillName: name,
      source: input.source,
    });
    if (!input.runtime.readSkill) {
      const message = "Profile skill reading is not configured for this turn.";
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.load_failed",
        status: "failed",
        output: message,
        skillName: name,
        source: input.source,
      });
      return profileSkillModelResult({ ok: false, name, output: message });
    }
    if (!input.runtime.skills.some((skill) => skill.name === name)) {
      const message = `Profile skill ${name} is not in the active enabled skill catalog.`;
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.load_failed",
        status: "failed",
        output: message,
        skillName: name,
        source: input.source,
      });
      return profileSkillModelResult({ ok: false, name, output: message });
    }
    try {
      const skill = await input.runtime.readSkill(name);
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.loaded",
        status: "completed",
        output: `Loaded profile skill ${name}.`,
        skillName: name,
        skill,
        source: input.source,
      });
      return profileSkillModelResult({
        ok: true,
        name,
        output: `Loaded profile skill ${name}.`,
        skill,
      });
    } catch (error) {
      const message = textFromUnknown(error) || `Failed to load profile skill ${name}.`;
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.load_failed",
        status: "failed",
        output: message,
        skillName: name,
        source: input.source,
      });
      return profileSkillModelResult({ ok: false, name, output: message });
    }
  }

  function profileSkillModelResult(input: {
    ok: boolean;
    name: string;
    output: string;
    skill?: ProfileSkillReadResult;
  }): string {
    return JSON.stringify(
      {
        ok: input.ok,
        action: "profile_skill_read",
        output: input.output,
        data: input.skill ? { skill: input.skill } : { name: input.name },
      },
      null,
      2,
    );
  }

  async function appendProfileSkillEvent(input: {
    session: Session;
    turnId: string;
    eventName: "skill.selected" | "skill.loaded" | "skill.load_failed";
    status: "completed" | "failed";
    output: string;
    skillName: string;
    skill?: ProfileSkillReadResult | HostedProfileSkillBody | null;
    source: "provider" | "server";
  }): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: input.eventName,
        source: input.source,
        action: "profile_skill_read",
        appId: input.session.appId,
        status: input.status,
        output: input.output,
        error: input.status === "failed" ? input.output : undefined,
        data: {
          skillName: input.skillName,
          type: "profile_skill",
          ...(input.skill
            ? {
                path: input.skill.path,
                sourceHash: input.skill.sourceHash,
              }
            : {}),
        },
      }),
    );
  }

  async function appendConnectedAppSkillEvent(input: {
    session: Session;
    turnId: string;
    eventName: "skill.selected" | "skill.loaded" | "skill.load_failed";
    status: "completed" | "failed";
    output: string;
    provider: string;
    skill?: ConnectedAppIntegrationSkill | null;
    source: "provider" | "server";
  }): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: input.eventName,
        source: input.source,
        action: "connected_app_skill_read",
        appId: input.session.appId,
        status: input.status,
        output: input.output,
        error: input.status === "failed" ? input.output : undefined,
        data: {
          provider: input.provider,
          skillName: input.skill?.name ?? `${input.provider}-connected-app`,
          type: "connected_app_skill",
          ...(input.skill
            ? {
                path: input.skill.path,
                sourceHash: input.skill.sourceHash,
              }
            : {}),
        },
      }),
    );
  }

  function explicitProfileSkillNames(prompt: string): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const match of prompt.matchAll(/\$([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g)) {
      const name = match[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return names;
  }

  function profileSkillBodyFromReadResult(skill: ProfileSkillReadResult): HostedProfileSkillBody {
    return {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      path: skill.path,
      sourceHash: skill.sourceHash,
    };
  }

  function profileSkillFromNativeResult(result: NativeModelToolResult): ProfileSkillReadResult | null {
    const data = result.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const skill = (data as Record<string, unknown>).skill;
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
    const record = skill as Record<string, unknown>;
    const name = stringFromRecord(record, "name");
    const description = stringFromRecord(record, "description");
    const body = stringFromRecord(record, "body");
    const path = stringFromRecord(record, "path");
    const sourceHash = stringFromRecord(record, "sourceHash");
    const charCount = typeof record.charCount === "number" ? record.charCount : null;
    if (!name || !description || !body || !path || !sourceHash || charCount === null) return null;
    return { name, description, body, path, sourceHash, charCount };
  }

  function connectedAppSkillFromNativeResult(result: NativeModelToolResult): ConnectedAppIntegrationSkill | null {
    const data = result.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const skill = (data as Record<string, unknown>).skill;
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
    const record = skill as Record<string, unknown>;
    const name = stringFromRecord(record, "name");
    const description = stringFromRecord(record, "description");
    const body = stringFromRecord(record, "body");
    const path = stringFromRecord(record, "path");
    const sourceHash = stringFromRecord(record, "sourceHash");
    const provider = stringFromRecord(record, "provider");
    const charCount = typeof record.charCount === "number" ? record.charCount : null;
    if (!name || !description || !body || !path || !sourceHash || !provider || charCount === null) return null;
    return {
      name,
      description,
      body,
      path,
      sourceHash,
      provider: provider as ConnectedAppIntegrationSkill["provider"],
      charCount,
    };
  }

  function stringFromRecord(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function numberFromRecord(record: Record<string, unknown>, key: string): number | null {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function booleanFromRecord(record: Record<string, unknown>, key: string): boolean | null {
    const value = record[key];
    return typeof value === "boolean" ? value : null;
  }

  function nativeToolEventArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const browserArgs = redactBrowserToolArguments(toolName, args);
    if (browserArgs !== args) return browserArgs;
    return redactConnectedAppToolArguments(toolName, args);
  }

  function nativeToolInvalidArgumentsEventArgs(toolName: string, argumentsJson: string): Record<string, unknown> {
    if (!isConnectedAppProviderToolName(toolName)) return { argumentsJson };
    return { argumentsJson: "[redacted invalid connected app tool arguments]" };
  }

  async function appendNativeToolStarted(
    session: Session,
    turnId: string,
    toolCall: NativeModelToolCall,
    args: Record<string, unknown>,
  ): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "tool.started",
        source: "provider",
        action: toolCall.name,
        appId: session.appId,
        args,
        status: "started",
        data: {
          toolCallId: toolCall.id,
          tool: toolCall.name,
          type: "native_model_tool",
        },
      }),
    );
  }

  async function appendNativeToolCompleted(
    session: Session,
    turnId: string,
    result: NativeModelToolResult,
  ): Promise<void> {
    const resourceRefs = nativeToolResultResourceRefs(result);
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "tool.completed",
        source: "provider",
        action: result.name,
        appId: session.appId,
        status: result.ok ? "completed" : "failed",
        output: result.contentText,
        error: result.ok ? undefined : result.contentText,
        data: {
          toolCallId: result.toolCallId,
          tool: result.name,
          type: "native_model_tool",
          ...(resourceRefs.length > 0 ? { resourceRefs } : {}),
          result: result.data,
        },
      }),
    );
  }

  function nativeToolResultResourceRefs(result: NativeModelToolResult): string[] {
    const refs = new Set<string>();
    collectNativeToolResourceRefs(result.data, refs);
    return [...refs].slice(0, 50);
  }

  function collectNativeToolResourceRefs(value: unknown, refs: Set<string>): void {
    if (!value) return;
    if (typeof value === "string") {
      if (/^(workspace:(?:file|dir):|sandbox:(?:file|dir):|git:|event:|message:|artifact:|goal-context:)/.test(value)) {
        refs.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectNativeToolResourceRefs(item, refs);
      return;
    }
    if (typeof value !== "object") return;
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectNativeToolResourceRefs(child, refs);
    }
  }

  function failedNativeToolResult(toolCall: NativeModelToolCall, message: string): NativeModelToolResult {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      ok: false,
      contentText: JSON.stringify(
        {
          ok: false,
          action: toolCall.name,
          output: message,
        },
        null,
        2,
      ),
    };
  }

  async function maybeAutoCompactHostedContext(params: {
    session: Session;
    turn: Turn;
    provider: HostedCompactionProvider;
    model: string;
    maxContextTokens?: number | null;
    priorEvents: RuntimeEvent[];
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
    streamCompactionChatTurn?: (input: {
      provider: ChatProvider;
      model: string;
      messages: HostedMessages;
      requestId: string;
      signal?: AbortSignal;
    }) => AsyncGenerator<ContextCompactionStreamDelta, void, unknown>;
  }): Promise<RuntimeEvent[]> {
    throwIfInterrupted(params.signal);
    const preferences = await loadAppPreferences();
    if (!preferences.contextCompaction.autoEnabled) return params.priorEvents;
    const adapter = resolveContextCompactionAdapter(params.provider);
    if (adapter.kind !== "app_summary") return params.priorEvents;
    const projectedMessages = buildChatMessagesForProvider(params.priorEvents, params.prompt, params.systemPrompt);
    const decision = hostedAutoCompactionDecision({
      provider: params.provider,
      model: params.model,
      messages: projectedMessages,
      maxContextTokens: params.maxContextTokens,
      triggerPercent: preferences.contextCompaction.triggerPercent,
    });
    if (!decision.shouldCompact || params.priorEvents.length === 0) return params.priorEvents;

    const startedEvent = event({
      sessionId: params.session.id,
      turnId: params.turn.id,
      name: "session.compaction.started",
      source: "server",
      appId: params.session.appId,
      status: "started",
      output: "Auto compacting conversation context",
      data: {
        version: 1,
        provider: params.provider,
        model: params.model,
        reason: "auto",
        projectedTokens: decision.projectedTokens,
        thresholdTokens: decision.thresholdTokens,
        usableContextTokens: decision.usableContextTokens,
        maxContextTokens: decision.maxContextTokens,
        tokenSource: decision.tokenSource,
      },
    });
    await appendRuntimeEvent(startedEvent);

    try {
      const result = await runRecordedHostedContextCompaction({
        session: params.session,
        turn: params.turn,
        events: params.priorEvents,
        provider: params.provider,
        model: params.model,
        maxContextTokens: params.maxContextTokens,
        signal: params.signal,
        streamCompactionChatTurn: params.streamCompactionChatTurn,
      });
      throwIfInterrupted(params.signal);
      const completedEvent = event({
        sessionId: params.session.id,
        turnId: params.turn.id,
        name: "session.compaction.completed",
        source: "server",
        appId: params.session.appId,
        status: "completed",
        output: "Auto compacted conversation context",
        data: {
          version: 1,
          provider: params.provider,
          model: result.model,
          reason: "auto",
          mode: "summary",
          summary: result.summary,
          compactedThroughEventId: result.compactedThroughEventId,
          compactedThroughTurnId: result.compactedThroughTurnId,
          preservedFromEventId: result.preservedFromEventId,
          preservedEventIds: result.preservedEventIds,
          preservedResourceRefs: result.preservedResourceRefs,
          sourceEventCount: result.sourceEventCount,
          preservedEventCount: result.preservedEventCount,
          fileLedger: result.fileLedger,
          inputTokensBefore: result.inputTokensBefore,
          inputTokensAfter: result.inputTokensAfter,
          maxContextTokens: result.maxContextTokens,
          tokenSource: result.tokenSource,
          metrics: result.metrics,
          projectedTokens: decision.projectedTokens,
          thresholdTokens: decision.thresholdTokens,
          usableContextTokens: decision.usableContextTokens,
        },
      });
      await appendRuntimeEvent(completedEvent);
      return [...params.priorEvents, startedEvent, completedEvent];
    } catch (error) {
      if (params.signal.aborted) throw interruptedError();
      const message = error instanceof Error ? error.message : String(error);
      const failedEvent = event({
        sessionId: params.session.id,
        turnId: params.turn.id,
        name: "session.compaction.failed",
        source: "server",
        appId: params.session.appId,
        status: "failed",
        output: "Auto context compaction failed",
        error: message,
        data: {
          version: 1,
          provider: params.provider,
          model: params.model,
          reason: "auto",
          error: message,
          projectedTokens: decision.projectedTokens,
          thresholdTokens: decision.thresholdTokens,
          usableContextTokens: decision.usableContextTokens,
          maxContextTokens: decision.maxContextTokens,
          tokenSource: decision.tokenSource,
        },
      });
      await appendRuntimeEvent(failedEvent);
      return [...params.priorEvents, startedEvent, failedEvent];
    }
  }

  async function throwIfAutoCompactionOffWouldExceedLimit(input: {
    provider: ChatProvider;
    model: string;
    messages: HostedMessages;
    maxContextTokens?: number | null;
  }): Promise<void> {
    const preferences = await loadAppPreferences();
    if (preferences.contextCompaction.autoEnabled) return;
    const maxContextTokens =
      input.maxContextTokens ?? trustedProviderContextLimit({ provider: input.provider, model: input.model });
    if (!maxContextTokens) return;
    const projectedTokens = estimateHostedMessageTokens(input.messages);
    if (projectedTokens < maxContextTokens) return;
    throw new Error(
      [
        `This chat is at the context limit for ${input.provider}/${input.model}.`,
        "Start a new chat or turn auto compaction on to continue.",
      ].join(" "),
    );
  }

  async function runRecordedHostedContextCompaction(input: {
    session: Session;
    turn: Turn;
    events: RuntimeEvent[];
    provider: HostedCompactionProvider;
    model: string;
    maxContextTokens?: number | null;
    signal: AbortSignal;
    streamCompactionChatTurn?: (input: {
      provider: ChatProvider;
      model: string;
      messages: HostedMessages;
      requestId: string;
      signal?: AbortSignal;
    }) => AsyncGenerator<ContextCompactionStreamDelta, void, unknown>;
  }): Promise<HostedCompactionResult> {
    const usageState: {
      recorder: Awaited<ReturnType<typeof startProviderRequestUsageRecorder>> | null;
      finalized: boolean;
    } = { recorder: null, finalized: false };
    const requestId = `${input.turn.id}:context-compaction:0`;

    async function failUsageRecorder(error: unknown): Promise<void> {
      if (!usageState.recorder || usageState.finalized) return;
      usageState.finalized = true;
      await usageState.recorder.fail(
        error,
        input.signal.aborted || (error instanceof Error && error.name === "AbortError")
          ? "interrupted"
          : "failed",
      );
    }

    try {
      const streamCompactionChatTurn =
        input.streamCompactionChatTurn ??
        async function* (streamInput: {
          provider: ChatProvider;
          model: string;
          messages: HostedMessages;
          requestId: string;
          signal?: AbortSignal;
        }): AsyncGenerator<ContextCompactionStreamDelta, void, unknown> {
          if (streamInput.provider !== "openpond") {
            throw new Error(`Context compaction stream is not configured for ${streamInput.provider}.`);
          }
          for await (const delta of streamOpenPondHostedChatTurn({
            model: streamInput.model,
            messages: streamInput.messages,
            requestId: streamInput.requestId,
            signal: streamInput.signal,
          })) {
            if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
            if (delta.type === "reasoning_delta" && delta.text) yield { reasoningText: delta.text, raw: delta.raw };
            if (delta.type === "usage") yield { usage: delta.usage, raw: delta.raw };
          }
        };
      const result = await runHostedContextCompaction({
        session: input.session,
        events: input.events,
        provider: input.provider,
        model: input.model,
        maxContextTokens: input.maxContextTokens,
        signal: input.signal,
        streamCompactionChatTurn: async function* (streamInput) {
          usageState.recorder = await startProviderRequestUsageRecorder({
            session: input.session,
            turn: input.turn,
            provider: input.provider,
            model: streamInput.model ?? input.model,
            requestId,
            requestOrdinal: 0,
            requestKind: "context_compaction",
            upsert: safeUpsertModelUsageRecord,
          });
          try {
            for await (const delta of streamCompactionChatTurn(streamInput)) {
              if (delta.text) usageState.recorder.observeDelta({ text: delta.text });
              if (delta.reasoningText) usageState.recorder.observeDelta({ reasoningText: delta.reasoningText });
              if (delta.usage) usageState.recorder.observeDelta({ usage: delta.usage });
              yield delta;
            }
          } catch (error) {
            await failUsageRecorder(error);
            throw error;
          }
        },
      });
      if (usageState.recorder && !usageState.finalized) {
        usageState.finalized = true;
        await usageState.recorder.complete();
      }
      return result;
    } catch (error) {
      await failUsageRecorder(error);
      throw error;
    }
  }

  async function interruptActiveTurn(active: ActiveTurn, reason: string): Promise<Turn> {
    active.controller.abort();
    if (active.codexRuntime && active.codexTurnId) {
      try {
        await active.codexRuntime.client.interruptTurn({
          threadId: active.codexRuntime.threadId,
          turnId: active.codexTurnId,
        });
      } catch {
        await active.codexRuntime.client.stop().catch(() => undefined);
      }
    }
    return interruptTurn(active.session, active.turn.id, reason);
  }

  async function interruptSessionTurn(sessionId: string, reason = "Stopped by user"): Promise<Turn> {
    const active = activeTurns.get(sessionId);
    const session = active?.session ?? (await getSession(sessionId));
    const inProgressTurn = active?.turn ?? (await findInProgressTurn(sessionId));
    if (!inProgressTurn) throw new Error("No active turn to stop.");

    if (active) return interruptActiveTurn(active, reason);
    return interruptTurn(session, inProgressTurn.id, reason);
  }

  async function findInProgressTurn(sessionId: string): Promise<Turn | null> {
    const snapshot = await store.snapshot();
    for (let index = snapshot.turns.length - 1; index >= 0; index -= 1) {
      const turn = snapshot.turns[index]!;
      if (turn.sessionId === sessionId && turn.status === "in_progress") return turn;
    }
    return null;
  }

  async function turnWasInterrupted(turnId: string): Promise<boolean> {
    return (await store.snapshot()).turns.some((candidate) => candidate.id === turnId && candidate.status === "interrupted");
  }

  async function activeInProgressTurn(sessionId: string): Promise<Turn | null> {
    const active = activeTurns.get(sessionId);
    if (!active) return null;
    const stored = await getStoredTurn(active.turn.id);
    if (!stored || stored.status === "in_progress") return active.turn;
    return null;
  }

  async function mentionedAppsForTurn(appIds: string[] | undefined): Promise<OpenPondApp[]> {
    const uniqueIds = Array.from(new Set((appIds ?? []).map((appId) => appId.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return [];
    const apps = await Promise.all(
      uniqueIds.map((appId) =>
        findOpenPondApp(appId).catch(() => null)
      )
    );
    return apps.filter((app): app is OpenPondApp => Boolean(app));
  }

  async function connectedAppsForTurn(input: {
    refs: MentionedConnectedAppRef[] | undefined;
    prompt: string;
    session: Session;
    turnId: string;
  }): Promise<ResolvedConnectedAppContext[]> {
    if (
      !listIntegrationConnections ||
      ((!input.refs || input.refs.length === 0) && !promptMentionsConnectedAppProvider(input.prompt))
    ) {
      return [];
    }
    try {
      return await resolveConnectedAppContextsForTurn({
        refs: input.refs,
        prompt: input.prompt,
        cloudTeamId: input.session.cloudTeamId,
        listIntegrationConnections,
      });
    } catch (error) {
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turnId,
          name: "diagnostic",
          source: "server",
          appId: input.session.appId,
          status: "failed",
          output: "Connected app references could not be resolved for this turn.",
          data: {
            kind: "connected_app_resolution",
            providerCount: input.refs?.length ?? 0,
            error: textFromUnknown(error) || "Unknown connected app resolution error.",
          },
        }),
      );
      return [];
    }
  }

  async function sendTurn(sessionId: string, payload: unknown): Promise<Turn> {
    const input = SendTurnRequestSchema.parse(payload);
    let turnPermissions = turnPermissionsFromSendTurnInput(input);
    const existingTurn = (await activeInProgressTurn(sessionId)) ?? (await findInProgressTurn(sessionId));
    if (existingTurn) {
      throw new Error("A turn is already running for this chat.");
    }
    let session = await getSession(sessionId);
    let subagentContinuation = await prepareSubagentContinuationTurn({
      session,
      request: input,
      requestedTurnPermissions: turnPermissions,
    });
    if (subagentContinuation) turnPermissions = subagentContinuation.turnPermissions;
    const activeProvider = input.modelRef?.providerId ?? session.modelRef?.providerId ?? session.provider;
    const activeModelId = input.modelRef?.modelId ?? input.model ?? session.modelRef?.modelId ?? null;
    const turnModelRef: ChatModelRef | null = activeModelId
      ? { providerId: activeProvider, modelId: activeModelId }
      : input.modelRef ?? session.modelRef ?? null;
    const profileSkillCommand = executeProfileSkillCommand
      ? await executeProfileSkillCommand({ prompt: input.prompt })
      : null;
    const priorEvents = (await store.snapshot()).events.filter((item) => item.sessionId === sessionId);

    const startedAt = now();
    const effectiveUsageAttribution = input.usageAttribution ?? subagentContinuation?.usageAttribution ?? null;
    const createPipelineMetadata = {
      ...(input.metadata ? input.metadata : {}),
      ...(effectiveUsageAttribution ? { usageAttribution: effectiveUsageAttribution } : {}),
      ...(input.createPipelineRequest ? { createPipelineRequest: input.createPipelineRequest } : {}),
      ...(input.createPipeline ? { createPipeline: input.createPipeline } : {}),
    };
    const turn: Turn = {
      id: randomUUID(),
      sessionId,
      providerTurnId: null,
      modelRef: turnModelRef,
      prompt: input.prompt,
      startedAt,
      completedAt: null,
      status: "in_progress",
      error: null,
      metadata: createPipelineMetadata,
      createPipelineRequest: input.createPipelineRequest ?? null,
      createPipeline: input.createPipeline ?? null,
    };
    await insertStoredTurn(turn);
    const initialCwd =
      (!profileSkillCommand?.handled ? profileSkillCommand?.workspaceCwd ?? null : null) ??
      input.cwd ??
      (await resolveSessionWorkspaceCwd(session, { ensureOpenPond: false })) ??
      session.cwd ??
      defaultSessionCwd(session.appId);
    session = await updateSession(sessionId, {
      provider: activeProvider,
      modelRef: turnModelRef,
      status: "active",
      title: session.title === "New chat" ? input.prompt.slice(0, 64) : session.title,
      cwd: initialCwd,
    });
    const controller = new AbortController();
    const activeTurn: ActiveTurn = { session, turn, controller };
    activeTurns.set(sessionId, activeTurn);
    await markSubagentContinuationRunning({
      context: subagentContinuation,
      childTurnId: turn.id,
    });

    try {
      const attachmentContexts = await materializeChatAttachments({
        attachmentRootDir,
        sessionId,
        turnId: turn.id,
        attachments: input.attachments,
      });
      const attachmentContext = chatAttachmentContext(attachmentContexts);
      const providerPrompt = formatPromptWithAttachmentContext(input.prompt, attachmentContext);
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: turn.id,
          name: "turn.started",
          source: "chat_action",
          appId: session.appId,
          args: {
            prompt: input.prompt,
            cwd: initialCwd,
            provider: activeProvider,
            ...(turnModelRef ? { modelRef: turnModelRef } : {}),
            ...createPipelineMetadata,
            ...(attachmentContexts.length > 0
              ? {
                  attachments: chatAttachmentSummaries(input.attachments, {
                    sessionId,
                    turnId: turn.id,
                    materialized: attachmentContexts,
                  }),
                  attachmentContext,
                }
              : {}),
          },
          status: "started",
        })
      );
      const threadGoal = threadGoalFromTurnMetadata(input.metadata);
      if (threadGoal) {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "diagnostic",
            source: "server",
            appId: session.appId,
            status: "completed",
            output: threadGoal.output,
            data: threadGoal.data,
          })
        );
      }
      if (profileSkillCommand) {
        if (profileSkillCommand.handled) {
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "diagnostic",
              source: "server",
              appId: session.appId,
              status: "completed",
              output: `Profile skill command ${profileSkillCommand.action}.`,
              data: {
                kind: "profile_skill_command",
                action: profileSkillCommand.action,
                skillCount: profileSkillCommand.skills?.length ?? null,
              },
            }),
          );
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "assistant.delta",
              source: "server",
              appId: session.appId,
              output: profileSkillCommand.message,
            }),
          );
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "turn.completed",
              source: "server",
              appId: session.appId,
              status: "completed",
              output: `Profile skill command ${profileSkillCommand.action}.`,
            }),
          );
          return completeTurn(sessionId, turn.id, null);
        }
        const goal = profileSkillCommand.goal ?? null;
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "diagnostic",
            source: "server",
            appId: session.appId,
            status: "completed",
            output: "Profile skill command routed to goal.",
            data: {
              kind: "profile_skill_command",
              action: profileSkillCommand.action,
              routing: "goal",
              goal,
              skill: profileSkillCommand.skill ?? null,
            },
          }),
        );
        if (goal) {
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "diagnostic",
              source: "server",
              appId: session.appId,
              status: "completed",
              output:
                typeof goal.objective === "string" && goal.objective.trim()
                  ? goal.objective.trim()
                  : profileSkillCommand.message,
              data: {
                kind: "thread_goal",
                provider: typeof goal.provider === "string" ? goal.provider : "openpond",
                goal,
              },
            }),
          );
        }
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "tool.started",
            source: "server",
            action: "openpond_profile_skill_goal",
            appId: session.appId,
            status: "started",
            output: "Creating profile skill.",
            args: {
              operation: profileSkillCommand.goal.operation,
              objective: profileSkillCommand.goal.userObjective,
              skillName: profileSkillCommand.goal.targetSkillName,
            },
            data: {
              tool: "openpond_profile_skill_goal",
              type: "profile_skill_goal",
            },
          }),
        );
        try {
          const executed = await executeProfileSkillGoalForTurn({
            session,
            turnId: turn.id,
            command: profileSkillCommand,
            eventSource: "server",
          });
          const result = profileSkillGoalToolResultFromExecution(executed);
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "tool.completed",
              source: "server",
              action: "openpond_profile_skill_goal",
              appId: session.appId,
              status: "completed",
              output: JSON.stringify(
                {
                  ok: true,
                  action: "openpond_profile_skill_goal",
                  output: result.nextStep,
                  data: result,
                },
                null,
                2,
              ),
              data: {
                tool: "openpond_profile_skill_goal",
                type: "profile_skill_goal",
                result,
              },
            }),
          );
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "assistant.delta",
              source: "server",
              appId: session.appId,
              output: executed.message,
            }),
          );
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "turn.completed",
              source: "server",
              appId: session.appId,
              status: "completed",
              output: executed.message,
            }),
          );
          return completeTurn(sessionId, turn.id, null);
        } catch (error) {
          const message = textFromUnknown(error) || "Profile skill goal failed.";
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "tool.completed",
              source: "server",
              action: "openpond_profile_skill_goal",
              appId: session.appId,
              status: "failed",
              output: JSON.stringify(
                {
                  ok: false,
                  action: "openpond_profile_skill_goal",
                  output: message,
                },
                null,
                2,
              ),
              error: message,
              data: {
                tool: "openpond_profile_skill_goal",
                type: "profile_skill_goal",
              },
            }),
          );
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "assistant.delta",
              source: "server",
              appId: session.appId,
              output: message,
            }),
          );
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "turn.completed",
              source: "server",
              appId: session.appId,
              status: "failed",
              output: message,
            }),
          );
          return failTurn(session, turn.id, message);
        }
      }
      if (input.createPipelineRequest) {
        let effectiveCreatePipeline = input.createPipeline ?? null;
        let plannedByServer = false;
        if (!effectiveCreatePipeline) {
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "create_pipeline.updated",
              source: "server",
              appId: session.appId,
              status: "pending",
              output: "Create planner is preparing the plan.",
              data: {
                createPipelineRequest: input.createPipelineRequest,
                createPipeline: null,
              },
            })
          );
          effectiveCreatePipeline = await planCreatePipelineForTurn({
            session,
            turn,
            request: input.createPipelineRequest,
            previousSnapshot: null,
            signal: controller.signal,
          });
          plannedByServer = true;
          await persistCreatePipelineSnapshot({
            session,
            turnId: turn.id,
            request: input.createPipelineRequest,
            snapshot: effectiveCreatePipeline,
            source: "server",
          });
        } else {
          assertCreatePipelineSnapshotLinked({
            actionLabel: "Create pipeline send turn",
            request: input.createPipelineRequest,
            snapshot: effectiveCreatePipeline,
          });
        }
        const createPipelineState = effectiveCreatePipeline.state;
        if (!plannedByServer) {
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "create_pipeline.updated",
              source: "server",
              appId: session.appId,
              status: createPipelineRuntimeEventStatus(effectiveCreatePipeline),
              output: createPipelineState === "awaiting_questions"
                ? "Create question ready."
                : "Create plan ready for review.",
              data: {
                createPipelineRequest: input.createPipelineRequest,
                createPipeline: effectiveCreatePipeline,
              },
            })
          );
          await syncCreatePlanApproval({
            session,
            turn,
            request: input.createPipelineRequest,
            snapshot: effectiveCreatePipeline,
          });
        }
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "turn.completed",
            source: "server",
            appId: session.appId,
            status: "completed",
            output: createPipelineState === "awaiting_questions"
              ? "Create pipeline paused for questions."
              : "Create pipeline paused for plan review.",
          })
        );
        return completeTurn(sessionId, turn.id, null);
      }
      const initialWorkspaceDiff = await workspaceDiffBaseline(session);
      const mentionedApps = await mentionedAppsForTurn(input.mentionedAppIds);
      const connectedApps = await connectedAppsForTurn({
        refs: input.mentionedConnectedApps,
        prompt: providerPrompt,
        session,
        turnId: turn.id,
      });
      session = await maybeCreateScaffoldForTurn(session, turn.id, providerPrompt);
      activeTurn.session = session;
      throwIfInterrupted(controller.signal);
      const personalizationSoul = await loadPersonalizationSoul();
      const shouldLoadProfileSkills =
        session.provider === "openpond" || isOpenAiCompatibleProviderId(session.provider);
      const profileSkillRuntime: ProfileSkillRuntime = shouldLoadProfileSkills
        ? await loadProfileSkillRuntime({ session, turnId: turn.id })
        : { profileSourcePath: null, skills: [], readSkill: null };
      const loadedProfileSkills = shouldLoadProfileSkills
        ? await preloadExplicitProfileSkills({
            session,
            turnId: turn.id,
            prompt: providerPrompt,
            runtime: profileSkillRuntime,
            signal: controller.signal,
          })
        : [];
      const extraSystemContext = subagentSystemContextForSession(session);
      if (session.provider === "openpond") {
        const providerTurnId = `openpond-${turn.id}`;
        const model = turnModelRef?.modelId || input.model || DEFAULT_OPENPOND_CHAT_MODEL;
        await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId }));
        const systemPrompt = await hostedSystemPrompt(HOSTED_CHAT_SYSTEM_PROMPT, personalizationSoul, session, {
          mentionedApps,
          openPondActionCatalog: input.openPondActionCatalog,
          openPondProfileSkills: profileSkillRuntime.skills,
          loadedProfileSkills,
          connectedApps,
          toolInstructionMode: hostedToolInstructionModeForProvider(hostedToolFlags, "openpond"),
          actionCatalogInstructionMode: actionCatalogInstructionModeForProvider("openpond"),
          profileSkillInstructionMode: profileSkillInstructionModeForProvider("openpond", profileSkillRuntime),
          browserControlAvailable: browserControlAvailable(session),
          extraSystemContext,
        });
        const hostedPriorEvents = await maybeAutoCompactHostedContext({
          session,
          turn,
          provider: "openpond",
          model,
          priorEvents,
          prompt: providerPrompt,
          systemPrompt,
          signal: controller.signal,
        });
        const messages = buildChatMessagesForProvider(hostedPriorEvents, providerPrompt, systemPrompt);
        await throwIfAutoCompactionOffWouldExceedLimit({
          provider: "openpond",
          model,
          messages,
        });
        session = await runHostedToolLoop({
          session,
          turn,
          turnPermissions,
          provider: "openpond",
          model,
          messages,
          resourceEvents: hostedPriorEvents,
          mentionedApps,
          connectedApps,
          openPondActionCatalog: input.openPondActionCatalog ?? [],
          profileSkillRuntime,
          userPrompt: providerPrompt,
          workspaceDiffBaseline: initialWorkspaceDiff,
          signal: controller.signal,
          stream: async function* (loopMessages, options) {
            for await (const delta of streamOpenPondHostedChatTurn({
              model,
              messages: loopMessages,
              tools: options?.tools,
              toolChoice: options?.toolChoice,
              requestId: turn.id,
              signal: controller.signal,
            })) {
              if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
              if (delta.type === "reasoning_delta" && delta.text) yield { reasoningText: delta.text, raw: delta.raw };
              if (delta.type === "tool_call_delta") yield { toolCalls: delta.toolCalls, raw: delta.raw };
              if (delta.type === "usage") yield { raw: delta.raw, usage: delta.usage };
              if (delta.type === "finish") yield { finishReason: delta.finishReason, raw: delta.raw };
            }
          },
        });
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "turn.completed",
            source: "provider",
            appId: session.appId,
            status: "completed",
          })
        );
        return completeTurn(sessionId, turn.id, providerTurnId);
      }

      if (isOpenAiCompatibleProviderId(session.provider)) {
        const providerTurnId = `${session.provider}-${turn.id}`;
        const model = turnModelRef?.modelId ?? input.model ?? null;
        const providerSettings = loadProviderSettings ? await loadProviderSettings() : null;
        const runtimeModel =
          model ??
          providerSettings?.providers[session.provider]?.defaultModel ??
          providerSettings?.modelCaches[session.provider]?.models.find((candidate) => candidate.id.trim())?.id ??
          null;
        const contextLimitTokens = trustedProviderContextLimit({
          provider: session.provider,
          model: runtimeModel,
          settings: providerSettings,
        });
        await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId }));
        const systemPrompt = await hostedSystemPrompt(HOSTED_CHAT_SYSTEM_PROMPT, personalizationSoul, session, {
          mentionedApps,
          openPondActionCatalog: input.openPondActionCatalog,
          openPondProfileSkills: profileSkillRuntime.skills,
          loadedProfileSkills,
          connectedApps,
          toolInstructionMode: hostedToolInstructionModeForProvider(hostedToolFlags, session.provider),
          actionCatalogInstructionMode: actionCatalogInstructionModeForProvider(session.provider),
          profileSkillInstructionMode: profileSkillInstructionModeForProvider(session.provider, profileSkillRuntime),
          browserControlAvailable: browserControlAvailable(session),
          extraSystemContext,
        });
        const hostedPriorEvents = await maybeAutoCompactHostedContext({
          session,
          turn,
          provider: session.provider,
          model: runtimeModel ?? "default",
          maxContextTokens: contextLimitTokens,
          priorEvents,
          prompt: providerPrompt,
          systemPrompt,
          signal: controller.signal,
          streamCompactionChatTurn: async function* (streamInput) {
            if (!streamLocalByokChatTurn) {
              throw new Error(`Provider ${session.provider} is not configured for local BYOK chat.`);
            }
            for await (const delta of streamLocalByokChatTurn({
              providerId: session.provider,
              modelId: runtimeModel,
              messages: streamInput.messages,
              requestId: streamInput.requestId,
              signal: streamInput.signal ?? controller.signal,
            })) {
              if (delta.text) yield { text: delta.text, raw: delta.raw };
              if (delta.reasoningText) yield { reasoningText: delta.reasoningText, raw: delta.raw };
              if (delta.usage) yield { usage: delta.usage, raw: delta.raw };
            }
          },
        });
        const messages = buildChatMessagesForProvider(hostedPriorEvents, providerPrompt, systemPrompt);
        await throwIfAutoCompactionOffWouldExceedLimit({
          provider: session.provider,
          model: runtimeModel ?? "default",
          messages,
          maxContextTokens: contextLimitTokens,
        });
        session = await runHostedToolLoop({
          session,
          turn,
          turnPermissions,
          provider: session.provider,
          model: runtimeModel ?? "default",
          messages,
          contextLimitTokens,
          resourceEvents: hostedPriorEvents,
          mentionedApps,
          connectedApps,
          openPondActionCatalog: input.openPondActionCatalog ?? [],
          profileSkillRuntime,
          userPrompt: providerPrompt,
          workspaceDiffBaseline: initialWorkspaceDiff,
          signal: controller.signal,
          stream: async function* (loopMessages, options) {
            if (!streamLocalByokChatTurn) {
              throw new Error(`Provider ${session.provider} is not configured for local BYOK chat.`);
            }
            for await (const delta of streamLocalByokChatTurn({
              providerId: session.provider,
              modelId: runtimeModel,
              messages: loopMessages,
              tools: options?.tools,
              toolChoice: options?.toolChoice,
              requestId: turn.id,
              signal: controller.signal,
            })) {
              if (delta.text) yield { text: delta.text, raw: delta.raw };
              if (delta.reasoningText) yield { reasoningText: delta.reasoningText, raw: delta.raw };
              if (delta.toolCalls) yield { toolCalls: delta.toolCalls, raw: delta.raw };
              if (delta.usage) yield { raw: delta.raw, usage: delta.usage };
              if (delta.finishReason !== undefined) yield { finishReason: delta.finishReason, raw: delta.raw };
            }
          },
        });
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "turn.completed",
            source: "provider",
            appId: session.appId,
            status: "completed",
            data: {
              provider: session.provider,
              model: runtimeModel,
            },
          })
        );
        return completeTurn(sessionId, turn.id, providerTurnId);
      }

      if (session.provider !== "codex") throw new Error(`Unsupported provider: ${session.provider}`);
      const codexModel = turnModelRef?.modelId ?? input.model ?? null;
      const turnCwd =
        input.cwd ??
        (await resolveSessionWorkspaceCwd(session, {
          ensureOpenPond: session.workspaceKind !== "local_project",
        })) ??
        session.cwd;
      if (turnCwd && turnCwd !== session.cwd) session = await updateSession(session.id, { cwd: turnCwd });
      activeTurn.session = session;
      const runtime = await ensureCodexRuntime(session, {
        ...input,
        model: codexModel,
        approvalPolicy: turnPermissions.approvalPolicy,
        sandbox: turnPermissions.sandbox,
        codexPermissionMode: turnPermissions.codexPermissionMode,
        codexReasoningEffort: turnPermissions.codexReasoningEffort,
      });
      activeTurn.codexRuntime = runtime;
      throwIfInterrupted(controller.signal);
      const providerTurn = await runtime.client.startTurn({
        threadId: runtime.threadId,
        prompt: providerPrompt,
        cwd: turnCwd ?? session.cwd,
        model: codexModel,
        approvalPolicy: turnPermissions.approvalPolicy,
        sandbox: turnPermissions.sandbox,
      });
      activeTurn.codexTurnId = providerTurn.turnId;
      if (controller.signal.aborted) {
        await runtime.client
          .interruptTurn({ threadId: runtime.threadId, turnId: providerTurn.turnId })
          .catch(() => undefined);
        throw interruptedError();
      }
      await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId: providerTurn.turnId }));
      await Promise.race([runtime.client.waitForTurn(providerTurn.turnId), waitForInterrupt(controller.signal)]);
      await appendWorkspaceDiffEvent(session, turn.id, { baseline: initialWorkspaceDiff });
      return completeTurn(sessionId, turn.id, providerTurn.turnId);
    } catch (error) {
      if (controller.signal.aborted || (await turnWasInterrupted(turn.id))) {
        return interruptTurn(session, turn.id, "Stopped by user");
      }
      const message = error instanceof Error ? error.message : String(error);
      if (input.createPipelineRequest) {
        await persistCreatePipelinePlanningFailure({
          session,
          turn,
          request: input.createPipelineRequest,
          message,
        }).catch(() => undefined);
      }
      return failTurn(session, turn.id, message);
    } finally {
      await finalizeSubagentContinuationTurn({
        context: subagentContinuation,
        childSession: session,
        childTurnId: turn.id,
      }).catch(() => undefined);
      if (activeTurns.get(sessionId)?.turn.id === turn.id) activeTurns.delete(sessionId);
    }
  }

  async function updateTurnCreatePipeline(
    sessionId: string,
    turnId: string,
    payload: unknown,
  ): Promise<Turn> {
    const input = UpdateTurnCreatePipelineRequestSchema.parse(payload);
    const session = await getSession(sessionId);
    const requestedCreatePipelineRequest =
      input.createPipelineRequest ?? input.createPipeline.request ?? null;
    assertCreatePipelineSnapshotLinked({
      actionLabel: "Create pipeline turn update",
      request: requestedCreatePipelineRequest,
      snapshot: input.createPipeline,
    });
    const existingTurn = await getStoredTurn(turnId);
    if (!existingTurn || existingTurn.sessionId !== sessionId) throw new Error("Turn not found");
    let nextCreatePipeline = input.createPipeline;
    if (shouldRunCreatePipelinePlanner(nextCreatePipeline)) {
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId,
          name: "create_pipeline.updated",
          source: "server",
          appId: session.appId,
          status: "pending",
          output: "Create planner is preparing the plan.",
          data: {
            createPipelineRequest: requestedCreatePipelineRequest,
            createPipeline: nextCreatePipeline,
          },
        })
      );
      nextCreatePipeline = await planCreatePipelineForTurn({
        session,
        turn: existingTurn,
        request: requestedCreatePipelineRequest ?? nextCreatePipeline.request,
        previousSnapshot: nextCreatePipeline,
        signal: new AbortController().signal,
      });
    }
    let shouldQueueLocalCreateApply = false;
    if (isCreatePipelineMutationState(nextCreatePipeline.state)) {
      assertCreatePipelineMutationApproved({
        actionLabel: "Create pipeline turn update",
        request: requestedCreatePipelineRequest,
        snapshot: nextCreatePipeline,
      });
      nextCreatePipeline = createPlanExecutionSnapshotForApprovedAdapter(nextCreatePipeline, session);
      shouldQueueLocalCreateApply = shouldApplyLocalCreatePipelineAsync(nextCreatePipeline);
    }
    const result = await updateStoredTurn(turnId, (current) => {
      if (current.sessionId !== sessionId) throw new Error("Turn not found");
      const existingRequest = current.createPipelineRequest;
      if (
        existingRequest?.id &&
        requestedCreatePipelineRequest?.id &&
        existingRequest.id !== requestedCreatePipelineRequest.id
      ) {
        throw new Error("Create pipeline turn update cannot change the original request.");
      }
      return {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          createPipelineRequest: requestedCreatePipelineRequest,
          createPipeline: nextCreatePipeline,
        },
        createPipelineRequest: requestedCreatePipelineRequest,
        createPipeline: nextCreatePipeline,
      };
    });
    if (!result) throw new Error("Turn not found");
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId,
        name: "create_pipeline.updated",
        source: "ui_button",
        appId: session.appId,
        status: createPipelineRuntimeEventStatus(nextCreatePipeline),
        output: nextCreatePipeline.blockedReason ?? nextCreatePipeline.plan?.summary ?? nextCreatePipeline.state,
        data: {
          createPipelineRequest: result.createPipelineRequest,
          createPipeline: result.createPipeline,
        },
      })
    );
    await syncCreatePlanApproval({
      session,
      turn: result,
      request: result.createPipelineRequest ?? requestedCreatePipelineRequest,
      snapshot: result.createPipeline,
    });
    if (shouldQueueLocalCreateApply && result.createPipeline) {
      queueLocalCreatePipelineApply({
        session,
        turn: result,
        request: result.createPipelineRequest ?? requestedCreatePipelineRequest,
        snapshot: result.createPipeline,
      });
    }
    return result;
  }

  async function syncCreatePlanApproval(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot?: CreatePipelineSnapshot | null;
  }): Promise<Approval | null> {
    const snapshot = input.snapshot;
    const plan = snapshot?.plan ?? null;
    if (!snapshot || !plan?.approvalId) return null;
    const status = approvalStatusForPlan(plan.status);
    const existing = await findApproval(plan.approvalId);
    const approval = createPlanApproval({
      existing,
      session: input.session,
      turn: input.turn,
      request: input.request ?? snapshot.request,
      snapshot,
      status,
    });
    await upsertApproval(approval);
    if (!existing && approval.status === "pending") {
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turn.id,
          name: "approval.requested",
          source: "server",
          action: "create_plan",
          appId: input.session.appId,
          status: "pending",
          output: approval.title,
          data: approval,
        }),
      );
    }
    if (existing?.status === "pending" && approval.status !== "pending") {
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turn.id,
          name: "approval.resolved",
          source: "server",
          action: "create_plan",
          appId: input.session.appId,
          status: approval.status === "accepted" || approval.status === "accepted_for_session" ? "completed" : "failed",
          output: approval.title,
          data: {
            approvalId: approval.id,
            status: approval.status,
          },
        }),
      );
    }
    return approval;
  }

  async function resolveCreatePipelineApproval(
    approvalId: string,
    payload: unknown,
  ): Promise<Approval | null> {
    const input = ResolveApprovalRequestSchema.parse(payload);
    const approval = await store.getApproval(approvalId);
    if (!approval || approval.kind !== "create_plan") return null;
    if (approval.status !== "pending") throw new Error("Approval not found or already resolved");
    const turn = approval.turnId ? await getStoredTurn(approval.turnId) : null;
    if (!turn?.createPipeline) {
      throw new Error("Create plan approval is missing its create pipeline turn.");
    }
    const session = await getSession(approval.sessionId);
    const nextSnapshot = createPlanDecisionSnapshot(turn.createPipeline, input.decision);
    const effectiveSnapshot = createPlanExecutionSnapshotForApprovedAdapter(nextSnapshot, session);
    const shouldQueueLocalCreateApply = shouldApplyLocalCreatePipelineAsync(effectiveSnapshot);
    const result = await updateStoredTurn(turn.id, (current) => {
      if (current.sessionId !== approval.sessionId) throw new Error("Turn not found");
      return {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          createPipelineRequest: current.createPipelineRequest ?? effectiveSnapshot.request,
          createPipeline: effectiveSnapshot,
        },
        createPipelineRequest: current.createPipelineRequest ?? effectiveSnapshot.request,
        createPipeline: effectiveSnapshot,
      };
    });
    if (!result) throw new Error("Turn not found");
    assertCreatePipelineSnapshotLinked({
      actionLabel: "Create plan approval resolution",
      request: result.createPipelineRequest ?? effectiveSnapshot.request,
      snapshot: effectiveSnapshot,
    });
    if (isCreatePipelineMutationState(effectiveSnapshot.state)) {
      assertCreatePipelineMutationApproved({
        actionLabel: "Create plan approval resolution",
        request: result.createPipelineRequest ?? effectiveSnapshot.request,
        snapshot: effectiveSnapshot,
      });
    }
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: result.id,
        name: "create_pipeline.updated",
        source: "ui_button",
        appId: session.appId,
        status: createPipelineRuntimeEventStatus(effectiveSnapshot),
        output: effectiveSnapshot.blockedReason ?? effectiveSnapshot.plan?.summary ?? effectiveSnapshot.state,
        data: {
          createPipelineRequest: result.createPipelineRequest,
          createPipeline: effectiveSnapshot,
        },
      }),
    );
    const resolved = await syncCreatePlanApproval({
      session,
      turn: result,
      request: result.createPipelineRequest ?? effectiveSnapshot.request,
      snapshot: effectiveSnapshot,
    });
    if (shouldQueueLocalCreateApply) {
      queueLocalCreatePipelineApply({
        session,
        turn: result,
        request: result.createPipelineRequest ?? effectiveSnapshot.request,
        snapshot: effectiveSnapshot,
      });
    }
    return resolved;
  }

  async function resolveSubagentPatchApplyApproval(
    approvalId: string,
    payload: unknown,
  ): Promise<Approval | null> {
    const input = ResolveApprovalRequestSchema.parse(payload);
    const approval = await store.getApproval(approvalId);
    if (!approval || approval.kind !== "subagent_patch_apply") return null;
    if (approval.status !== "pending") throw new Error("Approval not found or already resolved");
    if (!store.getSubagentRun || !store.upsertSubagentRun) {
      throw new Error("Subagent runtime dependencies are not available.");
    }
    const runId = String(approval.providerRequestId);
    const run = await store.getSubagentRun(runId);
    if (!run) throw new Error(`Subagent run ${runId} was not found.`);
    const session = await getSession(approval.sessionId);
    const parentTurnId = approval.turnId ?? run.parentTurnId;
    if (!parentTurnId) throw new Error("Subagent patch approval is missing its parent turn.");
    const accepted = input.decision === "accept" || input.decision === "acceptForSession";
    const status = subagentPatchApprovalStatusForDecision(input.decision);
    const decidedAt = now();
    let nextRun = run;
    if (accepted) {
      const applyResult = await applySubagentPatchApproval({
        approval,
        run,
      });
      nextRun = SubagentRunSchema.parse({
        ...run,
        status: "accepted",
        completedAt: decidedAt,
        report: run.report
          ? {
              ...run.report,
              followUpNeeded: false,
            }
          : run.report,
        progress: SubagentProgressSchema.parse({
          ...(run.progress ?? {}),
          latestMeaningfulActivity: "Parent accepted the child review packet and applied the patch.",
          currentBlocker: null,
          updatedAt: decidedAt,
        }),
        review: SubagentReviewStateSchema.parse({
          ...(run.review ?? {}),
          status: "accepted",
          decidedAt,
          summary: run.report?.summary ?? run.review.summary ?? null,
        }),
        metadata: {
          ...(run.metadata ?? {}),
          workspaceHandoff: {
            ...(workspaceHandoffFromRun(run) ?? {}),
            applyResult,
          },
        },
      });
      await upsertSubagentRunAndNotify(nextRun);
    } else {
      const revisionMessage = input.decision === "cancel"
        ? "Parent cancelled the patch approval."
        : "Parent declined the patch approval; the child submission needs revision before acceptance.";
      const workspaceRetention = subagentRetainedWorkspaceState({
        retainedAt: decidedAt,
        reason: input.decision === "cancel"
          ? "Patch approval cancelled; child workspace retained for inspection."
          : "Patch approval declined; child workspace retained for revision.",
        trigger: input.decision === "cancel" ? "patch_approval_cancelled" : "patch_approval_declined",
      });
      nextRun = SubagentRunSchema.parse({
        ...run,
        status: input.decision === "cancel" ? "cancelled" : "needs_revision",
        completedAt: input.decision === "cancel" ? decidedAt : null,
        error: input.decision === "cancel" ? revisionMessage : run.error,
        report: run.report
          ? {
              ...run.report,
              followUpNeeded: input.decision !== "cancel",
            }
          : run.report,
        progress: SubagentProgressSchema.parse({
          ...(run.progress ?? {}),
          latestMeaningfulActivity: revisionMessage,
          currentBlocker: input.decision === "cancel" ? revisionMessage : null,
          updatedAt: decidedAt,
        }),
        review: SubagentReviewStateSchema.parse({
          ...(run.review ?? {}),
          status: input.decision === "cancel" ? "needs_user_input" : "needs_revision",
          decidedAt,
          issues: uniqueNonEmptyStrings([...(run.review.issues ?? []), revisionMessage]),
          requiredCorrections: input.decision === "cancel"
            ? run.review.requiredCorrections
            : uniqueNonEmptyStrings([
                ...(run.review.requiredCorrections ?? []),
                "Revise the submitted patch or provide a replacement plan before acceptance.",
              ]),
          humanReviewRecommended: true,
        }),
        metadata: {
          ...(run.metadata ?? {}),
          workspaceHandoff: {
            ...(workspaceHandoffFromRun(run) ?? {}),
            applyResult: {
              status: input.decision === "cancel" ? "cancelled" : "declined",
              approvalId: approval.id,
              decidedAt,
              workspaceRetention,
            },
          },
        },
      });
      await upsertSubagentRunAndNotify(nextRun);
    }
    const resolved: Approval = {
      ...approval,
      status,
    };
    await upsertApproval(resolved);
    await appendRuntimeEvent(
      event({
        sessionId: approval.sessionId,
        turnId: approval.turnId ?? undefined,
        name: "approval.resolved",
        source: "server",
        action: "subagent_patch_apply",
        appId: session.appId,
        status: accepted ? "completed" : "failed",
        output: approval.title,
        data: {
          approvalId,
          status,
          decision: input.decision,
          runId: nextRun.id,
          childSessionId: nextRun.childSessionId,
        },
      }),
    );
    const subagentEventName = accepted
      ? "subagent.accepted"
      : input.decision === "cancel"
        ? "subagent.cancelled"
        : "subagent.needs_revision";
    await appendSubagentReceipt({
      parentSession: session,
      parentTurnId,
      run: nextRun,
      eventName: subagentEventName,
      status: accepted ? "completed" : "failed",
      output: accepted
        ? `${run.roleId} subagent patch applied to the parent workspace.`
        : `${run.roleId} subagent patch was ${status}.`,
    });
    if (!accepted) {
      await appendSubagentReceipt({
        parentSession: session,
        parentTurnId,
        run: nextRun,
        eventName: "subagent.workspace_retained",
        status: "completed",
        output: input.decision === "cancel"
          ? `${run.roleId} subagent workspace retained after patch approval cancellation.`
          : `${run.roleId} subagent workspace retained for patch revision.`,
      });
    }
    if (accepted) {
      await appendWorkspaceDiffEvent(session, parentTurnId).catch(() => undefined);
      const cleanup = await cleanupSubagentRun({
        run: nextRun,
        parentSession: session,
        parentTurnId,
        reason: "accepted_patch_applied",
        policy: "auto_after_acceptance",
      });
      nextRun = cleanup.run;
    }
    return resolved;
  }

  function subagentPatchApprovalStatusForDecision(decision: ResolveApprovalRequest["decision"]): Approval["status"] {
    if (decision === "accept" || decision === "acceptForSession") return "accepted";
    if (decision === "cancel") return "cancelled";
    return "declined";
  }

  async function applySubagentPatchApproval(input: {
    approval: Approval;
    run: SubagentRun;
  }): Promise<Record<string, unknown>> {
    const handoff = workspaceHandoffFromRun(input.run);
    if (!handoff || !truthyRecordBoolean(handoff, "changed")) {
      throw new Error("Subagent run has no captured patch to apply.");
    }
    const patchPath = stringFromRecord(handoff, "patchPath");
    const parentRepoPath = stringFromRecord(handoff, "parentRepoPath");
    const workspaceRoot = stringFromRecord(handoff, "workspaceRoot");
    const patchRootPath = stringFromRecord(handoff, "patchRootPath") ?? workspaceRoot;
    if (!patchPath || !parentRepoPath || !workspaceRoot || !patchRootPath) {
      throw new Error("Subagent patch handoff is missing patchPath, parentRepoPath, or workspaceRoot.");
    }
    assertPathInside({ rootPath: patchRootPath, targetPath: patchPath, label: "Subagent patch" });
    const checkResult = await runWorkspaceCommand("git", ["apply", "--check", patchPath], parentRepoPath);
    if (checkResult.code !== 0) {
      throw new Error(
        checkResult.stderr.trim() ||
        checkResult.stdout.trim() ||
        "Subagent patch does not apply cleanly to the parent workspace.",
      );
    }
    const applyResult = await runWorkspaceCommand("git", ["apply", patchPath], parentRepoPath);
    if (applyResult.code !== 0) {
      throw new Error(
        applyResult.stderr.trim() ||
        applyResult.stdout.trim() ||
        "Subagent patch failed to apply to the parent workspace.",
      );
    }
    return {
      status: "applied",
      approvalId: input.approval.id,
      appliedAt: now(),
      parentRepoPath,
      patchPath,
      checkStdout: checkResult.stdout.trim() || null,
      applyStdout: applyResult.stdout.trim() || null,
    };
  }

  function shouldApplyLocalCreatePipelineAsync(snapshot: CreatePipelineSnapshot): boolean {
    return Boolean(
      snapshot.state === "applying_source" &&
        snapshot.plan?.status === "approved" &&
        snapshot.request.adapter.kind === "local",
    );
  }

  function queueLocalCreatePipelineApply(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
  }): void {
    const key = `${input.session.id}:${input.turn.id}:${input.snapshot.id}`;
    if (createPipelineApplyJobs.has(key)) return;
    const receipt = turnFollowUpQueue.enqueue(
      {
        label: "Apply approved local Create pipeline",
        metadata: {
          key,
          sessionId: input.session.id,
          turnId: input.turn.id,
          pipelineId: input.snapshot.id,
        },
      },
      async () => {
        try {
          await runQueuedLocalCreatePipelineApply(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const blocked = createPipelineBackgroundFailureSnapshot(input.snapshot, message);
          await persistCreatePipelineSnapshot({
            session: input.session,
            turnId: input.turn.id,
            request: input.request ?? input.snapshot.request,
            snapshot: blocked,
            source: "server",
          });
        } finally {
          createPipelineApplyJobs.delete(key);
        }
      },
    );
    createPipelineApplyJobs.set(key, receipt);
  }

  async function runQueuedLocalCreatePipelineApply(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
  }): Promise<void> {
    const latestTurn = await getStoredTurn(input.turn.id) ?? input.turn;
    const effectiveSnapshot = await applyApprovedLocalCreatePipelineSnapshot(input.snapshot, {
      session: input.session,
      turn: latestTurn,
      ensureCodexRuntime,
      appendRuntimeEvent,
      setProviderTurnId: (providerTurnId) =>
        setTurnProviderTurnId(input.session.id, input.turn.id, providerTurnId),
      onSnapshot: async (snapshot) => {
        await persistCreatePipelineSnapshot({
          session: input.session,
          turnId: input.turn.id,
          request: input.request ?? snapshot.request,
          snapshot,
          source: "server",
        });
      },
      model: input.session.provider === "codex" ? input.session.modelRef?.modelId ?? null : null,
      runChecks: runLocalCreatePipelineChecks,
    });
    await persistCreatePipelineSnapshot({
      session: input.session,
      turnId: input.turn.id,
      request: input.request ?? effectiveSnapshot.request,
      snapshot: effectiveSnapshot,
      source: "server",
    });
  }

  async function planCreatePipelineForTurn(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    previousSnapshot?: CreatePipelineSnapshot | null;
    signal: AbortSignal;
  }): Promise<CreatePipelineSnapshot> {
    if (planCreatePipeline) {
      return planCreatePipeline({
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
        modelRef: input.turn.modelRef,
        requestId: `${input.turn.id}:create-planner`,
        signal: input.signal,
      });
    }
    const providerId = input.turn.modelRef?.providerId ?? input.session.provider;
    const modelId =
      input.turn.modelRef?.modelId ??
      (providerId === "openpond" ? DEFAULT_OPENPOND_CHAT_MODEL : null);
    if (providerId === "openpond") {
      const model = modelId || DEFAULT_OPENPOND_CHAT_MODEL;
      return runRecordedModelBackedCreatePipelinePlanner({
        session: input.session,
        turn: input.turn,
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
        provider: providerId,
        model,
        modelRef: { providerId, modelId: model },
        requestId: `${input.turn.id}:create-planner`,
        signal: input.signal,
        stream: async function* (messages) {
          for await (const delta of streamOpenPondHostedChatTurn({
            model,
            messages,
            requestId: `${input.turn.id}:create-planner`,
            signal: input.signal,
          })) {
            if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
            if (delta.type === "usage") yield { raw: delta.raw, usage: delta.usage };
          }
        },
      });
    }
    if (isOpenAiCompatibleProviderId(providerId) && streamLocalByokChatTurn) {
      if (!modelId) {
        throw new Error(`Create planner requires a selected model for provider ${providerId}.`);
      }
      return runRecordedModelBackedCreatePipelinePlanner({
        session: input.session,
        turn: input.turn,
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
        provider: providerId,
        model: modelId,
        modelRef: { providerId, modelId },
        requestId: `${input.turn.id}:create-planner`,
        signal: input.signal,
        stream: (messages) =>
          streamLocalByokChatTurn({
            providerId,
            modelId,
            messages,
            requestId: `${input.turn.id}:create-planner`,
            signal: input.signal,
          }),
      });
    }
    throw new Error("Create planner requires OpenPond Chat or a configured OpenAI-compatible provider.");
  }

  async function runRecordedModelBackedCreatePipelinePlanner(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    previousSnapshot: CreatePipelineSnapshot | null;
    provider: ChatProvider;
    model: string;
    modelRef: ChatModelRef;
    requestId: string;
    signal: AbortSignal;
    stream: Parameters<typeof runModelBackedCreatePipelinePlanner>[0]["stream"];
  }): Promise<CreatePipelineSnapshot> {
    const usageTurn = createUsageTurnForCreatePipelinePlanner({
      turn: input.turn,
      request: input.request,
      previousSnapshot: input.previousSnapshot,
    });
    const usageRecorder = await startProviderRequestUsageRecorder({
      session: input.session,
      turn: usageTurn,
      provider: input.provider,
      model: input.model,
      requestId: input.requestId,
      requestOrdinal: 0,
      requestKind: "create_pipeline_planner",
      upsert: safeUpsertModelUsageRecord,
    });
    try {
      const snapshot = await runModelBackedCreatePipelinePlanner({
        request: input.request,
        previousSnapshot: input.previousSnapshot,
        modelRef: input.modelRef,
        requestId: input.requestId,
        signal: input.signal,
        stream: async function* (messages) {
          for await (const delta of input.stream(messages)) {
            usageRecorder.observeDelta(delta);
            yield delta;
          }
        },
      });
      usageTurn.createPipeline = snapshot;
      await usageRecorder.complete();
      return snapshot;
    } catch (error) {
      await usageRecorder.fail(
        error,
        input.signal.aborted || (error instanceof Error && error.name === "AbortError")
          ? "interrupted"
          : "failed",
      );
      throw error;
    }
  }

  function createUsageTurnForCreatePipelinePlanner(input: {
    turn: Turn;
    request: CreatePipelineRequest;
    previousSnapshot: CreatePipelineSnapshot | null;
  }): Turn {
    return {
      ...input.turn,
      createPipelineRequest: input.request,
      createPipeline: input.previousSnapshot,
      metadata: {
        ...(input.turn.metadata ?? {}),
        createPipelineRequest: input.request,
        ...(input.previousSnapshot ? { createPipeline: input.previousSnapshot } : {}),
      },
    };
  }

  async function persistCreatePipelinePlanningFailure(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    message: string;
  }): Promise<Turn | null> {
    const current = await getStoredTurn(input.turn.id);
    const existingSnapshot = current?.createPipeline ?? input.turn.createPipeline ?? null;
    if (existingSnapshot && existingSnapshot.state !== "planning") return current;
    const snapshot = createBlockedCreatePipelinePlannerSnapshot({
      request: input.request,
      previousSnapshot: existingSnapshot,
      modelRef: current?.modelRef ?? input.turn.modelRef,
      reason: `Create planner failed: ${input.message}`,
    });
    return persistCreatePipelineSnapshot({
      session: input.session,
      turnId: input.turn.id,
      request: input.request,
      snapshot,
      source: "server",
    });
  }

  async function persistCreatePipelineSnapshot(input: {
    session: Session;
    turnId: string;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
    source: RuntimeEvent["source"];
  }): Promise<Turn> {
    const result = await updateStoredTurn(input.turnId, (current) => {
      if (current.sessionId !== input.session.id) throw new Error("Turn not found");
      return {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          createPipelineRequest: input.request ?? current.createPipelineRequest ?? input.snapshot.request,
          createPipeline: input.snapshot,
        },
        createPipelineRequest: input.request ?? current.createPipelineRequest ?? input.snapshot.request,
        createPipeline: input.snapshot,
      };
    });
    if (!result) throw new Error("Turn not found");
    await appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: result.id,
        name: "create_pipeline.updated",
        source: input.source,
        appId: input.session.appId,
        status: createPipelineRuntimeEventStatus(input.snapshot),
        output: input.snapshot.blockedReason ?? input.snapshot.plan?.summary ?? input.snapshot.state,
        data: {
          createPipelineRequest: result.createPipelineRequest,
          createPipeline: input.snapshot,
        },
      }),
    );
    await syncCreatePlanApproval({
      session: input.session,
      turn: result,
      request: result.createPipelineRequest ?? input.request ?? input.snapshot.request,
      snapshot: input.snapshot,
    });
    return result;
  }

  async function findApproval(approvalId: string): Promise<Approval | null> {
    return store.getApproval(approvalId);
  }

  async function setTurnProviderTurnId(
    sessionId: string,
    turnId: string,
    providerTurnId: string,
  ): Promise<void> {
    await updateStoredTurn(turnId, (current) => {
      if (current.sessionId !== sessionId) return current;
      return {
        ...current,
        providerTurnId,
      };
    });
  }

  return {
    sendTurn,
    isSessionTurnActive: (sessionId: string) => activeTurns.has(sessionId),
    interruptSessionTurn,
    updateTurnCreatePipeline,
    resolveCreatePipelineApproval,
    resolveSubagentPatchApplyApproval,
    runSubagentLifecycleAction,
    cleanupExpiredRetainedSubagentWorkspace,
  };
}

function shouldRunCreatePipelinePlanner(snapshot: CreatePipelineSnapshot): boolean {
  return snapshot.state === "planning" && !snapshot.plan;
}

function threadGoalFromTurnMetadata(metadata: SendTurnRequest["metadata"]): {
  output: string;
  data: Record<string, unknown>;
} | null {
  const value = metadata?.threadGoal;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const objective = typeof record.objective === "string" && record.objective.trim()
    ? record.objective.trim()
    : "Goal runtime updated";
  const provider = typeof record.provider === "string" && record.provider.trim()
    ? record.provider.trim()
    : "openpond";
  return {
    output: objective,
    data: {
      kind: "thread_goal",
      provider,
      goal: record,
    },
  };
}

type CreatePipelinePlanStatus = NonNullable<CreatePipelineSnapshot["plan"]>["status"];

function approvalStatusForPlan(status: CreatePipelinePlanStatus): Approval["status"] {
  if (status === "approved") return "accepted";
  if (status === "rejected") return "declined";
  if (status === "cancelled") return "cancelled";
  return "pending";
}

function createPlanApproval(input: {
  existing?: Approval | null;
  session: Session;
  turn: Turn;
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot;
  status: Approval["status"];
}): Approval {
  const plan = input.snapshot.plan;
  const createdAt = input.existing?.createdAt ?? input.snapshot.createdAt;
  return {
    id: plan?.approvalId ?? `approval_${input.snapshot.id}`,
    sessionId: input.session.id,
    turnId: input.turn.id,
    providerRequestId: input.snapshot.id,
    kind: "create_plan",
    title: `${input.request.operation === "edit" ? "Approve edit plan" : "Approve create plan"}: ${input.request.objective}`,
    detail: JSON.stringify(
      {
        requestId: input.request.id,
        pipelineId: input.snapshot.id,
        planId: plan?.id ?? null,
        objective: input.request.objective,
        summary: plan?.summary ?? null,
        sourcePlan: plan?.sourcePlan ?? [],
        requirements: plan?.requirements ?? [],
        checks: plan?.checks ?? [],
        workflowCaptureId: input.snapshot.workflowCapture?.id ?? null,
      },
      null,
      2,
    ),
    status: input.status,
    createdAt,
  };
}

function createPlanDecisionSnapshot(
  snapshot: CreatePipelineSnapshot,
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
): CreatePipelineSnapshot {
  const timestamp = now();
  const approved = decision === "accept" || decision === "acceptForSession";
  const cancelled = decision === "cancel";
  const blockedReason = approved
    ? null
    : cancelled
      ? "Create plan cancelled before source mutation."
      : "Create plan rejected before source mutation.";
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: approved ? "applying_source" : "blocked",
    plan: snapshot.plan
      ? {
          ...snapshot.plan,
          status: approved ? "approved" : cancelled ? "cancelled" : "rejected",
          approvedAt: approved ? snapshot.plan.approvedAt ?? timestamp : null,
          metadata: approved
            ? snapshot.plan.metadata
            : {
                ...snapshot.plan.metadata,
                blockedReason,
              },
          updatedAt: timestamp,
        }
      : null,
    blockedReason,
    updatedAt: timestamp,
  });
}

function createPlanExecutionSnapshotForApprovedAdapter(
  snapshot: CreatePipelineSnapshot,
  session: Session,
): CreatePipelineSnapshot {
  if (
    snapshot.state !== "applying_source" ||
    snapshot.plan?.status !== "approved" ||
    snapshot.request.adapter.kind === "local"
  ) {
    return snapshot;
  }
  const target = resolveWorkspaceExecutionTarget({ session });
  const adapterKind = snapshot.request.adapter.kind;
  const reason =
    adapterKind === "hosted"
      ? "Approved hosted Create plans from this chat require the Cloud work item background flow. No local source mutation was performed."
      : "Approved promote-to-hosted Create plans require an explicit Cloud promotion flow. No local source mutation was performed.";
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "blocked",
    blockedReason: reason,
    metadata: {
      ...snapshot.metadata,
      createPipelineApproval: {
        status: "blocked",
        reason:
          adapterKind === "hosted"
            ? "hosted_create_pipeline_apply_not_configured"
            : "promote_local_to_hosted_apply_not_configured",
        adapterKind,
        workspaceExecutionTarget: createPipelineExecutionTargetMetadata(target),
      },
    },
    updatedAt: now(),
  });
}

function createPipelineExecutionTargetMetadata(
  target: ReturnType<typeof resolveWorkspaceExecutionTarget>,
): Record<string, unknown> {
  if (target.target === "sandbox") {
    return {
      target: target.target,
      ready: target.ready,
      workspaceKind: target.workspaceKind,
      workspaceId: target.workspaceId,
      sandboxId: target.sandboxId,
      cloudProjectId: target.cloudProjectId,
      localProjectId: target.localProjectId,
      hybrid: target.hybrid,
      reason: target.reason,
    };
  }
  if (target.target === "local") {
    return {
      target: target.target,
      ready: target.ready,
      workspaceKind: target.workspaceKind,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      cwd: target.cwd,
      reason: target.reason,
    };
  }
  return {
    target: target.target,
    ready: target.ready,
    workspaceKind: target.workspaceKind,
    workspaceId: target.workspaceId,
    reason: target.reason,
  };
}

function createPipelineRuntimeEventStatus(
  snapshot: CreatePipelineSnapshot,
): RuntimeEvent["status"] {
  if (snapshot.state === "awaiting_questions" || snapshot.state === "awaiting_plan_approval") return "pending";
  if (
    snapshot.state === "applying_source" ||
    snapshot.state === "running_checks" ||
    snapshot.state === "pushing_hosted" ||
    snapshot.state === "running_hosted_checks"
  ) {
    return "started";
  }
  if (
    snapshot.state === "blocked" ||
    snapshot.state === "failed" ||
    snapshot.state === "cancelled"
  ) {
    return "failed";
  }
  return "completed";
}

function createPipelineBackgroundFailureSnapshot(
  snapshot: CreatePipelineSnapshot,
  message: string,
): CreatePipelineSnapshot {
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "blocked",
    blockedReason: message,
    metadata: {
      ...snapshot.metadata,
      localCreatePipeline: {
        status: "blocked",
        reason: "local_create_background_apply_failed",
      },
    },
    updatedAt: now(),
  });
}

export function normalizeMentionedSandboxToolRequest(input: {
  request: WorkspaceToolRequest;
  mentionedApps: OpenPondApp[];
  userPrompt: string;
}): WorkspaceToolRequest {
  void input.mentionedApps;
  void input.userPrompt;
  return input.request;
}
