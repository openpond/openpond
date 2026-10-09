import { initializeHome,readPreferences } from "@openpond/persistence";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { installPublishedExperimentSource } from "./harness/published-experiment-source.js";
import { createStandaloneExperimentTurnOwner } from "./harness/standalone-experiment-turn-owner.js";
import { experimentSessionStreamResolver } from "./runtime/experiment-session-stream.js";
import { onStartupFailure,ownHomeRuntime } from "./runtime/home-runtime-owner.js";
import { lazyRuntimeService } from "./runtime/lazy-runtime-service.js";
import { reconcileInterruptedScheduledWork } from "./runtime/scheduled-work-recovery.js";
import type { TaskInboxRepository } from "./runtime/task-inbox/repository.js";
import { createWorkOutputService } from "./work/work-output-service.js";

import { createAppServer,type AppServerInstance } from "@openpond/app-server";
import {
  loadOpenPondProfileLibrary,
  loadOpenPondProfileState,
  loadOpenPondProfileStateFromSource,
  readProfileSkill,
} from "@openpond/cloud";
import { localPathWorkspaceId } from "@openpond/contracts/workspaces";
import { type Approval } from "@openpond/contracts/approvals";
import { type ModelUsageRecord } from "@openpond/contracts/usage";
import { type OpenPondApp } from "@openpond/contracts/apps";
import { type RuntimeEvent } from "@openpond/contracts/runtime";
import { contentHash } from "@openpond/harness";
import { createLogger } from "@openpond/logging";
import {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
  getBundledRuntimeVersion,
} from "@openpond/runtime";

import { VERSION } from "./constants.js";
import { type HostProfileExternalDataset } from "./harness/host-profile-external-dataset.js";
import { ensureExplicitProfileHarnessSource } from "./harness/local-explicit-profile-source.js";
import { createLocalHarnessEvaluationReviewModelStream } from "./harness/local-harness-evaluation-review-model.js";
import { createLocalHarnessModelToolDefinitions } from "./harness/local-harness-model-tools.js";
import {
  ensureLocalHarnessRunOverlay,
} from "./harness/local-harness-run-overlay.js";
import {
  ensureSelectedLocalHarnessWorkspace
} from "./harness/local-harness-selection.js";
import { loadSelectedLocalHarnessRuntime } from "./harness/local-harness-skill-runtime.js";
import { importLocalHarnessWorkspaceSource } from "./harness/local-harness-workspace-service.js";
import { ensureLocalProfileWorkflows,loadLocalHarnessRuntimeForSession,profileWorkflowsForRelease } from "./harness/local-profile-workflow-runtime.js";
import { PROFILE_HARNESS_WORKSPACE_PREFIX } from "./harness/profile-harness-workspace-identity.js";
import { createOpenPondCommandAccessService } from "./openpond/command-access.js";
import { createHostedTurnHelpers } from "./openpond/hosted-turn-helpers.js";
import { loadPersonalizationSettings } from "./openpond/personalization.js";
import {
  createScriptedOpenPondChatStream,
  scriptedOpenPondModelsEnabled,
} from "./openpond/scripted-chat-provider.js";
import { appDataDir } from "./paths.js";
import { createAgentRuntimePorts } from "./runtime/agent-runtime-host.js";
import type { AppServerSandboxRequest } from "./runtime/app-server-sandbox-tools.js";
import { createAppServerWorkspace } from "./runtime/app-server-workspace.js";
import { createBackgroundWorkerQueue } from "./runtime/background-worker-queue.js";
import {
  isBundledAuthoringSkillName,
  loadBundledAuthoringSkills,
  readBundledAuthoringProfileSkill,
} from "./runtime/bundled-authoring-skills.js";
import { createProfileTurnDependencies } from "./runtime/profile-turn-dependencies.js";
import { createRuntimeEventBus } from "./runtime/runtime-event-bus.js";
import { createTurnRunner } from "./runtime/turn-runner.js";
import type { TurnRunnerDependencies } from "./runtime/turns/ports.js";
import { resolveMaxHostedWorkspaceToolRounds } from "./server-entry-helpers.js";
import { createSessionTitleService } from "./session-title-service.js";
import { createSessionStore } from "./store/session-store.js";
import type { LocalHarnessReleaseRecord } from "./store/store-harness-workspaces.js";
import { SqliteStore } from "./store/store.js";
import {
  loadTasksetAuthoringProfileSkill,
  readTasksetAuthoringProfileSkill,
} from "./training/task-authoring-skill.js";
import { event,now } from "./utils.js";
import { findLocalProject } from "./workspace/local-projects.js";

import {
  createEmbeddingToolResolver,
  type AppServerEmbeddingOptions,
  type AppServerServiceOptions,
  type AppServerWorkLifecycle,
} from "./runtime/app-server-embedding.js";

export { AGENT_PROTOCOL_VERSION } from "@openpond/agent-runtime";
export { runAppServerJsonl } from "@openpond/app-server";
export type { AppServerEmbeddingOptions,AppServerHarnessToolContext,AppServerServiceOptions,AppServerToolBinding } from "./runtime/app-server-embedding.js";
export type { AppServerSandboxRequest } from "./runtime/app-server-sandbox-tools.js";

const MAX_REPEATED_INVALID_TOOL_REQUESTS = 3;

/** One selection boundary for the session, turn and event core. */
export type AppServerRuntimeCoreStorage = TurnRunnerDependencies["store"] & Pick<SqliteStore,
  "sessionCount" | "insertSessionAtFront" | "getSession" | "updateSession" |
  "appendRuntimeEvent" | "runtimeEventPageRows" | "turnsForSession" |
  "upsertApproval" | "upsertModelUsageRecord" | "runtimeEventsForTurn" | "listModelUsageRecords">;

export type OpenPondAppServerOptions = {
  /** Dedicated host-admitted case runtime; credentials/spend remain at its owner. */
  experimentPolicyClient?: import("@openpond/agent-runtime").AgentHostStorageClient;
  /** Trusted host-provisioned published closure; never a caller permission grant. */
  experimentHarnessSource?: { ownerId: string; sourcePackage: import("@openpond/harness").HarnessSourcePackage };
  hostStorageClient?: import("@openpond/agent-runtime").AgentHostStorageClient;
  /** Select all mutable runtime domains together after host capability negotiation. */
  runtimeStorage?: {
    kind: "hosted_postgres";
    client: import("@openpond/agent-runtime").AgentHostStorageClient;
    core: AppServerRuntimeCoreStorage;
    inbox: TaskInboxRepository;
    admittedProfileRelease?: import("./store/hosted-profile-source.js").AdmittedHostedProfileRelease;
  };
  storeDir?: string;
  workspaceDir?: string;
  version?: string;
  maxHostedWorkspaceToolRounds?: number;
  streamOpenPondHostedChatTurn?: typeof defaultStreamOpenPondHostedChatTurn;
  /** Transport-owned tools/policy composed after the harness resolves its tools. */
  resolveModelTools?: import("./runtime/app-server-embedding.js").ResolveAppServerModelTools;
  /** Internal native Experiment authority, bound before session admission. */
  resolveSessionModelStream?: (session:import("@openpond/contracts").Session,turn:import("@openpond/contracts").Turn)=>Promise<typeof defaultStreamOpenPondHostedChatTurn|null>;
  sandboxRequest?: AppServerSandboxRequest;
  /** Trusted source directory containing harness.json and declared assets. Immutable per workspace ID. */
  harness?: { sourceDirectory: string; workspaceId: string; name: string };
  /** Authorized Profile repository bytes and accepted revision supplied by the embedding host. */
  profileExternalDataset?:HostProfileExternalDataset;
  profileExternalDatasetClient?:import("@openpond/agent-runtime").AgentHostStorageClient;
  profileSource?: { repoPath: string; repositoryId: string; profileId: string; sourceRevision: string };
  /** Explicit embedding enables native-only, allowlisted tools and disables hosted services by default. */
  embedding?: AppServerEmbeddingOptions;
  services?: AppServerServiceOptions;
  workInputsForSession?: AppServerWorkLifecycle["workInputsForSession"];
  finalizeWorkTurn?: AppServerWorkLifecycle["finalizeWorkTurn"];
};

export type OpenPondAppServerInstance = AppServerInstance & {
  updateSession(id: string, patch: Partial<import("@openpond/contracts").Session>): Promise<import("@openpond/contracts").Session>;
  pinSessionHarness(id: string): Promise<{ id: string; contentHash: string } | null>;
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
  if (options.runtimeStorage) {
    return (await import("./runtime/hosted-app-server-composition.js")).createHostedOwnedAppServer({ ...options, runtimeStorage: options.runtimeStorage });
  }
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
  const webSearch = await selectService(services.webSearch, embedded, async () => (await import("./openpond/web-search.js")).createWebSearchExecutorFromEnv());
  const scheduling = await selectService(services.scheduling, embedded, async () => (await import("./openpond/saved-work.js")).createHostedSavedWork);
  const connectedApps = await selectService(services.connectedApps, embedded, async () => {
    const [executor, connections] = await Promise.all([import("./openpond/connected-app-executor.js"), import("./openpond/app-server-connected-apps.js")]);
    return { execute: executor.createCloudConnectedAppToolExecutor(), list: connections.listAppServerIntegrationConnections };
  });
  const tasksets = await selectService(services.tasksets, embedded, async () => (await import("./openpond/hosted-tasksets.js")).executeHostedTasksetAction);
  const backgroundReview = services.backgroundReview ?? !embedded;
  // A model-tool adapter does not configure the separate local evaluation workflow.
  const harnessEvaluationEnabled = !embedded && Boolean(tasksets);
  await initializeHome(storeDir);
  if (backgroundReview) await (await import("./refiner/refiner-profile-service.js")).initializeRefinerProfile(storeDir);
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
  const coreStore = store;
  const loadRuntimePreferences = async () => (await readPreferences(storeDir)).preferences;
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
  } = createRuntimeEventBus({ logger, store: coreStore });
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
  let publishedExperimentSource: Awaited<ReturnType<typeof installPublishedExperimentSource>> | undefined;
  let standaloneExperimentOwner: ReturnType<typeof createStandaloneExperimentTurnOwner> | undefined;
  if (options.experimentHarnessSource) {
    if (!options.experimentPolicyClient || options.profileSource || options.harness || options.runtimeStorage)
      throw new Error("A published standalone Experiment source requires its isolated policy owner and local case store.");
    const source = options.experimentHarnessSource.sourcePackage;
    publishedExperimentSource = await (await import("./harness/published-experiment-source.js")).installPublishedExperimentSource({
      store, storeDir, ownerId: options.experimentHarnessSource.ownerId, sourcePackage: source,
      reference: { harnessRelease: { id: source.harnessRelease.id, contentHash: source.harnessRelease.contentHash },
        agentSnapshot: { id: source.agentSnapshot.id, contentHash: source.agentSnapshot.contentHash }, sourcePackageHash: source.contentHash },
      createdAt: now(),
    });
  }
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
      repositoryId: source.repositoryId,
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
    findLocalProject: (projectId) => findLocalProject(store, projectId),
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
    store: coreStore,
    defaultSessionCwd: () => workspaceDir,
    appendRuntimeEvent,
    loadAppPreferences: loadRuntimePreferences,
    loadLastUsedProfile: async () =>
      (await loadOpenPondProfileLibrary()).lastUsed,
  });
  const sessionTitleService = createSessionTitleService({
    appendRuntimeEvent,
    store: coreStore,
    logger,
    stream: streamOpenPondHostedChatTurn,
  });
  const createSessionWithAutoTitle = embedded ? createSession : sessionTitleService.wrapCreateSession(createSession);
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
  const harnessTasksetReview = harnessEvaluationEnabled ? await (await import("./harness/local-harness-taskset-review.js")).createLocalHarnessTasksetReviewControl({
    store,
    storeDir,
    evaluationRuntime: {
      streamOpenPondHostedChatTurn,
      workRuntime: {
        createSession,
        getSession,
        executeWorkspaceTool: workspace.executeWorkspaceTool,
        runtimeEventsForSession: (sessionId) =>
          coreStore.runtimeEventsForSession(sessionId),
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
    await coreStore.upsertApproval(approval);
  };
  const commandAccess = createOpenPondCommandAccessService({
    upsertApproval,
    appendRuntimeEvent,
  });
  const projectActionRunPayload = await selectService(services.projectActions, embedded, async () => (await import("./project-actions/project-action-payload.js")).createProjectActionRunPayload({
    appendRuntimeEvent,
    resolveProjectRoot: async () => null,
  }));
  const safeUpsertModelUsageRecord = async (
    record: ModelUsageRecord,
  ): Promise<void> => {
    try {
      await coreStore.upsertModelUsageRecord(record);
    } catch (error) {
      await appendRuntimeEvent(
        runtimeDiagnostic(record, error),
      ).catch(() => undefined);
    }
  };
  const harnessImprovement = backgroundReview ? (await import("./harness/local-harness-improvement-runtime.js")).createLocalHarnessImprovementRuntime({
    store,
    storeDir,
    queue: turnFollowUpQueue,
    streamOpenPondHostedChatTurn,
    appendRuntimeEvent,
    upsertModelUsageRecord: safeUpsertModelUsageRecord,
  }) : undefined;
  await harnessImprovement?.reconcilePending();

  const externalDataset=options.profileExternalDataset?await (explicitProfileRelease&&options.profileExternalDatasetClient?(await import("./harness/host-profile-external-dataset.js")).createHostProfileExternalDataset({value:options.profileExternalDataset,release:explicitProfileRelease,sourceRevision:options.profileSource!.sourceRevision,client:options.profileExternalDatasetClient}):Promise.reject(new Error("External Dataset execution requires an explicit private Profile source owner."))):null;
  const evaluationOutputOwner=createWorkOutputService({deviceId:`evaluation-${contentHash(storeDir).slice(0,24)}`,storeDir,runtimeEventsForSession:id=>coreStore.runtimeEventsForSession(id)});
  const isolatedProfileTools=explicitProfileRelease?(await import("./harness/host-profile-evaluation-tools.js")).createHostProfileEvaluationTools({storeDir,release:explicitProfileRelease,getTurn:id=>coreStore.getTurn(id),getSession,saveOutput:evaluationOutputOwner.saveOwnedOutputBytes,recordOutput:async(sessionId,turnId,data)=>{await appendRuntimeEvent({id:randomUUID(),timestamp:new Date().toISOString(),name:"workspace_action_result",source:"server",sessionId,turnId,action:"work_output_save",status:"completed",output:`Saved ${data.outputRef.title} as immutable case output.`,data});},authorize:async params=>{if(externalDataset){await externalDataset.authorize(params);return;}const selected=await selectedEvaluationProfile();if(!selected||selected.ref.profileId!==options.profileSource?.profileId||selected.sourceRevision!==options.profileSource?.sourceRevision)throw new Error("The released evaluation source authority changed.");const retained=await store.getHarnessReleaseRecord(explicitProfileRelease!.harnessRelease.contentHash);if(!retained||retained.harnessRelease.contentHash!==explicitProfileRelease!.harnessRelease.contentHash)throw new Error("The isolated evaluation release is unavailable.");}}):null;
  const embeddedToolResolver=options.embedding ? createEmbeddingToolResolver(options.embedding, async (turnId,bindings)=>{const turn=await coreStore.getTurn(turnId);if(!turn)throw new Error("Embedded turn is unavailable.");const session=await getSession(turn.sessionId),previous=session.metadata?.embeddingToolBindings,admittedBindings=[...bindings].sort((a,b)=>a.name.localeCompare(b.name));if(previous!==undefined&&contentHash(previous)!==contentHash(admittedBindings))throw new Error("Embedded tool bindings changed; start a new thread.");await updateSession(session.id,{metadata:{...session.metadata,embeddingToolBindings:admittedBindings}});await coreStore.updateTurn(turnId,current=>({...current,metadata:{...current.metadata,toolBindings:admittedBindings}}));}):undefined;
  const turnRunner = createTurnRunner({
    executionHost: embedded ? "embedded" : "local",
    storageHome: storeDir,
    workInputsForSession: options.workInputsForSession,
    finalizeWorkTurn: options.finalizeWorkTurn,
    isolatedProfileEvaluationForTurn:isolatedProfileTools?async(session)=>{if(session.metadata?.profileEvaluationRun===undefined)return false;if(!isolatedProfileTools.ownsSession(session.id))throw new Error("A Profile evaluation target has no actual admitted case owner.");return true;}:undefined,
    executeProfileEvaluationAction:isolatedProfileTools?.executeAction,
    resolveModelTools: options.resolveModelTools || isolatedProfileTools || embeddedToolResolver ? async context => {
      const tools = isolatedProfileTools
        ? isolatedProfileTools.ownsSession(context.session.id) ? await isolatedProfileTools.resolveTools(context) : await embeddedToolResolver?.(context) ?? []
        : embeddedToolResolver ? await embeddedToolResolver(context) : context.tools;
      return options.resolveModelTools ? options.resolveModelTools({ ...context, tools }) : tools;
    } : undefined,
    ...(embedded ? { hostedToolFlags: { toolMode: "native" as const, nativeToolTransport: true, nativeToolProviderDenylist: [], textToolFallback: false } } : {}),
    attachmentRootDir: path.join(storeDir, "attachments"),
    store: coreStore,
    inboxStore: store,
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
    loadSelectedHarnessRuntime: (session) => loadLocalHarnessRuntimeForSession(store, session),
    ensureHarnessRunOverlay: (input) => ensureLocalHarnessRunOverlay({ store, ...input }),
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
    loadPersonalizationSoul: async () => (await loadPersonalizationSettings(store, storeDir)).soul,
    loadAppPreferences: loadRuntimePreferences,
    maybeCreateScaffoldForTurn: hostedTurnHelpers.maybeCreateScaffoldForTurn,
    hostedSystemPrompt: hostedTurnHelpers.hostedSystemPrompt,
    appendAssistantText: hostedTurnHelpers.appendAssistantText,
    appendHostedContextUsage: hostedTurnHelpers.appendHostedContextUsage,
    streamOpenPondHostedChatTurn,
    turnFollowUpQueue,
    resolveSessionModelStream:experimentSessionStreamResolver(async (session, turn) =>
      await standaloneExperimentOwner?.resolveSessionModelStream(session, turn)
      ?? await options.resolveSessionModelStream?.(session, turn) ?? null),
    subagentQueue,
    maxHostedWorkspaceToolRounds: options.experimentHarnessSource
      ? (await import("@openpond/evals/experiments")).STANDALONE_EXPERIMENT_MAX_POLICY_CALLS
      : resolveMaxHostedWorkspaceToolRounds(options.maxHostedWorkspaceToolRounds),
    maxRepeatedInvalidToolRequests: MAX_REPEATED_INVALID_TOOL_REQUESTS,
  });
  onStartupFailure(() => turnRunner.close());
  await turnRunner.recoverPendingSubagentCompletions();
  await turnRunner.recoverTaskInbox();

  async function resolveApproval(
    approvalId: string,
    payload: unknown,
  ): Promise<Approval> {
    const nativeApproval = await turnRunner.resolveNativeAgentApproval(approvalId, payload);
    if (nativeApproval) return nativeApproval;
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
  const selectedEvaluationProfile = async () => {
    if (options.profileSource) return {
      ref: { source: "openpond_git" as const, repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId },
      sourceRevision: options.profileSource.sourceRevision,
    };
    const [library, profile] = await Promise.all([loadOpenPondProfileLibrary(), loadOpenPondProfileState()]);
    return library.lastUsed && profile.git?.head && !profile.git.dirty
      ? { ref: library.lastUsed, sourceRevision: profile.git.head } : null;
  };

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
  if (publishedExperimentSource) {
    const retained = publishedExperimentSource;
    standaloneExperimentOwner = (await import("./harness/standalone-experiment-turn-owner.js")).createStandaloneExperimentTurnOwner({
      store, createSession, sendTurn: turnRunner.sendTurn, interruptSessionTurn: turnRunner.interruptSessionTurn,
      authorizeWorkspace: async (reference, workspace) => {
        if (workspace.id !== retained.workspace.id || contentHash(workspace.ownerScope) !== contentHash(retained.workspace.ownerScope)
          || reference.sourcePackageHash !== retained.workspace.metadata.experimentSourcePackageHash
          || reference.harnessRelease.id !== retained.release.harnessRelease.id
          || reference.harnessRelease.contentHash !== retained.release.harnessRelease.contentHash)
          throw new Error("Standalone Experiment source differs from this execution owner's admitted closure.");
      },
    });
  }
  const evaluations = lazyRuntimeService(async () => {
    const { createAppServerEvaluations } = await import("./runtime/app-server-evaluations.js");
    return createAppServerEvaluations({ options, store, storeDir, explicitProfileRelease, externalDataset,
      isolatedProfileTools, selectedEvaluationProfile, listProfileWorkflows, createSessionWithAutoTitle,
      turnRunner, streamOpenPondHostedChatTurn, publishedExperimentSource, standaloneExperimentOwner });
  });
  const evaluationRoutes = evaluations.methods(["listProfileEvaluations", "executeProfileEvaluationCase", "executeExperimentCase", "cancelExperimentCase", "executeProfileEvaluationRun", "prepareProfileEvaluationRun", "runPreparedProfileEvaluation", "runProfileEvaluationSuite", "compareProfileEvaluationRuns", "buildProfileEvaluationReport"]);
  onStartupFailure(() => evaluations.close());
  const harnessServices = lazyRuntimeService(async () => {
    const { createAppServerHarnessServices } = await import("./runtime/app-server-harness-services.js");
    return createAppServerHarnessServices({ store, storeDir, backgroundReview, harnessEvaluationEnabled,
      harnessEvaluationReviewStream, harnessTasksetReview });
  });
  const harnessRoutes = harnessServices.methods(["inspectHarness", "reviewHarnessProposal", "reviewHarness", "acceptHarnessEvaluationReview", "materializeHarnessEvaluationTaskset", "runHarnessEvaluationBaseline", "validateHarness", "updateHarnessBackgroundReview", "diffHarness", "rollbackHarness", "inspectRefiner", "updateRefiner", "activateRefiner", "rollbackRefiner"]);
  onStartupFailure(() => harnessServices.close());
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
      turnsForSession: (sessionId) => coreStore.turnsForSession(sessionId, 1_000),
      runtimeEventsForSession: (sessionId) => coreStore.runtimeEventsForSession(sessionId),
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
        return (await import("./harness/profile-training-source.js")).profileTrainingSource({ release: explicitProfileRelease, storeDir });
      },
      ...evaluationRoutes,

      ...harnessRoutes,

      subscribeRuntimeEvents,
      observeRuntimeOperation: (runtimeEvent) => {
        logger.info("agent runtime operation", runtimeEvent);
      },
    }),
    close: async () => {
      if (closing) return;
      closing = true;
      await sessionTitleService.close();
      // Optional workflows can be waiting on turns; cancel both owners before draining.
      await Promise.all([evaluations.close(), harnessServices.close(), turnRunner.close()]);
      isolatedProfileTools?.close();
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
    updateSession,
    pinSessionHarness: async id => {
      const runtime = await loadLocalHarnessRuntimeForSession(store, await getSession(id));
      if (!runtime) return null;
      const reference = { id: runtime.release.harnessRelease.id, contentHash: runtime.release.harnessRelease.contentHash };
      await ensureLocalHarnessRunOverlay({ store, runId: id, workspace: runtime.workspace, harnessRelease: reference, admittedAt: now() });
      return reference;
    },
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

async function selectService<T>(override: T | false | undefined, embedded: boolean, defaultService: () => Promise<T>): Promise<T | undefined> {
  if (override === false) return undefined;
  if (override !== undefined) return override;
  return embedded ? undefined : defaultService();
}
