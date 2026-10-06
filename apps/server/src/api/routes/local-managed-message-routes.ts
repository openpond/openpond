import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import { ZodError } from "zod";
import { LocalManagedMessageError } from "../../runtime/task-inbox/local-managed-message-error.js";

/** Authenticated local renderer actions; never mounted as model tools or hosted APIs. */
export async function handleLocalManagedMessageRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const match = /^\/v1\/sessions\/([^/]+)\/(local-message-target|local-messages)$/.exec(requestUrl.pathname);
  if (!match) return false;
  const address = request.socket.remoteAddress;
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const origin = request.headers.origin;
  let localOrigin = !origin || origin === "null";
  if (typeof origin === "string" && origin !== "null") {
    try { localOrigin = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname); }
    catch { localOrigin = false; }
  }
  if (!loopback || !localOrigin || request.headers.forwarded || request.headers["x-forwarded-for"] || !deps.localManagedMessaging) {
    sendJson(response, 403, { error: "Managed local messaging is available only in the desktop app on this device." });
    return true;
  }
  response.setHeader("Cache-Control", "no-store");
  const sessionId = decodeURIComponent(match[1]!);
  if (request.method === "GET" && match[2] === "local-message-target") {
    try {
      sendJson(response, 200, await deps.localManagedMessaging.inspect(sessionId));
    } catch (error) {
      if (error instanceof LocalManagedMessageError) sendJson(response, error.status, { error: error.message });
      else throw error;
    }
    return true;
  }
  if (request.method === "POST" && match[2] === "local-messages") {
    try {
      sendJson(response, 202, await deps.localManagedMessaging.send(sessionId, await readJson(request, { maxBytes: 128 * 1024 })));
    } catch (error) {
      if (error instanceof LocalManagedMessageError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof ZodError) sendJson(response, 422, { error: "Review the message and its exact target before sending." });
      else throw error;
    }
    return true;
  }
  sendJson(response, 405, { error: "Method not allowed." });
  return true;
}
