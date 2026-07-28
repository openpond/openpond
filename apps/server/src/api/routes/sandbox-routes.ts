import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleSandboxRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const {
    sandboxPayload,
  } = deps;
  if (request.method === "GET" && requestUrl.pathname === "/v1/integrations/connections") {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "integration_connections",
        payload: {
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId") ?? undefined,
          agentId: requestUrl.searchParams.get("agentId") ?? undefined,
          status: requestUrl.searchParams.get("status") ?? undefined,
        },
      }),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/connected-apps/status") {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "connected_app_status",
        payload: {
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId") ?? undefined,
          agentId: requestUrl.searchParams.get("agentId") ?? undefined,
          status: requestUrl.searchParams.get("status") ?? "all",
        },
      }),
    );
    return true;
  }
  const sandboxMatch = /^\/v1\/sandboxes\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "GET" && sandboxMatch) {
    sendJson(
      response,
      200,
      await sandboxPayload({ type: "get", sandboxId: decodeURIComponent(sandboxMatch[1]!) }),
    );
    return true;
  }
  const sandboxIntegrationsMatch = /^\/v1\/sandboxes\/([^/]+)\/integrations$/.exec(
    requestUrl.pathname,
  );
  if (sandboxIntegrationsMatch) {
    const sandboxId = decodeURIComponent(sandboxIntegrationsMatch[1]!);
    if (request.method === "GET") {
      sendJson(response, 200, await sandboxPayload({ type: "integration_leases", sandboxId }));
      return true;
    }
    if (request.method === "POST") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "integration_attach",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "DELETE") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "integration_remove",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
  }
  const sandboxPreserveSourceMatch =
    /^\/v1\/sandboxes\/([^/]+)\/preserve-source$/.exec(requestUrl.pathname);
  if (request.method === "POST" && sandboxPreserveSourceMatch) {
    const sandboxId = decodeURIComponent(sandboxPreserveSourceMatch[1]!);
    const sandboxRecord = asRecord(
      asRecord(await sandboxPayload({ type: "get", sandboxId })).sandbox,
    );
    const runtimeId =
      typeof sandboxRecord.runtimeId === "string" ? sandboxRecord.runtimeId.trim() : "";
    if (!runtimeId) {
      throw new Error("Active sandbox is not attached to a sandbox runtime.");
    }
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "sandbox_runtime_preserve_source",
        runtimeId,
        payload: {
          ...asRecord(await readJson(request)),
          sandboxId,
        },
      }),
    );
    return true;
  }
  const sandboxFilesMatch = /^\/v1\/sandboxes\/([^/]+)\/files$/.exec(requestUrl.pathname);
  if (sandboxFilesMatch) {
    const sandboxId = decodeURIComponent(sandboxFilesMatch[1]!);
    if (request.method === "GET" && requestUrl.searchParams.get("list") === "1") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "list_files",
          sandboxId,
          payload: {
            path: requestUrl.searchParams.get("path") ?? undefined,
            recursive: requestUrl.searchParams.has("recursive")
              ? requestUrl.searchParams.get("recursive") !== "false"
              : undefined,
            maxEntries: requestUrl.searchParams.get("maxEntries") ?? undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "GET") {
      sendJson(
        response,
        200,
      await sandboxPayload({
        type: "download_file",
        sandboxId,
        payload: {
          path: requestUrl.searchParams.get("path") ?? "",
          offsetBytes: requestUrl.searchParams.get("offsetBytes") ?? undefined,
          maxBytes: requestUrl.searchParams.get("maxBytes") ?? undefined,
        },
      }),
    );
      return true;
    }
    if (request.method === "POST") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "upload_file",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
  }
  const sandboxGitMatch =
    /^\/v1\/sandboxes\/([^/]+)\/git\/(status|diff)$/.exec(
      requestUrl.pathname,
    );
  if (sandboxGitMatch) {
    const sandboxId = decodeURIComponent(sandboxGitMatch[1]!);
    const gitAction = sandboxGitMatch[2]!;
    if (request.method === "GET" && gitAction === "status") {
      sendJson(response, 200, await sandboxPayload({ type: "git_status", sandboxId }));
      return true;
    }
    if (request.method === "POST" && gitAction === "diff") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "git_diff",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
  }
  if (requestUrl.pathname === "/v1/sandbox-projects") {
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "project_list",
          payload: { teamId: requestUrl.searchParams.get("teamId") ?? undefined },
        }),
      );
      return true;
    }
    if (request.method === "POST") {
      sendJson(
        response,
        201,
        await sandboxPayload({ type: "project_upsert", payload: await readJson(request) }),
      );
      return true;
    }
  }
  const sandboxProjectMatch = /^\/v1\/sandbox-projects\/([^/]+)$/.exec(
    requestUrl.pathname,
  );
  const sandboxProjectSyncMatch = /^\/v1\/sandbox-projects\/([^/]+)\/sync$/.exec(
    requestUrl.pathname,
  );
  const sandboxProjectSourceUploadMatch = /^\/v1\/sandbox-projects\/([^/]+)\/source$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && sandboxProjectSyncMatch) {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "project_sync",
        projectId: decodeURIComponent(sandboxProjectSyncMatch[1]!),
        payload: { teamId: requestUrl.searchParams.get("teamId") ?? undefined },
      }),
    );
    return true;
  }
  if (request.method === "POST" && sandboxProjectSourceUploadMatch) {
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "project_source_upload",
        projectId: decodeURIComponent(sandboxProjectSourceUploadMatch[1]!),
        payload: {
          ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
        },
      }),
    );
    return true;
  }
  if (sandboxProjectMatch) {
    const projectId = decodeURIComponent(sandboxProjectMatch[1]!);
    const payload = { teamId: requestUrl.searchParams.get("teamId") ?? undefined };
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({ type: "project_get", projectId, payload }),
      );
      return true;
    }
    if (request.method === "DELETE") {
      sendJson(
        response,
        200,
        await sandboxPayload({ type: "project_archive", projectId, payload }),
      );
      return true;
    }
  }
  if (requestUrl.pathname === "/v1/sandbox-agents") {
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "agent_list",
          payload: { teamId: requestUrl.searchParams.get("teamId") ?? undefined },
        }),
      );
      return true;
    }
    if (request.method === "POST") {
      sendJson(
        response,
        201,
        await sandboxPayload({ type: "agent_upsert", payload: await readJson(request) }),
      );
      return true;
    }
  }
  const sandboxAgentRunMatch = /^\/v1\/sandbox-agents\/([^/]+)\/run$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && sandboxAgentRunMatch) {
    sendJson(
      response,
      201,
      await sandboxPayload({
        type: "agent_run",
        agentId: decodeURIComponent(sandboxAgentRunMatch[1]!),
        payload: await readJson(request),
      }),
    );
    return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
