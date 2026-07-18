import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTurnRunner } from "../apps/server/dist/runtime/turn-runner.js";

const NOW = "2026-05-16T00:00:00.000Z";

function baseSession(overrides = {}) {
  return {
    id: "session_1",
    provider: "codex",
    modelRef: { providerId: "codex", modelId: "gpt-5" },
    title: "Rename tool",
    appId: "app_1",
    appName: "mpp-service-tool",
    workspaceKind: "local_project",
    workspaceId: "project_1",
    workspaceName: "mpp-service-tool",
    localProjectId: "project_1",
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/wrong/hosted/workspace/repo",
    codexThreadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}

function createImproveRun(overrides = {}) {
  return {
    schemaVersion: "openpond.createImprove.run.v1",
    id: "create_improve_contract",
    revision: 0,
    operation: "create",
    surface: "direct_prompt_create",
    command: "/create",
    objective: "Create a support triage agent",
    state: "awaiting_plan_approval",
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: "/tmp/openpond-profile",
      sourcePath: "/tmp/openpond-profile/profiles/default",
      localHead: null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: "user_1", kind: "user", label: "User" },
    scope: {
      profileId: "default",
      conversationId: "session_1",
      originTurnId: "turn_1",
      workItemId: null,
      projectId: "project_1",
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      signalRefs: [],
      evalRefs: [],
      targetRepoAssumptions: [],
    },
    target: {
      kind: "agent",
      id: "support-triage-agent",
      displayName: "Support Triage Agent",
      defaultActionKey: "support-triage-agent.chat",
    },
    plan: {
      schemaVersion: "openpond.createImprove.plan.v1",
      id: "create_improve_plan_contract",
      runId: "create_improve_contract",
      status: "pending_approval",
      objective: "Create a support triage agent",
      summary: "Create the source-backed support triage agent.",
      capturedContextSummary: "Direct Create request.",
      defaultChatAction: {
        key: "support-triage-agent.chat",
        label: "Support Triage Agent",
        required: true,
      },
      sourcePlan: [],
      requirements: [],
      checks: [],
      approvalId: "approval_create_improve_contract",
      approvedAt: null,
      editedFromPlanId: null,
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
    },
    workflowCapture: null,
    executionPolicy: { mode: "background", pauseAllowed: true, cancellationAllowed: true },
    iterationPolicy: { mode: "single", maximumAttempts: 1, currentAttempt: 0 },
    approvalIds: ["approval_create_improve_contract"],
    questionIds: [],
    questions: [],
    candidates: [],
    evaluationReceipts: [],
    checkRefs: [],
    sourceRefs: [],
    externalExecutionRefs: [],
    localProfileCommit: null,
    hostedSourceCommit: null,
    hostedSourceRef: null,
    releaseOutcome: {
      status: "not_requested",
      profileCommit: null,
      profileTag: null,
      releaseReceiptRef: null,
      updatedAt: null,
    },
    blockedReason: null,
    appliedActionIds: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function baseTurn(createImproveRun = null) {
  return {
    id: "turn_1",
    sessionId: "session_1",
    providerTurnId: null,
    modelRef: { providerId: "codex", modelId: "gpt-5" },
    prompt: "Create a support triage agent",
    startedAt: NOW,
    completedAt: NOW,
    status: "completed",
    error: null,
    metadata: {},
    createImproveRun,
  };
}

function createMemoryStore({ events, turns, approvals = [], createImproveRuns = [] }) {
  const actionReceipts = new Map();
  return {
    async runtimeEventsForSession(sessionId, query = {}) {
      return events
        .map((event, index) => ({ ...event, sequence: event.sequence ?? index + 1 }))
        .filter((event) =>
          event.sessionId === sessionId
          && (query.afterSequence == null || event.sequence > query.afterSequence)
          && (!query.names?.length || query.names.includes(event.name))
        )
        .slice(0, query.limit ?? undefined);
    },
    async latestAssistantTextForSession(sessionId) {
      return events.findLast((event) =>
        event.sessionId === sessionId && event.name === "assistant.delta" && event.output?.trim()
      )?.output?.trim() ?? null;
    },
    async currentOpenPondThreadGoal() {
      return null;
    },
    async openPondThreadGoalById() {
      return null;
    },
    async latestTurnForSession(sessionId, status) {
      return turns.findLast((turn) =>
        turn.sessionId === sessionId && (!status || turn.status === status)
      ) ?? null;
    },
    async countTurnsForSession(sessionId) {
      return turns.filter((turn) => turn.sessionId === sessionId).length;
    },
    async hasSubagentParentWakeTurn() {
      return false;
    },
    async countSubagentParentWakeTurns() {
      return 0;
    },
    async getTurn(turnId) {
      return turns.find((turn) => turn.id === turnId) ?? null;
    },
    async insertTurn(turn) {
      turns.push(turn);
    },
    async updateTurn(turnId, updater) {
      const index = turns.findIndex((turn) => turn.id === turnId);
      if (index === -1) return null;
      turns[index] = updater(turns[index]);
      return turns[index];
    },
    async getApproval(approvalId) {
      return approvals.find((approval) => approval.id === approvalId) ?? null;
    },
    async getCreateImproveRun(runId) {
      return createImproveRuns.find((run) => run.id === runId)
        ?? turns.map((turn) => turn.createImproveRun).find((run) => run?.id === runId)
        ?? null;
    },
    async listCreateImproveRuns() {
      return createImproveRuns;
    },
    async upsertCreateImproveRun(run) {
      const index = createImproveRuns.findIndex((candidate) => candidate.id === run.id);
      if (index === -1) createImproveRuns.push(run);
      else createImproveRuns[index] = run;
      return run;
    },
    async mutateCreateImproveRun(action, updater) {
      const replay = actionReceipts.get(action.actionId);
      if (replay) return { run: replay, replayed: true };
      const current = await this.getCreateImproveRun(action.runId);
      assert.ok(current);
      assert.equal(current.revision, action.expectedRevision);
      const next = updater(current);
      await this.upsertCreateImproveRun(next);
      actionReceipts.set(action.actionId, next);
      return { run: next, replayed: false };
    },
    async upsertModelUsageRecord(record) {
      return record;
    },
    async listModelUsageRecords() {
      return [];
    },
  };
}

function upsertApprovalInto(approvals) {
  return async (approval) => {
    const index = approvals.findIndex((candidate) => candidate.id === approval.id);
    if (index === -1) approvals.push(approval);
    else approvals[index] = approval;
  };
}

function createManualQueue() {
  const entries = [];
  return {
    queueId: "test-turn-follow-up",
    enqueue(job, work) {
      const receipt = {
        id: `receipt_${entries.length + 1}`,
        queueId: "test-turn-follow-up",
        label: job.label,
        enqueuedAt: NOW,
        startedAt: null,
        completedAt: null,
        status: "queued",
        error: null,
        metadata: job.metadata ?? {},
        done: Promise.resolve(null),
      };
      entries.push({ receipt, work });
      return receipt;
    },
    async drain() {
      for (const entry of entries) {
        if (entry.receipt.status !== "queued") continue;
        entry.receipt.status = "running";
        entry.receipt.startedAt = NOW;
        try {
          await entry.work();
          entry.receipt.status = "completed";
        } catch (error) {
          entry.receipt.status = "failed";
          entry.receipt.error = error instanceof Error ? error.message : String(error);
        }
        entry.receipt.completedAt = NOW;
      }
    },
    receipts() {
      return entries.map((entry) => entry.receipt);
    },
    pendingReceipts() {
      return entries
        .map((entry) => entry.receipt)
        .filter((receipt) => receipt.status === "queued" || receipt.status === "running");
    },
  };
}

function runnerDependencies({
  session,
  store,
  approvals,
  events,
  queue,
  ensureCodexRuntime,
  resolveSessionWorkspaceCwd = async (candidate) => candidate.cwd,
}) {
  let currentSession = session;
  return {
    store,
    upsertApproval: upsertApprovalInto(approvals),
    getSession: async () => currentSession,
    updateSession: async (_sessionId, patch) => {
      currentSession = { ...currentSession, ...patch };
      return currentSession;
    },
    completeTurn: async (_sessionId, turnId, providerTurnId = null) =>
      store.updateTurn(turnId, (turn) => ({
        ...turn,
        providerTurnId,
        completedAt: NOW,
        status: "completed",
      })),
    failTurn: async (_session, turnId, message) =>
      store.updateTurn(turnId, (turn) => ({ ...turn, status: "failed", error: message })),
    interruptTurn: async (_session, turnId) =>
      store.updateTurn(turnId, (turn) => ({ ...turn, status: "interrupted" })),
    defaultSessionCwd: (appId) => `/default/${appId ?? "none"}`,
    resolveSessionWorkspaceCwd,
    ensureCodexRuntime,
    appendWorkspaceDiffEvent: async () => undefined,
    workspaceDiffBaseline: async () => null,
    appendRuntimeEvent: async (event) => {
      events.push(event);
    },
    executeWorkspaceTool: async () => {
      throw new Error("workspace tools should not run in this test");
    },
    loadPersonalizationSoul: async () => "",
    maybeCreateScaffoldForTurn: async (candidate) => candidate,
    hostedSystemPrompt: async () => "",
    appendAssistantText: async () => undefined,
    appendHostedContextUsage: async () => undefined,
    turnFollowUpQueue: queue,
    maxHostedWorkspaceToolRounds: 1,
    maxRepeatedInvalidToolRequests: 1,
  };
}

describe("turn runner workspace cwd", () => {
  test("uses one revisioned Create/Improve run for approval and queued execution", async () => {
    const run = createImproveRun();
    const turns = [baseTurn(run)];
    const events = [];
    const approvals = [];
    const runs = [run];
    const queue = createManualQueue();
    const store = createMemoryStore({ events, turns, approvals, createImproveRuns: runs });
    const runner = createTurnRunner(runnerDependencies({
      session: baseSession({ cwd: "/tmp/openpond-profile" }),
      store,
      approvals,
      events,
      queue,
      ensureCodexRuntime: async () => {
        throw new Error("intentional contract execution failure");
      },
    }));

    const approved = await runner.applyCreateImproveAction(run.id, {
      runId: run.id,
      expectedRevision: 0,
      actionId: "approve_create_improve_contract",
      type: "approve_plan",
    });

    assert.equal(approved.revision, 1);
    assert.equal(approved.state, "applying_source");
    assert.deepEqual(approved.appliedActionIds, ["approve_create_improve_contract"]);
    assert.equal(turns[0].createImproveRun.id, run.id);
    assert.equal(turns[0].createImproveRun.state, "applying_source");
    assert.equal(queue.pendingReceipts().length, 1);

    await queue.drain();

    assert.equal(turns[0].createImproveRun.state, "blocked");
    assert.ok(turns[0].createImproveRun.blockedReason);
    assert.ok(events.some((event) =>
      event.name === "create_improve.updated"
      && event.data?.createImproveRun?.id === run.id
    ));
  });

  test("keeps linked local project Codex turns in the local project checkout", async () => {
    const turns = [];
    const events = [];
    const approvals = [];
    const resolveCalls = [];
    let codexRuntimeSession = null;
    let codexStartTurn = null;
    const store = createMemoryStore({ events, turns, approvals });
    const runner = createTurnRunner(runnerDependencies({
      session: baseSession(),
      store,
      approvals,
      events,
      queue: createManualQueue(),
      resolveSessionWorkspaceCwd: async (candidate, options = {}) => {
        resolveCalls.push({ workspaceKind: candidate.workspaceKind, appId: candidate.appId, options });
        return "/home/glu/Projects/all/templates-qa/mpp-service-tool";
      },
      ensureCodexRuntime: async (candidate, turnInput) => {
        codexRuntimeSession = { ...candidate };
        return {
          client: {
            startTurn: async (params) => {
              codexStartTurn = params;
              return { turnId: "codex_turn_1" };
            },
            waitForTurn: async () => undefined,
            interruptTurn: async () => undefined,
          },
          threadId: "codex_thread_1",
          cwd: candidate.cwd,
          permissionMode: turnInput.codexPermissionMode,
        };
      },
    }));

    const turn = await runner.sendTurn("session_1", {
      prompt: "rename call-mpp-service",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      codexPermissionMode: "default",
    });

    assert.equal(turn.status, "completed");
    assert.equal(codexRuntimeSession.cwd, "/home/glu/Projects/all/templates-qa/mpp-service-tool");
    assert.equal(codexStartTurn.cwd, "/home/glu/Projects/all/templates-qa/mpp-service-tool");
    assert.equal(resolveCalls.length, 2);
    assert.deepEqual(resolveCalls.map((call) => call.options.ensureOpenPond), [false, false]);
  });
});
