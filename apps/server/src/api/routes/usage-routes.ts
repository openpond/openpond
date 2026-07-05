import { sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleUsageRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/usage") {
    sendJson(response, 200, await deps.usageSummaryPayload(requestUrl));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/usage/records") {
    sendJson(response, 200, await deps.usageRecordsPayload(requestUrl));
    return true;
  }
  return false;
}
