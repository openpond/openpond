#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CompactSessionRequestSchema,
  InsightsAskRequestSchema,
  PatchInsightRequestSchema,
  RunSessionCommandRequestSchema,
  normalizeSidebarFilePath,
  type Approval,
  type ChatProvider,
  type ChatModelRef,
  type CodexReasoningEffort,
  type InsightStatus,
  type InsightsListResponse,
  type InsightsScanResponse,
  type ModelUsageRecord,
  type RuntimeEvent,
  type ServerStatus,
} from "@openpond/contracts";
import { detectCodexStatus } from "@openpond/codex-provider";
import {
  loadOpenPondProfileState,
  readProfileSkill,
  runProfileSkillCommandFromPrompt,
  runProfileSkillGoalCommand,
} from "@openpond/cloud";
import {
  getBundledRuntimeVersion,
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";
import {
  APP_PREFERENCES_CACHE_KEY,
  APP_PREFERENCES_CACHE_TYPE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  VERSION,
} from "./constants.js";
import { runOpenPondServerCli } from "./cli.js";
import { createHostedTurnHelpers } from "./openpond/hosted-turn-helpers.js";
import { runHostedContextCompaction } from "./openpond/context-compaction/index.js";
import { resolveContextCompactionAdapter } from "./openpond/context-adapter.js";
import { trustedProviderContextLimit } from "./openpond/context-usage.js";
import { createLogger } from "@openpond/logging";
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
import { loadGitCommitDiffAtPath } from "./workspace/workspace-diff.js";
import { createCodexBridge } from "./runtime/codex-bridge.js";
import { createCodexRuntimeManager } from "./runtime/codex-runtime.js";
import { createServerPayloads } from "./api/server-payloads.js";
import {
  runtimeEventPageRequestFromUrl,
  runtimeEventsPagePayloadFromEntries,
} from "./api/event-page.js";
import {
  usageRecordsPayload,
  usageSummaryPayload,
} from "./api/usage-payloads.js";
import { readProvidersFile } from "./openpond/provider-settings.js";
import { buildProviderSettings } from "./openpond/provider-registry.js";
import { cachedProviderCatalog } from "./openpond/provider-catalog.js";
import {
  readProviderSecrets,
  updateProviderCredentialValidation,
  writeProviderChatGptSubscriptionCredential,
} from "./openpond/provider-secrets.js";
import { streamOpenAiCompatibleChatCompletion } from "./openpond/openai-compatible-provider.js";
import { createWebSearchExecutorFromEnv } from "./openpond/web-search.js";
import { createCloudConnectedAppToolExecutor } from "./openpond/connected-app-executor.js";
import { createOpenPondCommandAccessService } from "./openpond/command-access.js";
import { runOpenPondDirectCommand } from "./openpond/direct-command.js";
import {
  isCodexHistorySessionId,
  readCodexHistoryThreadPayload,
} from "./codex-history.js";
import { createCodexStatusService } from "./codex-status-service.js";
import { createSessionStore } from "./store/session-store.js";
import {
  createOpenPondHttpSurface,
  listenOpenPondHttpServer,
} from "./api/server-http.js";
import { createServerWorkQueues } from "./runtime/background-worker-queue.js";
import { createServerShutdown } from "./runtime/server-shutdown.js";
import { createTurnRunner } from "./runtime/turn-runner.js";
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
import { communityRequestPayload } from "./openpond/community-client.js";
import { contentHash } from "@openpond/taskset-sdk";
import { createTaskCreatorService } from "./training/task-creator.js";
import { authorTaskDesignWithModel } from "./training/task-authoring-model.js";
import { loadTasksetAuthoringSkillBundle } from "./training/task-authoring-skill.js";
import { createTaskMinerService } from "./training/task-miner.js";
import { createTaskMinerBackgroundLoop } from "./training/task-miner-background-loop.js";
import { createTaskEvaluationService } from "./training/evaluation-service.js";
import { createTrainingService } from "./training/training-service.js";
import { createTrainingApi } from "./training/training-api.js";
import { createTrainingChatSearchService } from "./training/training-chat-search.js";
import { createDatasetArtifactService } from "./training/dataset-artifact-service.js";
import { createDatasetImportService } from "./training/dataset-imports/import-service.js";
import { createTrainingBaselineAttemptRunner } from "./training/task-baseline-attempt-runner.js";
import { createFireworksBaselineDeploymentService } from "./training/fireworks-baseline-deployment.js";
import { createComputeService } from "./compute/compute-service.js";
import { normalizeAppPreferences } from "./preferences.js";
import { createLocalAdapterChatRuntime } from "./training/local-adapter-chat-runtime.js";
import { createManagedAdapterRegistryClient } from "./training/managed-adapter-registry-client.js";
import { createManagedAdapterSyncService } from "./training/managed-adapter-sync-service.js";
import { createManagedAdapterChatRuntime } from "./training/managed-adapter-chat-runtime.js";
import { createTrainedAdapterChatRuntime } from "./training/trained-adapter-chat-runtime.js";
import {
  createCrossSystemChatToolRuntime,
  createCrossSystemFrontierBaselineService,
  createFrontierBaselineChatSource,
  type CrossSystemFrontierModelStream,
} from "./training/cross-system-operations/index.js";
import {
  LOCAL_ADAPTER_PROVIDER_ID,
  listLocalAdapterProviderModels,
  withLocalAdapterProviderModels,
} from "./training/local-adapter-models.js";

export type { OpenPondServerInstance, OpenPondServerOptions } from "./types.js";

const DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS = 64;
const MAX_REPEATED_INVALID_TOOL_REQUESTS = 3;

export async function createOpenPondServer(
  options: OpenPondServerOptions = {}
): Promise<OpenPondServerInstance> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const storeDir = options.storeDir ?? appDataDir();
  const version = options.version ?? VERSION;
  const runtimeVersion = getBundledRuntimeVersion();
  const maxHostedWorkspaceToolRounds = resolveMaxHostedWorkspaceToolRounds(
    options.maxHostedWorkspaceToolRounds
  );
  const streamOpenPondHostedChatTurn = createScriptedOpenPondChatStream(
    options.streamOpenPondHostedChatTurn ?? defaultStreamOpenPondHostedChatTurn,
    { enabled: scriptedOpenPondModelsEnabled() }
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
  const {
    appendRuntimeEvent,
    closeEventSubscribers,
    openEventSubscriber,
    truncateLogValue,
  } = createRuntimeEventBus({
    logger,
    store,
  });
  const workQueues = createServerWorkQueues(logger);
  const browserControlQueue = createBrowserControlQueue();
  const codexSessions = new Map<string, RuntimeCodexSession>();
  const workspaceLocks = new Map<string, Promise<unknown>>();
  let actualPort = port;
  let closing = false;
  const codexStatusService = createCodexStatusService({
    detect: () => detectCodexStatus(process.env.CODEX_BINARY || "codex"),
  });

  logger.info("server starting", { host, port, storeDir, serverId });

  const refreshCodexStatus = (force = false) =>
    codexStatusService.refresh(force);

  void refreshCodexStatus();

  async function upsertApproval(approval: Approval): Promise<void> {
    await store.upsertApproval(approval);
  }

  async function withWorkspaceLock<T>(
    appId: string,
    fn: () => Promise<T>
  ): Promise<T> {
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
    skillSourceFilePayload,
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
    closeWorkspaceLsp,
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
    listSidebarFileBookmarksPayload,
    patchSidebarFileBookmarkPayload,
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
    profileRenameAgentPayload,
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
    getCodexStatus: codexStatusService.get,
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
  const {
    closeCloudWorkspaceReadiness,
    executeWorkspaceTool,
    ensureCloudWorkspaceReady,
  } = createWorkspaceToolExecutor({
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
    sandboxRequest: sandboxRequestPayload,
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
    const [file, secrets, localAdapterModels] = await Promise.all([
      readProvidersFile(providersFilePath),
      readProviderSecrets(providerSecretPaths),
      listLocalAdapterProviderModels(store),
    ]);
    return {
      secrets,
      settings: withLocalAdapterProviderModels(
        buildProviderSettings({
          file,
          secrets,
          codex: codexStatusService.get(),
          catalog: cachedProviderCatalog(file),
        }),
        localAdapterModels
      ),
    };
  }
  async function resolveFireworksCredential() {
    const credential = (await readProviderSecrets(providerSecretPaths))
      .providers.fireworks;
    if (!credential) return null;
    const value = credential.source === "local_secret"
      ? credential.value
      : credential.source === "env" && credential.envVar
        ? process.env[credential.envVar] ?? null
        : null;
    if (
      !value?.trim()
      || (credential.source !== "local_secret" && credential.source !== "env")
    ) {
      return null;
    }
    return {
      value,
      source: credential.source,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    };
  }
  async function trainingModelText(input: {
    model: ChatModelRef;
    reasoningEffort?: CodexReasoningEffort | "none" | null;
    messages: Array<{ role: "system" | "user"; content: string }>;
    signal: AbortSignal;
    requestId: string;
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    seed?: number;
  }): Promise<string> {
    let text = "";
    if (input.model.providerId === LOCAL_ADAPTER_PROVIDER_ID) {
      for await (const delta of trainedAdapterChatRuntime.stream({
        modelId: input.model.modelId,
        messages: input.messages,
        requestId: input.requestId,
        signal: input.signal,
      })) {
        if (delta.text) text += delta.text;
      }
      return text;
    }
    if (input.model.providerId === "openpond") {
      for await (const delta of streamOpenPondHostedChatTurn({
        model: input.model.modelId,
        messages: input.messages,
        requestId: input.requestId,
        signal: input.signal,
      })) {
        if (delta.type === "text_delta" && delta.text) text += delta.text;
      }
      return text;
    }
    const state = await localByokRuntimeState();
    for await (const delta of streamOpenAiCompatibleChatCompletion({
      providerId: input.model.providerId,
      settings: state.settings,
      secrets: state.secrets,
      modelId: input.model.modelId,
      messages: input.messages,
      requestId: input.requestId,
      signal: input.signal,
      reasoningEffort: input.reasoningEffort,
      maxOutputTokens: input.maxOutputTokens,
      temperature: input.temperature,
      topP: input.topP,
      seed: input.seed,
    })) {
      if (delta.type === "text_delta" && delta.text) text += delta.text;
    }
    return text;
  }

  const tasksetAuthoringSkillText = await loadTasksetAuthoringSkillBundle();
  const taskCreatorService = createTaskCreatorService({
    store,
    tasksetRootDir: path.join(storeDir, "training", "tasksets"),
    authoringSkillHash: contentHash(tasksetAuthoringSkillText),
    loadCodexHistoryThread: (sessionId) =>
      readCodexHistoryThreadPayload(sessionId, {
        attachmentRootDir,
        maxEvents: 100_000,
      }),
    authorProposal: (input) =>
      authorTaskDesignWithModel({
        ...input,
        skillText: tasksetAuthoringSkillText,
        stream: async function* ({ model, reasoningEffort, messages, signal }) {
          yield {
            text: await trainingModelText({
              model,
              reasoningEffort,
              messages,
              signal,
              requestId: `task-authoring:${contentHash(input.id).slice(0, 40)}`,
            }),
          };
        },
      }),
  });
  await taskCreatorService.reconcileInterruptedCreations();
  const taskMinerService = createTaskMinerService({
    store,
    addSessionSource: (input) => taskCreatorService.addSessionSource(input),
  });
  let trainingBaselineAttemptRunner: ReturnType<
    typeof createTrainingBaselineAttemptRunner
  > | null = null;
  const datasetArtifactService = createDatasetArtifactService({
    store,
    workerProjectDir: path.resolve(
      process.cwd(),
      "python",
      "openpond-training",
    ),
  });
  const fireworksBaselineDeployments =
    createFireworksBaselineDeploymentService({
      resolveCredential: resolveFireworksCredential,
    });
  const taskEvaluationService = createTaskEvaluationService({
    store,
    storeDir,
    projectDatasetArtifact: datasetArtifactService.project,
    prepareBaselineModels: fireworksBaselineDeployments.prepare,
    cleanupBaselineDeployments:
      fireworksBaselineDeployments.cleanupOrphanedDeployments,
    resolveTask: ({ tasksetId, taskId, split }) =>
      datasetArtifactService.task(tasksetId, taskId, split),
    runAttempt: async (input) => {
      if (!trainingBaselineAttemptRunner) {
        throw new Error("The Taskset baseline runner is not initialized.");
      }
      return trainingBaselineAttemptRunner(input);
    },
    modelJudge: async ({ grader, task, attempt }) => {
      const raw = await trainingModelText({
        model: grader.judge,
        signal: new AbortController().signal,
        requestId: `task-judge:${attempt.id}:${grader.id}`,
        messages: [
          {
            role: "system",
            content: `Apply this rubric and return JSON only with score (0..1), passed, and feedback.\n\n${grader.rubric}`,
          },
          {
            role: "user",
            content: JSON.stringify({
              input: task.input,
              expectedOutput: task.expectedOutput,
              output: attempt.output,
            }),
          },
        ],
      });
      const parsed = parseModelJudgeResult(raw);
      if (!parsed)
        throw new Error("Model judge returned invalid structured output.");
      return parsed;
    },
  });
  const computeService = createComputeService({
    storeDir,
    localWorkerProjectDir: path.resolve(
      process.cwd(),
      "python",
      "openpond-training"
    ),
  });
  const managedAdapterRegistryClient = createManagedAdapterRegistryClient();
  const managedAdapterSyncService = createManagedAdapterSyncService({
    store,
    client: managedAdapterRegistryClient,
    resolveSelectedTeamId: async () => {
      const entry = await store.getCacheEntry<unknown>(
        APP_PREFERENCES_CACHE_TYPE,
        APP_PREFERENCES_CACHE_KEY,
      );
      return normalizeAppPreferences(entry?.payload).defaultTeamId;
    },
  });
  const computePayload = async (action: string, payload: unknown) => {
    if (action === "state") return computeService.state();
    if (action === "scan") return computeService.scan();
    if (action === "update_settings") {
      const settings = await computeService.updateSettings(payload);
      await computeService.scan();
      return settings;
    }
    if (action === "download_smollm2")
      return computeService.startModelDownload();
    if (action === "cancel_download") {
      const input =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {};
      if (typeof input.jobId !== "string" || !input.jobId)
        throw new Error("jobId is required.");
      return computeService.cancelModelDownload(input.jobId);
    }
    throw new Error(`Unknown compute action ${action}.`);
  };
  const trainingService = createTrainingService({
    store,
    storeDir,
    localWorkerProjectDir: path.resolve(
      process.cwd(),
      "python",
      "openpond-training"
    ),
    revalidateCompute: async () => {
      await computeService.scan();
    },
    resolveModelPath: computeService.modelPath,
    modelArtifactStore: async () =>
      (await computeService.settings()).modelStorePath,
    computeInventory: computeService.inventory,
    resolveApprovalActor: async () => {
      const account = (await bootstrapPayload()).account;
      if (account.state !== "signed_in") return null;
      return account.profile?.handle?.trim() || null;
    },
    resolveFireworksCredential,
    recordFireworksCredentialValidation: async (error) => {
      await updateProviderCredentialValidation({
        paths: providerSecretPaths,
        providerId: "fireworks",
        timestamp: now(),
        lastError: error,
      });
    },
    gradeTaskAttempt: taskEvaluationService.grade,
    projectDatasetArtifact: datasetArtifactService.project,
    resolveDatasetTask: ({ tasksetId, taskId, split }) =>
      datasetArtifactService.task(tasksetId, taskId, split),
    deactivateManagedBinding: managedAdapterSyncService.deactivateBinding,
    reactivateManagedBinding: managedAdapterSyncService.reactivateBinding,
    activateManagedBinding: managedAdapterSyncService.activateBinding,
  });
  const localAdapterChatRuntime = createLocalAdapterChatRuntime({
    store,
    projectDir: path.resolve(process.cwd(), "python", "openpond-training"),
    resolveModelPath: computeService.modelPath,
  });
  const managedAdapterChatRuntime = createManagedAdapterChatRuntime({
    store,
    client: managedAdapterRegistryClient,
  });
  const trainedAdapterChatRuntime = createTrainedAdapterChatRuntime({
    managed: managedAdapterChatRuntime,
    fireworks: {
      appliesTo: trainingService.isFireworksModel,
      stream: trainingService.streamFireworksModel,
    },
    local: localAdapterChatRuntime,
  });
  managedAdapterSyncService.start();
  const crossSystemChatToolRuntime = createCrossSystemChatToolRuntime({
    store,
    gradeAttempt: taskEvaluationService.grade,
  });
  const trainingChatSearchService = createTrainingChatSearchService({ store });
  const datasetImportService = createDatasetImportService({
    store,
    workerProjectDir: path.resolve(
      process.cwd(),
      "python",
      "openpond-training",
    ),
    datasetStorageRoot: async () =>
      (await computeService.settings()).datasetStorePath,
  });
  await datasetImportService.reconcile();
  const crossSystemFrontierModelStream: CrossSystemFrontierModelStream =
    async function* (input) {
      if (input.model.providerId === LOCAL_ADAPTER_PROVIDER_ID) {
        for await (const delta of trainedAdapterChatRuntime.stream({
          modelId: input.model.modelId,
          messages: input.messages,
          tools: input.tools,
          toolChoice: input.toolChoice,
          requestId: input.requestId,
          signal: input.signal,
        })) {
          yield { text: delta.text, toolCalls: delta.toolCalls };
        }
        return;
      }
      if (input.model.providerId === "openpond") {
        for await (const delta of streamOpenPondHostedChatTurn({
          model: input.model.modelId,
          messages: input.messages,
          tools: input.tools,
          toolChoice: input.toolChoice,
          requestId: input.requestId,
          signal: input.signal,
        })) {
          if (delta.type === "text_delta") yield { text: delta.text };
          if (delta.type === "continuation")
            yield { continuation: delta.continuation };
          if (delta.type === "tool_call_delta")
            yield { toolCalls: delta.toolCalls };
        }
        return;
      }
      const state = await localByokRuntimeState();
      for await (const delta of streamOpenAiCompatibleChatCompletion({
        providerId: input.model.providerId,
        settings: state.settings,
        secrets: state.secrets,
        modelId: input.model.modelId,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        requestId: input.requestId,
        signal: input.signal,
        reasoningEffort: input.reasoningEffort,
        saveChatGptSubscriptionCredential: async (providerId, credential) => {
          await writeProviderChatGptSubscriptionCredential({
            paths: providerSecretPaths,
            providerId,
            credential,
            timestamp: now(),
          });
        },
      })) {
        if (delta.type === "text_delta") yield { text: delta.text };
        if (delta.type === "continuation")
          yield { continuation: delta.continuation };
        if (delta.type === "tool_call_delta")
          yield { toolCalls: delta.toolCalls };
      }
    };
  trainingBaselineAttemptRunner = createTrainingBaselineAttemptRunner({
    store,
    storeDir,
    modelText: trainingModelText,
    crossSystemStream: crossSystemFrontierModelStream,
    timestamp: now,
  });
  const crossSystemFrontierBaselineService =
    createCrossSystemFrontierBaselineService({
      store,
      stream: crossSystemFrontierModelStream,
      findLocalProject: findLocalWorkspace,
      createEvidenceSource: ({
        profileId,
        model,
        localProject,
        task,
        trajectory,
      }) =>
        createFrontierBaselineChatSource({
          store,
          profileId,
          model,
          localProject,
          task,
          trajectory,
          createSession,
          appendRuntimeEvent,
          addSessionSource: taskCreatorService.addSessionSource,
        }),
    });
  const trainingApi = createTrainingApi({
    store,
    taskCreator: taskCreatorService,
    taskMiner: taskMinerService,
    evaluation: taskEvaluationService,
    training: trainingService,
    chatSearch: trainingChatSearchService,
    datasetArtifacts: datasetArtifactService,
    datasetImports: datasetImportService,
    frontierBaseline: crossSystemFrontierBaselineService,
  });

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
    getCodexStatus: codexStatusService.get,
    handleCodexServerRequest,
    mapCodexNotification,
    optionsVersion: options.version,
    setCodexStatus: (status) => {
      codexStatusService.set(status);
    },
    store,
    storeDir,
    updateSession,
  });

  const turnRunner = createTurnRunner({
    attachmentRootDir,
    store,
    resolveCreateImproveTaskset: (
      tasksetId: string,
      revision: number,
      contentHash: string
    ) => store.getTasksetRevision(tasksetId, revision, contentHash),
    gradeCreateImproveTaskAttempt: taskEvaluationService.grade,
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
    executeCrossSystemTool: crossSystemChatToolRuntime.execute,
    finalizeCrossSystemTurn: crossSystemChatToolRuntime.finalize,
    loadOpenPondProfileState,
    readOpenPondProfileSkill: readProfileSkill,
    executeProfileSkillCommand: ({ prompt }) =>
      runProfileSkillCommandFromPrompt(prompt),
    executeProfileSkillGoal: (input) => runProfileSkillGoalCommand(input),
    executeWebSearch: executeWebSearch ?? undefined,
    executeConnectedAppTool,
    browserToolExecutor: browserControlQueue.executor,
    manageSidebarFile: async ({ session, action, path: requestedPath }) => {
      if (action === "list") {
        const response = await listSidebarFileBookmarksPayload();
        return {
          ...response,
          changed: null,
          nextStep: response.items.length === 0
            ? "There are no pinned or saved files."
            : `Listed ${response.items.length} sidebar file${response.items.length === 1 ? "" : "s"}.`,
        };
      }
      const path = normalizeSidebarFilePath(requestedPath ?? "");
      const workspaceId = session.workspaceId ?? session.localProjectId ?? session.appId;
      if (!workspaceId) {
        throw new Error("This chat is not attached to a workspace, so it cannot manage a workspace file.");
      }
      const workspaceKind = session.workspaceKind === "local_project" ? "local" : "sandbox";
      const workspaceName = session.workspaceName ?? session.appName ?? session.title ?? workspaceId;
      const response = await patchSidebarFileBookmarkPayload({
        workspaceKind,
        workspaceId,
        workspaceName,
        path,
        status: action === "pin"
          ? "pinned"
          : action === "save_for_later"
            ? "saved_for_later"
            : "none",
        sourceSessionId: session.id,
      });
      const changed = response.items.find((item) =>
        item.workspaceKind === workspaceKind &&
        item.workspaceId === workspaceId &&
        item.path === path
      ) ?? null;
      const verb = action === "pin"
        ? "Pinned"
        : action === "save_for_later"
          ? "Saved"
          : "Removed";
      return {
        ...response,
        changed,
        nextStep: `${verb} ${path}${action === "save_for_later" ? " for later" : ""}.`,
      };
    },
    listIntegrationConnections: listSandboxIntegrationConnections,
    loadPersonalizationSoul: async () =>
      (await loadPersonalizationSettings(store, storeDir)).soul,
    loadAppPreferences,
    loadProviderSettings: async () => (await localByokRuntimeState()).settings,
    maybeCreateScaffoldForTurn,
    hostedSystemPrompt,
    appendAssistantText,
    appendHostedContextUsage,
    streamLocalByokChatTurn: async function* (input) {
      if (input.providerId === LOCAL_ADAPTER_PROVIDER_ID) {
        yield* trainedAdapterChatRuntime.stream({
          modelId: input.modelId,
          messages: input.messages,
          tools: input.tools,
          toolChoice: input.toolChoice,
          requestId: input.requestId,
          signal: input.signal,
        });
        return;
      }
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
        if (delta.type === "continuation") {
          yield { continuation: delta.continuation, raw: delta.raw };
        }
        if (delta.type === "tool_call_delta")
          yield { toolCalls: delta.toolCalls, raw: delta.raw };
        if (delta.type === "usage")
          yield { raw: delta.raw, usage: delta.usage };
        if (delta.type === "finish")
          yield { finishReason: delta.finishReason, raw: delta.raw };
      }
    },
    streamOpenPondHostedChatTurn,
    subagentQueue: workQueues.subagent,
    turnFollowUpQueue: workQueues.turnFollowUp,
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests: MAX_REPEATED_INVALID_TOOL_REQUESTS,
  });
  const {
    sendTurn,
    interruptSessionTurn,
    pauseSessionGoal,
    applyCreateImproveAction,
    getCreateImproveRun,
    listCreateImproveRuns,
    resolveCreateImproveApproval,
    resolveSubagentPatchApplyApproval,
    runSubagentLifecycleAction,
  } = turnRunner;
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
  const taskMinerBackgroundLoop = createTaskMinerBackgroundLoop({
    service: taskMinerService,
    loadProfileState: loadOpenPondProfileState,
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
  async function resolveApproval(
    approvalId: string,
    payload: unknown
  ): Promise<Approval> {
    const commandApproval = await openPondCommandAccess.resolveApproval(
      approvalId,
      payload
    );
    if (commandApproval) return commandApproval;
    const createImproveApproval = await resolveCreateImproveApproval(
      approvalId,
      payload
    );
    if (createImproveApproval) return createImproveApproval;
    const subagentPatchApplyApproval = await resolveSubagentPatchApplyApproval(
      approvalId,
      payload
    );
    if (subagentPatchApplyApproval) return subagentPatchApplyApproval;
    return resolveCodexApproval(approvalId, payload);
  }

  async function appendCodexCompactionCompletedIfNeeded(
    session: Awaited<ReturnType<typeof getSession>>,
    codexThreadId: string,
    reason: "manual",
    model: string | null
  ): Promise<RuntimeEvent> {
    const existing = findRecentCodexCompactionCompleted(
      await store.runtimeEventsForSession(session.id, {
        names: ["session.compaction.completed"],
        limit: 100,
      }),
      session.id,
      codexThreadId
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
    error: unknown
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
      })
    );
  }

  async function safeUpsertModelUsageRecord(
    record: ModelUsageRecord
  ): Promise<void> {
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
          output:
            error instanceof Error
              ? error.message
              : "Failed to persist model usage record.",
          data: {
            kind: "model_usage_record_failed",
            requestId: record.requestId,
            provider: record.provider,
            model: record.model,
          },
        })
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
      recorder: Awaited<
        ReturnType<typeof startProviderRequestUsageRecorder>
      > | null;
      finalized: boolean;
    } = { recorder: null, finalized: false };

    async function failUsageRecorder(error: unknown): Promise<void> {
      if (!usageState.recorder || usageState.finalized) return;
      usageState.finalized = true;
      await usageState.recorder.fail(
        error,
        error instanceof Error && error.name === "AbortError"
          ? "interrupted"
          : "failed"
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
                if (delta.type === "text_delta" && delta.text)
                  usageState.recorder.observeDelta({ text: delta.text });
                if (delta.type === "reasoning_delta" && delta.text) {
                  usageState.recorder.observeDelta({
                    reasoningText: delta.text,
                  });
                }
                if (delta.type === "usage")
                  usageState.recorder.observeDelta({ usage: delta.usage });
                if (delta.type === "text_delta" && delta.text)
                  yield { text: delta.text, raw: delta.raw };
                if (delta.type === "reasoning_delta" && delta.text)
                  yield { reasoningText: delta.text, raw: delta.raw };
                if (delta.type === "usage")
                  yield { usage: delta.usage, raw: delta.raw };
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
              saveChatGptSubscriptionCredential: async (
                providerId,
                credential
              ) => {
                await writeProviderChatGptSubscriptionCredential({
                  paths: providerSecretPaths,
                  providerId,
                  credential,
                  timestamp: now(),
                });
              },
            })) {
              if (delta.type === "text_delta" && delta.text)
                usageState.recorder.observeDelta({ text: delta.text });
              if (delta.type === "reasoning_delta" && delta.text) {
                usageState.recorder.observeDelta({ reasoningText: delta.text });
              }
              if (delta.type === "usage")
                usageState.recorder.observeDelta({ usage: delta.usage });
              if (delta.type === "text_delta" && delta.text)
                yield { text: delta.text, raw: delta.raw };
              if (delta.type === "reasoning_delta" && delta.text)
                yield { reasoningText: delta.text, raw: delta.raw };
              if (delta.type === "usage")
                yield { usage: delta.usage, raw: delta.raw };
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

  async function compactSession(
    sessionId: string,
    payload: unknown
  ): Promise<unknown> {
    const input = CompactSessionRequestSchema.parse(payload ?? {});
    const session = await getSession(sessionId);
    if (session.status === "active")
      throw new Error("Cannot compact context while a turn is running.");
    if (session.status === "closed")
      throw new Error("Cannot compact a closed session.");
    const requestedModel = input.model ?? session.modelRef?.modelId ?? null;

    const priorEvents = await store.runtimeEventsForSession(sessionId);
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
        const compacted = await runtime.client.compactThread({
          threadId: runtime.threadId,
        });
        const completedEvent =
          compacted.completion === "response"
            ? await appendCodexCompactionCompletedIfNeeded(
                session,
                runtime.threadId,
                input.reason,
                requestedModel
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
      const state =
        adapter.route === "local_byok" ? await localByokRuntimeState() : null;
      const maxContextTokens =
        adapter.route === "local_byok"
          ? trustedProviderContextLimit({
              provider: session.provider,
              model: requestedModel,
              settings: state?.settings ?? null,
            })
          : null;
      if (adapter.route === "local_byok" && !maxContextTokens) {
        throw new Error(
          `Context compaction for ${session.provider} requires a selected model with a trusted context window.`
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
        error
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
    const status =
      rawStatus === "active" ||
      rawStatus === "resolved" ||
      rawStatus === "dismissed" ||
      rawStatus === "all"
        ? rawStatus
        : "all";
    const rawLimit = Number(requestUrl.searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
    const rawEvidenceSource = requestUrl.searchParams.get("evidenceSource");
    const evidenceSource = isInsightEvidenceSourceFilter(rawEvidenceSource)
      ? rawEvidenceSource
      : "all";
    const rawRunStatus = requestUrl.searchParams.get("runStatus");
    const runStatus =
      rawRunStatus === "running" ||
      rawRunStatus === "completed" ||
      rawRunStatus === "failed" ||
      rawRunStatus === "skipped" ||
      rawRunStatus === "all"
        ? rawRunStatus
        : "all";
    const rawRunTrigger = requestUrl.searchParams.get("runTrigger");
    const runTrigger =
      rawRunTrigger === "startup" ||
      rawRunTrigger === "interval" ||
      rawRunTrigger === "manual" ||
      rawRunTrigger === "slash_command" ||
      rawRunTrigger === "all"
        ? rawRunTrigger
        : "all";
    const runModel = requestUrl.searchParams.get("runModel");
    return withInsightsSchedule(
      await insightsService.list({
        status,
        limit,
        evidenceSource,
        runStatus,
        runTrigger,
        runModel,
      })
    );
  }

  async function runInsightsScanPayload(requestUrl?: URL): Promise<unknown> {
    const rawTrigger = requestUrl?.searchParams.get("trigger");
    const trigger = rawTrigger === "slash_command" ? "slash_command" : "manual";
    return withInsightsSchedule(
      await insightsBackgroundLoop.scanNow({ force: true, trigger })
    );
  }

  async function askInsightsPayload(payload: unknown): Promise<unknown> {
    const input = InsightsAskRequestSchema.parse(payload);
    return withInsightsSchedule(await insightsService.ask(input.question));
  }

  async function patchInsightPayload(
    insightId: string,
    payload: unknown
  ): Promise<unknown> {
    const input = PatchInsightRequestSchema.parse(payload);
    return withInsightsSchedule(
      await insightsService.patchStatus(
        insightId,
        input.status as InsightStatus
      )
    );
  }

  function withInsightsSchedule<
    T extends InsightsListResponse | InsightsScanResponse
  >(payload: T): T {
    const status = insightsBackgroundLoop.status();
    return {
      ...payload,
      nextScanAt: status.nextScanAt,
      scanRunning: status.scanRunning,
      scanStartedAt: status.scanStartedAt,
    };
  }

  async function listLocalAgentSchedulesPayload(
    payload?: unknown
  ): Promise<unknown> {
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { localProjectId?: unknown })
        : {};
    return localAgentScheduleLoop.list({
      localProjectId:
        typeof input.localProjectId === "string" ? input.localProjectId : null,
    });
  }

  async function syncLocalAgentSchedulesPayload(): Promise<unknown> {
    return localAgentScheduleLoop.syncNow();
  }

  async function patchLocalAgentSchedulePayload(
    scheduleId: string,
    payload: unknown
  ): Promise<unknown> {
    const updated = await localAgentScheduleLoop.patchSchedule(
      scheduleId,
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { enabled?: boolean })
        : {}
    );
    if (!updated) throw new Error("Local agent schedule not found");
    return { schedule: updated };
  }

  async function runLocalAgentSchedulePayload(
    scheduleId: string,
    payload: unknown
  ): Promise<unknown> {
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { input?: unknown })
        : {};
    return localAgentScheduleLoop.runNow(
      scheduleId,
      input.input &&
        typeof input.input === "object" &&
        !Array.isArray(input.input)
        ? (input.input as Record<string, unknown>)
        : undefined
    );
  }

  async function listLocalAgentScheduleRunsPayload(
    scheduleId: string,
    payload?: unknown
  ): Promise<unknown> {
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { limit?: unknown })
        : {};
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    return { runs: await localAgentScheduleLoop.listRuns(scheduleId, limit) };
  }

  async function patchSessionPayload(
    sessionId: string,
    payload: unknown
  ): Promise<unknown> {
    return isCodexHistorySessionId(sessionId)
      ? patchCodexHistorySessionPayload(sessionId, payload)
      : patchSession(sessionId, payload);
  }

  async function runSessionCommandPayload(
    sessionId: string,
    payload: unknown
  ): Promise<unknown> {
    const input = RunSessionCommandRequestSchema.parse(payload);
    const session = await getSession(sessionId);
    if (session.provider === "codex" || isCodexHistorySessionId(session.id)) {
      throw new Error(
        "OpenPond command access is not available for Codex sessions."
      );
    }
    return runOpenPondDirectCommand(
      {
        appendRuntimeEvent,
        executeLocalCommand: openPondCommandAccess.executeCommand,
        executeWorkspaceTool,
        getSession,
        runtimeEventsForSession: (targetSessionId) =>
          store.runtimeEventsForSession(targetSessionId),
      },
      {
        session,
        command: input.command,
        cwd: input.cwd ?? null,
        timeoutSeconds: input.timeoutSeconds ?? null,
      }
    );
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
  const voiceTranscription = createVoiceTranscriptionService({
    storeDir,
    logger,
  });

  const { httpServer, terminalWebSockets } = createOpenPondHttpSurface({
    routeOptions: {
      host,
      getActualPort: () => actualPort,
      token,
      version,
      runtimeVersion,
      logger,
      openEventSubscriber,
      refreshCodexStatus,
      bootstrapPayload,
      skillSourceFilePayload,
      eventPagePayload,
      usageSummaryPayload: usageSummaryRoutePayload,
      usageRecordsPayload: usageRecordsRoutePayload,
      listInsightsPayload,
      runInsightsScanPayload,
      askInsightsPayload,
      patchInsightPayload,
      trainingPayload: trainingApi.request,
      fireworksRftPayload: trainingService.handleFireworksRft,
      computePayload,
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
      profileRenameAgentPayload,
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
      listSidebarFileBookmarksPayload,
      patchSidebarFileBookmarkPayload,
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
      communityPayload: communityRequestPayload,
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
      ensureCloudWorkspaceReady,
      recordPreflightTurnFailure,
      listCreateImproveRunsPayload: async (requestUrl) => ({
        schemaVersion: "openpond.createImprove.runList.v1",
        runs: await listCreateImproveRuns({
          profileId: requestUrl.searchParams.get("profileId"),
          conversationId: requestUrl.searchParams.get("conversationId"),
          targetKind: createImproveTargetKind(
            requestUrl.searchParams.get("targetKind")
          ),
          targetId: requestUrl.searchParams.get("targetId"),
          limit: createImproveLimit(requestUrl.searchParams.get("limit")),
        }),
        generatedAt: new Date().toISOString(),
      }),
      getCreateImproveRunPayload: getCreateImproveRun,
      getCreateImproveCandidateDiffPayload: async (runId, candidateId) => {
        const run = await getCreateImproveRun(runId);
        if (!run) throw new Error("Create/Improve run not found.");
        const candidate = run.candidates.find(
          (item) => item.id === candidateId
        );
        if (!candidate?.git?.headCommit)
          throw new Error("Candidate change is not available.");
        const repoPath =
          candidate.git.worktreePath ??
          (run.adapter.kind === "local" ||
          run.adapter.kind === "promote_local_to_hosted"
            ? run.adapter.repoPath
            : null);
        if (!repoPath)
          throw new Error("Candidate source is no longer available.");
        return loadGitCommitDiffAtPath(
          repoPath,
          `candidate:${run.id}:${candidate.id}`,
          candidate.git.baseCommit,
          candidate.git.headCommit
        );
      },
      applyCreateImproveAction,
      interruptSessionTurn,
      pauseSessionGoal,
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
  actualPort = await listenOpenPondHttpServer({
    host,
    httpServer,
    logger,
    port,
    serverId,
  });
  await turnRunner.recoverPendingSubagentCompletions();
  insightsBackgroundLoop.start();
  taskMinerBackgroundLoop.start();
  localAgentScheduleLoop.start();

  const status: ServerStatus = {
    id: serverId,
    host,
    port: actualPort,
    startedAt,
    storePath: store.storePath,
    version,
    runtimeVersion,
  };
  const closeServer = createServerShutdown({
    serverId,
    logger,
    httpServer,
    store,
    workQueues,
    codexSessions: codexSessions.values(),
    markClosing: () => {
      closing = true;
    },
    backgroundLoops: [
      insightsBackgroundLoop,
      taskMinerBackgroundLoop,
      localAgentScheduleLoop,
    ],
    browserControlQueue,
    closeEventSubscribers,
    terminalWebSockets,
    runtimeClosers: [
      waitForOpenPondRefresh,
      turnRunner.close,
      teamChatAiExecutions.close,
      trainedAdapterChatRuntime.close,
      managedAdapterSyncService.close,
      crossSystemChatToolRuntime.close,
      crossSystemFrontierBaselineService.close,
      taskMinerService.close,
      taskEvaluationService.close,
      trainingService.close,
      computeService.close,
      closeCloudWorkspaceReadiness,
      closeWorkspaceLsp,
      voiceTranscription.close,
    ],
  });

  return {
    url: `http://${host}:${actualPort}`,
    token,
    tokenFile,
    storePath: store.storePath,
    status,
    close: closeServer,
    testHooks: {
      drainWorkQueues: workQueues.drain,
      workQueueReceipts: workQueues.receipts,
    },
  };
}

function parseModelJudgeResult(
  raw: string
): {
  score: number;
  passed: boolean;
  feedback: string;
  evidenceRefs: string[];
} | null {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    const value = JSON.parse(normalized) as Record<string, unknown>;
    if (typeof value.score !== "number" || typeof value.passed !== "boolean")
      return null;
    return {
      score: Math.max(0, Math.min(1, value.score)),
      passed: value.passed,
      feedback:
        typeof value.feedback === "string"
          ? value.feedback.slice(0, 20_000)
          : "Model judge completed.",
      evidenceRefs: [],
    };
  } catch {
    return null;
  }
}

function resolveMaxHostedWorkspaceToolRounds(
  optionValue: number | undefined
): number {
  if (
    typeof optionValue === "number" &&
    Number.isFinite(optionValue) &&
    optionValue > 0
  ) {
    return Math.floor(optionValue);
  }
  const envValue = process.env.OPENPOND_HOSTED_WORKSPACE_TOOL_ROUNDS?.trim();
  if (!envValue) return DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS;
  if (/^(unlimited|infinite|infinity)$/i.test(envValue))
    return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS;
}

function isInsightEvidenceSourceFilter(
  value: string | null
): value is
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
  codexThreadId: string
): RuntimeEvent | null {
  const cutoff = Date.now() - 60_000;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    const timestamp = Date.parse(item.timestamp);
    if (Number.isFinite(timestamp) && timestamp < cutoff) return null;
    if (
      item.sessionId !== sessionId ||
      item.name !== "session.compaction.completed"
    )
      continue;
    const data =
      item.data && typeof item.data === "object"
        ? (item.data as Record<string, unknown>)
        : null;
    if (data?.provider === "codex" && data.codexThreadId === codexThreadId)
      return item;
  }
  return null;
}

function createImproveTargetKind(
  value: string | null
): "agent" | "skill" | "extension" | "model" | "configuration" | null {
  return value === "agent" ||
    value === "skill" ||
    value === "extension" ||
    value === "model" ||
    value === "configuration"
    ? value
    : null;
}

function createImproveLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

if (isCliEntrypoint(import.meta.url)) {
  void runOpenPondServerCli(createOpenPondServer).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
