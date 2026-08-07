import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  AgentJsonRpcDispatcher,
  type AgentRuntimeHost,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./protocol.js";

export async function runAgentJsonlServer(input: {
  host: AgentRuntimeHost;
  readable: Readable;
  writable: Writable;
}): Promise<void> {
  const dispatcher = new AgentJsonRpcDispatcher(input.host);
  let writeChain = Promise.resolve();
  const pendingNotifications: JsonRpcNotification[] = [];
  const write = (message: JsonRpcResponse | JsonRpcNotification) => {
    writeChain = writeChain.then(async () => {
      if (!input.writable.write(`${JSON.stringify(message)}\n`)) await once(input.writable, "drain");
    });
    return writeChain;
  };
  const flushPendingNotifications = () => {
    if (!dispatcher.initialized || pendingNotifications.length === 0) return;
    for (const notification of pendingNotifications.splice(0)) void write(notification);
  };
  const unsubscribe = input.host.subscribe?.((notification) => {
    if (!dispatcher.initialized) {
      pendingNotifications.push(notification);
      return;
    }
    void write(notification);
  });
  const inFlight = new Set<Promise<void>>();
  const lines = createInterface({ input: input.readable, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        await write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        continue;
      }
      const operation = (async () => {
        const response = await dispatcher.handle(parsed);
        if (response) await write(response);
        flushPendingNotifications();
      })();
      const method = parsed && typeof parsed === "object" && "method" in parsed
        ? (parsed as { method?: unknown }).method
        : null;
      if (method === "initialize" || method === "initialized") {
        await operation;
        continue;
      }
      inFlight.add(operation);
      void operation.finally(() => inFlight.delete(operation));
    }
    await Promise.all(inFlight);
    await writeChain;
  } finally {
    unsubscribe?.();
  }
}
