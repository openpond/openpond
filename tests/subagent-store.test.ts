import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { SubagentMessage, SubagentRun } from "@openpond/contracts";
import { SqliteStore } from "../apps/server/src/store/store";

describe("subagent store", () => {
  test("persists subagent runs and goal-scoped mailbox messages", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-subagent-store-"));
    const store = new SqliteStore(storeDir);

    try {
      const queued = subagentRun({
        status: "queued",
        childSessionId: null,
        report: null,
      });
      await store.upsertSubagentRun(queued);

      const completed = subagentRun({
        status: "completed",
        childSessionId: "session-child-coding",
        completedAt: "2026-07-07T10:05:00.000Z",
        report: {
          summary: "Implemented the scoped change.",
          findings: [],
          artifacts: [],
          patchRef: null,
          diffRef: { kind: "diff", id: "diff-1", label: "Coding diff" },
          testsRun: ["bun test tests/subagent-store.test.ts"],
          blockers: [],
          confidence: "high",
          followUpNeeded: false,
        },
      });
      await store.upsertSubagentRun(completed);

      expect(await store.getSubagentRun("subagent-run-coding")).toEqual(completed);
      expect(await store.listSubagentRuns({ parentSessionId: "session-parent" })).toEqual([completed]);
      expect(await store.listSubagentRuns({ parentGoalId: "goal-1", status: "completed" })).toEqual([completed]);
      expect(await store.listSubagentRuns({ childSessionId: "session-child-coding" })).toEqual([completed]);
      expect(await store.listSubagentRuns({ parentGoalId: "goal-1", status: ["running", "blocked"] })).toEqual([]);

      const question = subagentMessage({
        id: "subagent-message-1",
        kind: "question",
        fromRunId: "subagent-run-review",
        toRunId: "subagent-run-coding",
        body: "Can you confirm the test command?",
      });
      const answer = subagentMessage({
        id: "subagent-message-2",
        kind: "answer",
        fromRunId: "subagent-run-coding",
        toRunId: "subagent-run-review",
        body: "The focused store test passed.",
      });
      await store.appendSubagentMessage(question);
      await store.appendSubagentMessage(answer);

      expect(await store.listSubagentMessages({ parentGoalId: "goal-1" })).toEqual([question, answer]);
      expect(await store.listSubagentMessages({ toRunId: "subagent-run-coding" })).toEqual([question]);
      expect(await store.listSubagentMessages({ fromRunId: "subagent-run-coding" })).toEqual([answer]);
    } finally {
      await store.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

function subagentRun(patch: Partial<SubagentRun>): SubagentRun {
  return {
    id: "subagent-run-coding",
    parentSessionId: "session-parent",
    parentTurnId: "turn-parent",
    parentGoalId: "goal-1",
    childSessionId: null,
    roleId: "coding",
    objective: "Implement the scoped change.",
    modelRef: { providerId: "zai", modelId: "glm-5.2" },
    isolationMode: "copy_on_write",
    toolPolicy: "workspace_write",
    background: true,
    peerMessages: "goal_scoped",
    status: "queued",
    required: true,
    createdAt: "2026-07-07T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    error: null,
    report: null,
    metadata: {},
    ...patch,
  };
}

function subagentMessage(patch: Partial<SubagentMessage>): SubagentMessage {
  return {
    id: "subagent-message",
    parentGoalId: "goal-1",
    fromRunId: "subagent-run-coding",
    toRunId: null,
    toRole: null,
    kind: "status",
    body: "Status update.",
    refs: [],
    createdAt: patch.id === "subagent-message-2"
      ? "2026-07-07T10:07:00.000Z"
      : "2026-07-07T10:06:00.000Z",
    ...patch,
  };
}
