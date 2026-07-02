import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleInsightsRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/insights") {
    sendJson(response, 200, await deps.listInsightsPayload(requestUrl));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/insights/scan") {
    sendJson(response, 202, await deps.runInsightsScanPayload(requestUrl));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/insights/question") {
    sendJson(response, 202, await deps.askInsightsPayload(await readJson(request)));
    return true;
  }
  const insightMatch = /^\/v1\/insights\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "PATCH" && insightMatch) {
    sendJson(
      response,
      200,
      await deps.patchInsightPayload(decodeURIComponent(insightMatch[1]!), await readJson(request)),
    );
    return true;
  }
  return false;
}
