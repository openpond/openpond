import { expect, test, vi } from "vitest";
import type { TaskInput, Turn, Session } from "@openpond/contracts";
import { createSessionCodexRecovery } from "../apps/server/src/api/session-codex-recovery";
import {
  retainCodexRecoveryInput,
  CodexOwnershipError,
} from "../apps/server/src/runtime/codex-ownership";
import {
  createTurnRunnerTestHarness,
  turnRunnerTestSession,
} from "./helpers/turn-runner-test-harness";
import { codexThreadUrl } from "../apps/desktop/src/desktop-codex-thread";

// Failure story: a rejected native resume loses the original permissions or
// creates a duplicate queued message on every attempt, making recovery unsafe.
test("a writer rejection durably retains the exact request once and never starts a native turn", async () => {
  const session = turnRunnerTestSession({
    provider: "codex",
    modelRef: { providerId: "codex", modelId: "gpt-6.1-sol" },
    experience: "work",
    cwd: "/tmp/openpond",
    workspaceKind: "local_project",
    workspaceId: "test-project",
    codexThreadId: "busy-thread",
  });
  const ensure = vi.fn(async () => {
    throw new CodexOwnershipError("busy-thread", new Error("active writer"));
  });
  const harness = createTurnRunnerTestHarness({
    sessions: [session],
    dependencies: { ensureCodexRuntime: ensure },
  });
  try {
    const request = {
      prompt: "Review the current plan",
      modelRef: session.modelRef!,
      approvalPolicy: "never" as const,
      sandbox: "read-only" as const,
      codexPermissionMode: "default" as const,
      codexReasoningEffort: "high" as const,
      metadata: { contextNote: "Preserve this request context" },
    };
    const failed = await harness.runner.sendTurn(session.id, request);
    expect(failed.status).toBe("failed");
    expect(failed.providerTurnId).toBeNull();
    let snapshot = await harness.runner.readTaskInbox(session.id);
    expect(snapshot.paused).toBe(true);
    expect(snapshot.inputs).toHaveLength(1);
    expect(snapshot.inputs[0]).toMatchObject({
      state: "pending",
      turnId: null,
      body: request.prompt,
      payload: request,
    });
    const marker = failed.metadata.codexRecovery as { inputId: string; revision: number };
    expect(marker).toMatchObject({
      inputId: snapshot.inputs[0]!.id,
      revision: snapshot.inputs[0]!.revision,
    });
    expect(
      harness.state.events.some(
        (event) =>
          event.turnId === failed.id &&
          (event.data as { kind?: string })?.kind === "codex_ownership_recovery",
      ),
    ).toBe(true);
    await harness.runner.updateTaskInput(session.id, marker.inputId, {
      action: "resume",
      expectedRevision: marker.revision,
    });
    await harness.dependencies.turnFollowUpQueue.drain();
    snapshot = await harness.runner.readTaskInbox(session.id);
    expect(snapshot.inputs).toHaveLength(1);
    expect(snapshot.inputs[0]!.state).toBe("pending");
    expect(ensure).toHaveBeenCalledTimes(2);
  } finally {
    await harness.runner.close();
  }
});

function recoveryFixture() {
  const session = {
    id: "session",
    provider: "codex",
    codexThreadId: "native",
    status: "failed",
    cwd: "/workspace",
  } as Session;
  const failed = {
    id: "failed",
    sessionId: session.id,
    status: "failed",
    providerTurnId: null,
    prompt: "Saved request",
    metadata: { codexRecovery: { inputId: "input", revision: 1 } },
  } as Turn;
  let input = {
    id: "input",
    sessionId: session.id,
    senderKind: "user",
    kind: "queued",
    state: "pending",
    turnId: null,
    revision: 1,
    body: failed.prompt,
    payload: { prompt: failed.prompt, attachments: [{ name: "evidence.txt" }] },
  } as TaskInput;
  let active: string | null = null;
  let latest = failed;
  let external = true;
  const resumeThread = vi.fn(async () => {
    if (external) throw new Error("thread native already has an active writer");
    return { threadId: "native", response: {} };
  });
  const stop = vi.fn(async () => {});
  const unarchiveThread = vi.fn(async () => {});
  const interrupt = vi.fn(async (_session: string, expected: string) => {
    if (active !== expected) throw new Error("The expected turn is no longer active.");
    active = null;
  });
  const resume = vi.fn(async (_session: string, receipt: TaskInput) => {
    input = { ...receipt, revision: receipt.revision + 1 };
  });
  const deps = {
    getSession: async () => session,
    getTurn: async () => failed,
    latestTurn: async () => failed,
    getInput: async () => input,
    activeTurnId: async () => active,
    ownsWriter: () => false,
    interrupt,
    waitForSettlement: vi.fn(async () => {}),
    resume,
    append: vi.fn(async () => {}),
    createClient: () => ({ resumeThread, unarchiveThread, stop }),
    isArchived: async () => false,
  };
  deps.latestTurn = async () => latest;
  return {
    deps,
    session,
    failed,
    resume,
    resumeThread,
    unarchiveThread,
    stop,
    interrupt,
    setExternal: (value: boolean) => {
      external = value;
    },
    setActive: (value: string | null) => {
      active = value;
      if (value) latest = { ...failed, id: value };
    },
    advance: () => {
      latest = { ...failed, id: "newer-completed-turn", status: "completed" };
    },
    edit: () => {
      input = { ...input, body: "Edited request", revision: 2 };
    },
  };
}

// Failure story: recovery must not force-release a foreign writer, dispatch a
// request twice on a double click, or replay a message edited during the check.
test("foreign ownership, concurrent retries and edits preserve the saved input boundary", async () => {
  const f = recoveryFixture();
  const recover = createSessionCodexRecovery(f.deps);
  expect(await recover("session", { failedTurnId: "failed" })).toEqual({
    state: "external",
    threadId: "native",
  });
  expect(f.resume).not.toHaveBeenCalled();
  expect(f.interrupt).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
  f.setExternal(false);
  const results = await Promise.all([
    recover("session", { failedTurnId: "failed" }),
    recover("session", { failedTurnId: "failed" }),
  ]);
  expect(results).toEqual([{ state: "resumed" }, { state: "resumed" }]);
  expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.resume.mock.calls[0]?.[1].payload).toMatchObject({
    attachments: [{ name: "evidence.txt" }],
  });
  expect(await recover("session", { failedTurnId: "failed" })).toEqual({ state: "superseded" });
  const edited = recoveryFixture();
  edited.setExternal(false);
  edited.resumeThread.mockImplementationOnce(async () => {
    edited.edit();
    return { threadId: "native", response: {} };
  });
  expect(
    await createSessionCodexRecovery(edited.deps)("session", { failedTurnId: "failed" }),
  ).toEqual({ state: "superseded" });
  expect(edited.resume).not.toHaveBeenCalled();
  const advanced = recoveryFixture();
  advanced.setExternal(false);
  advanced.resumeThread.mockImplementationOnce(async () => {
    advanced.advance();
    return { threadId: "native", response: {} };
  });
  expect(
    await createSessionCodexRecovery(advanced.deps)("session", { failedTurnId: "failed" }),
  ).toEqual({ state: "superseded" });
  expect(advanced.resume).not.toHaveBeenCalled();
  const archived = recoveryFixture();
  archived.setExternal(false);
  archived.deps.isArchived = async () => true;
  expect(
    await createSessionCodexRecovery(archived.deps)("session", { failedTurnId: "failed" }),
  ).toEqual({ state: "resumed" });
  expect(archived.unarchiveThread).toHaveBeenCalledExactlyOnceWith("native");
  expect(archived.unarchiveThread.mock.invocationCallOrder[0]).toBeLessThan(
    archived.resumeThread.mock.invocationCallOrder[0]!,
  );
});

// Failure story: an old confirmation must never stop a newer turn, and a caller
// must not be able to use another chat's failure record to control this writer.
test("interruptions require confirmation for the exact active turn and enforce chat identity", async () => {
  const f = recoveryFixture();
  f.setExternal(false);
  f.setActive("active-a");
  const recover = createSessionCodexRecovery(f.deps);
  expect(await recover("session", { failedTurnId: "failed" })).toEqual({
    state: "active",
    activeTurnId: "active-a",
  });
  expect(f.interrupt).not.toHaveBeenCalled();
  f.setActive("active-b");
  expect(
    await recover("session", { failedTurnId: "failed", confirmedActiveTurnId: "active-a" }),
  ).toEqual({ state: "active", activeTurnId: "active-b" });
  expect(f.interrupt).not.toHaveBeenCalled();
  expect(
    await recover("session", { failedTurnId: "failed", confirmedActiveTurnId: "active-b" }),
  ).toEqual({ state: "resumed" });
  expect(f.interrupt).toHaveBeenCalledExactlyOnceWith("session", "active-b");
  const other = recoveryFixture();
  other.failed.sessionId = "another-session";
  await expect(
    createSessionCodexRecovery(other.deps)("session", { failedTurnId: "failed" }),
  ).rejects.toThrow("this chat");
  expect(other.resumeThread).not.toHaveBeenCalled();
});

// Failure story: this IPC action must not become an arbitrary protocol launcher.
test("the Codex launcher only constructs a thread URL from a native thread ID", () => {
  const threadId = "01a15edf-7b9f-7d40-a9ad-010bfde944d8";
  expect(codexThreadUrl({ threadId })).toBe(`codex://threads/${threadId}`);
  for (const payload of [
    { threadId: "file:///etc/passwd" },
    { threadId: "../native" },
    { url: "https://example.com" },
    null,
  ]) {
    expect(() => codexThreadUrl(payload)).toThrow();
  }
});

// Equal prompt text must not substitute another queued request's permissions or attachments.
test("ownership retention does not reuse a different request with the same prompt", async () => {
  const request = { prompt: "Review the plan", sandbox: "read-only" as const };
  const queue = vi.fn(async () => ({ id: "retained", revision: 1 }) as TaskInput);
  const marker = await retainCodexRecoveryInput({
    turn: { id: "failed" } as Turn,
    request,
    pending: async () => [
      {
        id: "unrelated",
        senderKind: "user",
        kind: "queued",
        state: "pending",
        body: request.prompt,
        payload: { ...request, sandbox: "danger-full-access" },
      } as TaskInput,
    ],
    queue,
  });
  expect(marker).toEqual({ inputId: "retained", revision: 1 });
  expect(queue).toHaveBeenCalledWith(request, "codex-ownership:failed");
});
