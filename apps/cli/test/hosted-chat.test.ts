import { afterEach, describe, expect, test } from "vitest";
import { runBoundedOpChat } from "../src/cli/opchat-bounded-chat";

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

  // Failure story: a CLI warm request must not dispatch outside its workspace,
  // quoted cap or deadline, or call an aborted provider request free/safe to retry.
  test("bounds a CLI call before dispatch and preserves uncertain cancellation", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    const receipts: Record<string, unknown>[] = [];
    const options = {
      model: "openpond/qwen3-8b-base", message: "Reply OK", teamId: "team_test",
      maxOutputTokens: "8", requestId: "warm-proof", timeoutSec: "1", maxSpend: "0.05",
    };
    const dependencies = {
      account: async () => ({ token: "session_test", chatApiBaseUrl: "https://api.example.test/opchat/v1" }),
      emit: (receipt: Record<string, unknown>) => { receipts.push(receipt); },
    };
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      if (init?.method === "GET") return jsonResponse({
        id: options.model, context_window: 8192, output_limit: 2048,
        metadata: { billing: { pricing: {
          version: "base-rate-v1", source: "openpond-serving", effectiveAt: "2026-10-05T00:00:00Z",
          inputUsdPerMillionTokens: 5, cachedInputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 20,
        } } },
      });
      if (new Headers(init?.headers).get("x-request-id") === "cancel-proof") {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return jsonResponse({
        id: "chatcmpl_test", model: options.model, request_id: options.requestId, provider_request_id: "pool/job",
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    };
    await expect(runBoundedOpChat({ ...options, opchatApiBaseUrl: "https://other.test" }, dependencies)).rejects.toThrow("origin");
    expect(requests).toHaveLength(0);
    await expect(runBoundedOpChat({ ...options, maxSpend: "0.04" }, dependencies)).rejects.toThrow("exceeds --max-spend");
    expect(requests.map(request => request.method)).toEqual(["GET"]);
    await runBoundedOpChat(options, dependencies);
    const posted = requests.filter(request => request.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe("https://api.example.test/opchat/v1/chat/completions");
    expect(posted[0]?.body).toMatchObject({
      model: options.model, max_tokens: 8, messages: [{ role: "user", content: "Reply OK" }], stream: false,
    });
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer session_test");
      expect(request.headers.get("x-openpond-team-id")).toBe("team_test");
    }
    expect(posted[0]?.headers.get("x-request-id")).toBe("warm-proof");
    expect(posted[0]?.headers.get("x-openpond-request-id")).toBe("warm-proof");
    expect(receipts.at(-1)).toMatchObject({
      status: "completed", quote: { maximumRequestCostUsd: 0.04112 },
      completion: { id: "chatcmpl_test", request_id: "warm-proof", provider_request_id: "pool/job" },
      usage: { total_tokens: 5 }, accounting: { chargedUsd: null, requiresLedgerReconciliation: true },
    });
    await expect(runBoundedOpChat({ ...options, requestId: "cancel-proof" }, dependencies)).rejects.toThrow("deadline");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(2);
    expect(receipts.at(-1)).toMatchObject({
      status: "timed_out", requestId: "cancel-proof", dispatchAttempted: true,
      accounting: { state: "unknown", chargedUsd: null, cleanupConfirmed: false },
    });
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
