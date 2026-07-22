import { readJson, sendBinary, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleWorkspaceRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const {
    workspaceLspSettingsStatusPayload,
    workspaceLspRuntimeStatusPayload,
    restartWorkspaceLspPayload,
    reorderSidebarApps,
    patchSidebarAppPreference,
    listSidebarFileBookmarksPayload,
    patchSidebarFileBookmarkPayload,
    workspaceStatePayload,
    createWorkspaceBranchPayload,
    checkoutWorkspaceBranchPayload,
    workspaceDiffPayload,
    workspaceFilePayload,
    saveWorkspaceFilePayload,
    workspaceImagePayload,
    workspaceLspTouchPayload,
    workspaceLspActionPayload,
  } = deps;
  if (request.method === "GET" && requestUrl.pathname === "/v1/lsp/settings-status") {
    sendJson(response, 200, await workspaceLspSettingsStatusPayload());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/lsp/status") {
    sendJson(response, 200, await workspaceLspRuntimeStatusPayload());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/lsp/restart") {
    sendJson(response, 200, await restartWorkspaceLspPayload());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/sidebar/apps/reorder") {
    sendJson(response, 200, await reorderSidebarApps(await readJson(request)));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/sidebar/files") {
    sendJson(response, 200, await listSidebarFileBookmarksPayload());
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/sidebar/files") {
    sendJson(response, 200, await patchSidebarFileBookmarkPayload(await readJson(request)));
    return true;
  }
  const sidebarAppPatchMatch = /^\/v1\/sidebar\/apps\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "PATCH" && sidebarAppPatchMatch) {
    sendJson(
      response,
      200,
      await patchSidebarAppPreference(
        decodeURIComponent(sidebarAppPatchMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const workspaceMatch = /^\/v1\/workspaces\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "GET" && workspaceMatch) {
    sendJson(
      response,
      200,
      await workspaceStatePayload(
        decodeURIComponent(workspaceMatch[1]!),
        requestUrl.searchParams.get("ensure") === "1",
      ),
    );
    return true;
  }
  const workspaceBranchesMatch = /^\/v1\/workspaces\/([^/]+)\/branches$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && workspaceBranchesMatch) {
    sendJson(
      response,
      201,
      await createWorkspaceBranchPayload(
        decodeURIComponent(workspaceBranchesMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const workspaceBranchMatch = /^\/v1\/workspaces\/([^/]+)\/branch$/.exec(requestUrl.pathname);
  if (request.method === "PATCH" && workspaceBranchMatch) {
    sendJson(
      response,
      200,
      await checkoutWorkspaceBranchPayload(
        decodeURIComponent(workspaceBranchMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const workspaceDiffMatch = /^\/v1\/workspaces\/([^/]+)\/diff$/.exec(requestUrl.pathname);
  if (request.method === "GET" && workspaceDiffMatch) {
    sendJson(
      response,
      200,
      await workspaceDiffPayload(decodeURIComponent(workspaceDiffMatch[1]!)),
    );
    return true;
  }
  const workspaceFileMatch = /^\/v1\/workspaces\/([^/]+)\/file$/.exec(requestUrl.pathname);
  if (request.method === "GET" && workspaceFileMatch) {
    sendJson(
      response,
      200,
      await workspaceFilePayload(
        decodeURIComponent(workspaceFileMatch[1]!),
        requestUrl.searchParams.get("path"),
      ),
    );
    return true;
  }
  if (request.method === "PATCH" && workspaceFileMatch) {
    sendJson(
      response,
      200,
      await saveWorkspaceFilePayload(
        decodeURIComponent(workspaceFileMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const workspaceImageMatch = /^\/v1\/workspaces\/([^/]+)\/file-image$/.exec(requestUrl.pathname);
  if (request.method === "GET" && workspaceImageMatch) {
    const image = await workspaceImagePayload(
      decodeURIComponent(workspaceImageMatch[1]!),
      requestUrl.searchParams.get("path"),
    );
    sendBinary(response, 200, image.bytes, image.contentType);
    return true;
  }
  const workspaceLspTouchMatch = /^\/v1\/workspaces\/([^/]+)\/lsp\/touch$/.exec(requestUrl.pathname);
  if (request.method === "POST" && workspaceLspTouchMatch) {
    sendJson(
      response,
      200,
      await workspaceLspTouchPayload(
        decodeURIComponent(workspaceLspTouchMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const workspaceLspActionMatch = /^\/v1\/workspaces\/([^/]+)\/lsp\/action$/.exec(requestUrl.pathname);
  if (request.method === "POST" && workspaceLspActionMatch) {
    sendJson(
      response,
      200,
      await workspaceLspActionPayload(
        decodeURIComponent(workspaceLspActionMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  return false;
}
