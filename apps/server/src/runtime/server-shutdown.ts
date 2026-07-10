import type { Server } from "node:http";
import { ServerLifecycleRegistry } from "./server-lifecycle-registry.js";

type ShutdownLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  flush(): Promise<void>;
};

export function createServerShutdown(input: {
  serverId: string;
  logger: ShutdownLogger;
  markClosing(): void;
  backgroundLoops: ReadonlyArray<{ stop(): void }>;
  browserControlQueue: { close(): void };
  closeEventSubscribers(): Promise<void>;
  terminalWebSockets: { close(): void };
  runtimeClosers: ReadonlyArray<() => unknown | Promise<unknown>>;
  codexSessions: Iterable<{ client: { stop(): Promise<void> } }>;
  workQueues: { drain(): Promise<void> };
  httpServer: Server;
  store: { close(): Promise<void> };
}) {
  const lifecycle = new ServerLifecycleRegistry();
  lifecycle.register({
    id: "admission-and-background-loops",
    phase: 0,
    close: () => {
      input.markClosing();
      for (const loop of input.backgroundLoops) loop.stop();
    },
  });
  lifecycle.register({
    id: "transports",
    phase: 1,
    close: async () => {
      input.browserControlQueue.close();
      await input.closeEventSubscribers();
      input.terminalWebSockets.close();
    },
  });
  lifecycle.register({
    id: "runtime-services",
    phase: 2,
    close: () => Promise.all(input.runtimeClosers.map((close) => close())).then(() => undefined),
  });
  lifecycle.register({
    id: "provider-runtimes",
    phase: 3,
    close: () => Promise.all([...input.codexSessions].map((runtime) => runtime.client.stop())).then(() => undefined),
  });
  lifecycle.register({ id: "work-queues", phase: 4, close: () => input.workQueues.drain() });
  lifecycle.register({ id: "http-server", phase: 5, close: () => closeHttpServer(input.httpServer) });
  lifecycle.register({ id: "store", phase: 6, close: () => input.store.close() });
  lifecycle.register({
    id: "logger",
    phase: 7,
    close: () => {
      input.logger.info("server closed", { serverId: input.serverId });
      return input.logger.flush();
    },
  });

  return function closeServer(): Promise<void> {
    input.logger.info("server closing", { serverId: input.serverId });
    return lifecycle.close();
  };
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    });
  });
}
