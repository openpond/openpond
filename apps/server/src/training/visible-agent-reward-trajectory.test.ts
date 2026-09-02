import { describe, expect, test } from "vitest";

import { VisibleAgentTrajectorySchema } from "./visible-agent-reward-trajectory.js";

describe("visible-agent Reward Model trajectory input", () => {
  test("accepts bounded policy-visible agent evidence", () => {
    expect(VisibleAgentTrajectorySchema.parse(trajectory())).toMatchObject({
      schemaVersion: "openpond.visibleAgentTrajectory.v1",
      termination: { terminal: true, truncated: false },
    });
  });

  test("rejects privileged answers and reward leakage anywhere in the trace", () => {
    expect(() => VisibleAgentTrajectorySchema.parse({
      ...trajectory(),
      finalVisibleState: {
        orderStatus: "refunded",
        hiddenObjective: "Issue exactly 12.34 USD.",
      },
    })).toThrow("forbidden privileged field hiddenObjective");
    expect(() => VisibleAgentTrajectorySchema.parse({
      ...trajectory(),
      toolEvents: [{
        index: 1,
        name: "issue_refund",
        arguments: { amount: 12.34 },
        result: { reward: 1 },
        status: "succeeded",
      }],
    })).toThrow("forbidden privileged field reward");
  });
});

function trajectory() {
  return {
    schemaVersion: "openpond.visibleAgentTrajectory.v1" as const,
    conversation: [
      { index: 0, role: "user" as const, name: null, content: "Please resolve the blocked work item." },
      { index: 1, role: "assistant" as const, name: null, content: "I can inspect and resolve it." },
    ],
    toolEvents: [{
      index: 2,
      name: "get_work_item",
      arguments: { itemId: "item-17" },
      result: { status: "blocked", actionable: true },
      status: "succeeded" as const,
    }],
    runtimeEvents: [{ index: 3, type: "confirmation_received", detail: { approved: true } }],
    finalVisibleState: { resolution: "work_item_completed" },
    escalation: { requested: false, reason: null, handoff: null },
    termination: { terminal: true, truncated: false, reason: "resolved" },
  };
}
