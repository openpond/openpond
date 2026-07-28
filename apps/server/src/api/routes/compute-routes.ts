import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleComputeRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/v1/compute")) return false;
  if (request.method === "GET" && requestUrl.pathname === "/v1/compute") {
    sendJson(response, 200, await deps.computePayload("state", {}));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/compute/scan") {
    sendJson(response, 200, await deps.computePayload("scan", {}));
    return true;
  }
  if (request.method === "PATCH" && requestUrl.pathname === "/v1/compute/settings") {
    sendJson(response, 200, await deps.computePayload("update_settings", await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/compute/models/smollm2/download") {
    sendJson(response, 202, await deps.computePayload("download_smollm2", {}));
    return true;
  }
  const cancelMatch = /^\/v1\/compute\/downloads\/([^/]+)\/cancel$/.exec(requestUrl.pathname);
  if (request.method === "POST" && cancelMatch) {
    sendJson(response, 200, await deps.computePayload("cancel_download", { jobId: decodeURIComponent(cancelMatch[1]!) }));
    return true;
  }
  return false;
}
