import { describe, expect, test } from "vitest";
import { createTurnRunnerTestHarness } from "./helpers/turn-runner-test-harness";

function blockingHostedStream(onStarted: () => void) {
  return async function* (input: { signal: AbortSignal }) {
    onStarted();
    await new Promise<void>((_, reject) => {
      if (input.signal.aborted) {
        reject(new Error("aborted stream"));
        return;
      }
      input.signal.addEventListener("abort", () => reject(new Error("aborted stream")), { once: true });
    });
    yield { text: "unreachable" };
  };
}

function waitUntilStarted() {
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  return { start, started };
}

describe("turn-runner lifecycle", () => {
  test("interruptAll is concurrent-idempotent and waits for active turns to settle", async () => {
    const stream = waitUntilStarted();
    const harness = createTurnRunnerTestHarness({
      dependencies: { streamLocalByokChatTurn: blockingHostedStream(stream.start) },
    });
    const pendingTurn = harness.runner.sendTurn("session_test", {
      prompt: "Keep running until interrupted.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await stream.started;

    const first = harness.runner.interruptAll("Lifecycle test interruption");
    const second = harness.runner.interruptAll("Lifecycle test interruption");
    expect(second).toBe(first);

    const [interrupted, turn] = await Promise.all([first, pendingTurn]);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ status: "interrupted", error: "Lifecycle test interruption" });
    expect(turn.status).toBe("interrupted");
    expect(harness.runner.isSessionTurnActive("session_test")).toBe(false);
    expect(await harness.runner.interruptAll()).toEqual([]);
  });

  test("close is idempotent, drains owned queues, and rejects new turns", async () => {
    const stream = waitUntilStarted();
    let followUpRan = false;
    let subagentJobRan = false;
    const harness = createTurnRunnerTestHarness({
      dependencies: { streamLocalByokChatTurn: blockingHostedStream(stream.start) },
    });
    harness.dependencies.turnFollowUpQueue.enqueue({ label: "close follow-up proof" }, async () => {
      followUpRan = true;
    });
    harness.dependencies.subagentQueue!.enqueue({ label: "close subagent proof" }, async () => {
      subagentJobRan = true;
    });
    const pendingTurn = harness.runner.sendTurn("session_test", {
      prompt: "Close while this is active.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await stream.started;

    const first = harness.runner.close();
    const second = harness.runner.close();
    expect(second).toBe(first);
    await Promise.all([first, pendingTurn]);

    expect(followUpRan).toBe(true);
    expect(subagentJobRan).toBe(true);
    expect(harness.dependencies.turnFollowUpQueue.pendingReceipts()).toEqual([]);
    expect(harness.dependencies.subagentQueue!.pendingReceipts()).toEqual([]);
    expect(harness.runner.isSessionTurnActive("session_test")).toBe(false);
    await expect(harness.runner.sendTurn("session_test", {
      prompt: "This must not start.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    })).rejects.toThrow("Turn runner is closed.");
  });
});
