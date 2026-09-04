import { describe, expect, it } from "vitest";
import type { ChatWorkflow, ChatWorkflowRun, SavedWorkRecurrence } from "@openpond/contracts";
import { createBackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import type { SqliteStore } from "../store/store.js";
import { createChatWorkflowLoop, nextOccurrence } from "./chat-workflow-scheduler.js";

function recurrence(
  overrides: Partial<SavedWorkRecurrence> = {},
): SavedWorkRecurrence {
  return {
    version: 1,
    kind: "daily",
    timeZone: "America/New_York",
    startDate: "2026-09-03",
    localTime: "09:30",
    end: { kind: "never" },
    ...overrides,
  } as SavedWorkRecurrence;
}

describe("chat workflow recurrence", () => {
  it("preserves the requested wall-clock time across daylight-saving changes", () => {
    expect(
      nextOccurrence(
        recurrence(),
        new Date("2026-09-03T13:31:00.000Z"),
        0,
      ),
    ).toBe("2026-09-04T13:30:00.000Z");

    expect(
      nextOccurrence(
        recurrence(),
        new Date("2026-11-02T14:31:00.000Z"),
        0,
      ),
    ).toBe("2026-11-03T14:30:00.000Z");
  });

  it("stops one-time and occurrence-bounded workflows", () => {
    expect(
      nextOccurrence(
        recurrence({ kind: "once" }),
        new Date("2026-09-03T13:31:00.000Z"),
        0,
      ),
    ).toBeNull();
    expect(
      nextOccurrence(
        recurrence({ end: { kind: "after_occurrences", occurrences: 3 } }),
        new Date("2026-09-03T12:00:00.000Z"),
        3,
      ),
    ).toBeNull();
  });

  it("delivers a run through the workflow's attached chat", async () => {
    const workflows = new Map<string, ChatWorkflow>();
    const runs = new Map<string, ChatWorkflowRun>();
    const store = {
      upsertChatWorkflow: async (workflow: ChatWorkflow) => {
        workflows.set(workflow.id, workflow);
        return workflow;
      },
      getChatWorkflow: async (id: string) => workflows.get(id) ?? null,
      insertChatWorkflowRun: async (run: ChatWorkflowRun) => {
        runs.set(run.id, run);
        return run;
      },
      patchChatWorkflowRun: async (
        id: string,
        update: (run: ChatWorkflowRun) => ChatWorkflowRun,
      ) => {
        const current = runs.get(id)!;
        const next = update(current);
        runs.set(id, next);
        return next;
      },
      patchChatWorkflow: async (
        id: string,
        update: (workflow: ChatWorkflow) => ChatWorkflow,
      ) => {
        const current = workflows.get(id)!;
        const next = update(current);
        workflows.set(id, next);
        return next;
      },
    } as unknown as SqliteStore;
    const queue = createBackgroundWorkerQueue({ queueId: "test-chat-workflow" });
    const delivered: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
    const loop = createChatWorkflowLoop({
      store,
      queue,
      getSession: async (sessionId) => ({ id: sessionId, title: "Launch notes" }) as never,
      sendTurn: async (sessionId, payload) => {
        delivered.push({ sessionId, payload: payload as Record<string, unknown> });
        return { id: "turn-1", status: "completed", error: null } as never;
      },
      isSessionTurnActive: () => false,
      isClosing: () => false,
    });
    const workflow = await loop.create({
      sessionId: "chat-42",
      name: "Morning brief",
      prompt: "Summarize the overnight launch activity.",
      recurrence: recurrence({ startDate: "2099-09-03" }),
    });
    await loop.runNow(workflow.id);
    await queue.drain();

    expect(delivered).toMatchObject([
      {
        sessionId: "chat-42",
        payload: {
          prompt: "Summarize the overnight launch activity.",
          metadata: {
            interactionKind: "scheduled_workflow",
            chatWorkflowId: workflow.id,
          },
        },
      },
    ]);
    expect(workflows.get(workflow.id)).toMatchObject({
      lastRunStatus: "succeeded",
      scheduledRunCount: 0,
    });
  });
});
