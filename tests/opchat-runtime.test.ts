import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  listOpChatModels,
  listOpChatProviders,
  streamOpChatChatCompletion,
} from "../packages/runtime/src/chat";
import {
  DEFAULT_OPENPOND_OPCHAT_API_BASE_URL,
  resolveHostedChatApiBaseUrl,
} from "../packages/runtime/src/urls";
import { HOSTED_CHAT_SYSTEM_PROMPT } from "../apps/server/src/constants";

const originalFetch = globalThis.fetch;
const originalOpChatUrl = process.env.OPENPOND_OPCHAT_API_URL;
const originalChatUrl = process.env.OPENPOND_CHAT_API_URL;

beforeEach(() => {
  delete process.env.OPENPOND_OPCHAT_API_URL;
  delete process.env.OPENPOND_CHAT_API_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("OPENPOND_OPCHAT_API_URL", originalOpChatUrl);
  restoreEnv("OPENPOND_CHAT_API_URL", originalChatUrl);
});

describe("OpenPond runtime OpChat routing", () => {
  test("guides OpenPond Chat to emit markdown image syntax when asked to show images", () => {
    expect(HOSTED_CHAT_SYSTEM_PROMPT).toContain("Markdown image syntax");
    expect(HOSTED_CHAT_SYSTEM_PROMPT).toContain("![description](path-or-url)");
    expect(HOSTED_CHAT_SYSTEM_PROMPT).toContain("instead of a bare path or raw HTML");
  });

  test("keeps exposed reasoning prose-only", () => {
    expect(HOSTED_CHAT_SYSTEM_PROMPT).toContain("If you emit reasoning or thinking content");
    expect(HOSTED_CHAT_SYSTEM_PROMPT).toContain("keep it sparse and user-readable");
    expect(HOSTED_CHAT_SYSTEM_PROMPT).toContain("Omit reasoning for routine searches, reads, tool calls");
    expect(HOSTED_CHAT_SYSTEM_PROMPT).toContain("Do not restate the user request, narrate every action");
    expect(HOSTED_CHAT_SYSTEM_PROMPT).toContain("Put necessary code or exact snippets only in the final assistant answer");
  });

  test("resolves hosted chat bases to the OpChat route root", () => {
    expect(resolveHostedChatApiBaseUrl(null, {}, "https://api.openpond.ai")).toBe(
      DEFAULT_OPENPOND_OPCHAT_API_BASE_URL,
    );
    expect(resolveHostedChatApiBaseUrl(null, {}, "https://api.qa.openpond.example")).toBe(
      "https://api.qa.openpond.example/opchat/v1",
    );
    expect(
      resolveHostedChatApiBaseUrl(
        { handle: "qa", chatApiBaseUrl: "https://api.qa.openpond.example/v1/chat/completions" },
        {},
        "https://api.openpond.ai",
      ),
    ).toBe("https://api.qa.openpond.example/opchat/v1");
    expect(
      resolveHostedChatApiBaseUrl(
        {
          handle: "qa",
          chatApiBaseUrl: "https://api.qa.openpond.example/opchat/v1/chat/completions",
        },
        {},
        "https://api.openpond.ai",
      ),
    ).toBe("https://api.qa.openpond.example/opchat/v1");
    expect(
      resolveHostedChatApiBaseUrl(
        {
          handle: "staging",
          chatApiBaseUrl:
            "https://api.openpond.ai/opchat/v1",
        },
        {},
        "https://api.openpond.ai",
      ),
    ).toBe("https://api.openpond.ai/opchat/v1");
  });

  test("lists models from /opchat/v1/models", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return jsonResponse({
        object: "list",
        data: [{ id: "openpond-chat" }, { id: "deepseek-v4-flash" }],
      });
    };

    const result = await listOpChatModels({
      apiBaseUrl: "https://api.example.test/opchat/v1/",
      token: "opk_test",
    });

    expect(requests).toEqual(["https://api.example.test/opchat/v1/models"]);
    expect(result.data.map((model) => model.id)).toEqual(["openpond-chat", "deepseek-v4-flash"]);
  });

  test("lists providers from /opchat/v1/providers", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return jsonResponse({
        object: "list",
        data: [
          {
            id: "openpond",
            object: "provider",
            display_name: "OpenPond Chat",
            model_ids: ["openpond-chat"],
          },
          {
            id: "openrouter",
            object: "provider",
            display_name: "OpenRouter",
            model_ids: [],
          },
        ],
      });
    };

    const result = await listOpChatProviders({
      apiBaseUrl: "https://api.example.test/opchat/v1/",
      token: "opk_test",
    });

    expect(requests).toEqual(["https://api.example.test/opchat/v1/providers"]);
    expect(result.data.map((provider) => provider.id)).toEqual(["openpond", "openrouter"]);
  });

  test("preserves whitespace and proxy keepalives across live provider chunk boundaries", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return sseResponse([
        { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
        { choices: [{ delta: { reasoning_content: "thinking " }, finish_reason: null }] },
        ": openpond-pending",
        { choices: [{ delta: { reasoning_content: "clearly" }, finish_reason: null }] },
        { choices: [{ delta: { content: "hello " }, finish_reason: null }] },
        { choices: [{ delta: { content: "world\n\n- one\n- two" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { total_tokens: 12 },
        },
        "[DONE]",
      ]);
    };

    const deltas = await collectStream({ reasoningEffort: "high" });

    expect(requests).toEqual([
      {
        url: "https://api.example.test/opchat/v1/chat/completions",
        body: {
          model: "openpond-chat",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "high",
          stream: true,
          thinking: { type: "enabled" },
        },
      },
    ]);
    expect(
      deltas
        .filter((delta) => delta.type === "reasoning_delta")
        .map((delta) => delta.text)
        .join(""),
    ).toBe("thinking clearly");
    expect(
      deltas
        .filter((delta) => delta.type === "text_delta")
        .map((delta) => delta.text)
        .join(""),
    ).toBe("hello world\n\n- one\n- two");
    expect(deltas.find((delta) => delta.type === "usage")).toMatchObject({
      type: "usage",
      usage: { total_tokens: 12 },
    });
    expect(deltas.find((delta) => delta.type === "finish")).toMatchObject({
      type: "finish",
      finishReason: "stop",
    });
  });

  test("captures Fireworks prompt-cache response headers when the usage body omits them", async () => {
    globalThis.fetch = async () => sseResponse([
      { choices: [{ delta: { content: "cached" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      },
      "[DONE]",
    ], {
      "fireworks-prompt-tokens": "100",
      "fireworks-cached-prompt-tokens": "70",
    });

    const deltas = await collectStream();

    expect(deltas.find((delta) => delta.type === "usage")).toMatchObject({
      type: "usage",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        cached_input_tokens: 70,
        cache_telemetry_source: "provider_response_headers",
      },
    });
  });

  test("prefers provider usage-body cache telemetry over response headers", async () => {
    globalThis.fetch = async () => sseResponse([
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      },
      "[DONE]",
    ], {
      "fireworks-prompt-tokens": "100",
      "fireworks-cached-prompt-tokens": "70",
    });

    const usageDelta = (await collectStream()).find((delta) => delta.type === "usage");

    expect(usageDelta).toMatchObject({
      type: "usage",
      usage: { prompt_tokens_details: { cached_tokens: 40 } },
    });
    expect(usageDelta && "usage" in usageDelta
      ? usageDelta.usage.cache_telemetry_source
      : undefined).toBeUndefined();
  });

  test("falls back to response headers when cache fields in the usage body are malformed", async () => {
    globalThis.fetch = async () => sseResponse([
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          cached_input_tokens: "unknown",
        },
      },
      "[DONE]",
    ], {
      "fireworks-prompt-tokens": "100",
      "fireworks-cached-prompt-tokens": "70",
    });

    expect((await collectStream()).find((delta) => delta.type === "usage")).toMatchObject({
      type: "usage",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        cached_input_tokens: 70,
        cache_telemetry_source: "provider_response_headers",
      },
    });
  });

  test("sends native tools to OpChat and preserves reasoning for tool follow-ups", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return sseResponse([
        {
          choices: [{
            delta: {
              reasoning_content: "I should inspect the workspace.",
              tool_calls: [{
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "resource_search",
                  arguments: '{"query"',
                },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: ':"README"}' },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
        "[DONE]",
      ]);
    };

    const tools = [
      {
        type: "function",
        function: {
          name: "resource_search",
          description: "Search workspace resources.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      },
    ] as const;
    const deltas = [];
    for await (const delta of streamOpChatChatCompletion({
      apiBaseUrl: "https://api.example.test/opchat/v1",
      token: "opk_test",
      model: "openpond-chat",
      messages: [{ role: "user", content: "find README" }],
      tools: [...tools],
      toolChoice: "auto",
    })) {
      deltas.push(delta);
    }

    expect(requests).toEqual([
      {
        url: "https://api.example.test/opchat/v1/chat/completions",
        body: {
          model: "openpond-chat",
          messages: [{ role: "user", content: "find README" }],
          stream: true,
          tools,
          tool_choice: "auto",
        },
      },
    ]);
    expect(deltas.map((delta) => delta.type)).toEqual([
      "reasoning_delta",
      "tool_call_delta",
      "continuation",
      "finish",
    ]);
    expect(deltas[1]).toMatchObject({
      type: "tool_call_delta",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "resource_search",
            arguments: '{"query":"README"}',
          },
        },
      ],
    });
    expect(deltas[2]).toMatchObject({
      type: "continuation",
      continuation: {
        kind: "chat_completions_reasoning",
        reasoningContent: "I should inspect the workspace.",
      },
    });
    expect(deltas[3]).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });

  test("projects hosted reasoning continuations into OpenAI-compatible messages", async () => {
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        { choices: [{ delta: { content: "done" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ]);
    };

    for await (const _delta of streamOpChatChatCompletion({
      apiBaseUrl: "https://api.example.test/opchat/v1",
      token: "opk_test",
      model: "openpond-chat",
      messages: [
        { role: "user", content: "find README" },
        {
          role: "assistant",
          content: "",
          continuation: {
            kind: "chat_completions_reasoning",
            reasoningContent: "I should inspect the workspace.",
          },
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "resource_search",
                arguments: '{"query":"README"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
      ],
    })) {
      // Drain the stream so the request body and response lifecycle are both exercised.
    }

    expect(requests[0]).toMatchObject({
      messages: [
        { role: "user", content: "find README" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "I should inspect the workspace.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "resource_search",
                arguments: '{"query":"README"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
      ],
    });
    expect(JSON.stringify(requests[0])).not.toContain("continuation");
  });

  test("shows OpenAI-style provider errors from OpChat failures", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "provider_error",
            type: "server_error",
            message: "The upstream model provider failed to complete the request.",
          },
        },
        502,
      );

    await expect(collectStream()).rejects.toThrow(
      "OpenPond OpChat request failed: 502 provider_error: server_error: The upstream model provider failed to complete the request.",
    );
  });
});

async function collectStream(
  options: { reasoningEffort?: "low" | "medium" | "high" | "xhigh" } = {},
) {
  const deltas = [];
  for await (const delta of streamOpChatChatCompletion({
    apiBaseUrl: "https://api.example.test/opchat/v1",
    token: "opk_test",
    model: "openpond-chat",
    messages: [{ role: "user", content: "hello" }],
    reasoningEffort: options.reasoningEffort,
  })) {
    deltas.push(delta);
  }
  return deltas;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(
  events: Array<unknown | string>,
  headers: Record<string, string> = {},
): Response {
  const body = events.map((event) => {
    if (typeof event === "string" && event.startsWith(":")) {
      return `${event}\n\n`;
    }
    return `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
  }).join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function restoreEnv(name: "OPENPOND_OPCHAT_API_URL" | "OPENPOND_CHAT_API_URL", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
