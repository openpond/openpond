import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleProjectCloudRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const {
    createLocalProjectPayload,
    previewLocalProjectCloudSourcePayload,
    uploadLocalProjectCloudSourcePayload,
    localProjectActionCatalogPayload,
    updateLocalProjectAgentSetupPayload,
    deleteLocalProjectPayload,
  } = deps;
  const localProjectActionsMatch = /^\/v1\/projects\/([^/]+)\/actions$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "GET" && localProjectActionsMatch) {
    sendJson(
      response,
      200,
      await localProjectActionCatalogPayload(
        decodeURIComponent(localProjectActionsMatch[1]!),
      ),
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/projects") {
    sendJson(response, 201, await createLocalProjectPayload(await readJson(request)));
    return true;
  }
  const localProjectCloudSourceMatch = /^\/v1\/projects\/([^/]+)\/cloud-source$/.exec(
    requestUrl.pathname,
  );
  const localProjectCloudSourcePreviewMatch = /^\/v1\/projects\/([^/]+)\/cloud-source\/preview$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "GET" && localProjectCloudSourcePreviewMatch) {
    sendJson(
      response,
      200,
      await previewLocalProjectCloudSourcePayload(
        decodeURIComponent(localProjectCloudSourcePreviewMatch[1]!),
        {
          branch: requestUrl.searchParams.get("branch") ?? undefined,
        },
      ),
    );
    return true;
  }
  if (request.method === "POST" && localProjectCloudSourceMatch) {
    sendJson(
      response,
      200,
      await uploadLocalProjectCloudSourcePayload(
        decodeURIComponent(localProjectCloudSourceMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const localProjectMatch = /^\/v1\/projects\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "PATCH" && localProjectMatch) {
    sendJson(
      response,
      200,
      await updateLocalProjectAgentSetupPayload(
        decodeURIComponent(localProjectMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  if (request.method === "DELETE" && localProjectMatch) {
    sendJson(
      response,
      200,
      await deleteLocalProjectPayload(decodeURIComponent(localProjectMatch[1]!)),
    );
    return true;
  }
  return false;
}
