import { describe, expect, test } from "vitest";
import {
  createCloudConnectedAppToolExecutor,
  DEFAULT_CONNECTED_APP_TOOL_PATH,
  resolveCloudConnectedAppToolTarget,
} from "../apps/server/src/openpond/connected-app-executor";
import type { ConnectedAppToolExecutionRequest } from "../apps/server/src/openpond/connected-app-tool-registry";

describe("cloud connected app executor", () => {
  test("posts scoped provider tool calls to the OpenPond cloud connector API", async () => {
    const calls: Array<{
      baseUrl: string;
      token: string | null;
      path: string;
      init?: RequestInit;
    }> = [];
    const executor = createCloudConnectedAppToolExecutor({
      env: env({
        OPENPOND_SANDBOX_API_KEY: "opk_connected_test",
        OPENPOND_SANDBOX_API_URL: "https://api.openpond.ai/v1/sandboxes",
      }),
      apiFetch: async (baseUrl, token, path, init) => {
        calls.push({ baseUrl, token, path, init });
        return jsonResponse({
          ok: true,
          output: "Found 1 Drive result.",
          data: {
            items: [{ ref: "google:file:budget", title: "Budget" }],
          },
        });
      },
      loadAccountContext: async () => {
        throw new Error("account context should not be loaded when env API key is present");
      },
    });

    const result = await executor(googleSearchRequest());

    expect(result).toEqual({
      ok: true,
      output: "Found 1 Drive result.",
      data: {
        items: [{ ref: "google:file:budget", title: "Budget" }],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].baseUrl).toBe("https://api.openpond.ai");
    expect(calls[0].token).toBe("opk_connected_test");
    expect(calls[0].path).toBe(DEFAULT_CONNECTED_APP_TOOL_PATH);
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      provider: "google",
      operation: "search",
      toolName: "connected_app_search",
      sessionId: "session_1",
      turnId: "turn_1",
      userPrompt: "find the budget doc",
      connectionIds: ["conn_google"],
      capabilityIds: ["google.drive.file.read"],
      args: {
        provider: "google",
        query: "budget",
      },
    });
    expect(JSON.stringify(body)).not.toContain("leaseId");
    expect(JSON.stringify(body)).not.toContain("proxyUrl");
    expect(JSON.stringify(body)).not.toContain("sandboxId");
  });

  test("resolves the target from connected app API env before account context", async () => {
    const target = await resolveCloudConnectedAppToolTarget({
      env: env({
        OPENPOND_CONNECTED_APP_API_KEY: "opk_connected_test",
        OPENPOND_CONNECTED_APP_API_URL: "http://localhost:8787/v1",
        OPENPOND_CONNECTED_APP_TOOL_PATH: "integrations/custom-call",
      }),
      loadAccountContext: async () => {
        throw new Error("account context should not be loaded when env API key is present");
      },
    });

    expect(target).toEqual({
      apiBaseUrl: "http://localhost:8787",
      apiKey: "opk_connected_test",
      path: "/integrations/custom-call",
    });
  });

  test("fails closed when the cloud connector endpoint is not available", async () => {
    const executor = createCloudConnectedAppToolExecutor({
      env: env({
        OPENPOND_SANDBOX_API_KEY: "opk_connected_test",
        OPENPOND_SANDBOX_API_URL: "https://api.openpond.ai/v1/sandboxes",
      }),
      apiFetch: async () =>
        jsonResponse({ error: "Not found" }, { status: 404 }),
    });

    const result = await executor(googleSearchRequest());

    expect(result.ok).toBe(false);
    expect(result.output).toContain("endpoint is not available");
    expect(result.output).toContain("No google provider API call was made");
  });

  test("fails closed before fetch when account auth is missing", async () => {
    let called = false;
    const executor = createCloudConnectedAppToolExecutor({
      env: env({}),
      apiFetch: async () => {
        called = true;
        return jsonResponse({ ok: true });
      },
      loadAccountContext: async () => ({
        token: null,
        apiBaseUrl: "https://api.openpond.ai",
      } as any),
    });

    const result = await executor(googleSearchRequest());

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("OpenPond account API key is required");
    expect(result.output).toContain("No google provider API call was made");
  });

  test("does not execute non-leaseable native ingestion providers", async () => {
    let called = false;
    const executor = createCloudConnectedAppToolExecutor({
      env: env({
        OPENPOND_SANDBOX_API_KEY: "opk_connected_test",
        OPENPOND_SANDBOX_API_URL: "https://api.openpond.ai/v1/sandboxes",
      }),
      apiFetch: async () => {
        called = true;
        return jsonResponse({ ok: true });
      },
    });

    const result = await executor({
      ...googleSearchRequest(),
      provider: "slack",
      capabilityIds: ["slack.message.ingest"],
    });

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("slack is not leaseable for cloud connector execution");
    expect(result.output).toContain("No slack provider API call was made");
  });
});

function googleSearchRequest(): ConnectedAppToolExecutionRequest {
  return {
    provider: "google",
    operation: "search",
    toolName: "connected_app_search",
    sessionId: "session_1",
    turnId: "turn_1",
    userPrompt: "find the budget doc",
    connectionIds: ["conn_google"],
    capabilityIds: ["google.drive.file.read"],
    args: {
      provider: "google",
      query: "budget",
    },
  };
}

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
