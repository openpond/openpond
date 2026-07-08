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
  SubagentMessageDeliverySchema,
  SubagentMessageSchema,
  SubagentRunSchema,
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
  type SubagentMessage,
  type SubagentMessageDelivery,
  type SubagentMessagePriority,
  type SubagentRun,
  type SubagentRoleSettings,
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
} from "../openpond/context-compaction.js";
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
import { runOpenPondGoalControl } from "../openpond/goal-control.js";
import {
  createConnectedAppSkillModelToolDefinitions,
  createCommandModelToolDefinition,
  createOpenPondActionModelToolDefinitions,
  createOpenPondProfileSkillModelToolDefinitions,
  createResourceModelToolDefinitions,
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
const PARENT_MODEL_VISIBLE_SUBAGENT_EVENTS = new Set<RuntimeEvent["name"]>([
  "subagent.progress",
  "subagent.reported",
  "subagent.completed",
  "subagent.failed",
  "subagent.blocked",
  "subagent.cancelled",
  "subagent.message",
]);
const SUBAGENT_INTERRUPT_WAKE_MAX_RESUMES = 3;
const SUBAGENT_PARENT_WAKE_MAX_CHAIN = 4;

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
  cloudTeamId?: string | null;
  listIntegrationConnections: ConnectedAppIntegrationConnectionLookup;
}): Promise<ResolvedConnectedAppContext[]> {
  if (!input.refs || input.refs.length === 0) return [];
  const cloudTeamId = input.cloudTeamId?.trim() ?? "";
  const primaryResult = await input.listIntegrationConnections({
    ...(cloudTeamId ? { teamId: cloudTeamId } : {}),
    status: "active",
  });
  const primaryContexts = withConnectedAppToolNames(
    resolveMentionedConnectedAppContexts({
      mentionedRefs: input.refs,
      connections: primaryResult.connections,
    }),
  );
  if (!cloudTeamId || mentionedConnectedAppRefsResolved(input.refs, primaryContexts)) {
    return primaryContexts;
  }

  try {
    const aggregateResult = await input.listIntegrationConnections({ status: "active" });
    const aggregateContexts = withConnectedAppToolNames(
      resolveMentionedConnectedAppContexts({
        mentionedRefs: input.refs,
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
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests,
  } = deps;
  const hostedToolFlags = resolveHostedToolRolloutFlags(deps.hostedToolFlags);
  const activeTurns = new Map<string, ActiveTurn>();
  const createPipelineApplyJobs = new Map<string, BackgroundWorkReceipt>();
  const subagentParentWakeJobs = new Map<string, BackgroundWorkReceipt>();

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
                sendSubagentMessage: sendSubagentMessageFromModelTool,
              }
            : {}),
        }),
      );
    }
    definitions.push(...createBrowserModelToolDefinitions(browserToolExecutor));
    if (executeOpenPondCommand) {
      definitions.push(createCommandModelToolDefinition({ executeCommand: executeOpenPondCommand }));
    }
    if (hostedToolFlags.resourceTools) {
      definitions.push(...createResourceModelToolDefinitions({ executeWorkspaceTool, runtimeEvents }));
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
      upsertRun: (run: SubagentRun) => store.upsertSubagentRun!(run),
      getRun: (runId: string) => store.getSubagentRun!(runId),
      listRuns: (query?: Parameters<NonNullable<typeof store.listSubagentRuns>>[0]) =>
        store.listSubagentRuns!(query),
      appendMessage: (message: SubagentMessage) => store.appendSubagentMessage!(message),
      listUsageRecords: (query?: Parameters<NonNullable<typeof store.listModelUsageRecords>>[0]) =>
        store.listModelUsageRecords!(query),
    };
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
    const childSystemContext = subagentChildSystemContext({
      role,
      objective: input.objective,
      parentSession: context.session,
      contextPack: input.context ?? null,
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
    return subagentToolResultFromRun(run, run.status === "completed"
      ? "Subagent completed; use its report and child conversation as evidence."
      : "Subagent has not completed yet; continue parent work or check again later.");
  }

  async function cancelSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentCancelToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    if (run.status === "completed") {
      return subagentToolResultFromRun(run, "Subagent already completed; no cancellation was applied.");
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
    const cleanupResult = input.cleanupWorkspace === false
      ? { status: "skipped", reason: "cleanupWorkspace was false" }
      : await cleanupSubagentWorkspace(nextRun);
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
      const completedAt = now();
      const summary = await latestAssistantTextForSession(input.childSession.id);
      const usage = await subagentUsageTotalsForRun(input.run.id);
      const workspaceHandoff = await captureSubagentWorkspaceHandoff(run);
      run = SubagentRunSchema.parse({
        ...run,
        status: "completed",
        completedAt,
        report: {
          summary: summary || "Child conversation completed.",
          artifacts: workspaceHandoff?.artifacts ?? [],
          patchRef: workspaceHandoff?.patchRef ?? null,
          diffRef: workspaceHandoff?.diffRef ?? null,
          blockers: [],
          followUpNeeded: workspaceHandoff?.changed ?? false,
        },
        metadata: {
          ...(run.metadata ?? {}),
          usage,
          ...(workspaceHandoff ? { workspaceHandoff: workspaceHandoff.metadata } : {}),
        },
      });
      await deps.upsertRun(run);
      if (workspaceHandoff?.changed) {
        await appendSubagentReceipt({
          parentSession: input.parentSession,
          parentTurnId: input.parentTurnId,
          run,
          eventName: "subagent.reported",
          status: "completed",
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
        eventName: "subagent.completed",
        status: "completed",
        output: `${run.roleId} subagent completed.`,
      });
    } catch (error) {
      const latestAfterError = await deps.getRun(run.id).catch(() => null);
      if (latestAfterError?.status === "cancelled") return;
      const message = textFromUnknown(error) || "Subagent failed.";
      run = SubagentRunSchema.parse({
        ...run,
        status: "failed",
        completedAt: now(),
        error: message,
        report: {
          summary: "Child conversation failed before producing a final report.",
          blockers: [message],
          followUpNeeded: true,
        },
      });
      await deps.upsertRun(run);
      await appendSubagentReceipt({
        parentSession: input.parentSession,
        parentTurnId: input.parentTurnId,
        run,
        eventName: "subagent.failed",
        status: "failed",
        output: `${run.roleId} subagent failed: ${message}`,
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
    parentTurnId: string;
    run: SubagentRun;
    eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
    status: RuntimeEvent["status"];
    output: string;
  }): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: input.parentSession.id,
        turnId: input.parentTurnId,
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
      nextStep,
    };
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
    const updated = SubagentRunSchema.parse({
      ...latestRun,
      status: completed ? "completed" : interrupted ? "needs_resume" : "failed",
      completedAt: completed ? now() : latestRun.completedAt,
      error: completed ? null : message,
      report: {
        ...(latestRun.report ?? {}),
        summary: summary || latestRun.report?.summary || (completed ? "Child conversation completed." : "Subagent follow-up did not complete."),
        blockers: completed
          ? latestRun.report?.blockers ?? []
          : uniqueNonEmptyStrings([...(latestRun.report?.blockers ?? []), message ?? "Subagent follow-up did not complete."]),
        followUpNeeded: !completed,
      },
      metadata: {
        ...(latestRun.metadata ?? {}),
        usage,
        lastFollowUpTurnId: input.childTurnId,
        lastFollowUpCompletedAt: now(),
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
        eventName: completed ? "subagent.completed" : "subagent.failed",
        status: completed ? "completed" : "failed",
        output: completed
          ? `${updated.roleId} subagent follow-up completed.`
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
      createdAt: now(),
      cleanup: "manual_after_handoff",
    };
  }

  function safeSubagentPathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "subagent";
  }

  async function captureSubagentWorkspaceHandoff(run: SubagentRun): Promise<{
    changed: boolean;
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
    const patch = diffResult.stdout;
    const changed = Boolean(patch.trim());
    const patchPath = path.join(workspaceRoot, "handoff.patch");
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
      artifacts: patchRef ? [patchRef] : [],
      patchRef,
      diffRef,
      metadata: {
        status: "captured",
        changed,
        repoPath,
        parentRepoPath,
        workspaceRoot,
        branch: workspace.branch ?? null,
        baseCommit: workspace.baseCommit ?? null,
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

  function captureSubagentSandboxForkHandoff(
    run: SubagentRun,
    workspace: Record<string, unknown>,
  ): {
    changed: boolean;
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
      artifacts: [sandboxRef],
      patchRef: null,
      diffRef: null,
      metadata: {
        status: "captured",
        changed: true,
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
    if (!workspace || workspace.implementation !== "git_worktree") return null;
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
      "When finished, respond with a concise report: summary, findings, files or artifacts changed/read, tests or checks run, blockers, confidence, and follow-up needed.",
    ].filter(Boolean).join("\n");
  }

  function subagentChildPrompt(input: {
    objective: string;
    contextPack: string | null;
  }): string {
    return [
      input.objective,
      input.contextPack ? ["Context:", input.contextPack].join("\n") : null,
    ].filter(Boolean).join("\n\n");
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
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "diagnostic",
        source: "provider",
        appId: context.session.appId,
        status: "completed",
        output: result.nextStep,
        data: {
          kind: "goal_control",
          provider: "openpond",
          action: input.action,
          mode: result.mode,
          reason: input.reason,
          goal: result.goal,
          previousGoal: result.previousGoal,
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
        output: result.goal.objective,
        data: {
          kind: "thread_goal",
          provider: "openpond",
          goal: result.goal,
        },
      }),
    );
    const resumedSubagentCount = await markGoalSubagentsNeedsResume({
      context,
      goalId: result.goal.id,
      action: result.action,
    });
    const nextStep = resumedSubagentCount > 0
      ? `${result.nextStep} ${resumedSubagentCount} active ${resumedSubagentCount === 1 ? "subagent needs" : "subagents need"} resume.`
      : result.nextStep;
    return {
      goalId: result.goal.id,
      action: result.action,
      status: result.status,
      objective: result.goal.objective,
      mode: result.mode,
      nextStep,
    };
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
    const unresolved = runs.filter((run) => run.required && run.status !== "completed");
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
        for await (const delta of params.stream(
          messages,
          nativeTools.length > 0 ? { tools: nativeTools, toolChoice: "auto" } : undefined,
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
      }

      messages.push({
        role: "user",
        content: [
          "Workspace tool result:",
          toolResults.join("\n\n"),
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
          preservedResourceRefs: result.preservedResourceRefs,
          sourceEventCount: result.sourceEventCount,
          preservedEventCount: result.preservedEventCount,
          inputTokensBefore: result.inputTokensBefore,
          inputTokensAfter: result.inputTokensAfter,
          maxContextTokens: result.maxContextTokens,
          tokenSource: result.tokenSource,
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
    session: Session;
    turnId: string;
  }): Promise<ResolvedConnectedAppContext[]> {
    if (!listIntegrationConnections || !input.refs || input.refs.length === 0) return [];
    try {
      return await resolveConnectedAppContextsForTurn({
        refs: input.refs,
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
            providerCount: input.refs.length,
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
    let nextRun = run;
    if (accepted) {
      const applyResult = await applySubagentPatchApproval({
        approval,
        run,
      });
      nextRun = SubagentRunSchema.parse({
        ...run,
        report: run.report
          ? {
              ...run.report,
              followUpNeeded: false,
            }
          : run.report,
        metadata: {
          ...(run.metadata ?? {}),
          workspaceHandoff: {
            ...(workspaceHandoffFromRun(run) ?? {}),
            applyResult,
          },
        },
      });
      await store.upsertSubagentRun(nextRun);
    } else {
      nextRun = SubagentRunSchema.parse({
        ...run,
        metadata: {
          ...(run.metadata ?? {}),
          workspaceHandoff: {
            ...(workspaceHandoffFromRun(run) ?? {}),
            applyResult: {
              status: input.decision === "cancel" ? "cancelled" : "declined",
              approvalId: approval.id,
              decidedAt: now(),
            },
          },
        },
      });
      await store.upsertSubagentRun(nextRun);
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
    await appendSubagentReceipt({
      parentSession: session,
      parentTurnId,
      run: nextRun,
      eventName: "subagent.reported",
      status: accepted ? "completed" : "failed",
      output: accepted
        ? `${run.roleId} subagent patch applied to the parent workspace.`
        : `${run.roleId} subagent patch was ${status}.`,
    });
    if (accepted) {
      await appendWorkspaceDiffEvent(session, parentTurnId).catch(() => undefined);
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
    if (!patchPath || !parentRepoPath || !workspaceRoot) {
      throw new Error("Subagent patch handoff is missing patchPath, parentRepoPath, or workspaceRoot.");
    }
    assertPathInside({ rootPath: workspaceRoot, targetPath: patchPath, label: "Subagent patch" });
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
    interruptSessionTurn,
    updateTurnCreatePipeline,
    resolveCreatePipelineApproval,
    resolveSubagentPatchApplyApproval,
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
