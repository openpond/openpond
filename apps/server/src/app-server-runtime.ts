import { reconcileInterruptedScheduledWork } from "./runtime/scheduled-work-recovery.js";
import { initializeRefinerProfile } from "./refiner/refiner-profile-service.js";
import { initializeHome, readPreferences } from "@openpond/persistence";
import { onStartupFailure, ownHomeRuntime } from "./runtime/home-runtime-owner.js";
import path from "node:path";
import { mkdir } from "node:fs/promises";

import { createAppServer, type AppServerInstance } from "@openpond/app-server";
import {
  localPathWorkspaceId,
  type Approval,
  type ModelUsageRecord,
  type OpenPondApp,
  type RuntimeEvent,
} from "@openpond/contracts";
import {
  loadOpenPondProfileLibrary,
  loadOpenPondProfileState,
  loadOpenPondProfileStateFromSource,
  readProfileSkill,
} from "@openpond/cloud";
import { createLogger } from "@openpond/logging";
import { contentHash } from "@openpond/harness";
import {
  getBundledRuntimeVersion,
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

import { VERSION } from "./constants.js";
import {
  ensureSelectedLocalHarnessWorkspace,
  resolveSelectedLocalHarnessRelease,
} from "./harness/local-harness-selection.js";
import { loadSelectedLocalHarnessRuntime } from "./harness/local-harness-skill-runtime.js";
import { ensureExplicitProfileHarnessSource, importLocalHarnessWorkspaceSource } from "./harness/local-harness-workspace-service.js";
import { PROFILE_HARNESS_WORKSPACE_PREFIX } from "./harness/profile-harness-workspace-identity.js";
import { ensureLocalProfileWorkflows, loadLocalHarnessRuntimeForSession, profileWorkflowsForRelease } from "./harness/local-profile-workflow-runtime.js";
import { profileEvaluationsForRelease } from "./harness/local-profile-evaluation-runtime.js";
import { profileTrainingSource } from "./harness/profile-training-source.js";
import { createProfileEvaluationCaseService } from "./harness/profile-evaluation-case-service.js";
import { createProfileEvaluationRunService } from "./harness/profile-evaluation-run-service.js";
import { createProfileEvaluationSuiteService } from "./harness/profile-evaluation-suite-service.js";
import { createProfileEvaluationComparisonService } from "./harness/profile-evaluation-comparison-service.js";
import { buildProfileEvaluationReport } from "./harness/profile-evaluation-report-service.js";
import { createProfileEvaluationRunPreparationService } from "./harness/profile-evaluation-run-preparation.js";
import { loadLocalProfileEvaluationTaskset } from "./harness/local-profile-evaluation-taskset.js";
import type { LocalHarnessReleaseRecord } from "./store/store-harness-workspaces.js";
import {
  ensureLocalHarnessRunOverlay,
} from "./harness/local-harness-run-overlay.js";
import {
  createLocalHarnessSettingsRoutePayloads,
  localHarnessHistoryPayload,
} from "./harness/local-harness-history.js";
import { createLocalHarnessImprovementRuntime } from "./harness/local-harness-improvement-runtime.js";
import { createLocalHarnessModelToolDefinitions } from "./harness/local-harness-model-tools.js";
import {
  activateRefinerRelease,
  inspectRefinerProfile,
  rollbackRefinerRelease,
  updateRefinerProfile,
} from "./refiner/refiner-profile-service.js";
import { createOpenPondCommandAccessService } from "./openpond/command-access.js";
import { listAppServerIntegrationConnections } from "./openpond/app-server-connected-apps.js";
import { createCloudConnectedAppToolExecutor } from "./openpond/connected-app-executor.js";
import { createHostedTurnHelpers } from "./openpond/hosted-turn-helpers.js";
import { loadPersonalizationSettings } from "./openpond/personalization.js";
import { createHostedSavedWork } from "./openpond/saved-work.js";
import { executeHostedTasksetAction } from "./openpond/hosted-tasksets.js";
import { createProjectActionRunPayload } from "./project-actions/project-action-payload.js";
import {
  createScriptedOpenPondChatStream,
  scriptedOpenPondModelsEnabled,
} from "./openpond/scripted-chat-provider.js";
import { createWebSearchExecutorFromEnv } from "./openpond/web-search.js";
import { appDataDir } from "./paths.js";
import { createBackgroundWorkerQueue } from "./runtime/background-worker-queue.js";
import { createAppServerWorkspace } from "./runtime/app-server-workspace.js";
import type { AppServerSandboxRequest } from "./runtime/app-server-sandbox-tools.js";
import {
  isBundledAuthoringSkillName,
  loadBundledAuthoringSkills,
  readBundledAuthoringProfileSkill,
} from "./runtime/bundled-authoring-skills.js";
import { createAgentRuntimePorts } from "./runtime/agent-runtime-host.js";
import { reviewSelectedLocalHarnessEvaluation } from "./harness/local-harness-evaluation-review.js";
import { createLocalHarnessEvaluationReviewModelStream } from "./harness/local-harness-evaluation-review-model.js";
import { createLocalHarnessTasksetReviewControl } from "./harness/local-harness-taskset-review.js";
import {
  loadTasksetAuthoringProfileSkill,
  readTasksetAuthoringProfileSkill,
} from "./training/task-authoring-skill.js";
import { createProfileTurnDependencies } from "./runtime/profile-turn-dependencies.js";
import { createRuntimeEventBus } from "./runtime/runtime-event-bus.js";
import { createTurnRunner } from "./runtime/turn-runner.js";
import { resolveMaxHostedWorkspaceToolRounds } from "./server-entry-helpers.js";
import { createSessionStore } from "./store/session-store.js";
import {
  autoTitlePromptFromPayload,
  createSessionTitleService,
  withPendingAutoTitle,
} from "./session-title-service.js";
import { SqliteStore } from "./store/store.js";
import { event, now } from "./utils.js";

import {
  createEmbeddingToolResolver,
  type AppServerEmbeddingOptions,
  type AppServerServiceOptions,
  type AppServerWorkLifecycle,
} from "./runtime/app-server-embedding.js";

export type { AppServerEmbeddingOptions, AppServerServiceOptions, AppServerToolBinding, AppServerHarnessToolContext } from "./runtime/app-server-embedding.js";
export { runAppServerJsonl } from "@openpond/app-server";
export { AGENT_PROTOCOL_VERSION } from "@openpond/agent-runtime";
export type { AppServerSandboxRequest } from "./runtime/app-server-sandbox-tools.js";

const MAX_REPEATED_INVALID_TOOL_REQUESTS = 3;

export type OpenPondAppServerOptions = {
  storeDir?: string;
  workspaceDir?: string;
  version?: string;
  maxHostedWorkspaceToolRounds?: number;
  streamOpenPondHostedChatTurn?: typeof defaultStreamOpenPondHostedChatTurn;
  sandboxRequest?: AppServerSandboxRequest;
  /** Trusted source directory containing harness.json and declared assets. Immutable per workspace ID. */
  harness?: { sourceDirectory: string; workspaceId: string; name: string };
  /** Authorized Profile repository bytes and accepted revision supplied by the embedding host. */
  profileSource?: { repoPath: string; repositoryId: string; profileId: string; sourceRevision: string };
  /** Explicit embedding enables native-only, allowlisted tools and disables hosted services by default. */
  embedding?: AppServerEmbeddingOptions;
  services?: AppServerServiceOptions;
  workInputsForSession?: AppServerWorkLifecycle["workInputsForSession"];
  finalizeWorkTurn?: AppServerWorkLifecycle["finalizeWorkTurn"];
};

export type OpenPondAppServerInstance = AppServerInstance & {
  storePath: string;
  workspaceDir: string;
  composition: readonly AppServerCompositionService[];
};

export type AppServerCompositionService =
  | "sqlite_store"
  | "runtime_event_bus"
  | "session_store"
  | "hosted_provider"
  | "web_search"
  | "connected_apps"
  | "workspace_tools"
  | "command_approvals"
  | "harness"
  | "refiner"
  | "agent_runtime"
  | "jsonl_transport";

export const APP_SERVER_COMPOSITION: readonly AppServerCompositionService[] = [
  "sqlite_store",
  "runtime_event_bus",
  "session_store",
  "hosted_provider",
  "web_search",
  "connected_apps",
  "workspace_tools",
  "command_approvals",
  "harness",
  "refiner",
  "agent_runtime",
  "jsonl_transport",
];

export async function createOpenPondAppServer(options: OpenPondAppServerOptions = {}): Promise<OpenPondAppServerInstance> {
  const storeDir = path.resolve(options.storeDir ?? appDataDir());
  return ownHomeRuntime(storeDir, () => createOwnedAppServer({ ...options, storeDir }));
}
async function createOwnedAppServer(options: OpenPondAppServerOptions): Promise<OpenPondAppServerInstance> {
  const storeDir = path.resolve(options.storeDir ?? appDataDir());
  const embedded = Boolean(options.embedding);
  if (embedded && !options.streamOpenPondHostedChatTurn) {
    throw new Error("Embedded Work requires an explicit model-stream adapter.");
  }
  const services = options.services ?? {};
  const webSearch = selectService(services.webSearch, embedded, createWebSearchExecutorFromEnv);
  const scheduling = selectService(services.scheduling, embedded, () => createHostedSavedWork);
  const connectedApps = selectService(services.connectedApps, embedded, () => ({
    execute: createCloudConnectedAppToolExecutor(), list: listAppServerIntegrationConnections,
  }));
  const tasksets = selectService(services.tasksets, embedded, () => executeHostedTasksetAction);
  const backgroundReview = services.backgroundReview ?? !embedded;
  // A model-tool adapter does not configure the separate local evaluation workflow.
  const harnessEvaluationEnabled = !embedded && Boolean(tasksets);
  await initializeHome(storeDir);
  await initializeRefinerProfile(storeDir);
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
  await mkdir(workspaceDir, { recursive: true });
  const version = options.version ?? VERSION;
  const runtimeVersion = getBundledRuntimeVersion();
  const logger = createLogger({
    channel: "app-server",
    logDir: path.join(storeDir, "logs"),
    metadata: { version, runtimeVersion, placement: "hosted_work" },
  });
  onStartupFailure(() => logger.flush());
  const store = new SqliteStore(storeDir, { logger });
  onStartupFailure(() => store.close());
  await store.recentTurns(1);
  const scheduleRecovery = reconcileInterruptedScheduledWork(storeDir);
  if (scheduleRecovery.recovered || scheduleRecovery.needsReview) logger.warn("Scheduled work requires review after restart", scheduleRecovery);
  const streamOpenPondHostedChatTurn = createScriptedOpenPondChatStream(
    options.streamOpenPondHostedChatTurn ?? defaultStreamOpenPondHostedChatTurn,
    { enabled: scriptedOpenPondModelsEnabled() },
  );
  const harnessEvaluationReviewStream =
    createLocalHarnessEvaluationReviewModelStream(streamOpenPondHostedChatTurn);

  const {
    appendRuntimeEvent,
    closeEventSubscribers,
    subscribeRuntimeEvents,
  } = createRuntimeEventBus({ logger, store });
  const turnFollowUpQueue = createBackgroundWorkerQueue({
    queueId: "turn-follow-up",
    logger,
  });
  const subagentQueue = createBackgroundWorkerQueue({
    queueId: "subagent",
    logger,
  });

  if (options.harness && options.profileSource) {
    throw new Error("Configure either an explicit Harness source or Profile source for this app-server.");
  }
  let explicitProfileRelease: LocalHarnessReleaseRecord | null = null;
  if (options.profileSource) {
    const source = options.profileSource;
    if (!source.repositoryId.trim() || !source.profileId.trim() || !source.sourceRevision.trim()) {
      throw new Error("Explicit Profile source requires an identity and accepted revision.");
    }
    const profile = await loadOpenPondProfileStateFromSource({ repoPath: source.repoPath, profileId: source.profileId });
    if (profile.mode !== "local" || !profile.sourcePath || profile.error ||
        (profile.git?.isRepo && (profile.git.head !== source.sourceRevision || profile.git.dirty))) {
      throw new Error("Explicit Profile source does not match its accepted revision.");
    }
    explicitProfileRelease = await ensureExplicitProfileHarnessSource({
      store, storeDir,
      workspaceId: `${PROFILE_HARNESS_WORKSPACE_PREFIX}${contentHash({ profileId: source.profileId, sourceRevision: source.sourceRevision }).slice(0, 24)}`,
      ownerId: "desktop-personal",
      name: source.profileId,
      profile,
      sourceRevision: source.sourceRevision,
    });
  }
  if (options.harness) {
    await importLocalHarnessWorkspaceSource({
      store, storeDir, sourceDir: options.harness.sourceDirectory,
      id: options.harness.workspaceId, name: options.harness.name, ownerId: "desktop-personal",
    });
    await store.selectHarnessWorkspace({
      ownerKind: "personal", ownerId: "desktop-personal",
      workspaceId: options.harness.workspaceId, updatedAt: now(),
    });
  }
  await ensureSelectedLocalHarnessWorkspace({
    store,
    storeDir,
    loadProfileState: loadOpenPondProfileState,
    now,
  }).catch((error) => {
    logger.warn("app-server Harness initialization failed", { error });
  });

  const hostedTurnHelpers = createHostedTurnHelpers({
    appendRuntimeEvent,
    onRepositoryInstructionDiagnostic: (diagnostic, session) => {
      logger.warn("repository instruction file skipped", {
        diagnostic,
        sessionId: session.id,
      });
    },
  });
  const {
    createSession,
    getSession,
    updateSession,
    completeTurn,
    failTurn,
    interruptTurn,
  } = createSessionStore({
    store,
    defaultSessionCwd: () => workspaceDir,
    appendRuntimeEvent,
    loadAppPreferences: async () => (await readPreferences(storeDir)).preferences,
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
    const session = await createSession(embedded ? payload : withPendingAutoTitle(payload));
    if (prompt && !embedded) sessionTitleService.schedule(session.id, prompt);
    return session;
  };
  const workspace = createAppServerWorkspace({
    workspaceDir,
    logger,
    getSession,
    updateSession,
    appendRuntimeEvent,
    sandboxRequest: options.sandboxRequest ?? (embedded ? async () => {
      throw new Error("Sandbox execution is not configured in this app-server deployment.");
    } : undefined),
  });
  const harnessTasksetReview = harnessEvaluationEnabled ? await createLocalHarnessTasksetReviewControl({
    store,
    storeDir,
    evaluationRuntime: {
      streamOpenPondHostedChatTurn,
      workRuntime: {
        createSession,
        getSession,
        executeWorkspaceTool: workspace.executeWorkspaceTool,
        runtimeEventsForSession: (sessionId) =>
          store.runtimeEventsForSession(sessionId),
      },
      resolveReleasedHarness: async () => {
        const runtime = await loadSelectedLocalHarnessRuntime(store);
        return runtime
          ? {
              agentSnapshot: runtime.release.agentSnapshot,
              harnessRelease: runtime.release.harnessRelease,
              instructionContext: runtime.instructionContext,
            }
          : null;
      },
    },
  }) : undefined;
  const upsertApproval = async (approval: Approval): Promise<void> => {
    await store.upsertApproval(approval);
  };
  const commandAccess = createOpenPondCommandAccessService({
    upsertApproval,
    appendRuntimeEvent,
  });
  const projectActionRunPayload = selectService(services.projectActions, embedded, () => createProjectActionRunPayload({
    appendRuntimeEvent,
    resolveProjectRoot: async () => null,
  }));
  const safeUpsertModelUsageRecord = async (
    record: ModelUsageRecord,
  ): Promise<void> => {
    try {
      await store.upsertModelUsageRecord(record);
    } catch (error) {
      await appendRuntimeEvent(
        runtimeDiagnostic(record, error),
      ).catch(() => undefined);
    }
  };
  const harnessImprovement = backgroundReview ? createLocalHarnessImprovementRuntime({
    store,
    storeDir,
    queue: turnFollowUpQueue,
    streamOpenPondHostedChatTurn,
    appendRuntimeEvent,
    upsertModelUsageRecord: safeUpsertModelUsageRecord,
  }) : undefined;
  await harnessImprovement?.reconcilePending();

  const turnRunner = createTurnRunner({
    storageHome: storeDir,
    workInputsForSession: options.workInputsForSession,
    finalizeWorkTurn: options.finalizeWorkTurn,
    resolveModelTools: options.embedding ? createEmbeddingToolResolver(options.embedding, async (turnId, bindings) => {
      const turn = await store.getTurn(turnId);
      if (!turn) throw new Error("Embedded turn is unavailable.");
      const session = await getSession(turn.sessionId);
      const previous = session.metadata?.embeddingToolBindings;
      const admittedBindings = [...bindings].sort((a, b) => a.name.localeCompare(b.name));
      if (previous !== undefined && contentHash(previous) !== contentHash(admittedBindings)) {
        throw new Error("Embedded tool bindings changed; start a new thread.");
      }
      await updateSession(session.id, { metadata: { ...session.metadata, embeddingToolBindings: admittedBindings } });
      await store.updateTurn(turnId, current => ({ ...current, metadata: { ...current.metadata, toolBindings: admittedBindings } }));
    }) : undefined,
    ...(embedded ? { hostedToolFlags: { toolMode: "native" as const, nativeToolTransport: true, nativeToolProviderDenylist: [], textToolFallback: false } } : {}),
    attachmentRootDir: path.join(storeDir, "attachments"),
    store,
    createSession,
    upsertApproval,
    getSession,
    updateSession,
    completeTurn,
    failTurn,
    interruptTurn,
    defaultSessionCwd: () => workspaceDir,
    findOpenPondApp: async (appId) => workspaceApp(appId, workspaceDir),
    resolveSessionWorkspaceCwd: async (session) =>
      session.cwd?.trim() || workspaceDir,
    ensureCodexRuntime: async () => {
      throw new Error(
        "The hosted app-server placement uses the OpenPond provider; Codex process hosting is not configured.",
      );
    },
    appendWorkspaceDiffEvent: workspace.appendWorkspaceDiffEvent,
    workspaceDiffBaseline: workspace.workspaceDiffBaseline,
    appendRuntimeEvent,
    processHarnessImprovementBoundary: harnessImprovement,
    executeWorkspaceTool: workspace.executeWorkspaceTool,
    executeOpenPondCommand: commandAccess.executeCommand,
    executeProjectAction: projectActionRunPayload,
    executeDatasetBuilderAction: tasksets,
    loadOpenPondProfileState,
    ...createProfileTurnDependencies(),
    ...(embedded || services.profileActions === false ? { executeProfileSkillCommand: undefined } : {}),
    loadOpenPondProfileLibrary,
    readOpenPondProfileSkill: readProfileSkill,
    loadSelectedHarnessRuntime: (session) =>
      loadLocalHarnessRuntimeForSession(store, session),
    ensureHarnessRunOverlay: (input) =>
      ensureLocalHarnessRunOverlay({ store, ...input }),
    harnessModelTools: createLocalHarnessModelToolDefinitions({ store, storeDir }).filter(tool =>
      backgroundReview || !["refiner_profile_inspect", "refiner_profile_update", "refine_request", "refine_status"].includes(tool.name)),
    loadBuiltInOpenPondSkills: async () => [
      await loadTasksetAuthoringProfileSkill(),
      ...(await loadBundledAuthoringSkills()),
    ],
    readBuiltInOpenPondSkill: async (name) => {
      if (name === "openpond-taskset-authoring") {
        return readTasksetAuthoringProfileSkill();
      }
      if (isBundledAuthoringSkillName(name)) {
        return readBundledAuthoringProfileSkill(name);
      }
      throw new Error(`Built-in OpenPond skill not found: ${name}`);
    },
    executeWebSearch: webSearch,
    createScheduledWork: scheduling,
    executeConnectedAppTool: connectedApps?.execute,
    listIntegrationConnections: connectedApps?.list,
    loadPersonalizationSoul: async () =>
      (await loadPersonalizationSettings(store, storeDir)).soul,
    loadAppPreferences: async () => (await readPreferences(storeDir)).preferences,
    maybeCreateScaffoldForTurn: hostedTurnHelpers.maybeCreateScaffoldForTurn,
    hostedSystemPrompt: hostedTurnHelpers.hostedSystemPrompt,
    appendAssistantText: hostedTurnHelpers.appendAssistantText,
    appendHostedContextUsage: hostedTurnHelpers.appendHostedContextUsage,
    streamOpenPondHostedChatTurn,
    turnFollowUpQueue,
    subagentQueue,
    maxHostedWorkspaceToolRounds: resolveMaxHostedWorkspaceToolRounds(
      options.maxHostedWorkspaceToolRounds,
    ),
    maxRepeatedInvalidToolRequests: MAX_REPEATED_INVALID_TOOL_REQUESTS,
  });
  onStartupFailure(() => turnRunner.close());
  await turnRunner.recoverPendingSubagentCompletions();
  await turnRunner.recoverTaskInbox();

  async function resolveApproval(
    approvalId: string,
    payload: unknown,
  ): Promise<Approval> {
    const commandApproval = await commandAccess.resolveApproval(
      approvalId,
      payload,
    );
    if (commandApproval) return commandApproval;
    const createImproveApproval = await turnRunner.resolveCreateImproveApproval(
      approvalId,
      payload,
    );
    if (createImproveApproval) return createImproveApproval;
    const subagentApproval = await turnRunner.resolveSubagentPatchApplyApproval(
      approvalId,
      payload,
    );
    if (subagentApproval) return subagentApproval;
    throw new Error(`Approval not found: ${approvalId}`);
  }

  let closing = false;
  const harnessSettings = createLocalHarnessSettingsRoutePayloads({
    store,
    storeDir,
    evaluationReviewStream: harnessEvaluationReviewStream,
  });
  const selectedEvaluationProfile = async () => {
    if (options.profileSource) return {
      ref: { source: "openpond_git" as const, repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId },
      sourceRevision: options.profileSource.sourceRevision,
    };
    const [library, profile] = await Promise.all([loadOpenPondProfileLibrary(), loadOpenPondProfileState()]);
    return library.lastUsed && profile.git?.head && !profile.git.dirty
      ? { ref: library.lastUsed, sourceRevision: profile.git.head } : null;
  };
  const executeProfileEvaluationCase = createProfileEvaluationCaseService({
    store,
    storeDir,
    selectedProfile: selectedEvaluationProfile,
    createSession: createSessionWithAutoTitle,
    sendTurn: turnRunner.sendTurn,
    interruptSessionTurn: turnRunner.interruptSessionTurn,
  });
  const listProfileWorkflows = async () => {
    if (options.profileSource && explicitProfileRelease) {
      return profileWorkflowsForRelease({
        store,
        release: explicitProfileRelease,
        ref: { source: "openpond_git" as const, repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId },
        sourceRevision: options.profileSource.sourceRevision,
      });
    }
    const [library, profile] = await Promise.all([loadOpenPondProfileLibrary(), loadOpenPondProfileState()]);
    if (!library.lastUsed) throw new Error("Select a Profile before loading its workflows.");
    return ensureLocalProfileWorkflows({ store, storeDir, ref: library.lastUsed, profile, reloadProfile: loadOpenPondProfileState });
  };
  const prepareProfileEvaluationRun = createProfileEvaluationRunPreparationService({
    store,
    selectedWorkflows: listProfileWorkflows,
    loadTasksetPackage: (definition, profileId, harnessRelease) => loadLocalProfileEvaluationTaskset({
      store, storeDir, definition, profileId, harnessRelease,
    }),
    modelConfigurationHash: async (modelRef, request) => {
      if (!options.profileSource || modelRef.providerId !== "openpond" || !request.hostModelConfigurationHash) {
        throw new Error("Hosted Profile evaluation requires an explicit source and trusted OpenPond model configuration receipt.");
      }
      return request.hostModelConfigurationHash;
    },
    placement: "remote",
  });
  const executeProfileEvaluationRun = createProfileEvaluationRunService({
    store, selectedProfile: selectedEvaluationProfile, executeCase: executeProfileEvaluationCase,
  });
  const executeProfileEvaluationSuite = createProfileEvaluationSuiteService({
    store, selectedWorkflows: listProfileWorkflows,
    prepareRun: prepareProfileEvaluationRun, executeRun: executeProfileEvaluationRun,
  });
  const instance = createAppServer({
    ports: createAgentRuntimePorts({
      placement: "hosted_work",
      connectedAppProviders: connectedApps ? undefined : [],
      featureOverrides: {
        harnessBackgroundReview: backgroundReview,
        harnessProposalReview: backgroundReview,
        harnessReview: harnessEvaluationEnabled,
        harnessEvaluationReview: harnessEvaluationEnabled,
        harnessEvaluationReviewAcceptance: harnessEvaluationEnabled,
        harnessEvaluationTasksetMaterialization: harnessEvaluationEnabled,
        harnessEvaluationBaseline: harnessEvaluationEnabled,
        refinerProfiles: backgroundReview,
        immutableRefinerAdmission: backgroundReview,
      },
      createSession: createSessionWithAutoTitle,
      getSession,
      turnsForSession: (sessionId) => store.turnsForSession(sessionId, 1_000),
      runtimeEventsForSession: (sessionId) =>
        store.runtimeEventsForSession(sessionId),
      sendTurn: turnRunner.sendTurn,
      steerSessionTurn: turnRunner.steerSessionTurn,
      readTaskInbox: turnRunner.readTaskInbox,
      queueTaskInput: turnRunner.queueTaskInput,
      updateTaskInput: turnRunner.updateTaskInput,
      isSessionTurnActive: turnRunner.isSessionTurnActive,
      waitForSessionTurnSettlement: turnRunner.waitForSessionTurnSettlement,
      interruptSessionTurn: turnRunner.interruptSessionTurn,
      resolveApproval,
      listProfileWorkflows,
      loadProfileTrainingSource: async () => {
        if (!options.profileSource || !explicitProfileRelease) {
          throw new Error("An explicit published Profile is required for hosted training source export.");
        }
        return profileTrainingSource({ release: explicitProfileRelease, storeDir });
      },
      listProfileEvaluations: async () => {
        if (options.profileSource && explicitProfileRelease) {
          const evaluations = await profileEvaluationsForRelease({
            store,
            ref: { source: "openpond_git", repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId },
            sourceRevision: options.profileSource.sourceRevision,
            harnessRelease: { id: explicitProfileRelease.harnessRelease.id, contentHash: explicitProfileRelease.harnessRelease.contentHash },
          });
          const [runs, comparisons, suiteRuns] = await Promise.all([
            store.listProfileEvaluationRuns({ source: "openpond_git", repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId }),
            store.listProfileEvaluationComparisons({ source: "openpond_git", repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId }),
            store.listProfileEvaluationSuiteRuns({ source: "openpond_git", repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId }),
          ]);
          return { ...evaluations, runs, comparisons, suiteRuns };
        }
        const [library, profile] = await Promise.all([loadOpenPondProfileLibrary(), loadOpenPondProfileState()]);
        if (!library.lastUsed) throw new Error("Select a Profile before loading its evaluations.");
        const workflows = await ensureLocalProfileWorkflows({ store, storeDir, ref: library.lastUsed, profile, reloadProfile: loadOpenPondProfileState });
        const evaluations = await profileEvaluationsForRelease({
          store,
          ref: workflows.profileRef,
          sourceRevision: workflows.sourceRevision,
          harnessRelease: workflows.harnessRelease,
        });
        const [runs, comparisons, suiteRuns] = await Promise.all([
          store.listProfileEvaluationRuns(workflows.profileRef),
          store.listProfileEvaluationComparisons(workflows.profileRef),
          store.listProfileEvaluationSuiteRuns(workflows.profileRef),
        ]);
        return { ...evaluations, runs, comparisons, suiteRuns };
      },
      executeProfileEvaluationCase,
      executeProfileEvaluationRun,
      prepareProfileEvaluationRun,
      runPreparedProfileEvaluation: async (request) => executeProfileEvaluationRun(await prepareProfileEvaluationRun(request, { requireExpectedManifestHash: true })),
      runProfileEvaluationSuite: executeProfileEvaluationSuite,
      compareProfileEvaluationRuns: createProfileEvaluationComparisonService({ store, selectedProfile: selectedEvaluationProfile }),
      buildProfileEvaluationReport: async (request) => {
        const selected = await selectedEvaluationProfile();
        if (!selected) throw new Error("Select a Profile before building an evaluation report.");
        return buildProfileEvaluationReport({ store, profileRef: selected.ref, request });
      },
      inspectHarness: () => localHarnessHistoryPayload(store),
      reviewHarnessProposal: guardService(backgroundReview, "Harness review", harnessSettings.reviewHarnessProposalPayload),
      reviewHarness: guardService(harnessEvaluationEnabled, "Harness evaluation", (request) => reviewSelectedLocalHarnessEvaluation({
        store,
        request,
        stream: harnessEvaluationReviewStream,
        continuation: { storeDir, stream: harnessEvaluationReviewStream },
      })),
      acceptHarnessEvaluationReview: guardService(harnessEvaluationEnabled, "Tasksets", request => harnessTasksetReview!.acceptEvaluationReview(request)),
      materializeHarnessEvaluationTaskset:
        guardService(harnessEvaluationEnabled, "Tasksets", request => harnessTasksetReview!.materializeEvaluationTaskset(request)),
      runHarnessEvaluationBaseline:
        guardService(harnessEvaluationEnabled, "Tasksets", request => harnessTasksetReview!.runEvaluationBaseline(request)),
      validateHarness: async () => {
        const release = await resolveSelectedLocalHarnessRelease(store);
        return release
          ? {
              valid: true,
              workspaceId: release.workspaceId,
              harnessRelease: release.harnessRelease,
              agentSnapshot: release.agentSnapshot,
            }
          : {
              valid: false,
              reason: "No app-server Harness release is selected.",
            };
      },
      updateHarnessBackgroundReview:
        guardService(backgroundReview, "Background review", harnessSettings.updateHarnessBackgroundReviewPayload),
      diffHarness: harnessSettings.harnessDiffPayload,
      rollbackHarness: harnessSettings.rollbackHarnessPayload,
      inspectRefiner: guardService(backgroundReview, "Refiner", () => inspectRefinerProfile(storeDir)),
      updateRefiner: guardService(backgroundReview, "Refiner", (payload) => updateRefinerProfile(storeDir, payload)),
      activateRefiner: guardService(backgroundReview, "Refiner", (payload) => activateRefinerRelease(storeDir, payload)),
      rollbackRefiner: guardService(backgroundReview, "Refiner", (payload) => rollbackRefinerRelease(storeDir, payload)),
      subscribeRuntimeEvents,
      observeRuntimeOperation: (runtimeEvent) => {
        logger.info("agent runtime operation", runtimeEvent);
      },
    }),
    close: async () => {
      if (closing) return;
      closing = true;
      await turnRunner.close();
      await Promise.all([
        turnFollowUpQueue.drain(),
        subagentQueue.drain(),
      ]);
      await closeEventSubscribers();
      await store.close();
      await logger.flush();
    },
  });
  const composition = APP_SERVER_COMPOSITION.filter(service =>
    (service !== "web_search" || Boolean(webSearch)) &&
    (service !== "connected_apps" || Boolean(connectedApps)) &&
    (service !== "refiner" || backgroundReview));
  logger.info("app-server ready", {
    storePath: store.storePath,
    workspaceDir,
    composition,
  });
  return {
    ...instance,
    storePath: store.storePath,
    workspaceDir,
    composition,
  };
}

function workspaceApp(appId: string, workspaceDir: string): OpenPondApp {
  return {
    id: appId || localPathWorkspaceId(workspaceDir),
    name: path.basename(workspaceDir) || "Sandbox workspace",
    description: null,
    visibility: "private",
    gitOwner: null,
    gitRepo: null,
    gitHost: null,
    defaultBranch: null,
    sandbox: false,
    updatedAt: now(),
    latestDeployment: null,
  };
}

function runtimeDiagnostic(
  record: ModelUsageRecord,
  error: unknown,
): RuntimeEvent {
  return event({
    sessionId: record.sessionId ?? undefined,
    turnId: record.turnId ?? undefined,
    name: "diagnostic",
    source: "server",
    status: "failed",
    output: error instanceof Error
      ? error.message
      : "Failed to persist model usage record.",
    data: {
      kind: "model_usage_record_failed",
      requestId: record.requestId,
      provider: record.provider,
      model: record.model,
    },
  });
}

function selectService<T>(override: T | false | undefined, embedded: boolean, defaultService: () => T): T | undefined {
  if (override === false) return undefined;
  if (override !== undefined) return override;
  return embedded ? undefined : defaultService();
}

function guardService<A extends unknown[], R>(enabled: boolean, name: string, handler: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    if (!enabled) throw new Error(`${name} is disabled in this app-server deployment.`);
    return handler(...args);
  };
}
