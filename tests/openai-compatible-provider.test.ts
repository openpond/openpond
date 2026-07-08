import { afterEach, describe, expect, test } from "bun:test";
import { ProviderConfigSchema } from "../packages/contracts/src/providers";
import { buildProviderSettings } from "../apps/server/src/openpond/provider-registry";
import {
  listOpenAiCompatibleProviderModels,
  normalizeOpenAiCompatibleBaseUrl,
  resolveOpenAiCompatibleProvider,
  streamOpenAiCompatibleChatCompletion,
  validateOpenAiCompatibleProvider,
} from "../apps/server/src/openpond/openai-compatible-provider";
import type { ProvidersFile } from "../apps/server/src/types";
import type { ProviderSecrets } from "../apps/server/src/openpond/provider-secrets";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI-compatible provider adapter", () => {
  test("streams chat completions with local BYOK credentials", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      openPondClient: string | null;
      openPondRequestId: string | null;
      body: Record<string, unknown>;
    }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        openPondClient: headers.get("x-openpond-client"),
        openPondRequestId: headers.get("x-openpond-request-id"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":" z.ai"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"The user"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":" says hello"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":9}}\n\n',
        "data: [DONE]\n\n",
      ]);
    };

    const deltas = [];
    for await (const delta of streamOpenAiCompatibleChatCompletion({
      ...providerState("https://provider.example/v1", "zai"),
      providerId: "zai",
      modelId: "test/model",
      messages: [{ role: "user", content: "hello z.ai" }],
      requestId: "turn_1",
    })) {
      deltas.push(delta);
    }

    expect(requests).toEqual([
      {
        url: "https://provider.example/v1/chat/completions",
        authorization: "Bearer sk-test",
        openPondClient: null,
        openPondRequestId: null,
        body: {
          model: "test/model",
          messages: [{ role: "user", content: "hello z.ai" }],
          stream: true,
        },
      },
    ]);
    expect(deltas.map((delta) => delta.type)).toEqual([
      "text_delta",
      "text_delta",
      "reasoning_delta",
      "reasoning_delta",
      "usage",
      "finish",
    ]);
    expect(deltas.slice(0, 4)).toMatchObject([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " z.ai" },
      { type: "reasoning_delta", text: "The user" },
      { type: "reasoning_delta", text: " says hello" },
    ]);
  });

  test("sends native tools to BYOK providers and streams tool call deltas", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_resource","type":"function","function":{"name":"resource_read","arguments":"{\\"ref\\":\\"workspace:README.md\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    };

    const tools = [
      {
        type: "function",
        function: {
          name: "resource_read",
          description: "Read a workspace resource by reference.",
          parameters: {
            type: "object",
            properties: {
              ref: { type: "string" },
            },
            required: ["ref"],
          },
        },
      },
    ] as const;
    const deltas = [];
    for await (const delta of streamOpenAiCompatibleChatCompletion({
      ...providerState("https://provider.example/v1", "zai"),
      providerId: "zai",
      modelId: "test/model",
      messages: [{ role: "user", content: "read README" }],
      tools: [...tools],
      toolChoice: "auto",
      requestId: "turn_tools",
    })) {
      deltas.push(delta);
    }

    expect(requests).toEqual([
      {
        url: "https://provider.example/v1/chat/completions",
        authorization: "Bearer sk-test",
        body: {
          model: "test/model",
          messages: [{ role: "user", content: "read README" }],
          stream: true,
          tools,
          tool_stream: true,
          tool_choice: "auto",
        },
      },
    ]);
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      type: "tool_call_delta",
      toolCalls: [
        {
          id: "call_resource",
          type: "function",
          function: {
            name: "resource_read",
            arguments: '{"ref":"workspace:README.md"}',
          },
        },
      ],
    });
    expect(deltas[1]).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });

  test("lists and validates provider models from /models", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return jsonResponse({
        object: "list",
        data: [
          {
            id: "test/model",
            name: "Test Model",
            context_window: 128000,
            max_output_tokens: 8192,
          },
        ],
      });
    };

    const state = providerState();
    const models = await listOpenAiCompatibleProviderModels({
      ...state,
      providerId: "openrouter",
      modelId: "test/model",
    });
    const validation = await validateOpenAiCompatibleProvider({
      ...state,
      providerId: "openrouter",
      modelId: "test/model",
    });

    expect(requests).toEqual([
      "https://provider.example/v1/models",
      "https://provider.example/v1/models",
    ]);
    expect(models[0]).toMatchObject({
      id: "test/model",
      providerId: "openrouter",
      displayName: "Test Model",
      contextWindow: 128000,
      outputLimit: 8192,
      source: "provider",
    });
    expect(validation).toMatchObject({
      ok: true,
      live: true,
      modelFound: true,
      modelCount: 1,
    });
  });

  test("marks current GLM models as reasoning capable when discovered", async () => {
    globalThis.fetch = async () =>
      jsonResponse({
        data: [
          {
            id: "glm-5.2",
            name: "GLM-5.2",
          },
        ],
      });

    const models = await listOpenAiCompatibleProviderModels({
      ...providerState(),
      providerId: "openrouter",
      modelId: "glm-5.2",
    });

    expect(models[0]?.capabilities.reasoning).toBe(true);
  });

  test("marks Grok models as reasoning capable when discovered", async () => {
    globalThis.fetch = async () =>
      jsonResponse({
        data: [
          {
            id: "grok-4.5",
            name: "Grok 4.5",
          },
        ],
      });

    const models = await listOpenAiCompatibleProviderModels({
      ...providerState("https://api.x.ai/v1", "xai"),
      providerId: "xai",
      modelId: "grok-4.5",
    });

    expect(models[0]).toMatchObject({
      id: "grok-4.5",
      providerId: "xai",
      displayName: "Grok 4.5",
      capabilities: { reasoning: true },
    });
  });

  test("explains raw OpenAI provider credentials", () => {
    expect(() =>
      resolveOpenAiCompatibleProvider({
        ...providerState("https://api.openai.com/v1", "openai", null),
        providerId: "openai",
        modelId: "gpt-5.5",
      }),
    ).toThrow(/The raw OpenAI provider uses Platform API credentials/);
  });

  test("streams OpenAI ChatGPT subscription requests through the Codex Responses endpoint", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      accountId: string | null;
      body: Record<string, unknown>;
    }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        accountId: headers.get("chatgpt-account-id"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return streamResponse([
        sse({ type: "response.output_text.delta", delta: "Hello" }),
        sse({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", call_id: "call_read", name: "resource_read", arguments: "" },
        }),
        sse({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "call_read",
          delta: '{"ref":',
        }),
        sse({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "call_read",
          delta: '"README.md"}',
        }),
        sse({ type: "response.completed", response: { usage: { total_tokens: 12 } } }),
      ]);
    };

    const deltas = [];
    for await (const delta of streamOpenAiCompatibleChatCompletion({
      ...subscriptionProviderState(),
      providerId: "openai",
      modelId: "gpt-5.5",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "read README" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "resource_read",
            parameters: { type: "object" },
          },
        },
      ],
      toolChoice: "auto",
      requestId: "turn_subscription",
    })) {
      deltas.push(delta);
    }

    expect(requests).toEqual([
      {
        url: "https://chatgpt.com/backend-api/codex/responses",
        authorization: "Bearer access-token",
        accountId: "acct_123456",
        body: {
          model: "gpt-5.5",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "read README" }],
            },
          ],
          stream: true,
          store: false,
          instructions: "Be concise.",
          tools: [
            {
              type: "function",
              name: "resource_read",
              parameters: { type: "object" },
            },
          ],
          tool_choice: "auto",
        },
      },
    ]);
    expect(deltas.map((delta) => delta.type)).toEqual([
      "text_delta",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_delta",
      "usage",
      "finish",
    ]);
    expect(deltas[0]).toMatchObject({ type: "text_delta", text: "Hello" });
    expect(deltas.slice(1, 4)).toMatchObject([
      { type: "tool_call_delta", toolCalls: [{ id: "call_read", function: { name: "resource_read" } }] },
      { type: "tool_call_delta", toolCalls: [{ function: { arguments: '{"ref":' } }] },
      { type: "tool_call_delta", toolCalls: [{ function: { arguments: '"README.md"}' } }] },
    ]);
    expect(deltas[4]).toMatchObject({ type: "usage", usage: { total_tokens: 12 } });
  });

  test("normalizes endpoint-shaped base URLs before building requests", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      if (String(input).endsWith("/models")) {
        return jsonResponse({ data: [{ id: "test/model" }] });
      }
      return streamResponse(["data: [DONE]\n\n"]);
    };

    expect(normalizeOpenAiCompatibleBaseUrl("https://provider.example/v1/models?ignored=1")).toBe(
      "https://provider.example/v1",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://provider.example/v1/chat/completions")).toBe(
      "https://provider.example/v1",
    );

    await listOpenAiCompatibleProviderModels({
      ...providerState("https://provider.example/v1/models"),
      providerId: "openrouter",
      modelId: "test/model",
    });
    for await (const _delta of streamOpenAiCompatibleChatCompletion({
      ...providerState("https://provider.example/v1/chat/completions"),
      providerId: "openrouter",
      modelId: "test/model",
      messages: [{ role: "user", content: "hello" }],
    })) {
      // Drain the stream.
    }

    expect(requests).toEqual([
      "https://provider.example/v1/models",
      "https://provider.example/v1/chat/completions",
    ]);
  });

  test("times out provider setup requests", async () => {
    globalThis.fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await expect(
      listOpenAiCompatibleProviderModels({
        ...providerState(),
        providerId: "openrouter",
        modelId: "test/model",
        requestTimeoutMs: 1,
      }),
    ).rejects.toThrow(/timed out/);
  });

  test("caps provider error bodies before surfacing failures", async () => {
    const hiddenTail = "tail-secret";
    globalThis.fetch = async () => new Response(`${"x".repeat(70 * 1024)}${hiddenTail}`, { status: 500 });

    try {
      await listOpenAiCompatibleProviderModels({
        ...providerState(),
        providerId: "openrouter",
        modelId: "test/model",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("truncated");
      expect(message).not.toContain(hiddenTail);
      return;
    }
    throw new Error("expected provider model discovery to fail");
  });

  test("explains Z.ai Coding Plan endpoint requirements for balance errors", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "1113",
            message: "Insufficient balance or no resource package. Please recharge.",
          },
        },
        429,
      );

    await expect(async () => {
      for await (const _delta of streamOpenAiCompatibleChatCompletion({
        ...providerState("https://api.z.ai/api/paas/v4", "zai"),
        providerId: "zai",
        modelId: "glm-5.2",
        messages: [{ role: "user", content: "hello z.ai" }],
      })) {
        // Drain.
      }
    }).toThrow(/Coding Plan subscriptions use https:\/\/api\.z\.ai\/api\/coding\/paas\/v4/);
  });
});

function providerState(
  baseUrl = "https://provider.example/v1",
  providerId: "openai" | "openrouter" | "xai" | "zai" = "openrouter",
  apiKey: string | null = "sk-test",
): { settings: ReturnType<typeof buildProviderSettings>; secrets: ProviderSecrets } {
  const file: ProvidersFile = {
    version: 1,
    providers: {
      [providerId]: ProviderConfigSchema.parse({
        enabled: true,
        baseUrl,
        defaultModel: "test/model",
      }),
    },
    modelCaches: {},
  };
  const secrets: ProviderSecrets = {
    version: 1,
    providers: {},
  };
  if (apiKey) {
    secrets.providers[providerId] = {
      source: "local_secret",
      value: apiKey,
      envVar: null,
      oauth: null,
      createdAt: "2026-06-30T10:00:00.000Z",
      updatedAt: "2026-06-30T10:00:00.000Z",
      lastValidatedAt: null,
      lastError: null,
    };
  }
  return {
    settings: buildProviderSettings({ file, secrets }),
    secrets,
  };
}

function subscriptionProviderState(): { settings: ReturnType<typeof buildProviderSettings>; secrets: ProviderSecrets } {
  const file: ProvidersFile = {
    version: 1,
    providers: {
      openai: ProviderConfigSchema.parse({
        enabled: true,
        defaultModel: "gpt-5.5",
      }),
    },
    modelCaches: {},
  };
  const secrets: ProviderSecrets = {
    version: 1,
    providers: {
      openai: {
        source: "chatgpt_subscription",
        value: null,
        envVar: null,
        oauth: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 3600_000,
          accountId: "acct_123456",
        },
        createdAt: "2026-06-30T10:00:00.000Z",
        updatedAt: "2026-06-30T10:00:00.000Z",
        lastValidatedAt: null,
        lastError: null,
      },
    },
  };
  return {
    settings: buildProviderSettings({ file, secrets }),
    secrets,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
