#!/usr/bin/env node
import path from "node:path"; import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  CompactSessionRequestSchema,
  CreateHostedSavedWorkRequestSchema,
  RunSessionCommandRequestSchema,
  normalizeSidebarFilePath,
  type Approval,
  type ChatProvider,
  type ModelUsageRecord,
  type RuntimeEvent,
  type ServerStatus,
} from "@openpond/contracts";
import { detectCodexStatus } from "@openpond/codex-provider"; import { runAgentCompaction } from "@openpond/agent-runtime"; import { createAppServer } from "@openpond/app-server";
import {
  installAgentPackageIntoActiveProfile,
  loadOpenPondProfileLibrary,
  loadOpenPondProfileState,
  loadOpenPondProfileStateForRef,
  readProfileSkill,
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
import { createOpenPondAppServer } from "./app-server-runtime.js";
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
import {
  ensureSelectedLocalHarnessWorkspace,
  resolveSelectedLocalHarnessRelease,
} from "./harness/local-harness-selection.js";
import {
  ensureLocalHarnessRunOverlay,
  loadLocalHarnessRuntimeForAgentRun,
} from "./harness/local-harness-run-overlay.js";
import { createLocalHarnessImprovementRuntime } from "./harness/local-harness-improvement-runtime.js";
import { createLocalHarnessModelToolDefinitions } from "./harness/local-harness-model-tools.js";
import { createLocalHarnessSettingsRoutePayloads } from "./harness/local-harness-history.js";
import { createRefinerProfileRoutePayloads } from "./refiner/refiner-profile-service.js";
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
import { loadGitCommitDiffAtPath } from "./workspace/workspace-diff.js";
import { createCodexBridge } from "./runtime/codex-bridge.js";
import { createCodexRuntimeManager } from "./runtime/codex-runtime.js";
import { createServerPayloads } from "./api/server-payloads.js";
import { createProjectActionRunPayload } from "./project-actions/project-action-payload.js";
import { findLocalProject } from "./workspace/local-projects.js";
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
import {
  createWebFetchModelToolDefinition,
  createWebSearchModelToolDefinition,
} from "./openpond/model-tool-registry.js";
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
  autoTitlePromptFromPayload,
  createSessionTitleService,
  withPendingAutoTitle,
} from "./session-title-service.js";
import { createOpenPondHttpSurface, listenOpenPondHttpServer } from "./api/server-http.js";
import { createServerWorkQueues } from "./runtime/background-worker-queue.js";
import { createServerShutdown } from "./runtime/server-shutdown.js";
import { createTurnRunner } from "./runtime/turn-runner.js";
import { createAgentRuntimePorts } from "./runtime/agent-runtime-host.js";
import { reviewSelectedLocalHarnessEvaluation } from "./harness/local-harness-evaluation-review.js";
import { createLocalHarnessEvaluationReviewModelStream } from "./harness/local-harness-evaluation-review-model.js";
import { createLocalHarnessEvaluationReviewScheduler } from "./harness/local-harness-evaluation-review-scheduler.js";
import { startProviderRequestUsageRecorder } from "./runtime/model-usage-recorder.js";
import { createWorkspaceToolExecutor } from "./workspace-tools/workspace-tool-executor.js";
import { createWorkOutputService } from "./work/work-output-service.js";
import { createWorkSandboxLifecycleService } from "./work/work-sandbox-lifecycle-service.js";
import { createDesktopWorkEvidenceApi } from "./work/work-evidence-api.js";
import { createWorkAgentPackageService } from "./work/work-agent-package-service.js";
import { createWorkAgentSdkArchiveLoader } from "./work/work-agent-sdk-archive.js";
import { createServerWorkspaceWorkflows } from "./workspace/server-workspace-workflows.js";
import { organizationRequestPayload } from "./openpond/organizations.js";
import {
  listSandboxIntegrationConnections,
  sandboxRequestPayload,
} from "./openpond/sandboxes.js";
import {
  createHostedSavedWork,
  deleteHostedSavedWork,
  listHostedSavedWork,
  runHostedSavedWork,
  updateHostedSavedWork,
} from "./openpond/saved-work.js";
import { createRemoteAccessManager } from "./remote-access/tailscale.js";
import { createVoiceTranscriptionService } from "./voice-transcription.js";
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
import {
  loadTasksetAuthoringProfileSkill,
  loadTasksetAuthoringSkillArtifact,
  readTasksetAuthoringProfileSkill,
} from "./training/task-authoring-skill.js";
import {
  isBundledAuthoringSkillName,
  loadBundledAuthoringSkills,
  readBundledAuthoringProfileSkill,
} from "./runtime/bundled-authoring-skills.js";
import { createTaskMinerService } from "./training/task-miner.js";
import { createTaskMinerBackgroundLoop } from "./training/task-miner-background-loop.js";
import { createTaskEvaluationService } from "./training/evaluation-service.js";
import {
  createImproveLimit,
  createImproveTargetKind,
  findRecentCodexCompactionCompleted,
  resolveMaxHostedWorkspaceToolRounds,
} from "./server-entry-helpers.js";
import { createTrainingService } from "./training/training-service.js";
import { createModelProjectHostingService } from "./training/model-project-hosting.js";
import { managedRlOperatorAccess } from "./training/managed-rl-operator-access.js";
import { createTrainingApi } from "./training/training-api.js";
import { runLocalHarnessEvaluationBaseline } from "./harness/local-harness-taskset-review.js";
import { createTrainingChatSearchService } from "./training/training-chat-search.js";
import { createDatasetArtifactService } from "./training/dataset-artifact-service.js";
import { createDatasetImportService } from "./training/dataset-imports/import-service.js";
import { createHarnessRefinerBenchmarkService } from "./training/harness-refiner-benchmark-service.js";
import { createTaskAttemptModelJudge } from "./training/task-attempt-grader-evidence.js";
import { createPreferenceComparisonService } from "./training/preference-comparison-service.js";
import { createPreferenceComparisonModelJudge } from "./training/preference-comparison-model-judge.js";
import { createPreferenceComparisonVisualLoader } from "./training/preference-comparison-visuals.js";
import { createHarnessRefinerBenchmarkModelStream } from "./training/harness-refiner-benchmark-model.js";
import { resolveBenchmarkUpstreamModel } from "./training/training-model-runtime.js";
import { createBenchmarkRuntimeComposition } from "./training/benchmark-runtime-composition.js";
import { createDatasetStorageService } from "./training/dataset-storage-service.js";
import { createPortableTrainingServerDependencies } from "./training/portable-training-server-dependencies.js";
import { createMediaPayloads } from "./api/media-payloads.js";
import { createProfileTurnDependencies } from "./runtime/profile-turn-dependencies.js";
import { normalizeAppPreferences } from "./preferences.js";
import { createManagedAdapterRegistryClient } from "./training/managed-adapter-registry-client.js";
import { resolveManagedAdapterUserAccess } from "./openpond/hosted-api-access.js";
import { createManagedAdapterSyncService } from "./training/managed-adapter-sync-service.js";
import { createManagedAdapterChatRuntime } from "./training/managed-adapter-chat-runtime.js";
import { createTrainingModelRuntime } from "./training/training-model-runtime.js";
import {
  listManagedAdapterProviderModels,
  withManagedAdapterProviderModels,
} from "./training/managed-adapter-models.js";

export type { OpenPondServerInstance, OpenPondServerOptions } from "./types.js";
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
  const harnessEvaluationReviewStream =
    createLocalHarnessEvaluationReviewModelStream(streamOpenPondHostedChatTurn);
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
  await ensureSelectedLocalHarnessWorkspace({
    store,
    storeDir,
    loadProfileState: loadOpenPondProfileState,
    now,
  }).catch((error) => {
    logger.warn("local Harness workspace initialization failed; temporary Profile adapter remains active", {
      error,
    });
  });
  const workEvidenceApi = createDesktopWorkEvidenceApi({ store, storeDir });
  const startedAt = now();
  const serverId = randomUUID();
  const workOutputService = createWorkOutputService({
    deviceId: serverId,
    storeDir,
    runtimeEventsForSession: (sessionId) =>
      store.runtimeEventsForSession(sessionId),
  });
  const workAgentPackageService = createWorkAgentPackageService({
    deviceId: serverId,
    storeDir,
    runtimeEventsForSession: (sessionId) =>
      store.runtimeEventsForSession(sessionId),
    loadAgentSdkArchive: createWorkAgentSdkArchiveLoader({ storeDir }),
    installAgentPackage: installAgentPackageIntoActiveProfile,
  });
  const {
    appendRuntimeEvent,
    closeEventSubscribers,
    openEventSubscriber,
    subscribeRuntimeEvents,
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
    localProjectActionCatalogPayload,
    patchSidebarAppPreference,
    listSidebarFileBookmarksPayload,
    patchSidebarFileBookmarkPayload,
    reorderSidebarApps,
    refreshOpenPondPayload,
    loadMoreOpenPondAppsPayload,
    switchOpenPondPayload,
    saveOpenPondAccountPayload,
    removeOpenPondAccountPayload,
    updateOpenPondAccountConfigPayload,
    profileCurrentPayload,
    profileCatalogPayload,
    profileSelectPayload,
    profileRemovePayload,
    profilePublicationPreviewPayload,
    profilePublicationPublishPayload,
    profileInstallPayload,
    profileUpdatePayload,
    profileInitPayload,
    profileLoadPayload,
    profileCheckPayload,
    profileRenameAgentPayload,
    profileCommitPayload,
    profilePushPayload,
    profileRunPayload,
    extensionCatalogPayload,
    extensionPreviewPayload,
    extensionAddPayload,
    extensionUpdatePayload,
    extensionUpdateAllPayload,
    extensionRemovePayload,
    loadExtensionCatalog,
    readExtensionSkill,
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
  const projectActionRunPayload = createProjectActionRunPayload({
    appendRuntimeEvent,
    resolveProjectRoot: async (projectId) =>
      (await findLocalProject(store, projectId))?.workspacePath ?? null,
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
    createManagedLocalWorkCwd: async (sessionId) => {
      const workspacePath = path.join(storeDir, "work", "tasks", sessionId);
      await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });
      return workspacePath;
    },
    loadAppPreferences,
    appendRuntimeEvent,
    loadLastUsedProfile: async () =>
      (await loadOpenPondProfileLibrary()).lastUsed,
  });
  const sessionTitleService = createSessionTitleService({
    appendRuntimeEvent,
    getSession,
    logger,
    stream: streamOpenPondHostedChatTurn,
    updateSession,
  });
  const createSessionWithAutoTitle: typeof createSession = async (payload) => {
    const prompt = autoTitlePromptFromPayload(payload);
    const session = await createSession(withPendingAutoTitle(payload));
    if (prompt) sessionTitleService.schedule(session.id, prompt);
    return session;
  };

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
    deleteWorkOutput: workOutputService.deleteWorkOutput,
    readWorkOutput: workOutputService.readWorkOutput,
    prepareWorkAgent: workAgentPackageService.prepareWorkAgent,
    promoteWorkAgentPackage: workAgentPackageService.promoteWorkAgentPackage,
    saveWorkAgentPackage: workAgentPackageService.saveWorkAgentPackage,
    saveWorkOutput: workOutputService.saveWorkOutput,
  });
  const openPondCommandAccess = createOpenPondCommandAccessService({
    upsertApproval,
    appendRuntimeEvent,
  });
  const workSandboxLifecycle = createWorkSandboxLifecycleService({
    storeDir,
    saveAllWorkOutputs: workOutputService.saveAllWorkOutputs,
    sandboxRequest: sandboxRequestPayload,
    updateSession,
    appendRuntimeEvent,
  });
  const {
    maybeCreateScaffoldForTurn,
    hostedSystemPrompt,
    appendAssistantText,
    appendHostedContextUsage,
  } = createHostedTurnHelpers({
    appendRuntimeEvent,
    onRepositoryInstructionDiagnostic: (diagnostic, session) => {
      logger.warn("repository instruction file skipped", {
        diagnostic,
        sessionId: session.id,
      });
    },
  });

  async function localByokRuntimeState() {
    const [file, secrets, managedAdapterModels] = await Promise.all([
      readProvidersFile(providersFilePath),
      readProviderSecrets(providerSecretPaths),
      listManagedAdapterProviderModels(store),
    ]);
    return {
      secrets,
      settings: withManagedAdapterProviderModels(
        buildProviderSettings({
          file,
          secrets,
          codex: codexStatusService.get(),
          catalog: cachedProviderCatalog(file),
        }),
        managedAdapterModels
      ),
    };
  }
  const { trainingModelText, trainingModelStream } =
    createTrainingModelRuntime({
      loadLocalByokRuntimeState: localByokRuntimeState,
      getManagedAdapterChatRuntime: () => managedAdapterChatRuntime,
      streamOpenPondHostedChatTurn,
    });

  const tasksetAuthoringSkillArtifact = await loadTasksetAuthoringSkillArtifact();
  const tasksetAuthoringSkillText = tasksetAuthoringSkillArtifact.bundle;
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
  const datasetArtifactService = createDatasetArtifactService({
    store,
    workerProjectDir: path.resolve(process.cwd(), "python", "openpond-datasets"),
  });
  const {
    benchmarkTasksets,
    localTasksetWorkRuntime,
    resolveReleasedHarness,
    tasksetWorkRuntime,
  } = createBenchmarkRuntimeComposition({
    store,
    storeDir,
    deviceId: serverId,
    createSession,
    getSession,
    executeWorkspaceTool,
  });
  const taskEvaluationModelJudge = createTaskAttemptModelJudge({
    store,
    modelText: trainingModelText,
  });
  const preferenceComparisonModelJudge = createPreferenceComparisonModelJudge({
    modelText: trainingModelText,
    loadVisualCandidates: createPreferenceComparisonVisualLoader({ store }).loadVisualCandidates,
  });
  const preferenceComparisonService = createPreferenceComparisonService({
    store,
    storeDir,
    // The local server is already protected by its bearer boundary. Hosted
    // deployments replace this with organization-scoped authorization.
    authorize: ({ reviewerKey }) => Boolean(reviewerKey.trim()),
    modelJudge: preferenceComparisonModelJudge,
  });
  const taskEvaluationService = createTaskEvaluationService({
    store,
    storeDir,
    modelText: trainingModelText,
    modelStream: trainingModelStream,
    workRuntime: tasksetWorkRuntime,
    additionalWorkToolDefinitions: () => [
      createWebFetchModelToolDefinition(),
      createWebSearchModelToolDefinition({ executeWebSearch }),
    ],
    resolveTasksetRelease: (taskset) =>
      benchmarkTasksets.releaseForTaskset(taskset),
    resolveReleasedHarness,
    resolveTask: ({ tasksetId, taskId, split }) =>
      datasetArtifactService.task(tasksetId, taskId, split),
    modelJudge: taskEvaluationModelJudge,
  });
  const localBenchmarkEvaluationService = createTaskEvaluationService({
    store,
    storeDir,
    modelText: trainingModelText,
    modelStream: trainingModelStream,
    workRuntime: localTasksetWorkRuntime,
    additionalWorkToolDefinitions: () => [
      createWebFetchModelToolDefinition(),
      createWebSearchModelToolDefinition({ executeWebSearch }),
    ],
    resolveTasksetRelease: (taskset) =>
      benchmarkTasksets.releaseForTaskset(taskset),
    resolveReleasedHarness,
    resolveTask: ({ tasksetId, taskId, split }) =>
      datasetArtifactService.task(tasksetId, taskId, split),
    modelJudge: taskEvaluationModelJudge,
  });
  const datasetStorageService = createDatasetStorageService({ storeDir });
  const managedAdapterRegistryClient = createManagedAdapterRegistryClient();
  const managedAdapterSyncService = createManagedAdapterSyncService({
    store,
    client: managedAdapterRegistryClient,
    resolveSelectedTeamId: async () => {
      const entry = await store.getCacheEntry<unknown>(
        APP_PREFERENCES_CACHE_TYPE,
        APP_PREFERENCES_CACHE_KEY
      );
      return normalizeAppPreferences(entry?.payload).defaultTeamId;
    },
  });
  const datasetStoragePayload = async (action: "state" | "update", payload?: unknown) =>
    action === "state" ? datasetStorageService.state() : datasetStorageService.update(payload);
  const portableTrainingDependencies = createPortableTrainingServerDependencies(
    {
      storeDir,
      environment: process.env,
    }
  );
  const resolveManagedTrainingAccess = async () => {
    const operatorAccess = await managedRlOperatorAccess(process.env);
    if (operatorAccess) return operatorAccess;
    const entry = await store.getCacheEntry<unknown>(
      APP_PREFERENCES_CACHE_TYPE,
      APP_PREFERENCES_CACHE_KEY
    );
    const teamId = normalizeAppPreferences(entry?.payload).defaultTeamId;
    return resolveManagedAdapterUserAccess({ teamId });
  };
  const modelProjectHosting = createModelProjectHostingService({
    store,
    resolveAccess: resolveManagedTrainingAccess,
    env: process.env,
  });
  const trainingService = createTrainingService({
    store,
    storeDir,
    ...portableTrainingDependencies,
    resolveManagedTrainingAccess,
    loadProfileState: loadOpenPondProfileState,
    resolveReleasedHarness,
    resolveApprovalActor: async () => {
      const account = (await bootstrapPayload()).account;
      if (account.state !== "signed_in") return null;
      return account.profile?.handle?.trim() || null;
    },
    gradeTaskAttempt: taskEvaluationService.grade,
    projectDatasetArtifact: datasetArtifactService.project,
    resolveDatasetTask: ({ tasksetId, taskId, split }) =>
      datasetArtifactService.task(tasksetId, taskId, split),
    tasksetWorkRuntime,
    deactivateManagedBinding: managedAdapterSyncService.deactivateBinding,
    reactivateManagedBinding: managedAdapterSyncService.reactivateBinding,
    activateManagedBinding: managedAdapterSyncService.activateBinding,
  });
  const managedAdapterChatRuntime = createManagedAdapterChatRuntime({
    store,
    client: managedAdapterRegistryClient,
  });
  managedAdapterSyncService.start();
  const trainingChatSearchService = createTrainingChatSearchService({ store });
  const datasetImportService = createDatasetImportService({
    store,
    workerProjectDir: path.resolve(
      process.cwd(),
      "python",
      "openpond-datasets"
    ),
    datasetStorageRoot: async () =>
      (await datasetStorageService.settings()).datasetStorePath,
  });
  await datasetImportService.reconcile();
  const harnessRefinerBenchmarks = createHarnessRefinerBenchmarkService({
    store,
    storeDir,
    evaluation: localBenchmarkEvaluationService,
    benchmarkTasksets,
    loadProfileState: loadOpenPondProfileState,
    refinerStream: createHarnessRefinerBenchmarkModelStream(
      streamOpenPondHostedChatTurn,
    ),
    resolveUpstreamModel: resolveBenchmarkUpstreamModel,
  });
  await harnessRefinerBenchmarks.reconcileInterrupted();
  const trainingApi = createTrainingApi({
    store,
    storeDir,
    taskCreator: taskCreatorService,
    taskMiner: taskMinerService,
    evaluation: taskEvaluationService,
    training: trainingService,
    chatSearch: trainingChatSearchService,
    datasetArtifacts: datasetArtifactService,
    datasetImports: datasetImportService,
    benchmarkTasksets,
    harnessRefinerBenchmarks,
    preferenceComparisons: preferenceComparisonService,
    modelProjectHosting,
    modelStream: trainingModelStream,
  });
  const trainingPayload = trainingApi.request;
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

  const processLocalHarnessImprovementBoundary =
    createLocalHarnessImprovementRuntime({
      store,
      storeDir,
      queue: workQueues.turnFollowUp,
      streamOpenPondHostedChatTurn,
      appendRuntimeEvent,
      upsertModelUsageRecord: safeUpsertModelUsageRecord,
    });
  await processLocalHarnessImprovementBoundary.reconcilePending();

  const turnRunner = createTurnRunner({
    attachmentRootDir,
    store,
    loadSelectedHarnessRuntime: (session) =>
      loadLocalHarnessRuntimeForAgentRun(store, session.id),
    ensureHarnessRunOverlay: (input) =>
      ensureLocalHarnessRunOverlay({ store, ...input }),
    harnessModelTools: createLocalHarnessModelToolDefinitions({ store, storeDir }),
    processHarnessImprovementBoundary: processLocalHarnessImprovementBoundary,
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
    finalizeWorkTurn: workSandboxLifecycle.finalizeTurn,
    workInputsForSession: workOutputService.workInputsForSession,
    executeOpenPondCommand: openPondCommandAccess.executeCommand,
    executeProfileAction: profileRunPayload,
    executeProjectAction: projectActionRunPayload,
    executeDatasetBuilderAction: async ({
      session,
      provider,
      model,
      action,
      payload,
    }) => {
      const profile = session.currentProfile
        ? await loadOpenPondProfileStateForRef(session.currentProfile)
        : await loadOpenPondProfileState();
      const profileId =
        session.currentProfile?.profileId ?? profile.activeProfile ?? "default";
      const creationId =
        typeof payload.creationId === "string" ? payload.creationId : null;
      const tasksetId =
        typeof payload.tasksetId === "string" ? payload.tasksetId : null;
      if (action === "start") {
        return trainingApi.request("start_creation", {
          profileId,
          sourceIds: Array.isArray(payload.sourceIds) ? payload.sourceIds : [],
          surface: "training_page",
          mode: payload.mode === "customize" ? "customize" : "defaults",
          entryMode: "manual",
          resourceIntent: "dataset",
          buildIntent: payload.buildIntent,
          buildSpecification: payload.buildSpecification,
          objective: payload.objective,
          methodHint: payload.methodHint,
          analysisModel: { providerId: provider, modelId: model },
          targetIntent: {
            kind: null,
            id: null,
            displayName: null,
            operation: "create",
          },
        });
      }
      if (action === "status")
        return trainingApi.request("state", { profileId });
      if (
        !creationId &&
        [
          "revise",
          "answer_questions",
          "approve_disclosure",
          "materialize",
          "cancel",
        ].includes(action)
      ) {
        throw new Error(
          "creationId is required for this Dataset Builder action."
        );
      }
      if (action === "revise") {
        return trainingApi.request("chat_creation", {
          creationId,
          message: payload.message,
        });
      }
      if (action === "answer_questions") {
        return trainingApi.request("answer_questions", {
          creationId,
          answers: payload.answers,
        });
      }
      if (action === "approve_disclosure") {
        return trainingApi.request("approve_disclosure", {
          creationId,
          approved: payload.approved === true,
        });
      }
      if (action === "materialize") {
        return trainingApi.request("approve_materialization", {
          creationId,
          approved: payload.approved === true,
        });
      }
      if (action === "cancel") {
        return trainingApi.request("cancel_creation", { creationId });
      }
      if (!tasksetId)
        throw new Error("tasksetId is required for Dataset testing.");
      if (action === "audit_graders") {
        return trainingApi.request("audit_graders", { tasksetId });
      }
      if (action === "calibrate_judges") {
        return trainingApi.request("calibrate_judges", { tasksetId });
      }
      if (action === "readiness") {
        return trainingApi.request("readiness", { tasksetId });
      }
      return trainingApi.request("baseline", {
        tasksetId,
        models: [{ providerId: provider, modelId: model }],
        seeds: [17],
        attemptsPerTask:
          typeof payload.attemptsPerTask === "number"
            ? payload.attemptsPerTask
            : 4,
        taskLimit:
          typeof payload.taskLimit === "number" ? payload.taskLimit : 8,
        split: payload.split ?? "train",
        selectionStrategy: "rft_easy_curriculum_v1",
      });
    },
    loadOpenPondProfileState,
    ...createProfileTurnDependencies(),
    loadOpenPondProfileLibrary,
    readOpenPondProfileSkill: readProfileSkill,
    loadBuiltInOpenPondSkills: async () => [
      await loadTasksetAuthoringProfileSkill(),
      ...(await loadBundledAuthoringSkills()),
    ],
    readBuiltInOpenPondSkill: async (name) => {
      if (name === "openpond-taskset-authoring")
        return readTasksetAuthoringProfileSkill();
      if (isBundledAuthoringSkillName(name))
        return readBundledAuthoringProfileSkill(name);
      throw new Error(`Built-in OpenPond skill not found: ${name}`);
    },
    loadOpenPondExtensionCatalog: loadExtensionCatalog,
    readOpenPondExtensionSkill: readExtensionSkill,
    executeWebSearch: executeWebSearch ?? undefined,
    createScheduledWork: createHostedSavedWork,
    executeConnectedAppTool,
    browserToolExecutor: browserControlQueue.executor,
    manageSidebarFile: async ({ session, action, path: requestedPath }) => {
      if (action === "list") {
        const response = await listSidebarFileBookmarksPayload();
        return {
          ...response,
          changed: null,
          nextStep:
            response.items.length === 0
              ? "There are no pinned or saved files."
              : `Listed ${response.items.length} sidebar file${
                  response.items.length === 1 ? "" : "s"
                }.`,
        };
      }
      const path = normalizeSidebarFilePath(requestedPath ?? "");
      const workspaceId =
        session.workspaceId ?? session.localProjectId ?? session.appId;
      if (!workspaceId) {
        throw new Error(
          "This chat is not attached to a workspace, so it cannot manage a workspace file."
        );
      }
      const workspaceKind =
        session.workspaceKind === "local_project" ? "local" : "sandbox";
      const workspaceName =
        session.workspaceName ??
        session.appName ??
        session.title ??
        workspaceId;
      const response = await patchSidebarFileBookmarkPayload({
        workspaceKind,
        workspaceId,
        workspaceName,
        path,
        status:
          action === "pin"
            ? "pinned"
            : action === "save_for_later"
            ? "saved_for_later"
            : "none",
        sourceSessionId: session.id,
      });
      const changed =
        response.items.find(
          (item) =>
            item.workspaceKind === workspaceKind &&
            item.workspaceId === workspaceId &&
            item.path === path
        ) ?? null;
      const verb =
        action === "pin"
          ? "Pinned"
          : action === "save_for_later"
          ? "Saved"
          : "Removed";
      return {
        ...response,
        changed,
        nextStep: `${verb} ${path}${
          action === "save_for_later" ? " for later" : ""
        }.`,
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
      if (input.providerId === "openpond" && await managedAdapterChatRuntime.appliesTo(input.modelId)) {
        yield* managedAdapterChatRuntime.stream({
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
        maxOutputTokens: input.maxOutputTokens,
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
    applyCreateImproveAction,
    getCreateImproveRun,
    listCreateImproveRuns,
    resolveCreateImproveApproval,
    resolveSubagentPatchApplyApproval,
    runSubagentLifecycleAction,
  } = turnRunner;
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
    loadProfileLibrary: loadOpenPondProfileLibrary,
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
    return runAgentCompaction({
      started: async () => { await appendRuntimeEvent(startedEvent); },
      compact: async () => {
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
          continuationCapsule: result.continuationCapsule,
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
      },
      failed: async (error) => {
        await appendCompactionFailed(
          session,
          session.provider,
          requestedModel,
          input.reason,
          error
        );
      },
    });
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

  async function listWorkOutputsPayload(): Promise<unknown> {
    return workOutputService.listWorkOutputs(await store.sessionShells());
  }

  async function listHostedSavedWorkPayload(): Promise<unknown> {
    return listHostedSavedWork();
  }

  async function createHostedSavedWorkPayload(
    payload: unknown
  ): Promise<unknown> {
    return createHostedSavedWork(
      CreateHostedSavedWorkRequestSchema.parse(payload)
    );
  }

  async function updateHostedSavedWorkPayload(
    scheduleId: string,
    payload: unknown
  ): Promise<unknown> {
    return updateHostedSavedWork(scheduleId, payload);
  }

  async function deleteHostedSavedWorkPayload(
    scheduleId: string
  ): Promise<unknown> {
    return deleteHostedSavedWork(scheduleId);
  }

  async function runHostedSavedWorkPayload(
    scheduleId: string,
    clientRequestId: string
  ): Promise<unknown> {
    if (!clientRequestId.trim()) {
      throw new Error("clientRequestId is required to run scheduled Work.");
    }
    return runHostedSavedWork(scheduleId, clientRequestId);
  }

  async function usageSummaryRoutePayload(requestUrl: URL): Promise<unknown> {
    return usageSummaryPayload({ requestUrl, store });
  }

  async function usageRecordsRoutePayload(requestUrl: URL): Promise<unknown> {
    return usageRecordsPayload({ requestUrl, store });
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

  const harnessSettingsRoutes = createLocalHarnessSettingsRoutePayloads({ store, storeDir, evaluationReviewStream: harnessEvaluationReviewStream });
  const refinerSettingsRoutes = createRefinerProfileRoutePayloads(storeDir);
  const harnessEvaluationReviewScheduler = createLocalHarnessEvaluationReviewScheduler({
    store,
    storeDir,
    stream: harnessEvaluationReviewStream,
    isClosing: () => closing,
    logger,
  });

  const agentRuntime = createAppServer({
    ports: createAgentRuntimePorts({
      createSession: createSessionWithAutoTitle,
      getSession,
      turnsForSession: (sessionId) => store.turnsForSession(sessionId, 1_000),
      runtimeEventsForSession: (sessionId) =>
        store.runtimeEventsForSession(sessionId),
      sendTurn,
      isSessionTurnActive: turnRunner.isSessionTurnActive,
      waitForSessionTurnSettlement: turnRunner.waitForSessionTurnSettlement,
      interruptSessionTurn,
      resolveApproval,
      inspectHarness: harnessSettingsRoutes.harnessHistoryPayload,
      reviewHarnessProposal: harnessSettingsRoutes.reviewHarnessProposalPayload,
      reviewHarness: (request) => reviewSelectedLocalHarnessEvaluation({
        store,
        request,
        stream: harnessEvaluationReviewStream,
        continuation: { storeDir, stream: harnessEvaluationReviewStream },
      }),
      acceptHarnessEvaluationReview: async (request) => {
        const profile = await loadOpenPondProfileState();
        return trainingApi.request("accept_harness_review", {
          ...(request && typeof request === "object" && !Array.isArray(request)
            ? request
            : {}),
          profileId: profile.activeProfile ?? "default",
        });
      },
      materializeHarnessEvaluationTaskset: async (request) => {
        const input = request && typeof request === "object" && !Array.isArray(request)
          ? request as Record<string, unknown>
          : {};
        return trainingApi.request("approve_materialization", {
          creationId: input.creationId,
          approved: true,
        });
      },
      runHarnessEvaluationBaseline: (request) => runLocalHarnessEvaluationBaseline({ store, evaluation: taskEvaluationService, request }),
      validateHarness: async () => {
        const release = await resolveSelectedLocalHarnessRelease(store);
        return release
          ? {
              valid: true,
              workspaceId: release.workspaceId,
              harnessRelease: release.harnessRelease,
              agentSnapshot: release.agentSnapshot,
            }
          : { valid: false, reason: "No Local Harness release is selected." };
      },
      updateHarnessBackgroundReview:
        harnessSettingsRoutes.updateHarnessBackgroundReviewPayload,
      diffHarness: harnessSettingsRoutes.harnessDiffPayload,
      rollbackHarness: harnessSettingsRoutes.rollbackHarnessPayload,
      ...refinerSettingsRoutes,
      subscribeRuntimeEvents,
      observeRuntimeOperation: (runtimeEvent) => {
        logger.info("agent runtime operation", runtimeEvent);
      },
    }),
  }).runtime;

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
      localProjectActionCatalogPayload,
      skillSourceFilePayload,
      extensionCatalogPayload,
      extensionPreviewPayload,
      extensionAddPayload,
      extensionUpdatePayload,
      extensionUpdateAllPayload,
      extensionRemovePayload,
      eventPagePayload,
      listWorkOutputsPayload,
      captureWorkEvidencePayload: workEvidenceApi.capture,
      getWorkEvidencePayload: workEvidenceApi.get,
      recordWorkEvidenceFeedbackPayload: workEvidenceApi.recordFeedback,
      listWorkEvidenceFeedbackPayload: workEvidenceApi.listFeedback,
      classifyWorkEvidencePayload: workEvidenceApi.eligibility,
      ...harnessSettingsRoutes,
      ...refinerSettingsRoutes,
      listHostedSavedWorkPayload,
      createHostedSavedWorkPayload,
      updateHostedSavedWorkPayload,
      deleteHostedSavedWorkPayload,
      runHostedSavedWorkPayload,
      usageSummaryPayload: usageSummaryRoutePayload,
      usageRecordsPayload: usageRecordsRoutePayload,
      trainingPayload,
      datasetStoragePayload,
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
      removeOpenPondAccountPayload,
      updateOpenPondAccountConfigPayload,
      profileCurrentPayload,
      profileCatalogPayload,
      profileSelectPayload,
      profileRemovePayload,
      profilePublicationPreviewPayload,
      profilePublicationPublishPayload,
      profileInstallPayload,
      profileUpdatePayload,
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
      ...createMediaPayloads(attachmentRootDir),
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
      agentRuntime,
      createSession: createSessionWithAutoTitle,
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
  if (options.httpEnabled !== false) {
    actualPort = await listenOpenPondHttpServer({
      host,
      httpServer,
      logger,
      port,
      serverId,
    });
  } else {
    actualPort = 0;
  }
  await turnRunner.recoverPendingSubagentCompletions();
  workSandboxLifecycle.start();
  if (options.httpEnabled !== false) {
    localAgentScheduleLoop.start();
    harnessEvaluationReviewScheduler.start();
  }

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
      taskMinerBackgroundLoop,
      localAgentScheduleLoop,
      harnessEvaluationReviewScheduler,
    ],
    browserControlQueue,
    closeEventSubscribers,
    terminalWebSockets,
    runtimeClosers: [
      waitForOpenPondRefresh,
      turnRunner.close,
      teamChatAiExecutions.close,
      managedAdapterSyncService.close,
      taskMinerService.close,
      taskEvaluationService.close,
      trainingService.close,
      closeCloudWorkspaceReadiness,
      closeWorkspaceLsp,
      voiceTranscription.close,
      workSandboxLifecycle.close,
    ],
  });

  return {
    agentRuntime,
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

if (isCliEntrypoint(import.meta.url)) {
  void runOpenPondServerCli({
    createOpenPondServer,
    createOpenPondAppServer,
  }).catch((error) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : String(error)
    );
    process.exit(1);
  });
}
