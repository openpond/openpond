import { afterEach, describe, expect, test } from "vitest";

import {
  assertTerminalSandboxLifecycleSettled,
  normalizeIntegrationAttachInput,
  normalizeIntegrationLeaseId,
  normalizeSandboxRuntimeCreateInput,
  normalizeCreateInput,
  normalizeSandboxEnvRefsForApp,
  implicitConnectedAppStatusTeamIds,
  mergeConnectedAppStatusConnectionResults,
  resolveImplicitConnectedAppStatusConnections,
  sandboxLifecycleRequiresSynchronousAccounting,
  sandboxRequestPayload,
  selectImplicitConnectedAppStatusTeamId,
  successfulConnectedAppStatusConnectionResults,
} from "../apps/server/src/openpond/sandboxes";
import { pipefailSandboxShellCommand } from "../apps/server/src/openpond/shell-command";
import {
  pickSandboxChatDefaultRuntime,
  sandboxChatDefaultRuntimeMetadata,
  summarizeSandboxToolResult,
} from "../apps/server/src/workspace-tools/workspace-tool-sandbox-actions";
import { normalizeMentionedSandboxToolRequest } from "../apps/server/src/runtime/turn-runner";

const originalFetch = globalThis.fetch;
const originalSandboxApiKey = process.env.OPENPOND_SANDBOX_API_KEY;
const originalSandboxApiUrl = process.env.OPENPOND_SANDBOX_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSandboxApiKey === undefined) {
    delete process.env.OPENPOND_SANDBOX_API_KEY;
  } else {
    process.env.OPENPOND_SANDBOX_API_KEY = originalSandboxApiKey;
  }
  if (originalSandboxApiUrl === undefined) {
    delete process.env.OPENPOND_SANDBOX_API_URL;
  } else {
    process.env.OPENPOND_SANDBOX_API_URL = originalSandboxApiUrl;
  }
});

describe("sandbox env normalization", () => {
  test("accepts secret ref env mappings", () => {
    expect(
      normalizeSandboxEnvRefsForApp([
        {
          name: "FOO_API_KEY",
          secretRef: "openpond://secret/team_test/secret_test#v1",
        },
      ]),
    ).toEqual([
      {
        name: "FOO_API_KEY",
        secretRef: "openpond://secret/team_test/secret_test#v1",
      },
    ]);
  });

  test("rejects inline values before app server proxying", () => {
    expect(() =>
      normalizeSandboxEnvRefsForApp([
        {
          name: "FOO_API_KEY",
          value: "plaintext-secret",
        },
      ]),
    ).toThrow("Sandbox env entries must use secretRef, not inline values.");
  });
});

describe("sandbox create normalization", () => {
  test("wraps sandbox exec commands with pipefail before API execution", async () => {
    const command = `${JSON.stringify(process.execPath)} -e "console.log('failing validation'); process.exit(7)" | tail -40`;
    const requests: Array<{ method: string; pathname: string; body: unknown }> = [];
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, pathname: url.pathname, body });
      if (method === "POST" && url.pathname.endsWith("/exec")) {
        return Response.json({
          command: {
            id: "command_pipefail",
            command: body?.command,
            status: "failed",
            exitCode: 7,
            output: "failing validation\n",
          },
        });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    const result = await sandboxRequestPayload({
      type: "exec",
      sandboxId: "sandbox_pipefail",
      payload: { command, timeoutSeconds: 30 },
    });

    expect(requests).toEqual([
      {
        method: "POST",
        pathname: "/v1/sandboxes/sandbox_pipefail/exec",
        body: {
          command: pipefailSandboxShellCommand(command),
          timeoutSeconds: 30,
        },
      },
    ]);
    expect(result).toMatchObject({
      command: {
        status: "failed",
        exitCode: 7,
        output: "failing validation\n",
      },
    });
  });

  test("rejects inline sandbox runtime settings on raw sandbox create", () => {
    expect(() =>
      normalizeCreateInput({
        sandboxRuntime: {
          projectId: "project_test",
          mode: "feature",
        },
      }),
    ).toThrow("Sandbox runtime settings must use /v1/runtimes");
  });

  test("normalizes raw sandbox create without managed workspace fields", () => {
    expect(
      normalizeCreateInput({
        projectId: "project_test",
        agentId: "agent_test",
        workspacePurpose: "change_code",
        purpose: "Change code",
        metadata: {
          source: "openpond-app-sandbox-ui",
          workspacePurpose: "change_code",
          purpose: "Change code",
        },
      }),
    ).toEqual({
      projectId: "project_test",
      agentId: "agent_test",
      metadata: {
        source: "openpond-app-sandbox-ui",
      },
    });
  });

  test("normalizes runtime-facing integration leases without connection material", () => {
    expect(
      normalizeCreateInput({
        integrationLeases: [
          {
            leaseId: " lease_google ",
            provider: "google",
            capabilities: [" google.drive.file.read "],
            scopes: [" drive.readonly "],
            resourcePolicy: { driveFolderIds: ["folder_1"] },
            expiresAt: "2026-07-04T01:00:00.000Z",
            proxyUrl: " https://proxy.openpond.ai/lease_google ",
            required: true,
            providerAccountName: "Docs User",
          },
        ],
      }),
    ).toEqual({
      integrationLeases: [
        {
          leaseId: "lease_google",
          provider: "google",
          capabilities: ["google.drive.file.read"],
          scopes: ["drive.readonly"],
          resourcePolicy: { driveFolderIds: ["folder_1"] },
          expiresAt: "2026-07-04T01:00:00.000Z",
          proxyUrl: "https://proxy.openpond.ai/lease_google",
          required: true,
        },
      ],
    });
  });
});

describe("sandbox runtime create normalization", () => {
  test("forwards managed workspace settings without UI-only purpose labels", () => {
    expect(
      normalizeSandboxRuntimeCreateInput({
        teamId: "team_test",
        projectId: "project_test",
        agentId: "agent_test",
        workflowMode: "feature",
        baseBranch: "master",
        runtimeProfileId: "openpond-coding-core-v1",
        promotionPolicy: "manual",
        workspacePurpose: "change_code",
        purpose: "Change code",
        metadata: {
          source: "openpond-app",
          workspacePurpose: "change_code",
          purpose: "Change code",
        },
      }),
    ).toEqual({
      teamId: "team_test",
      projectId: "project_test",
      agentId: "agent_test",
      workflowMode: "feature",
      baseBranch: "master",
      runtimeProfileId: "openpond-coding-core-v1",
      promotionPolicy: "manual",
      metadata: {
        source: "openpond-app",
      },
    });
  });

  test("normalizes legacy runtime mode into canonical workflowMode", () => {
    expect(
      normalizeSandboxRuntimeCreateInput({
        teamId: "team_test",
        mode: "patch_only",
      }),
    ).toEqual({
      teamId: "team_test",
      workflowMode: "patch_only",
    });
  });
});

describe("sandbox integration lease normalization", () => {
  test("classifies creating sandboxes with active reservations as requiring synchronous lifecycle accounting", () => {
    expect(
      sandboxLifecycleRequiresSynchronousAccounting({
        state: "creating",
        reservation: { status: "reserved" },
      } as never),
    ).toBe(true);
    expect(
      sandboxLifecycleRequiresSynchronousAccounting({
        state: "running",
        reservation: { status: "reserved" },
      } as never),
    ).toBe(false);
    expect(
      sandboxLifecycleRequiresSynchronousAccounting({
        state: "creating",
        reservation: { status: "released" },
      } as never),
    ).toBe(false);
  });

  test("does not request async stop or delete for creating sandboxes with active reservations", async () => {
    const requests: Array<{ method: string; pathname: string; prefer: string | null }> = [];
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      requests.push({
        method,
        pathname: url.pathname,
        prefer: new Headers(init?.headers).get("Prefer"),
      });
      if (method === "GET") {
        return Response.json({
          sandbox: sandboxLifecycleRecord("sandbox_creating", "creating", "reserved"),
        });
      }
      if (method === "DELETE") {
        return Response.json({
          sandbox: sandboxLifecycleRecord("sandbox_creating", "deleted", "released"),
        });
      }
      if (method === "POST" && url.pathname.endsWith("/stop")) {
        return Response.json({
          sandbox: sandboxLifecycleRecord("sandbox_creating", "deleted", "released"),
        });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    await sandboxRequestPayload({
      type: "delete",
      sandboxId: "sandbox_creating",
    });
    await sandboxRequestPayload({
      type: "stop",
      sandboxId: "sandbox_creating",
    });

    expect(requests).toEqual([
      { method: "GET", pathname: "/v1/sandboxes/sandbox_creating", prefer: null },
      { method: "DELETE", pathname: "/v1/sandboxes/sandbox_creating", prefer: null },
      { method: "GET", pathname: "/v1/sandboxes/sandbox_creating", prefer: null },
      { method: "POST", pathname: "/v1/sandboxes/sandbox_creating/stop", prefer: null },
    ]);
  });

  test("keeps normal running sandbox stop and delete requests async", async () => {
    const requests: Array<{ method: string; pathname: string; prefer: string | null }> = [];
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      requests.push({
        method,
        pathname: url.pathname,
        prefer: new Headers(init?.headers).get("Prefer"),
      });
      if (method === "GET") {
        return Response.json({
          sandbox: sandboxLifecycleRecord("sandbox_running", "running", "reserved"),
        });
      }
      if (method === "DELETE") {
        return Response.json({
          sandbox: sandboxLifecycleRecord("sandbox_running", "deleted", "captured"),
        });
      }
      if (method === "POST" && url.pathname.endsWith("/stop")) {
        return Response.json({
          accepted: true,
          operation: "stop",
          sandbox: sandboxLifecycleRecord("sandbox_running", "running", "reserved"),
        });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    await sandboxRequestPayload({
      type: "delete",
      sandboxId: "sandbox_running",
    });
    await sandboxRequestPayload({
      type: "stop",
      sandboxId: "sandbox_running",
    });

    expect(requests).toEqual([
      { method: "GET", pathname: "/v1/sandboxes/sandbox_running", prefer: null },
      { method: "DELETE", pathname: "/v1/sandboxes/sandbox_running", prefer: "respond-async" },
      { method: "GET", pathname: "/v1/sandboxes/sandbox_running", prefer: null },
      { method: "POST", pathname: "/v1/sandboxes/sandbox_running/stop", prefer: "respond-async" },
    ]);
  });

  test("rejects terminal stop or delete responses with unsettled active reservations", async () => {
    expect(() =>
      assertTerminalSandboxLifecycleSettled(
        "delete",
        sandboxLifecycleRecord("sandbox_deleted_reserved", "deleted", "reserved") as never,
      ),
    ).toThrow("reservation reservation_sandbox_deleted_reserved is still reserved");
    expect(() =>
      assertTerminalSandboxLifecycleSettled(
        "stop",
        sandboxLifecycleRecord("sandbox_running_reserved", "running", "reserved") as never,
      ),
    ).not.toThrow();
    expect(() =>
      assertTerminalSandboxLifecycleSettled(
        "delete",
        sandboxLifecycleRecord("sandbox_deleted_released", "deleted", "released") as never,
      ),
    ).not.toThrow();
  });

  test("surfaces ambiguous delete-while-creating accounting instead of treating cleanup as complete", async () => {
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({
          sandbox: sandboxLifecycleRecord("sandbox_creating", "creating", "reserved"),
        });
      }
      if (method === "DELETE") {
        return Response.json({
          sandbox: sandboxLifecycleRecord("sandbox_creating", "deleted", "reserved"),
        });
      }
      if (method === "POST" && url.pathname.endsWith("/stop")) {
        return Response.json({
          accepted: true,
          operation: "stop",
          sandbox: sandboxLifecycleRecord("sandbox_creating", "deleted", "reserved"),
        });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    await expect(
      sandboxRequestPayload({
        type: "delete",
        sandboxId: "sandbox_creating",
      }),
    ).rejects.toThrow("Cleanup accounting has not settled");
    await expect(
      sandboxRequestPayload({
        type: "stop",
        sandboxId: "sandbox_creating",
      }),
    ).rejects.toThrow("Cleanup accounting has not settled");
  });

  test("explains failed lifecycle requests while creating reservations are still claimed", async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      requests.push({ method, pathname: url.pathname });
      if (method === "GET") {
        return Response.json({
          sandbox: sandboxLifecycleRecord("sandbox_claimed", "creating", "reserved"),
        });
      }
      if (method === "DELETE") {
        return Response.json({ error: "fetch failed" }, { status: 500 });
      }
      if (method === "POST" && url.pathname.endsWith("/stop")) {
        return Response.json({ error: "sandbox_not_running" }, { status: 409 });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    await expect(
      sandboxRequestPayload({
        type: "delete",
        sandboxId: "sandbox_claimed",
      }),
    ).rejects.toThrow(
      "Sandbox delete failed while sandbox sandbox_claimed is still creating with active reservation reservation_sandbox_claimed.",
    );
    await expect(
      sandboxRequestPayload({
        type: "stop",
        sandboxId: "sandbox_claimed",
      }),
    ).rejects.toThrow(
      "Sandbox stop failed while sandbox sandbox_claimed is still creating with active reservation reservation_sandbox_claimed.",
    );

    expect(requests).toEqual([
      { method: "GET", pathname: "/v1/sandboxes/sandbox_claimed" },
      { method: "DELETE", pathname: "/v1/sandboxes/sandbox_claimed" },
      { method: "GET", pathname: "/v1/sandboxes/sandbox_claimed" },
      { method: "GET", pathname: "/v1/sandboxes/sandbox_claimed" },
      { method: "POST", pathname: "/v1/sandboxes/sandbox_claimed/stop" },
      { method: "GET", pathname: "/v1/sandboxes/sandbox_claimed" },
    ]);
  });

  test("selects an implicit connected app status team from active manageable organizations", () => {
    expect(
      implicitConnectedAppStatusTeamIds([
        organization("team_member", "member", "active"),
        organization("team_admin", "admin", "active"),
        organization("team_member", "member", "active"),
        organization("team_disabled", "owner", "disabled"),
        {
          id: "team_legacy_owner",
          name: "Legacy Owner",
          role: "owner",
        } as never,
      ]),
    ).toEqual(["team_member", "team_admin", "team_legacy_owner"]);

    expect(
      selectImplicitConnectedAppStatusTeamId([
        organization("team_member", "member", "active"),
        organization("team_admin", "admin", "active"),
        organization("team_owner", "owner", "disabled"),
      ]),
    ).toBe("team_admin");

    expect(
      selectImplicitConnectedAppStatusTeamId([
        organization("team_member", "member", "active"),
        organization("team_owner", "owner", "active"),
        organization("team_admin", "admin", "active"),
      ]),
    ).toBe("team_owner");

    expect(
      selectImplicitConnectedAppStatusTeamId([
        organization("team_disabled", "owner", "disabled"),
      ]),
    ).toBe("");

    expect(
      selectImplicitConnectedAppStatusTeamId([
        {
          id: "team_legacy_owner",
          name: "Legacy Owner",
          role: "owner",
        } as never,
      ]),
    ).toBe("team_legacy_owner");
  });

  test("merges implicit connected app status connections across all active teams", () => {
    const googleConnection = connection("connection_google", "team_docs", "google");
    expect(
      mergeConnectedAppStatusConnectionResults([
        {
          connections: [
            googleConnection,
            connection("connection_x", "team_social", "x"),
          ],
        },
        {
          connections: [
            connection("connection_github", "team_code", "github"),
            { ...googleConnection, teamId: "team_duplicate" },
          ],
        },
        { connections: null },
      ]).map((item) => ({
        id: item.id,
        provider: item.provider,
        teamId: item.teamId,
      })),
    ).toEqual([
      { id: "connection_google", provider: "google", teamId: "team_docs" },
      { id: "connection_x", provider: "x", teamId: "team_social" },
      { id: "connection_github", provider: "github", teamId: "team_code" },
    ]);
  });

  test("fails connected app status when team lookup failures would produce a false empty status", () => {
    expect(() =>
      successfulConnectedAppStatusConnectionResults([
        null,
        null,
      ]),
    ).toThrow("Connected app status is unavailable because one or more team integration connection lookups could not be loaded.");

    expect(() =>
      successfulConnectedAppStatusConnectionResults([
        null,
        { connections: [] },
      ]),
    ).toThrow("Connected app status is unavailable because one or more team integration connection lookups could not be loaded.");

    expect(
      successfulConnectedAppStatusConnectionResults([
        null,
        { connections: [] },
        { connections: [connection("connection_x", "team_social", "x")] },
      ]),
    ).toEqual([
      { connections: [] },
      { connections: [connection("connection_x", "team_social", "x")] },
    ]);
  });

  test("resolves implicit connected app connections across teams for chat turns", async () => {
    const calls: unknown[] = [];
    const result = await resolveImplicitConnectedAppStatusConnections(
      {
        listOrganizations: async () => [
          organization("team_empty", "owner", "active"),
          organization("team_social", "member", "active"),
          organization("team_unavailable", "member", "active"),
        ],
        integrationConnections: async (input: { teamId?: string; status?: string }) => {
          calls.push(input);
          if (input.teamId === "team_unavailable") throw new Error("503 unavailable");
          if (input.teamId === "team_social") {
            return {
              teamId: "team_social",
              connections: [connection("connection_x", "team_social", "x")],
            };
          }
          return { teamId: input.teamId ?? null, connections: [] };
        },
      } as never,
      { status: "active" },
    );

    expect(calls).toEqual([
      { teamId: "team_empty", status: "active" },
      { teamId: "team_social", status: "active" },
      { teamId: "team_unavailable", status: "active" },
    ]);
    expect(result).toEqual({
      teamId: "team_social",
      connections: [connection("connection_x", "team_social", "x")],
    });
  });

  test("lists integration connections across active teams when no team is supplied", async () => {
    const requests: Array<{ pathname: string; search: string }> = [];
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ pathname: url.pathname, search: url.search });
      if (url.pathname === "/v1/organizations") {
        return Response.json({
          organizations: [
            organization("team_selected", "owner", "active"),
            organization("team_social", "member", "active"),
          ],
        });
      }
      if (url.pathname === "/v1/integrations/connections" && url.searchParams.get("teamId") === "team_social") {
        return Response.json({
          teamId: "team_social",
          connections: [connection("connection_x", "team_social", "x")],
        });
      }
      return Response.json({
        teamId: url.searchParams.get("teamId"),
        connections: [],
      });
    };

    const result = await sandboxRequestPayload({
      type: "integration_connections",
      payload: { status: "active" },
    });

    expect(result).toMatchObject({
      teamId: "team_social",
      connections: [connection("connection_x", "team_social", "x")],
    });
    expect(requests).toEqual([
      { pathname: "/v1/organizations", search: "" },
      { pathname: "/v1/integrations/connections", search: "?teamId=team_selected&status=active" },
      { pathname: "/v1/integrations/connections", search: "?teamId=team_social&status=active" },
    ]);
  });

  test("validates provider capabilities and strips provider before cloud proxying", () => {
    expect(
      normalizeIntegrationAttachInput({
        connectionId: " connection_google ",
        provider: "google",
        capabilities: [" google.drive.file.read ", "google.docs.write"],
        scopes: [" https://www.googleapis.com/auth/drive.file "],
        resourcePolicy: { driveFolderIds: ["folder_1"] },
        ttlSeconds: 3600.8,
        expiresAt: "2026-07-04T01:00:00.000Z",
        required: false,
      }),
    ).toEqual({
      connectionId: "connection_google",
      capabilities: ["google.drive.file.read", "google.docs.write"],
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      resourcePolicy: { driveFolderIds: ["folder_1"] },
      expiresAt: "2026-07-04T01:00:00.000Z",
      ttlSeconds: 3600,
      required: false,
    });
  });

  test("supports all current leaseable OAuth providers at the attach and runtime-lease boundary", () => {
    const providers = [
      ["google", "google.drive.file.read"],
      ["github", "github.repo.read"],
      ["x", "x.profile.read"],
    ] as const;

    for (const [provider, capability] of providers) {
      expect(
        normalizeIntegrationAttachInput({
          connectionId: `connection_${provider}`,
          provider,
          capabilities: [capability],
        }),
      ).toEqual({
        connectionId: `connection_${provider}`,
        capabilities: [capability],
      });
    }

    expect(
      normalizeCreateInput({
        integrationLeases: providers.map(([provider, capability]) => ({
          leaseId: `lease_${provider}`,
          provider,
          capabilities: [capability],
          proxyUrl: `https://proxy.openpond.ai/lease_${provider}`,
        })),
      }).integrationLeases,
    ).toEqual([
      {
        leaseId: "lease_google",
        provider: "google",
        capabilities: ["google.drive.file.read"],
        proxyUrl: "https://proxy.openpond.ai/lease_google",
      },
      {
        leaseId: "lease_github",
        provider: "github",
        capabilities: ["github.repo.read"],
        proxyUrl: "https://proxy.openpond.ai/lease_github",
      },
      {
        leaseId: "lease_x",
        provider: "x",
        capabilities: ["x.profile.read"],
        proxyUrl: "https://proxy.openpond.ai/lease_x",
      },
    ]);
  });

  test("rejects malformed integration lease scope, ttl, expiry, and resource policy input", () => {
    const base = {
      connectionId: "connection_google",
      provider: "google",
      capabilities: ["google.drive.file.read"],
    };

    expect(() =>
      normalizeIntegrationAttachInput({
        ...base,
        scopes: "drive.readonly",
      }),
    ).toThrow("Sandbox integration scopes must be an array of strings.");
    expect(() =>
      normalizeIntegrationAttachInput({
        ...base,
        ttlSeconds: 0,
      }),
    ).toThrow("Sandbox integration ttlSeconds must be a positive number.");
    expect(() =>
      normalizeIntegrationAttachInput({
        ...base,
        expiresAt: "not-a-date",
      }),
    ).toThrow("Sandbox integration expiresAt must be a valid ISO timestamp.");
    expect(() =>
      normalizeIntegrationAttachInput({
        ...base,
        resourcePolicy: ["folder_1"],
      }),
    ).toThrow("Sandbox integration resourcePolicy must be an object.");
    expect(() =>
      normalizeIntegrationAttachInput({
        ...base,
        resourcePolicy: { accessToken: "provider-token" },
      }),
    ).toThrow("Sandbox integration resourcePolicy must not include secrets or credentials.");
  });

  test("rejects overbroad provider capability requests", () => {
    expect(() =>
      normalizeIntegrationAttachInput({
        connectionId: "connection_google",
        provider: "google",
        capabilities: ["google.drive.file.read", "github.repo.read"],
      }),
    ).toThrow("Sandbox integration capabilities are not allowed for google: github.repo.read");
  });

  test("rejects non-leaseable integration providers", () => {
    expect(() =>
      normalizeIntegrationAttachInput({
        connectionId: "connection_mcp",
        provider: "mcp",
        capabilities: ["mcp.tool.call"],
      }),
    ).toThrow("Sandbox integration provider is not leaseable: mcp");
  });

  test("rejects runtime integration leases with connection ids, secret keys, or overbroad capabilities", () => {
    const base = {
      leaseId: "lease_google",
      provider: "google",
      capabilities: ["google.drive.file.read"],
    };

    expect(() =>
      normalizeCreateInput({
        integrationLeases: [{ ...base, connectionId: "connection_google" }],
      }),
    ).toThrow("Sandbox integration leases must use leaseId/proxy refs, not connection ids.");
    expect(() =>
      normalizeCreateInput({
        integrationLeases: [{ ...base, accessToken: "provider-token" }],
      }),
    ).toThrow("Sandbox integration leases must not include secrets or credentials.");
    expect(() =>
      normalizeCreateInput({
        integrationLeases: [{ ...base, capabilities: ["github.repo.read"] }],
      }),
    ).toThrow("Sandbox integration capabilities are not allowed for google: github.repo.read");
  });

  test("keeps legacy attach payloads without provider valid", () => {
    expect(
      normalizeIntegrationAttachInput({
        connectionId: "connection_legacy",
        capabilities: ["provider.local.read"],
      }),
    ).toEqual({
      connectionId: "connection_legacy",
      capabilities: ["provider.local.read"],
    });
  });

  test("normalizes lease removal ids", () => {
    expect(normalizeIntegrationLeaseId({ leaseId: " lease_test " })).toBe("lease_test");
    expect(() => normalizeIntegrationLeaseId({ leaseId: " " })).toThrow(
      "Sandbox integration lease is required.",
    );
  });
});

function organization(
  teamId: string,
  role: "owner" | "admin" | "member",
  status: "active" | "disabled" | "archived",
) {
  return {
    teamId,
    slug: `${teamId}-slug`,
    name: teamId,
    displayName: teamId,
    role,
    status,
    primaryContactEmail: null,
    customDomain: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  };
}

function connection(
  id: string,
  teamId: string,
  provider: "google" | "github" | "x",
) {
  return {
    id,
    provider,
    ownerUserId: "user_test",
    teamId,
    providerAccountId: `${provider}_account`,
    providerAccountName: `${provider} account`,
    providerWorkspaceId: null,
    providerWorkspaceName: null,
    scopes: [],
    status: "active" as const,
    connectedAt: "2026-07-04T00:00:00.000Z",
    lastRefreshedAt: null,
    revokedAt: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  };
}

describe("sandbox chat default runtime selection", () => {
  test("marks app chat runtimes as default reusable runtimes", () => {
    expect(
      sandboxChatDefaultRuntimeMetadata({
        requestId: "request_test",
        defaultRuntime: true,
        projectId: "project_test",
      }),
    ).toEqual({
      source: "openpond-app-sandbox-chat",
      openpondAppCreateRequestId: "request_test",
      openpondAppDefaultRuntime: true,
      projectId: "project_test",
    });
  });

  test("omits the reusable runtime marker for detached action sandboxes", () => {
    expect(
      sandboxChatDefaultRuntimeMetadata({
        requestId: "request_test",
        defaultRuntime: false,
        openpondAppDefaultRuntime: true,
      }),
    ).toEqual({
      source: "openpond-app-sandbox-chat",
      openpondAppCreateRequestId: "request_test",
    });
  });

  test("preserves Hybrid runtime source attribution", () => {
    expect(
      sandboxChatDefaultRuntimeMetadata({
        requestId: "request_test",
        defaultRuntime: true,
        source: "openpond-app-hybrid-chat-preflight",
        projectId: "project_test",
      }),
    ).toEqual({
      source: "openpond-app-hybrid-chat-preflight",
      openpondAppCreateRequestId: "request_test",
      openpondAppDefaultRuntime: true,
      projectId: "project_test",
    });
  });

  test("does not describe creating attached sandboxes as active", () => {
    expect(
      summarizeSandboxToolResult("sandbox_create", {
        sandbox: {
          id: "sandbox_creating",
          state: "creating",
        },
      }),
    ).toBe("Sandbox workspace attached: sandbox_creating (creating)");
    expect(
      summarizeSandboxToolResult("sandbox_create", {
        sandbox: {
          id: "sandbox_running",
          state: "running",
        },
      }),
    ).toBe("Active sandbox workspace: sandbox_running");
  });

  test("selects only matching non-terminal default runtimes for a project agent", () => {
    const runtime = pickSandboxChatDefaultRuntime({
      projectId: "project_test",
      agentId: "agent_test",
      mode: "feature",
      runtimes: [
        {
          id: "runtime_archived",
          projectId: "project_test",
          agentId: "agent_test",
          mode: "feature",
          status: "archived",
          metadata: { openpondAppDefaultRuntime: true },
        },
        {
          id: "runtime_other_agent",
          projectId: "project_test",
          agentId: "agent_other",
          mode: "feature",
          status: "running",
          metadata: { openpondAppDefaultRuntime: true },
        },
        {
          id: "runtime_default",
          projectId: "project_test",
          agentId: "agent_test",
          mode: "feature",
          status: "waiting_for_user",
          metadata: { openpondAppDefaultRuntime: true },
        },
      ] as never,
    });

    expect(runtime?.id).toBe("runtime_default");
  });

  test("does not select checkpointed default runtimes without rootfs snapshots", () => {
    const runtime = pickSandboxChatDefaultRuntime({
      projectId: "project_test",
      agentId: "agent_test",
      mode: "feature",
      runtimes: [
        {
          id: "runtime_checkpoint_without_snapshot",
          projectId: "project_test",
          agentId: "agent_test",
          mode: "feature",
          status: "checkpointed",
          rootfsSnapshotId: null,
          metadata: { openpondAppDefaultRuntime: true },
        },
        {
          id: "runtime_checkpoint_with_snapshot",
          projectId: "project_test",
          agentId: "agent_test",
          mode: "feature",
          status: "checkpointed",
          rootfsSnapshotId: "snapshot_test",
          metadata: { openpondAppDefaultRuntime: true },
        },
      ] as never,
    });

    expect(runtime?.id).toBe("runtime_checkpoint_with_snapshot");
  });
});

describe("sandbox mentioned app tool requests", () => {
  test("does not rewrite app mentions into sandbox-owned app requests", () => {
    const request = normalizeMentionedSandboxToolRequest({
      request: {
        action: "sandbox_create",
        source: "chat_action",
        args: {
          appId: "app_test",
          budget: { maxUsd: "0.05" },
        },
      },
      userPrompt: "@deepseek-template hello deepseek",
      mentionedApps: [
        {
          id: "app_test",
          name: "deepseek-template",
          gitRepo: "deepseek-template",
          sandbox: true,
          sandboxActionRegistry: {
            defaultActionName: "stream-chat",
            inputSchema: {
              type: "object",
              properties: {
                prompt: { type: "string" },
              },
            },
            actions: [{ name: "stream-chat" }],
          },
        } as never,
      ],
    });

    expect(request).toEqual({
      action: "sandbox_create",
      source: "chat_action",
      args: {
        appId: "app_test",
        budget: { maxUsd: "0.05" },
      },
    });
  });
});

function sandboxLifecycleRecord(
  id: string,
  state: "creating" | "running" | "stopped" | "archived" | "deleted" | "error",
  reservationStatus: "reserved" | "captured" | "released",
) {
  return {
    id,
    state,
    reservation: {
      id: `reservation_${id}`,
      status: reservationStatus,
      reservedUsd: "0.050000",
      capturedUsd: reservationStatus === "captured" ? "0.010000" : "0.000000",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      mpp: {
        mode: "simulated_poc",
        reservationRef: `mpp_${id}`,
        settlementRail: "tempo_usdce",
      },
    },
    receipts: [],
    logs: [],
  };
}
