import path from "node:path";

import { createAppServer, type AppServerInstance } from "@openpond/app-server";
import {
  AppPreferencesSchema,
  localPathWorkspaceId,
  type Approval,
  type ModelUsageRecord,
  type OpenPondApp,
  type RuntimeEvent,
} from "@openpond/contracts";
import {
  loadOpenPondProfileLibrary,
  loadOpenPondProfileState,
  readProfileSkill,
} from "@openpond/cloud";
import { createLogger } from "@openpond/logging";
import {
  getBundledRuntimeVersion,
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

import { VERSION } from "./constants.js";
import {
  ensureSelectedLocalHarnessWorkspace,
  resolveSelectedLocalHarnessRelease,
} from "./harness/local-harness-selection.js";
import {
  ensureLocalHarnessRunOverlay,
  loadLocalHarnessRuntimeForAgentRun,
} from "./harness/local-harness-run-overlay.js";
import {
  createLocalHarnessSettingsRoutePayloads,
  localHarnessHistoryPayload,
} from "./harness/local-harness-history.js";
import { createLocalHarnessImprovementRuntime } from "./harness/local-harness-improvement-runtime.js";
import { createLocalHarnessModelToolDefinitions } from "./harness/local-harness-model-tools.js";
import { createOpenPondCommandAccessService } from "./openpond/command-access.js";
import { listAppServerIntegrationConnections } from "./openpond/app-server-connected-apps.js";
import { createCloudConnectedAppToolExecutor } from "./openpond/connected-app-executor.js";
import { createHostedTurnHelpers } from "./openpond/hosted-turn-helpers.js";
import { loadPersonalizationSettings } from "./openpond/personalization.js";
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
import { createLocalHarnessTasksetReviewControl } from "./harness/local-harness-taskset-review.js";
import { createProfileTurnDependencies } from "./runtime/profile-turn-dependencies.js";
import { createRuntimeEventBus } from "./runtime/runtime-event-bus.js";
import { createTurnRunner } from "./runtime/turn-runner.js";
import { resolveMaxHostedWorkspaceToolRounds } from "./server-entry-helpers.js";
import { createSessionStore } from "./store/session-store.js";
import { SqliteStore } from "./store/store.js";
import { event, now } from "./utils.js";

const MAX_REPEATED_INVALID_TOOL_REQUESTS = 3;

export type OpenPondAppServerOptions = {
  storeDir?: string;
  workspaceDir?: string;
  version?: string;
  maxHostedWorkspaceToolRounds?: number;
  streamOpenPondHostedChatTurn?: typeof defaultStreamOpenPondHostedChatTurn;
  sandboxRequest?: AppServerSandboxRequest;
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

export async function createOpenPondAppServer(
  options: OpenPondAppServerOptions = {},
): Promise<OpenPondAppServerInstance> {
  const storeDir = path.resolve(options.storeDir ?? appDataDir());
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
  const version = options.version ?? VERSION;
  const runtimeVersion = getBundledRuntimeVersion();
  const logger = createLogger({
    channel: "app-server",
    logDir: path.join(storeDir, "logs"),
    metadata: { version, runtimeVersion, placement: "hosted_work" },
  });
  const store = new SqliteStore(storeDir, { logger });
  const streamOpenPondHostedChatTurn = createScriptedOpenPondChatStream(
    options.streamOpenPondHostedChatTurn ?? defaultStreamOpenPondHostedChatTurn,
    { enabled: scriptedOpenPondModelsEnabled() },
  );

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
    loadAppPreferences: async () => AppPreferencesSchema.parse({}),
    loadLastUsedProfile: async () =>
      (await loadOpenPondProfileLibrary()).lastUsed,
  });
  const workspace = createAppServerWorkspace({
    workspaceDir,
    logger,
    getSession,
    appendRuntimeEvent,
    sandboxRequest: options.sandboxRequest,
  });
  const harnessTasksetReview = await createLocalHarnessTasksetReviewControl({
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
        const release = await resolveSelectedLocalHarnessRelease(store);
        return release
          ? {
              agentSnapshot: release.agentSnapshot,
              harnessRelease: release.harnessRelease,
            }
          : null;
      },
    },
  });
  const upsertApproval = async (approval: Approval): Promise<void> => {
    await store.upsertApproval(approval);
  };
  const commandAccess = createOpenPondCommandAccessService({
    upsertApproval,
    appendRuntimeEvent,
  });
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
  const harnessImprovement = createLocalHarnessImprovementRuntime({
    store,
    storeDir,
    queue: turnFollowUpQueue,
    streamOpenPondHostedChatTurn,
    appendRuntimeEvent,
    upsertModelUsageRecord: safeUpsertModelUsageRecord,
  });
  await harnessImprovement.reconcilePending();

  const turnRunner = createTurnRunner({
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
    loadOpenPondProfileState,
    ...createProfileTurnDependencies(),
    loadOpenPondProfileLibrary,
    readOpenPondProfileSkill: readProfileSkill,
    loadSelectedHarnessRuntime: (session) =>
      loadLocalHarnessRuntimeForAgentRun(store, session.id),
    ensureHarnessRunOverlay: (input) =>
      ensureLocalHarnessRunOverlay({ store, ...input }),
    harnessModelTools: createLocalHarnessModelToolDefinitions({ store }),
    loadBuiltInOpenPondSkills: loadBundledAuthoringSkills,
    readBuiltInOpenPondSkill: async (name) => {
      if (!isBundledAuthoringSkillName(name)) {
        throw new Error(`Built-in OpenPond skill not found: ${name}`);
      }
      return readBundledAuthoringProfileSkill(name);
    },
    executeWebSearch: createWebSearchExecutorFromEnv(),
    executeConnectedAppTool: createCloudConnectedAppToolExecutor(),
    listIntegrationConnections: listAppServerIntegrationConnections,
    loadPersonalizationSoul: async () =>
      (await loadPersonalizationSettings(store, storeDir)).soul,
    loadAppPreferences: async () => AppPreferencesSchema.parse({}),
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
  await turnRunner.recoverPendingSubagentCompletions();

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
  });
  const instance = createAppServer({
    ports: createAgentRuntimePorts({
      placement: "hosted_work",
      createSession,
      getSession,
      turnsForSession: (sessionId) => store.turnsForSession(sessionId, 1_000),
      runtimeEventsForSession: (sessionId) =>
        store.runtimeEventsForSession(sessionId),
      sendTurn: turnRunner.sendTurn,
      isSessionTurnActive: turnRunner.isSessionTurnActive,
      waitForSessionTurnSettlement: turnRunner.waitForSessionTurnSettlement,
      interruptSessionTurn: turnRunner.interruptSessionTurn,
      resolveApproval,
      inspectHarness: () => localHarnessHistoryPayload(store),
      reviewHarnessProposal: createLocalHarnessSettingsRoutePayloads({ store, storeDir }).reviewHarnessProposalPayload,
      reviewHarness: (request) => reviewSelectedLocalHarnessEvaluation({ store, request }),
      acceptHarnessEvaluationReview: harnessTasksetReview.acceptEvaluationReview,
      materializeHarnessEvaluationTaskset:
        harnessTasksetReview.materializeEvaluationTaskset,
      runHarnessEvaluationBaseline:
        harnessTasksetReview.runEvaluationBaseline,
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
        harnessSettings.updateHarnessBackgroundReviewPayload,
      diffHarness: harnessSettings.harnessDiffPayload,
      rollbackHarness: harnessSettings.rollbackHarnessPayload,
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
  logger.info("app-server ready", {
    storePath: store.storePath,
    workspaceDir,
    composition: APP_SERVER_COMPOSITION,
  });
  return {
    ...instance,
    storePath: store.storePath,
    workspaceDir,
    composition: APP_SERVER_COMPOSITION,
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
