import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { TaskSignals } from "@openpond/agent-runtime";
import { SessionSchema, SubagentRunSchema, TaskWaitSchema, TurnSchema, type TaskInputAdmission } from "@openpond/contracts";
import { SqliteStore } from "../apps/server/src/store/store";
import { createTaskInboxRuntime } from "../apps/server/src/runtime/task-inbox/runtime";
import { createTaskCoordinationMcp } from "../apps/server/src/runtime/task-inbox/codex-mcp";

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
