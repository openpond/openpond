import { describe, expect, test } from "vitest";
import { SubagentMessageSchema, SubagentRunSchema } from "../packages/contracts/src";
import { baseSession, createSubagentHarness, preferences } from "./helpers/turn-runner-subagent-harness";

describe("subagent child lifecycle", () => {
  test("completes a child directly and continues the parent with one bounded result", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: { roleId: "research", objective: "Inspect the focused behavior" },
      preferences: preferences(),
      textBySessionId: { "role:research": ["Focused child result."] },
    });

    await harness.runner.sendTurn("session_1", {
      prompt: "Start focused research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();
    await harness.turnFollowUpQueue.drain();

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]).toMatchObject({
      status: "completed",
      report: { summary: "Focused child result." },
    });
    const completionMessages = harness.messages.filter((message) => message.id.startsWith("subagent_completion_"));
    expect(completionMessages).toHaveLength(1);
    expect(completionMessages[0]).toMatchObject({
      fromRunId: harness.runs[0]!.id,
      body: "Focused child result.",
      delivery: {
        deliveredParentSessionId: "session_1",
        wakeParentReason: "child_turn_completed",
      },
    });
    const parentContinuations = harness.turns.filter((turn) => turn.metadata?.subagentCompletionWake);
    expect(parentContinuations).toHaveLength(1);
    expect(parentContinuations[0]?.prompt).toContain("Focused child result.");
  });

  test("compacts an oversized child final instead of failing the run", async () => {
    const oversized = `Result\n${"x".repeat(25_000)}`;
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: { roleId: "planner", objective: "Return a detailed plan" },
      preferences: preferences(),
      textBySessionId: { "role:planner": [oversized] },
    });

    await harness.runner.sendTurn("session_1", {
      prompt: "Start planning",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();
    await harness.turnFollowUpQueue.drain();

    expect(harness.runs[0]?.status).toBe("completed");
    expect(harness.runs[0]?.report?.summary.length).toBe(20_000);
    expect(harness.runs[0]?.report?.summary.endsWith("...")).toBe(true);
    const continuation = harness.turns.find((turn) => turn.metadata?.subagentCompletionWake);
    expect(continuation?.prompt).toContain("Result");
  });

  test("reuses the same child thread for an explicit follow-up", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: { roleId: "coding", objective: "Implement the focused change" },
      preferences: preferences(),
      textBySessionId: { "role:coding": ["Initial implementation.", "Revised implementation."] },
      toolCallForStream: (_stream, context) => {
        const prompt = context.requestTurn?.prompt ?? "";
        if (context.requestSession?.id !== "session_1") return null;
        if (prompt === "Start implementation" && !context.injectedFlags.started) {
          context.injectedFlags.started = true;
          return {
            name: "openpond_subagent_start",
            args: { roleId: "coding", objective: "Implement the focused change" },
          };
        }
        if (prompt === "Request correction" && !context.injectedFlags.followedUp) {
          context.injectedFlags.followedUp = true;
          return {
            name: "openpond_subagent_followup",
            args: { runId: context.runs[0]!.id, message: "Correct the focused edge case." },
          };
        }
        return null;
      },
      disableDefaultToolCall: true,
    });

    await harness.runner.sendTurn("session_1", {
      prompt: "Start implementation",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();
    await harness.turnFollowUpQueue.drain();
    const runId = harness.runs[0]!.id;
    const childSessionId = harness.runs[0]!.childSessionId;

    await harness.runner.sendTurn("session_1", {
      prompt: "Request correction",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();
    await harness.turnFollowUpQueue.drain();

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]).toMatchObject({
      id: runId,
      childSessionId,
      status: "completed",
      report: { summary: "Revised implementation." },
    });
    expect(harness.messages.filter((message) => message.id.startsWith("subagent_completion_"))).toHaveLength(2);
    expect([...harness.sessions.values()].filter((session) => session.parentSessionId === "session_1")).toHaveLength(1);
  });

  test("a completion continuation can queue a follow-up without a stale completion write winning", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: { roleId: "review", objective: "Review the implementation" },
      preferences: preferences(),
      textBySessionId: { "role:review": ["First review.", "Second review."] },
      toolCallForStream: (_stream, context) => {
        if (context.requestSession?.id !== "session_1") return null;
        const prompt = context.requestTurn?.prompt ?? "";
        if (prompt === "Start review" && !context.injectedFlags.started) {
          context.injectedFlags.started = true;
          return {
            name: "openpond_subagent_start",
            args: { roleId: "review", objective: "Review the implementation" },
          };
        }
        if (prompt.includes("First review.") && !context.injectedFlags.followedUp) {
          context.injectedFlags.followedUp = true;
          return {
            name: "openpond_subagent_followup",
            args: { runId: context.runs[0]!.id, message: "Review the corrected implementation." },
          };
        }
        return null;
      },
      disableDefaultToolCall: true,
    });

    await harness.runner.sendTurn("session_1", {
      prompt: "Start review",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();
    await harness.turnFollowUpQueue.drain();
    await harness.subagentQueue.drain();
    await harness.turnFollowUpQueue.drain();

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]).toMatchObject({
      status: "completed",
      report: { summary: "Second review." },
    });
    expect(harness.messages.filter((message) => message.id.startsWith("subagent_completion_"))).toHaveLength(2);
  });

  test("ordinary child messages are queued without creating parent watcher turns", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_send_message",
      toolArgs: { kind: "status", body: "Intermediate note." },
      preferences: preferences(),
      initialRuns: [SubagentRunSchema.parse({
        id: "run_child",
        parentSessionId: "session_1",
        parentTurnId: "turn_parent",
        parentGoalId: "goal_1",
        childSessionId: "session_child",
        roleId: "research",
        objective: "Inspect the focused behavior",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
        isolationMode: "none",
        toolPolicy: "read_only",
        background: true,
        peerMessages: "goal_scoped",
        status: "running",
        required: true,
        createdAt: "2026-07-07T10:00:00.000Z",
      })],
    });
    harness.sessions.set("session_child", baseSession({
      id: "session_child",
      parentSessionId: "session_1",
      parentGoalId: "goal_1",
      subagentRunId: "run_child",
      subagentRoleId: "research",
    }));

    await harness.runner.sendTurn("session_child", {
      prompt: "Send an intermediate note",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.turnFollowUpQueue.drain();

    const ordinaryMessage = harness.messages.find((message) => message.body === "Intermediate note.");
    expect(ordinaryMessage?.delivery?.deliveredParentSessionId).toBe("session_1");
    expect(harness.turns.some((turn) => turn.metadata?.subagentParentWake)).toBe(false);
    expect(harness.turns.some((turn) => turn.metadata?.subagentLifecycleWake)).toBe(false);
  });

  test("recovers and coalesces durable completions once after restart", async () => {
    const runs = ["research", "coding"].map((roleId, index) => SubagentRunSchema.parse({
      id: `run_${roleId}`,
      parentSessionId: "session_1",
      parentTurnId: "turn_parent",
      parentGoalId: "goal_1",
      childSessionId: `session_child_${index + 1}`,
      roleId,
      objective: `Complete ${roleId}`,
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "none",
      toolPolicy: roleId === "coding" ? "workspace_write" : "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "completed",
      required: true,
      report: { summary: `${roleId} result` },
      createdAt: "2026-07-07T10:00:00.000Z",
      completedAt: "2026-07-07T10:00:01.000Z",
    }));
    const messages = runs.map((run, index) => SubagentMessageSchema.parse({
      id: `subagent_completion_turn_child_${index + 1}`,
      parentGoalId: "goal_1",
      fromRunId: run.id,
      toRole: "parent",
      kind: "handoff",
      priority: "normal",
      body: run.report?.summary,
      delivery: {
        status: "delivered",
        deliveredParentSessionId: "session_1",
        acknowledgedParentSessionId: "session_1",
        wakeRequestedParentSessionId: "session_1",
        wakeQueuedParentSessionId: "session_1",
        wakeParentReason: "child_turn_completed",
      },
      createdAt: "2026-07-07T10:00:01.000Z",
    }));
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: { roleId: "research", objective: "unused" },
      preferences: preferences(),
      initialRuns: runs,
      initialMessages: messages,
      disableDefaultToolCall: true,
    });
    runs.forEach((run, index) => harness.sessions.set(
      run.childSessionId!,
      baseSession({
        id: run.childSessionId!,
        parentSessionId: "session_1",
        parentTurnId: "turn_parent",
        parentGoalId: "goal_1",
        subagentRunId: run.id,
        subagentRoleId: run.roleId,
      }),
    ));

    expect(await harness.runner.recoverPendingSubagentCompletions()).toBe(2);
    await harness.turnFollowUpQueue.drain();

    const continuations = harness.turns.filter((turn) => turn.metadata?.subagentCompletionWake);
    expect(continuations).toHaveLength(1);
    expect((continuations[0]?.metadata?.subagentCompletionWake as { messageIds?: string[] }).messageIds).toHaveLength(2);
    expect(continuations[0]?.prompt).toContain("research result");
    expect(continuations[0]?.prompt).toContain("coding result");
    expect(await harness.runner.recoverPendingSubagentCompletions()).toBe(0);
    await harness.turnFollowUpQueue.drain();
    expect(harness.turns.filter((turn) => turn.metadata?.subagentCompletionWake)).toHaveLength(1);
  });

  test("does not auto-continue a completion already consumed by join", async () => {
    const run = SubagentRunSchema.parse({
      id: "run_joined",
      parentSessionId: "session_1",
      parentTurnId: "turn_parent",
      parentGoalId: "goal_1",
      childSessionId: "session_child_joined",
      roleId: "coding",
      objective: "Complete the bounded edit",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
      isolationMode: "none",
      toolPolicy: "workspace_write",
      background: true,
      peerMessages: "goal_scoped",
      status: "completed",
      report: { summary: "Joined result" },
      metadata: {
        completionConsumedByParent: {
          at: "2026-07-07T10:00:02.000Z",
          parentSessionId: "session_1",
          parentTurnId: "turn_parent",
          childCompletedAt: "2026-07-07T10:00:01.000Z",
        },
      },
      createdAt: "2026-07-07T10:00:00.000Z",
      completedAt: "2026-07-07T10:00:01.000Z",
    });
    const message = SubagentMessageSchema.parse({
      id: "subagent_completion_turn_joined",
      parentGoalId: "goal_1",
      fromRunId: run.id,
      toRole: "parent",
      kind: "handoff",
      priority: "normal",
      body: "Joined result",
      delivery: {
        status: "delivered",
        deliveredParentSessionId: "session_1",
        acknowledgedParentSessionId: "session_1",
        wakeRequestedParentSessionId: "session_1",
        wakeQueuedParentSessionId: "session_1",
        wakeParentReason: "child_turn_completed",
      },
      createdAt: "2026-07-07T10:00:01.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: { roleId: "coding", objective: "unused" },
      preferences: preferences(),
      initialRuns: [run],
      initialMessages: [message],
      disableDefaultToolCall: true,
    });
    harness.sessions.set(run.childSessionId!, baseSession({
      id: run.childSessionId!,
      parentSessionId: "session_1",
      parentTurnId: "turn_parent",
      parentGoalId: "goal_1",
      subagentRunId: run.id,
      subagentRoleId: run.roleId,
    }));

    expect(await harness.runner.recoverPendingSubagentCompletions()).toBe(1);
    await harness.turnFollowUpQueue.drain();

    expect(harness.turns.some((turn) => turn.metadata?.subagentCompletionWake)).toBe(false);
    expect(harness.runs[0]?.metadata?.completionNotifications).toEqual([
      expect.objectContaining({ outcome: "joined" }),
    ]);
  });
});
