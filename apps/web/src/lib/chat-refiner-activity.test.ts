import type { RuntimeEvent } from "@openpond/contracts";
import { describe, expect, it } from "vitest";

import { buildChatMessages } from "./chat-messages";

const HASH = "a".repeat(64);

describe("Harness Refiner Work receipts", () => {
  it("merges an applied terminal receipt into the reviewed Work disclosure", () => {
    const messages = buildChatMessages([
      event("turn.started", { args: { prompt: "Create the report" } }),
      event("assistant.reasoning.delta", { output: "Checking the source" }),
      event("assistant.delta", { output: "Done." }),
      event("turn.completed"),
      refinerEvent("harness.refiner.queued", runningActivity()),
      refinerEvent("harness.refiner.completed", completedActivity("applied")),
    ]);

    const work = messages.find((message) => message.role === "activity_group");
    expect(work?.refinerActivity).toMatchObject({
      state: "completed",
      result: "applied",
      route: "skill",
      operation: "update",
      target: "skills/pdf/SKILL.md",
    });
    expect(messages.some((message) => message.statusKind === "harness_refinement")).toBe(false);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("retains clean no-action receipts in ordinary and evaluation Work", () => {
    const ordinary = buildChatMessages(baseEvents("material_only"));
    expect(ordinary.find((message) => message.refinerActivity)?.refinerActivity).toMatchObject({
      result: "no_action",
      visibility: "material_only",
    });

    const evaluation = buildChatMessages(baseEvents("always"));
    expect(evaluation.find((message) => message.refinerActivity)?.refinerActivity).toMatchObject({
      result: "no_action",
      visibility: "always",
    });
  });

  it("creates one receipt-only Work disclosure before the assistant and rebuilds identically", () => {
    const events = [
      event("turn.started", { args: { prompt: "Answer briefly" } }),
      event("assistant.delta", { output: "Answer." }),
      event("turn.completed"),
      refinerEvent("harness.refiner.completed", completedActivity("routed")),
    ];
    const first = buildChatMessages(events);
    const second = buildChatMessages(events);
    const workIndex = first.findIndex((message) => message.role === "activity_group");
    const assistantIndex = first.findIndex((message) => message.role === "assistant");

    expect(workIndex).toBeGreaterThan(0);
    expect(workIndex).toBeLessThan(assistantIndex);
    expect(first[workIndex]?.activities).toEqual([]);
    expect(first[workIndex]?.refinerActivity).toMatchObject({ result: "routed", route: "runtime" });
    expect(second).toEqual(first);
  });

  it("updates a temporary receipt-only Work disclosure after ordinary no-action", () => {
    const messages = buildChatMessages([
      event("turn.started", { args: { prompt: "Answer briefly" } }),
      event("assistant.delta", { output: "Answer." }),
      event("turn.completed"),
      refinerEvent("harness.refiner.queued", runningActivity()),
      refinerEvent("harness.refiner.completed", completedActivity("no_action")),
    ]);

    expect(messages.find((message) => message.role === "activity_group")?.refinerActivity)
      .toMatchObject({ state: "completed", result: "no_action" });
  });
});

function baseEvents(visibility: "always" | "material_only"): RuntimeEvent[] {
  return [
    event("turn.started", { args: { prompt: "Summarize this" } }),
    event("assistant.reasoning.delta", { output: "Reading" }),
    event("assistant.delta", { output: "Summary." }),
    event("turn.completed"),
    refinerEvent("harness.refiner.completed", {
      ...completedActivity("no_action"),
      visibility,
    }),
  ];
}

function runningActivity() {
  return {
    schemaVersion: "openpond.localHarnessRefinerActivityDisplay.v1",
    visibility: "material_only",
    state: "running",
    summary: "Reviewing this Work for a reusable improvement",
  };
}

function completedActivity(result: "applied" | "routed" | "no_action") {
  const proposal = result === "applied";
  const routed = result === "routed";
  return {
    schemaVersion: "openpond.localHarnessRefinerActivityDisplay.v1",
    visibility: "material_only",
    state: "completed",
    workspaceId: "workspace-1",
    result,
    decision: proposal ? "propose" : routed ? "route" : "no_action",
    route: proposal ? "skill" : routed ? "runtime" : null,
    operation: proposal ? "update" : null,
    target: proposal ? "skills/pdf/SKILL.md" : null,
    summary: proposal ? "Updated PDF skill" : routed ? "Runtime issue" : "No reusable change",
    expectedOutcome: proposal ? "Future PDF checks are reliable." : null,
    reason: "Bounded terminal reason.",
    evidenceBasis: null,
    critiqueStatus: proposal ? "passed" : "not_applicable",
    validationStatus: proposal ? "passed" : "not_applicable",
    validationReceipts: proposal
      ? [{ id: "validation-1", contentHash: HASH, status: "passed", summary: "Skill validation passed." }]
      : [],
    edits: proposal
      ? [{
          id: "edit-1",
          operation: "update",
          target: "skills/pdf/SKILL.md",
          summary: "Updated PDF skill",
          content: "New exact content",
        }]
      : [],
    trigger: { id: "trigger-1", contentHash: HASH },
    outcome: { id: "outcome-1", contentHash: HASH },
    proposal: proposal ? { id: "proposal-1", contentHash: HASH } : null,
    applyReceipt: proposal ? { id: "apply-1", contentHash: HASH } : null,
    advanceReceipt: proposal ? { id: "advance-1", contentHash: HASH } : null,
    inputHarness: { id: "harness-1", contentHash: HASH },
    outputHarness: proposal ? { id: "harness-2", contentHash: HASH } : null,
  };
}

function refinerEvent(name: RuntimeEvent["name"], activity: object): RuntimeEvent {
  return event(name, {
    status: name.endsWith("failed") ? "failed" : name.endsWith("completed") ? "completed" : "pending",
    data: { activity },
  });
}

let sequence = 0;
function event(
  name: RuntimeEvent["name"],
  input: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    sequence,
    sessionId: "session-1",
    turnId: "turn-1",
    name,
    timestamp: `2026-08-16T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...input,
  };
}
