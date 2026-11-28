import { LocalAdapterPublicationRequestSchema, LocalAdapterPublicationScheduleSchema } from "@openpond/contracts/resource-setup";
import { OpenPondModelProjectApiError } from "openpond-sdk/model-projects";
import { LocalAdapterPublicationError } from "../../training/local-adapter-publication.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import { isDesktopLocalRequest } from "../local-human-authority.js";

export async function handleLocalAdapterPublicationRoutes({ deps, request, requestUrl, response }: HttpRouteContext) {
  const operation = /^\/v1\/training\/local-adapter-publication\/(preview|upload)$/.exec(requestUrl.pathname)?.[1];
  if (!operation || request.method !== "POST") return false;
  response.setHeader("Cache-Control", "no-store");
  if (!isDesktopLocalRequest(request)) {
    sendJson(response, 403, { code: "local_adapter_requires_desktop", error: "Open the local Desktop to upload a saved adapter." });
    return true;
  }
  const schema = operation === "preview" ? LocalAdapterPublicationRequestSchema : LocalAdapterPublicationScheduleSchema;
  const input = schema.safeParse(await readJson(request, { maxBytes: 8_192 }));
  if (!input.success) {
    sendJson(response, 400, { code: "local_adapter_request_invalid", error: "Choose the exact saved Model version and workspace." });
    return true;
  }
  const abort = new AbortController(), cancel = () => abort.abort();
  response.once("close", cancel);
  try {
    const result = await deps.trainingPayload(operation === "preview" ? "preview_local_adapter_publication" : "publish_local_adapter", input.data, requestUrl, abort.signal);
    if (!abort.signal.aborted) sendJson(response, 200, result);
  } catch (error) {
    if (abort.signal.aborted) return true;
    const status = error instanceof LocalAdapterPublicationError || error instanceof OpenPondModelProjectApiError ? error.status : 409;
    sendJson(response, status, { code: "local_adapter_publication_failed",
      error: error instanceof Error ? error.message.slice(0, 512) : "The saved adapter could not be uploaded." });
  } finally { response.off("close", cancel); }
  return true;
}
