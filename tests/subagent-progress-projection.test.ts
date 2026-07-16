import { describe, expect, test } from "vitest";
import {
  SubagentRunSchema,
  type RuntimeEvent,
  type SubagentRun,
} from "../packages/contracts/src";
import { createSubagentContinuationRuntime } from "../apps/server/src/runtime/subagents/continuation-runtime";
import {
  SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY,
  subagentProgressProjectionFromRuntimeEvents,
  subagentProgressProjectionStateFromRun,
} from "../apps/server/src/runtime/subagents/progress-reducer";

describe("subagent progress projection", () => {
  test("carries repetition counts and pending tool arguments across event batches", () => {
    const run = subagentRunFixture();
    const first = subagentProgressProjectionFromRuntimeEvents({
      run,
      state: subagentProgressProjectionStateFromRun(run),
      events: [
        runtimeEvent(1, "tool.started", {
          data: { toolCallId: "search_1" },
          args: { query: "progress cursor" },
        }),
        runtimeEvent(2, "tool.completed", {
          action: "resource_search",
          data: { toolCallId: "search_1", result: { items: [] } },
        }),
        runtimeEvent(3, "tool.started", {
          data: { toolCallId: "validation_1" },
          args: { command: "pnpm test tests/progress.test.ts" },
        }),
      ],
      phase: null,
      latestMeaningfulActivity: null,
      currentBlocker: null,
    });

    const secondRun = SubagentRunSchema.parse({
      ...run,
      progress: first.progress,
      metadata: { [SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY]: first.state },
    });
    const second = subagentProgressProjectionFromRuntimeEvents({
      run: secondRun,
      state: subagentProgressProjectionStateFromRun(secondRun),
      events: [
        runtimeEvent(4, "tool.completed", {
          action: "resource_search",
          data: { toolCallId: "search_2", result: { query: "progress cursor", items: [] } },
          args: { query: "progress cursor" },
        }),
        runtimeEvent(5, "tool.completed", {
          action: "exec_command",
          status: "completed",
          output: "1 pass\n0 fail",
          data: {
            toolCallId: "validation_1",
            result: { exitCode: 0, stdout: "1 pass\n0 fail" },
          },
        }),
      ],
      phase: null,
      latestMeaningfulActivity: null,
      currentBlocker: null,
    });

    expect(second.state.afterSequence).toBe(5);
    expect(second.state.startedArgsByToolCallId).toEqual({});
    expect(second.progress.repeatedSearches).toEqual(["resource_search:progress cursor"]);
    expect(second.progress.validationAttempts).toEqual([
      expect.objectContaining({
        command: "pnpm test tests/progress.test.ts",
        status: "passed",
        exitCode: 0,
      }),
    ]);

    const replay = subagentProgressProjectionFromRuntimeEvents({
      run: SubagentRunSchema.parse({
        ...secondRun,
        progress: second.progress,
        metadata: { [SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY]: second.state },
      }),
      state: second.state,
      events: [runtimeEvent(5, "tool.completed", {
        action: "exec_command",
        data: { toolCallId: "validation_1", result: { exitCode: 0 } },
      })],
      phase: null,
      latestMeaningfulActivity: null,
      currentBlocker: null,
    });
    expect(replay.progress.validationAttempts).toHaveLength(1);
  });

  test("reads large child histories in bounded sequence-aware batches without rescanning", async () => {
    const run = subagentRunFixture();
    const events = Array.from({ length: 2_501 }, (_, index) =>
      runtimeEvent(index + 1, "tool.started", {
        data: { toolCallId: `call_${index + 1}` },
        args: { query: `query_${index + 1}` },
      }),
    );
    const queries: Array<{ afterSequence: number; limit: number; names: readonly RuntimeEvent["name"][] }> = [];
    const runtime = createSubagentContinuationRuntime({
      requireSubagentDeps: () => ({
        getRun: async () => run,
        upsertRun: async () => run,
        listRuns: async () => [run],
        listUsageRecords: async () => [],
      }),
      runtimeEventsForSession: async (_sessionId, query = {}) => {
        queries.push({
          afterSequence: query.afterSequence ?? 0,
          limit: query.limit ?? 0,
          names: query.names ?? [],
        });
        return events
          .filter((event) => (event.sequence ?? 0) > (query.afterSequence ?? 0))
          .slice(0, query.limit ?? undefined);
      },
      countTurnsForSession: async () => 0,
      latestAssistantTextForSession: async () => null,
      loadAppPreferences: async () => { throw new Error("not used"); },
      getTurn: async () => null,
      getSession: async () => { throw new Error("not used"); },
      appendSubagentReceipt: async () => undefined,
    });

    await runtime.subagentRuntimeDerivedProgress({ run, childSessionId: "session_child" });
    expect(queries.map((query) => query.afterSequence)).toEqual([0, 1_000, 2_000]);
    expect(queries.every((query) => query.limit === 1_000)).toBe(true);
    expect(queries[0]?.names).toEqual([
      "tool.started",
      "tool.completed",
      "workspace_action_result",
      "command.output",
    ]);
    expect((run.metadata[SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY] as { afterSequence: number }).afterSequence)
      .toBe(2_501);

    queries.length = 0;
    await runtime.subagentRuntimeDerivedProgress({ run, childSessionId: "session_child" });
    expect(queries.map((query) => query.afterSequence)).toEqual([2_501]);
  });

  test("bounds failed tool output before storing it as the current blocker", () => {
    const run = subagentRunFixture();
    const projection = subagentProgressProjectionFromRuntimeEvents({
      run,
      state: subagentProgressProjectionStateFromRun(run),
      events: [runtimeEvent(1, "tool.completed", {
        action: "unknown_tool",
        status: "failed",
        output: "x".repeat(12_000),
      })],
      phase: null,
      latestMeaningfulActivity: null,
      currentBlocker: null,
    });

    expect(projection.progress.currentBlocker?.length).toBeLessThanOrEqual(5_000);
    expect(projection.progress.currentBlocker?.endsWith("...")).toBe(true);
  });

  test("bounds inline validation commands before persisting progress", () => {
    const run = subagentRunFixture();
    const longCommand = `python3 -c '${"x".repeat(3_000)}' # test`;
    const projection = subagentProgressProjectionFromRuntimeEvents({
      run,
      state: subagentProgressProjectionStateFromRun(run),
      events: [
        runtimeEvent(1, "tool.completed", {
          action: "exec_command",
          status: "completed",
          args: { command: longCommand },
          output: "audit test passed",
          data: { result: { command: longCommand, exitCode: 0, stdout: "audit test passed" } },
        }),
      ],
      phase: null,
      latestMeaningfulActivity: null,
      currentBlocker: null,
    });

    expect(projection.progress.validationAttempts).toHaveLength(1);
    expect(projection.progress.validationAttempts[0]?.command.length).toBe(2_000);
    expect(projection.progress.validationAttempts[0]?.command.endsWith("...")).toBe(true);
    expect(projection.progress.validationAttempts[0]?.status).toBe("passed");
  });
});

function subagentRunFixture(): SubagentRun {
  return SubagentRunSchema.parse({
    id: "run_progress",
    parentSessionId: "session_parent",
    childSessionId: "session_child",
    roleId: "test",
    objective: "Prove incremental progress projection",
    progress: {},
    evidenceRetention: {},
    createdAt: "2026-07-10T00:00:00.000Z",
  });
}

function runtimeEvent(
  sequence: number,
  name: RuntimeEvent["name"],
  patch: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  return {
    id: `event_${sequence}`,
    sessionId: "session_child",
    turnId: "turn_child",
    name,
    timestamp: `2026-07-10T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    source: "provider",
    sequence,
    ...patch,
  };
}
