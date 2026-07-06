import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "@openpond/contracts";
import {
  activeGoalRuntimeFromSessionMetadata,
  latestGoalRuntimeFromEvents,
  latestKnownActiveGoalRuntimeFromEvents,
} from "../apps/web/src/lib/goal-runtime";

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
          provider: "codex",
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
            status: "completed",
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
            status: "running",
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

  test("known active goal ignores synthetic lifecycle clears for active sidebar rows", () => {
    const status = latestKnownActiveGoalRuntimeFromEvents([
      runtimeEvent({
        id: "goal_1",
        name: "diagnostic",
        data: {
          kind: "thread_goal",
          provider: "codex",
          goal: {
            objective: "Ship sidebar polish",
            status: "running",
            timeUsedSeconds: 125,
            tokensUsed: 1250,
          },
        },
      }),
      runtimeEvent({
        id: "goal_synthetic_clear",
        name: "diagnostic",
        data: { kind: "thread_goal_cleared", synthetic: true },
      }),
    ]);

    expect(status?.tone).toBe("active");
    expect(status?.actionLabel).toBe("Pursuing goal");
  });

  test("known active goal still respects explicit goal clears", () => {
    const status = latestKnownActiveGoalRuntimeFromEvents([
      runtimeEvent({
        id: "goal_1",
        name: "diagnostic",
        data: {
          kind: "thread_goal",
          provider: "codex",
          goal: {
            objective: "Ship sidebar polish",
            status: "running",
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

  test("uses active Codex goal runtime metadata for sidebar rows", () => {
    const status = activeGoalRuntimeFromSessionMetadata({
      codexGoalRuntime: {
        provider: "codex",
        objective: "Finish the validation pass",
        status: "active",
        timeUsedSeconds: 61,
        tokensUsed: 2000,
        tokenBudget: null,
        updatedAt: "2026-07-06T17:00:00.000Z",
      },
    });

    expect(status?.tone).toBe("active");
    expect(status?.actionLabel).toBe("Pursuing goal");
    expect(status?.detail).toBe("Active · 2k tokens");
  });

  test("formats million-scale goal token counts compactly", () => {
    const status = activeGoalRuntimeFromSessionMetadata({
      codexGoalRuntime: {
        provider: "codex",
        objective: "Finish the validation pass",
        status: "active",
        timeUsedSeconds: 61,
        tokensUsed: 2_584_020,
        tokenBudget: null,
        updatedAt: "2026-07-06T17:00:00.000Z",
      },
    });

    expect(status?.detail).toBe("Active · 2.58M tokens");
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
            status: "running",
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
            status: "running",
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
            status: "completed",
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

  test("maps exact OpenPond goal statuses to stable UI tone and action label", () => {
    const cases = [
      ["queued", "active", "Goal queued"],
      ["running", "active", "Pursuing goal"],
      ["awaiting_user_input", "active", "Goal awaiting input"],
      ["awaiting_approval", "active", "Goal awaiting approval"],
      ["paused", "paused", "Goal paused"],
      ["blocked", "limited", "Goal blocked"],
      ["completed", "done", "Goal achieved"],
      ["failed", "limited", "Goal failed"],
      ["cancelled", "limited", "Goal cancelled"],
      ["budget_limited", "limited", "Goal budget limited"],
    ] as const;

    for (const [goalStatus, tone, actionLabel] of cases) {
      const status = latestGoalRuntimeFromEvents([
        runtimeEvent({
          id: `goal_${goalStatus}`,
          name: "diagnostic",
          data: {
            kind: "thread_goal",
            goal: {
              objective: `Status ${goalStatus}`,
              status: goalStatus,
              timeUsedSeconds: 1,
            },
          },
        }),
      ]);

      expect(status?.tone).toBe(tone);
      expect(status?.actionLabel).toBe(actionLabel);
    }
  });

  test("maps exact Codex goal statuses to stable UI tone and action label", () => {
    const cases = [
      ["active", "active", "Pursuing goal"],
      ["running", "active", "Pursuing goal"],
      ["paused", "paused", "Goal paused"],
      ["blocked", "limited", "Goal blocked"],
      ["complete", "done", "Goal achieved"],
      ["completed", "done", "Goal achieved"],
      ["failed", "limited", "Goal failed"],
      ["cancelled", "limited", "Goal cancelled"],
      ["canceled", "limited", "Goal cancelled"],
      ["budget_limited", "limited", "Goal budget limited"],
    ] as const;

    for (const [goalStatus, tone, actionLabel] of cases) {
      const status = latestGoalRuntimeFromEvents([
        runtimeEvent({
          id: `codex_goal_${goalStatus}`,
          name: "diagnostic",
          data: {
            kind: "thread_goal",
            provider: "codex",
            goal: {
              objective: `Status ${goalStatus}`,
              status: goalStatus,
              timeUsedSeconds: 1,
            },
          },
        }),
      ]);

      expect(status?.tone).toBe(tone);
      expect(status?.actionLabel).toBe(actionLabel);
    }
  });

  test("does not classify unknown statuses by substring", () => {
    const cases = [
      ["incomplete", "active", "Goal status unknown"],
      ["unblocked", "active", "Goal status unknown"],
    ] as const;

    for (const [goalStatus, tone, actionLabel] of cases) {
      const status = latestGoalRuntimeFromEvents([
        runtimeEvent({
          id: `goal_${goalStatus}`,
          name: "diagnostic",
          data: {
            kind: "thread_goal",
            provider: "codex",
            goal: {
              objective: `Status ${goalStatus}`,
              status: goalStatus,
              timeUsedSeconds: 1,
            },
          },
        }),
      ]);

      expect(status?.status).toBe(goalStatus);
      expect(status?.detail).toBe(`${goalStatus.charAt(0).toUpperCase()}${goalStatus.slice(1)}`);
      expect(status?.tone).toBe(tone);
      expect(status?.actionLabel).toBe(actionLabel);
    }
  });
});
