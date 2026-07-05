import { afterEach, describe, expect, test } from "bun:test";
import { createOpenPondSandboxClient } from "@openpond/cloud";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sandbox integration cloud client", () => {
  test("lists organizations through the public API root", async () => {
    const calls: FetchCall[] = [];
    let requestCount = 0;
    globalThis.fetch = async (input, init) => {
      requestCount += 1;
      calls.push(fetchCall(input, init));
      return jsonResponse({
        [requestCount === 1 ? "organizations" : "teams"]: [organizationPayload(`team_${requestCount}`)],
      });
    };
    const client = createOpenPondSandboxClient({
      apiKey: "opk_test",
      sandboxApiUrl: "http://localhost:8787/api/sandboxes",
    });

    const result = await client.listOrganizations();
    const legacyResult = await client.listOrganizations();

    expect(result.map((organization) => organization.teamId)).toEqual(["team_1"]);
    expect(legacyResult.map((organization) => organization.teamId)).toEqual(["team_2"]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("http://localhost:8787/api/organizations");
      expect(call.method).toBe("GET");
      expect(call.headers["openpond-api-key"]).toBe("opk_test");
      expect(call.headers.authorization).toBe("ApiKey opk_test");
    }
  });

  test("lists integration connections through the public API root", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push(fetchCall(input, init));
      return jsonResponse({
        teamId: "team_1",
        connections: [
          {
            id: "conn_google",
            provider: "google",
            ownerUserId: "user_1",
            teamId: "team_1",
            providerAccountId: "acct_1",
            providerAccountName: "Docs User",
            providerWorkspaceId: null,
            providerWorkspaceName: "Drive",
            scopes: ["drive.readonly"],
            status: "active",
            connectedAt: "2026-07-04T00:00:00.000Z",
            lastRefreshedAt: null,
            revokedAt: null,
            createdAt: "2026-07-04T00:00:00.000Z",
            updatedAt: "2026-07-04T00:00:00.000Z",
          },
        ],
      });
    };
    const client = createOpenPondSandboxClient({
      apiKey: "opk_test",
      sandboxApiUrl: "http://localhost:8787/api/sandboxes",
    });

    const result = await client.integrationConnections({
      teamId: "team_1",
      projectId: "project_1",
      agentId: "agent_1",
      status: "active",
    });

    expect(result.connections).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://localhost:8787/api/integrations/connections?teamId=team_1&projectId=project_1&agentId=agent_1&status=active",
    );
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers["openpond-api-key"]).toBe("opk_test");
    expect(calls[0].headers.authorization).toBe("ApiKey opk_test");
  });

  test("lists, attaches, and removes sandbox integration leases through the sandbox API", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input, init) => {
      const call = fetchCall(input, init);
      calls.push(call);
      return jsonResponse({
        sandbox: {
          id: "sandbox_1",
          state: "running",
        },
        integrationLeases: [
          {
            leaseId: "lease_google",
            provider: "google",
            scopes: ["drive.readonly"],
            capabilities: ["google.drive.file.read"],
            resourcePolicy: { paths: ["folder_1"] },
            expiresAt: "2026-07-04T01:00:00.000Z",
            proxyUrl: "https://proxy.openpond.ai/lease_google",
            required: true,
          },
        ],
      });
    };
    const client = createOpenPondSandboxClient({
      apiKey: "opk_test",
      sandboxApiUrl: "http://localhost:8787/api/sandboxes",
    });

    await client.integrationLeases("sandbox_1");
    await client.attachIntegrationConnection("sandbox_1", {
      connectionId: "conn_google",
      scopes: ["drive.readonly"],
      capabilities: ["google.drive.file.read"],
      resourcePolicy: { paths: ["folder_1"] },
      ttlSeconds: 3600,
      required: true,
    });
    await client.removeIntegrationLease("sandbox_1", "lease_google");

    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8787/api/sandboxes/sandbox_1/integrations",
      "http://localhost:8787/api/sandboxes/sandbox_1/integrations",
      "http://localhost:8787/api/sandboxes/sandbox_1/integrations",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "DELETE"]);
    expect(calls[1].body).toEqual({
      connectionId: "conn_google",
      scopes: ["drive.readonly"],
      capabilities: ["google.drive.file.read"],
      resourcePolicy: { paths: ["folder_1"] },
      ttlSeconds: 3600,
      required: true,
    });
    expect(calls[2].body).toEqual({ leaseId: "lease_google" });
    for (const call of calls) {
      expect(call.headers["openpond-api-key"]).toBe("opk_test");
      expect(call.headers.authorization).toBe("ApiKey opk_test");
    }
  });
});

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function fetchCall(input: RequestInfo | URL, init?: RequestInit): FetchCall {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  return {
    url,
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    headers: Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value])),
    body,
  };
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

function organizationPayload(teamId: string) {
  return {
    teamId,
    slug: teamId,
    name: teamId,
    displayName: teamId,
    role: "owner",
    status: "active",
    primaryContactEmail: null,
    customDomain: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  };
}
