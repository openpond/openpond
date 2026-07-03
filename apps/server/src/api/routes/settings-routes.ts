import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleSettingsRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const {
    gitAvailabilityPayload,
    startGitInstallPayload,
    refreshOpenPondPayload,
    switchOpenPondPayload,
    saveOpenPondAccountPayload,
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
    validateProviderCredentialPayload,
    providerDiagnosticsPayload,
    updatePersonalizationPayload,
  } = deps;
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
  if (request.method === "POST" && requestUrl.pathname === "/v1/openpond/apps/refresh") {
    sendJson(response, 200, await refreshOpenPondPayload());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/openpond/accounts/switch") {
    sendJson(response, 200, await switchOpenPondPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/openpond/accounts/login") {
    sendJson(response, 200, await saveOpenPondAccountPayload(await readJson(request)));
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/openpond/accounts/config") {
    sendJson(response, 200, await updateOpenPondAccountConfigPayload(await readJson(request)));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/audio/transcriptions/status") {
    sendJson(response, 200, await voiceTranscriptionStatusPayload());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/audio/transcriptions") {
    sendJson(response, 200, await transcribeVoicePayload(await readJson(request)));
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/preferences") {
    sendJson(response, 200, await updateAppPreferencesPayload(await readJson(request)));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/providers") {
    sendJson(response, 200, await providerSettingsPayload());
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/providers") {
    sendJson(response, 200, await updateProviderSettingsPayload(await readJson(request)));
    return true;
  }
  const providerModelsMatch = /^\/v1\/providers\/([^/]+)\/models$/.exec(requestUrl.pathname);
  if (request.method === "GET" && providerModelsMatch) {
    sendJson(
      response,
      200,
      await listProviderModelsPayload(decodeURIComponent(providerModelsMatch[1]!), {
        query: requestUrl.searchParams.get("query") ?? undefined,
        refresh: requestUrl.searchParams.get("refresh") === "1",
        limit: requestUrl.searchParams.has("limit")
          ? Number(requestUrl.searchParams.get("limit"))
          : undefined,
      }),
    );
    return true;
  }
  if (request.method === "POST" && providerModelsMatch) {
    sendJson(
      response,
      200,
      await refreshProviderModelsPayload(
        decodeURIComponent(providerModelsMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const providerCredentialMatch = /^\/v1\/providers\/([^/]+)\/credential$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "PUT" && providerCredentialMatch) {
    sendJson(
      response,
      200,
      await writeProviderCredentialPayload(
        decodeURIComponent(providerCredentialMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  if (request.method === "DELETE" && providerCredentialMatch) {
    sendJson(
      response,
      200,
      await deleteProviderCredentialPayload(
        decodeURIComponent(providerCredentialMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const providerValidationMatch = /^\/v1\/providers\/([^/]+)\/validate$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && providerValidationMatch) {
    sendJson(
      response,
      200,
      await validateProviderCredentialPayload(
        decodeURIComponent(providerValidationMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/diagnostics/providers") {
    sendJson(response, 200, await providerDiagnosticsPayload());
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/personalization") {
    sendJson(response, 200, await updatePersonalizationPayload(await readJson(request)));
    return true;
  }
  return false;
}
