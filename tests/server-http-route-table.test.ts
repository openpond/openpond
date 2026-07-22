import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import {
  createHttpRequestHandler,
  type HttpRouteDeps,
} from "../apps/server/src/api/http-routes";
import { CommunityApiError } from "../apps/server/src/openpond/community-client";

type RecordedCall = {
  name: string;
  args: unknown[];
};

describe("server HTTP route table", () => {
  test("dispatches representative authenticated routes to extracted domain handlers", async () => {
    const calls: RecordedCall[] = [];
    const deps = routeTableDeps(calls);
    const server = createServer(createHttpRequestHandler(deps));

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await expect(
        expectJsonRequest(origin, "GET", "/v1/profile", 200)
      ).resolves.toMatchObject({
        name: "profileCurrentPayload",
      });
      await expect(
        expectJsonRequest(origin, "GET", "/v1/extensions", 200)
      ).resolves.toMatchObject({
        name: "extensionCatalogPayload",
      });
      await expect(
        expectJsonRequest(
          origin,
          "GET",
          "/v1/skills/extension/duckailabs%2Fducky-capital-skills/source?path=README.md",
          200
        )
      ).resolves.toMatchObject({
        name: "skillSourceFilePayload",
        args: ["extension", "duckailabs/ducky-capital-skills", "README.md"],
      });
      await expect(
        expectJsonRequest(origin, "POST", "/v1/extensions", 201, {
          source: "owner/repo",
        })
      ).resolves.toMatchObject({
        name: "extensionAddPayload",
        args: [{ source: "owner/repo" }],
      });
      await expect(
        expectJsonRequest(origin, "POST", "/v1/extensions/github/owner/repo/update", 200, {
          ref: "v2",
        })
      ).resolves.toMatchObject({
        name: "extensionUpdatePayload",
        args: [{ source: "owner/repo", ref: "v2" }],
      });
      await expect(
        expectJsonRequest(origin, "DELETE", "/v1/extensions/github/owner/repo", 200)
      ).resolves.toMatchObject({
        name: "extensionRemovePayload",
        args: ["owner/repo"],
      });
      await expect(
        expectJsonRequest(
          origin,
          "PATCH",
          "/v1/profile/agents/support%20agent/name",
          200,
          { name: "Support Assistant" }
        )
      ).resolves.toMatchObject({
        name: "profileRenameAgentPayload",
        args: ["support agent", { name: "Support Assistant" }],
      });
      await expect(
        expectJsonRequest(origin, "GET", "/v1/organizations", 200)
      ).resolves.toMatchObject({
        name: "organizationPayload",
        args: [{ type: "list" }],
      });
      await expect(
        expectJsonRequest(origin, "GET", "/v1/sandboxes?teamId=team-1", 200)
      ).resolves.toMatchObject({
        name: "sandboxPayload",
        args: [{ type: "list", payload: { teamId: "team-1" } }],
      });
      await expect(
        expectJsonRequest(
          origin,
          "GET",
          "/v1/team-chat/agents?teamId=team-1",
          200
        )
      ).resolves.toMatchObject({
        name: "teamChatPayload",
        args: [{ type: "agents", teamId: "team-1" }],
      });
      await expect(
        expectJsonRequest(
          origin,
          "GET",
          "/v1/communities?cursor=community-cursor",
          200
        )
      ).resolves.toMatchObject({
        name: "communityPayload",
        args: [{ type: "discover", cursor: "community-cursor" }],
      });
      await expect(
        expectJsonRequest(
          origin,
          "POST",
          "/v1/communities/community-1/join",
          201,
          {
            acceptedRulesVersionId: "rules-1",
          }
        )
      ).resolves.toMatchObject({
        name: "communityPayload",
        args: [
          {
            type: "join",
            communityId: "community-1",
            acceptedRulesVersionId: "rules-1",
          },
        ],
      });
      await expect(
        expectJsonRequest(origin, "POST", "/v1/projects", 201, {
          name: "Local repo",
        })
      ).resolves.toMatchObject({
        name: "createLocalProjectPayload",
        args: [{ name: "Local repo" }],
      });
      await expect(
        expectJsonRequest(
          origin,
          "GET",
          "/v1/providers/provider-one/models?refresh=1&limit=5",
          200
        )
      ).resolves.toMatchObject({
        name: "listProviderModelsPayload",
        args: ["provider-one", { refresh: true, limit: 5 }],
      });
      await expect(
        expectJsonRequest(origin, "POST", "/v1/diagnostics/client", 201, {
          message: "UI failed",
          surface: "app",
        })
      ).resolves.toMatchObject({
        name: "recordClientDiagnosticPayload",
        args: [{ message: "UI failed", surface: "app" }],
      });
      await expect(
        expectJsonRequest(origin, "GET", "/v1/workspaces/app-1/diff", 200)
      ).resolves.toMatchObject({
        name: "workspaceDiffPayload",
        args: ["app-1"],
      });
      await expect(
        expectJsonRequest(origin, "GET", "/v1/lsp/status", 200)
      ).resolves.toMatchObject({
        name: "workspaceLspRuntimeStatusPayload",
      });
      await expect(
        expectJsonRequest(origin, "GET", "/v1/insights?status=active", 200)
      ).resolves.toMatchObject({
        name: "listInsightsPayload",
      });
      await expect(
        expectJsonRequest(origin, "POST", "/v1/insights/scan", 202)
      ).resolves.toMatchObject({
        name: "runInsightsScanPayload",
      });
      await expect(
        expectJsonRequest(origin, "PATCH", "/v1/insights/insight-1", 200, {
          status: "dismissed",
        })
      ).resolves.toMatchObject({
        name: "patchInsightPayload",
        args: ["insight-1", { status: "dismissed" }],
      });
      await expect(
        expectJsonRequest(origin, "POST", "/v1/lsp/restart", 200)
      ).resolves.toMatchObject({
        name: "restartWorkspaceLspPayload",
      });
      await expect(
        expectJsonRequest(origin, "POST", "/v1/sessions/session-1/turns", 202, {
          prompt: "Hi",
        })
      ).resolves.toMatchObject({
        name: "sendTurn",
        args: ["session-1", { prompt: "Hi" }],
      });
      await expect(
        expectJsonRequest(
          origin,
          "POST",
          "/v1/subagents/run-1/lifecycle",
          200,
          { action: "archive" }
        )
      ).resolves.toMatchObject({
        name: "runSubagentLifecycleAction",
        args: ["run-1", { action: "archive" }],
      });
      await expect(
        expectJsonRequest(
          origin,
          "POST",
          "/v1/sessions/session-1/preflight-turns/failure",
          200,
          {
            prompt: "Edit README",
            error: "Cloud sandbox sandbox_1 is error.",
            target: "hybrid_sandbox",
          }
        )
      ).resolves.toMatchObject({
        name: "recordPreflightTurnFailure",
        args: [
          "session-1",
          {
            prompt: "Edit README",
            error: "Cloud sandbox sandbox_1 is error.",
            target: "hybrid_sandbox",
          },
        ],
      });
      await expect(
        expectJsonRequest(
          origin,
          "POST",
          "/v1/sessions/session-1/workspace/ensure-ready",
          200,
          {
            branch: "feature/ready",
            surface: "terminal",
          }
        )
      ).resolves.toMatchObject({
        name: "ensureCloudWorkspaceReady",
        args: ["session-1", { branch: "feature/ready", surface: "terminal" }],
      });
      await expect(
        expectJsonRequest(
          origin,
          "POST",
          "/v1/codex-history/codex_history_thread-1/turns/interrupt",
          202
        )
      ).resolves.toMatchObject({
        name: "interruptCodexHistoryTurnPayload",
        args: ["codex_history_thread-1"],
      });

      expect(calls.map((call) => call.name)).toEqual([
        "profileCurrentPayload",
        "extensionCatalogPayload",
        "skillSourceFilePayload",
        "extensionAddPayload",
        "extensionUpdatePayload",
        "extensionRemovePayload",
        "profileRenameAgentPayload",
        "organizationPayload",
        "sandboxPayload",
        "teamChatPayload",
        "communityPayload",
        "communityPayload",
        "createLocalProjectPayload",
        "listProviderModelsPayload",
        "recordClientDiagnosticPayload",
        "workspaceDiffPayload",
        "workspaceLspRuntimeStatusPayload",
        "listInsightsPayload",
        "runInsightsScanPayload",
        "patchInsightPayload",
        "restartWorkspaceLspPayload",
        "sendTurn",
        "runSubagentLifecycleAction",
        "recordPreflightTurnFailure",
        "ensureCloudWorkspaceReady",
        "interruptCodexHistoryTurnPayload",
      ]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("preserves hosted community status, code, and recovery details", async () => {
    const deps = routeTableDeps([]);
    deps.communityPayload = async () => {
      throw new CommunityApiError("community_rules_version_stale", 409, {
        currentRulesVersionId: "rules-2",
      });
    };
    const server = createServer(createHttpRequestHandler(deps));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/communities/community-1/join`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer route-table-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ acceptedRulesVersionId: "rules-1" }),
        }
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "community_rules_version_stale",
        details: { currentRulesVersionId: "rules-2" },
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

async function expectJsonRequest(
  origin: string,
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: "Bearer route-table-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}

function routeTableDeps(calls: RecordedCall[]): HttpRouteDeps {
  const base = {
    host: "127.0.0.1",
    getActualPort: () => 0,
    token: "route-table-token",
    version: "route-table-test",
    runtimeVersion: "runtime-test",
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    subscribers: new Set<ServerResponse>(),
    async workspaceImagePayload() {
      throw new Error(
        "workspace image route not expected in route table dispatch test"
      );
    },
  };
  return new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return async (...args: unknown[]) => {
        const call = {
          name: String(property),
          args: args.map((arg) => (arg instanceof URL ? arg.toString() : arg)),
        };
        calls.push(call);
        return call;
      };
    },
  }) as unknown as HttpRouteDeps;
}
