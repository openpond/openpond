import { describe, expect, test } from "vitest";
import {
  createTurnRunnerTestHarness,
  normalizeRuntimeEventTrace,
  turnRunnerTestSession,
} from "./helpers/turn-runner-test-harness";

describe("turn-runner characterization", () => {
  test("preserves hosted success state and ordered runtime events", async () => {
    const harness = createTurnRunnerTestHarness();
    const turn = await harness.runner.sendTurn("session_test", {
      prompt: "Characterize a successful hosted turn.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn).toMatchObject({
      sessionId: "session_test",
      status: "completed",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      prompt: "Characterize a successful hosted turn.",
    });
    expect(harness.state.sessions.get("session_test")?.status).toBe("idle");
    expect(normalizeRuntimeEventTrace(harness.state.events)).toEqual([
      expect.objectContaining({
        sessionId: "session_test",
        turnId: "<turnId>",
        name: "turn.started",
        source: "chat_action",
        status: "started",
      }),
      expect.objectContaining({
        sessionId: "session_test",
        turnId: "<turnId>",
        name: "assistant.delta",
        source: "provider",
        output: "Characterized response.",
      }),
      expect.objectContaining({
        sessionId: "session_test",
        turnId: "<turnId>",
        name: "turn.completed",
        source: "provider",
        status: "completed",
        data: { provider: "openrouter", model: "test/model" },
      }),
    ]);
  });

  test("preserves provider failure state and releases the active-session guard", async () => {
    const harness = createTurnRunnerTestHarness({
      dependencies: {
        streamLocalByokChatTurn: async function* () {
          throw new Error("characterized provider failure");
        },
      },
    });

    const turn = await harness.runner.sendTurn("session_test", {
      prompt: "Characterize a failed hosted turn.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn).toMatchObject({ status: "failed", error: "characterized provider failure" });
    expect(harness.runner.isSessionTurnActive("session_test")).toBe(false);
    expect(harness.state.sessions.get("session_test")?.status).toBe("idle");
    expect(normalizeRuntimeEventTrace(harness.state.events)).toEqual([
      expect.objectContaining({
        name: "turn.started",
        source: "chat_action",
        status: "started",
      }),
    ]);
  });

  test("preserves interruption state and permits a follow-up turn", async () => {
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const harness = createTurnRunnerTestHarness({
      dependencies: {
        streamLocalByokChatTurn: async function* (input) {
          await Promise.race([
            streamReleased,
            new Promise<void>((_, reject) => {
              input.signal.addEventListener("abort", () => reject(new Error("aborted stream")), { once: true });
            }),
          ]);
          yield { text: "late response" };
        },
      },
    });
    const pending = harness.runner.sendTurn("session_test", {
      prompt: "Characterize an interrupted turn.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    while (!harness.runner.isSessionTurnActive("session_test")) await Promise.resolve();
    const interrupted = await harness.runner.interruptSessionTurn("session_test");
    releaseStream();
    await pending;

    expect(interrupted.status).toBe("interrupted");
    expect(harness.runner.isSessionTurnActive("session_test")).toBe(false);

    const followUpHarness = createTurnRunnerTestHarness({
      sessions: [turnRunnerTestSession({ id: "session_follow_up" })],
    });
    const followUp = await followUpHarness.runner.sendTurn("session_follow_up", {
      prompt: "Follow up after interruption.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    expect(followUp.status).toBe("completed");
  });
});
