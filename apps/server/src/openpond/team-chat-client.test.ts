import { describe, expect, mock, test } from "bun:test";

import { apiBaseUrlFromSandboxApiUrl, teamChatRequestPayload } from "./team-chat-client.js";

describe("team chat API base URL", () => {
  test("forwards the desktop agent catalog request to the hosted team chat API", async () => {
    const requests: string[] = [];
    const fetchMock = mockFetch(async (url) => {
      requests.push(url);
      return Response.json({ agents: [] });
    });
    const result = await teamChatRequestPayload(
      { type: "agents", teamId: "team_1" },
      {
        loadAccountContext: testAccountContext,
        fetchImpl: fetchMock,
      },
    );

    expect(result).toEqual({ agents: [] });
    expect(requests).toEqual(["https://api.test/v1/team-chat/agents?teamId=team_1"]);
  });

  test("derives the public API origin from sandbox collection URLs", () => {
    expect(apiBaseUrlFromSandboxApiUrl("https://api.openpond.ai/v1/sandboxes")).toBe(
      "https://api.openpond.ai",
    );
    expect(apiBaseUrlFromSandboxApiUrl("http://localhost:3000/api/sandboxes")).toBe(
      "http://localhost:3000",
    );
  });

  test("preserves an explicit deployment path prefix", () => {
    expect(apiBaseUrlFromSandboxApiUrl("https://example.test/staging/api/sandboxes")).toBe(
      "https://example.test/staging",
    );
  });
});

describe("team chat attachment upload", () => {
  test("creates, uploads, and finalizes an image through the hosted grants", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = mockFetch(async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/attachments")) {
        return jsonResponse({
          attachment: attachmentPayload("pending"),
          uploadUrl: "https://upload.test/object",
          uploadHeaders: {
            "content-type": "image/png",
            "x-amz-tagging": "status=pending",
          },
          expiresAt: "2026-07-09T12:05:00.000Z",
        });
      }
      if (url === "https://upload.test/object") {
        expect(init?.method).toBe("PUT");
        expect(Buffer.from(init?.body as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/finalize")) return jsonResponse(attachmentPayload("ready"));
      return new Response(null, { status: 404 });
    });

    const result = await teamChatRequestPayload(attachmentUploadAction(), {
      fetchImpl: fetchMock,
      loadAccountContext: testAccountContext,
    });

    expect(result).toMatchObject({ id: "attachment_1", status: "ready" });
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.test/v1/team-chat/threads/thread_1/attachments",
      "https://upload.test/object",
      "https://api.test/v1/team-chat/threads/thread_1/attachments/attachment_1/finalize",
    ]);
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("ApiKey opk_test");
  });

  test("reuses a finalized upload intent without overwriting the object", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({
        attachment: attachmentPayload("ready"),
        uploadUrl: null,
        uploadHeaders: {},
        expiresAt: null,
      }),
    );

    const result = await teamChatRequestPayload(attachmentUploadAction(), {
      fetchImpl,
      loadAccountContext: testAccountContext,
    });

    expect(result).toMatchObject({ id: "attachment_1", status: "ready" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function attachmentUploadAction() {
  return {
    type: "attachment_upload" as const,
    teamId: "team_1",
    threadId: "thread_1",
    attachment: {
      id: "client_attachment_1",
      name: "image.png",
      mediaType: "image/png",
      sizeBytes: 3,
      kind: "image" as const,
      contentsBase64: Buffer.from([1, 2, 3]).toString("base64"),
    },
  };
}

function attachmentPayload(status: "pending" | "ready") {
  return {
    id: "attachment_1",
    messageId: null,
    clientAttachmentId: "client_attachment_1",
    kind: "image",
    name: "image.png",
    mediaType: "image/png",
    sizeBytes: 3,
    status,
    createdAt: "2026-07-09T12:00:00.000Z",
    readyAt: status === "ready" ? "2026-07-09T12:00:01.000Z" : null,
  };
}

function mockFetch(
  implementation: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch & ReturnType<typeof mock> {
  return mock(async (input: URL | RequestInfo, init?: RequestInit) =>
    implementation(String(input), init),
  ) as typeof fetch & ReturnType<typeof mock>;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function testAccountContext() {
  return {
    config: {},
    profiles: [],
    account: null,
    token: "opk_test",
    apiBaseUrl: "https://api.test",
    chatApiBaseUrl: "https://api.test",
    accountState: {} as never,
  };
}
