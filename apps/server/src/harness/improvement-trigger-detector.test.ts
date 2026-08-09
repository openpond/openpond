import { describe, expect, test } from "vitest";

import type { ImprovementSafeBoundary, RuntimeEvent } from "@openpond/contracts";

import {
  DEFAULT_REFINEMENT_TRIGGER_POLICY,
  detectHarnessImprovementAtBoundary,
} from "./improvement-trigger-detector.js";

const HASH = "a".repeat(64);
const AT = "2026-08-05T12:00:00.000Z";
const harnessRelease = { id: "harness-release-a", contentHash: HASH };

function boundary(kind: ImprovementSafeBoundary["kind"]): ImprovementSafeBoundary {
  return { kind, eventSequence: 10, occurredAt: AT };
}

function toolEvent(input: {
  id: string;
  sequence: number;
  status: "started" | "completed" | "failed";
  output?: string;
  action?: string;
  callId?: string;
  args?: Record<string, unknown>;
  data?: Record<string, unknown>;
}): RuntimeEvent {
  return {
    id: input.id,
    sequence: input.sequence,
    sessionId: "session-a",
    turnId: "turn-a",
    name: input.status === "started" ? "tool.started" : "tool.completed",
    timestamp: AT,
    source: "provider",
    action: input.action ?? "exec_command",
    status: input.status,
    output: input.output,
    error: input.status === "failed" ? input.output : undefined,
    args: input.args,
    data: { toolCallId: input.callId ?? input.id, ...input.data },
  };
}

function detect(
  events: RuntimeEvent[],
  kind: ImprovementSafeBoundary["kind"] = "completed_tool_batch",
) {
  return detectHarnessImprovementAtBoundary({
    runRef: "run-a",
    turnId: "turn-a",
    harnessRelease,
    overlay: null,
    events,
    boundary: boundary(kind),
  });
}

describe("Harness improvement trigger detector", () => {
  test("does nothing for an ordinary successful tool batch", () => {
    const result = detect([
      toolEvent({ id: "start-a", sequence: 1, status: "started", callId: "call-a" }),
      toolEvent({ id: "done-a", sequence: 2, status: "completed", callId: "call-a" }),
    ]);
    expect(result.observations).toEqual([]);
    expect(result.trigger.decision).toBe("no_action");
    expect(result.trigger.estimatedMaxCostUsd).toBe(0);
  });

  test("records an open failure but waits for recovery at a tool-batch boundary", () => {
    const result = detect([
      toolEvent({ id: "failed-a", sequence: 1, status: "failed", output: "Exit code 1" }),
    ]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "tool_failure",
      state: "open",
      deterministicClass: "command_exit_nonzero",
    });
    expect(result.trigger.decision).toBe("no_action");
  });

  test("does not treat internal workspace cleanup as recovery", () => {
    const result = detect([
      toolEvent({
        id: "failed-environment",
        sequence: 1,
        status: "failed",
        action: "work_environment",
        output: "Work sandbox entered error during startup.",
      }),
      {
        id: "sandbox-stop-result",
        sequence: 2,
        sessionId: "session-a",
        turnId: "turn-a",
        name: "workspace_action_result",
        timestamp: AT,
        source: "server",
        action: "sandbox_stop",
        status: "completed",
        output: "Stopped sandbox.",
      },
    ]);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "tool_failure",
      state: "open",
      tool: { name: "work_environment" },
    });
    expect(result.trigger.decision).toBe("no_action");
  });

  test("queues the Refiner for a recovered missing dependency so it can choose the correct layer", () => {
    const result = detect([
      toolEvent({
        id: "failed-a",
        sequence: 1,
        status: "failed",
        output: "ModuleNotFoundError: No module named 'docx'",
        callId: "call-a",
      }),
      toolEvent({
        id: "retry-a",
        sequence: 2,
        status: "started",
        callId: "call-b",
        args: { command: "use bundled document runtime" },
      }),
      toolEvent({ id: "done-a", sequence: 3, status: "completed", callId: "call-b" }),
    ]);
    expect(result.observations.map((item) => item.kind)).toEqual([
      "tool_failure",
      "retry",
      "recovery",
    ]);
    expect(result.trigger).toMatchObject({
      decision: "queue_refiner",
      deterministicRoute: null,
      estimatedMaxCostUsd: 0.01,
    });
  });

  test("queues a bounded Refiner for an unclassified recovered detour", () => {
    const result = detect([
      toolEvent({ id: "failed-a", sequence: 1, status: "failed", output: "Unexpected converter response" }),
      toolEvent({ id: "done-a", sequence: 2, status: "completed" }),
    ]);
    expect(result.trigger.decision).toBe("queue_refiner");
    expect(result.trigger.suggestedRoutes).toEqual([]);
    expect(result.trigger.estimatedMaxCostUsd).toBeLessThanOrEqual(
      DEFAULT_REFINEMENT_TRIGGER_POLICY.maxEstimatedCostUsd,
    );
  });

  test("does not classify a nonzero command as a timeout from timeout configuration fields", () => {
    const result = detect([
      toolEvent({
        id: "failed-a",
        sequence: 1,
        status: "failed",
        output: JSON.stringify({ timeoutSeconds: 30, timedOut: false }),
        data: {
          result: {
            exitCode: 1,
            timedOut: false,
            timeoutSeconds: 30,
            stderr: "Error: RECOVERABLE_COMMAND_SYNTAX",
          },
        },
      }),
      toolEvent({ id: "done-a", sequence: 2, status: "completed" }),
    ]);
    expect(result.observations[0]?.deterministicClass).toBe(
      "command_exit_nonzero",
    );
  });

  test("marks an earlier failure recovered when the turn later succeeds", () => {
    const result = detect(
      [
        toolEvent({ id: "failed-a", sequence: 1, status: "failed", output: "Unexpected converter response" }),
        toolEvent({ id: "done-a", sequence: 2, status: "completed" }),
      ],
      "turn_completed",
    );
    expect(result.observations.find((item) => item.kind === "tool_failure")?.state).toBe(
      "recovered",
    );
    expect(result.observations.some((item) => item.state === "terminal")).toBe(false);
  });

  test("queues research-budget recovery without preselecting a route", () => {
    const result = detect([
      toolEvent({
        id: "failed-a",
        sequence: 1,
        status: "failed",
        output: "Research limit reached",
        action: "web_search",
      }),
      toolEvent({
        id: "done-a",
        sequence: 2,
        status: "completed",
        action: "web_search",
      }),
    ]);
    expect(result.trigger.decision).toBe("queue_refiner");
    expect(result.trigger.suggestedRoutes).toEqual([]);
  });

  test("records recovery through a different fallback tool", () => {
    const result = detect([
      toolEvent({
        id: "failed-fetch",
        sequence: 1,
        status: "failed",
        output: "Research limit reached",
        action: "web_fetch",
      }),
      toolEvent({
        id: "connected-app-result",
        sequence: 2,
        status: "completed",
        action: "connected_app_search",
      }),
    ]);
    expect(result.observations.map((item) => item.kind)).toEqual([
      "tool_failure",
      "recovery",
    ]);
    expect(result.observations.at(-1)?.summary).toMatch(
      /connected_app_search recovered after web_fetch failed/i,
    );
    expect(result.trigger.decision).toBe("queue_refiner");
  });

  test.each([
    "Hey, you messed this up; do this instead.",
    "Here is another detail for the work.",
  ])("reviews every completed user turn without classifying its wording: %s", (prompt) => {
    const userTurn: RuntimeEvent = {
      id: "turn-started-user-evidence",
      sequence: 1,
      sessionId: "session-a",
      turnId: "turn-a",
      name: "turn.started",
      timestamp: AT,
      source: "server",
      status: "started",
      args: { prompt },
    };
    const result = detectHarnessImprovementAtBoundary({
      runRef: "run-a",
      turnId: "turn-a",
      harnessRelease,
      overlay: null,
      events: [userTurn],
      boundary: boundary("turn_completed"),
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "user_turn",
      deterministicClass: null,
    });
    expect(result.trigger.decision).toBe("queue_refiner");
    expect(result.trigger.suggestedRoutes).toEqual([]);
  });

  test("deduplicates equivalent routed evidence and treats terminal failure as actionable", () => {
    const terminal = detect(
      [toolEvent({ id: "failed-a", sequence: 1, status: "failed", output: "Unexpected failure" })],
      "turn_completed",
    );
    expect(terminal.observations[0]?.state).toBe("terminal");
    expect(terminal.trigger.decision).toBe("queue_refiner");

    const duplicate = detectHarnessImprovementAtBoundary({
      runRef: "run-a",
      turnId: "turn-a",
      harnessRelease,
      overlay: null,
      events: [toolEvent({ id: "failed-a", sequence: 1, status: "failed", output: "Unexpected failure" })],
      boundary: boundary("turn_completed"),
      priorDeduplicationKeys: new Set([terminal.trigger.deduplicationKey]),
    });
    expect(duplicate.trigger.decision).toBe("no_action");
    expect(duplicate.trigger.reason).toMatch(/already routed/i);
  });

  test("coalesces an end-of-turn review after an earlier recovered batch queued one", () => {
    const result = detectHarnessImprovementAtBoundary({
      runRef: "run-a",
      turnId: "turn-a",
      harnessRelease,
      overlay: null,
      events: [
        {
          id: "turn-started",
          sequence: 1,
          sessionId: "session-a",
          turnId: "turn-a",
          name: "turn.started",
          timestamp: AT,
          source: "chat_action",
          status: "started",
          args: { prompt: "Make the report." },
        },
      ],
      boundary: boundary("turn_completed"),
      turnReviewAlreadyQueued: true,
    });

    expect(result.observations).toEqual([
      expect.objectContaining({ kind: "user_turn" }),
    ]);
    expect(result.trigger).toMatchObject({
      decision: "no_action",
      estimatedMaxCostUsd: 0,
    });
    expect(result.trigger.reason).toMatch(/already has a queued/i);
  });
});
