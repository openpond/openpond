import { describe, expect, test } from "bun:test";
import {
  CONNECTED_APP_TOOL_CALL_ENDPOINT,
  ConnectedAppToolCallRequestSchema,
} from "@openpond/contracts";
import { executeConnectedAppToolCall } from "@openpond/cloud";

describe("connected app tool-call contract", () => {
  test("accepts leaseable OAuth provider tool calls", () => {
    expect(ConnectedAppToolCallRequestSchema.parse(googleSearchRequest())).toEqual(
      googleSearchRequest(),
    );
  });

  test("accepts direct X post reads by status URL", () => {
    const request = {
      provider: "x",
      operation: "read",
      toolName: "connected_app_read",
      sessionId: "session_1",
      turnId: "turn_1",
      userPrompt: "scrape this tweet",
      connectionIds: ["conn_x"],
      capabilityIds: ["x.search.read"],
      args: {
        provider: "x",
        ref: "https://x.com/thsottiaux/status/2073551549494596079",
        operation: "x.post.read",
      },
    } as const;

    expect(ConnectedAppToolCallRequestSchema.parse(request)).toEqual(request);
  });

  test("accepts GitHub issue creation writes", () => {
    expect(ConnectedAppToolCallRequestSchema.parse(githubIssueCreateRequest())).toEqual(
      githubIssueCreateRequest(),
    );
  });

  test("rejects native ingestion and descriptor-only providers", () => {
    const slack = ConnectedAppToolCallRequestSchema.safeParse({
      ...googleSearchRequest(),
      provider: "slack",
      capabilityIds: ["slack.message.ingest"],
    });
    const mcp = ConnectedAppToolCallRequestSchema.safeParse({
      ...googleSearchRequest(),
      provider: "mcp",
      capabilityIds: ["mcp.tool.call"],
    });

    expect(slack.success).toBe(false);
    expect(mcp.success).toBe(false);
    expect(firstError(slack)).toContain("not leaseable");
    expect(firstError(mcp)).toContain("not leaseable");
  });

  test("rejects mismatched tool operations and capabilities", () => {
    const wrongTool = ConnectedAppToolCallRequestSchema.safeParse({
      ...googleSearchRequest(),
      toolName: "connected_app_write",
    });
    const wrongCapability = ConnectedAppToolCallRequestSchema.safeParse({
      ...googleSearchRequest(),
      operation: "write",
      toolName: "connected_app_write",
      capabilityIds: ["google.drive.file.read"],
    });

    expect(wrongTool.success).toBe(false);
    expect(wrongCapability.success).toBe(false);
    expect(firstError(wrongTool)).toContain("does not match search operation");
    expect(firstError(wrongCapability)).toContain("not allowed for google write");
  });

  test("rejects undeclared provider operations and missing provider operation input", () => {
    const unknownOperation = ConnectedAppToolCallRequestSchema.safeParse({
      ...googleWriteRequest(),
      args: {
        provider: "google",
        operation: "google.docs.rewrite_everything",
        input: { ref: "google:doc:budget", patch: "Hello" },
        explicitUserIntent: "User asked to edit google:doc:budget.",
      },
    });
    const missingInput = ConnectedAppToolCallRequestSchema.safeParse({
      ...googleWriteRequest(),
      args: {
        provider: "google",
        operation: "google.docs.update",
        input: { ref: "google:doc:budget" },
        explicitUserIntent: "User asked to edit google:doc:budget.",
      },
    });

    expect(unknownOperation.success).toBe(false);
    expect(missingInput.success).toBe(false);
    expect(firstError(unknownOperation)).toContain("operation google.docs.rewrite_everything is not allowed");
    expect(firstError(missingInput)).toContain("requires input.patch");
  });

  test("cloud client posts to the connected app tool-call endpoint", async () => {
    const calls: Array<{
      baseUrl: string;
      token: string | null;
      path: string;
      init?: RequestInit;
    }> = [];
    const response = await executeConnectedAppToolCall(
      "https://api.openpond.ai",
      "opk_connected_test",
      googleSearchRequest(),
      {
        apiFetch: async (baseUrl, token, path, init) => {
          calls.push({ baseUrl, token, path, init });
          return jsonResponse({
            ok: true,
            output: "Found 1 result.",
            data: { items: [{ ref: "google:file:budget" }] },
          });
        },
      },
    );

    expect(response).toEqual({
      ok: true,
      status: 200,
      endpointAvailable: true,
      output: "Found 1 result.",
      data: { items: [{ ref: "google:file:budget" }] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].baseUrl).toBe("https://api.openpond.ai");
    expect(calls[0].token).toBe("opk_connected_test");
    expect(calls[0].path).toBe(CONNECTED_APP_TOOL_CALL_ENDPOINT);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(googleSearchRequest());
  });

  test("cloud client returns fail-closed response for missing endpoint", async () => {
    const response = await executeConnectedAppToolCall(
      "https://api.openpond.ai",
      "opk_connected_test",
      googleSearchRequest(),
      {
        apiFetch: async () => jsonResponse({ error: "Not found" }, { status: 404 }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    expect(response.endpointAvailable).toBe(false);
    expect(response.output).toBe("Not found");
  });
});

function googleSearchRequest() {
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
  } as const;
}

function googleWriteRequest() {
  return {
    provider: "google",
    operation: "write",
    toolName: "connected_app_write",
    sessionId: "session_1",
    turnId: "turn_1",
    userPrompt: "edit the budget doc",
    connectionIds: ["conn_google"],
    capabilityIds: ["google.docs.write"],
    args: {
      provider: "google",
      operation: "google.docs.update",
      input: {
        ref: "google:doc:budget",
        patch: "Hello",
      },
      explicitUserIntent: "User asked to edit google:doc:budget.",
    },
  } as const;
}

function githubIssueCreateRequest() {
  return {
    provider: "github",
    operation: "write",
    toolName: "connected_app_write",
    sessionId: "session_1",
    turnId: "turn_1",
    userPrompt: "submit issue",
    connectionIds: ["conn_github"],
    capabilityIds: ["github.issue.write"],
    args: {
      provider: "github",
      operation: "github.issue.create",
      input: {
        repo: "openpond/openpond",
        title: "Slash issue command",
        body: "Add a slash command that files issues.",
      },
      explicitUserIntent: "User asked to submit a new issue to openpond/openpond.",
    },
  } as const;
}

function firstError(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string {
  return result.error?.issues[0]?.message ?? "";
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
