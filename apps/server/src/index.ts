#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CompactSessionRequestSchema,
  InsightsAskRequestSchema,
  PatchInsightRequestSchema,
  RunSessionCommandRequestSchema,
  type Approval,
  type ChatProvider,
  type CodexStatus,
  type InsightStatus,
  type InsightsListResponse,
  type InsightsScanResponse,
  type ModelUsageRecord,
  type RuntimeEvent,
  type ServerStatus,
  type SubagentRun,
} from "@openpond/contracts";
import { detectCodexStatus } from "@openpond/codex-provider";
import { loadOpenPondProfileState, readProfileSkill, runProfileSkillCommandFromPrompt, runProfileSkillGoalCommand } from "@openpond/cloud";
import {
  getBundledRuntimeVersion,
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";
import { DEFAULT_HOST, DEFAULT_PORT, VERSION } from "./constants.js";
import { runOpenPondServerCli } from "./cli.js";
import { createHostedTurnHelpers } from "./openpond/hosted-turn-helpers.js";
import { runHostedContextCompaction } from "./openpond/context-compaction/index.js";
import { resolveContextCompactionAdapter } from "./openpond/context-adapter.js";
import { trustedProviderContextLimit } from "./openpond/context-usage.js";
import { createLogger } from "./logger.js";
import {
  appDataDir,
  ensureCapabilityToken,
  providersConfigPath,
  providerSecretsConfigPath,
  providerSecretsKeyPath,
} from "./paths.js";
import { loadPersonalizationSettings } from "./openpond/personalization.js";
import { createRuntimeEventBus } from "./runtime/runtime-event-bus.js";
import { SqliteStore } from "./store/store.js";
import type {
  OpenPondServerInstance,
  OpenPondServerOptions,
  RuntimeCodexSession,
} from "./types.js";
import { event, isCliEntrypoint, now } from "./utils.js";
import {
  checkWorkspaceGitAvailability,
  startMacOSCommandLineToolsInstall,
} from "./workspace/workspaces.js";
import { readLocalImageFile } from "./workspace/workspace-common.js";
import { createCodexBridge } from "./runtime/codex-bridge.js";
import { createCodexRuntimeManager } from "./runtime/codex-runtime.js";
import { createServerPayloads } from "./api/server-payloads.js";
import {
  runtimeEventPageRequestFromUrl,
  runtimeEventsPagePayloadFromEntries,
} from "./api/event-page.js";
import { usageRecordsPayload, usageSummaryPayload } from "./api/usage-payloads.js";
import { readProvidersFile } from "./openpond/provider-settings.js";
import { buildProviderSettings } from "./openpond/provider-registry.js";
import { cachedProviderCatalog } from "./openpond/provider-catalog.js";
import {
  readProviderSecrets,
  writeProviderChatGptSubscriptionCredential,
} from "./openpond/provider-secrets.js";
import { streamOpenAiCompatibleChatCompletion } from "./openpond/openai-compatible-provider.js";
import { createWebSearchExecutorFromEnv } from "./openpond/web-search.js";
import { createCloudConnectedAppToolExecutor } from "./openpond/connected-app-executor.js";
import { createOpenPondCommandAccessService } from "./openpond/command-access.js";
import { runOpenPondDirectCommand } from "./openpond/direct-command.js";
import { isCodexHistorySessionId } from "./codex-history.js";
import { createSessionStore } from "./store/session-store.js";
import { createOpenPondHttpSurface, listenOpenPondHttpServer } from "./api/server-http.js";
import { createServerWorkQueues } from "./runtime/background-worker-queue.js";
import { createTurnRunner } from "./runtime/turn-runner.js";
import { createSubagentLifecycleWatcher } from "./runtime/subagent-lifecycle-watcher.js";
import { startProviderRequestUsageRecorder } from "./runtime/model-usage-recorder.js";
import { readChatAttachmentImageFile } from "./chat-attachments.js";
import { createWorkspaceToolExecutor } from "./workspace-tools/workspace-tool-executor.js";
import { createServerWorkspaceWorkflows } from "./workspace/server-workspace-workflows.js";
import { organizationRequestPayload } from "./openpond/organizations.js";
import {
  listSandboxIntegrationConnections,
  sandboxRequestPayload,
} from "./openpond/sandboxes.js";
import { createRemoteAccessManager } from "./remote-access/tailscale.js";
import { createVoiceTranscriptionService } from "./voice-transcription.js";
import { createInsightsService } from "./insights/create-edit-insights.js";
import { createInsightsBackgroundLoop } from "./insights/insights-background-loop.js";
import { createBrowserControlQueue } from "./openpond/browser-control-queue.js";
import { createLocalAgentScheduleLoop } from "./agents/local-agent-scheduler.js";
import {
  createScriptedOpenPondChatStream,
  scriptedOpenPondModelsEnabled,
} from "./openpond/scripted-chat-provider.js";
import { createTeamChatAiExecutionService } from "./openpond/team-chat-executor.js";
import { teamChatRequestPayload } from "./openpond/team-chat-client.js";

export type { OpenPondServerInstance, OpenPondServerOptions } from "./types.js";

const DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS = 64;
const MAX_REPEATED_INVALID_TOOL_REQUESTS = 3;

export async function createOpenPondServer(
  options: OpenPondServerOptions = {},
): Promise<OpenPondServerInstance> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const storeDir = options.storeDir ?? appDataDir();
  const version = options.version ?? VERSION;
  const runtimeVersion = getBundledRuntimeVersion();
  const maxHostedWorkspaceToolRounds = resolveMaxHostedWorkspaceToolRounds(options.maxHostedWorkspaceToolRounds);
  const streamOpenPondHostedChatTurn = createScriptedOpenPondChatStream(
    options.streamOpenPondHostedChatTurn ?? defaultStreamOpenPondHostedChatTurn,
    { enabled: scriptedOpenPondModelsEnabled() },
  );
  const executeWebSearch = createWebSearchExecutorFromEnv();
  const executeConnectedAppTool = createCloudConnectedAppToolExecutor();
  const attachmentRootDir = path.join(storeDir, "attachments");
  const logger = createLogger({
    channel: "server",
    logDir: path.join(storeDir, "logs"),
    metadata: {
      version,
      runtimeVersion,
    },
  });
  const providersFilePath = providersConfigPath(storeDir);
  const providerSecretPaths = {
    secretsFilePath: providerSecretsConfigPath(storeDir),
    keyFilePath: providerSecretsKeyPath(storeDir),
  };
  const { token, tokenFile } = await ensureCapabilityToken(storeDir);
  const store = new SqliteStore(storeDir, { logger });
  const startedAt = now();
  const serverId = randomUUID();
  const { appendRuntimeEvent, closeEventSubscribers, subscribers, truncateLogValue } =
    createRuntimeEventBus({
      logger,
      store,
  });
  const workQueues = createServerWorkQueues(logger);
  const browserControlQueue = createBrowserControlQueue();
  const codexSessions = new Map<string, RuntimeCodexSession>();
  const workspaceLocks = new Map<string, Promise<unknown>>();
  let actualPort = port;
  let closing = false;
  let codexStatus: CodexStatus = {
    available: false,
    binaryPath: null,
    version: null,
    authHealth: "unknown",
    account: null,
    appServer: { status: "idle", lastError: null },
  };

  logger.info("server starting", { host, port, storeDir, serverId });

  async function refreshCodexStatus(): Promise<CodexStatus> {
    const probe = await detectCodexStatus(process.env.CODEX_BINARY || "codex");
    codexStatus = {
      available: probe.available,
      binaryPath: probe.binaryPath,
      version: probe.version,
      authHealth: probe.authHealth,
      account: probe.account,
      appServer: {
        status: codexStatus.appServer.status,
        lastError: probe.error,
      },
    };
    return codexStatus;
  }

  void refreshCodexStatus();

  async function upsertApproval(approval: Approval): Promise<void> {
    await store.upsertApproval(approval);
  }

  async function withWorkspaceLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const existing = workspaceLocks.get(appId);
    if (existing) throw new Error("Workspace is busy");
    const lock = fn();
    workspaceLocks.set(appId, lock);
    try {
      return await lock;
    } finally {
      if (workspaceLocks.get(appId) === lock) workspaceLocks.delete(appId);
    }
  }

  const {
    openPondCacheScope,
    upsertScaffoldApp,
    loadAppPreferences,
    updateAppPreferencesPayload,
    providerSettingsPayload,
    updateProviderSettingsPayload,
    listProviderModelsPayload,
    refreshProviderModelsPayload,
    writeProviderCredentialPayload,
    deleteProviderCredentialPayload,
    startOpenAiSubscriptionAuthPayload,
    validateProviderCredentialPayload,
    providerDiagnosticsPayload,
    recordClientDiagnosticPayload,
    updatePersonalizationPayload,
    bootstrapPayload,
    codexHistoryThreadPayload,
    patchCodexHistorySessionPayload,
    sendCodexHistoryTurnPayload,
    interruptCodexHistoryTurnPayload,
    findOpenPondApp,
    gitBaseUrlFromContext,
    findLocalWorkspace,
    refreshLocalProjectWorkspace,
    linkLocalProjectOpenPondApp,
    workspaceStatePayload,
    workspaceTemplateConfigPayload,
    ensureSessionWorkspace,
    resolveSessionWorkspaceCwd,
    defaultSessionCwd,
    createWorkspaceBranchPayload,
    checkoutWorkspaceBranchPayload,
    workspaceDiffPayload,
    workspaceFilePayload,
    saveWorkspaceFilePayload,
    workspaceImagePayload,
    workspaceLspTouchPayload,
    workspaceLspActionPayload,
    workspaceLspSettingsStatusPayload,
    workspaceLspRuntimeStatusPayload,
    restartWorkspaceLspPayload,
    createLocalProjectPayload,
    deleteLocalProjectPayload,
    updateLocalProjectAgentSetupPayload,
    previewLocalProjectCloudSourcePayload,
    uploadLocalProjectCloudSourcePayload,
    listCloudWorkItemsPayload,
    getCloudWorkItemPayload,
    createCloudWorkItemPayload,
    sendCloudWorkItemMessagePayload,
    handleCloudWorkItemBackgroundPayload,
    cancelCloudWorkItemTaskPayload,
    openCloudWorkItemPayload,
    applyCloudWorkItemLocalPatchPayload,
    patchSidebarAppPreference,
    reorderSidebarApps,
    refreshOpenPondPayload,
    loadMoreOpenPondAppsPayload,
    switchOpenPondPayload,
    saveOpenPondAccountPayload,
    updateOpenPondAccountConfigPayload,
    profileCurrentPayload,
    profileCatalogPayload,
    profileInitPayload,
    profileLoadPayload,
    profileCheckPayload,
    profileCommitPayload,
    profilePushPayload,
    profileRunPayload,
    recordPreflightTurnFailure,
    waitForOpenPondRefresh,
  } = createServerPayloads({
    attachmentRootDir,
    store,
    storeDir,
    providersFilePath,
    serverId,
    host,
    getActualPort: () => actualPort,
    startedAt,
    version,
    runtimeVersion,
    getCodexStatus: () => codexStatus,
    refreshCodexStatus,
    appendRuntimeEvent,
    isClosing: () => closing,
  });

  const {
    createSession,
    patchSession,
    getSession,
    updateSession,
    completeTurn,
    failTurn,
    interruptTurn,
  } = createSessionStore({
    store,
    defaultSessionCwd,
    loadAppPreferences,
    appendRuntimeEvent,
  });

  const {
    activeWorkspace,
    appendWorkspaceDiffEvent,
    workspaceDiffBaseline,
    runPostEditChecks,
    runPostEditWorkflow,
  } = createServerWorkspaceWorkflows({
    appendRuntimeEvent,
    checkpointDiffQueue: workQueues.checkpointDiff,
    findLocalWorkspace,
    findOpenPondApp,
    storeDir,
    workspaceDiffPayload,
  });

  const { executeWorkspaceTool } = createWorkspaceToolExecutor({
    logger,
    truncateLogValue,
    appendRuntimeEvent,
    appendWorkspaceDiffEvent,
    getSession,
    updateSession,
    findLocalWorkspace,
    refreshLocalProjectWorkspace,
    linkLocalProjectOpenPondApp,
    activeWorkspace,
    withWorkspaceLock,
    runPostEditChecks,
    runPostEditWorkflow,
    openPondCacheScope,
    upsertScaffoldApp,
    gitBaseUrlFromContext,
  });
  const openPondCommandAccess = createOpenPondCommandAccessService({
    upsertApproval,
    appendRuntimeEvent,
  });

  const {
    maybeCreateScaffoldForTurn,
    hostedSystemPrompt,
    appendAssistantText,
    appendHostedContextUsage,
  } = createHostedTurnHelpers({
    appendRuntimeEvent,
  });

  async function localByokRuntimeState() {
    const [file, secrets] = await Promise.all([
      readProvidersFile(providersFilePath),
      readProviderSecrets(providerSecretPaths),
    ]);
    return {
      secrets,
      settings: buildProviderSettings({
        file,
        secrets,
        codex: codexStatus,
        catalog: cachedProviderCatalog(file),
      }),
    };
  }
  const teamChatAiExecutions = createTeamChatAiExecutionService({
    loadProviderRuntime: localByokRuntimeState,
    version,
  });

  const {
    resolveApproval: resolveCodexApproval,
    handleCodexServerRequest,
    mapCodexNotification,
  } = createCodexBridge({
    store,
    upsertApproval,
    appendRuntimeEvent,
    providerRuntimeIngestionQueue: workQueues.providerRuntimeIngestion,
  });

  const { ensureCodexRuntime } = createCodexRuntimeManager({
    appendRuntimeEvent,
    codexSessions,
    getCodexStatus: () => codexStatus,
    handleCodexServerRequest,
    mapCodexNotification,
    optionsVersion: options.version,
    setCodexStatus: (status) => {
      codexStatus = status;
    },
    store,
    storeDir,
    updateSession,
  });

  let notifySubagentLifecycleStateChanged: ((run: SubagentRun) => void) | null = null;

  const {
    sendTurn,
    isSessionTurnActive,
    interruptSessionTurn,
    updateTurnCreatePipeline,
    resolveCreatePipelineApproval,
    resolveSubagentPatchApplyApproval,
    runSubagentLifecycleAction,
    cleanupExpiredRetainedSubagentWorkspace,
  } = createTurnRunner({
    attachmentRootDir,
    store,
    createSession,
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
    forkSandboxForSubagent: async ({ sandboxId, payload }) =>
      sandboxRequestPayload({ type: "fork", sandboxId, payload }),
    cleanupSandboxForSubagent: async ({ sandboxId }) =>
      sandboxRequestPayload({ type: "delete", sandboxId }),
    executeOpenPondCommand: openPondCommandAccess.executeCommand,
    executeProfileAction: profileRunPayload,
    loadOpenPondProfileState,
    readOpenPondProfileSkill: readProfileSkill,
    executeProfileSkillCommand: ({ prompt }) => runProfileSkillCommandFromPrompt(prompt),
    executeProfileSkillGoal: (input) => runProfileSkillGoalCommand(input),
    executeWebSearch: executeWebSearch ?? undefined,
    executeConnectedAppTool,
    browserToolExecutor: browserControlQueue.executor,
    listIntegrationConnections: listSandboxIntegrationConnections,
    loadPersonalizationSoul: async () => (await loadPersonalizationSettings(store, storeDir)).soul,
    loadAppPreferences,
    loadProviderSettings: async () => (await localByokRuntimeState()).settings,
    maybeCreateScaffoldForTurn,
    hostedSystemPrompt,
    appendAssistantText,
    appendHostedContextUsage,
    streamLocalByokChatTurn: async function* (input) {
      const state = await localByokRuntimeState();
      for await (const delta of streamOpenAiCompatibleChatCompletion({
        providerId: input.providerId,
        settings: state.settings,
        secrets: state.secrets,
        modelId: input.modelId,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        requestId: input.requestId,
        signal: input.signal,
        saveChatGptSubscriptionCredential: async (providerId, credential) => {
          await writeProviderChatGptSubscriptionCredential({
            paths: providerSecretPaths,
            providerId,
            credential,
            timestamp: now(),
          });
        },
      })) {
        if (delta.type === "text_delta") {
          yield { text: delta.text, raw: delta.raw };
        }
        if (delta.type === "reasoning_delta") {
          yield { reasoningText: delta.text, raw: delta.raw };
        }
        if (delta.type === "tool_call_delta") yield { toolCalls: delta.toolCalls, raw: delta.raw };
        if (delta.type === "usage") yield { raw: delta.raw, usage: delta.usage };
        if (delta.type === "finish") yield { finishReason: delta.finishReason, raw: delta.raw };
      }
    },
    streamOpenPondHostedChatTurn,
    subagentQueue: workQueues.subagent,
    turnFollowUpQueue: workQueues.turnFollowUp,
    notifySubagentRunStateChanged: (run) => {
      notifySubagentLifecycleStateChanged?.(run);
    },
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests: MAX_REPEATED_INVALID_TOOL_REQUESTS,
  });
  const insightsService = createInsightsService({
    store,
    storeDir,
    createSession,
    updateSession,
    sendTurn,
    appendRuntimeEvent,
    loadAppPreferences,
    logger,
  });
  const insightsBackgroundLoop = createInsightsBackgroundLoop({
    service: insightsService,
    queue: workQueues.insights,
    isClosing: () => closing,
    logger,
  });
  const localAgentScheduleLoop = createLocalAgentScheduleLoop({
    store,
    queue: workQueues.localAgentSchedule,
    isClosing: () => closing,
    loadProfileState: loadOpenPondProfileState,
    appendRuntimeEvent,
    logger,
  });
  const subagentLifecycleWatcher = createSubagentLifecycleWatcher({
    store,
    queue: workQueues.subagentLifecycle,
    parentWakeQueue: workQueues.turnFollowUp,
    loadAppPreferences,
    appendRuntimeEvent,
    getSession,
    sendTurn,
    interruptSessionTurn,
    cleanupExpiredRetainedWorkspace: async ({ run, checkedAt, retention }) =>
      (await cleanupExpiredRetainedSubagentWorkspace(run.id, {
        checkedAt,
        retention,
        reason: `Retained subagent workspace expired at ${retention.expiresAt}.`,
      })).run,
    isSessionActive: isSessionTurnActive,
    isClosing: () => closing,
    logger,
  });
  notifySubagentLifecycleStateChanged = subagentLifecycleWatcher.notifySubagentRunStateChanged;

  async function resolveApproval(approvalId: string, payload: unknown): Promise<Approval> {
    const commandApproval = await openPondCommandAccess.resolveApproval(approvalId, payload);
    if (commandApproval) return commandApproval;
    const createPipelineApproval = await resolveCreatePipelineApproval(approvalId, payload);
    if (createPipelineApproval) return createPipelineApproval;
    const subagentPatchApplyApproval = await resolveSubagentPatchApplyApproval(approvalId, payload);
    if (subagentPatchApplyApproval) return subagentPatchApplyApproval;
    return resolveCodexApproval(approvalId, payload);
  }

  async function appendCodexCompactionCompletedIfNeeded(
    session: Awaited<ReturnType<typeof getSession>>,
    codexThreadId: string,
    reason: "manual",
    model: string | null,
  ): Promise<RuntimeEvent> {
    const existing = findRecentCodexCompactionCompleted(
      (await store.snapshot()).events,
      session.id,
      codexThreadId,
    );
    if (existing) return existing;
    const completedEvent = event({
      sessionId: session.id,
      name: "session.compaction.completed",
      source: "server",
      appId: session.appId,
      status: "completed",
      output: "Compacted conversation context",
      data: {
        version: 1,
        provider: "codex",
        model,
        reason,
        mode: "native",
        codexThreadId,
      },
    });
    await appendRuntimeEvent(completedEvent);
    return completedEvent;
  }

  async function appendCompactionFailed(
    session: Awaited<ReturnType<typeof getSession>>,
    provider: ChatProvider,
    model: string | null,
    reason: "manual",
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        name: "session.compaction.failed",
        source: "server",
        appId: session.appId,
        status: "failed",
        output: "Context compaction failed",
        error: message,
        data: {
          version: 1,
          provider,
          model,
          reason,
          error: message,
        },
      }),
    );
  }

  async function safeUpsertModelUsageRecord(record: ModelUsageRecord): Promise<void> {
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
          output: error instanceof Error ? error.message : "Failed to persist model usage record.",
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

  async function runRecordedManualHostedContextCompaction(input: {
    session: Awaited<ReturnType<typeof getSession>>;
    events: RuntimeEvent[];
    provider: ChatProvider;
    model: string | null;
    maxContextTokens?: number | null;
    route: "openpond_hosted" | "local_byok";
    requestId: string;
  }) {
    const usageState: {
      recorder: Awaited<ReturnType<typeof startProviderRequestUsageRecorder>> | null;
      finalized: boolean;
    } = { recorder: null, finalized: false };

    async function failUsageRecorder(error: unknown): Promise<void> {
      if (!usageState.recorder || usageState.finalized) return;
      usageState.finalized = true;
      await usageState.recorder.fail(
        error,
        error instanceof Error && error.name === "AbortError" ? "interrupted" : "failed",
      );
    }

    try {
      const result = await runHostedContextCompaction({
        session: input.session,
        events: input.events,
        provider: input.provider,
        model: input.model,
        maxContextTokens: input.maxContextTokens,
        streamCompactionChatTurn: async function* (streamInput) {
          usageState.recorder = await startProviderRequestUsageRecorder({
            session: input.session,
            turn: null,
            provider: input.provider,
            model: streamInput.model ?? input.model ?? "unknown",
            requestId: input.requestId,
            requestOrdinal: 0,
            requestKind: "context_compaction",
            upsert: safeUpsertModelUsageRecord,
          });
          try {
            if (input.route === "openpond_hosted") {
              for await (const delta of streamOpenPondHostedChatTurn({
                model: streamInput.model,
                messages: streamInput.messages,
                requestId: streamInput.requestId,
                signal: streamInput.signal,
              })) {
                if (delta.type === "text_delta" && delta.text) usageState.recorder.observeDelta({ text: delta.text });
                if (delta.type === "reasoning_delta" && delta.text) {
                  usageState.recorder.observeDelta({ reasoningText: delta.text });
                }
                if (delta.type === "usage") usageState.recorder.observeDelta({ usage: delta.usage });
                if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
                if (delta.type === "reasoning_delta" && delta.text) yield { reasoningText: delta.text, raw: delta.raw };
                if (delta.type === "usage") yield { usage: delta.usage, raw: delta.raw };
              }
              return;
            }

            const state = await localByokRuntimeState();
            for await (const delta of streamOpenAiCompatibleChatCompletion({
              providerId: streamInput.provider,
              settings: state.settings,
              secrets: state.secrets,
              modelId: streamInput.model,
              messages: streamInput.messages,
              requestId: streamInput.requestId,
              signal: streamInput.signal,
              saveChatGptSubscriptionCredential: async (providerId, credential) => {
                await writeProviderChatGptSubscriptionCredential({
                  paths: providerSecretPaths,
                  providerId,
                  credential,
                  timestamp: now(),
                });
              },
            })) {
              if (delta.type === "text_delta" && delta.text) usageState.recorder.observeDelta({ text: delta.text });
              if (delta.type === "reasoning_delta" && delta.text) {
                usageState.recorder.observeDelta({ reasoningText: delta.text });
              }
              if (delta.type === "usage") usageState.recorder.observeDelta({ usage: delta.usage });
              if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
              if (delta.type === "reasoning_delta" && delta.text) yield { reasoningText: delta.text, raw: delta.raw };
              if (delta.type === "usage") yield { usage: delta.usage, raw: delta.raw };
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

  async function compactSession(sessionId: string, payload: unknown): Promise<unknown> {
    const input = CompactSessionRequestSchema.parse(payload ?? {});
    const session = await getSession(sessionId);
    if (session.status === "active")
      throw new Error("Cannot compact context while a turn is running.");
    if (session.status === "closed") throw new Error("Cannot compact a closed session.");
    const requestedModel = input.model ?? session.modelRef?.modelId ?? null;

    const priorEvents = (await store.snapshot()).events.filter(
      (item) => item.sessionId === sessionId,
    );
    const startedEvent = event({
      sessionId,
      name: "session.compaction.started",
      source: "server",
      appId: session.appId,
      status: "started",
      output: "Compacting conversation context",
      data: {
        version: 1,
        provider: session.provider,
        model: requestedModel,
        reason: input.reason,
      },
    });
    await appendRuntimeEvent(startedEvent);

    try {
      if (session.provider === "codex") {
        const runtime = await ensureCodexRuntime(session, {
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          model: requestedModel,
          codexPermissionMode: "default",
        });
        const compacted = await runtime.client.compactThread({ threadId: runtime.threadId });
        const completedEvent =
          compacted.completion === "response"
            ? await appendCodexCompactionCompletedIfNeeded(
                session,
                runtime.threadId,
                input.reason,
                requestedModel,
              )
            : null;
        return {
          ok: true,
          mode: "native",
          method: compacted.method,
          summaryEventId: completedEvent?.id ?? null,
          response: compacted.response,
        };
      }

      const adapter = resolveContextCompactionAdapter(session.provider);
      if (adapter.kind !== "app_summary") throw new Error(adapter.reason);
      const state = adapter.route === "local_byok" ? await localByokRuntimeState() : null;
      const maxContextTokens = adapter.route === "local_byok"
        ? trustedProviderContextLimit({
            provider: session.provider,
            model: requestedModel,
            settings: state?.settings ?? null,
          })
        : null;
      if (adapter.route === "local_byok" && !maxContextTokens) {
        throw new Error(
          `Context compaction for ${session.provider} requires a selected model with a trusted context window.`,
        );
      }
      const result = await runRecordedManualHostedContextCompaction({
        session,
        events: priorEvents,
        provider: adapter.provider,
        model: requestedModel,
        maxContextTokens,
        route: adapter.route,
        requestId: `${session.id}:context-compaction:${startedEvent.id}`,
      });
      const completedEvent = event({
        sessionId,
        name: "session.compaction.completed",
        source: "server",
        appId: session.appId,
        status: "completed",
        output: "Compacted conversation context",
        data: {
          version: 1,
          provider: adapter.provider,
          model: result.model,
          reason: input.reason,
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
        },
      });
      await appendRuntimeEvent(completedEvent);
      return {
        ok: true,
        mode: "summary",
        summaryEventId: completedEvent.id,
        inputTokensBefore: result.inputTokensBefore,
        inputTokensAfter: result.inputTokensAfter,
        maxContextTokens: result.maxContextTokens,
        tokenSource: result.tokenSource,
      };
    } catch (error) {
      await appendCompactionFailed(
        session,
        session.provider,
        requestedModel,
        input.reason,
        error,
      );
      throw error;
    }
  }

  async function gitAvailabilityPayload(): Promise<unknown> {
    return checkWorkspaceGitAvailability(storeDir);
  }

  async function eventPagePayload(requestUrl: URL): Promise<unknown> {
    const request = runtimeEventPageRequestFromUrl(requestUrl);
    const rows = await store.runtimeEventPageRows(request);
    return runtimeEventsPagePayloadFromEntries({
      ...rows,
      request,
    });
  }

  async function usageSummaryRoutePayload(requestUrl: URL): Promise<unknown> {
    return usageSummaryPayload({ requestUrl, store });
  }

  async function usageRecordsRoutePayload(requestUrl: URL): Promise<unknown> {
    return usageRecordsPayload({ requestUrl, store });
  }

  async function listInsightsPayload(requestUrl: URL): Promise<unknown> {
    const rawStatus = requestUrl.searchParams.get("status");
    const status = rawStatus === "active" || rawStatus === "resolved" || rawStatus === "dismissed" || rawStatus === "all"
      ? rawStatus
      : "all";
    const rawLimit = Number(requestUrl.searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
    const rawEvidenceSource = requestUrl.searchParams.get("evidenceSource");
    const evidenceSource = isInsightEvidenceSourceFilter(rawEvidenceSource) ? rawEvidenceSource : "all";
    const rawRunStatus = requestUrl.searchParams.get("runStatus");
    const runStatus = rawRunStatus === "running" || rawRunStatus === "completed" || rawRunStatus === "failed" || rawRunStatus === "skipped" || rawRunStatus === "all"
      ? rawRunStatus
      : "all";
    const rawRunTrigger = requestUrl.searchParams.get("runTrigger");
    const runTrigger = rawRunTrigger === "startup" || rawRunTrigger === "interval" || rawRunTrigger === "manual" || rawRunTrigger === "slash_command" || rawRunTrigger === "all"
      ? rawRunTrigger
      : "all";
    const runModel = requestUrl.searchParams.get("runModel");
    return withInsightsSchedule(await insightsService.list({
      status,
      limit,
      evidenceSource,
      runStatus,
      runTrigger,
      runModel,
    }));
  }

  async function runInsightsScanPayload(requestUrl?: URL): Promise<unknown> {
    const rawTrigger = requestUrl?.searchParams.get("trigger");
    const trigger = rawTrigger === "slash_command" ? "slash_command" : "manual";
    return withInsightsSchedule(await insightsBackgroundLoop.scanNow({ force: true, trigger }));
  }

  async function askInsightsPayload(payload: unknown): Promise<unknown> {
    const input = InsightsAskRequestSchema.parse(payload);
    return withInsightsSchedule(await insightsService.ask(input.question));
  }

  async function patchInsightPayload(insightId: string, payload: unknown): Promise<unknown> {
    const input = PatchInsightRequestSchema.parse(payload);
    return withInsightsSchedule(await insightsService.patchStatus(insightId, input.status as InsightStatus));
  }

  function withInsightsSchedule<T extends InsightsListResponse | InsightsScanResponse>(payload: T): T {
    const status = insightsBackgroundLoop.status();
    return {
      ...payload,
      nextScanAt: status.nextScanAt,
      scanRunning: status.scanRunning,
      scanStartedAt: status.scanStartedAt,
    };
  }

  async function listLocalAgentSchedulesPayload(payload?: unknown): Promise<unknown> {
    const input = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as { localProjectId?: unknown }
      : {};
    return localAgentScheduleLoop.list({
      localProjectId: typeof input.localProjectId === "string" ? input.localProjectId : null,
    });
  }

  async function syncLocalAgentSchedulesPayload(): Promise<unknown> {
    return localAgentScheduleLoop.syncNow();
  }

  async function patchLocalAgentSchedulePayload(scheduleId: string, payload: unknown): Promise<unknown> {
    const updated = await localAgentScheduleLoop.patchSchedule(
      scheduleId,
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as { enabled?: boolean }
        : {},
    );
    if (!updated) throw new Error("Local agent schedule not found");
    return { schedule: updated };
  }

  async function runLocalAgentSchedulePayload(scheduleId: string, payload: unknown): Promise<unknown> {
    const input = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as { input?: unknown }
      : {};
    return localAgentScheduleLoop.runNow(
      scheduleId,
      input.input && typeof input.input === "object" && !Array.isArray(input.input)
        ? input.input as Record<string, unknown>
        : undefined,
    );
  }

  async function listLocalAgentScheduleRunsPayload(
    scheduleId: string,
    payload?: unknown,
  ): Promise<unknown> {
    const input = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as { limit?: unknown }
      : {};
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    return { runs: await localAgentScheduleLoop.listRuns(scheduleId, limit) };
  }

  async function patchSessionPayload(sessionId: string, payload: unknown): Promise<unknown> {
    return isCodexHistorySessionId(sessionId)
      ? patchCodexHistorySessionPayload(sessionId, payload)
      : patchSession(sessionId, payload);
  }

  async function runSessionCommandPayload(sessionId: string, payload: unknown): Promise<unknown> {
    const input = RunSessionCommandRequestSchema.parse(payload);
    const session = await getSession(sessionId);
    if (session.provider === "codex" || isCodexHistorySessionId(session.id)) {
      throw new Error("OpenPond command access is not available for Codex sessions.");
    }
    return runOpenPondDirectCommand({
      appendRuntimeEvent,
      executeLocalCommand: openPondCommandAccess.executeCommand,
      executeWorkspaceTool,
      getSession,
      runtimeEventsSnapshot: async () => (await store.snapshot()).events,
    }, {
      session,
      command: input.command,
      cwd: input.cwd ?? null,
      timeoutSeconds: input.timeoutSeconds ?? null,
    });
  }

  async function startGitInstallPayload(): Promise<unknown> {
    const result = startMacOSCommandLineToolsInstall();
    if (result.ok) return result;
    throw new Error(result.error);
  }

  const remoteAccess = createRemoteAccessManager({
    getActualPort: () => actualPort,
    logger,
    token,
    webRoot: options.webRoot ?? null,
    webTargetUrl: process.env.OPENPOND_REMOTE_ACCESS_TARGET,
  });
  const voiceTranscription = createVoiceTranscriptionService({ storeDir, logger });

  const { httpServer, terminalWebSockets } = createOpenPondHttpSurface({
    routeOptions: {
      host,
      getActualPort: () => actualPort,
      token,
      version,
      runtimeVersion,
      logger,
      subscribers,
      refreshCodexStatus,
      bootstrapPayload,
      eventPagePayload,
      usageSummaryPayload: usageSummaryRoutePayload,
      usageRecordsPayload: usageRecordsRoutePayload,
      listInsightsPayload,
      runInsightsScanPayload,
      askInsightsPayload,
      patchInsightPayload,
      listLocalAgentSchedulesPayload,
      syncLocalAgentSchedulesPayload,
      patchLocalAgentSchedulePayload,
      runLocalAgentSchedulePayload,
      listLocalAgentScheduleRunsPayload,
      codexHistoryThreadPayload,
      sendCodexHistoryTurnPayload,
      interruptCodexHistoryTurnPayload,
      loadMoreOpenPondAppsPayload,
      workspaceTemplateConfigPayload,
      refreshOpenPondPayload,
      switchOpenPondPayload,
      saveOpenPondAccountPayload,
      updateOpenPondAccountConfigPayload,
      profileCurrentPayload,
      profileCatalogPayload,
      profileInitPayload,
      profileLoadPayload,
      profileCheckPayload,
      profileCommitPayload,
      profilePushPayload,
      profileRunPayload,
      updateAppPreferencesPayload,
      providerSettingsPayload,
      updateProviderSettingsPayload,
      listProviderModelsPayload,
      refreshProviderModelsPayload,
      writeProviderCredentialPayload,
      deleteProviderCredentialPayload,
      startOpenAiSubscriptionAuthPayload,
      validateProviderCredentialPayload,
      providerDiagnosticsPayload,
      recordClientDiagnosticPayload,
      updatePersonalizationPayload,
      reorderSidebarApps,
      patchSidebarAppPreference,
      workspaceStatePayload,
      createWorkspaceBranchPayload,
      checkoutWorkspaceBranchPayload,
      workspaceDiffPayload,
      workspaceFilePayload,
      saveWorkspaceFilePayload,
      workspaceImagePayload,
      localImagePayload: async (filePath) => {
        const image = await readLocalImageFile(filePath);
        if (!image) throw new Error("Image not found");
        return image;
      },
      chatAttachmentImagePayload: async (input) => {
        const image = await readChatAttachmentImageFile({
          attachmentRootDir,
          sessionId: input.sessionId,
          turnId: input.turnId,
          storageName: input.storageName,
          contentType: input.contentType,
        });
        if (!image) throw new Error("Image not found");
        return image;
      },
      workspaceLspTouchPayload,
      workspaceLspActionPayload,
      workspaceLspSettingsStatusPayload,
      workspaceLspRuntimeStatusPayload,
      restartWorkspaceLspPayload,
      createLocalProjectPayload,
      deleteLocalProjectPayload,
      updateLocalProjectAgentSetupPayload,
      previewLocalProjectCloudSourcePayload,
      uploadLocalProjectCloudSourcePayload,
      listCloudWorkItemsPayload,
      getCloudWorkItemPayload,
      createCloudWorkItemPayload,
      sendCloudWorkItemMessagePayload,
      handleCloudWorkItemBackgroundPayload,
      cancelCloudWorkItemTaskPayload,
      openCloudWorkItemPayload,
      applyCloudWorkItemLocalPatchPayload,
      organizationPayload: organizationRequestPayload,
      sandboxPayload: sandboxRequestPayload,
      teamChatPayload: teamChatRequestPayload,
      executeTeamChatAiTurn: teamChatAiExecutions.execute,
      cancelTeamChatAiTurnExecution: teamChatAiExecutions.cancel,
      gitAvailabilityPayload,
      startGitInstallPayload,
      remoteAccessPayload: remoteAccess.status,
      enableRemoteAccessPayload: remoteAccess.enable,
      disableRemoteAccessPayload: remoteAccess.disable,
      voiceTranscriptionStatusPayload: voiceTranscription.status,
      transcribeVoicePayload: voiceTranscription.transcribe,
      browserControlRegister: browserControlQueue.registerDesktopExecutor,
      browserControlNext: browserControlQueue.claimNext,
      browserControlComplete: browserControlQueue.completeRequest,
      browserControlStatus: browserControlQueue.status,
      createSession,
      patchSession: patchSessionPayload,
      sendTurn,
      runSessionCommand: runSessionCommandPayload,
      recordPreflightTurnFailure,
      updateTurnCreatePipeline,
      interruptSessionTurn,
      compactSession,
      executeWorkspaceTool,
      runSubagentLifecycleAction,
      resolveApproval,
    },
    terminalOptions: {
      host,
      getActualPort: () => actualPort,
      token,
      logger,
      defaultCwdForApp: defaultSessionCwd,
    },
    webRoot: options.webRoot ?? null,
  });
  actualPort = await listenOpenPondHttpServer({ host, httpServer, logger, port, serverId });
  insightsBackgroundLoop.start();
  localAgentScheduleLoop.start();
  subagentLifecycleWatcher.start();

  const status: ServerStatus = {
    id: serverId,
    host,
    port: actualPort,
    startedAt,
    storePath: store.storePath,
    version,
    runtimeVersion,
  };

  return {
    url: `http://${host}:${actualPort}`,
    token,
    tokenFile,
    storePath: store.storePath,
    status,
    close: async () => {
      logger.info("server closing", { serverId });
      closing = true;
      insightsBackgroundLoop.stop();
      localAgentScheduleLoop.stop();
      subagentLifecycleWatcher.stop();
      browserControlQueue.close();
      await closeEventSubscribers();
      terminalWebSockets.close();
      await waitForOpenPondRefresh();
      for (const runtime of codexSessions.values()) await runtime.client.stop();
      await workQueues.drain();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      await store.close();
      logger.info("server closed", { serverId });
      await logger.flush();
    },
    testHooks: {
      drainWorkQueues: workQueues.drain,
      workQueueReceipts: workQueues.receipts,
    },
  };
}

function resolveMaxHostedWorkspaceToolRounds(optionValue: number | undefined): number {
  if (typeof optionValue === "number" && Number.isFinite(optionValue) && optionValue > 0) {
    return Math.floor(optionValue);
  }
  const envValue = process.env.OPENPOND_HOSTED_WORKSPACE_TOOL_ROUNDS?.trim();
  if (!envValue) return DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS;
  if (/^(unlimited|infinite|infinity)$/i.test(envValue)) return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS;
}

function isInsightEvidenceSourceFilter(value: string | null): value is
  | "all"
  | "create_edit"
  | "stuck_turn"
  | "tool_failure"
  | "abandoned_goal"
  | "user_correction"
  | "unresolved_conversation"
  | "usage_anomaly" {
  return (
    value === "all" ||
    value === "create_edit" ||
    value === "stuck_turn" ||
    value === "tool_failure" ||
    value === "abandoned_goal" ||
    value === "user_correction" ||
    value === "unresolved_conversation" ||
    value === "usage_anomaly"
  );
}

function findRecentCodexCompactionCompleted(
  events: RuntimeEvent[],
  sessionId: string,
  codexThreadId: string,
): RuntimeEvent | null {
  const cutoff = Date.now() - 60_000;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    const timestamp = Date.parse(item.timestamp);
    if (Number.isFinite(timestamp) && timestamp < cutoff) return null;
    if (item.sessionId !== sessionId || item.name !== "session.compaction.completed") continue;
    const data =
      item.data && typeof item.data === "object" ? (item.data as Record<string, unknown>) : null;
    if (data?.provider === "codex" && data.codexThreadId === codexThreadId) return item;
  }
  return null;
}

if (isCliEntrypoint(import.meta.url)) {
  void runOpenPondServerCli(createOpenPondServer).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
