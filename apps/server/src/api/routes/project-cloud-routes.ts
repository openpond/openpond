import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleProjectCloudRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const {
    createLocalProjectPayload,
    listCloudWorkItemsPayload,
    createCloudWorkItemPayload,
    sendCloudWorkItemMessagePayload,
    handleCloudWorkItemBackgroundPayload,
    cancelCloudWorkItemTaskPayload,
    openCloudWorkItemPayload,
    getCloudWorkItemPayload,
    uploadLocalProjectCloudSourcePayload,
    updateLocalProjectAgentSetupPayload,
    deleteLocalProjectPayload,
  } = deps;
  if (request.method === "POST" && requestUrl.pathname === "/v1/projects") {
    sendJson(response, 201, await createLocalProjectPayload(await readJson(request)));
    return true;
  }
  if (requestUrl.pathname === "/v1/cloud/work-items") {
    if (request.method === "GET") {
      const projectIds = requestUrl.searchParams
        .getAll("projectId")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
      sendJson(
        response,
        200,
        await listCloudWorkItemsPayload({
          teamId: requestUrl.searchParams.get("teamId") ?? undefined,
          projectIds,
          includeArchived: requestUrl.searchParams.get("includeArchived") === "true",
          limit: Number.parseInt(requestUrl.searchParams.get("limit") ?? "", 10) || undefined,
        }),
      );
      return true;
    }
    if (request.method === "POST") {
      sendJson(response, 201, await createCloudWorkItemPayload(await readJson(request)));
      return true;
    }
  }
  const cloudWorkItemMessageMatch = /^\/v1\/cloud\/work-items\/([^/]+)\/messages$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && cloudWorkItemMessageMatch) {
    sendJson(
      response,
      201,
      await sendCloudWorkItemMessagePayload(
        decodeURIComponent(cloudWorkItemMessageMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const cloudWorkItemBackgroundMatch = /^\/v1\/cloud\/work-items\/([^/]+)\/handle-background$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && cloudWorkItemBackgroundMatch) {
    sendJson(
      response,
      202,
      await handleCloudWorkItemBackgroundPayload(
        decodeURIComponent(cloudWorkItemBackgroundMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const cloudWorkItemCancelTaskMatch = /^\/v1\/cloud\/work-items\/([^/]+)\/cancel-task$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && cloudWorkItemCancelTaskMatch) {
    sendJson(
      response,
      202,
      await cancelCloudWorkItemTaskPayload(
        decodeURIComponent(cloudWorkItemCancelTaskMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const cloudWorkItemOpenCloudMatch = /^\/v1\/cloud\/work-items\/([^/]+)\/open-cloud$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && cloudWorkItemOpenCloudMatch) {
    sendJson(
      response,
      200,
      await openCloudWorkItemPayload(
        decodeURIComponent(cloudWorkItemOpenCloudMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const cloudWorkItemMatch = /^\/v1\/cloud\/work-items\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "GET" && cloudWorkItemMatch) {
    sendJson(
      response,
      200,
      await getCloudWorkItemPayload(
        decodeURIComponent(cloudWorkItemMatch[1]!),
        { teamId: requestUrl.searchParams.get("teamId") ?? undefined },
      ),
    );
    return true;
  }
  const localProjectCloudSourceMatch = /^\/v1\/projects\/([^/]+)\/cloud-source$/.exec(
    requestUrl.pathname,
  );
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
