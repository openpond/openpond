import { describe, expect, test } from "vitest";
import {
  SubagentRunSchema,
} from "../packages/contracts/src";
import {
  baseSession,
  createSubagentHarness,
  preferences,
} from "./helpers/turn-runner-subagent-harness";

describe("subagent child lifecycle", () => {
  test("completes a child with a durable passive result and no parent watcher turn", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Inspect the focused behavior",
      },
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
    const completionMessages = harness.messages.filter((message) =>
      message.id.startsWith("subagent_completion_")
    );
    expect(completionMessages).toHaveLength(1);
    expect(completionMessages[0]).toMatchObject({
      fromRunId: harness.runs[0]!.id,
      body: "Focused child result.",
      delivery: {
        deliveredParentSessionId: "session_1",
        status: "pending",
        inputIds: [expect.any(String)],
      },
    });
    const parentContinuations = harness.turns.filter(
      (turn) => turn.metadata?.subagentCompletionWake
    );
    expect(parentContinuations).toHaveLength(0);
    expect((await harness.runner.readTaskInbox("session_1")).inputs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "result", body: "Focused child result." })]));
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
    const result = (await harness.runner.readTaskInbox("session_1")).inputs.find((input) => input.kind === "result");
    expect(result?.body).toBe(harness.runs[0]?.report?.summary);
  });

  test("reuses the same child thread for an explicit follow-up", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: { roleId: "coding", objective: "Implement the focused change" },
      preferences: preferences(),
      textBySessionId: {
        "role:coding": ["Initial implementation.", "Revised implementation."],
      },
      toolCallForStream: (_stream, context) => {
        const prompt = context.requestTurn?.prompt ?? "";
        if (context.requestSession?.id !== "session_1") return null;
        if (
          prompt === "Start implementation" &&
          !context.injectedFlags.started
        ) {
          context.injectedFlags.started = true;
          return {
            name: "openpond_subagent_start",
            args: {
              roleId: "coding",
              objective: "Implement the focused change",
            },
          };
        }
        if (
          prompt === "Request correction" &&
          !context.injectedFlags.followedUp
        ) {
          context.injectedFlags.followedUp = true;
          return {
            name: "openpond_subagent_followup",
            args: {
              runId: context.runs[0]!.id,
              message: "Correct the focused edge case.",
            },
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
    expect(
      harness.messages.filter((message) =>
        message.id.startsWith("subagent_completion_")
      )
    ).toHaveLength(2);
    expect(
      [...harness.sessions.values()].filter(
        (session) => session.parentSessionId === "session_1"
      )
    ).toHaveLength(1);
  });

  test("ordinary child messages are queued without creating parent watcher turns", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_send_message",
      toolArgs: { kind: "status", body: "Intermediate note." },
      preferences: preferences(),
      initialRuns: [
        SubagentRunSchema.parse({
          id: "run_child",
          parentSessionId: "session_1",
          parentTurnId: "turn_parent",
          childSessionId: "session_child",
          roleId: "research",
          objective: "Inspect the focused behavior",
          modelRef: { providerId: "openrouter", modelId: "test/model" },
          isolationMode: "none",
          toolPolicy: "read_only",
          background: true,
          peerMessages: "parent_scoped",
          status: "running",
          required: true,
          createdAt: "2026-07-07T10:00:00.000Z",
        }),
      ],
    });
    harness.sessions.set(
      "session_child",
      baseSession({
        id: "session_child",
        parentSessionId: "session_1",
        subagentRunId: "run_child",
        subagentRoleId: "research",
      })
    );

    await harness.runner.sendTurn("session_child", {
      prompt: "Send an intermediate note",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.turnFollowUpQueue.drain();

    const ordinaryMessage = harness.messages.find(
      (message) => message.body === "Intermediate note."
    );
    expect(ordinaryMessage?.delivery?.deliveredParentSessionId).toBe(
      "session_1"
    );
    expect(
      harness.turns.some((turn) => turn.metadata?.subagentParentWake)
    ).toBe(false);
    expect(
      harness.turns.some((turn) => turn.metadata?.subagentLifecycleWake)
    ).toBe(false);
  });

});
