import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handlePonderRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const path = requestUrl.pathname;
  if (path === "/v1/ponder" && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: "/ponder", method: "POST" }));
    return true;
  }
  if (path === "/v1/ponder/work" && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: "/ponder/work" }));
    return true;
  }
  if (path === "/v1/ponder/introduction/seen" && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: "/ponder/introduction/seen", method: "POST", body: await readJson(request) as Record<string, unknown> }));
    return true;
  }
  if (path === "/v1/ponder/work-inputs" && request.method === "POST") {
    sendJson(response, 201, await deps.ponderRequestPayload({ path: "/work-inputs", method: "POST", body: await readJson(request) as Record<string, unknown> }));
    return true;
  }
  const finalizeInputMatch = /^\/v1\/ponder\/work-inputs\/([a-zA-Z0-9_-]+)\/finalize$/.exec(path);
  if (finalizeInputMatch && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/work-inputs/${encodeURIComponent(finalizeInputMatch[1]!)}/finalize`, method: "POST" }));
    return true;
  }
  const outputMatch = /^\/v1\/ponder\/work-outputs\/([a-zA-Z0-9_-]+)$/.exec(path);
  if (outputMatch && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/work-outputs/${encodeURIComponent(outputMatch[1]!)}` }));
    return true;
  }
  const conversationMatch = /^\/v1\/ponder\/conversations\/([a-zA-Z0-9_-]+)$/.exec(path);
  if (conversationMatch && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/conversations/${encodeURIComponent(conversationMatch[1]!)}` }));
    return true;
  }
  const activityMatch = /^\/v1\/ponder\/conversations\/([a-zA-Z0-9_-]+)\/activity$/.exec(path);
  if (activityMatch && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/conversations/${encodeURIComponent(activityMatch[1]!)}/activity${requestUrl.search}` }));
    return true;
  }
  const turnMatch = /^\/v1\/ponder\/conversations\/([a-zA-Z0-9_-]+)\/turns$/.exec(path);
  if (turnMatch && request.method === "POST") {
    const idempotencyKey = request.headers["idempotency-key"];
    sendJson(response, 201, await deps.ponderRequestPayload({ path: `/conversations/${encodeURIComponent(turnMatch[1]!)}/turns`, method: "POST", body: await readJson(request) as Record<string, unknown>, idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined }));
    return true;
  }
  const eventsMatch = /^\/v1\/ponder\/turns\/([a-zA-Z0-9_-]+)\/events$/.exec(path);
  if (eventsMatch && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/turns/${encodeURIComponent(eventsMatch[1]!)}\/events${requestUrl.search}` }));
    return true;
  }
  const cancelMatch = /^\/v1\/ponder\/turns\/([a-zA-Z0-9_-]+)\/cancel$/.exec(path);
  if (cancelMatch && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/turns/${encodeURIComponent(cancelMatch[1]!)}/cancel`, method: "POST" }));
    return true;
  }
  const waitMatch = /^\/v1\/ponder\/turns\/([a-zA-Z0-9_-]+)\/waits\/([a-zA-Z0-9_-]+)\/resolve$/.exec(path);
  if (waitMatch && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/turns/${encodeURIComponent(waitMatch[1]!)}/waits/${encodeURIComponent(waitMatch[2]!)}/resolve`, method: "POST", body: await readJson(request) as Record<string, unknown> }));
    return true;
  }
  return false;
}
