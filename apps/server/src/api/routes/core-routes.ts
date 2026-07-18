import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleCoreRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  const {
    refreshCodexStatus,
    bootstrapPayload,
    profileCurrentPayload,
    profileCatalogPayload,
    profileInitPayload,
    profileLoadPayload,
    profileCheckPayload,
    profileRenameAgentPayload,
    profileCommitPayload,
    profilePushPayload,
    profileRunPayload,
    remoteAccessPayload,
    enableRemoteAccessPayload,
    disableRemoteAccessPayload,
    loadMoreOpenPondAppsPayload,
    codexHistoryThreadPayload,
    sendCodexHistoryTurnPayload,
    interruptCodexHistoryTurnPayload,
    workspaceTemplateConfigPayload,
  } = deps;
  if (request.method === "GET" && requestUrl.pathname === "/v1/bootstrap") {
    if (requestUrl.searchParams.get("refreshCodex") === "1")
      await refreshCodexStatus(true);
    sendJson(
      response,
      200,
      await bootstrapPayload({
        forceOpenPond: requestUrl.searchParams.get("refreshOpenPond") === "1",
        ensureProfile: requestUrl.searchParams.get("ensureProfile") !== "0",
      })
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/status") {
    await refreshCodexStatus(true);
    const payload = await bootstrapPayload();
    sendJson(response, 200, {
      server: payload.server,
      codex: payload.codex,
      account: payload.account,
    });
    return true;
  }
  if (requestUrl.pathname === "/v1/profile") {
    if (request.method === "GET") {
      sendJson(response, 200, await profileCurrentPayload());
      return true;
    }
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/v1/profile/catalog"
  ) {
    sendJson(response, 200, await profileCatalogPayload());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/profile/init") {
    sendJson(response, 200, await profileInitPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/profile/load") {
    sendJson(response, 200, await profileLoadPayload(await readJson(request)));
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/profile/check"
  ) {
    sendJson(response, 200, await profileCheckPayload(await readJson(request)));
    return true;
  }
  const profileAgentNameMatch = /^\/v1\/profile\/agents\/([^/]+)\/name$/.exec(
    requestUrl.pathname
  );
  if (request.method === "PATCH" && profileAgentNameMatch) {
    sendJson(
      response,
      200,
      await profileRenameAgentPayload(
        decodeURIComponent(profileAgentNameMatch[1]!),
        await readJson(request)
      )
    );
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/profile/commit"
  ) {
    sendJson(
      response,
      200,
      await profileCommitPayload(await readJson(request))
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/profile/push") {
    sendJson(response, 200, await profilePushPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/profile/run") {
    sendJson(response, 200, await profileRunPayload(await readJson(request)));
    return true;
  }
  if (requestUrl.pathname === "/v1/remote-access") {
    if (request.method === "GET") {
      sendJson(response, 200, await remoteAccessPayload());
      return true;
    }
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/remote-access/enable"
  ) {
    sendJson(response, 200, await enableRemoteAccessPayload());
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/remote-access/disable"
  ) {
    sendJson(response, 200, await disableRemoteAccessPayload());
    return true;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/v1/openpond/account"
  ) {
    const payload = await bootstrapPayload({
      forceOpenPond: requestUrl.searchParams.get("refresh") === "1",
    });
    sendJson(response, 200, {
      account: payload.account,
      accountMeta: payload.accountMeta,
      apps: payload.apps,
      appsError: payload.appsError,
      appsMeta: payload.appsMeta,
    });
    return true;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/v1/openpond/apps/more"
  ) {
    sendJson(response, 200, await loadMoreOpenPondAppsPayload(requestUrl));
    return true;
  }
  const codexHistoryThreadMatch = /^\/v1\/codex-history\/([^/]+)$/.exec(
    requestUrl.pathname
  );
  if (request.method === "GET" && codexHistoryThreadMatch) {
    sendJson(
      response,
      200,
      await codexHistoryThreadPayload(
        decodeURIComponent(codexHistoryThreadMatch[1]!),
        requestUrl
      )
    );
    return true;
  }
  const codexHistoryTurnMatch = /^\/v1\/codex-history\/([^/]+)\/turns$/.exec(
    requestUrl.pathname
  );
  if (request.method === "POST" && codexHistoryTurnMatch) {
    sendJson(
      response,
      202,
      await sendCodexHistoryTurnPayload(
        decodeURIComponent(codexHistoryTurnMatch[1]!),
        await readJson(request)
      )
    );
    return true;
  }
  const codexHistoryTurnInterruptMatch =
    /^\/v1\/codex-history\/([^/]+)\/turns\/interrupt$/.exec(
      requestUrl.pathname
    );
  if (request.method === "POST" && codexHistoryTurnInterruptMatch) {
    sendJson(
      response,
      202,
      await interruptCodexHistoryTurnPayload(
        decodeURIComponent(codexHistoryTurnInterruptMatch[1]!)
      )
    );
    return true;
  }
  const appTemplateConfigMatch =
    /^\/v1\/openpond\/apps\/([^/]+)\/template-config$/.exec(
      requestUrl.pathname
    );
  if (request.method === "GET" && appTemplateConfigMatch) {
    sendJson(
      response,
      200,
      await workspaceTemplateConfigPayload(
        decodeURIComponent(appTemplateConfigMatch[1]!)
      )
    );
    return true;
  }
  return false;
}
