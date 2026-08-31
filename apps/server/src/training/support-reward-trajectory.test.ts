import { describe, expect, test } from "vitest";

import { SupportVisibleTrajectorySchema } from "./support-reward-trajectory.js";

describe("support Reward Model trajectory input", () => {
  test("accepts bounded policy-visible support evidence", () => {
    expect(SupportVisibleTrajectorySchema.parse(trajectory())).toMatchObject({
      schemaVersion: "openpond.supportVisibleTrajectory.v1",
      termination: { terminal: true, truncated: false },
    });
  });

  test("rejects privileged answers and reward leakage anywhere in the trace", () => {
    expect(() => SupportVisibleTrajectorySchema.parse({
      ...trajectory(),
      finalVisibleState: {
        orderStatus: "refunded",
        hiddenObjective: "Issue exactly 12.34 USD.",
      },
    })).toThrow("forbidden privileged field hiddenObjective");
    expect(() => SupportVisibleTrajectorySchema.parse({
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
    schemaVersion: "openpond.supportVisibleTrajectory.v1" as const,
    conversation: [
      { index: 0, role: "customer" as const, name: null, content: "My order arrived damaged." },
      { index: 1, role: "assistant" as const, name: null, content: "I can help with a replacement." },
    ],
    toolEvents: [{
      index: 2,
      name: "get_order",
      arguments: { orderId: "order-17" },
      result: { status: "delivered", damaged: true },
      status: "succeeded" as const,
    }],
    runtimeEvents: [{ index: 3, type: "confirmation_received", detail: { approved: true } }],
    finalVisibleState: { resolution: "replacement_created" },
    escalation: { requested: false, reason: null, handoff: null },
    termination: { terminal: true, truncated: false, reason: "resolved" },
  };
}
