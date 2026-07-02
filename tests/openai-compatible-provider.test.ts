import { afterEach, describe, expect, test } from "bun:test";
import { ProviderConfigSchema } from "../packages/contracts/src/providers";
import { buildProviderSettings } from "../apps/server/src/openpond/provider-registry";
import {
  listOpenAiCompatibleProviderModels,
  normalizeOpenAiCompatibleBaseUrl,
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
    const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":9}}\n\n',
        "data: [DONE]\n\n",
      ]);
    };

    const deltas = [];
    for await (const delta of streamOpenAiCompatibleChatCompletion({
      ...providerState(),
      providerId: "openrouter",
      modelId: "test/model",
      messages: [{ role: "user", content: "hello" }],
      requestId: "turn_1",
    })) {
      deltas.push(delta);
    }

    expect(requests).toEqual([
      {
        url: "https://provider.example/v1/chat/completions",
        authorization: "Bearer sk-test",
        body: {
          model: "test/model",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
      },
    ]);
    expect(deltas.map((delta) => delta.type)).toEqual([
      "text_delta",
      "reasoning_delta",
      "usage",
      "finish",
    ]);
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
});

function providerState(baseUrl = "https://provider.example/v1"): { settings: ReturnType<typeof buildProviderSettings>; secrets: ProviderSecrets } {
  const file: ProvidersFile = {
    version: 1,
    providers: {
      openrouter: ProviderConfigSchema.parse({
        enabled: true,
        baseUrl,
        defaultModel: "test/model",
      }),
    },
    modelCaches: {},
  };
  const secrets: ProviderSecrets = {
    version: 1,
    providers: {
      openrouter: {
        source: "local_secret",
        value: "sk-test",
        envVar: null,
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
