import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createAppServer } from "@openpond/app-server";
import { emptyOpenPondProfileLibrary, emptyOpenPondProfileState, localPathWorkspaceId,
  SendTurnRequestSchema, type OpenPondApp } from "@openpond/contracts";
import { createLogger } from "@openpond/logging";
import { getBundledRuntimeVersion } from "@openpond/runtime";
import { HOST_STORAGE_CONTRACT_VERSION, HostStorageCapabilitySchema } from "@openpond/agent-runtime";
import { contentHash } from "@openpond/harness";

import type { OpenPondAppServerInstance, OpenPondAppServerOptions } from "../app-server-runtime.js";
import { VERSION } from "../constants.js";
import { loadHostedHarnessRuntimeForSession, loadHostedHarnessRuntime } from "../store/hosted-harness-runtime.js";
import { HostedHarnessOverlayStorage } from "../store/hosted-harness-overlay-storage.js";
import { HostedHarnessStateStorage } from "../store/hosted-harness-state-storage.js";
import { loadHostedRuntimeSettings } from "../store/hosted-runtime-settings.js";
import { listHostedProfileWorkflows, loadHostedProfileStateAndLibrary } from "../store/hosted-profile-source.js";
import { createRuntimeEventBus } from "./runtime-event-bus.js";
import { createBackgroundWorkerQueue } from "./background-worker-queue.js";
import { createSessionStore } from "../store/session-store.js";
import { createAppServerWorkspace } from "./app-server-workspace.js";
import { createHostedTurnHelpers } from "../openpond/hosted-turn-helpers.js";
import { createTurnRunner } from "./turn-runner.js";
import { createAgentRuntimePorts } from "./agent-runtime-host.js";
import { createEmbeddingToolResolver } from "./app-server-embedding.js";
import { createHostedWorkOutputLifecycle } from "../work/hosted-work-output-lifecycle.js";
import { createHostedHarnessMemoryTools } from "../store/hosted-harness-memory-tools.js";
import { createHostedEmbeddingAdapter, createHostedSandboxRequest } from "./hosted-embedding-adapter.js";
import { assertHostedWorkCapabilities } from "./hosted-capability-admission.js";
import { resolveMaxHostedWorkspaceToolRounds } from "../server-entry-helpers.js";
import { createScriptedOpenPondChatStream, scriptedOpenPondModelsEnabled } from "../openpond/scripted-chat-provider.js";

const unavailable = async (): Promise<never> => { throw new Error("This hosted control is not available until its Postgres repository is activated."); };
const emptyProfileLibrary = emptyOpenPondProfileLibrary();
const emptyProfile = emptyOpenPondProfileState();

/** Core hosted Work composition. Every mutable runtime store is supplied by the host. */
export async function createHostedOwnedAppServer(options: OpenPondAppServerOptions & {
  runtimeStorage: NonNullable<OpenPondAppServerOptions["runtimeStorage"]>;
}): Promise<OpenPondAppServerInstance> {
  const storage = options.runtimeStorage;
  const client = options.hostStorageClient;
  if (storage.kind !== "hosted_postgres" || !client || storage.client !== client) {
    throw new Error("Hosted storage selection mismatch.");
  }
  if (options.embedding || options.sandboxRequest) {
    throw new Error("Hosted Postgres tool and sandbox authority must come from the host transport.");
  }
  if (!options.streamOpenPondHostedChatTurn) {
    throw new Error("Hosted Postgres runtime requires a host-admitted model stream.");
  }
  if (options.profileSource || options.harness) {
    throw new Error("Hosted Postgres runtime accepts only host-admitted immutable sources.");
  }
  if (options.services && Object.values(options.services).some((service) => service !== false && service !== undefined)) {
    throw new Error("Hosted service adapters must be admitted by the Postgres composition.");
  }
  const capabilities = HostStorageCapabilitySchema.parse(await client.request({
    contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
    operation: "capabilities", params: {},
  }));
  assertHostedWorkCapabilities(capabilities);
  const embedding = createHostedEmbeddingAdapter(client, capabilities.allowedTools);
  const sandboxRequest = createHostedSandboxRequest(client);
  const storeDir = path.resolve(options.storeDir ?? process.cwd());
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
  await mkdir(workspaceDir, { recursive: true });
  const logger = createLogger({ channel: "app-server", logDir: path.join(storeDir, "logs"),
    metadata: { version: options.version ?? VERSION, runtimeVersion: getBundledRuntimeVersion(), placement: "hosted_work" } });
  const core = storage.core;
  const admittedProfile = storage.admittedProfileRelease
    ? await loadHostedProfileStateAndLibrary(client, storage.admittedProfileRelease)
    : { profile: emptyProfile, profileLibrary: emptyProfileLibrary };
  const { appendRuntimeEvent, closeEventSubscribers, subscribeRuntimeEvents } = createRuntimeEventBus({ logger, store: core });
  const outputLifecycle = createHostedWorkOutputLifecycle({
    client, storeDir, sandboxRequest,
    getTurn: (turnId) => core.getTurn(turnId),
    runtimeEventsForSession: (sessionId) => core.runtimeEventsForSession(sessionId,
      { excludeReasoningDeltas: true }),
    appendRuntimeEvent,
  });
  const turnFollowUpQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up", logger });
  const subagentQueue = createBackgroundWorkerQueue({ queueId: "subagent", logger });
  const stream = createScriptedOpenPondChatStream(options.streamOpenPondHostedChatTurn,
    { enabled: scriptedOpenPondModelsEnabled() });
  const preferences = async () => (await loadHostedRuntimeSettings(client)).preferences;
  const { createSession, getSession, updateSession, completeTurn, failTurn, interruptTurn } = createSessionStore({
    store: core, defaultSessionCwd: () => workspaceDir, appendRuntimeEvent,
    loadAppPreferences: preferences,
    loadLastUsedProfile: async () => admittedProfile.profileLibrary.lastUsed,
  });
  const workspace = createAppServerWorkspace({
    workspaceDir, logger, getSession, updateSession, appendRuntimeEvent,
    sandboxRequest,
  });
  const helpers = createHostedTurnHelpers({
    appendRuntimeEvent, findLocalProject: async () => null,
    onRepositoryInstructionDiagnostic: (diagnostic, session) => logger.warn("repository instruction file skipped", {
      diagnostic, sessionId: session.id,
    }),
  });
  const overlay = new HostedHarnessOverlayStorage(client);
  const harnessState = new HostedHarnessStateStorage(client);
  const turnRunner = createTurnRunner({
    workInputsForSession: options.workInputsForSession,
    finalizeWorkTurn: outputLifecycle.finalizeWorkTurn,
    attachmentRootDir: path.join(storeDir, "attachments"),
    resolveModelTools: createEmbeddingToolResolver(embedding, async (turnId, bindings) => {
      const turn = await core.getTurn(turnId);
      if (!turn) throw new Error("Embedded turn is unavailable.");
      const session = await getSession(turn.sessionId);
      const previous = session.metadata?.embeddingToolBindings;
      const admittedBindings = [...bindings].sort((a, b) => a.name.localeCompare(b.name));
      if (previous !== undefined && contentHash(previous) !== contentHash(admittedBindings)) {
        throw new Error("Embedded tool bindings changed; start a new thread.");
      }
      await updateSession(session.id, { metadata: { ...session.metadata, embeddingToolBindings: admittedBindings } });
      await core.updateTurn(turnId, current => ({ ...current,
        metadata: { ...current.metadata, toolBindings: admittedBindings } }));
    }),
    hostedToolFlags: { toolMode: "native", nativeToolTransport: true,
      nativeToolProviderDenylist: [], textToolFallback: false },
    store: core, inboxStore: storage.inbox,
    createSession, getSession, updateSession, completeTurn, failTurn, interruptTurn,
    upsertApproval: (approval) => core.upsertApproval(approval),
    defaultSessionCwd: () => workspaceDir,
    findOpenPondApp: async (appId): Promise<OpenPondApp> => ({
      id: appId || localPathWorkspaceId(workspaceDir), name: path.basename(workspaceDir) || "Workspace",
      description: null, visibility: "private", sandbox: true,
    }),
    resolveSessionWorkspaceCwd: async (session) => session.cwd?.trim() || workspaceDir,
    ensureCodexRuntime: async () => { throw new Error("Codex process hosting is unavailable."); },
    appendWorkspaceDiffEvent: workspace.appendWorkspaceDiffEvent,
    workspaceDiffBaseline: workspace.workspaceDiffBaseline,
    appendRuntimeEvent, executeWorkspaceTool: workspace.executeWorkspaceTool,
    executeOpenPondCommand: async () => {
      throw new Error("Hosted commands require durable authorization.");
    },
    loadOpenPondProfileState: async () => admittedProfile.profile,
    loadOpenPondProfileLibrary: async () => admittedProfile.profileLibrary,
    readOpenPondProfileSkill: unavailable,
    loadSelectedHarnessRuntime: (session) => {
      if (session.currentProfile && (!storage.admittedProfileRelease ||
          session.currentProfile.repositoryId !== storage.admittedProfileRelease.repositoryId ||
          session.currentProfile.profileId !== storage.admittedProfileRelease.profileId)) {
        throw new Error("Hosted Profile session lacks admitted immutable source.");
      }
      return loadHostedHarnessRuntimeForSession(client, session);
    },
    ensureHarnessRunOverlay: (input) => overlay.ensureHarnessRunOverlay(input),
    harnessModelTools: createHostedHarnessMemoryTools(client),
    loadBuiltInOpenPondSkills: async () => [],
    readBuiltInOpenPondSkill: unavailable,
    loadPersonalizationSoul: async () => (await loadHostedRuntimeSettings(client)).personalizationSoul,
    loadAppPreferences: preferences,
    maybeCreateScaffoldForTurn: helpers.maybeCreateScaffoldForTurn,
    hostedSystemPrompt: helpers.hostedSystemPrompt,
    appendAssistantText: helpers.appendAssistantText,
    appendHostedContextUsage: helpers.appendHostedContextUsage,
    streamOpenPondHostedChatTurn: stream,
    turnFollowUpQueue, subagentQueue,
    maxHostedWorkspaceToolRounds: resolveMaxHostedWorkspaceToolRounds(options.maxHostedWorkspaceToolRounds),
    maxRepeatedInvalidToolRequests: 3,
  });
  await turnRunner.recoverPendingSubagentCompletions();
  await turnRunner.recoverTaskInbox();
  const sendTurn: typeof turnRunner.sendTurn = async (sessionId, payload) => {
    if (SendTurnRequestSchema.parse(payload).attachments?.length) {
      throw new Error("Hosted attachments require managed-file admission.");
    }
    const session = await getSession(sessionId);
    if (session.currentProfile && (!storage.admittedProfileRelease ||
        session.currentProfile.repositoryId !== storage.admittedProfileRelease.repositoryId ||
        session.currentProfile.profileId !== storage.admittedProfileRelease.profileId)) {
      throw new Error("Hosted Profile session lacks admitted immutable source.");
    }
    return turnRunner.sendTurn(sessionId, payload);
  };
  let closing = false;
  const instance = createAppServer({
    ports: createAgentRuntimePorts({
      bindHome: false,
      placement: "hosted_work", connectedAppProviders: [],
      featureOverrides: {
        profileWorkflows: Boolean(storage.admittedProfileRelease), profileEvaluations: false,
        harnessProposalReview: false,
        harnessEvaluationReview: false, harnessEvaluationReviewAcceptance: false,
        harnessEvaluationTasksetMaterialization: false, harnessEvaluationBaseline: false,
        harnessBackgroundReview: false, harnessDiff: false, harnessRollback: false,
        harnessReview: false, refinerProfiles: false, immutableRefinerAdmission: false,
      },
      createSession, getSession,
      turnsForSession: (sessionId) => core.turnsForSession(sessionId, 1_000),
      runtimeEventsForSession: (sessionId) => core.runtimeEventsForSession(sessionId,
        { excludeReasoningDeltas: true }),
      sendTurn, steerSessionTurn: turnRunner.steerSessionTurn,
      readTaskInbox: turnRunner.readTaskInbox, queueTaskInput: turnRunner.queueTaskInput,
      updateTaskInput: turnRunner.updateTaskInput,
      isSessionTurnActive: turnRunner.isSessionTurnActive,
      waitForSessionTurnSettlement: turnRunner.waitForSessionTurnSettlement,
      interruptSessionTurn: turnRunner.interruptSessionTurn,
      resolveApproval: async (approvalId, payload) => {
        const improve = await turnRunner.resolveCreateImproveApproval(approvalId, payload);
        if (improve) return improve;
        const subagent = await turnRunner.resolveSubagentPatchApplyApproval(approvalId, payload);
        if (subagent) return subagent;
        throw new Error(`Approval not found: ${approvalId}`);
      },
      listProfileWorkflows: storage.admittedProfileRelease
        ? () => listHostedProfileWorkflows(client, storage.admittedProfileRelease!) : unavailable,
      listProfileEvaluations: unavailable,
      loadProfileTrainingSource: unavailable, prepareProfileEvaluationRun: unavailable,
      runPreparedProfileEvaluation: unavailable, runProfileEvaluationSuite: unavailable,
      executeProfileEvaluationCase: unavailable, executeProfileEvaluationRun: unavailable,
      compareProfileEvaluationRuns: unavailable, buildProfileEvaluationReport: unavailable,
      inspectHarness: async () => {
        const runtime = await loadHostedHarnessRuntime(client);
        if (!runtime) return null;
        const workspaceId = runtime.workspace.id;
        const [backgroundReview, evaluationReview, refinementCandidates, crossRunRequests] = await Promise.all([
          harnessState.getPreference(workspaceId, "workspace_settings"),
          harnessState.getPreference(workspaceId, "evaluation_review_settings"),
          harnessState.listCandidates(workspaceId),
          harnessState.listCrossRunRequests(workspaceId),
        ]);
        return { workspace: runtime.workspace, release: runtime.release,
          backgroundReview, evaluationReview, refinementCandidates, crossRunRequests };
      },
      reviewHarnessProposal: unavailable, reviewHarness: unavailable,
      acceptHarnessEvaluationReview: unavailable, materializeHarnessEvaluationTaskset: unavailable,
      runHarnessEvaluationBaseline: unavailable,
      validateHarness: async () => {
        const runtime = await loadHostedHarnessRuntime(client);
        return runtime ? { valid: true, workspaceId: runtime.workspace.id,
          harnessRelease: runtime.release.harnessRelease, agentSnapshot: runtime.release.agentSnapshot }
          : { valid: false, reason: "No admitted hosted Harness release." };
      },
      updateHarnessBackgroundReview: unavailable, diffHarness: unavailable,
      rollbackHarness: unavailable, inspectRefiner: unavailable,
      updateRefiner: unavailable, activateRefiner: unavailable, rollbackRefiner: unavailable,
      subscribeRuntimeEvents,
      observeRuntimeOperation: (runtimeEvent) => logger.info("agent runtime operation", runtimeEvent),
    }),
    close: async () => {
      if (closing) return;
      closing = true;
      await turnRunner.close();
      await Promise.all([turnFollowUpQueue.drain(), subagentQueue.drain()]);
      await closeEventSubscribers();
      await logger.flush();
    },
  });
  return { ...instance, storePath: "hosted-postgres", workspaceDir,
    composition: ["runtime_event_bus", "session_store", "hosted_provider", "workspace_tools",
      "command_approvals", "harness", "agent_runtime", "jsonl_transport"] };
}
