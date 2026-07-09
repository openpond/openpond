import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createTurnRunner } from "../apps/server/dist/runtime/turn-runner.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function baseSession(overrides = {}) {
  return {
    id: "session_1",
    provider: "codex",
    title: "Rename tool",
    appId: "app_1",
    appName: "mpp-service-tool",
    workspaceKind: "local_project",
    workspaceId: "project_1",
    workspaceName: "mpp-service-tool",
    cwd: "/wrong/hosted/workspace/repo",
    codexThreadId: null,
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}

function createMemoryStore({ events, turns, approvals = [] }) {
  return {
    async snapshot() {
      return { events, turns, approvals };
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
      const next = updater(turns[index]);
      turns[index] = next;
      return next;
    },
    async getApproval(approvalId) {
      return approvals.find((approval) => approval.id === approvalId) ?? null;
    },
    async mutate(fn) {
      fn({ events, turns, approvals });
    },
  };
}

function upsertApprovalInto(approvals = []) {
  return async (approval) => {
    const index = approvals.findIndex((candidate) => candidate.id === approval.id);
    if (index === -1) approvals.push(approval);
    else approvals[index] = approval;
  };
}

function createImmediateQueue() {
  const receipts = [];
  return {
    queueId: "test-turn-follow-up",
    enqueue(job, work) {
      const receipt = {
        id: `receipt_${receipts.length + 1}`,
        queueId: "test-turn-follow-up",
        label: job.label,
        enqueuedAt: "2026-05-16T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        status: "queued",
        error: null,
        metadata: job.metadata ?? {},
        done: Promise.resolve(null),
      };
      receipt.done = (async () => {
        receipt.status = "running";
        receipt.startedAt = "2026-05-16T00:00:00.000Z";
        try {
          await work();
          receipt.status = "completed";
        } catch (error) {
          receipt.status = "failed";
          receipt.error = error instanceof Error ? error.message : String(error);
        } finally {
          receipt.completedAt = "2026-05-16T00:00:01.000Z";
        }
        return receipt;
      })();
      receipts.push(receipt);
      return receipt;
    },
    async drain() {
      await Promise.all(receipts.map((receipt) => receipt.done));
    },
    receipts() {
      return receipts;
    },
    pendingReceipts() {
      return receipts.filter((receipt) => receipt.status === "queued" || receipt.status === "running");
    },
  };
}

describe("turn runner workspace cwd", () => {
  test("pauses create pipeline turns for plan review before provider execution", async () => {
    let session = baseSession({
      provider: "openpond",
      appId: null,
      appName: null,
      workspaceKind: undefined,
      workspaceId: null,
      workspaceName: null,
      cwd: null,
    });
    const turns = [];
    const events = [];
    let workspaceDiffCalled = false;
    const now = "2026-05-16T00:00:00.000Z";
    const createPipelineRequest = {
      schemaVersion: "openpond.createPipeline.request.v1",
      id: "create_request_review",
      operation: "create",
      surface: "direct_prompt_create",
      command: "/create",
      objective: "Create release notes agent",
      adapter: {
        kind: "hosted",
        sourceAuthority: "hosted_profile",
        teamId: "team_1",
        projectId: "profile_project_1",
        activeProfile: "default",
        sourceRef: "main",
        baseSha: null,
        workItemId: null,
        confirmationPolicy: "always_require_plan_approval",
      },
      actor: { id: "sam", kind: "user", label: "Sam" },
      scope: {
        conversationId: "session_1",
        workItemId: null,
        projectId: "profile_project_1",
        targetProject: null,
      },
      context: {
        messageIds: [],
        conversationExcerpts: [],
        attachments: [],
        apps: [],
        tools: [],
        targetRepoAssumptions: [],
      },
      targetAgent: {
        agentId: null,
        displayName: null,
        defaultActionKey: "chat",
      },
      metadata: { source: "web_composer_slash" },
      createdAt: now,
    };

    const runner = createTurnRunner({
      store: createMemoryStore({ events, turns }),
      upsertApproval: upsertApprovalInto(),
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-05-16T00:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("Codex runtime should not be created for create plan review");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => {
        workspaceDiffCalled = true;
        return null;
      },
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tools should not run for create plan review");
      },
      loadPersonalizationSoul: async () => {
        throw new Error("provider personalization should not load for create plan review");
      },
      maybeCreateScaffoldForTurn: async () => {
        throw new Error("scaffold creation should not run for create plan review");
      },
      hostedSystemPrompt: async () => {
        throw new Error("hosted system prompt should not build for create plan review");
      },
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      planCreatePipeline: async ({ request }) =>
        createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
      turnFollowUpQueue: createImmediateQueue(),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "/create release notes agent",
      createPipelineRequest,
    });

    assert.equal(turn.status, "completed");
    assert.equal(turn.providerTurnId, null);
    assert.equal(workspaceDiffCalled, false);
    assert.equal(events.some((event) => event.name === "create_pipeline.updated"), true);
  });

  test("persists and resolves create plan approvals through approval rows", async () => {
    let session = baseSession({
      provider: "openpond",
      appId: null,
      appName: null,
      workspaceKind: undefined,
      workspaceId: null,
      workspaceName: null,
      cwd: null,
    });
    const turns = [];
    const events = [];
    const approvals = [];
    const request = createPipelineRequest("create_request_approval");
    const snapshot = createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval");

    const runner = createTurnRunner({
      store: createMemoryStore({ events, turns, approvals }),
      upsertApproval: upsertApprovalInto(approvals),
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-05-16T00:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("Codex runtime should not be created for create plan review");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tools should not run for create plan review");
      },
      loadPersonalizationSoul: async () => {
        throw new Error("provider personalization should not load for create plan review");
      },
      maybeCreateScaffoldForTurn: async () => {
        throw new Error("scaffold creation should not run for create plan review");
      },
      hostedSystemPrompt: async () => {
        throw new Error("hosted system prompt should not build for create plan review");
      },
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      turnFollowUpQueue: createImmediateQueue(),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "/create release notes agent",
      createPipelineRequest: request,
      createPipeline: snapshot,
    });

    assert.equal(turn.status, "completed");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, snapshot.plan.approvalId);
    assert.equal(approvals[0].kind, "create_plan");
    assert.equal(approvals[0].status, "pending");
    assert.equal(events.some((event) => event.name === "approval.requested"), true);

    const resolved = await runner.resolveCreatePipelineApproval(snapshot.plan.approvalId, {
      decision: "accept",
    });

    assert.equal(resolved.status, "accepted");
    assert.equal(approvals[0].status, "accepted");
    assertHostedCreateApplyBlocked(turns[0].createPipeline);
    assert.equal(turns[0].createPipeline.plan.status, "approved");
    assert.equal(events.some((event) => event.name === "approval.resolved"), true);
  });

  test("resolves local create plan approval before background source application completes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-local-create-approval-"));
    const repoPath = join(workspace, "profile-repo");
    const sourcePath = join(repoPath, "profiles", "default");
    await mkdir(join(sourcePath, "settings"), { recursive: true });
    let session = baseSession({
      provider: "openpond",
      appId: null,
      appName: null,
      workspaceKind: undefined,
      workspaceId: null,
      workspaceName: null,
      cwd: null,
    });
    const turns = [];
    const events = [];
    const approvals = [];
    const request = createLocalPipelineRequest("create_request_local_approval", {
      repoPath,
      sourcePath,
    });
    const snapshot = createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval");
    const sourceApplyGate = deferred();
    let waitForTurnStarted = false;
    let codexRuntimeSession = null;
    let codexTurnInput = null;
    let codexStartTurn = null;
    let checkInput = null;

    const runner = createTurnRunner({
      store: createMemoryStore({ events, turns, approvals }),
      upsertApproval: upsertApprovalInto(approvals),
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-05-16T00:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async (candidate, turnInput) => {
        codexRuntimeSession = { ...candidate };
        codexTurnInput = { ...turnInput };
        return {
          client: {
            startTurn: async (params) => {
              codexStartTurn = { ...params };
              return { turnId: "codex_create_apply_approval" };
            },
            waitForTurn: async () => {
              waitForTurnStarted = true;
              await sourceApplyGate.promise;
            },
            interruptTurn: async () => undefined,
          },
          threadId: "codex_thread_approval",
          cwd: candidate.cwd,
          permissionMode: turnInput.codexPermissionMode,
          reasoningEffort: turnInput.codexReasoningEffort ?? null,
        };
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("local create approval test should not run tools");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (candidate) => candidate,
      hostedSystemPrompt: async () => "",
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      runLocalCreatePipelineChecks: async (input) => {
        checkInput = input;
        return {
          checkRefs: ["profiles/default/agents/support-triage/.openpond/agent-inspect.json"],
          metadata: { inspect: { stdout: "ok", stderr: "" } },
        };
      },
      turnFollowUpQueue: createImmediateQueue(),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "/create support triage agent",
      createPipelineRequest: request,
      createPipeline: snapshot,
    });
    assert.equal(turn.status, "completed");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "pending");

    const resolved = await runner.resolveCreatePipelineApproval(snapshot.plan.approvalId, {
      decision: "accept",
    });

    assert.equal(resolved.status, "accepted");
    assert.equal(approvals[0].status, "accepted");
    assert.equal(turns[0].createPipeline.state, "applying_source");
    assert.equal(turns[0].createPipeline.plan.status, "approved");
    assert.equal(waitForTurnStarted, false);
    assert.equal(checkInput, null);
    assert.equal(events.some((event) => event.name === "approval.resolved"), true);

    await waitFor(() => waitForTurnStarted, "background local create source application did not start");
    assert.equal(turns[0].createPipeline.state, "applying_source");
    sourceApplyGate.resolve();
    await waitFor(
      () => turns[0]?.createPipeline?.state === "ready_local",
      "background local create source application did not persist ready_local",
    );

    assert.equal(turns[0].providerTurnId, "codex_create_apply_approval");
    assert.equal(codexRuntimeSession.cwd, repoPath);
    assert.equal(codexTurnInput.approvalPolicy, "never");
    assert.equal(codexTurnInput.sandbox, "workspace-write");
    assert.equal(codexStartTurn.cwd, repoPath);
    assert.match(codexStartTurn.prompt, /already-approved OpenPond Create plan/);
    assert.equal(checkInput.target.repoPath, repoPath);
    assert.equal(checkInput.target.sourcePath, sourcePath);
    assert.equal(checkInput.target.workspaceRoot, repoPath);
    assert.equal(turns[0].createPipeline.checkRefs.length, 1);
    assert.notDeepEqual(turns[0].createPipeline.sourceRefs, []);
    assert.equal(events.some((event) => event.output?.includes("Applying approved Create plan with Codex")), true);
    assert.equal(events.some((event) => event.output?.includes("Codex completed approved Create source application")), true);
  });

  test("rejects mutation-state create pipeline turn updates without plan approval", async () => {
    let session = baseSession({
      provider: "openpond",
      appId: null,
      appName: null,
      workspaceKind: undefined,
      workspaceId: null,
      workspaceName: null,
      cwd: null,
    });
    const request = createPipelineRequest();
    const turns = [
      {
        id: "turn_1",
        sessionId: "session_1",
        providerTurnId: null,
        prompt: "/create release notes agent",
        startedAt: "2026-05-16T00:00:00.000Z",
        completedAt: "2026-05-16T00:00:01.000Z",
        status: "completed",
        error: null,
        metadata: {
          createPipelineRequest: request,
          createPipeline: createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
        },
        createPipelineRequest: request,
        createPipeline: createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
      },
    ];
    const events = [];
    const runner = createTurnRunner({
      store: createMemoryStore({ events, turns }),
      upsertApproval: upsertApprovalInto(),
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async () => {
        throw new Error("turn update test should not complete turns");
      },
      failTurn: async () => {
        throw new Error("turn update test should not fail turns");
      },
      interruptTurn: async () => {
        throw new Error("turn update test should not interrupt turns");
      },
      defaultSessionCwd: () => "/tmp/openpond",
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("turn update test should not create runtime");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("turn update test should not run tools");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (candidate) => candidate,
      hostedSystemPrompt: async () => "",
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      turnFollowUpQueue: createImmediateQueue(),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    await assert.rejects(
      () =>
        runner.updateTurnCreatePipeline("session_1", "turn_1", {
          createPipelineRequest: request,
          createPipeline: createPipelineSnapshot(request, "applying_source", "pending_approval"),
        }),
      /requires an approved plan/,
    );
    assert.equal(events.length, 0);
    assert.equal(turns[0].createPipeline.state, "awaiting_plan_approval");

    await assert.rejects(
      () =>
        runner.updateTurnCreatePipeline("session_1", "turn_1", {
          createPipelineRequest: { ...request, id: "create_request_other" },
          createPipeline: createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
        }),
      /snapshot for the submitted request/,
    );
    assert.equal(events.length, 0);

    await assert.rejects(
      () =>
        runner.updateTurnCreatePipeline("session_1", "turn_1", {
          createPipelineRequest: createPipelineRequest("create_request_replacement"),
          createPipeline: createPipelineSnapshot(
            createPipelineRequest("create_request_replacement"),
            "awaiting_plan_approval",
            "pending_approval",
          ),
        }),
      /cannot change the original request/,
    );
    assert.equal(events.length, 0);

    const approved = await runner.updateTurnCreatePipeline("session_1", "turn_1", {
      createPipelineRequest: request,
      createPipeline: createPipelineSnapshot(request, "applying_source", "approved"),
    });
    assertHostedCreateApplyBlocked(approved.createPipeline);
    assert.equal(approved.createPipeline.plan.status, "approved");
    assert.equal(events.some((event) => event.name === "create_pipeline.updated"), true);
  });

  test("applies approved local create pipeline turn updates through Codex", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-local-create-turn-"));
    const repoPath = join(workspace, "profile-repo");
    const sourcePath = join(repoPath, "profiles", "default");
    await mkdir(join(sourcePath, "settings"), { recursive: true });
    let session = baseSession({
      provider: "openpond",
      appId: null,
      appName: null,
      workspaceKind: undefined,
      workspaceId: null,
      workspaceName: null,
      cwd: null,
    });
    const request = createLocalPipelineRequest("create_request_local_update", {
      repoPath,
      sourcePath,
    });
    const turns = [
      {
        id: "turn_1",
        sessionId: "session_1",
        providerTurnId: null,
        prompt: "/create support triage agent",
        startedAt: "2026-05-16T00:00:00.000Z",
        completedAt: "2026-05-16T00:00:01.000Z",
        status: "completed",
        error: null,
        metadata: {
          createPipelineRequest: request,
          createPipeline: createPipelineSnapshot(
            request,
            "awaiting_plan_approval",
            "pending_approval",
          ),
        },
        createPipelineRequest: request,
        createPipeline: createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
      },
    ];
    const events = [];
    let codexRuntimeSession = null;
    let codexTurnInput = null;
    let codexStartTurn = null;
    let checkInput = null;
    const checksGate = deferred();
    const runner = createTurnRunner({
      store: createMemoryStore({ events, turns }),
      upsertApproval: upsertApprovalInto(),
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async () => {
        throw new Error("local create update test should not complete turns");
      },
      failTurn: async () => {
        throw new Error("local create update test should not fail turns");
      },
      interruptTurn: async () => {
        throw new Error("local create update test should not interrupt turns");
      },
      defaultSessionCwd: () => "/tmp/openpond",
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async (candidate, turnInput) => {
        codexRuntimeSession = { ...candidate };
        codexTurnInput = { ...turnInput };
        return {
          client: {
            startTurn: async (params) => {
              codexStartTurn = { ...params };
              return { turnId: "codex_create_apply_1" };
            },
            waitForTurn: async () => undefined,
            interruptTurn: async () => undefined,
          },
          threadId: "codex_thread_1",
          cwd: candidate.cwd,
          permissionMode: turnInput.codexPermissionMode,
          reasoningEffort: turnInput.codexReasoningEffort ?? null,
        };
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("local create update test should not run tools");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (candidate) => candidate,
      hostedSystemPrompt: async () => "",
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      runLocalCreatePipelineChecks: async (input) => {
        checkInput = input;
        await checksGate.promise;
        return {
          checkRefs: ["profiles/default/agents/support-triage/.openpond/agent-inspect.json"],
          metadata: { inspect: { stdout: "ok", stderr: "" } },
        };
      },
      turnFollowUpQueue: createImmediateQueue(),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const updated = await runner.updateTurnCreatePipeline("session_1", "turn_1", {
      createPipelineRequest: request,
      createPipeline: createPipelineSnapshot(request, "applying_source", "approved"),
    });

    assert.equal(updated.createPipeline.state, "applying_source");
    assert.equal(updated.createPipeline.blockedReason, null);
    assert.equal(turns[0].providerTurnId, null);
    assert.equal(turns[0].createPipeline.state, "applying_source");
    assert.equal(checkInput, null);

    await waitFor(() => checkInput, "background local create checks did not start");
    assert.equal(turns[0].createPipeline.state, "running_checks");
    assert.equal(
      events.some(
        (event) =>
          event.name === "create_pipeline.updated" &&
          event.data?.createPipeline?.state === "running_checks",
      ),
      true,
    );
    checksGate.resolve();
    await waitFor(
      () => turns[0]?.createPipeline?.state === "ready_local",
      "background local create update did not persist ready_local",
    );

    assert.equal(turns[0].providerTurnId, "codex_create_apply_1");
    assert.equal(turns[0].createPipeline.state, "ready_local");
    assert.equal(codexRuntimeSession.cwd, repoPath);
    assert.equal(codexTurnInput.approvalPolicy, "never");
    assert.equal(codexTurnInput.sandbox, "workspace-write");
    assert.equal(codexStartTurn.cwd, repoPath);
    assert.match(codexStartTurn.prompt, /already-approved OpenPond Create plan/);
    assert.equal(checkInput.target.repoPath, repoPath);
    assert.equal(checkInput.target.sourcePath, sourcePath);
    assert.equal(checkInput.target.workspaceRoot, repoPath);
    assert.equal(turns[0].createPipeline.checkRefs.length, 1);
    assert.notDeepEqual(turns[0].createPipeline.sourceRefs, []);
    assert.equal(events.some((event) => event.name === "create_pipeline.updated"), true);
    assert.equal(events.some((event) => event.output?.includes("Applying approved Create plan with Codex")), true);
    assert.equal(events.some((event) => event.output?.includes("Codex completed approved Create source application")), true);
  });

  test("recovers approved local create when Codex app-server exits cleanly after writing source", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-local-create-clean-exit-"));
    const repoPath = join(workspace, "profile-repo");
    const sourcePath = join(repoPath, "profiles", "default");
    const agentId = "support-triage";
    await mkdir(join(sourcePath, "settings"), { recursive: true });
    await writeGeneratedSupportSummaryAgent({ repoPath, sourcePath, agentId });
    let session = baseSession({
      provider: "openpond",
      appId: null,
      appName: null,
      workspaceKind: undefined,
      workspaceId: null,
      workspaceName: null,
      cwd: null,
    });
    const request = {
      ...createLocalPipelineRequest("create_request_local_clean_exit", {
        repoPath,
        sourcePath,
      }),
      targetAgent: {
        agentId,
        displayName: "Support Triage",
        defaultActionKey: "chat",
      },
    };
    const turns = [
      {
        id: "turn_1",
        sessionId: "session_1",
        providerTurnId: null,
        prompt: "/create support triage agent",
        startedAt: "2026-05-16T00:00:00.000Z",
        completedAt: "2026-05-16T00:00:01.000Z",
        status: "completed",
        error: null,
        metadata: {
          createPipelineRequest: request,
          createPipeline: createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
        },
        createPipelineRequest: request,
        createPipeline: createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
      },
    ];
    const events = [];
    let checkInput = null;
    const runner = createTurnRunner({
      store: createMemoryStore({ events, turns }),
      upsertApproval: upsertApprovalInto(),
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async () => {
        throw new Error("local create clean-exit test should not complete turns");
      },
      failTurn: async () => {
        throw new Error("local create clean-exit test should not fail turns");
      },
      interruptTurn: async () => {
        throw new Error("local create clean-exit test should not interrupt turns");
      },
      defaultSessionCwd: () => "/tmp/openpond",
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async (candidate, turnInput) => ({
        client: {
          startTurn: async () => ({ turnId: "codex_create_apply_clean_exit" }),
          waitForTurn: async () => {
            throw new Error("codex app-server exited with code 0: clean shutdown after source write");
          },
          interruptTurn: async () => undefined,
        },
        threadId: "codex_thread_clean_exit",
        cwd: candidate.cwd,
        permissionMode: turnInput.codexPermissionMode,
        reasoningEffort: turnInput.codexReasoningEffort ?? null,
      }),
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("local create clean-exit test should not run tools");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (candidate) => candidate,
      hostedSystemPrompt: async () => "",
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      runLocalCreatePipelineChecks: async (input) => {
        checkInput = input;
        return {
          checkRefs: [`profiles/default/agents/${agentId}/.openpond/agent-inspect.json`],
          metadata: { inspect: { stdout: "ok", stderr: "" } },
        };
      },
      turnFollowUpQueue: createImmediateQueue(),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    await runner.updateTurnCreatePipeline("session_1", "turn_1", {
      createPipelineRequest: request,
      createPipeline: createPipelineSnapshot(request, "applying_source", "approved"),
    });

    await waitFor(
      () => turns[0]?.createPipeline?.state === "ready_local",
      "background local create clean-exit recovery did not persist ready_local",
      8000,
    );

    assert.equal(turns[0].providerTurnId, "codex_create_apply_clean_exit");
    assert.equal(turns[0].createPipeline.state, "ready_local");
    assert.equal(checkInput.target.sourceRoot, join(sourcePath, "agents", agentId));
    assert.equal(
      events.some((event) => event.output?.includes("exited cleanly before returning a turn completion")),
      true,
    );
    assert.equal(
      events.some((event) => event.output?.includes("Recovered completed Create source after Codex source application")),
      true,
    );
  });

  test("runs generated local create checks without clobbering default or existing generated source", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-local-create-no-clobber-"));
    const repoPath = join(workspace, "profile-repo");
    const sourcePath = join(repoPath, "profiles", "default");
    const agentId = "support-summary";
    await mkdir(join(sourcePath, "agent"), { recursive: true });
    await mkdir(join(sourcePath, "settings"), { recursive: true });
    await mkdir(join(sourcePath, "agents", "existing-generated", "agent"), { recursive: true });
    await writeFile(
      join(sourcePath, "agent", "agent.ts"),
      "export const existingDefaultSource = 'do-not-clobber-default';\n",
      "utf8",
    );
    await writeFile(
      join(sourcePath, "agents", "existing-generated", "agent", "agent.ts"),
      "export const existingGeneratedSource = 'do-not-clobber-existing-generated';\n",
      "utf8",
    );
    await writeFile(
      join(repoPath, "openpond-profile.json"),
      JSON.stringify(
        {
          schema: "openpond.profileRepo.v1",
          defaultProfile: "default",
          profiles: {
            default: {
              path: "profiles/default",
              defaultAgent: "default",
              enabledAgents: ["default", "existing-generated"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(sourcePath, "settings", "profile.yaml"),
      [
        "schema: openpond.profile.v1",
        "profile: default",
        "agents:",
        "  - id: default",
        "    path: agent/agent.ts",
        "    enabled: true",
        "  - id: existing-generated",
        "    path: agents/existing-generated",
        "    enabled: true",
        "",
      ].join("\n"),
      "utf8",
    );
    const defaultBefore = await readFile(join(sourcePath, "agent", "agent.ts"), "utf8");
    const existingGeneratedBefore = await readFile(
      join(sourcePath, "agents", "existing-generated", "agent", "agent.ts"),
      "utf8",
    );
    let session = baseSession({
      provider: "openpond",
      appId: null,
      appName: null,
      workspaceKind: undefined,
      workspaceId: null,
      workspaceName: null,
      cwd: null,
    });
    const request = {
      ...createLocalPipelineRequest("create_request_local_no_clobber", {
        repoPath,
        sourcePath,
      }),
      targetAgent: {
        agentId,
        displayName: "Support Summary",
        defaultActionKey: "chat",
      },
    };
    const turns = [
      {
        id: "turn_1",
        sessionId: "session_1",
        providerTurnId: null,
        prompt: "/create support summary agent",
        startedAt: "2026-05-16T00:00:00.000Z",
        completedAt: "2026-05-16T00:00:01.000Z",
        status: "completed",
        error: null,
        metadata: {
          createPipelineRequest: request,
          createPipeline: createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
        },
        createPipelineRequest: request,
        createPipeline: createPipelineSnapshot(request, "awaiting_plan_approval", "pending_approval"),
      },
    ];
    const events = [];

    const runner = createTurnRunner({
      store: createMemoryStore({ events, turns }),
      upsertApproval: upsertApprovalInto(),
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async () => {
        throw new Error("local create no-clobber test should not complete turns");
      },
      failTurn: async () => {
        throw new Error("local create no-clobber test should not fail turns");
      },
      interruptTurn: async () => {
        throw new Error("local create no-clobber test should not interrupt turns");
      },
      defaultSessionCwd: () => "/tmp/openpond",
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async (candidate, turnInput) => ({
        client: {
          startTurn: async () => ({ turnId: "codex_create_apply_no_clobber" }),
          waitForTurn: async () => {
            await writeGeneratedSupportSummaryAgent({ repoPath, sourcePath, agentId });
          },
          interruptTurn: async () => undefined,
        },
        threadId: "codex_thread_no_clobber",
        cwd: candidate.cwd,
        permissionMode: turnInput.codexPermissionMode,
        reasoningEffort: turnInput.codexReasoningEffort ?? null,
      }),
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("local create no-clobber test should not run tools");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (candidate) => candidate,
      hostedSystemPrompt: async () => "",
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      turnFollowUpQueue: createImmediateQueue(),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const updated = await runner.updateTurnCreatePipeline("session_1", "turn_1", {
      createPipelineRequest: request,
      createPipeline: createPipelineSnapshot(request, "applying_source", "approved"),
    });

    assert.equal(updated.createPipeline.state, "applying_source");
    await waitFor(
      () => turns[0]?.createPipeline?.state === "ready_local",
      "background local create no-clobber check did not persist ready_local",
      15000,
    );

    const defaultAfter = await readFile(join(sourcePath, "agent", "agent.ts"), "utf8");
    const existingGeneratedAfter = await readFile(
      join(sourcePath, "agents", "existing-generated", "agent", "agent.ts"),
      "utf8",
    );
    const generatedSource = await readFile(join(sourcePath, "agents", agentId, "agent", "agent.ts"), "utf8");
    const rootManifest = JSON.parse(await readFile(join(repoPath, "openpond-profile.json"), "utf8"));
    const profileYaml = await readFile(join(sourcePath, "settings", "profile.yaml"), "utf8");
    const registry = JSON.parse(
      await readFile(join(sourcePath, "agents", agentId, ".openpond", "action-registry.json"), "utf8"),
    );
    const evalResults = JSON.parse(
      await readFile(join(sourcePath, "agents", agentId, ".openpond", "eval-results.json"), "utf8"),
    );

    assert.equal(defaultAfter, defaultBefore);
    assert.equal(existingGeneratedAfter, existingGeneratedBefore);
    assert.match(generatedSource, /support-open-items/);
    assert.deepEqual(rootManifest.profiles.default.enabledAgents, ["default", "existing-generated", agentId]);
    assert.match(profileYaml, /id: existing-generated/);
    assert.match(profileYaml, new RegExp(`id: ${agentId}`));
    assert.equal(registry.actions[0].id, "chat");
    assert.equal(registry.actions[0].timeoutSeconds, 60);
    assert.equal(registry.actions[0].setupRequirements[0].status, "ready");
    assert.equal(evalResults.summary.total, 1);
    assert.equal(evalResults.summary.failed, 0);
    assert.equal(turns[0].providerTurnId, "codex_create_apply_no_clobber");
    assert.equal(turns[0].createPipeline.checkRefs.some((ref) => ref.includes(".openpond/eval-results.json")), true);
    assert.equal(events.some((event) => event.output?.includes("Codex completed approved Create source application")), true);
  });

  test("keeps linked local project Codex turns in the local project checkout", async () => {
    let session = baseSession();
    const turns = [];
    const events = [];
    const resolveCalls = [];
    let codexRuntimeSession = null;
    let codexStartTurn = null;

    const runner = createTurnRunner({
      store: createMemoryStore({ events, turns }),
      upsertApproval: upsertApprovalInto(),
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-05-16T00:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: (appId) => `/default/${appId ?? "none"}`,
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
      turnFollowUpQueue: createImmediateQueue(),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "rename call-mpp-service",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      codexPermissionMode: "default",
    });

    assert.equal(turn.status, "completed");
    assert.equal(session.cwd, "/home/glu/Projects/all/templates-qa/mpp-service-tool");
    assert.equal(codexRuntimeSession.cwd, "/home/glu/Projects/all/templates-qa/mpp-service-tool");
    assert.equal(codexStartTurn.cwd, "/home/glu/Projects/all/templates-qa/mpp-service-tool");
    assert.equal(resolveCalls.length, 2);
    assert.deepEqual(resolveCalls.map((call) => call.options.ensureOpenPond), [false, false]);
  });
});

function createPipelineRequest(id = "create_request_update") {
  const now = "2026-05-16T00:00:00.000Z";
  return {
    schemaVersion: "openpond.createPipeline.request.v1",
    id,
    operation: "create",
    surface: "direct_prompt_create",
    command: "/create",
    objective: "Create release notes agent",
    adapter: {
      kind: "hosted",
      sourceAuthority: "hosted_profile",
      teamId: "team_1",
      projectId: "profile_project_1",
      activeProfile: "default",
      sourceRef: "main",
      baseSha: null,
      workItemId: null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: "sam", kind: "user", label: "Sam" },
    scope: {
      conversationId: "session_1",
      workItemId: null,
      projectId: "profile_project_1",
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: [],
    },
    targetAgent: {
      agentId: null,
      displayName: null,
      defaultActionKey: "chat",
    },
    metadata: { source: "web_composer_slash" },
    createdAt: now,
  };
}

function createLocalPipelineRequest(id = "create_request_local_update", paths = {}) {
  return {
    ...createPipelineRequest(id),
    objective: "Create a support triage agent that summarizes open customer issues",
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: paths.repoPath ?? "/tmp/openpond-profile",
      sourcePath: paths.sourcePath ?? "/tmp/openpond-profile/profiles/default",
      localHead: "local_head",
      confirmationPolicy: "always_require_plan_approval",
    },
    scope: {
      conversationId: "session_1",
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
  };
}

function assertHostedCreateApplyBlocked(snapshot) {
  assert.equal(snapshot.state, "blocked");
  assert.equal(
    snapshot.blockedReason,
    "Approved hosted Create plans from this chat require the Cloud work item background flow. No local source mutation was performed.",
  );
  assert.equal(snapshot.metadata.createPipelineApproval.status, "blocked");
  assert.equal(snapshot.metadata.createPipelineApproval.reason, "hosted_create_pipeline_apply_not_configured");
  assert.equal(snapshot.metadata.createPipelineApproval.adapterKind, "hosted");
  assert.ok(snapshot.metadata.createPipelineApproval.workspaceExecutionTarget);
}

async function writeGeneratedSupportSummaryAgent({ repoPath, sourcePath, agentId }) {
  const sourceRoot = join(sourcePath, "agents", agentId);
  await mkdir(join(sourcePath, "node_modules"), { recursive: true });
  await symlink(join(process.cwd(), "packages", "agent-sdk"), join(sourcePath, "node_modules", "openpond-agent-sdk"), "dir")
    .catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  await mkdir(join(sourceRoot, "agent"), { recursive: true });
  await mkdir(join(sourceRoot, "fixtures"), { recursive: true });
  await mkdir(join(sourceRoot, "artifacts"), { recursive: true });
  await writeFile(
    join(sourceRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "support-summary-agent",
        version: "0.1.0",
        private: true,
        type: "module",
        dependencies: {
          "openpond-agent-sdk": "file:../../node_modules/openpond-agent-sdk",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(sourceRoot, "tsconfig.json"),
    `${JSON.stringify({ extends: "../../../../tsconfig.json", include: ["agent/**/*.ts"] }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(sourceRoot, "agent", "instructions.md"),
    [
      "# Support Summary Agent",
      "",
      "Use the committed support fixture to summarize open customer issues.",
      "This fixture intentionally exists beside a default profile source and another generated agent to prove no clobbering.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(sourceRoot, "fixtures", "support-open-items.json"),
    `${JSON.stringify(
      [
        { customer: "Acme", owner: "Nina", status: "blocked" },
        { customer: "Northwind", owner: "Omar", status: "waiting" },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(sourceRoot, "agent", "agent.ts"),
    [
      'import { mkdir, readFile, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      'import { action, defineAgentProject, defineChannel, defineEval, defineInstructions, defineWorkflow } from "openpond-agent-sdk";',
      "",
      'const summaryArtifact = "artifacts/support-summary.md";',
      "",
      "const supportWorkflow = defineWorkflow({",
      '  name: "support-summary",',
      '  description: "Summarize committed support open-item fixtures.",',
      "  async run(ctx, input) {",
      '    const fixture = JSON.parse(await readFile(path.join(process.cwd(), "fixtures", "support-open-items.json"), "utf8"));',
      '    const blocked = fixture.filter((item) => item.status === "blocked");',
      '    const owners = Array.from(new Set(fixture.map((item) => item.owner))).join(", ");',
      '    const text = ["# Support Open Items", "", `Total items: ${fixture.length}`, `Blocked customers: ${blocked.map((item) => item.customer).join(", ")}`, `Owners: ${owners}`, `Request: ${String(input.prompt ?? "")}`].join("\\n");',
      '    await mkdir(path.join(process.cwd(), "artifacts"), { recursive: true });',
      "    await writeFile(path.join(process.cwd(), summaryArtifact), text + \"\\n\", \"utf8\");",
      '    ctx.trace.event("support.summary.generated", { total: fixture.length, blocked: blocked.length });',
      '    ctx.trace.artifact(summaryArtifact, { kind: "markdown-summary", fixture: "support-open-items" });',
      '    return { text, intent: "support_open_items", artifactRefs: [summaryArtifact], metadata: { fixtureRows: fixture.length, existingSourceNoClobber: true } };',
      "  },",
      "});",
      "",
      "export default defineAgentProject({",
      '  name: "support-summary-agent",',
      '  version: "0.1.0",',
      '  useCase: "support-open-items",',
      '  description: "Fixture-backed support open-items summary agent.",',
      '  manifestMode: "typescript",',
      '  runtime: { base: "node-bun-workspace" },',
      '  instructions: defineInstructions("./agent/instructions.md"),',
      '  defaultAction: "chat",',
      "  actions: [",
      '    action("chat", {',
      '      label: "Chat",',
      '      description: "Summarize support open items from a committed fixture.",',
      '      target: { kind: "workflow", workflow: "support-summary" },',
      "      timeoutSeconds: 60,",
      '      inputSchema: "support.summary.input.v1",',
      '      outputSchema: "support.summary.output.v1",',
      "      outputArtifacts: [summaryArtifact],",
      '      approval: { mode: "never", reason: "Fixture-only local summary." },',
      "      setup: [",
      '        { kind: "channel", name: "openpond_chat", required: true, status: "ready", satisfied: true, description: "Built-in local chat channel." },',
      "      ],",
      "    }),",
      "  ],",
      "  workflows: [supportWorkflow],",
      "  channels: [",
      "    defineChannel({",
      '      id: "openpond_chat",',
      '      target: { action: "chat" },',
      '      normalizeEvent: (event) => ({ prompt: String(event.prompt ?? ""), channel: "openpond_chat" }),',
      "      renderResponse: (result) => ({ text: result.text }),",
      "    }),",
      "  ],",
      "  evals: [",
      "    defineEval({",
      '      name: "support-open-items-fixture",',
      '      description: "Summarizes the support fixture and writes the declared artifact.",',
      '      fixtures: ["fixtures/support-open-items.json"],',
      "      expectedArtifacts: [summaryArtifact],",
      "      publishGate: true,",
      "      async run(t) {",
      '        await t.send({ prompt: "what are open items?", channel: "openpond_chat" });',
      '        t.expectIntent("support_open_items");',
      '        t.expectTextIncludes("Blocked customers: Acme");',
      "        t.expectArtifact(summaryArtifact);",
      "      },",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoPath, "openpond-profile.json"),
    `${JSON.stringify(
      {
        schema: "openpond.profileRepo.v1",
        defaultProfile: "default",
        profiles: {
          default: {
            path: "profiles/default",
            defaultAgent: agentId,
            enabledAgents: ["default", "existing-generated", agentId],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(sourcePath, "settings", "profile.yaml"),
    [
      "schema: openpond.profile.v1",
      "profile: default",
      "agents:",
      "  - id: default",
      "    path: agent/agent.ts",
      "    enabled: true",
      "  - id: existing-generated",
      "    path: agents/existing-generated",
      "    enabled: true",
      `  - id: ${agentId}`,
      `    path: agents/${agentId}`,
      "    enabled: true",
      "",
    ].join("\n"),
    "utf8",
  );
}

function createPipelineSnapshot(request, state, planStatus) {
  const now = "2026-05-16T00:00:00.000Z";
  const approvalId = "approval_create_plan";
  return {
    schemaVersion: "openpond.createPipeline.snapshot.v1",
    id: "create_pipeline_update",
    goalId: request.id,
    state,
    request,
    plan: {
      schemaVersion: "openpond.createPipeline.plan.v1",
      id: "create_plan_update",
      goalId: request.id,
      requestId: request.id,
      status: planStatus,
      objective: request.objective,
      summary: "Create a source-backed profile agent.",
      capturedContextSummary: "Direct prompt create.",
      defaultChatAction: {
        key: "chat",
        label: "Chat",
        required: true,
      },
      sourcePlan: [],
      requirements: [],
      checks: [],
      approvalId,
      approvedAt: planStatus === "approved" ? now : null,
      editedFromPlanId: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
    workflowCapture: null,
    approvalIds: [approvalId],
    questionIds: [],
    checkRefs: [],
    sourceRefs: [],
    localGoalId: null,
    localProfileCommit: null,
    hostedGoalId: null,
    hostedSourceCommit: null,
    hostedSourceRef: "main",
    blockedReason: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
