import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCodexBridge } from "../apps/server/dist/runtime/codex-bridge.js";

function immediateQueue() {
  return {
    enqueue(_work, run) {
      return run();
    },
  };
}

describe("codex bridge", () => {
  test("maps token usage and compact notifications into runtime events", async () => {
    const events = [];
    const store = {
      async snapshot() {
        return {
          sessions: [{ id: "session_1", appId: "app_1" }],
          turns: [{ id: "turn_local", sessionId: "session_1", providerTurnId: "turn_provider", status: "in_progress" }],
          events,
          approvals: [],
        };
      },
    };
    const bridge = createCodexBridge({
      store,
      upsertApproval: async () => {},
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      providerRuntimeIngestionQueue: immediateQueue(),
    });

    await bridge.mapCodexNotification("session_1", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread_1",
        turnId: "turn_provider",
        tokenUsage: {
          total: { totalTokens: 64000 },
          last: { totalTokens: 1200 },
          modelContextWindow: 128000,
        },
      },
    });

    const usageEvent = events.find((event) => event.name === "session.context.updated");
    assert.equal(usageEvent.turnId, "turn_local");
    assert.equal(usageEvent.data.provider, "codex");
    assert.equal(usageEvent.data.usedTokens, 1200);
    assert.equal(usageEvent.data.percentFull, 1);

    await bridge.mapCodexNotification("session_1", {
      method: "item/started",
      params: {
        threadId: "thread_1",
        turnId: "turn_provider",
        item: { type: "contextCompaction", id: "compact_1" },
      },
    });

    const startedEvents = events.filter((event) => event.name === "session.compaction.started");
    assert.equal(startedEvents.length, 1);
    assert.equal(startedEvents[0].data.reason, "auto");

    await bridge.mapCodexNotification("session_1", {
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_provider",
        item: { type: "contextCompaction", id: "compact_1" },
      },
    });

    const completedEvents = events.filter((event) => event.name === "session.compaction.completed");
    assert.equal(completedEvents.length, 1);
    assert.equal(completedEvents[0].turnId, "turn_local");
    assert.equal(completedEvents[0].data.provider, "codex");
    assert.equal(completedEvents[0].data.reason, "auto");
    assert.equal(completedEvents[0].data.codexThreadId, "thread_1");

    await bridge.mapCodexNotification("session_1", {
      method: "thread/compacted",
      params: {
        threadId: "thread_1",
        turnId: "turn_provider",
      },
    });
    assert.equal(events.filter((event) => event.name === "session.compaction.completed").length, 1);

    await bridge.mapCodexNotification("session_1", {
      method: "item/started",
      params: {
        turnId: "turn_provider",
        item: { type: "webSearch", id: "search_1", query: "weather 07747" },
      },
    });
    await bridge.mapCodexNotification("session_1", {
      method: "item/completed",
      params: {
        turnId: "turn_provider",
        item: { type: "webSearch", id: "search_1", query: "weather 07747" },
      },
    });

    const webSearchEvents = events.filter((event) => event.action === "web_search");
    assert.deepEqual(
      webSearchEvents.map((event) => [event.name, event.status, event.output]),
      [
        ["tool.started", "started", "weather 07747"],
        ["tool.completed", "completed", "weather 07747"],
      ]
    );

    await bridge.mapCodexNotification("session_1", {
      method: "thread/goal/updated",
      params: {
        threadId: "thread_1",
        turnId: "turn_provider",
        goal: {
          objective: "Ship sidebar polish",
          status: "active",
          tokenBudget: 10000,
          tokensUsed: 1200,
          timeUsedSeconds: 90,
        },
      },
    });

    const goalEvent = events.find((event) => event.data?.kind === "thread_goal");
    assert.equal(goalEvent.name, "diagnostic");
    assert.equal(goalEvent.output, "Ship sidebar polish");
    assert.equal(goalEvent.data.provider, "codex");
    assert.equal(goalEvent.data.goal.timeUsedSeconds, 90);

    await bridge.mapCodexNotification("session_1", {
      method: "thread/goal/cleared",
      params: {
        threadId: "thread_1",
        turnId: "turn_provider",
      },
    });

    const goalClearedEvent = events.find((event) => event.data?.kind === "thread_goal_cleared");
    assert.equal(goalClearedEvent.name, "diagnostic");
    assert.equal(goalClearedEvent.data.threadId, "thread_1");
  });

  test("clears stale active Codex goals when a live turn completes", async () => {
    const events = [];
    const store = {
      async snapshot() {
        return {
          sessions: [{ id: "session_1", appId: "app_1" }],
          turns: [{ id: "turn_local", sessionId: "session_1", providerTurnId: "turn_provider", status: "in_progress" }],
          events,
          approvals: [],
        };
      },
    };
    const bridge = createCodexBridge({
      store,
      upsertApproval: async () => {},
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      providerRuntimeIngestionQueue: immediateQueue(),
    });

    await bridge.mapCodexNotification("session_1", {
      method: "thread/goal/updated",
      params: {
        threadId: "thread_1",
        turnId: "turn_provider",
        goal: {
          objective: "Ship sidebar polish",
          status: "active",
          tokenBudget: 10000,
          tokensUsed: 1200,
          timeUsedSeconds: 90,
        },
      },
    });

    await bridge.mapCodexNotification("session_1", {
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_provider",
        turn: { id: "turn_provider", status: "completed" },
      },
    });

    assert.deepEqual(
      events.map((event) => [event.name, event.data?.kind ?? null]),
      [
        ["diagnostic", "thread_goal"],
        ["turn.completed", null],
        ["diagnostic", "thread_goal_cleared"],
      ]
    );
    const clearEvent = events.at(-1);
    assert.equal(clearEvent.turnId, "turn_local");
    assert.equal(clearEvent.data.provider, "codex");
    assert.equal(clearEvent.data.threadId, "thread_1");
  });
});
