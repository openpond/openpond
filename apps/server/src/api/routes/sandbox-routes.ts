import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleSandboxRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const {
    sandboxPayload,
  } = deps;
  if (request.method === "GET" && requestUrl.pathname === "/v1/sandboxes") {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "list",
        payload: {
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId") ?? undefined,
          agentId: requestUrl.searchParams.get("agentId") ?? undefined,
        },
      }),
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/runtimes") {
    sendJson(
      response,
      201,
      await sandboxPayload({
        type: "sandbox_runtime_create",
        payload: await readJson(request),
      }),
    );
    return true;
  }
  const sandboxRuntimeSandboxMatch =
    /^\/v1\/runtimes\/([^/]+)\/sandbox$/.exec(requestUrl.pathname);
  if (request.method === "POST" && sandboxRuntimeSandboxMatch) {
    sendJson(
      response,
      202,
      await sandboxPayload({
        type: "sandbox_runtime_sandbox_create",
        runtimeId: decodeURIComponent(sandboxRuntimeSandboxMatch[1]!),
        payload: await readJson(request),
      }),
    );
    return true;
  }
  if (requestUrl.pathname === "/v1/sandboxes/volumes") {
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "volume_list",
          payload: {
            teamId: requestUrl.searchParams.get("teamId") ?? undefined,
            projectId: requestUrl.searchParams.get("projectId") ?? undefined,
            agentId: requestUrl.searchParams.get("agentId") ?? undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "POST") {
      sendJson(
        response,
        201,
        await sandboxPayload({ type: "volume_create", payload: await readJson(request) }),
      );
      return true;
    }
  }
  const sandboxVolumeMatch = /^\/v1\/sandboxes\/volumes\/([^/]+)$/.exec(requestUrl.pathname);
  if (sandboxVolumeMatch) {
    const volumeId = decodeURIComponent(sandboxVolumeMatch[1]!);
    const payload = {
      teamId: requestUrl.searchParams.get("teamId") ?? undefined,
      projectId: requestUrl.searchParams.get("projectId") ?? undefined,
      agentId: requestUrl.searchParams.get("agentId") ?? undefined,
    };
    if (request.method === "GET") {
      sendJson(response, 200, await sandboxPayload({ type: "volume_get", volumeId, payload }));
      return true;
    }
    if (request.method === "DELETE") {
      sendJson(response, 200, await sandboxPayload({ type: "volume_delete", volumeId, payload }));
      return true;
    }
  }
  if (requestUrl.pathname === "/v1/sandbox-secrets") {
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "secret_list",
          payload: {
            teamId: requestUrl.searchParams.get("teamId") ?? undefined,
            projectId: requestUrl.searchParams.get("projectId") ?? undefined,
            agentId: requestUrl.searchParams.get("agentId") ?? undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      sendJson(
        response,
        201,
        await sandboxPayload({ type: "secret_create", payload: body }),
      );
      return true;
    }
  }
  const sandboxSecretMatch = /^\/v1\/sandbox-secrets\/([^/]+)(?:\/(rotate|attach|revoke))?$/.exec(
    requestUrl.pathname,
  );
  if (sandboxSecretMatch) {
    const secretId = decodeURIComponent(sandboxSecretMatch[1]!);
    const action = sandboxSecretMatch[2] ?? "";
    if (request.method === "GET" && !action) {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "secret_get",
          secretId,
          payload: {
            teamId: requestUrl.searchParams.get("teamId") ?? undefined,
            projectId: requestUrl.searchParams.get("projectId") ?? undefined,
            agentId: requestUrl.searchParams.get("agentId") ?? undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "POST" && action === "rotate") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "secret_rotate",
          secretId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "POST" && action === "attach") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "secret_attach",
          secretId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "POST" && action === "revoke") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "secret_revoke",
          secretId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "DELETE" && !action) {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "secret_delete",
          secretId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/sandboxes/snapshots") {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "snapshot_catalog",
        payload: {
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId") ?? undefined,
          agentId: requestUrl.searchParams.get("agentId") ?? undefined,
          q: requestUrl.searchParams.get("q") ?? undefined,
          replayState: requestUrl.searchParams.get("replayState") ?? undefined,
          tag: requestUrl.searchParams.get("tag") ?? undefined,
          useCase: requestUrl.searchParams.get("useCase") ?? undefined,
        },
      }),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/sandboxes/templates") {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "template_catalog",
        payload: {
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId") ?? undefined,
          q: requestUrl.searchParams.get("q") ?? undefined,
          name: requestUrl.searchParams.get("name") ?? undefined,
          version: requestUrl.searchParams.get("version") ?? undefined,
          tag: requestUrl.searchParams.get("tag") ?? undefined,
          useCase: requestUrl.searchParams.get("useCase") ?? undefined,
        },
      }),
    );
    return true;
  }
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
  const sandboxCatalogForkMatch = /^\/v1\/sandboxes\/snapshots\/([^/]+)\/fork$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && sandboxCatalogForkMatch) {
    const body = await readJson(request);
    const payload =
      body && typeof body === "object" && !Array.isArray(body) ? body : {};
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "snapshot_fork",
        snapshotId: decodeURIComponent(sandboxCatalogForkMatch[1]!),
        payload: {
          ...payload,
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId") ?? undefined,
        },
      }),
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/sandboxes/templates/launch") {
    const body = await readJson(request);
    const payload =
      body && typeof body === "object" && !Array.isArray(body) ? body : {};
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "template_launch",
        payload: {
          ...payload,
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId") ?? undefined,
        },
      }),
    );
    return true;
  }
  if (requestUrl.pathname === "/v1/sandbox-replays") {
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "replays",
          payload: {
            teamId: requestUrl.searchParams.get("teamId") ?? undefined,
            projectId: requestUrl.searchParams.get("projectId") ?? undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      const payload =
        body && typeof body === "object" && !Array.isArray(body) ? body : {};
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "replay_start",
          payload: {
            ...payload,
            teamId: requestUrl.searchParams.get("teamId") ?? undefined,
            projectId: requestUrl.searchParams.get("projectId") ?? undefined,
          },
        }),
      );
      return true;
    }
  }
  const sandboxReplayMatch = /^\/v1\/sandbox-replays\/([^/]+)(?:\/(logs|artifacts|cancel))?$/.exec(
    requestUrl.pathname,
  );
  if (sandboxReplayMatch) {
    const replayId = decodeURIComponent(sandboxReplayMatch[1]!);
    const action = sandboxReplayMatch[2] ?? "";
    const payload = {
      teamId: requestUrl.searchParams.get("teamId") ?? undefined,
      projectId: requestUrl.searchParams.get("projectId") ?? undefined,
    };
    if (request.method === "GET" && !action) {
      sendJson(response, 200, await sandboxPayload({ type: "replay_get", replayId, payload }));
      return true;
    }
    if (request.method === "GET" && action === "logs") {
      sendJson(response, 200, await sandboxPayload({ type: "replay_logs", replayId, payload }));
      return true;
    }
    if (request.method === "GET" && action === "artifacts") {
      sendJson(response, 200, await sandboxPayload({ type: "replay_artifacts", replayId, payload }));
      return true;
    }
    if (request.method === "POST" && action === "cancel") {
      sendJson(response, 200, await sandboxPayload({ type: "replay_cancel", replayId, payload }));
      return true;
    }
  }
  if (requestUrl.pathname === "/v1/sandbox-template-builds") {
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "template_builds",
          payload: {
            teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "POST") {
      sendJson(
        response,
        202,
        await sandboxPayload({
          type: "template_build_create",
          payload: await readJson(request),
        }),
      );
      return true;
    }
  }
  const sandboxTemplateBuildActionMatch =
    /^\/v1\/sandbox-template-builds\/([^/]+)(?:\/(logs|cancel))?$/.exec(
      requestUrl.pathname,
    );
  if (sandboxTemplateBuildActionMatch) {
    const buildId = decodeURIComponent(sandboxTemplateBuildActionMatch[1]!);
    const action = sandboxTemplateBuildActionMatch[2] ?? "";
    if (request.method === "GET" && !action) {
      sendJson(response, 200, await sandboxPayload({ type: "template_build_get", buildId }));
      return true;
    }
    if (request.method === "GET" && action === "logs") {
      sendJson(response, 200, await sandboxPayload({ type: "template_build_logs", buildId }));
      return true;
    }
    if (request.method === "POST" && action === "cancel") {
      sendJson(response, 200, await sandboxPayload({ type: "template_build_cancel", buildId }));
      return true;
    }
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/sandboxes") {
    sendJson(
      response,
      201,
      await sandboxPayload({ type: "create", payload: await readJson(request) }),
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
  if (request.method === "DELETE" && sandboxMatch) {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "delete",
        sandboxId: decodeURIComponent(sandboxMatch[1]!),
        failOnUnpreservedChanges:
          requestUrl.searchParams.get("failOnUnpreservedChanges") === "true" ||
          requestUrl.searchParams.get("failOnUnpreservedChanges") === "1",
      }),
    );
    return true;
  }
  const sandboxSnapshotCreateMatch = /^\/v1\/sandboxes\/([^/]+)\/snapshots$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && sandboxSnapshotCreateMatch) {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "snapshot_create",
        sandboxId: decodeURIComponent(sandboxSnapshotCreateMatch[1]!),
        payload: await readJson(request),
      }),
    );
    return true;
  }
  const sandboxSnapshotMatch = /^\/v1\/sandboxes\/([^/]+)\/snapshots\/([^/]+)$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "PATCH" && sandboxSnapshotMatch) {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "snapshot_update",
        sandboxId: decodeURIComponent(sandboxSnapshotMatch[1]!),
        snapshotId: decodeURIComponent(sandboxSnapshotMatch[2]!),
        payload: await readJson(request),
      }),
    );
    return true;
  }
  const sandboxSnapshotActionMatch =
    /^\/v1\/sandboxes\/([^/]+)\/snapshots\/([^/]+)\/(validate|publish)$/.exec(
      requestUrl.pathname,
    );
  if (request.method === "POST" && sandboxSnapshotActionMatch) {
    const sandboxId = decodeURIComponent(sandboxSnapshotActionMatch[1]!);
    const snapshotId = decodeURIComponent(sandboxSnapshotActionMatch[2]!);
    const action = sandboxSnapshotActionMatch[3]!;
    sendJson(
      response,
      200,
      await sandboxPayload(
        action === "validate"
          ? {
              type: "snapshot_validate",
              sandboxId,
              snapshotId,
              payload: await readJson(request),
            }
          : {
              type: "snapshot_publish",
              sandboxId,
              snapshotId,
            },
      ),
    );
    return true;
  }
  const sandboxForkMatch = /^\/v1\/sandboxes\/([^/]+)\/fork$/.exec(requestUrl.pathname);
  if (request.method === "POST" && sandboxForkMatch) {
    sendJson(
      response,
      200,
      await sandboxPayload({
        type: "fork",
        sandboxId: decodeURIComponent(sandboxForkMatch[1]!),
        payload: await readJson(request),
      }),
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
  const sandboxActionMatch =
    /^\/v1\/sandboxes\/([^/]+)\/(exec|ports|stop|receipts|logs|billing)$/.exec(
      requestUrl.pathname,
    );
  if (sandboxActionMatch) {
    const sandboxId = decodeURIComponent(sandboxActionMatch[1]!);
    const action = sandboxActionMatch[2]!;
    if (request.method === "POST" && action === "exec") {
      sendJson(
        response,
        200,
        await sandboxPayload({ type: "exec", sandboxId, payload: await readJson(request) }),
      );
      return true;
    }
    if (request.method === "POST" && action === "ports") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "open_port",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "POST" && action === "stop") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "stop",
          sandboxId,
          failOnUnpreservedChanges:
            requestUrl.searchParams.get("failOnUnpreservedChanges") === "true" ||
            requestUrl.searchParams.get("failOnUnpreservedChanges") === "1",
        }),
      );
      return true;
    }
    if (request.method === "GET" && action === "receipts") {
      sendJson(response, 200, await sandboxPayload({ type: "receipts", sandboxId }));
      return true;
    }
    if (request.method === "GET" && action === "logs") {
      sendJson(response, 200, await sandboxPayload({ type: "logs", sandboxId }));
      return true;
    }
    if (request.method === "GET" && action === "billing") {
      sendJson(response, 200, await sandboxPayload({ type: "billing", sandboxId }));
      return true;
    }
  }
  const sandboxProcessesMatch = /^\/v1\/sandboxes\/([^/]+)\/processes$/.exec(
    requestUrl.pathname,
  );
  if (sandboxProcessesMatch) {
    const sandboxId = decodeURIComponent(sandboxProcessesMatch[1]!);
    if (request.method === "POST") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "process_start",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "GET") {
      sendJson(response, 200, await sandboxPayload({ type: "process_list", sandboxId }));
      return true;
    }
  }
  const sandboxProcessMatch = /^\/v1\/sandboxes\/([^/]+)\/processes\/([^/]+)$/.exec(
    requestUrl.pathname,
  );
  if (sandboxProcessMatch) {
    const sandboxId = decodeURIComponent(sandboxProcessMatch[1]!);
    const processId = decodeURIComponent(sandboxProcessMatch[2]!);
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "process_get",
          sandboxId,
          processId,
          payload: {
            since: requestUrl.searchParams.get("since") ?? undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "DELETE") {
      sendJson(
        response,
        200,
        await sandboxPayload({ type: "process_stop", sandboxId, processId }),
      );
      return true;
    }
  }
  const sandboxPtysMatch = /^\/v1\/sandboxes\/([^/]+)\/pty$/.exec(requestUrl.pathname);
  if (sandboxPtysMatch) {
    const sandboxId = decodeURIComponent(sandboxPtysMatch[1]!);
    if (request.method === "POST") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "pty_start",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "GET") {
      sendJson(response, 200, await sandboxPayload({ type: "pty_list", sandboxId }));
      return true;
    }
  }
  const sandboxPtyInputMatch = /^\/v1\/sandboxes\/([^/]+)\/pty\/([^/]+)\/input$/.exec(
    requestUrl.pathname,
  );
  if (sandboxPtyInputMatch) {
    const sandboxId = decodeURIComponent(sandboxPtyInputMatch[1]!);
    const ptyId = decodeURIComponent(sandboxPtyInputMatch[2]!);
    if (request.method === "POST") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "pty_input",
          sandboxId,
          ptyId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
  }
  const sandboxPtyMatch = /^\/v1\/sandboxes\/([^/]+)\/pty\/([^/]+)$/.exec(
    requestUrl.pathname,
  );
  if (sandboxPtyMatch) {
    const sandboxId = decodeURIComponent(sandboxPtyMatch[1]!);
    const ptyId = decodeURIComponent(sandboxPtyMatch[2]!);
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "pty_get",
          sandboxId,
          ptyId,
          payload: {
            since: requestUrl.searchParams.get("since") ?? undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "DELETE") {
      sendJson(response, 200, await sandboxPayload({ type: "pty_stop", sandboxId, ptyId }));
      return true;
    }
  }
  const sandboxFilesMatch = /^\/v1\/sandboxes\/([^/]+)\/files$/.exec(requestUrl.pathname);
  if (sandboxFilesMatch) {
    const sandboxId = decodeURIComponent(sandboxFilesMatch[1]!);
    if (request.method === "GET" && requestUrl.searchParams.get("stat") === "1") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "stat_file",
          sandboxId,
          payload: {
            path: requestUrl.searchParams.get("path") ?? "",
          },
        }),
      );
      return true;
    }
    if (request.method === "GET" && requestUrl.searchParams.get("search") === "1") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "search_files",
          sandboxId,
          payload: {
            query: requestUrl.searchParams.get("query") ?? "",
            path: requestUrl.searchParams.get("path") ?? undefined,
            maxResults: requestUrl.searchParams.get("maxResults") ?? undefined,
          },
        }),
      );
      return true;
    }
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
    if (request.method === "DELETE") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "delete_file",
          sandboxId,
          payload: {
            path: requestUrl.searchParams.get("path") ?? "",
            recursive: requestUrl.searchParams.has("recursive")
              ? requestUrl.searchParams.get("recursive") !== "false"
              : undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "PUT") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "mkdir",
          sandboxId,
          payload: {
            path: requestUrl.searchParams.get("path") ?? "",
            recursive: requestUrl.searchParams.has("recursive")
              ? requestUrl.searchParams.get("recursive") !== "false"
              : undefined,
          },
        }),
      );
      return true;
    }
    if (request.method === "PATCH") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "move_file",
          sandboxId,
          payload: {
            fromPath: requestUrl.searchParams.get("fromPath") ?? "",
            toPath: requestUrl.searchParams.get("toPath") ?? "",
            overwrite: requestUrl.searchParams.has("overwrite")
              ? requestUrl.searchParams.get("overwrite") !== "false"
              : undefined,
          },
        }),
      );
      return true;
    }
  }
  const sandboxGitMatch =
    /^\/v1\/sandboxes\/([^/]+)\/git\/(status|diff|branch|commit|pull|push)$/.exec(
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
    if (request.method === "POST" && gitAction === "branch") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "git_branch",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "POST" && gitAction === "commit") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "git_commit",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "POST" && gitAction === "pull") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "git_pull",
          sandboxId,
          payload: await readJson(request),
        }),
      );
      return true;
    }
    if (request.method === "POST" && gitAction === "push") {
      sendJson(
        response,
        200,
        await sandboxPayload({
          type: "git_push",
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
  const sandboxAgentMatch = /^\/v1\/sandbox-agents\/([^/]+)$/.exec(
    requestUrl.pathname,
  );
  if (sandboxAgentMatch) {
    const agentId = decodeURIComponent(sandboxAgentMatch[1]!);
    const payload = { teamId: requestUrl.searchParams.get("teamId") ?? undefined };
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await sandboxPayload({ type: "agent_get", agentId, payload }),
      );
      return true;
    }
    if (request.method === "DELETE") {
      sendJson(
        response,
        200,
        await sandboxPayload({ type: "agent_archive", agentId, payload }),
      );
      return true;
    }
  }
  return false;
}
