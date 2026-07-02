import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import { now } from "../../utils.js";
import {
  signedChatAttachmentImageUrlPayload,
  signedLocalImageUrlPayload,
  signedWorkspaceImageUrlPayload,
} from "../signed-workspace-image.js";
export async function handleEventRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const {
    eventPagePayload,
    subscribers,
    token,
  } = deps;
  if (request.method === "GET" && requestUrl.pathname === "/v1/events/page") {
    sendJson(response, 200, await eventPagePayload(requestUrl));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write("retry: 1500\n");
    response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const heartbeat = setInterval(() => {
      if (response.destroyed) return;
      response.write(`: heartbeat ${now()}\n\n`);
    }, 25000);
    subscribers.add(response);
    request.on("close", () => {
      clearInterval(heartbeat);
      subscribers.delete(response);
    });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/local-image") {
    sendJson(response, 410, { error: "Local image route disabled. Use signed workspace image URLs." });
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/assets/workspace-image-url") {
    sendJson(response, 200, signedWorkspaceImageUrlPayload(await readJson(request), requestUrl, token));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/assets/chat-attachment-image-url") {
    sendJson(response, 200, signedChatAttachmentImageUrlPayload(await readJson(request), requestUrl, token));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/assets/local-image-url") {
    sendJson(response, 200, signedLocalImageUrlPayload(await readJson(request), requestUrl, token));
    return true;
  }
  return false;
}
