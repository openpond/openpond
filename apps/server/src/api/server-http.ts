import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { createHttpRequestHandler } from "./http-routes.js";
import type { createTerminalWebSocketHandler } from "../runtime/terminal-sessions.js";
import { createHttpRequestHandler as createRoutes } from "./http-routes.js";
import { createStaticWebHandler } from "./static-web.js";
import { createTerminalWebSocketHandler as createTerminal } from "../runtime/terminal-sessions.js";

type RouteOptions = Parameters<typeof createHttpRequestHandler>[0];
type TerminalOptions = Parameters<typeof createTerminalWebSocketHandler>[0];
type ServerLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
};

export function createOpenPondHttpSurface({
  routeOptions,
  terminalOptions,
  webRoot,
}: {
  routeOptions: RouteOptions;
  terminalOptions: TerminalOptions;
  webRoot?: string | null;
}) {
  const routeHandler = createRoutes(routeOptions);
  const webHandler = webRoot
    ? createStaticWebHandler({ logger: routeOptions.logger, token: routeOptions.token, webRoot })
    : null;
  const httpServer = createServer((request, response) => {
    if (!webHandler) {
      routeHandler(request, response);
      return;
    }
    webHandler(request, response, routeHandler);
  });
  const terminalWebSockets = createTerminal(terminalOptions);
  httpServer.on("upgrade", (request, socket, head) => {
    if (terminalWebSockets.handleUpgrade(request, socket, head)) return;
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  return { httpServer, terminalWebSockets };
}

export async function listenOpenPondHttpServer({
  host,
  httpServer,
  logger,
  port,
  serverId,
}: {
  host: string;
  httpServer: ReturnType<typeof createServer>;
  logger: ServerLogger;
  port: number;
  serverId: string;
}): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const actualPort = address.port;
  logger.info("server listening", { host, port: actualPort, serverId });
  return actualPort;
}
