import { describe, expect, test } from "vitest";

import { buildOpChatBody } from "../src/chat.js";

describe("OpenPond hosted chat request", () => {
  test("forwards the pinned benchmark sampling policy", () => {
    expect(buildOpChatBody({
      model: "openpond-chat",
      messages: [{ role: "user", content: "hello" }],
      reasoningEffort: "high",
      maxTokens: 4_096,
      temperature: 0,
      topP: 1,
    }, false)).toMatchObject({
      model: "openpond-chat",
      stream: false,
      max_tokens: 4_096,
      temperature: 0,
      top_p: 1,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });
});
