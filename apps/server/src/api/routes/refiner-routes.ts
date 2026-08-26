import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleRefinerRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/refiner") {
    sendJson(response, 200, await deps.refinerHistoryPayload());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/refiner/update") {
    sendJson(response, 200, await deps.updateRefinerProfilePayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/refiner/activate") {
    sendJson(response, 200, await deps.activateRefinerReleasePayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/refiner/rollback") {
    sendJson(response, 200, await deps.rollbackRefinerReleasePayload(await readJson(request)));
    return true;
  }
  return false;
}
