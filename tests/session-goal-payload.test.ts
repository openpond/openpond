import { expect, test, vi } from "vitest";
import type { Session } from "@openpond/contracts";
import type { CodexThreadGoal } from "@openpond/codex-provider";
import { createSessionGoalPayload } from "../apps/server/src/api/session-goal-payload";

// Failure story: editing a goal must not reset its paused state, budget or usage,
// and two open editors must not silently overwrite one another's objective.
test("goal edits preserve provider lifecycle and reject stale, duplicate, and empty edits", async () => {
  let goal: CodexThreadGoal = { threadId: "native-thread", objective: "Original objective", status: "paused",
    tokenBudget: 50_000, tokensUsed: 8_000, timeUsedSeconds: 180, createdAt: 1, updatedAt: 2 };
  const events: unknown[] = [];
  const client = {
    getThreadGoal: vi.fn(async () => ({ goal })),
    setThreadGoal: vi.fn(async (_id, patch) => ({ goal: goal = { ...goal, ...patch } })),
    stop: vi.fn(async () => {}),
  };
  const update = createSessionGoalPayload({
    getSession: async () => ({ id: "session", provider: "codex", codexThreadId: "native-thread", status: "idle" } as Session),
    appendRuntimeEvent: async value => { events.push(value); }, createClient: () => client,
  });
  const results = await Promise.allSettled([
    update("session", { expectedObjective: "Original objective", objective: "  Revised objective  " }),
    update("session", { expectedObjective: "Original objective", objective: "Stale edit" }),
  ]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  expect(client.setThreadGoal).toHaveBeenCalledExactlyOnceWith("native-thread", { objective: "Revised objective" });
  expect(goal).toMatchObject({ objective: "Revised objective", status: "paused", tokensUsed: 8_000, tokenBudget: 50_000, timeUsedSeconds: 180 });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ sessionId: "session", name: "diagnostic", data: { kind: "thread_goal", goal } });
  expect(client.stop).toHaveBeenCalledTimes(2);
  await expect(update("session", { expectedObjective: goal.objective, objective: " " })).rejects.toThrow();
  expect(client.setThreadGoal).toHaveBeenCalledTimes(1);
  expect(await update("session", undefined)).toMatchObject({ goal });
  await update("session", { expectedObjective: goal.objective, status: "active" });
  expect(goal.status).toBe("active");
});

// Failure story: a caller cannot use the goal endpoint to mutate a non-Codex
// chat or accidentally resurrect a goal removed in the provider.
test("goal mutations enforce the session/provider boundary and clean up failed clients", async () => {
  const createClient = vi.fn(() => ({ getThreadGoal: async () => ({ goal: null }),
    setThreadGoal: vi.fn(), stop: vi.fn(async () => {}) }));
  const deps = { getSession: async () => ({ provider: "openai", status: "idle" } as Session),
    appendRuntimeEvent: vi.fn(), createClient };
  await expect(createSessionGoalPayload(deps)("session", { expectedObjective: "Old", status: "active" })).rejects.toThrow("Codex goal");
  expect(createClient).not.toHaveBeenCalled();
  const client = createClient();
  const update = createSessionGoalPayload({ ...deps, getSession: async () => ({ provider: "codex", codexThreadId: "thread", status: "idle" } as Session), createClient: () => client });
  await expect(update("session", { expectedObjective: "Old", objective: "New" })).rejects.toThrow("removed");
  expect(client.setThreadGoal).not.toHaveBeenCalled();
  expect(client.stop).toHaveBeenCalledOnce();
});
