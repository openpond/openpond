import { EnclaveError, type EnclaveAction } from "../../enclave/connection.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleEnclaveRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/v1/url-models/")) return false;
  const key = `${request.method} ${requestUrl.pathname}`;
  const action = ({ "GET /v1/url-models/list": "list", "POST /v1/url-models/save": "save",
    "POST /v1/url-models/remove": "remove", "POST /v1/url-models/inspect": "inspect" } as Record<string, EnclaveAction>)[key];
  response.setHeader("Cache-Control", "no-store");
  if (!action || !deps.enclavePayload) { sendJson(response, 404, { error: "Not found" }); return true; }
  const controller = new AbortController();
  const cancel = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", cancel);
  try {
    const payload = action !== "list" ? await readJson(request, { maxBytes: 8192 }) : undefined;
    const result = await deps.enclavePayload(action, payload, controller.signal);
    if (!controller.signal.aborted) sendJson(response, 200, result);
  } catch (error) {
    if (!controller.signal.aborted) {
      if (error instanceof EnclaveError) sendJson(response, error.status, { error: error.message });
      else throw error;
    }
  } finally { response.off("close", cancel); }
  return true;
}
