import { afterEach, describe, expect, test } from "bun:test";

import {
  getOpChatModel,
  getOpChatProvider,
  listOpChatModels,
  listOpChatProviders,
  resolveHostedChatApiBaseUrl,
  resolveOpChatApiBaseUrl,
  sendHostedChatTurn,
  streamHostedChatTurn,
} from "../src/hosted-chat";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpChat hosted chat client", () => {
  test("resolves explicit OpChat base URLs before legacy chat settings", () => {
    expect(
      resolveOpChatApiBaseUrl({
        opChatApiBaseUrl:
          "https://api.qa.openpond.example/opchat/v1/chat/completions",
        chatApiBaseUrl: "https://legacy.example/v1",
      })
    ).toBe("https://api.qa.openpond.example/opchat/v1");
  });

  test("normalizes legacy chat and API bases to the OpChat route root", () => {
    expect(
      resolveOpChatApiBaseUrl({
        chatApiBaseUrl: "https://gateway.openpond.dev/v1",
      })
    ).toBe("https://gateway.openpond.dev/opchat/v1");
    expect(
      resolveHostedChatApiBaseUrl({
        apiBaseUrl: "https://api.qa.openpond.example",
      })
    ).toBe("https://api.qa.openpond.example/opchat/v1");
  });

  test("uses OPENPOND_OPCHAT_API_URL as the environment override", () => {
    expect(
      resolveOpChatApiBaseUrl({
        env: {
          OPENPOND_OPCHAT_API_URL:
            "https://api.example.test/opchat/v1/models/openpond-chat",
          OPENPOND_CHAT_API_URL: "https://legacy.example/v1",
        },
      })
    ).toBe("https://api.example.test/opchat/v1");
  });

  test("lists and retrieves OpChat models from /opchat/v1/models", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      if (String(input).endsWith("/models/openpond-chat")) {
        return jsonResponse({ id: "openpond-chat", object: "model" });
      }
      return jsonResponse({
        object: "list",
        data: [{ id: "openpond-chat", object: "model" }],
      });
    };

    await expect(
      listOpChatModels({
        apiBaseUrl: "https://api.openpond.ai/opchat/v1",
        token: "opk_test",
      })
    ).resolves.toMatchObject({
      data: [{ id: "openpond-chat" }],
    });
    await expect(
      getOpChatModel({
        apiBaseUrl: "https://api.openpond.ai/opchat/v1",
        token: "opk_test",
        model: "openpond-chat",
      })
    ).resolves.toMatchObject({ id: "openpond-chat" });

    expect(requests).toEqual([
      "https://api.openpond.ai/opchat/v1/models",
      "https://api.openpond.ai/opchat/v1/models/openpond-chat",
    ]);
  });

  test("lists and retrieves OpChat providers from /opchat/v1/providers", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      if (String(input).endsWith("/providers/openpond")) {
        return jsonResponse({
          id: "openpond",
          object: "provider",
          display_name: "OpenPond Chat",
        });
      }
      return jsonResponse({
        object: "list",
        data: [
          {
            id: "openpond",
            object: "provider",
            display_name: "OpenPond Chat",
          },
        ],
      });
    };

    await expect(
      listOpChatProviders({
        apiBaseUrl: "https://api.openpond.ai/opchat/v1",
        token: "opk_test",
      })
    ).resolves.toMatchObject({
      data: [{ id: "openpond" }],
    });
    await expect(
      getOpChatProvider({
        apiBaseUrl: "https://api.openpond.ai/opchat/v1",
        token: "opk_test",
        provider: "openpond",
      })
    ).resolves.toMatchObject({ id: "openpond" });

    expect(requests).toEqual([
      "https://api.openpond.ai/opchat/v1/providers",
      "https://api.openpond.ai/opchat/v1/providers/openpond",
    ]);
  });

  test("sends non-streaming chat completions to /opchat/v1/chat/completions", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      return jsonResponse({
        id: "chatcmpl_test",
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    };

    await expect(
      sendHostedChatTurn({
        apiBaseUrl: "https://api.openpond.ai/opchat/v1",
        token: "opk_test",
        model: "openpond-chat",
        messages: [{ role: "user", content: "hello" }],
      })
    ).resolves.toMatchObject({
      id: "chatcmpl_test",
      usage: { total_tokens: 5 },
    });

    expect(requests).toEqual([
      {
        url: "https://api.openpond.ai/opchat/v1/chat/completions",
        body: {
          model: "openpond-chat",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
      },
    ]);
  });

  test("sends OpenAI chat tools and preserves assistant tool calls", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      return jsonResponse({
        id: "chatcmpl_tool",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "lookup_price",
                    arguments: '{"symbol":"OPND"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    };

    await expect(
      sendHostedChatTurn({
        apiBaseUrl: "https://api.openpond.ai/opchat/v1",
        token: "opk_test",
        model: "openpond-chat",
        messages: [{ role: "user", content: "lookup OPND" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_price",
              parameters: {
                type: "object",
                properties: { symbol: { type: "string" } },
                required: ["symbol"],
              },
            },
          },
        ],
        toolChoice: {
          type: "function",
          function: { name: "lookup_price" },
        },
      })
    ).resolves.toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_123",
                function: { name: "lookup_price" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    expect(requests[0]).toMatchObject({
      url: "https://api.openpond.ai/opchat/v1/chat/completions",
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_price",
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "lookup_price" },
        },
      },
    });
  });

  test("parses streaming chat completion chunks from OpChat SSE", async () => {
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":5}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }
      );

    const chunks = [];
    for await (const chunk of streamHostedChatTurn({
      apiBaseUrl: "https://api.openpond.ai/opchat/v1",
      token: "opk_test",
      model: "openpond-chat",
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        type: "text_delta",
        text: "hel",
        raw: {
          choices: [{ delta: { content: "hel" }, finish_reason: null }],
        },
      },
      {
        type: "text_delta",
        text: "lo",
        raw: {
          choices: [{ delta: { content: "lo" }, finish_reason: null }],
        },
      },
      {
        type: "usage",
        usage: { total_tokens: 5 },
        raw: {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { total_tokens: 5 },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        raw: {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { total_tokens: 5 },
        },
      },
    ]);
  });

  test("parses streaming tool call deltas from OpChat SSE", async () => {
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_123","type":"function","function":{"name":"lookup_price","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }
      );

    const chunks = [];
    for await (const chunk of streamHostedChatTurn({
      apiBaseUrl: "https://api.openpond.ai/opchat/v1",
      token: "opk_test",
      model: "openpond-chat",
      messages: [{ role: "user", content: "lookup OPND" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        type: "tool_call_delta",
        toolCalls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "lookup_price", arguments: "{}" },
          },
        ],
        raw: {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_123",
                    type: "function",
                    function: { name: "lookup_price", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        type: "finish",
        finishReason: "tool_calls",
        raw: {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
        },
      },
    ]);
  });

  test("includes OpenAI error object codes in hosted errors", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "model_not_found",
            type: "invalid_request_error",
            message: "No model named missing-model.",
          },
        },
        404
      );

    await expect(
      getOpChatModel({
        apiBaseUrl: "https://api.openpond.ai/opchat/v1",
        token: "opk_test",
        model: "missing-model",
      })
    ).rejects.toThrow("model_not_found");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
