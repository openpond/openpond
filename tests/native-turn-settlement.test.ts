import { expect, test, vi } from "vitest";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./helpers/turn-runner-test-harness";

// Failure story: cancellation must not hide an unconfirmed native shutdown or
// preserve output bytes while their producer can still be writing them.
test("unconfirmed native cancellation fails instead of acknowledging clean interruption", async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const session = turnRunnerTestSession({ provider: "codex", modelRef: { providerId: "codex", modelId: "gpt-6.1-sol" },
    experience: "work", cwd: "/tmp/openpond", workspaceKind: "local_project", workspaceId: "test-project" });
  const stop = vi.fn(async () => { throw new Error("native closure unconfirmed"); });
  const finalize = vi.fn(async () => session);
  const flush = vi.fn(async () => {});
  const harness = createTurnRunnerTestHarness({ sessions: [session], dependencies: {
    ensureCodexRuntime: async () => ({ threadId: "native-thread", cwd: session.cwd, permissionMode: "default", reasoningEffort: null,
      client: { startTurn: async () => ({ turnId: "native-turn" }), interruptTurn: async () => ({}),
        waitForTurn: () => { started(); return new Promise(() => {}); }, stopAndWait: stop } as never }),
    stopCodexRuntime: stop, flushCodexRuntimeEvents: flush, finalizeWorkTurn: finalize,
  } });
  try {
    const pending = harness.runner.sendTurn(session.id, { prompt: "Complete the work.", modelRef: session.modelRef });
    await Promise.race([waiting, pending.then(turn => { throw new Error("Native test failed before waiting: " + turn.error); })]);
    await harness.runner.interruptSessionTurn(session.id);
    const terminal = await pending;
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("native closure unconfirmed");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
  } finally { await harness.runner.close(); }
});
