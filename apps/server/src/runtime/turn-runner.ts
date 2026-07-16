import { randomUUID } from "node:crypto";
import {
  AppPreferencesSchema,
  DEFAULT_OPENPOND_CHAT_MODEL,
  LocalModelChatConfigurationSchema,
  SendTurnRequestSchema,
  type ChatModelRef,
  type ChatProvider,
  type LocalModelChatConfiguration,
  type OpenPondActionCatalogEntry,
  type RuntimeEvent,
  type Session,
  type SubagentRoleSettings,
  type Turn,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import { HOSTED_CHAT_SYSTEM_PROMPT } from "../constants.js";
import {
  chatAttachmentContext,
  chatAttachmentSummaries,
  formatPromptWithAttachmentContext,
  materializeChatAttachments,
} from "../chat-attachments.js";
import { trustedProviderContextLimit } from "../openpond/context-usage.js";
import { buildChatMessagesForProvider } from "../openpond/hosted-chat.js";
import type { ResolvedConnectedAppContext } from "../openpond/connected-app-context.js";
import { isOpenAiCompatibleProviderId } from "../openpond/openai-compatible-provider.js";
import { event, now } from "../utils.js";
import type { BackgroundWorkReceipt } from "./background-worker-queue.js";
import {
  hostedToolInstructionModeForProvider,
  nativeToolTransportEnabledForProvider,
  resolveHostedToolRolloutFlags,
} from "./hosted-turn/rollout.js";
import {
  createConnectedAppTurnResolver,
} from "./hosted-turn/connected-apps.js";
import { resolveMentionedAppsForTurn } from "./hosted-turn/mentioned-apps.js";
import { createProfileSkillGoalRuntime } from "./hosted-turn/profile-skill-goal.js";
import { createHostedCompactionRuntime } from "./hosted-turn/compaction-runtime.js";
import {
  createNativeToolRuntime,
  type ProfileSkillRuntime,
} from "./hosted-turn/native-tools-runtime.js";
import { createHostedToolLoopRuntime } from "./hosted-turn/tool-loop-runtime.js";
import { createProfileSkillCatalogRuntime } from "./hosted-turn/profile-skill-catalog-runtime.js";
import { createCapabilityCatalogRuntime } from "./hosted-turn/capability-catalog.js";
import { createCreatePipelineRuntime } from "./create-pipeline/runtime.js";
import { createCreatePipelineModelTool } from "./create-pipeline/model-tool.js";
import { createCreatePipelineTurnHandler } from "./create-pipeline/send-turn.js";
import { ActiveTurnRegistry } from "./turns/active-turn-registry.js";
import { KeyedRegistry } from "./turns/keyed-registry.js";
import { createGoalSubagentLifecycle } from "./goals/subagent-lifecycle.js";
import { createGoalControlRuntime } from "./goals/control-runtime.js";
import type { ActiveTurn, TurnRunner, TurnRunnerDependencies } from "./turns/ports.js";
import { createProfileSkillCommandRuntime } from "./turns/profile-skill-command-runtime.js";
import { createInterruptionRuntime } from "./turns/interruption-runtime.js";
import { createActiveTurnSettlement, createTurnRunnerLifecycle } from "./turns/lifecycle-runtime.js";
import { createSafeModelUsagePersistence } from "./turns/model-usage-persistence.js";
import {
  resolveSubagentDelegation,
  subagentSystemContextForSession,
} from "./subagents/policies-and-prompts.js";
import { applySubagentPatch, createSubagentPatchApprovalRuntime } from "./subagents/patch-approval.js";
import { createSubagentWorkspaceRuntime } from "./subagents/workspace-runtime.js";
import {
  createSubagentContinuationRuntime,
} from "./subagents/continuation-runtime.js";
import { createSubagentMessagingRuntime } from "./subagents/messaging-runtime.js";
import { createSubagentChildTurnRuntime } from "./subagents/child-turn-runtime.js";
import { createSubagentCompletionRuntime } from "./subagents/completion-runtime.js";
import { createSubagentToolRuntime } from "./subagents/tool-runtime.js";
import type { GoalSubagentPort, SubagentLifecycleControl, SubagentToolHandlers, SubagentTurnHooks } from "./subagents/facets.js";
import { createSubagentRepositoryRuntime } from "./subagents/repository-runtime.js";
import {
  subagentRoleLabel,
  subagentToolResultFromRun,
  uniqueSubagentRefs,
} from "./subagents/tool-results.js";
import {
  threadGoalFromTurnMetadata,
} from "./create-pipeline/snapshots.js";

export * from "./turns/public-api.js";

export function createTurnRunner(deps: TurnRunnerDependencies): TurnRunner {
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
    executeCrossSystemTool,
    finalizeCrossSystemTurn,
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
  const activeTurns = new ActiveTurnRegistry();
  const subagentParentWakeJobs = new KeyedRegistry<BackgroundWorkReceipt>("subagent parent wake job");
  const goalContinuationJobs = new KeyedRegistry<BackgroundWorkReceipt>("goal continuation job");
  const connectedAppsForTurn = createConnectedAppTurnResolver({
    listIntegrationConnections,
    appendRuntimeEvent,
  });
  const safeUpsertModelUsageRecord = createSafeModelUsagePersistence({
    upsert: store.upsertModelUsageRecord
      ? (record) => store.upsertModelUsageRecord!(record)
      : null,
    appendRuntimeEvent,
  });

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

  async function insertStoredTurn(turn: Turn): Promise<void> {
    await store.insertTurn(turn);
  }

  async function updateStoredTurn(
    turnId: string,
    updater: (turn: Turn) => Turn,
  ): Promise<Turn | null> {
    return store.updateTurn(turnId, updater);
  }

  const {
    activeInProgressTurn,
    findInProgressTurn,
    interruptActiveTurn,
    interruptedError,
    interruptSessionTurn,
    throwIfInterrupted,
    turnWasInterrupted,
    waitForInterrupt,
  } = createInterruptionRuntime({
    activeTurns,
    getSession,
    getTurn: getStoredTurn,
    latestTurnForSession: (sessionId, status) => store.latestTurnForSession(sessionId, status),
    interruptTurn,
  });
  const turnRunnerLifecycle = createTurnRunnerLifecycle({
    activeTurns,
    interruptActiveTurn,
    jobRegistries: [subagentParentWakeJobs, goalContinuationJobs],
    queues: [turnFollowUpQueue, ...(subagentQueue ? [subagentQueue] : [])],
  });

  const subagentRepositoryRuntime = createSubagentRepositoryRuntime({
    createSession,
    queue: subagentQueue,
    upsertRun: store.upsertSubagentRun ? (run) => store.upsertSubagentRun!(run) : undefined,
    getRun: store.getSubagentRun ? (runId) => store.getSubagentRun!(runId) : undefined,
    listRuns: store.listSubagentRuns ? (query) => store.listSubagentRuns!(query) : undefined,
    appendMessage: store.appendSubagentMessage
      ? (message) => store.appendSubagentMessage!(message)
      : undefined,
    listUsageRecords: store.listModelUsageRecords
      ? (query) => store.listModelUsageRecords!(query)
      : undefined,
    notifyRunStateChanged: notifySubagentRunStateChanged,
    appendRuntimeEvent,
  });
  const subagentToolsAvailable = subagentRepositoryRuntime.available;
  const requireSubagentDeps = subagentRepositoryRuntime.requireDependencies;
  const upsertSubagentRunAndNotify = subagentRepositoryRuntime.upsertRunAndNotify;
  const appendSubagentReceipt = subagentRepositoryRuntime.appendReceipt;

  const createPipelineRuntime = createCreatePipelineRuntime({
    getSession,
    getTurn: getStoredTurn,
    updateTurn: updateStoredTurn,
    getApproval: (approvalId) => store.getApproval(approvalId),
    upsertApproval,
    appendRuntimeEvent,
    ensureCodexRuntime,
    runLocalCreatePipelineChecks,
    planCreatePipeline,
    turnFollowUpQueue,
    streamLocalByokChatTurn,
    streamOpenPondHostedChatTurn,
    upsertModelUsageRecord: safeUpsertModelUsageRecord,
  });
  const {
    persistCreatePipelinePlanningFailure,
    persistCreatePipelineSnapshot,
    planCreatePipelineForTurn,
    resolveCreatePipelineApproval,
    syncCreatePlanApproval,
    updateTurnCreatePipeline,
  } = createPipelineRuntime;
  const startCreatePipelineFromModelTool = createCreatePipelineModelTool({
    getTurn: getStoredTurn,
    loadProfileState: loadOpenPondProfileState,
    appendRuntimeEvent,
    planCreatePipelineForTurn,
    persistCreatePipelineSnapshot,
  });
  const handleCreatePipelineTurn = createCreatePipelineTurnHandler({
    appendRuntimeEvent,
    planCreatePipelineForTurn,
    persistCreatePipelineSnapshot,
    syncCreatePlanApproval,
    completeTurn,
  });
  const {
    executeProfileSkillGoalForTurn,
    profileSkillGoalToolResultFromExecution,
    startProfileSkillGoalFromModelTool,
  } = createProfileSkillGoalRuntime({
    executeProfileSkillGoal,
    updateSession,
    appendRuntimeEvent,
  });
  const handleProfileSkillCommand = createProfileSkillCommandRuntime({
    appendRuntimeEvent,
    executeProfileSkillGoalForTurn,
    profileSkillGoalToolResultFromExecution,
    completeTurn,
    failTurn,
  });
  const {
    maybeAutoCompactHostedContext,
    throwIfAutoCompactionOffWouldExceedLimit,
  } = createHostedCompactionRuntime({
    loadAppPreferences,
    appendRuntimeEvent,
    streamOpenPondHostedChatTurn,
    upsertModelUsageRecord: safeUpsertModelUsageRecord,
    throwIfInterrupted,
    interruptedError,
  });
  const {
    appendProfileSkillEvent,
    applyNativeToolUsageAttribution,
    executeNativeToolCalls,
    explicitProfileSkillNames,
    profileSkillBodyFromReadResult,
    readProfileSkillForModel,
  } = createNativeToolRuntime({
    maxRepeatedInvalidToolRequests,
    appendRuntimeEvent,
    updateTurn: updateStoredTurn,
    throwIfInterrupted,
  });
  const {
    loadProfileSkillRuntime,
    preloadExplicitProfileSkills,
    profileSkillInstructionModeForProvider,
  } = createProfileSkillCatalogRuntime({
    loadProfileState: loadOpenPondProfileState,
    readProfileSkill: readOpenPondProfileSkill,
    appendRuntimeEvent,
    nativeToolsEnabledForProvider,
    hostedToolFlags,
    appendProfileSkillEvent,
    explicitProfileSkillNames,
    profileSkillBodyFromReadResult,
    throwIfInterrupted,
  });
  const { runHostedToolLoop } = createHostedToolLoopRuntime({
    hostedToolFlags,
    nativeToolsEnabledForProvider,
    createNativeModelToolDefinitions,
    profileSkillInstructionModeForProvider,
    subagentToolsAvailable,
    runtimeEventsForSession: (sessionId, query) => store.runtimeEventsForSession(sessionId, query),
    getSession,
    appendHostedContextUsage,
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests,
    appendRuntimeEvent,
    upsertModelUsageRecord: safeUpsertModelUsageRecord,
    executeNativeToolCalls,
    applyNativeToolUsageAttribution,
    readProfileSkillForModel,
    executeWorkspaceTool,
    appendAssistantText,
    throwIfInterrupted,
  });
  const {
    captureSubagentWorkspaceHandoff,
    cleanupSubagentRun,
    prepareSubagentWorkspaceIsolation,
    subagentWorkspaceTargetKeyForSession,
    subagentWorkspaceTargetKeyFromRun,
  } = createSubagentWorkspaceRuntime({
    attachmentRootDir,
    resolveSessionWorkspaceCwd,
    forkSandboxForSubagent,
    cleanupSandboxForSubagent,
    appendSubagentReceipt,
    requireSubagentPersistence: () => ({ upsertRun: requireSubagentDeps().upsertRun }),
  }) satisfies SubagentLifecycleControl;
  const {
    finalizeSubagentContinuationTurn,
    markSubagentContinuationRunning,
    prepareSubagentContinuationTurn,
    subagentChildTurnPermissions,
    subagentRuntimeDerivedProgress,
    subagentUsageAttribution,
    subagentUsageTotalsForRun,
    turnPermissionsFromSendTurnInput,
  } = createSubagentContinuationRuntime({
    requireSubagentDeps,
    runtimeEventsForSession: store.persistedRuntimeEventsForSession
      ? (sessionId, query) => store.persistedRuntimeEventsForSession!(sessionId, query)
      : (sessionId, query) => store.runtimeEventsForSession(sessionId, query),
    latestAssistantTextForSession: (sessionId) => store.latestAssistantTextForSession(sessionId),
    loadAppPreferences,
    getTurn: getStoredTurn,
    getSession,
    appendSubagentReceipt,
  }) satisfies SubagentTurnHooks;
  const {
    queueSubagentFollowupMessage,
    sendSubagentMessageFromModelTool,
    withSubagentInterruptWakeMetadata,
  } = createSubagentMessagingRuntime({
    requireSubagentDeps,
    currentGoal: (sessionId) => store.currentOpenPondThreadGoal(sessionId),
    getSession,
    latestTurnForSession: (sessionId) => store.latestPersistedTurnForSession(sessionId),
    appendRuntimeEvent,
    appendSubagentReceipt,
    getActiveTurn: (sessionId) => {
      const active = activeTurns.get(sessionId);
      return active ? { sessionId, turn: { id: active.turn.id } } : null;
    },
    interruptActiveTurn: (active, reason) => {
      const current = activeTurns.get(active.sessionId);
      if (!current) throw new Error(`No active turn for session ${active.sessionId}`);
      return interruptActiveTurn(current, reason);
    },
  });
  const { notifyParentOfSubagentCompletion, recoverPendingCompletions } = createSubagentCompletionRuntime({
    appendMessage: (message) => requireSubagentDeps().appendMessage(message),
    listMessages: store.listSubagentMessages
      ? (input) => store.listSubagentMessages!(input)
      : async () => [],
    getRun: (runId) => requireSubagentDeps().getRun(runId),
    listRuns: (input) => requireSubagentDeps().listRuns(input),
    upsertRun: upsertSubagentRunAndNotify,
    getSession,
    hasParentWakeTurn: (sessionId, messageId) => store.hasSubagentParentWakeTurn(sessionId, messageId),
    appendRuntimeEvent,
    currentGoal: (sessionId) => store.currentOpenPondThreadGoal(sessionId),
    turnFollowUpQueue,
    parentWakeJobs: subagentParentWakeJobs,
    getActiveTurn: (sessionId) => {
      const active = activeTurns.get(sessionId);
      return active ? { sessionId, turn: { id: active.turn.id } } : null;
    },
    sendTurn,
  });
  const { resolveSubagentPatchApplyApproval } = createSubagentPatchApprovalRuntime({
    getApproval: (approvalId) => store.getApproval(approvalId),
    getSubagentRun: store.getSubagentRun ? (runId) => store.getSubagentRun!(runId) : null,
    canPersistSubagentRun: Boolean(store.upsertSubagentRun),
    getSession,
    upsertSubagentRunAndNotify,
    upsertApproval,
    appendRuntimeEvent,
    appendSubagentReceipt,
    appendWorkspaceDiffEvent,
    cleanupSubagentRun,
  });
  const { runSubagentChildTurn } = createSubagentChildTurnRuntime({
    requireSubagentDeps,
    sendTurn,
    getTurn: getStoredTurn,
    getPersistedRun: store.getPersistedSubagentRun
      ? (runId) => store.getPersistedSubagentRun!(runId)
      : (runId) => requireSubagentDeps().getRun(runId),
    upsertPersistedRun: store.upsertPersistedSubagentRun
      ? (run) => store.upsertPersistedSubagentRun!(run)
      : (run) => store.upsertSubagentRun!(run),
    notifyRunStateChanged: notifySubagentRunStateChanged,
    latestTurnForSession: (sessionId) => store.latestPersistedTurnForSession(sessionId),
    latestAssistantTextForSession: (sessionId) => store.latestAssistantTextForSession(sessionId),
    appendSubagentReceipt,
    subagentRuntimeDerivedProgress,
    subagentUsageAttribution,
    subagentUsageTotalsForRun,
    captureSubagentWorkspaceHandoff,
    applySubagentPatch,
    appendWorkspaceDiffEvent,
    uniqueSubagentRefs,
    withSubagentInterruptWakeMetadata,
    notifyParentOfSubagentCompletion,
  });
  const {
    applyGoalLifecycleToSubagents,
    archiveSubagentChildSession,
    markGoalSubagentsNeedsResume,
    subagentLifecycleActionNextStep,
  } = createGoalSubagentLifecycle({
    subagentToolsAvailable,
    requireSubagentDeps,
    interruptSessionTurn,
    cleanupSubagentRun,
    appendSubagentReceipt,
    getSession,
    updateSession,
    loadAppPreferences,
    subagentChildTurnPermissions,
    runSubagentChildTurn,
    enqueueSubagentResume: (descriptor, work) => requireSubagentDeps().queue.enqueue(descriptor, work),
  }) satisfies GoalSubagentPort;
  const { startGoalControlFromModelTool } = createGoalControlRuntime({
    enableGoalContinuations,
    subagentToolsAvailable,
    requireSubagentDeps,
    currentGoal: (sessionId) => store.currentOpenPondThreadGoal(sessionId),
    goalById: (sessionId, goalId) => store.openPondThreadGoalById(sessionId, goalId),
    claimGoal: store.claimOpenPondThreadGoal
      ? (input) => store.claimOpenPondThreadGoal!(input)
      : null,
    releaseGoalClaim: store.releaseOpenPondThreadGoalClaim
      ? (sessionId, goalId) => store.releaseOpenPondThreadGoalClaim!(sessionId, goalId)
      : null,
    appendRuntimeEvent,
    turnFollowUpQueue,
    goalContinuationJobs,
    sendTurn,
    activeInProgressTurn,
    findInProgressTurn,
    markGoalSubagentsNeedsResume,
    applyGoalLifecycleToSubagents,
  });
  async function pauseSessionGoal(sessionId: string): Promise<unknown> {
    const session = await getSession(sessionId);
    const currentTurn = (await activeInProgressTurn(sessionId)) ?? (await findInProgressTurn(sessionId));
    const eventTurn = currentTurn ?? await store.latestTurnForSession(sessionId);
    const request = {
      action: "pause" as const,
      reason: "User paused the goal from the composer.",
    };
    const controller = new AbortController();
    const result = await startGoalControlFromModelTool({
      session,
      turnId: eventTurn?.id ?? `goal_control_${randomUUID()}`,
      turnPermissions: {
        sandbox: "read-only",
        codexPermissionMode: "auto-review",
        approvalPolicy: "never",
      },
      provider: session.provider,
      model: session.modelRef?.modelId ?? DEFAULT_OPENPOND_CHAT_MODEL,
      callId: `goal_control_${randomUUID()}`,
      args: request,
      signal: controller.signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "Pause the active goal.",
      turnMetadata: eventTurn?.metadata ?? {},
    }, request);
    // Persist the paused goal and interrupt its active children before interrupting
    // the parent turn. This closes the race where a lifecycle wake starts the
    // next child between an interrupt and the goal status update.
    await interruptSessionTurn(sessionId, "Goal paused by user").catch((error) => {
      if (
        error instanceof Error &&
        (error.message === "No active turn to stop." || error.message === "Turn not found")
      ) return;
      throw error;
    });
    return result;
  }
  const {
    cancelSubagentFromModelTool,
    cleanupExpiredRetainedSubagentWorkspace,
    joinSubagentFromModelTool,
    followupSubagentFromModelTool,
    runSubagentLifecycleAction,
    startSubagentFromModelTool,
    statusSubagentsFromModelTool,
  } = createSubagentToolRuntime({
    requireSubagentDeps,
    loadAppPreferences,
    currentGoal: (sessionId) => store.currentOpenPondThreadGoal(sessionId),
    getSession,
    appendSubagentReceipt,
    subagentWorkspaceTargetKeyForSession,
    subagentWorkspaceTargetKeyFromRun,
    subagentChildTurnPermissions,
    prepareSubagentWorkspaceIsolation,
    runSubagentChildTurn,
    subagentToolResultFromRun,
    subagentRoleLabel,
    interruptSessionTurn,
    cleanupSubagentRun,
    queueSubagentFollowupMessage,
    archiveSubagentChildSession,
    subagentLifecycleActionNextStep,
  }) satisfies SubagentToolHandlers;
  const capabilityCatalogDefinitions = createCapabilityCatalogRuntime({
    handlers: {
      startCreatePipeline: startCreatePipelineFromModelTool,
      startGoalControl: startGoalControlFromModelTool,
      ...(executeProfileSkillGoal
        ? { startProfileSkillGoal: startProfileSkillGoalFromModelTool }
        : {}),
      startSubagent: startSubagentFromModelTool,
      statusSubagents: statusSubagentsFromModelTool,
      joinSubagent: joinSubagentFromModelTool,
      cancelSubagent: cancelSubagentFromModelTool,
      followupSubagent: followupSubagentFromModelTool,
      sendSubagentMessage: sendSubagentMessageFromModelTool,
    },
    subagentToolsAvailable,
    hostedToolFlags,
    executeConnectedAppTool,
    browserToolExecutor,
    executeOpenPondCommand,
    executeWorkspaceTool,
    executeWebSearch,
    executeProfileAction,
    executeCrossSystemTool,
  });

  function createNativeModelToolDefinitions(
    openPondActionCatalog: OpenPondActionCatalogEntry[],
    runtimeEvents: RuntimeEvent[],
    profileSkillRuntime: ProfileSkillRuntime,
    connectedApps: ResolvedConnectedAppContext[],
    options: {
      disableWorkflowDelegationTools?: boolean;
      subagentRoles?: readonly SubagentRoleSettings[];
      subagentToolsEnabled?: boolean;
    } = {},
  ) {
    return capabilityCatalogDefinitions(
      openPondActionCatalog,
      runtimeEvents,
      profileSkillRuntime,
      connectedApps,
      options,
    );
  }
  async function sendTurn(sessionId: string, payload: unknown): Promise<Turn> {
    const finish = turnRunnerLifecycle.beginSendTurn();
    try {
      return await executeTurn(sessionId, payload);
    } finally {
      finish();
    }
  }

  async function executeTurn(sessionId: string, payload: unknown): Promise<Turn> {
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
    const appPreferences = nativeToolsEnabledForProvider(activeProvider) && subagentToolsAvailable()
      ? await loadAppPreferences()
      : null;
    const subagentDelegation = resolveSubagentDelegation(session, appPreferences);
    const turnModelRef: ChatModelRef | null = activeModelId
      ? { providerId: activeProvider, modelId: activeModelId }
      : input.modelRef ?? session.modelRef ?? null;
    const profileSkillCommand = executeProfileSkillCommand
      ? await executeProfileSkillCommand({ prompt: input.prompt })
      : null;
    const priorEvents = await store.runtimeEventsForSession(sessionId);

    const startedAt = now();
    const effectiveUsageAttribution = input.usageAttribution ?? subagentContinuation?.usageAttribution ?? null;
    const createPipelineMetadata = {
      ...(input.metadata ? input.metadata : {}),
      ...(subagentDelegation ? { subagentDelegation } : {}),
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
    const activeTurn: ActiveTurn = { session, turn, controller, ...createActiveTurnSettlement() };
    turnRunnerLifecycle.registerActiveTurn(sessionId, activeTurn);
    const persistGeneratedCrossSystemAttempt = async (input: {
      completedAt: string;
      terminalFailure?: {
        message: string;
        failureClass: "policy_failure" | "infrastructure_failure";
      } | null;
    }) => {
      const generatedTaskId = typeof turn.metadata.crossSystemTaskId === "string"
        ? turn.metadata.crossSystemTaskId.trim()
        : "";
      const modelId = turnModelRef?.modelId ?? activeModelId;
      if (activeProvider !== "local-adapter" || !modelId || !generatedTaskId || !finalizeCrossSystemTurn) return;
      try {
        const persisted = await finalizeCrossSystemTurn({
          modelId,
          localProjectId: session.localProjectId ?? (
            session.workspaceKind === "local_project" ? (session.workspaceId ?? null) : null
          ),
          sessionId,
          turnId: turn.id,
          userPrompt: turn.prompt,
          taskId: generatedTaskId,
          startedAt,
          completedAt: input.completedAt,
          terminalFailure: input.terminalFailure ?? null,
        });
        if (persisted) {
          await appendRuntimeEvent(event({
            sessionId,
            turnId: turn.id,
            name: "diagnostic",
            source: "server",
            appId: session.appId,
            status: "completed",
            output: input.terminalFailure
              ? "Persisted and graded the failed generated Cross-System Operations chat attempt."
              : "Persisted and graded the generated Cross-System Operations chat attempt.",
            data: persisted,
          }));
        }
      } catch (error) {
        await appendRuntimeEvent(event({
          sessionId,
          turnId: turn.id,
          name: "diagnostic",
          source: "server",
          appId: session.appId,
          status: "failed",
          output: error instanceof Error ? error.message : String(error),
          data: { generatedTaskId },
        }));
      }
    };
    try {
      await markSubagentContinuationRunning({
        context: subagentContinuation,
        childTurnId: turn.id,
      });
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
        return handleProfileSkillCommand({ session, turn, command: profileSkillCommand });
      }
      if (input.createPipelineRequest) {
        return await handleCreatePipelineTurn({
          session,
          turn,
          request: input.createPipelineRequest,
          snapshot: input.createPipeline,
          signal: controller.signal,
        });
      }
      const initialWorkspaceDiff = await workspaceDiffBaseline(session);
      const mentionedApps = await resolveMentionedAppsForTurn(input.mentionedAppIds, findOpenPondApp);
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
      const extraSystemContext = subagentSystemContextForSession(session, subagentDelegation);
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
          appPreferences,
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
        const providerModel = providerSettings?.modelCaches[session.provider]?.models.find((candidate) => candidate.id === runtimeModel);
        const localModelConfiguration = session.provider === "local-adapter"
          ? LocalModelChatConfigurationSchema.safeParse(providerModel?.raw?.chatConfiguration).data ?? null
          : null;
        const contextLimitTokens = localModelConfiguration?.contextWindowTokens ?? trustedProviderContextLimit({ provider: session.provider, model: runtimeModel, settings: providerSettings });
        await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId }));
        const systemPrompt = localModelConfiguration && localModelConfiguration.systemPromptMode !== "full_harness"
          ? localModelSystemPrompt(localModelConfiguration)
          : await hostedSystemPrompt(HOSTED_CHAT_SYSTEM_PROMPT, personalizationSoul, session, {
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
        const canCompactLocalModel = !localModelConfiguration || (
          localModelConfiguration.compaction === "when_needed" &&
          priorEvents.some((item) => item.name === "turn.started")
        );
        const hostedPriorEvents = canCompactLocalModel ? await maybeAutoCompactHostedContext({
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
        }) : priorEvents;
        const messages = buildChatMessagesForProvider(hostedPriorEvents, providerPrompt, systemPrompt);
        await throwIfAutoCompactionOffWouldExceedLimit({
          provider: session.provider,
          model: runtimeModel ?? "default",
          messages,
          maxContextTokens: contextLimitTokens,
        });
        session = await runHostedToolLoop({
          appPreferences,
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
              if (delta.continuation) yield { continuation: delta.continuation, raw: delta.raw };
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
        await persistGeneratedCrossSystemAttempt({ completedAt: now() });
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
        return interruptTurn(session, turn.id, activeTurn.interruptionReason ?? "Stopped by user");
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
      const failed = await failTurn(session, turn.id, message);
      await persistGeneratedCrossSystemAttempt({
        completedAt: failed.completedAt ?? now(),
        terminalFailure: {
          message,
          failureClass: error instanceof Error && error.name === "LocalAdapterToolProtocolError"
            ? "policy_failure"
            : "infrastructure_failure",
        },
      });
      return failed;
    } finally {
      await finalizeSubagentContinuationTurn({
        context: subagentContinuation,
        childSession: session,
        childTurnId: turn.id,
      }).catch(() => undefined);
      if (activeTurns.get(sessionId)?.turn.id === turn.id) activeTurns.delete(sessionId);
      activeTurn.settle();
    }
  }

  return {
    sendTurn,
    isSessionTurnActive: (sessionId: string) => activeTurns.has(sessionId),
    interruptSessionTurn,
    pauseSessionGoal,
    interruptAll: turnRunnerLifecycle.interruptAll,
    close: turnRunnerLifecycle.close,
    updateTurnCreatePipeline,
    resolveCreatePipelineApproval,
    resolveSubagentPatchApplyApproval,
    runSubagentLifecycleAction,
    recoverPendingSubagentCompletions: recoverPendingCompletions,
    cleanupExpiredRetainedSubagentWorkspace,
  };
}

function localModelSystemPrompt(configuration: LocalModelChatConfiguration): string {
  if (configuration.systemPromptMode === "custom" && configuration.customSystemPrompt) {
    return configuration.customSystemPrompt;
  }
  return "You are a helpful assistant. Answer the user directly and concisely. Follow the behavior learned for this task when it applies.";
}
