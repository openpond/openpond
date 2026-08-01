import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createContextUsageSnapshot,
  estimateHostedMessageTokens,
  trustedProviderContextLimit,
  usableHostedContextLimit,
} from "../apps/server/dist/openpond/context-usage.js";
import { hostedAutoCompactionDecision } from "../apps/server/dist/openpond/context-compaction/index.js";
import { buildChatMessagesForProvider } from "../apps/server/dist/openpond/hosted-chat.js";
import { ProviderSettingsSchema } from "../packages/contracts/dist/index.js";

describe("hosted context usage", () => {
  test("resolves trusted provider context windows from model metadata", () => {
    const settings = ProviderSettingsSchema.parse({
      modelCaches: {
        openpond: {
          providerId: "openpond",
          source: "hosted",
          models: [
            {
              id: "accounts/fireworks/models/kimi-k3",
              providerId: "openpond",
              displayName: "Kimi K3",
              contextWindow: 1_048_576,
              source: "hosted",
            },
          ],
        },
        zai: {
          providerId: "zai",
          source: "curated",
          models: [
            {
              id: "glm-5.2",
              providerId: "zai",
              displayName: "GLM-5.2",
              contextWindow: 1_000_000,
              source: "curated",
            },
            {
              id: "glm-5.1",
              providerId: "zai",
              displayName: "GLM-5.1",
              contextWindow: 200_000,
              source: "curated",
            },
          ],
        },
      },
    });

    assert.equal(trustedProviderContextLimit({ provider: "zai", model: "glm-5.2", settings }), 1_000_000);
    assert.equal(trustedProviderContextLimit({ provider: "zai", model: "glm-5.1", settings }), 200_000);
    assert.equal(trustedProviderContextLimit({ provider: "zai", model: "unknown", settings }), null);
    assert.equal(
      trustedProviderContextLimit({
        provider: "openpond",
        model: "accounts/fireworks/models/kimi-k3",
        settings,
      }),
      1_048_576,
    );
  });

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

describe("hosted context projection", () => {
  test("anchors on the latest compaction summary and replays its preserved tail", () => {
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
    assert.deepEqual(messages.map((message) => message.content), [
      "system prompt",
      "Conversation summary from earlier turns:\n\nOld summary with the durable goal.\n\nUse this as continuity context. Do not mention compaction unless asked.",
      "recent user request",
      "recent assistant answer",
      "new request",
    ]);
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
      messages: [{ role: "user", content: "x".repeat(25500) }],
    });
    assert.equal(loudDecision.shouldCompact, true);
    assert.equal(loudDecision.thresholdTokens, 6375);
    assert.ok(loudDecision.projectedTokens >= loudDecision.thresholdTokens);
  });
});
