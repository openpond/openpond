import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hostedAutoCompactionDecision } from "../apps/server/dist/openpond/context-compaction.js";
import { buildChatMessagesForProvider } from "../apps/server/dist/openpond/hosted-chat.js";

describe("hosted context projection", () => {
  test("anchors on latest compaction summary and replays preserved tail", () => {
    const events = [
      { id: "turn_old", name: "turn.started", args: { prompt: "old user request" } },
      { id: "assistant_old", name: "assistant.delta", output: "old assistant answer" },
      { id: "turn_recent", name: "turn.started", args: { prompt: "recent user request" } },
      { id: "assistant_recent", name: "assistant.delta", output: "recent assistant answer" },
      {
        id: "compact_1",
        name: "session.compaction.completed",
        data: {
          summary: "Old summary with the durable goal.",
          preservedFromEventId: "turn_recent",
        },
      },
    ];

    const messages = buildChatMessagesForProvider(events, "new request", "system prompt");
    assert.equal(messages[0].role, "system");
    assert.match(messages[1].content, /Old summary with the durable goal/);
    assert.deepEqual(
      messages.map((message) => message.content),
      [
        "system prompt",
        "Conversation summary from earlier turns:\n\nOld summary with the durable goal.\n\nUse this as continuity context. Do not mention compaction unless asked.",
        "recent user request",
        "recent assistant answer",
        "new request",
      ]
    );
    assert.equal(messages.some((message) => message.content.includes("old user request")), false);
  });

  test("replays only events after compaction when there is no preserved tail", () => {
    const events = [
      { id: "turn_old", name: "turn.started", args: { prompt: "old user request" } },
      {
        id: "compact_1",
        name: "session.compaction.completed",
        data: { summary: "Compacted state." },
      },
      { id: "turn_after", name: "turn.started", args: { prompt: "after compact" } },
    ];

    const messages = buildChatMessagesForProvider(events, "next", "system prompt");
    assert.deepEqual(messages.map((message) => message.content), [
      "system prompt",
      "Conversation summary from earlier turns:\n\nCompacted state.\n\nUse this as continuity context. Do not mention compaction unless asked.",
      "after compact",
      "next",
    ]);
  });

  test("auto compaction triggers near the usable hosted context threshold", () => {
    const quietDecision = hostedAutoCompactionDecision({
      provider: "openpond",
      model: "openpond-10k",
      messages: [{ role: "user", content: "short request" }],
    });
    assert.equal(quietDecision.shouldCompact, false);
    assert.equal(quietDecision.maxContextTokens, 10000);

    const loudDecision = hostedAutoCompactionDecision({
      provider: "openpond",
      model: "openpond-10k",
      messages: [{ role: "user", content: "x".repeat(7200) }],
    });
    assert.equal(loudDecision.shouldCompact, true);
    assert.equal(loudDecision.thresholdTokens, 1700);
    assert.ok(loudDecision.projectedTokens >= loudDecision.thresholdTokens);
  });
});
