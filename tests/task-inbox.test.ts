import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { TaskSignals } from "@openpond/agent-runtime";
import { SessionSchema, SubagentRunSchema, TaskWaitSchema, TurnSchema, type TaskInputAdmission } from "@openpond/contracts";
import { SqliteStore } from "../apps/server/src/store/store";
import { createTaskInboxRuntime } from "../apps/server/src/runtime/task-inbox/runtime";
import { createTaskCoordinationMcp } from "../apps/server/src/runtime/task-inbox/codex-mcp";
import { createLocalManagedMessaging } from "../apps/server/src/runtime/task-inbox/local-managed-messaging";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createHttpRequestHandler, type HttpRouteDeps } from "../apps/server/src/api/http-routes";

import { createSubagentCompletionRuntime } from "../apps/server/src/runtime/subagents/completion-runtime";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-inbox-"));
  let store = new SqliteStore(home);
  cleanup.push(async () => { await store.close(); await rm(home, { recursive: true, force: true }); });
  for (const id of ["a", "b", "outsider"]) await store.insertSessionAtFront(SessionSchema.parse({
    id, title: id, provider: "openrouter", experience: "development", appId: null, appName: null,
    localProjectId: id === "outsider" ? "other" : "project", cwd: null, codexThreadId: null,
    createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", status: "idle", pinned: false, archived: false, order: 0,
  }));
  const turn = TurnSchema.parse({ id: "turn-a", sessionId: "a", providerTurnId: null, prompt: "Original assignment",
    startedAt: "2026-09-20T00:00:00Z", completedAt: null, status: "in_progress", error: null });
  await store.insertTurn(turn);
  return { get store() { return store; }, turn, async reopen() { await store.close(); store = new SqliteStore(home); } };
}

function input(overrides: Partial<TaskInputAdmission> = {}): TaskInputAdmission {
  return { id: "input-1", sessionId: "a", senderSessionId: null, senderKind: "user", kind: "steer",
    body: "Preserve the API", payload: {}, idempotencyKey: "intent-1", replyTo: null, expectedTurnId: "turn-a", ...overrides };
}

// Failure story: a remote/unauthenticated request bypasses desktop Send, or an
// ambiguous HTTP retry duplicates a persisted message after a runtime restart.
test("desktop message HTTP admission enforces local authority and durable retry identity", async () => {
  const f = await fixture();
  await f.store.updateSession("a", session => ({ ...session, provider: "claude-code", cwd: "/tmp/owned-http-message",
    nativeAgent: { provider: "claude-code", instanceId: "installation", sessionId: "original-session", cwd: "/tmp/owned-http-message" } }));
  const messaging = () => createLocalManagedMessaging({ store: f.store,
    getSession: async id => (await f.store.getSession(id))!, latestTurn: id => f.store.latestTurnForSession(id),
    readiness: async () => ({ available: true, canSteer: false, reason: null }), approvalBlocked: async () => true,
    admit: admission => f.store.admitTaskInput(admission) });
  const deps = { host: "127.0.0.1", getActualPort: () => (server.address() as AddressInfo).port,
    token: "desktop-message-test", version: "test", runtimeVersion: "test", logger: { info() {}, warn() {}, error() {} },
    subscribers: new Set<ServerResponse>(), localManagedMessaging: messaging() } as unknown as HttpRouteDeps;
  const server = createServer(createHttpRequestHandler(deps));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sessions/a`;
  const headers = { authorization: "Bearer desktop-message-test", "content-type": "application/json", origin: "http://127.0.0.1:17876" };
  try {
    expect((await fetch(`${url}/local-message-target`)).status).toBe(401);
    expect((await fetch(`${url}/local-message-target`, { headers: { ...headers, "x-forwarded-for": "203.0.113.5" } })).status).toBe(403);
    expect((await fetch(`${url}/local-message-target`, { headers: { ...headers, origin: "https://remote.example" } })).status).toBe(403);
    expect(await f.store.taskInputsForSession("a")).toHaveLength(0);
    const observed = await (await fetch(`${url}/local-message-target`, { headers })).json() as { targetRevision: string };
    const body = { authority: "user_click", mode: "followup", prompt: "Reviewed edited task message",
      expectedTargetRevision: observed.targetRevision, idempotencyKey: "http-reviewed-click" };
    const send = (value: unknown) => fetch(`${url}/local-messages`, { method: "POST", headers, body: JSON.stringify(value) });
    const admitted = await send(body); expect(admitted.status).toBe(202);
    const receipt = await admitted.json() as { id: string; state: string; body: string };
    expect(receipt).toMatchObject({ state: "pending", body: body.prompt });
    await f.reopen(); deps.localManagedMessaging = messaging();
    await f.store.updateSession("a", session => ({ ...session, nativeAgent: { ...session.nativeAgent!, sessionId: "changed-session" } }));
    const retry = await send(body); expect(retry.status).toBe(202);
    expect((await retry.json() as { id: string }).id).toBe(receipt.id);
    expect((await send({ ...body, idempotencyKey: "new-stale-click" })).status).toBe(409);
    expect((await send({ ...body, prompt: "Changed after delivery" })).status).toBe(409);
    expect((await send({ ...body, authority: "model_decision" })).status).toBe(422);
    expect(await f.store.taskInputsForSession("a")).toHaveLength(1);
  } finally { server.close(); await once(server, "close"); }
});

// Failure story: a recommendation targets another native session after refresh,
// retries launch duplicate work after restart, or Send silently resumes paused work.
test("local Send binds the original managed target and preserves paused, approval and retry boundaries", async () => {
  const f = await fixture();
  await f.store.updateSession("a", (session) => ({ ...session, provider: "claude-code", cwd: "/tmp/owned-message-test",
    nativeAgent: { provider: "claude-code", instanceId: "owned-installation", sessionId: "owned-vendor-session", cwd: "/tmp/owned-message-test" } }));
  let available = true, approvalBlocked = true;
  const service = createLocalManagedMessaging({
    store: f.store, getSession: async (id) => (await f.store.getSession(id))!, latestTurn: (id) => f.store.latestTurnForSession(id),
    readiness: async () => ({ available, reason: available ? null : "Agent disabled", canSteer: false }),
    approvalBlocked: async () => approvalBlocked, admit: (admission) => f.store.admitTaskInput(admission),
  });
  await f.store.openTaskInboxTurn("a", "turn-a", "owner");
  const observed = await service.inspect("a");
  expect(observed).toMatchObject({ managedSessionId: "owned-vendor-session", approvalBlocked: true, canSendFollowup: true, canSteer: false });
  const intent = { authority: "user_click", mode: "followup", prompt: "Reviewed edited instruction", expectedTargetRevision: observed.targetRevision,
    idempotencyKey: "reviewed-click", recommendationId: "recommendation-test" };
  const [first, retry] = await Promise.all([service.send("a", intent), service.send("a", intent)]);
  expect(retry.id).toBe(first.id);
  expect(first).toMatchObject({ state: "pending", turnId: null, kind: "queued" });
  expect(await f.store.pendingTaskInputs("a", "turn-a")).toEqual([]);
  await expect(service.send("a", { ...intent, prompt: "Changed text" })).rejects.toThrow("different content");
  await expect(service.send("a", { ...intent, mode: "steer", expectedTurnId: "turn-a", idempotencyKey: "unsupported-steer" })).rejects.toThrow("no longer accepting");
  await f.store.closeTaskInboxTurn("a", "turn-a", "owner", "interrupted");
  approvalBlocked = false;
  expect((await service.inspect("a")).paused).toBe(true);
  expect(await f.store.reserveTaskFollowup("a", "unauthorized-resume", "owner")).toBeNull();
  await f.reopen();
  const recovered = createLocalManagedMessaging({ store: f.store, getSession: async (id) => (await f.store.getSession(id))!,
    latestTurn: (id) => f.store.latestTurnForSession(id), readiness: async () => ({ available, reason: "Agent disabled", canSteer: false }),
    approvalBlocked: async () => false, admit: (admission) => f.store.admitTaskInput(admission) });
  await f.store.updateSession("a", (session) => ({ ...session, nativeAgent: { ...session.nativeAgent!, sessionId: "other-vendor-session" } }));
  expect((await recovered.send("a", intent)).id).toBe(first.id);
  await expect(recovered.send("a", { ...intent, idempotencyKey: "new-click" })).rejects.toThrow("target changed");
  available = false;
  const unavailable = await recovered.inspect("a");
  expect(unavailable).toMatchObject({ canSendFollowup: false, unavailableReason: "Agent disabled" });
  await expect(recovered.send("a", { ...intent, expectedTargetRevision: unavailable.targetRevision, idempotencyKey: "disabled-click" })).rejects.toThrow("disabled");
  expect((await recovered.inspect("outsider")).canSendFollowup).toBe(false);
  available = true;
  await f.store.updateSession("a", (session) => ({ ...session, metadata: { nativeHistoryProjection: true, nativeResumeAvailable: true } }));
  const imported = await recovered.inspect("a");
  expect(imported).toMatchObject({ canSendFollowup: false });
  await expect(recovered.send("a", { ...intent, expectedTargetRevision: imported.targetRevision, idempotencyKey: "imported-click" })).rejects.toThrow("imported");
  await f.store.updateSession("a", (session) => ({ ...session, metadata: { nativeHistoryProjection: false } }));
  const raced = createLocalManagedMessaging({ store: f.store, getSession: async (id) => (await f.store.getSession(id))!,
    latestTurn: (id) => f.store.latestTurnForSession(id), readiness: async () => ({ available: true, reason: null, canSteer: false }),
    approvalBlocked: async () => false, admit: async (admission) => {
      await f.store.updateSession("a", (session) => ({ ...session, nativeAgent: { ...session.nativeAgent!, sessionId: "changed-during-admission" } }));
      return f.store.admitTaskInput(admission);
    } });
  const beforeRace = await raced.inspect("a");
  await expect(raced.send("a", { ...intent, expectedTargetRevision: beforeRace.targetRevision, idempotencyKey: "raced-click" })).rejects.toThrow("before message admission");
  expect(await f.store.taskInputsForSession("a")).toHaveLength(1);
});

// Failure story: a correction accepted during finalization is lost, replayed twice, or attached to a different assignment.
test("durable admission, inclusion, replacement and sealing agree on one turn", async () => {
  const f = await fixture();
  await f.store.openTaskInboxTurn("a", "turn-a", "owner");
  const [receipt, duplicate] = await Promise.all([f.store.admitTaskInput(input()), f.store.admitTaskInput(input({ id: "retry-id" }))]);
  expect(duplicate.id).toBe(receipt.id);
  await expect(f.store.admitTaskInput(input({ body: "Different intent" }))).rejects.toThrow("different content");
  expect(await f.store.sealTaskInboxTurn("a", "turn-a", "owner")).toBe(false);
  expect((await f.store.includeTaskInputs("a", "turn-a", "owner", "request-1")).map((row) => row.id)).toEqual([receipt.id]);
  await f.store.settleTaskInputRequest("request-1", "replaced");
  expect((await f.store.includeTaskInputs("a", "turn-a", "owner", "request-2"))[0]?.requestIds).toEqual(["request-1", "request-2"]);
  await f.store.settleTaskInputRequest("request-2", "resolved");
  expect(await f.store.sealTaskInboxTurn("a", "turn-a", "owner")).toBe(true);
  await expect(f.store.admitTaskInput(input({ id: "late", idempotencyKey: "late" }))).rejects.toThrow("no longer accepting");
  await f.reopen();
  expect(await f.store.getTaskInput(receipt.id)).toMatchObject({ state: "resolved", turnId: "turn-a", requestIds: ["request-1", "request-2"] });
});

// Failure story: partial broadcast or a raced promotion starts the same queued instruction twice.
test("broadcast admission rolls back and queue edits/promotions use revisions", async () => {
  const f = await fixture();
  await expect(f.store.admitTaskInputs([
    input({ kind: "message", expectedTurnId: null }), input({ id: "missing", sessionId: "missing", kind: "message", expectedTurnId: null }),
  ])).rejects.toThrow("unavailable");
  expect(await f.store.taskInputsForSession("a")).toEqual([]);
  const queued = await f.store.admitTaskInput(input({ kind: "queued", expectedTurnId: null }));
  const edited = await f.store.mutateTaskInput("a", queued.id, { action: "edit", expectedRevision: 1, body: "Newest instruction" });
  await expect(f.store.mutateTaskInput("a", queued.id, { action: "cancel", expectedRevision: 1 })).rejects.toThrow("changed");
  await f.store.openTaskInboxTurn("a", "turn-a", "owner");
  expect(await f.store.mutateTaskInput("a", queued.id, { action: "steer", expectedRevision: edited.revision, expectedTurnId: "turn-a" })).toMatchObject({ kind: "steer", turnId: "turn-a" });
  await f.store.includeTaskInputs("a", "turn-a", "owner", "request");
  await f.store.closeTaskInboxTurn("a", "turn-a", "owner", "completed");
  expect(await f.store.reserveTaskFollowup("a", "another-turn", "owner")).toBeNull();
});

// Failure story: a restart retries an uncertain action or drops an unstarted queued reservation.
test("owner recovery preserves uncertain inclusion and reclaims only unstarted reservations", async () => {
  const f = await fixture();
  await f.store.openTaskInboxTurn("a", "turn-a", "old-owner");
  await f.store.admitTaskInput(input());
  await f.store.includeTaskInputs("a", "turn-a", "old-owner", "uncertain-request");
  await f.store.admitTaskInput(input({ id: "queue-b", sessionId: "b", kind: "queued", expectedTurnId: null }));
  await f.store.reserveTaskFollowup("b", "unstarted-turn", "old-owner");
  await f.reopen();
  expect(await f.store.recoverTaskInboxOwners("new-owner")).toHaveLength(2);
  expect(await f.store.getTaskInput("input-1")).toMatchObject({ state: "included", error: expect.stringContaining("uncertain") });
  expect(await f.store.taskInboxPaused("a")).toBe(true);
  expect(await f.store.reserveTaskFollowup("b", "replacement-turn", "new-owner")).toMatchObject({ id: "queue-b", turnId: "replacement-turn" });
  await expect(f.store.renewTaskInboxTurn("a", "turn-a", "old-owner")).rejects.toThrow("ownership was lost");
});

// Failure story: cross-project data leaks, dependency cycles deadlock, or an earlier execution satisfies a new-work wait.
test("authorization, cycle prevention and generation-specific event waits share durable state", async () => {
  const f = await fixture();
  const runtime = createTaskInboxRuntime({ store: f.store,
    getSession: async (id) => { const session = await f.store.getSession(id); if (!session) throw new Error("missing"); return session; },
    listSessions: () => f.store.sessionShells(), getTurn: (id) => f.store.getTurn(id), latestTurn: (id) => f.store.latestTurnForSession(id),
    getSubagentRun: async () => null, getActiveTurn: () => undefined, recoverInterruptedTurn: async () => {},
    startFollowup: vi.fn(), dispatchFollowup: async () => {}, yieldWhileWaiting: (work) => work(), appendRuntimeEvent: async () => {},
  });
  cleanup.push(runtime.close);
  await expect(runtime.send({ senderSessionId: "outsider", sessionId: "a", body: "secret", idempotencyKey: "denied" })).rejects.toThrow("authorized project");
  await f.store.insertTurn({ ...f.turn, id: "old-b", sessionId: "b", status: "completed" });
  const receipt = await runtime.send({ senderSessionId: "a", sessionId: "b", body: "New work", kind: "followup", idempotencyKey: "new" });
  const waiting = runtime.wait({ sessionId: "a", turnId: "turn-a", callId: "wait-new", targetSessionId: "b", targetInputId: receipt.id, signal: new AbortController().signal });
  await vi.waitFor(async () => expect(await f.store.taskWaitsForSession("a")).toHaveLength(1));
  await expect(f.store.createTaskWait(TaskWaitSchema.parse({ id: "cycle", sessionId: "b", turnId: "new-b", targetSessionId: "a", targetTurnId: "turn-a", afterSequence: 0,
    deadline: new Date(Date.now() + 10_000).toISOString(), state: "waiting", createdAt: "now", updatedAt: "now" }))).rejects.toThrow("cycle");
  await f.store.reserveTaskFollowup("b", "new-b", runtime.ownerId);
  await f.store.insertTurn({ ...f.turn, id: "new-b", sessionId: "b", status: "completed" });
  runtime.signals.notify("b");
  expect(await waiting).toMatchObject({ state: "completed", targetInputId: receipt.id });
  await f.store.openTaskInboxTurn("a", "turn-a", runtime.ownerId);
  const pending = await runtime.send({ senderSessionId: "b", sessionId: "a", body: "Previously authorized update", idempotencyKey: "access-change" });
  await f.store.updateSession("b", (session) => ({ ...session, localProjectId: "other" }));
  expect(await runtime.include("a", "turn-a", "after-access-change")).toEqual([]);
  expect(await f.store.getTaskInput(pending.id)).toMatchObject({ state: "rejected" });
});

// Failure story: arrival between a condition read and sleeping is missed indefinitely.
test("signals cannot lose a wake during an asynchronous condition read", async () => {
  const signals = new TaskSignals();
  let delivered = false;
  let reads = 0;
  expect(await signals.wait({ taskIds: ["a"], signal: new AbortController().signal, deadline: Date.now() + 1000,
    read: async () => { reads++; if (delivered) return "received"; delivered = true; signals.notify("a"); return null; },
  })).toBe("received");
  expect(reads).toBe(2);
});

// Failure story: a browser or uncredentialed local client invokes another task's model tools.
test("Codex MCP binds tool execution to the session endpoint and rejects untrusted callers", async () => {
  const execute = vi.fn(async () => "saved");
  const mcp = await createTaskCoordinationMcp({ tools: [{ name: "send", description: "send", inputSchema: { type: "object" } }], execute });
  cleanup.push(mcp.close);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send", arguments: { message: "update" } } });
  expect((await fetch(mcp.config.url, { method: "POST", body })).status).toBe(403);
  expect((await fetch(mcp.config.url, { method: "POST", headers: { ...mcp.config.http_headers, Origin: "https://untrusted.example" }, body })).status).toBe(403);
  const response = await fetch(mcp.config.url, { method: "POST", headers: mcp.config.http_headers, body });
  expect(await response.json()).toMatchObject({ result: { content: [{ text: "saved" }] } });
  expect(execute).toHaveBeenCalledTimes(1);
});

// Failure story: a crash after inbox admission loses a child result or delivers it twice on restart.
test("completion outbox survives a delivery crash and settles one passive receipt after reopen", async () => {
  const f = await fixture();
  const run = SubagentRunSchema.parse({ id: "child-run", parentSessionId: "a", parentTurnId: "turn-a", childSessionId: "b",
    roleId: "research", objective: "Inspect", modelRef: { providerId: "openrouter", modelId: "test/model" },
    isolationMode: "none", toolPolicy: "read_only", background: true, peerMessages: "parent_scoped", status: "completed",
    required: true, report: { summary: "Durable child result" }, createdAt: "2026-09-20T00:00:00Z", completedAt: "2026-09-20T00:00:01Z" });
  await f.store.commitSubagentCompletion(run, "child-turn");
  let failReceiptWrite = true;
  const build = () => {
    const store = f.store;
    const getSession = async (id: string) => { const session = await store.getSession(id); if (!session) throw new Error("missing"); return session; };
    const startFollowup = vi.fn();
    const inbox = createTaskInboxRuntime({ store, getSession, listSessions: () => store.sessionShells(),
      getTurn: (id) => store.getTurn(id), latestTurn: (id) => store.latestTurnForSession(id),
      getSubagentRun: async () => null, getActiveTurn: () => undefined, recoverInterruptedTurn: async () => {},
      startFollowup, dispatchFollowup: async () => {}, yieldWhileWaiting: (work) => work(), appendRuntimeEvent: async () => {} });
    const completion = createSubagentCompletionRuntime({ inbox, store, getSession,
      appendMessage: async () => { if (failReceiptWrite) throw new Error("crash after admission"); }, appendRuntimeEvent: async () => {} });
    return { inbox, completion, startFollowup };
  };
  const first = build();
  expect(await first.completion.recoverPendingCompletions()).toBe(0);
  expect(await f.store.pendingTaskCompletions()).toHaveLength(1);
  const accepted = await f.store.taskInputsForSession("a");
  expect(accepted).toHaveLength(1);
  await first.completion.close(); await first.inbox.close();
  await f.reopen();
  failReceiptWrite = false;
  const second = build();
  cleanup.push(second.inbox.close, second.completion.close);
  expect(await second.completion.recoverPendingCompletions()).toBe(1);
  expect(await second.completion.recoverPendingCompletions()).toBe(0);
  expect(await f.store.pendingTaskCompletions()).toHaveLength(0);
  expect(await f.store.taskInputsForSession("a")).toEqual(accepted);
  expect(second.startFollowup).not.toHaveBeenCalled();
});

// Failure story: an explicit next assignment is consumed by the active request and never gets its own turn.
test("peer follow-up remains queued until the current assignment completes", async () => {
  const f = await fixture();
  await f.store.openTaskInboxTurn("a", "turn-a", "owner");
  const receipt = await f.store.admitTaskInput(input({ kind: "followup", senderKind: "task", senderSessionId: "b", expectedTurnId: null }));
  expect(receipt.turnId).toBeNull();
  expect(await f.store.includeTaskInputs("a", "turn-a", "owner", "current-request")).toEqual([]);
  expect(await f.store.reserveTaskFollowup("a", "future-turn", "owner")).toBeNull();
  await f.store.closeTaskInboxTurn("a", "turn-a", "owner", "completed");
  expect(await f.store.reserveTaskFollowup("a", "future-turn", "owner")).toMatchObject({ id: receipt.id, turnId: "future-turn" });
  expect(await f.store.includeTaskInputs("a", "future-turn", "owner", "future-request")).toEqual([expect.objectContaining({ id: receipt.id })]);
});

// Failure story: native active steering slips through input promotion, or a late
// message is lost while a completed native request is sealed for the next turn.
test("native requests reject steering through both entry points and preserve late messages across restart", async () => {
  const f = await fixture();
  await f.store.updateSession("a", (session) => ({ ...session, provider: "opencode" }));
  const runtime = createTaskInboxRuntime({ store: f.store,
    getSession: async (id) => { const session = await f.store.getSession(id); if (!session) throw new Error("missing"); return session; },
    listSessions: () => f.store.sessionShells(), getTurn: (id) => f.store.getTurn(id), latestTurn: (id) => f.store.latestTurnForSession(id),
    getSubagentRun: async () => null, getActiveTurn: () => undefined, recoverInterruptedTurn: async () => {},
    startFollowup: vi.fn(), dispatchFollowup: async () => {}, yieldWhileWaiting: (work) => work(), appendRuntimeEvent: async () => {},
  });
  await f.store.openTaskInboxTurn("a", "turn-a", runtime.ownerId);
  await expect(runtime.steer("a", { prompt: "Do not interrupt", expectedTurnId: "turn-a", idempotencyKey: "steer" })).rejects.toThrow("Queue");
  const queued = await f.store.admitTaskInput(input({ kind: "queued", expectedTurnId: null }));
  await expect(runtime.mutate("a", queued.id, { action: "steer", expectedRevision: queued.revision, expectedTurnId: "turn-a" })).rejects.toThrow("queued");
  expect(await f.store.getTaskInput(queued.id)).toMatchObject({ kind: "queued", state: "pending", turnId: null });
  const included = await f.store.admitTaskInput(input({ id: "before-dispatch", kind: "message", idempotencyKey: "before", expectedTurnId: null }));
  expect(await runtime.include("a", "turn-a", "native-request")).toEqual([expect.objectContaining({ id: included.id, state: "included" })]);
  await f.store.settleTaskInputRequest("native-request", "resolved");
  const late = await f.store.admitTaskInput(input({ id: "late-peer", kind: "message", idempotencyKey: "late", expectedTurnId: null }));
  const stale = await f.store.admitTaskInput(input({ id: "stale-steer", idempotencyKey: "stale" }));
  await runtime.finishNative("a", "turn-a");
  expect(await f.store.getTaskInput(late.id)).toMatchObject({ state: "pending", turnId: null });
  expect(await f.store.getTaskInput(stale.id)).toMatchObject({ state: "rejected" });
  await f.store.closeTaskInboxTurn("a", "turn-a", runtime.ownerId, "completed");
  await runtime.close();
  await f.reopen();
  expect(await f.store.getTaskInput(included.id)).toMatchObject({ state: "resolved", requestIds: ["native-request"] });
  const next = await f.store.reserveTaskFollowup("a", "next-turn", "next-owner");
  expect(next).toMatchObject({ id: queued.id });
  const nextInputs = await f.store.includeTaskInputs("a", "next-turn", "next-owner", "next-request");
  expect(nextInputs.map((row) => row.id)).toEqual([queued.id, late.id]);
  await f.store.settleTaskInputRequest("next-request", "failed");
  await f.store.closeTaskInboxTurn("a", "next-turn", "next-owner", "failed");
  await f.reopen();
  expect(await f.store.getTaskInput(late.id)).toMatchObject({ state: "included", error: expect.stringContaining("failed") });
  expect(await f.store.taskInboxPaused("a")).toBe(true);
  expect(await f.store.reserveTaskFollowup("a", "no-replay", "restarted-owner")).toBeNull();
});
