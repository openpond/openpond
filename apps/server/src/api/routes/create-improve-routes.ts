import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleCreateImproveRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/create-improve-runs") {
    sendJson(response, 200, await deps.listCreateImproveRunsPayload(requestUrl));
    return true;
  }
  const runMatch = /^\/v1\/create-improve-runs\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "GET" && runMatch) {
    const run = await deps.getCreateImproveRunPayload(decodeURIComponent(runMatch[1]!));
    if (!run) {
      sendJson(response, 404, { error: "Create/Improve run not found" });
      return true;
    }
    sendJson(response, 200, run);
    return true;
  }
  const candidateDiffMatch =
    /^\/v1\/create-improve-runs\/([^/]+)\/candidates\/([^/]+)\/diff$/.exec(
      requestUrl.pathname,
    );
  if (request.method === "GET" && candidateDiffMatch) {
    sendJson(
      response,
      200,
      await deps.getCreateImproveCandidateDiffPayload(
        decodeURIComponent(candidateDiffMatch[1]!),
        decodeURIComponent(candidateDiffMatch[2]!),
      ),
    );
    return true;
  }
  const actionMatch = /^\/v1\/create-improve-runs\/([^/]+)\/actions$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && actionMatch) {
    sendJson(
      response,
      200,
      await deps.applyCreateImproveAction(
        decodeURIComponent(actionMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  return false;
}
