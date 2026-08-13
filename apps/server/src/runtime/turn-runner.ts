import { createHash, randomUUID } from "node:crypto";
import {
  AppPreferencesSchema,
  DEFAULT_OPENPOND_CHAT_MODEL,
  DEFAULT_SESSION_EXPERIENCE,
  SendTurnRequestSchema,
  SessionUserQuestionResolutionSchema,
  type ChatModelRef,
  type ChatProvider,
  type OpenPondActionCatalogEntry,
  type RuntimeEvent,
  type SessionUserQuestionResolution,
  type Session,
  type SubagentRoleSettings,
  type Turn,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import {
  AGENT_PROTOCOL_VERSION,
  AgentCheckpointSchema,
  canonicalHash,
  checkpointHash,
} from "@openpond/agent-runtime";
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
import { createConnectedAppTurnResolver } from "./hosted-turn/connected-apps.js";
import { resolveMentionedAppsForTurn } from "./hosted-turn/mentioned-apps.js";
import { createHostedCompactionRuntime } from "./hosted-turn/compaction-runtime.js";
import {
  createNativeToolRuntime,
  type ProfileSkillRuntime,
} from "./hosted-turn/native-tools-runtime.js";
import { createHostedToolLoopRuntime } from "./hosted-turn/tool-loop-runtime.js";
import { createProfileSkillCatalogRuntime } from "./hosted-turn/profile-skill-catalog-runtime.js";
import { createCapabilityCatalogRuntime } from "./hosted-turn/capability-catalog.js";
import { createCreateImproveRuntime } from "./create-pipeline/runtime.js";
import { createCreateImproveTurnHandler } from "./create-pipeline/send-turn.js";
import { ActiveTurnRegistry } from "./turns/active-turn-registry.js";
import { KeyedRegistry } from "./turns/keyed-registry.js";
import type {
  ActiveTurn,
  TurnRunner,
  TurnRunnerDependencies,
} from "./turns/ports.js";
import { createProfileSkillCommandRuntime } from "./turns/profile-skill-command-runtime.js";
import { createInterruptionRuntime } from "./turns/interruption-runtime.js";
import {
  createActiveTurnSettlement,
  createTurnRunnerLifecycle,
} from "./turns/lifecycle-runtime.js";
import { createSafeModelUsagePersistence } from "./turns/model-usage-persistence.js";
import {
  resolveSubagentDelegation,
  subagentSystemContextForSession,
} from "./subagents/policies-and-prompts.js";
import {
  applySubagentPatch,
  createSubagentPatchApprovalRuntime,
} from "./subagents/patch-approval.js";
import { createSubagentWorkspaceRuntime } from "./subagents/workspace-runtime.js";
import { createSubagentContinuationRuntime } from "./subagents/continuation-runtime.js";
import { createSubagentMessagingRuntime } from "./subagents/messaging-runtime.js";
import { createSubagentChildTurnRuntime } from "./subagents/child-turn-runtime.js";
import { createSubagentCompletionRuntime } from "./subagents/completion-runtime.js";
import { createSubagentToolRuntime } from "./subagents/tool-runtime.js";
import type {
  SubagentLifecycleControl,
  SubagentToolHandlers,
  SubagentTurnHooks,
} from "./subagents/facets.js";
import { createSubagentLifecycleRuntime } from "./subagents/lifecycle-runtime.js";
import { createSubagentRepositoryRuntime } from "./subagents/repository-runtime.js";
import {
  subagentRoleLabel,
  subagentToolResultFromRun,
  uniqueSubagentRefs,
} from "./subagents/tool-results.js";
import {
  authoringCommandRoute,
  authoringCommandRouteFromLegacyAgentRun,
} from "./authoring-command-routing.js";
import {
  experienceAllowsAuthoring,
  experienceAllowsConnectedApps,
  experienceAllowsProfileSkills,
  sessionUsesRepositoryWork,
} from "./experience-policy.js";

export * from "./turns/public-api.js";

function parseUserQuestionResolution(
  value: unknown,
  priorEvents: RuntimeEvent[]
): SessionUserQuestionResolution | null {
  if (value === undefined) return null;
  const parsed = SessionUserQuestionResolutionSchema.parse(value);
  const asked = priorEvents.find((runtimeEvent) => {
    if (runtimeEvent.name !== "user_question.asked") return false;
    const data =
      runtimeEvent.data &&
      typeof runtimeEvent.data === "object" &&
      !Array.isArray(runtimeEvent.data)
        ? (runtimeEvent.data as Record<string, unknown>)
        : null;
    const question =
      data?.question &&
      typeof data.question === "object" &&
      !Array.isArray(data.question)
        ? (data.question as Record<string, unknown>)
        : null;
    return question?.id === parsed.questionId;
  });
  if (!asked)
    throw new Error(`Pending user question not found: ${parsed.questionId}`);
  const alreadyResolved = priorEvents.some((runtimeEvent) => {
    if (
      runtimeEvent.name !== "user_question.answered" &&
      runtimeEvent.name !== "user_question.dismissed"
    ) {
      return false;
    }
    const data =
      runtimeEvent.data &&
      typeof runtimeEvent.data === "object" &&
      !Array.isArray(runtimeEvent.data)
        ? (runtimeEvent.data as Record<string, unknown>)
        : null;
    const resolution =
      data?.resolution &&
      typeof data.resolution === "object" &&
      !Array.isArray(data.resolution)
        ? (data.resolution as Record<string, unknown>)
        : null;
    return resolution?.questionId === parsed.questionId;
  });
  if (alreadyResolved)
    throw new Error(`User question is already resolved: ${parsed.questionId}`);

  const askedData =
    asked.data && typeof asked.data === "object" && !Array.isArray(asked.data)
      ? (asked.data as Record<string, unknown>)
      : {};
  const askedQuestion =
    askedData.question &&
    typeof askedData.question === "object" &&
    !Array.isArray(askedData.question)
      ? (askedData.question as Record<string, unknown>)
      : {};
  const options = Array.isArray(askedQuestion.options)
    ? askedQuestion.options
    : [];
  if (
    parsed.action === "answer" &&
    parsed.optionId &&
    !options.some(
      (option) =>
        option &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        (option as Record<string, unknown>).id === parsed.optionId
    )
  ) {
    throw new Error(`Question option not found: ${parsed.optionId}`);
  }
  if (parsed.action === "answer" && !parsed.text && !parsed.optionId) {
    throw new Error("A user-question answer requires text or an option.");
  }
  return parsed;
}

function promptWithUserQuestionResolution(
  prompt: string,
  resolution: SessionUserQuestionResolution | null
): string {
  if (!resolution) return prompt;
  const structured =
    resolution.action === "answer"
      ? [
          `The user explicitly answered pending question ${resolution.questionId}.`,
          resolution.optionId
            ? `Selected option ID: ${resolution.optionId}.`
            : null,
          resolution.text ? `Answer: ${resolution.text}` : null,
          "Continue the same task using this answer.",
        ]
      : [
          `The user explicitly dismissed pending question ${resolution.questionId}.`,
          "Continue only if the task can proceed safely without that answer; otherwise explain the blocker.",
        ];
  return `${prompt}\n\n[OpenPond question resolution]\n${structured
    .filter(Boolean)
    .join("\n")}`;
}

export function createTurnRunner(deps: TurnRunnerDependencies): TurnRunner {
  const {
    attachmentRootDir,
    store,
    resolveCreateImproveTaskset,
    gradeCreateImproveTaskAttempt,
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
    processHarnessImprovementBoundary,
    executeWorkspaceTool,
    forkSandboxForSubagent,
    cleanupSandboxForSubagent,
    finalizeWorkTurn,
    workInputsForSession,
    executeOpenPondCommand,
    executeProfileAction,
    executeProjectAction,
    executeDatasetBuilderAction,
    loadOpenPondProfileState,
    loadOpenPondProfileStateForRef,
    loadOpenPondProfileLibrary,
    readOpenPondProfileSkill,
    loadSelectedHarnessRuntime,
    ensureHarnessRunOverlay,
    loadOpenPondExtensionCatalog,
    readOpenPondExtensionSkill,
    executeProfileSkillCommand,
    executeWebSearch,
    createScheduledWork,
    executeConnectedAppTool,
    browserToolExecutor,
    manageSidebarFile,
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
    planCreateImprove,
    turnFollowUpQueue,
    subagentQueue,
    notifySubagentRunStateChanged,
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests,
  } = deps;
  const hostedToolFlags = resolveHostedToolRolloutFlags(deps.hostedToolFlags);
  const activeTurns = new ActiveTurnRegistry();
  const subagentParentWakeJobs = new KeyedRegistry<BackgroundWorkReceipt>(
    "subagent parent wake job"
  );
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
  async function processHarnessImprovementBoundarySafely(input: {
    session: Session;
    turn: Turn;
    boundaryKind: import("@openpond/contracts").ImprovementSafeBoundaryKind;
  }): Promise<void> {
    if (!processHarnessImprovementBoundary || !input.turn.harnessSnapshot) return;
    try {
      await processHarnessImprovementBoundary(input);
    } catch (error) {
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turn.id,
          name: "diagnostic",
          source: "server",
          appId: input.session.appId,
          status: "failed",
          output: error instanceof Error ? error.message : String(error),
          data: { phase: "harness_improvement_boundary" },
        }),
      ).catch(() => undefined);
    }
  }

  async function getStoredTurn(turnId: string): Promise<Turn | null> {
    return store.getTurn(turnId);
  }

  function nativeToolsEnabledForProvider(provider: ChatProvider): boolean {
    return nativeToolTransportEnabledForProvider(hostedToolFlags, provider);
  }

  function browserControlAvailable(session: Session): boolean {
    return (
      browserToolExecutor?.available({
        sessionId: session.id,
        conversationId: session.id,
      }) ?? false
    );
  }

  function actionCatalogInstructionModeForProvider(
    provider: ChatProvider
  ): "text_fallback" | "native_tool" | "none" {
    if (
      nativeToolsEnabledForProvider(provider) &&
      hostedToolFlags.dynamicActionTools
    )
      return "native_tool";
    if (
      hostedToolInstructionModeForProvider(hostedToolFlags, provider) ===
      "full_text_fallback"
    )
      return "text_fallback";
    return "none";
  }

  async function insertStoredTurn(turn: Turn): Promise<void> {
    await store.insertTurn(turn);
  }

  async function updateStoredTurn(
    turnId: string,
    updater: (turn: Turn) => Turn
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
    latestTurnForSession: (sessionId, status) =>
      store.latestTurnForSession(sessionId, status),
    interruptTurn,
  });
  const turnRunnerLifecycle = createTurnRunnerLifecycle({
    activeTurns,
    interruptActiveTurn,
    jobRegistries: [subagentParentWakeJobs],
    queues: [turnFollowUpQueue, ...(subagentQueue ? [subagentQueue] : [])],
  });

  const subagentRepositoryRuntime = createSubagentRepositoryRuntime({
    createSession,
    queue: subagentQueue,
    upsertRun: store.upsertSubagentRun
      ? (run) => store.upsertSubagentRun!(run)
      : undefined,
    getRun: store.getSubagentRun
      ? (runId) => store.getSubagentRun!(runId)
      : undefined,
    listRuns: store.listSubagentRuns
      ? (query) => store.listSubagentRuns!(query)
      : undefined,
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
  const upsertSubagentRunAndNotify =
    subagentRepositoryRuntime.upsertRunAndNotify;
  const appendSubagentReceipt = subagentRepositoryRuntime.appendReceipt;

  const createImproveRuntime = createCreateImproveRuntime({
    getSession,
    getTurn: getStoredTurn,
    updateTurn: updateStoredTurn,
    getCreateImproveRun: (runId) => store.getCreateImproveRun(runId),
    listCreateImproveRuns: (query) => store.listCreateImproveRuns(query),
    upsertCreateImproveRun: (run) => store.upsertCreateImproveRun(run),
    mutateCreateImproveRun: (action, updater) =>
      store.mutateCreateImproveRun(action, updater),
    getApproval: (approvalId) => store.getApproval(approvalId),
    upsertApproval,
    appendRuntimeEvent,
    ensureCodexRuntime,
    runLocalCreatePipelineChecks,
    planCreateImprove,
    turnFollowUpQueue,
    streamLocalByokChatTurn,
    streamOpenPondHostedChatTurn,
    upsertModelUsageRecord: safeUpsertModelUsageRecord,
    resolveTaskset: resolveCreateImproveTaskset,
    gradeTaskAttempt: gradeCreateImproveTaskAttempt,
  });
  const {
    applyCreateImproveActionPayload,
    getCreateImproveRun,
    listCreateImproveRuns,
    persistCreateImprovePlanningFailure,
    persistCreateImproveRun,
    planCreateImproveForTurn,
    resolveCreateImproveApproval,
  } = createImproveRuntime;
  const handleCreateImproveTurn = createCreateImproveTurnHandler({
    appendRuntimeEvent,
    planCreateImproveForTurn,
    persistCreateImproveRun,
    completeTurn,
  });
  const handleProfileSkillCommand = createProfileSkillCommandRuntime({
    appendRuntimeEvent,
    completeTurn,
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
    executeNativeToolCalls,
    explicitProfileSkillNames,
    profileSkillBodyFromReadResult,
    readProfileSkillForModel,
  } = createNativeToolRuntime({
    maxRepeatedInvalidToolRequests,
    appendRuntimeEvent,
    throwIfInterrupted,
  });
  const {
    loadProfileSkillRuntime,
    preloadExplicitProfileSkills,
    profileSkillInstructionModeForProvider,
  } = createProfileSkillCatalogRuntime({
    loadProfileState: loadOpenPondProfileStateForRef
      ? (session) => loadOpenPondProfileStateForRef(session.currentProfile)
      : loadOpenPondProfileState
      ? () => loadOpenPondProfileState()
      : undefined,
    readProfileSkill: readOpenPondProfileSkill,
    loadBuiltInSkills: deps.loadBuiltInOpenPondSkills,
    readBuiltInSkill: deps.readBuiltInOpenPondSkill,
    loadExtensionCatalog: loadOpenPondExtensionCatalog,
    readExtensionSkill: readOpenPondExtensionSkill,
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
    runtimeEventsForSession: (sessionId, query) =>
      store.runtimeEventsForSession(sessionId, query),
    getSession,
    recordTurnToolCatalog: async ({ turnId, hash, capabilities }) => {
      const checkpointTurn = await getStoredTurn(turnId);
      const compactionEvent = checkpointTurn
        ? (await store.runtimeEventsForSession(checkpointTurn.sessionId, {
            names: ["session.compaction.completed"],
            limit: 1_000,
          })).filter((runtimeEvent) => runtimeEvent.turnId === turnId).at(-1) ?? null
        : null;
      const compactionData = compactionEvent?.data && typeof compactionEvent.data === "object" &&
        !Array.isArray(compactionEvent.data)
        ? compactionEvent.data as Record<string, unknown>
        : null;
      await store.updateTurn(turnId, (turn) => {
        const checkpoint = AgentCheckpointSchema.parse({
          protocolVersion: AGENT_PROTOCOL_VERSION,
          threadId: turn.sessionId,
          turnId: turn.id,
          harnessReleaseHash: turn.harnessSnapshot?.harnessRelease.contentHash ??
            canonicalHash({ harnessRelease: null }),
          toolCatalogHash: hash,
          context: {
            stage: "tool_catalog_ready",
            provider: turn.modelRef?.providerId ?? null,
            model: turn.modelRef?.modelId ?? null,
            compaction: compactionData
              ? {
                  eventId: compactionEvent?.id ?? null,
                  compactedThroughEventId: compactionData.compactedThroughEventId ?? null,
                  compactedThroughTurnId: compactionData.compactedThroughTurnId ?? null,
                  summaryHash: typeof compactionData.summary === "string"
                    ? canonicalHash(compactionData.summary)
                    : null,
                }
              : null,
          },
          pendingInteraction: null,
          usage: {},
        });
        return {
          ...turn,
          metadata: {
            ...turn.metadata,
            toolCatalogHash: hash,
            toolCapabilities: capabilities,
            agentCheckpoint: checkpoint,
            agentCheckpointHash: checkpointHash(checkpoint),
          },
          harnessSnapshot: turn.harnessSnapshot
            ? { ...turn.harnessSnapshot, toolCatalogHash: hash }
            : turn.harnessSnapshot,
        };
      });
    },
    getTaskset: store.getTaskset
      ? (tasksetId) => store.getTaskset!(tasksetId)
      : undefined,
    appendHostedContextUsage,
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests,
    appendRuntimeEvent,
    upsertModelUsageRecord: safeUpsertModelUsageRecord,
    executeNativeToolCalls,
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
    requireSubagentPersistence: () => ({
      upsertRun: requireSubagentDeps().upsertRun,
    }),
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
      ? (sessionId, query) =>
          store.persistedRuntimeEventsForSession!(sessionId, query)
      : (sessionId, query) => store.runtimeEventsForSession(sessionId, query),
    latestAssistantTextForSession: (sessionId) =>
      store.latestAssistantTextForSession(sessionId),
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
    getSession,
    latestTurnForSession: (sessionId) =>
      store.latestPersistedTurnForSession(sessionId),
    appendRuntimeEvent,
    appendSubagentReceipt,
    getActiveTurn: (sessionId) => {
      const active = activeTurns.get(sessionId);
      return active ? { sessionId, turn: { id: active.turn.id } } : null;
    },
    interruptActiveTurn: (active, reason) => {
      const current = activeTurns.get(active.sessionId);
      if (!current)
        throw new Error(`No active turn for session ${active.sessionId}`);
      return interruptActiveTurn(current, reason);
    },
  });
  const { notifyParentOfSubagentCompletion, recoverPendingCompletions } =
    createSubagentCompletionRuntime({
      appendMessage: (message) => requireSubagentDeps().appendMessage(message),
      listMessages: store.listSubagentMessages
        ? (input) => store.listSubagentMessages!(input)
        : async () => [],
      getRun: (runId) => requireSubagentDeps().getRun(runId),
      listRuns: (input) => requireSubagentDeps().listRuns(input),
      upsertRun: upsertSubagentRunAndNotify,
      getSession,
      hasParentWakeTurn: (sessionId, messageId) =>
        store.hasSubagentParentWakeTurn(sessionId, messageId),
      appendRuntimeEvent,
      turnFollowUpQueue,
      parentWakeJobs: subagentParentWakeJobs,
      getActiveTurn: (sessionId) => {
        const active = activeTurns.get(sessionId);
        return active ? { sessionId, turn: { id: active.turn.id } } : null;
      },
      sendTurn,
    });
  const { resolveSubagentPatchApplyApproval } =
    createSubagentPatchApprovalRuntime({
      getApproval: (approvalId) => store.getApproval(approvalId),
      getSubagentRun: store.getSubagentRun
        ? (runId) => store.getSubagentRun!(runId)
        : null,
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
    latestTurnForSession: (sessionId) =>
      store.latestPersistedTurnForSession(sessionId),
    latestAssistantTextForSession: (sessionId) =>
      store.latestAssistantTextForSession(sessionId),
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
  const { archiveSubagentChildSession, subagentLifecycleActionNextStep } =
    createSubagentLifecycleRuntime({
      getRun: (runId) => requireSubagentDeps().getRun(runId),
      upsertRun: (run) => requireSubagentDeps().upsertRun(run),
      getSession,
      updateSession,
      appendSubagentReceipt,
    });
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
      startSubagent: startSubagentFromModelTool,
      statusSubagents: statusSubagentsFromModelTool,
      joinSubagent: joinSubagentFromModelTool,
      cancelSubagent: cancelSubagentFromModelTool,
      followupSubagent: followupSubagentFromModelTool,
      sendSubagentMessage: sendSubagentMessageFromModelTool,
      ...(manageSidebarFile
        ? {
            manageSidebarFile: (context, input) =>
              manageSidebarFile({
                session: context.session,
                action: input.action,
                path: input.path,
              }),
          }
        : {}),
      ...(executeDatasetBuilderAction
        ? {
            runDatasetBuilder: (context, action, input) =>
              executeDatasetBuilderAction({
                session: context.session,
                provider: context.provider,
                model: context.model,
                action,
                payload: input,
              }),
          }
        : {}),
    },
    subagentToolsAvailable,
    hostedToolFlags,
    executeConnectedAppTool,
    browserToolExecutor,
    executeOpenPondCommand,
    executeWorkspaceTool,
    executeWebSearch,
    createScheduledWork,
    executeProfileAction,
    executeProjectAction,
    loadOpenPondProfileStateForRef,
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
      trainingHarness?: {
        taskId: string;
        actionBindings: import("@openpond/contracts").HarnessActionBinding[];
      };
      workInputs?: ReadonlyArray<{
        localPath?: string;
        storageName?: string;
      }>;
    } = {}
  ) {
    return [
      ...capabilityCatalogDefinitions(
      openPondActionCatalog,
      runtimeEvents,
      profileSkillRuntime,
      connectedApps,
      options
      ),
      ...(deps.harnessModelTools ?? []),
    ];
  }
  async function sendTurn(sessionId: string, payload: unknown): Promise<Turn> {
    const finish = turnRunnerLifecycle.beginSendTurn();
    try {
      return await executeTurn(sessionId, payload);
    } finally {
      finish();
    }
  }

  async function executeTurn(
    sessionId: string,
    payload: unknown
  ): Promise<Turn> {
    const input = SendTurnRequestSchema.parse(payload);
    let turnPermissions = turnPermissionsFromSendTurnInput(input);
    const existingTurn =
      (await activeInProgressTurn(sessionId)) ??
      (await findInProgressTurn(sessionId));
    if (existingTurn) {
      throw new Error("A turn is already running for this chat.");
    }
    let session = await getSession(sessionId);
    let workTurnFinalizationAttempted = false;
    session = {
      ...session,
      experience: session.experience ?? DEFAULT_SESSION_EXPERIENCE,
    };
    async function finalizeAttachedWorkSandbox(
      turnId: string,
      outcome: "completed" | "failed" | "interrupted"
    ): Promise<void> {
      if (
        workTurnFinalizationAttempted ||
        session.experience !== "work" ||
        !finalizeWorkTurn
      ) {
        return;
      }
      workTurnFinalizationAttempted = true;
      session = await finalizeWorkTurn({
        session: await getSession(sessionId),
        turnId,
        outcome,
      });
    }
    const requestedProvider =
      input.modelRef?.providerId ??
      session.modelRef?.providerId ??
      session.provider;
    if (requestedProvider === "codex" && !sessionUsesRepositoryWork(session)) {
      throw new Error("The Codex provider requires repository-aware Work.");
    }
    if (
      /^\/goal(?:\s|$)/i.test(input.prompt.trimStart()) &&
      (requestedProvider !== "codex" || !sessionUsesRepositoryWork(session))
    ) {
      throw new Error(
        "/goal is only available in repository-aware Work with the Codex provider."
      );
    }
    const selectedProfileRef =
      session.currentProfile ??
      (loadOpenPondProfileLibrary
        ? (await loadOpenPondProfileLibrary()).lastUsed
        : null);
    if (!session.currentProfile && selectedProfileRef) {
      session = await updateSession(sessionId, {
        currentProfile: selectedProfileRef,
      });
    }
    const selectedProfile = loadOpenPondProfileStateForRef
      ? await loadOpenPondProfileStateForRef(selectedProfileRef)
      : loadOpenPondProfileState
      ? await loadOpenPondProfileState()
      : null;
    // Resolve the movable current channel exactly once at turn admission. All
    // later Skill reads use this immutable bundle even if another Work advances
    // the channel while this turn is running.
    const selectedHarness = loadSelectedHarnessRuntime
      ? await loadSelectedHarnessRuntime(session)
      : null;
    const admittedHarnessOverlay =
      selectedHarness && ensureHarnessRunOverlay
        ? await ensureHarnessRunOverlay({
            runId: session.id,
            workspace: selectedHarness.workspace,
            harnessRelease: {
              id: selectedHarness.release.harnessRelease.id,
              contentHash: selectedHarness.release.harnessRelease.contentHash,
            },
            admittedAt: now(),
          })
        : null;
    let subagentContinuation = await prepareSubagentContinuationTurn({
      session,
      request: input,
      requestedTurnPermissions: turnPermissions,
    });
    if (subagentContinuation)
      turnPermissions = subagentContinuation.turnPermissions;
    const activeProvider =
      input.modelRef?.providerId ??
      session.modelRef?.providerId ??
      session.provider;
    const activeModelId =
      input.modelRef?.modelId ??
      input.model ??
      session.modelRef?.modelId ??
      null;
    const appPreferences =
      nativeToolsEnabledForProvider(activeProvider) && subagentToolsAvailable()
        ? await loadAppPreferences()
        : null;
    const subagentDelegation = resolveSubagentDelegation(
      session,
      appPreferences
    );
    const turnModelRef: ChatModelRef | null = activeModelId
      ? { providerId: activeProvider, modelId: activeModelId }
      : input.modelRef ?? session.modelRef ?? null;
    const legacyAgentAuthoringRoute = input.createImproveRun
      ? authoringCommandRouteFromLegacyAgentRun(input.createImproveRun)
      : null;
    const authoringRoute =
      authoringCommandRoute(input.prompt) ?? legacyAgentAuthoringRoute;
    if (authoringRoute && !experienceAllowsAuthoring(session)) {
      throw new Error(
        "Agent and Skill authoring are available in repository-aware Work."
      );
    }
    const activeCreateImproveRun = legacyAgentAuthoringRoute
      ? null
      : input.createImproveRun;
    const profileSkillCommand =
      !authoringRoute &&
      experienceAllowsProfileSkills(session.experience) &&
      executeProfileSkillCommand
        ? await executeProfileSkillCommand({
            prompt: input.prompt,
            profileRef: selectedProfileRef,
          })
        : null;
    const priorEvents = await store.runtimeEventsForSession(sessionId);
    const userQuestionResolution = parseUserQuestionResolution(
      input.metadata?.userQuestionResolution,
      priorEvents
    );

    const startedAt = now();
    const effectiveUsageAttribution =
      input.usageAttribution ?? subagentContinuation?.usageAttribution ?? null;
    const createImproveMetadata = {
      ...(input.metadata ? input.metadata : {}),
      ...(subagentDelegation ? { subagentDelegation } : {}),
      ...(effectiveUsageAttribution
        ? { usageAttribution: effectiveUsageAttribution }
        : {}),
      ...(activeCreateImproveRun
        ? { createImproveRun: activeCreateImproveRun }
        : {}),
      ...(authoringRoute
        ? {
            authoringIntent: authoringRoute.intent,
            selectedProfileRef,
          }
        : {}),
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
      metadata: createImproveMetadata,
      createImproveRun: activeCreateImproveRun ?? null,
      profileSnapshot:
        selectedProfileRef &&
        selectedProfile &&
        selectedProfile.mode !== "none" &&
        !selectedProfile.error
          ? {
              ref: selectedProfileRef,
              revision: selectedProfile.git?.head ?? null,
              sourceHash: createHash("sha256")
                .update(
                  JSON.stringify({
                    profile: selectedProfile.activeProfile,
                    revision: selectedProfile.git?.head ?? null,
                    agents: selectedProfile.agents,
                    skills: selectedProfile.skills.map((skill) => [
                      skill.name,
                      skill.sourceHash,
                    ]),
                    actions: selectedProfile.actionCatalog.map(
                      (action) => action.id
                    ),
                  })
                )
                .digest("hex"),
            }
          : null,
      harnessSnapshot: selectedHarness
        ? {
            schemaVersion: "openpond.harnessTurnSnapshot.v1",
            workspaceId: selectedHarness.workspace.id,
            workspaceRevision: selectedHarness.workspace.revision,
            sourceRevision: selectedHarness.workspace.sourceRevision,
            channelName: selectedHarness.workspace.currentChannel.name,
            channelRevision: selectedHarness.workspace.currentChannel.revision,
            harnessRelease: {
              id: selectedHarness.release.harnessRelease.id,
              contentHash: selectedHarness.release.harnessRelease.contentHash,
            },
            overlay: admittedHarnessOverlay
              ? {
                  id: admittedHarnessOverlay.id,
                  revision: admittedHarnessOverlay.revision,
                  contentHash: admittedHarnessOverlay.contentHash,
                }
              : null,
          }
        : null,
    };
    await insertStoredTurn(turn);
    const initialCwd =
      (authoringRoute && selectedProfile?.mode === "local"
        ? selectedProfile.repoPath
        : null) ??
      input.cwd ??
      (await resolveSessionWorkspaceCwd(session, { ensureOpenPond: false })) ??
      session.cwd ??
      (session.appId || activeProvider === "codex"
        ? defaultSessionCwd(session.appId)
        : null);
    session = await updateSession(sessionId, {
      experience: session.experience,
      provider: activeProvider,
      modelRef: turnModelRef,
      status: "active",
      title:
        session.title === "New chat"
          ? input.prompt.slice(0, 64)
          : session.title,
      cwd: initialCwd,
    });
    const controller = new AbortController();
    const activeTurn: ActiveTurn = {
      session,
      turn,
      controller,
      ...createActiveTurnSettlement(),
    };
    turnRunnerLifecycle.registerActiveTurn(sessionId, activeTurn);
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
      const workInputs =
        session.experience === "work"
          ? [
              ...(workInputsForSession
                ? await workInputsForSession(session)
                : []),
              ...attachmentContexts,
            ]
          : undefined;
      const attachmentContext = chatAttachmentContext(attachmentContexts);
      const providerPrompt = formatPromptWithAttachmentContext(
        promptWithUserQuestionResolution(input.prompt, userQuestionResolution),
        attachmentContext
      );
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
            ...createImproveMetadata,
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
      if (userQuestionResolution) {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name:
              userQuestionResolution.action === "answer"
                ? "user_question.answered"
                : "user_question.dismissed",
            source: "ui_button",
            action: "ask_user",
            appId: session.appId,
            status: "completed",
            output:
              userQuestionResolution.action === "answer"
                ? userQuestionResolution.text
                : "Question dismissed.",
            data: { resolution: userQuestionResolution },
          })
        );
      }
      if (profileSkillCommand) {
        return handleProfileSkillCommand({
          session,
          turn,
          command: profileSkillCommand,
        });
      }
      if (activeCreateImproveRun) {
        return await handleCreateImproveTurn({
          session,
          turn,
          run: activeCreateImproveRun,
          signal: controller.signal,
        });
      }
      const initialWorkspaceDiff = await workspaceDiffBaseline(session);
      const mentionedApps =
        sessionUsesRepositoryWork(session)
          ? await resolveMentionedAppsForTurn(
              input.mentionedAppIds,
              findOpenPondApp
            )
          : [];
      const connectedApps = experienceAllowsConnectedApps(session.experience)
        ? await connectedAppsForTurn({
            refs: input.mentionedConnectedApps,
            prompt: providerPrompt,
            session,
            turnId: turn.id,
          })
        : [];
      session = await maybeCreateScaffoldForTurn(
        session,
        turn.id,
        providerPrompt
      );
      activeTurn.session = session;
      throwIfInterrupted(controller.signal);
      const personalizationSoul = await loadPersonalizationSoul();
      const shouldLoadProfileSkills =
        (selectedHarness !== null || experienceAllowsProfileSkills(session.experience)) &&
        (session.provider === "openpond" ||
          isOpenAiCompatibleProviderId(session.provider));
      if (authoringRoute && !shouldLoadProfileSkills) {
        throw new Error(
          `${
            authoringRoute.intent.artifact === "agent" ? "Agent" : "Skill"
          } authoring requires an OpenPond hosted-tool provider so the bundled authoring skill and validation tools are available.`
        );
      }
      const profileSkillRuntime: ProfileSkillRuntime = shouldLoadProfileSkills
          ? await loadProfileSkillRuntime({
            session,
            turnId: turn.id,
            profile: selectedProfile,
            harnessRuntime: selectedHarness?.skillRuntime ?? null,
          })
        : { profileSourcePath: null, skills: [], readSkill: null };
      const loadedProfileSkills = shouldLoadProfileSkills
        ? await preloadExplicitProfileSkills({
            session,
            turnId: turn.id,
            prompt: providerPrompt,
            selectedSkillNames: authoringRoute
              ? [authoringRoute.skillName]
              : [],
            runtime: profileSkillRuntime,
            signal: controller.signal,
          })
        : [];
      const extraSystemContext = [
        selectedHarness?.instructionContext ?? null,
        subagentSystemContextForSession(session, subagentDelegation),
      ].filter(Boolean).join("\n\n");
      if (session.provider === "openpond") {
        const providerTurnId = `openpond-${turn.id}`;
        const model =
          turnModelRef?.modelId || input.model || DEFAULT_OPENPOND_CHAT_MODEL;
        await updateStoredTurn(turn.id, (current) => ({
          ...current,
          providerTurnId,
        }));
        const systemPrompt = await hostedSystemPrompt(
          HOSTED_CHAT_SYSTEM_PROMPT,
          personalizationSoul,
          session,
          {
            mentionedApps,
            openPondActionCatalog:
              sessionUsesRepositoryWork(session)
                ? input.openPondActionCatalog
                : [],
            openPondProfileSkills: profileSkillRuntime.skills,
            loadedProfileSkills,
            connectedApps,
            toolInstructionMode: hostedToolInstructionModeForProvider(
              hostedToolFlags,
              "openpond"
            ),
            actionCatalogInstructionMode:
              actionCatalogInstructionModeForProvider("openpond"),
            profileSkillInstructionMode: profileSkillInstructionModeForProvider(
              "openpond",
              profileSkillRuntime
            ),
            browserControlAvailable:
              sessionUsesRepositoryWork(session) &&
              browserControlAvailable(session),
            extraSystemContext,
          }
        );
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
        const messages = buildChatMessagesForProvider(
          hostedPriorEvents,
          providerPrompt,
          systemPrompt
        );
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
          openPondActionCatalog:
            sessionUsesRepositoryWork(session)
              ? input.openPondActionCatalog ?? []
              : [],
          profileSkillRuntime,
          workInputs:
            workInputs,
          userPrompt: providerPrompt,
          workspaceDiffBaseline: initialWorkspaceDiff,
          signal: controller.signal,
          stream: async function* (loopMessages, options) {
            for await (const delta of streamOpenPondHostedChatTurn({
              model,
              messages: loopMessages,
              tools: options?.tools,
              toolChoice: options?.toolChoice,
              requestId: options?.requestId ?? turn.id,
              reasoningEffort: turnPermissions.codexReasoningEffort,
              signal: controller.signal,
            })) {
              if (delta.type === "text_delta" && delta.text)
                yield { text: delta.text, raw: delta.raw };
              if (delta.type === "reasoning_delta" && delta.text)
                yield { reasoningText: delta.text, raw: delta.raw };
              if (delta.type === "tool_call_delta")
                yield { toolCalls: delta.toolCalls, raw: delta.raw };
              if (delta.type === "usage")
                yield { raw: delta.raw, usage: delta.usage };
              if (delta.type === "finish")
                yield { finishReason: delta.finishReason, raw: delta.raw };
            }
          },
        });
        await finalizeAttachedWorkSandbox(turn.id, "completed");
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
        const completed = await completeTurn(sessionId, turn.id, providerTurnId);
        await processHarnessImprovementBoundarySafely({
          session,
          turn: completed,
          boundaryKind: "turn_completed",
        });
        return completed;
      }

      if (isOpenAiCompatibleProviderId(session.provider)) {
        const providerTurnId = `${session.provider}-${turn.id}`;
        const model = turnModelRef?.modelId ?? input.model ?? null;
        const providerSettings = loadProviderSettings
          ? await loadProviderSettings()
          : null;
        const runtimeModel =
          model ??
          providerSettings?.providers[session.provider]?.defaultModel ??
          providerSettings?.modelCaches[session.provider]?.models.find(
            (candidate) => candidate.id.trim()
          )?.id ??
          null;
        const contextLimitTokens = trustedProviderContextLimit({
            provider: session.provider,
            model: runtimeModel,
            settings: providerSettings,
          });
        await updateStoredTurn(turn.id, (current) => ({
          ...current,
          providerTurnId,
        }));
        const systemPrompt = await hostedSystemPrompt(
                HOSTED_CHAT_SYSTEM_PROMPT,
                personalizationSoul,
                session,
                {
                  mentionedApps,
                  openPondActionCatalog:
                    sessionUsesRepositoryWork(session)
                      ? input.openPondActionCatalog
                      : [],
                  openPondProfileSkills: profileSkillRuntime.skills,
                  loadedProfileSkills,
                  connectedApps,
                  toolInstructionMode: hostedToolInstructionModeForProvider(
                    hostedToolFlags,
                    session.provider
                  ),
                  actionCatalogInstructionMode:
                    actionCatalogInstructionModeForProvider(session.provider),
                  profileSkillInstructionMode:
                    profileSkillInstructionModeForProvider(
                      session.provider,
                      profileSkillRuntime
                    ),
                  browserControlAvailable:
                    sessionUsesRepositoryWork(session) &&
                    browserControlAvailable(session),
                  extraSystemContext,
                }
              );
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
                  throw new Error(
                    `Provider ${session.provider} is not configured for local BYOK chat.`
                  );
                }
                for await (const delta of streamLocalByokChatTurn({
                  providerId: session.provider,
                  modelId: runtimeModel,
                  messages: streamInput.messages,
                  requestId: streamInput.requestId,
                  reasoningEffort: turnPermissions.codexReasoningEffort,
                  signal: streamInput.signal ?? controller.signal,
                })) {
                  if (delta.text) yield { text: delta.text, raw: delta.raw };
                  if (delta.reasoningText)
                    yield {
                      reasoningText: delta.reasoningText,
                      raw: delta.raw,
                    };
                  if (delta.usage) yield { usage: delta.usage, raw: delta.raw };
                }
              },
            });
        const messages = buildChatMessagesForProvider(
          hostedPriorEvents,
          providerPrompt,
          systemPrompt
        );
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
          openPondActionCatalog:
            sessionUsesRepositoryWork(session)
              ? input.openPondActionCatalog ?? []
              : [],
          profileSkillRuntime,
          workInputs:
            workInputs,
          userPrompt: providerPrompt,
          workspaceDiffBaseline: initialWorkspaceDiff,
          signal: controller.signal,
          stream: async function* (loopMessages, options) {
            if (!streamLocalByokChatTurn) {
              throw new Error(
                `Provider ${session.provider} is not configured for local BYOK chat.`
              );
            }
            for await (const delta of streamLocalByokChatTurn({
              providerId: session.provider,
              modelId: runtimeModel,
              messages: loopMessages,
              tools: options?.tools,
              toolChoice: options?.toolChoice,
              requestId: options?.requestId ?? turn.id,
              signal: controller.signal,
            })) {
              if (delta.text) yield { text: delta.text, raw: delta.raw };
              if (delta.reasoningText)
                yield { reasoningText: delta.reasoningText, raw: delta.raw };
              if (delta.continuation)
                yield { continuation: delta.continuation, raw: delta.raw };
              if (delta.toolCalls)
                yield { toolCalls: delta.toolCalls, raw: delta.raw };
              if (delta.usage) yield { raw: delta.raw, usage: delta.usage };
              if (delta.finishReason !== undefined)
                yield { finishReason: delta.finishReason, raw: delta.raw };
            }
          },
        });
        await finalizeAttachedWorkSandbox(turn.id, "completed");
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
        const completed = await completeTurn(sessionId, turn.id, providerTurnId);
        await processHarnessImprovementBoundarySafely({
          session,
          turn: completed,
          boundaryKind: "turn_completed",
        });
        return completed;
      }

      if (session.provider !== "codex")
        throw new Error(`Unsupported provider: ${session.provider}`);
      const codexModel = turnModelRef?.modelId ?? input.model ?? null;
      const turnCwd =
        input.cwd ??
        (await resolveSessionWorkspaceCwd(session, {
          ensureOpenPond: session.workspaceKind !== "local_project",
        })) ??
        session.cwd;
      if (turnCwd && turnCwd !== session.cwd)
        session = await updateSession(session.id, { cwd: turnCwd });
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
        prompt: codexPromptWithHarnessContext(providerPrompt, extraSystemContext),
        cwd: turnCwd ?? session.cwd,
        model: codexModel,
        approvalPolicy: turnPermissions.approvalPolicy,
        sandbox: turnPermissions.sandbox,
      });
      activeTurn.codexTurnId = providerTurn.turnId;
      if (controller.signal.aborted) {
        await runtime.client
          .interruptTurn({
            threadId: runtime.threadId,
            turnId: providerTurn.turnId,
          })
          .catch(() => undefined);
        throw interruptedError();
      }
      await updateStoredTurn(turn.id, (current) => ({
        ...current,
        providerTurnId: providerTurn.turnId,
      }));
      await Promise.race([
        runtime.client.waitForTurn(providerTurn.turnId),
        waitForInterrupt(controller.signal),
      ]);
      await appendWorkspaceDiffEvent(session, turn.id, {
        baseline: initialWorkspaceDiff,
      });
      const completed = await completeTurn(sessionId, turn.id, providerTurn.turnId);
      await processHarnessImprovementBoundarySafely({
        session,
        turn: completed,
        boundaryKind: "turn_completed",
      });
      return completed;
    } catch (error) {
      const interrupted =
        controller.signal.aborted || (await turnWasInterrupted(turn.id));
      try {
        await finalizeAttachedWorkSandbox(
          turn.id,
          interrupted ? "interrupted" : "failed"
        );
      } catch (finalizationError) {
        if (workTurnFinalizationAttempted) {
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "diagnostic",
              source: "server",
              appId: session.appId,
              status: "failed",
              output:
                finalizationError instanceof Error
                  ? finalizationError.message
                  : String(finalizationError),
              data: { phase: "work_turn_finalization" },
            })
          );
        }
      }
      if (interrupted) {
        const paused = await interruptTurn(
          session,
          turn.id,
          activeTurn.interruptionReason ?? "Stopped by user"
        );
        await processHarnessImprovementBoundarySafely({
          session,
          turn: paused,
          boundaryKind: "turn_paused",
        });
        return paused;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (activeCreateImproveRun) {
        await persistCreateImprovePlanningFailure({
          session,
          turn,
          run: activeCreateImproveRun,
          message,
        }).catch(() => undefined);
      }
      const failed = await failTurn(session, turn.id, message);
      await processHarnessImprovementBoundarySafely({
        session,
        turn: failed,
        boundaryKind: "turn_completed",
      });
      return failed;
    } finally {
      await finalizeSubagentContinuationTurn({
        context: subagentContinuation,
        childSession: session,
        childTurnId: turn.id,
      }).catch(() => undefined);
      if (activeTurns.get(sessionId)?.turn.id === turn.id)
        activeTurns.delete(sessionId);
      activeTurn.settle();
    }
  }

  return {
    sendTurn,
    isSessionTurnActive: (sessionId: string) => activeTurns.has(sessionId),
    waitForSessionTurnSettlement: async (sessionId: string) => {
      await activeTurns.get(sessionId)?.settled;
    },
    interruptSessionTurn,
    interruptAll: turnRunnerLifecycle.interruptAll,
    close: turnRunnerLifecycle.close,
    applyCreateImproveAction: applyCreateImproveActionPayload,
    getCreateImproveRun,
    listCreateImproveRuns,
    resolveCreateImproveApproval,
    resolveSubagentPatchApplyApproval,
    runSubagentLifecycleAction,
    recoverPendingSubagentCompletions: recoverPendingCompletions,
    cleanupExpiredRetainedSubagentWorkspace,
  };
}

function codexPromptWithHarnessContext(
  userPrompt: string,
  harnessContext: string,
): string {
  if (!harnessContext.trim()) return userPrompt;
  return [
    "<openpond_trusted_runtime_context>",
    harnessContext,
    "</openpond_trusted_runtime_context>",
    "",
    "<user_request>",
    userPrompt,
    "</user_request>",
  ].join("\n");
}
