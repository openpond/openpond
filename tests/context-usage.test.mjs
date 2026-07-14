import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createContextUsageSnapshot,
  estimateHostedMessageTokens,
  usableHostedContextLimit,
} from "../apps/server/dist/openpond/context-usage.js";

describe("hosted context usage", () => {
  test("keeps small local-model context windows usable", () => {
    assert.equal(usableHostedContextLimit(1024), 768);
  });

  test("counts projected hosted messages for heuristic snapshots", () => {
    const messages = [
      { role: "system", content: "System prompt." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there." },
    ];
    const tokens = estimateHostedMessageTokens(messages);
    const snapshot = createContextUsageSnapshot({
      provider: "openpond",
      model: "openpond-chat",
      messages,
      updatedAtEventId: "evt_1",
    });

    assert.equal(snapshot.source, "heuristic");
    assert.equal(snapshot.usedTokens, tokens);
    assert.equal(snapshot.maxContextTokens, 128000);
    assert.equal(snapshot.usableContextTokens, usableHostedContextLimit(128000));
  });

  test("uses provider total tokens when available after a streamed response", () => {
    const snapshot = createContextUsageSnapshot({
      provider: "openpond",
      model: "openpond-chat",
      messages: [{ role: "user", content: "Write a short note." }],
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
      includeCompletion: true,
      updatedAtEventId: "evt_2",
    });

    assert.equal(snapshot.source, "provider_usage");
    assert.equal(snapshot.usedTokens, 1500);
    assert.equal(snapshot.percentFull, 1);
  });
});
