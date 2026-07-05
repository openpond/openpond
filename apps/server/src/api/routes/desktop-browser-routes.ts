import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleDesktopBrowserRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "POST" && requestUrl.pathname === "/v1/desktop/browser-control/register") {
    sendJson(response, 200, await deps.browserControlRegister(await readJson(request)));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/desktop/browser-control/next") {
    sendJson(response, 200, await deps.browserControlNext(request));
    return true;
  }
  const resultMatch = /^\/v1\/desktop\/browser-control\/requests\/([^/]+)\/result$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && resultMatch) {
    sendJson(
      response,
      200,
      await deps.browserControlComplete(
        request,
        decodeURIComponent(resultMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/desktop/browser-control/status") {
    sendJson(response, 200, deps.browserControlStatus());
    return true;
  }
  return false;
}
