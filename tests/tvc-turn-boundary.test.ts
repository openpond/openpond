import { expect, test, vi } from "vitest";
import { createTurnRunnerTestHarness } from "./helpers/turn-runner-test-harness";

// TVC owns the agent loop. Desktop must not silently run local profile tools,
// send local history, or leave a turn in progress when the user presses Stop.
test("TVC turns use only the selected remote model and preserve desktop completion and stop semantics", async () => {
  const enclaveChat = vi.fn(async (_model: string, prompt: string, signal: AbortSignal) => {
    if (prompt === "wait") await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    return { requestId: "request", threadId: "remote-thread", turnId: "remote-turn", answer: prompt, tools: [] };
  });
  const executeProfileSkillCommand = vi.fn();
  const harness = createTurnRunnerTestHarness({ dependencies: { isRemoteAgentModel: async () => true, enclaveChat, executeProfileSkillCommand } });
  const modelRef = { providerId: "custom-openai-compatible" as const, modelId: "url:12345678-1234-1234-1234-123456789012" };
  try {
    expect((await harness.runner.sendTurn("session_test", { prompt: "first", modelRef })).status).toBe("completed");
    expect((await harness.runner.sendTurn("session_test", { prompt: "second", modelRef })).status).toBe("completed");
    expect(enclaveChat.mock.calls.map((call) => call.slice(0, 2))).toEqual([[modelRef.modelId, "first"], [modelRef.modelId, "second"]]);
    expect(executeProfileSkillCommand).not.toHaveBeenCalled();
    expect(harness.state.events.filter((event) => event.name === "assistant.delta").map((event) => event.output)).toEqual(["first", "second"]);
    const pending = harness.runner.sendTurn("session_test", { prompt: "wait", modelRef });
    await vi.waitFor(() => expect(enclaveChat).toHaveBeenCalledTimes(3));
    await harness.runner.interruptAll("User stopped the turn");
    expect((await pending).status).toBe("interrupted");
    expect(harness.runner.isSessionTurnActive("session_test")).toBe(false);
  } finally { await harness.runner.close(); }
});
