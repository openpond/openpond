import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleSettingsRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (requestUrl.pathname === "/v1/providers/acp-registry" && deps.acpRegistryPayload) {
    if (request.method === "GET") sendJson(response, 200, await deps.acpRegistryPayload("list", { query: requestUrl.searchParams.get("query") ?? undefined, refresh: requestUrl.searchParams.get("refresh") === "true" }));
    else if (request.method === "POST") sendJson(response, 201, await deps.acpRegistryPayload("register", await readJson(request)));
    else if (request.method === "DELETE") sendJson(response, 200, await deps.acpRegistryPayload("remove", await readJson(request)));
    else sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  const planUsage = /^\/v1\/providers\/(codex|claude-code)\/plan-usage$/.exec(requestUrl.pathname);
  if (planUsage && request.method === "GET" && deps.providerPlanUsagePayload) {
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, await deps.providerPlanUsagePayload(planUsage[1]!));
    return true;
  }
  const nativeHistory = /^\/v1\/native-history\/(list|open|branches|collector)$/.exec(requestUrl.pathname);
  if (nativeHistory && request.method === "POST" && deps.nativeHistoryPayload) {
    sendJson(response, 200, await deps.nativeHistoryPayload(nativeHistory[1]!, await readJson(request)));
    return true;
  }
  const nativeSetup = /^\/v1\/providers\/([^/]+)\/native-setup$/.exec(requestUrl.pathname);
  if (nativeSetup && request.method === "POST" && deps.nativeAgentSetupPayload) {
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", cancel);
    try {
      const result = await deps.nativeAgentSetupPayload(decodeURIComponent(nativeSetup[1]!), await readJson(request), controller.signal);
      if (!controller.signal.aborted) sendJson(response, 200, result);
    } finally { response.off("close", cancel); }
    return true;
  }
  if (requestUrl.pathname === "/v1/configuration" && deps.configuration) {
    if (request.method === "GET") sendJson(response, 200, await deps.configuration.status(requestUrl.searchParams.get("projectRoot") ?? undefined, requestUrl.searchParams.get("accountId") ?? undefined));
    else if (request.method === "POST") sendJson(response, 200, await deps.configuration.mutate(await readJson(request)));
    else sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/configuration/schema" && deps.configuration) {
    sendJson(response, 200, deps.configuration.schema()); return true;
  }
  const {
    gitAvailabilityPayload,
    startGitInstallPayload,
    refreshOpenPondPayload,
    switchOpenPondPayload,
    saveOpenPondAccountPayload,
    removeOpenPondAccountPayload,
    signOutOpenPondAccountPayload,
    updateOpenPondAccountConfigPayload,
    voiceTranscriptionStatusPayload,
    transcribeVoicePayload,
    updateAppPreferencesPayload,
    providerSettingsPayload,
    updateProviderSettingsPayload,
    listProviderModelsPayload,
    refreshProviderModelsPayload,
    writeProviderCredentialPayload,
    deleteProviderCredentialPayload,
    startOpenAiSubscriptionAuthPayload,
    validateProviderCredentialPayload,
    providerDiagnosticsPayload,
    recordClientDiagnosticPayload,
    updatePersonalizationPayload,
    datasetStoragePayload,
  } = deps;
  if (request.method === "GET" && requestUrl.pathname === "/v1/settings/dataset-storage") {
    sendJson(response, 200, await datasetStoragePayload("state"));
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/settings/dataset-storage") {
    sendJson(response, 200, await datasetStoragePayload("update", await readJson(request)));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/system/git") {
    sendJson(response, 200, await gitAvailabilityPayload());
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/system/git/install-command-line-tools"
  ) {
    sendJson(response, 200, await startGitInstallPayload());
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/openpond/accounts/refresh"
  ) {
    sendJson(response, 200, await refreshOpenPondPayload());
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/openpond/accounts/switch"
  ) {
    sendJson(
      response,
      200,
      await switchOpenPondPayload(await readJson(request))
    );
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/openpond/accounts/login"
  ) {
    sendJson(
      response,
      200,
      await saveOpenPondAccountPayload(await readJson(request))
    );
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/openpond/accounts/logout"
  ) {
    sendJson(response, 200, await signOutOpenPondAccountPayload());
    return true;
  }
  if (
    request.method === "DELETE" &&
    requestUrl.pathname === "/v1/openpond/accounts"
  ) {
    sendJson(
      response,
      200,
      await removeOpenPondAccountPayload(await readJson(request))
    );
    return true;
  }
  if (
    request.method === "PATCH" &&
    requestUrl.pathname === "/v1/openpond/accounts/config"
  ) {
    sendJson(
      response,
      200,
      await updateOpenPondAccountConfigPayload(await readJson(request))
    );
    return true;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/v1/audio/transcriptions/status"
  ) {
    sendJson(response, 200, await voiceTranscriptionStatusPayload());
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/audio/transcriptions"
  ) {
    sendJson(
      response,
      200,
      await transcribeVoicePayload(await readJson(request))
    );
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/preferences") {
    sendJson(
      response,
      200,
      await updateAppPreferencesPayload(await readJson(request))
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/providers") {
    sendJson(response, 200, await providerSettingsPayload());
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/providers") {
    sendJson(
      response,
      200,
      await updateProviderSettingsPayload(await readJson(request))
    );
    return true;
  }
  const providerModelsMatch = /^\/v1\/providers\/([^/]+)\/models$/.exec(
    requestUrl.pathname
  );
  if (request.method === "GET" && providerModelsMatch) {
    sendJson(
      response,
      200,
      await listProviderModelsPayload(
        decodeURIComponent(providerModelsMatch[1]!),
        {
          query: requestUrl.searchParams.get("query") ?? undefined,
          refresh: requestUrl.searchParams.get("refresh") === "1",
          limit: requestUrl.searchParams.has("limit")
            ? Number(requestUrl.searchParams.get("limit"))
            : undefined,
        }
      )
    );
    return true;
  }
  if (request.method === "POST" && providerModelsMatch) {
    sendJson(
      response,
      200,
      await refreshProviderModelsPayload(
        decodeURIComponent(providerModelsMatch[1]!),
        await readJson(request)
      )
    );
    return true;
  }
  const providerCredentialMatch = /^\/v1\/providers\/([^/]+)\/credential$/.exec(
    requestUrl.pathname
  );
  if (request.method === "PUT" && providerCredentialMatch) {
    sendJson(
      response,
      200,
      await writeProviderCredentialPayload(
        decodeURIComponent(providerCredentialMatch[1]!),
        await readJson(request)
      )
    );
    return true;
  }
  if (request.method === "DELETE" && providerCredentialMatch) {
    sendJson(
      response,
      200,
      await deleteProviderCredentialPayload(
        decodeURIComponent(providerCredentialMatch[1]!),
        await readJson(request)
      )
    );
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/providers/openai/subscription-auth"
  ) {
    sendJson(
      response,
      200,
      await startOpenAiSubscriptionAuthPayload(await readJson(request))
    );
    return true;
  }
  const providerValidationMatch = /^\/v1\/providers\/([^/]+)\/validate$/.exec(
    requestUrl.pathname
  );
  if (request.method === "POST" && providerValidationMatch) {
    sendJson(
      response,
      200,
      await validateProviderCredentialPayload(
        decodeURIComponent(providerValidationMatch[1]!),
        await readJson(request)
      )
    );
    return true;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/v1/diagnostics/providers"
  ) {
    sendJson(response, 200, await providerDiagnosticsPayload());
    return true;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/diagnostics/client"
  ) {
    sendJson(
      response,
      201,
      await recordClientDiagnosticPayload(await readJson(request))
    );
    return true;
  }
  if (
    request.method === "PATCH" &&
    requestUrl.pathname === "/v1/personalization"
  ) {
    sendJson(
      response,
      200,
      await updatePersonalizationPayload(await readJson(request))
    );
    return true;
  }
  return false;
}
