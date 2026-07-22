import { GithubExtensionError } from "@openpond/cloud";

import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

const EXTENSION_PATH = /^\/v1\/extensions\/github\/([^/]+)\/([^/]+)$/;
const EXTENSION_UPDATE_PATH = /^\/v1\/extensions\/github\/([^/]+)\/([^/]+)\/update$/;

export async function handleExtensionRoutes(context: HttpRouteContext): Promise<boolean> {
  if (!context.requestUrl.pathname.startsWith("/v1/extensions")) return false;
  try {
    return await handleExtensionRoute(context);
  } catch (error) {
    if (error instanceof GithubExtensionError) {
      sendJson(context.response, error.status, { error: error.message, code: error.code });
      return true;
    }
    throw error;
  }
}

async function handleExtensionRoute({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/extensions") {
    sendJson(response, 200, await deps.extensionCatalogPayload());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/extensions/preview") {
    sendJson(response, 200, await deps.extensionPreviewPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/extensions") {
    sendJson(response, 201, await deps.extensionAddPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/extensions/update-all") {
    sendJson(response, 200, await deps.extensionUpdateAllPayload());
    return true;
  }
  const updateMatch = EXTENSION_UPDATE_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && updateMatch) {
    const source = decodedSource(updateMatch[1], updateMatch[2]);
    const body = await readJson(request);
    const record = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    sendJson(response, 200, await deps.extensionUpdatePayload({
      source,
      ...(typeof record.ref === "string" ? { ref: record.ref } : {}),
    }));
    return true;
  }
  const extensionMatch = EXTENSION_PATH.exec(requestUrl.pathname);
  if (request.method === "DELETE" && extensionMatch) {
    sendJson(
      response,
      200,
      await deps.extensionRemovePayload(decodedSource(extensionMatch[1], extensionMatch[2])),
    );
    return true;
  }
  return false;
}

function decodedSource(owner: string | undefined, repo: string | undefined): string {
  return `${decodeURIComponent(owner ?? "")}/${decodeURIComponent(repo ?? "")}`;
}
