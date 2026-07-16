import { describe, expect, test } from "vitest";
import { AppPreferencesSchema, SubagentRunSchema, type SubagentRun } from "../packages/contracts/src";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createSubagentLifecycleWatcher } from "../apps/server/src/runtime/subagent-lifecycle-watcher";

describe("subagent lifecycle watcher repository reads", () => {
  test("bulk-loads run status sets once and groups one hundred scopes in memory", async () => {
    const runs = Array.from({ length: 100 }, (_, index) => subagentRun(index));
    const counts = {
      scopes: 0,
      active: 0,
      stale: 0,
      runs: 0,
    };
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listSubagentRunScopes: async () => {
          counts.scopes += 1;
          return runs.map((run) => ({
            parentSessionId: run.parentSessionId,
            parentGoalId: run.parentGoalId,
          }));
        },
        listActiveSubagentRuns: async () => {
          counts.active += 1;
          return runs;
        },
        listStaleSubagentRuns: async () => {
          counts.stale += 1;
          return [];
        },
        listSubagentRuns: async () => {
          counts.runs += 1;
          return [];
        },
      },
      queue: createBackgroundWorkerQueue({ queueId: "watcher-query-count" }),
      loadAppPreferences: async () => AppPreferencesSchema.parse({
        subagents: { enabled: true },
      }),
      appendRuntimeEvent: async () => undefined,
      isClosing: () => false,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");

    expect(result.activeCount).toBe(100);
    expect(counts).toEqual({
      scopes: 0,
      active: 1,
      stale: 1,
      runs: 2,
    });
  });
});

function subagentRun(index: number): SubagentRun {
  return SubagentRunSchema.parse({
    id: `run_${index}`,
    parentSessionId: `parent_${index}`,
    parentGoalId: `goal_${index}`,
    childSessionId: `child_${index}`,
    roleId: "research",
    objective: `Research scope ${index}`,
    status: "running",
    required: false,
    workerBrief: {},
    progress: {},
    review: {},
    evidenceRetention: {},
    createdAt: "2026-07-10T11:59:59.000Z",
    updatedAt: "2026-07-10T11:59:59.000Z",
  });
}
