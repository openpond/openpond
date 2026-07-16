import { describe, expect, test } from "vitest";
import { buildChatMessagesForProvider } from "../apps/server/src/openpond/hosted-chat";

describe("hosted chat compaction projection", () => {
  test("injects preserved resource refs from compaction metadata", () => {
    const messages = buildChatMessagesForProvider(
      [
        { id: "turn_old", name: "turn.started", args: { prompt: "old user request" } },
        {
          id: "compact_1",
          name: "session.compaction.completed",
          data: {
            summary: "Goal and resource state were compacted.",
            preservedResourceRefs: ["goal-context:goal_event", "workspace:file:README.md"],
          },
        },
      ],
      "next request",
      "system prompt",
    );

    expect(messages[1]?.content).toContain("Preserved resource refs:");
    expect(messages[1]?.content).toContain("- goal-context:goal_event");
    expect(messages[1]?.content).toContain("- workspace:file:README.md");
  });

  test("filters preserved tail by preserved event ids when a turn was split", () => {
    const messages = buildChatMessagesForProvider(
      [
        { id: "turn_old", name: "turn.started", args: { prompt: "old user request" } },
        { id: "assistant_old", name: "assistant.delta", output: "old assistant answer" },
        { id: "turn_huge", name: "turn.started", args: { prompt: "huge recent request" } },
        { id: "tool_huge", name: "command.output", output: "large tool output should stay summarized" },
        { id: "assistant_final", name: "assistant.delta", output: "latest final answer" },
        {
          id: "compact_1",
          name: "session.compaction.completed",
          data: {
            summary: "Earlier history and the huge tool output were compacted.",
            preservedFromEventId: "turn_huge",
            preservedEventIds: ["turn_huge", "assistant_final"],
          },
        },
      ],
      "next request",
      "system prompt",
    );

    expect(messages.map((message) => message.content)).toEqual([
      "system prompt",
      "Conversation summary from earlier turns:\n\nEarlier history and the huge tool output were compacted.\n\nUse this as continuity context. Do not mention compaction unless asked.",
      "huge recent request",
      "latest final answer",
      "next request",
    ]);
    expect(messages.some((message) => message.content.includes("old user request"))).toBe(false);
    expect(messages.some((message) => message.content.includes("large tool output"))).toBe(false);
  });

  test("projects preserved failure events as unresolved failure context", () => {
    const messages = buildChatMessagesForProvider(
      [
        { id: "turn_old", name: "turn.started", args: { prompt: "old user request" } },
        { id: "turn_failed", name: "turn.started", turnId: "failed_turn", args: { prompt: "run validation" } },
        {
          id: "failure_event",
          name: "turn.failed",
          turnId: "failed_turn",
          status: "failed",
          error: "FAIL tests/context-compaction.test.ts: expected failure label",
        },
        {
          id: "compact_1",
          name: "session.compaction.completed",
          data: {
            summary: "Older history was compacted.",
            preservedFromEventId: "turn_failed",
            preservedEventIds: ["turn_failed", "failure_event"],
          },
        },
      ],
      "next request",
      "system prompt",
    );

    expect(messages.map((message) => message.content)).toEqual([
      "system prompt",
      "Conversation summary from earlier turns:\n\nOlder history was compacted.\n\nUse this as continuity context. Do not mention compaction unless asked.",
      "run validation",
      "Recent unresolved failure (turn=failed_turn status=failed):\nFAIL tests/context-compaction.test.ts: expected failure label",
      "next request",
    ]);
  });
});
