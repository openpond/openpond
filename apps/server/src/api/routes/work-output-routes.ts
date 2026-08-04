import { sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleWorkOutputRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/work/outputs") {
    sendJson(response, 200, await deps.listWorkOutputsPayload());
    return true;
  }
  return false;
}
