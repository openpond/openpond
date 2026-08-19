import { describe, expect, test, vi } from "vitest";

import {
  buildOpChatBody,
  streamOpChatChatCompletion,
} from "../src/chat.js";

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

  test("summarizes an HTML gateway error instead of retaining the whole page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<!DOCTYPE html><html><head><title>openpond.ai | 502: Bad gateway</title></head><body>large host error</body></html>",
      { status: 502, headers: { "content-type": "text/html" } },
    ));
    let failure: unknown = null;
    try {
      for await (const _delta of streamOpChatChatCompletion({
        apiBaseUrl: "https://staging-api.openpond.ai/opchat/v1",
        token: "test-token",
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      })) {
        // The mocked gateway response never yields a model delta.
      }
    } catch (error) {
      failure = error;
    } finally {
      fetchMock.mockRestore();
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "OpenPond OpChat request failed: 502 502: Bad gateway",
    );
    expect((failure as Error).message).not.toContain("<!DOCTYPE html>");
  });
});
