import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { contentHash, type HostedHarnessRefinerRequest } from "@openpond/harness";
import {
  listOpChatModels,
  listOpChatProviders,
  requestOpChatHarnessRefinement,
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
            "https://api-new.staging-api.openpond.ai/opchat/v1",
        },
        {},
        "https://api-new.staging-api.openpond.ai",
      ),
    ).toBe("https://staging-api.openpond.ai/opchat/v1");
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

  test("posts content-addressed Harness evidence to the dedicated hosted Refiner route", async () => {
    const request = hostedRefinerRequest();
    const requests: Array<{
      url: string;
      authorization: string | null;
      requestId: string | null;
      body: unknown;
    }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        requestId: headers.get("x-openpond-request-id"),
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse(hostedRefinerResponse(request));
    };

    await expect(
      requestOpChatHarnessRefinement({
        apiBaseUrl: "https://api.example.test/opchat/v1/",
        token: "opk_runtime_scoped",
        request,
      }),
    ).resolves.toEqual(hostedRefinerResponse(request));

    expect(requests).toEqual([
      {
        url: "https://api.example.test/opchat/v1/harness/refine",
        authorization: "Bearer opk_runtime_scoped",
        requestId: request.requestId,
        body: request,
      },
    ]);
  });

  test("rejects a hosted Refiner response that is not bound to the request release", async () => {
    const request = hostedRefinerRequest();
    globalThis.fetch = async () =>
      jsonResponse({
        ...hostedRefinerResponse(request),
        currentRelease: {
          id: "release-other",
          contentHash: "f".repeat(64),
        },
      });

    await expect(
      requestOpChatHarnessRefinement({
        apiBaseUrl: "https://api.example.test/opchat/v1",
        token: "opk_runtime_scoped",
        request,
      }),
    ).rejects.toThrow("response binding does not match the request");
  });

  test("requests complete chat responses so whitespace survives provider chunk boundaries", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({
        choices: [{
          message: {
            content: "hello world\n\n- one\n- two",
            reasoning_content: "thinking clearly",
          },
          finish_reason: "stop",
        }],
        usage: { total_tokens: 12 },
      });
    };

    const deltas = await collectStream({ reasoningEffort: "high" });

    expect(requests).toEqual([
      {
        url: "https://api.example.test/opchat/v1/chat/completions",
        body: {
          model: "openpond-chat",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "high",
          stream: false,
          thinking: { type: "enabled" },
        },
      },
    ]);
    expect(deltas.map((delta) => delta.type)).toEqual([
      "reasoning_delta",
      "text_delta",
      "usage",
      "finish",
    ]);
    expect(deltas[1]).toMatchObject({
      type: "text_delta",
      text: "hello world\n\n- one\n- two",
    });
    expect(deltas[2]).toMatchObject({ type: "usage", usage: { total_tokens: 12 } });
    expect(deltas[3]).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  test("sends native tools to OpChat and preserves reasoning for tool follow-ups", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({
        choices: [{
          message: {
            reasoning_content: "I should inspect the workspace.",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "resource_search",
                arguments: '{"query":"README"}',
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
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
          stream: false,
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
      return jsonResponse({
        choices: [{
          message: { content: "done" },
          finish_reason: "stop",
        }],
      });
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

function hostedRefinerRequest(): HostedHarnessRefinerRequest {
  const evidence = {
    trigger: { id: "trigger-1" },
    observations: [{ id: "observation-1", kind: "execution_recovery" }],
    task: {
      prompt: "Prepare the report.",
      assistantOutput: "The report is ready.",
      previousAssistantOutput: null,
    },
    eventExcerpts: [],
    sourceFiles: [
      {
        path: "instructions/system.md",
        kind: "instruction" as const,
        content: "Complete the requested work.",
        loaded: true,
      },
    ],
    sourceCatalog: [
      {
        path: "instructions/system.md",
        kind: "instruction" as const,
        loaded: true,
      },
    ],
  };
  const admittedRelease = {
    id: "release-admitted",
    contentHash: "a".repeat(64),
  };
  return {
    schemaVersion: "openpond.hostedHarnessRefinerRequest.v1",
    requestId: "refiner-request-1",
    idempotencyKey: "refiner-idempotency-1",
    evidenceHash: contentHash(evidence),
    harness: {
      admittedRelease,
      currentRelease: admittedRelease,
      overlay: {
        id: "overlay-1",
        revision: 0,
        contentHash: "b".repeat(64),
      },
      workspace: {
        id: "workspace-1",
        revision: 0,
        sourceRevision: "c".repeat(64),
        channelRevision: 0,
      },
      capabilities: {
        memory: true,
        prompt: true,
        skill: true,
        agent: false,
      },
    },
    evidence,
  };
}

function hostedRefinerResponse(request: HostedHarnessRefinerRequest) {
  return {
    schemaVersion: "openpond.hostedHarnessRefinerResponse.v1" as const,
    requestId: request.requestId,
    evidenceHash: request.evidenceHash,
    admittedRelease: request.harness.admittedRelease,
    currentRelease: request.harness.currentRelease,
    decision: {
      schemaVersion: "openpond.localHarnessRefinerDecision.v1" as const,
      decision: "no_action" as const,
      reason: "No durable Harness change is warranted.",
    },
    serviceRevision: "refiner-test-v1",
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  };
}

function restoreEnv(name: "OPENPOND_OPCHAT_API_URL" | "OPENPOND_CHAT_API_URL", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
