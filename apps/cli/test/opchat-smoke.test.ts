import { afterEach, describe, expect, test } from "vitest";

import { runOpChatSmoke } from "../src/opchat-smoke";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpChat smoke helper", () => {
  test("validates models, chat, streaming, deterministic errors, and tools", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> =
      [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      requests.push({ url, body });

      if (url.endsWith("/models")) {
        return jsonResponse({
          object: "list",
          data: [
            { id: "openpond-chat", object: "model" },
            { id: "deepseek-v4-flash", object: "model" },
          ],
        });
      }
      if (url.endsWith("/models/not-a-real-opchat-model")) {
        return jsonResponse(
          {
            error: {
              code: "model_not_found",
              type: "invalid_request_error",
              message: "model not found",
            },
          },
          404
        );
      }
      if (url.endsWith("/models/openpond-chat")) {
        return jsonResponse({ id: "openpond-chat", object: "model" });
      }
      if (url.endsWith("/models/deepseek-v4-flash")) {
        return jsonResponse({ id: "deepseek-v4-flash", object: "model" });
      }
      if (url.endsWith("/chat/completions") && body?.stream === true) {
        return streamResponse([
          'data: {"choices":[{"delta":{"content":"stream "},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}\n\n',
          "data: [DONE]\n\n",
        ]);
      }
      if (url.endsWith("/chat/completions") && body?.tool_choice) {
        return jsonResponse({
          id: "chatcmpl_tool",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_weather",
                    type: "function",
                    function: {
                      name: "get_current_weather",
                      arguments: '{"location":"Boston, MA"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { total_tokens: 9 },
        });
      }
      if (
        url.endsWith("/chat/completions") &&
        Array.isArray(body?.messages) &&
        body.messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { role?: unknown }).role === "tool"
        )
      ) {
        return completionResponse("chatcmpl_tool_final", "tool result ok");
      }
      if (
        url.endsWith("/chat/completions") &&
        body?.model === "deepseek-v4-flash"
      ) {
        return completionResponse("chatcmpl_compat", "compat ok");
      }
      if (url.endsWith("/chat/completions")) {
        return completionResponse("chatcmpl_default", "default ok");
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    };

    const logs: string[] = [];
    const summary = await runOpChatSmoke({
      apiBaseUrl: "https://api.example.test/opchat/v1",
      token: "opk_test",
      log: (line) => logs.push(line),
    });

    expect(summary.listedModels).toEqual([
      "openpond-chat",
      "deepseek-v4-flash",
    ]);
    expect(summary.modelLookups).toEqual([
      "openpond-chat",
      "deepseek-v4-flash",
    ]);
    expect(summary.invalidModelError).toContain("model_not_found");
    expect(summary.nonStreaming).toMatchObject({
      id: "chatcmpl_default",
      textPreview: "default ok",
      usage: { total_tokens: 5 },
    });
    expect(summary.streaming).toMatchObject({
      textDeltaCount: 2,
      finishReason: "stop",
      usage: { total_tokens: 7 },
    });
    expect(summary.compatibilityNonStreaming).toMatchObject({
      id: "chatcmpl_compat",
      textPreview: "compat ok",
    });
    expect(summary.toolCalling).toMatchObject({
      toolCallCount: 1,
      toolNames: ["get_current_weather"],
      finishReason: "tool_calls",
      followUp: { textPreview: "tool result ok" },
    });
    expect(logs.some((line) => line.includes("opk_test"))).toBe(false);
    expect(requests.map((request) => request.url)).toContain(
      "https://api.example.test/opchat/v1/models/not-a-real-opchat-model"
    );
    expect(
      requests.some(
        (request) =>
          request.url.endsWith("/chat/completions") &&
          request.body?.tool_choice === "auto"
      )
    ).toBe(true);
  });
});

function completionResponse(id: string, content: string): Response {
  return jsonResponse({
    id,
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { total_tokens: 5 },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
