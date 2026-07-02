import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "@openpond/contracts";
import { latestGoalRuntimeFromEvents } from "../apps/web/src/lib/goal-runtime";

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp: "2026-05-29T00:00:00.000Z",
    ...input,
  };
}

describe("goal runtime projection", () => {
  test("uses latest Codex thread goal update", () => {
    const status = latestGoalRuntimeFromEvents([
      runtimeEvent({
        id: "goal_1",
        name: "diagnostic",
        data: {
          kind: "thread_goal",
          goal: {
            objective: "Ship sidebar polish",
            status: "active",
            tokenBudget: 10000,
            tokensUsed: 1250,
            timeUsedSeconds: 125,
          },
        },
      }),
    ]);

    expect(status?.label).toBe("Goal 2m");
    expect(status?.actionLabel).toBe("Pursuing goal");
    expect(status?.timeLabel).toBe("2m");
    expect(status?.detail).toBe("Active · 1.3k / 10k tokens");
    expect(status?.objective).toBe("Ship sidebar polish");
  });

  test("labels completed goals as achieved", () => {
    const status = latestGoalRuntimeFromEvents([
      runtimeEvent({
        id: "goal_done",
        name: "diagnostic",
        data: {
          kind: "thread_goal",
          goal: {
            objective: "Ship sidebar polish",
            status: "complete",
            timeUsedSeconds: 3605,
            tokensUsed: 1250,
          },
        },
      }),
    ]);

    expect(status?.tone).toBe("done");
    expect(status?.actionLabel).toBe("Goal achieved");
    expect(status?.timeLabel).toBe("1h");
  });

  test("cleared goal hides runtime status", () => {
    const status = latestGoalRuntimeFromEvents([
      runtimeEvent({
        id: "goal_1",
        name: "diagnostic",
        data: {
          kind: "thread_goal",
          goal: {
            objective: "Ship sidebar polish",
            status: "active",
            timeUsedSeconds: 125,
            tokensUsed: 1250,
          },
        },
      }),
      runtimeEvent({
        id: "goal_clear",
        name: "diagnostic",
        data: { kind: "thread_goal_cleared" },
      }),
    ]);

    expect(status).toBeNull();
  });

  test("terminal clear after interruption hides stale active goal status", () => {
    const status = latestGoalRuntimeFromEvents([
      runtimeEvent({
        id: "goal_1",
        name: "diagnostic",
        data: {
          kind: "thread_goal",
          goal: {
            objective: "Ship sidebar polish",
            status: "active",
            timeUsedSeconds: 125,
            tokensUsed: 1250,
          },
        },
      }),
      runtimeEvent({
        id: "turn_interrupted",
        name: "turn.interrupted",
        output: "Turn interrupted: interrupted",
      }),
      runtimeEvent({
        id: "goal_clear",
        name: "diagnostic",
        data: { kind: "thread_goal_cleared" },
      }),
    ]);

    expect(status).toBeNull();
  });

  test("terminal turn event hides stale active goal status even without explicit clear", () => {
    const status = latestGoalRuntimeFromEvents([
      runtimeEvent({
        id: "goal_1",
        name: "diagnostic",
        data: {
          kind: "thread_goal",
          goal: {
            objective: "Ship sidebar polish",
            status: "active",
            timeUsedSeconds: 125,
            tokensUsed: 1250,
          },
        },
      }),
      runtimeEvent({
        id: "turn_done",
        name: "turn.completed",
      }),
    ]);

    expect(status).toBeNull();
  });

  test("terminal turn event keeps explicit completed goal status visible", () => {
    const status = latestGoalRuntimeFromEvents([
      runtimeEvent({
        id: "goal_done",
        name: "diagnostic",
        data: {
          kind: "thread_goal",
          goal: {
            objective: "Ship sidebar polish",
            status: "complete",
            timeUsedSeconds: 3605,
            tokensUsed: 1250,
          },
        },
      }),
      runtimeEvent({
        id: "turn_done",
        name: "turn.completed",
      }),
    ]);

    expect(status?.tone).toBe("done");
    expect(status?.actionLabel).toBe("Goal achieved");
  });
});
