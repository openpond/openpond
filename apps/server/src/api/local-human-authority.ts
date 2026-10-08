import type { IncomingMessage } from "node:http";

/** A local human control must originate at this process, never a forwarded route. */
export function isDesktopLocalRequest(request: IncomingMessage) {
  const address = request.socket.remoteAddress;
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const origin = request.headers.origin;
  let localOrigin = !origin || origin === "null";
  if (typeof origin === "string" && origin !== "null") {
    try { localOrigin = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname); }
    catch { localOrigin = false; }
  }
  return loopback && localOrigin && !request.headers.forwarded && !request.headers["x-forwarded-for"];
}
