import { describe, expect, test } from "bun:test";
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
});
