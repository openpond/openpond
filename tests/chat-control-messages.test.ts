import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";

import {
  activityGroupSummary,
  buildChatMessages,
} from "../apps/web/src/lib/chat-messages";

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp: "2026-05-16T00:00:00.000Z",
    ...input,
  };
}

describe("chat control message projection", () => {
  test("renders Codex control prompts as activity rows", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "goal_1",
        name: "turn.started",
        turnId: "turn_1",
        args: {
          prompt:
            "<goal_context>\nKeep the sidebar work in scope.\n</goal_context>",
        },
      }),
      runtimeEvent({
        id: "abort_1",
        name: "turn.interrupted",
        turnId: "turn_1",
        output: "The user interrupted the previous turn.",
        data: { kind: "turn_aborted" },
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("activity_group");
    expect(messages[0]?.activities?.map((activity) => activity.label)).toEqual([
      "Goal context",
    ]);
    expect(messages[0]?.activities?.[0]?.content).toBe(
      "Keep the sidebar work in scope.",
    );
    expect(messages[1]).toMatchObject({
      role: "status_divider",
      content: "The user interrupted the previous turn.",
      statusKind: "interruption",
      statusState: "failed",
      statusTone: "danger",
    });
  });

  test("summarizes single Codex control outcomes without generic context wording", () => {
    const goalContextMessages = buildChatMessages([
      runtimeEvent({
        id: "goal_1",
        name: "turn.started",
        turnId: "turn_1",
        args: {
          prompt: "<goal_context>\nContinue after compaction.\n</goal_context>",
        },
      }),
    ]);
    const interruptedMessages = buildChatMessages([
      runtimeEvent({
        id: "abort_1",
        name: "turn.interrupted",
        turnId: "turn_1",
        output: "The user interrupted the previous turn.",
        data: { kind: "turn_aborted" },
      }),
    ]);

    expect(
      activityGroupSummary(goalContextMessages[0]?.activities ?? []),
    ).toBe("Goal context updated");
    expect(interruptedMessages[0]).toMatchObject({
      role: "status_divider",
      content: "The user interrupted the previous turn.",
      statusKind: "interruption",
    });
  });
});
