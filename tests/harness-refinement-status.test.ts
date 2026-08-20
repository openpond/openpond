import { describe, expect, test } from "vitest";

import { appendHarnessRefinementStatus } from "../apps/web/src/lib/chat-activities";
import type { ChatMessage } from "../apps/web/src/lib/app-models";

describe("Harness refinement status", () => {
  test("retains routine queued and no-action background reviews in chat", () => {
    const messages: ChatMessage[] = [];

    appendHarnessRefinementStatus(messages, {
      id: "refiner-queued",
      sessionId: "session-a",
      turnId: "turn-a",
      name: "harness.refiner.queued",
      timestamp: "2026-08-06T12:00:00.000Z",
      source: "server",
      status: "pending",
    });
    appendHarnessRefinementStatus(messages, {
      id: "refiner-completed",
      sessionId: "session-a",
      turnId: "turn-a",
      name: "harness.refiner.completed",
      timestamp: "2026-08-06T12:00:01.000Z",
      source: "server",
      status: "completed",
      output: "The turn contains no reusable improvement.",
      data: {
        outcome: {
          id: "outcome-a",
          contentHash: "hash-a",
          decision: "no_action",
          routed: false,
          route: null,
        },
        proposal: null,
        workspaceAdvance: null,
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "activity_group",
      turnId: "turn-a",
      refinerActivity: {
        state: "completed",
        result: "no_action",
        decision: "no_action",
      },
    });
  });

  test("labels a routed recommendation instead of reporting no reusable change", () => {
    const messages: ChatMessage[] = [];

    appendHarnessRefinementStatus(messages, {
      id: "refiner-completed",
      sessionId: "session-a",
      turnId: "turn-a",
      name: "harness.refiner.completed",
      timestamp: "2026-08-06T12:00:00.000Z",
      source: "server",
      status: "completed",
      output: "Routed to runtime: Work compute could not start.",
      data: {
        outcome: {
          id: "outcome-a",
          contentHash: "hash-a",
          decision: "no_action",
          routed: true,
          route: "runtime",
        },
        proposal: null,
        workspaceAdvance: null,
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "activity_group",
      turnId: "turn-a",
      refinerActivity: {
        state: "completed",
        result: "routed",
        decision: "route",
        route: "runtime",
      },
    });
  });
});
