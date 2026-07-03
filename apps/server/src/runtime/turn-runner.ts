import { randomUUID } from "node:crypto";
import {
  ChatProviderSchema,
  DEFAULT_OPENPOND_CHAT_MODEL,
  CreatePipelineRequestSchema,
  CreatePipelineSnapshotSchema,
  ResolveApprovalRequestSchema,
  SendTurnRequestSchema,
  UpdateTurnCreatePipelineRequestSchema,
  type Approval,
  type ChatModelRef,
  type ChatProvider,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
  type SendTurnRequest,
  type OpenPondActionCatalogEntry,
  type OpenPondApp,
  type OpenPondProfileSkill,
  type OpenPondProfileState,
  type RuntimeEvent,
  type Session,
  type Turn,
  type WorkspaceDiffSummary,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import type { HostedChatTool, HostedChatToolCall, HostedChatToolChoice } from "@openpond/cloud";
import type {
  ProfileSkillCommandResult,
  ProfileSkillGoalCommandInput,
} from "@openpond/cloud";
import { streamOpenPondHostedChatTurn } from "@openpond/runtime";
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
import {
  hostedAutoCompactionDecision,
  runHostedContextCompaction,
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
} from "../openpond/capability-tool-registry.js";
import { runOpenPondGoalControl } from "../openpond/goal-control.js";
import {
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
  HostedProfileSkillBody,
  ProfileSkillInstructionMode,
} from "../openpond/hosted-turn-helpers.js";
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
import { requiresWorkspaceToolForPrompt } from "./workspace-tool-requirements.js";

type HostedToolLoopDelta = {
  text?: string;
  toolCalls?: HostedChatToolCall[];
  finishReason?: string | null;
  raw?: unknown;
  usage?: unknown;
};

type HostedToolLoopStreamOptions = {
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
};

const RESOURCE_TEXT_FALLBACK_ACTIONS = new Set<WorkspaceToolRequest["action"]>([
  "resource_search",
  "resource_read",
]);

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
  dynamicActionTools: false,
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

export function createTurnRunner(deps: {
  attachmentRootDir: string;
  store: {
    snapshot(): Promise<{ events: RuntimeEvent[]; turns: Turn[]; approvals?: Approval[] }>;
    getTurn(turnId: string): Promise<Turn | null>;
    insertTurn(turn: Turn): Promise<void>;
    updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null>;
    getApproval(approvalId: string): Promise<Approval | null>;
  };
  upsertApproval: (approval: Approval) => Promise<void>;
  getSession: (sessionId: string) => Promise<Session>;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
  completeTurn: (sessionId: string, turnId: string, providerTurnId?: string | null) => Promise<Turn>;
  failTurn: (session: Session, turnId: string, message: string) => Promise<Turn>;
  interruptTurn: (session: Session, turnId: string, message?: string) => Promise<Turn>;
  defaultSessionCwd: (appId?: string | null) => string;
  findOpenPondApp: (appId: string) => Promise<OpenPondApp>;
  resolveSessionWorkspaceCwd: (
    session: Pick<Session, "appId" | "cwd" | "workspaceId" | "workspaceKind">,
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
  executeProfileAction?: (payload: unknown) => Promise<unknown>;
  loadOpenPondProfileState?: () => Promise<OpenPondProfileState>;
  readOpenPondProfileSkill?: (input: {
    profileSourcePath: string;
    name: string;
  }) => Promise<ProfileSkillReadResult>;
  executeProfileSkillCommand?: (input: {
    prompt: string;
  }) => Promise<{
    handled: boolean;
    message: string;
    action: string;
    prompt?: string;
    workspaceCwd?: string | null;
    goal?: Record<string, unknown>;
    skill?: unknown;
    skills?: unknown[];
  } | null>;
  executeProfileSkillGoal?: (
    input: ProfileSkillGoalCommandInput,
  ) => Promise<ProfileSkillCommandResult>;
  executeWebSearch?: WebSearchExecutor;
  loadPersonalizationSoul: () => Promise<string>;
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
      toolInstructionMode?: HostedToolInstructionMode;
      actionCatalogInstructionMode?: "text_fallback" | "native_tool" | "none";
      profileSkillInstructionMode?: ProfileSkillInstructionMode;
    }
  ) => Promise<string>;
  appendAssistantText: (session: Session, turnId: string, text: string) => Promise<void>;
  appendHostedContextUsage: (input: {
    session: Session;
    turnId: string;
    provider: "openpond";
    model: string;
    messages: HostedMessages;
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
  runLocalCreatePipelineChecks?: (
    input: LocalCreatePipelineCheckInput,
  ) => Promise<LocalCreatePipelineCheckResult>;
  planCreatePipeline?: CreatePipelinePlanner;
  turnFollowUpQueue: BackgroundWorkerQueue;
  maxHostedWorkspaceToolRounds: number;
  maxRepeatedInvalidToolRequests: number;
  hostedToolFlags?: Partial<HostedToolRolloutFlags>;
}) {
  const {
    attachmentRootDir,
    store,
    upsertApproval,
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
    executeProfileAction,
    loadOpenPondProfileState,
    readOpenPondProfileSkill,
    executeProfileSkillCommand,
    executeProfileSkillGoal,
    executeWebSearch,
    loadPersonalizationSoul,
    maybeCreateScaffoldForTurn,
    hostedSystemPrompt,
    appendAssistantText,
    appendHostedContextUsage,
    streamLocalByokChatTurn,
    runLocalCreatePipelineChecks,
    planCreatePipeline,
    turnFollowUpQueue,
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests,
  } = deps;
  const hostedToolFlags = resolveHostedToolRolloutFlags(deps.hostedToolFlags);
  const activeTurns = new Map<string, ActiveTurn>();
  const createPipelineApplyJobs = new Map<string, BackgroundWorkReceipt>();

  function interruptedError(): Error {
    const error = new Error("Stopped by user");
    error.name = "AbortError";
    return error;
  }

  function throwIfInterrupted(signal: AbortSignal): void {
    if (signal.aborted) throw interruptedError();
  }

  function waitForInterrupt(signal: AbortSignal): Promise<never> {
    if (signal.aborted) return Promise.reject(interruptedError());
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(interruptedError()), { once: true });
    });
  }

  async function getStoredTurn(turnId: string): Promise<Turn | null> {
    return store.getTurn(turnId);
  }

  function nativeToolsEnabledForProvider(provider: ChatProvider): boolean {
    return nativeToolTransportEnabledForProvider(hostedToolFlags, provider);
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
  ): ModelToolDefinition[] {
    const definitions: ModelToolDefinition[] = [];
    definitions.push(
      ...createOpenPondCapabilityModelToolDefinitions({
        startCreatePipeline: startCreatePipelineFromModelTool,
        startGoalControl: (context, input) =>
          startGoalControlFromModelTool(context, input, runtimeEvents),
        ...(executeProfileSkillGoal
          ? { startProfileSkillGoal: startProfileSkillGoalFromModelTool }
          : {}),
      }),
    );
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
    const localProfileLoaded =
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
        targetRepoAssumptions: input.session.cwd ? [`workspace: ${input.session.cwd}`] : [],
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
    return {
      goalId: command.goal.id,
      operation: command.goal.operation,
      targetSkillName: command.goal.targetSkillName,
      targetSkillPath: command.goal.targetSkillPath,
      status: command.goal.status,
      nextStep: command.message,
      goalPrompt: command.prompt,
    };
  }

  function profileSkillAgentRequirementReason(value: string): string | null {
    const normalized = value.toLowerCase();
    const unsupported = [
      "script",
      "reference file",
      "references/",
      "asset",
      "tool dependency",
      "mcp",
      "setup file",
      "setup command",
      "eval",
      "external system",
      "webhook",
      "api integration",
    ];
    const match = unsupported.find((item) => normalized.includes(item));
    return match
      ? `Profile skills are single-file instructions and cannot include ${match}.`
      : null;
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
    return {
      goalId: result.goal.id,
      action: result.action,
      status: result.status,
      objective: result.goal.objective,
      mode: result.mode,
      nextStep: result.nextStep,
    };
  }

  async function runHostedToolLoop(params: {
    session: Session;
    turn: Turn;
    provider: ChatProvider;
    model: string;
    messages: HostedMessages;
    resourceEvents: RuntimeEvent[];
    mentionedApps: OpenPondApp[];
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
    const invalidRequestCounts = new Map<string, number>();
    let workspaceToolResultCount = 0;
    let toolRequiredCorrectionSent = false;
    const nativeToolDefinitions = nativeToolsEnabledForProvider(params.provider)
      ? enabledModelToolDefinitions(createNativeModelToolDefinitions(
          params.openPondActionCatalog,
          params.resourceEvents,
          params.profileSkillRuntime,
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
    for (let index = 0; index < maxHostedWorkspaceToolRounds; index += 1) {
      throwIfInterrupted(params.signal);
      if (params.provider === "openpond") {
        await appendHostedContextUsage({
          session,
          turnId: params.turn.id,
          provider: params.provider,
          model: params.model,
          messages,
        });
      }
      let assistantText = "";
      let latestUsage: unknown;
      let finishReason: string | null | undefined;
      const nativeToolAccumulator = new NativeToolCallAccumulator();
      for await (const delta of params.stream(
        messages,
        nativeTools.length > 0 ? { tools: nativeTools, toolChoice: "auto" } : undefined,
      )) {
        throwIfInterrupted(params.signal);
        if (delta.usage) latestUsage = delta.usage;
        if (delta.text) assistantText += delta.text;
        if (delta.toolCalls) nativeToolAccumulator.append(delta.toolCalls);
        if (delta.finishReason !== undefined) finishReason = delta.finishReason;
      }

      const nativeToolCalls = nativeToolAccumulator.completed();
      if (nativeToolCalls.length > 0) {
        messages.push(assistantMessageForNativeToolCalls(assistantText, nativeToolCalls));
        const nativeResults = await executeNativeToolCalls({
          session,
          turnId: params.turn.id,
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
        for (const result of nativeResults) {
          messages.push(toolResultMessage(result));
        }
        session = await getSession(session.id);
        if (params.provider === "openpond") {
          await appendHostedContextUsage({
            session,
            turnId: params.turn.id,
            provider: params.provider,
            model: params.model,
            messages,
            usage: latestUsage,
            includeCompletion: true,
          });
        }
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
      if (skillReadRequests.length > 0) {
        messages.push(assistantMessage);
        if (params.provider === "openpond") {
          await appendHostedContextUsage({
            session,
            turnId: params.turn.id,
            provider: params.provider,
            model: params.model,
            messages,
            usage: latestUsage,
            includeCompletion: true,
          });
        }
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
      if (deniedTextFallbackRequests.length > 0 && requests.length === 0) {
        messages.push(assistantMessage);
        if (params.provider === "openpond") {
          await appendHostedContextUsage({
            session,
            turnId: params.turn.id,
            provider: params.provider,
            model: params.model,
            messages,
            usage: latestUsage,
            includeCompletion: true,
          });
        }
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
        if (
          workspaceToolResultCount === 0 &&
          !toolRequiredCorrectionSent &&
          requiresWorkspaceToolForPrompt(session, params.userPrompt)
        ) {
          messages.push(assistantMessage);
          if (params.provider === "openpond") {
            await appendHostedContextUsage({
              session,
              turnId: params.turn.id,
              provider: params.provider,
              model: params.model,
              messages,
              usage: latestUsage,
              includeCompletion: true,
            });
          }
          messages.push({
            role: "user",
            content: workspaceToolCorrectionMessage(textFallbackMode, nativeTools.length > 0),
          });
          toolRequiredCorrectionSent = true;
          continue;
        }
        await appendAssistantText(session, params.turn.id, assistantText);
        if (params.provider === "openpond") {
          await appendHostedContextUsage({
            session,
            turnId: params.turn.id,
            provider: params.provider,
            model: params.model,
            messages: [...messages, assistantMessage],
            usage: latestUsage,
            includeCompletion: true,
          });
        }
        return session;
      }

      messages.push(assistantMessage);
      if (params.provider === "openpond") {
        await appendHostedContextUsage({
          session,
          turnId: params.turn.id,
          provider: params.provider,
          model: params.model,
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
      }

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
        await appendNativeToolStarted(params.session, params.turnId, toolCall, { argumentsJson: toolCall.argumentsJson });
        await appendNativeToolCompleted(params.session, params.turnId, result);
        results.push(result);
        continue;
      }

      const profileSkillName = toolCall.name === "profile_skill_read" ? stringFromRecord(args, "name") : null;
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

      await appendNativeToolStarted(params.session, params.turnId, toolCall, args);
      try {
        const result = await definition.execute({
          session: params.session,
          turnId: params.turnId,
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
        results.push(result);
      }
    }
    return results;
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

  function stringFromRecord(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
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
    priorEvents: RuntimeEvent[];
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
  }): Promise<RuntimeEvent[]> {
    throwIfInterrupted(params.signal);
    const projectedMessages = buildChatMessagesForProvider(params.priorEvents, params.prompt, params.systemPrompt);
    const decision = hostedAutoCompactionDecision({
      provider: params.provider,
      model: params.model,
      messages: projectedMessages,
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
      const result = await runHostedContextCompaction({
        session: params.session,
        events: params.priorEvents,
        provider: params.provider,
        model: params.model,
        signal: params.signal,
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

  async function interruptSessionTurn(sessionId: string): Promise<Turn> {
    const active = activeTurns.get(sessionId);
    const session = active?.session ?? (await getSession(sessionId));
    const inProgressTurn = active?.turn ?? (await findInProgressTurn(sessionId));
    if (!inProgressTurn) throw new Error("No active turn to stop.");

    active?.controller.abort();
    if (active?.codexRuntime && active.codexTurnId) {
      try {
        await active.codexRuntime.client.interruptTurn({
          threadId: active.codexRuntime.threadId,
          turnId: active.codexTurnId,
        });
      } catch {
        await active.codexRuntime.client.stop().catch(() => undefined);
      }
    }
    return interruptTurn(session, inProgressTurn.id, "Stopped by user");
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

  async function sendTurn(sessionId: string, payload: unknown): Promise<Turn> {
    const input = SendTurnRequestSchema.parse(payload);
    const existingTurn = (await activeInProgressTurn(sessionId)) ?? (await findInProgressTurn(sessionId));
    if (existingTurn) {
      throw new Error("A turn is already running for this chat.");
    }
    let session = await getSession(sessionId);
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
    const createPipelineMetadata = {
      ...(input.metadata ? input.metadata : {}),
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

    try {
      const attachmentContexts = await materializeChatAttachments({
        attachmentRootDir,
        sessionId,
        turnId: turn.id,
        attachments: input.attachments,
      });
      const attachmentContext = chatAttachmentContext(attachmentContexts);
      let effectivePrompt = input.prompt;
      let providerPrompt = formatPromptWithAttachmentContext(effectivePrompt, attachmentContext);
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
                skill: profileSkillCommand.skill ?? null,
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
        if (typeof profileSkillCommand.prompt === "string" && profileSkillCommand.prompt.trim()) {
          effectivePrompt = profileSkillCommand.prompt;
          providerPrompt = formatPromptWithAttachmentContext(effectivePrompt, attachmentContext);
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
      if (session.provider === "openpond") {
        const providerTurnId = `openpond-${turn.id}`;
        const model = turnModelRef?.modelId || input.model || DEFAULT_OPENPOND_CHAT_MODEL;
        await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId }));
        const systemPrompt = await hostedSystemPrompt(HOSTED_CHAT_SYSTEM_PROMPT, personalizationSoul, session, {
          mentionedApps,
          openPondActionCatalog: input.openPondActionCatalog,
          openPondProfileSkills: profileSkillRuntime.skills,
          loadedProfileSkills,
          toolInstructionMode: hostedToolInstructionModeForProvider(hostedToolFlags, "openpond"),
          actionCatalogInstructionMode: actionCatalogInstructionModeForProvider("openpond"),
          profileSkillInstructionMode: profileSkillInstructionModeForProvider("openpond", profileSkillRuntime),
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
        session = await runHostedToolLoop({
          session,
          turn,
          provider: "openpond",
          model,
          messages,
          resourceEvents: hostedPriorEvents,
          mentionedApps,
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
        await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId }));
        const systemPrompt = await hostedSystemPrompt(HOSTED_CHAT_SYSTEM_PROMPT, personalizationSoul, session, {
          mentionedApps,
          openPondActionCatalog: input.openPondActionCatalog,
          openPondProfileSkills: profileSkillRuntime.skills,
          loadedProfileSkills,
          toolInstructionMode: hostedToolInstructionModeForProvider(hostedToolFlags, session.provider),
          actionCatalogInstructionMode: actionCatalogInstructionModeForProvider(session.provider),
          profileSkillInstructionMode: profileSkillInstructionModeForProvider(session.provider, profileSkillRuntime),
        });
        const messages = buildChatMessagesForProvider(priorEvents, providerPrompt, systemPrompt);
        session = await runHostedToolLoop({
          session,
          turn,
          provider: session.provider,
          model: model ?? "default",
          messages,
          resourceEvents: priorEvents,
          mentionedApps,
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
              modelId: model,
              messages: loopMessages,
              tools: options?.tools,
              toolChoice: options?.toolChoice,
              requestId: turn.id,
              signal: controller.signal,
            })) {
              if (delta.text) yield { text: delta.text, raw: delta.raw };
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
              model,
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
      });
      activeTurn.codexRuntime = runtime;
      throwIfInterrupted(controller.signal);
      const providerTurn = await runtime.client.startTurn({
        threadId: runtime.threadId,
        prompt: providerPrompt,
        cwd: turnCwd ?? session.cwd,
        model: codexModel,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
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
    const shouldQueueLocalCreateApply = shouldApplyLocalCreatePipelineAsync(nextSnapshot);
    const effectiveSnapshot = nextSnapshot;
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
      return runModelBackedCreatePipelinePlanner({
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
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
      return runModelBackedCreatePipelinePlanner({
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
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

  return { sendTurn, interruptSessionTurn, updateTurnCreatePipeline, resolveCreatePipelineApproval };
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
