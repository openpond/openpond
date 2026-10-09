import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentHostStorageClient } from "./host-storage-client.js";

import {
  AgentJsonRpcDispatcher,
  type AgentRuntimeHost,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcRequest,
} from "./protocol.js";

export async function runAgentJsonlServer(input: {
  host: AgentRuntimeHost | (() => Promise<AgentRuntimeHost>);
  readable: Readable;
  writable: Writable;
  hostStorageClient?: AgentHostStorageClient;
}): Promise<void> {
  let dispatcher: AgentJsonRpcDispatcher | null = null;
  let writeChain = Promise.resolve();
  let transportError: unknown;
  const observeFailure = (error: unknown) => {
    transportError ??= error;
    input.hostStorageClient?.close();
    lines.close();
  };
  const pendingNotifications: JsonRpcNotification[] = [];
  const write = (message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest) => {
    writeChain = writeChain.then(async () => {
      if (!input.writable.write(`${JSON.stringify(message)}\n`)) await once(input.writable, "drain");
    });
    // Notifications have no awaiting caller; retain failure for server shutdown.
    void writeChain.catch(observeFailure);
    return writeChain;
  };
  input.hostStorageClient?.bind((message) => write(message));
  const flushPendingNotifications = () => {
    if (!dispatcher?.initialized || pendingNotifications.length === 0) return;
    for (const notification of pendingNotifications.splice(0)) void write(notification);
  };
  let unsubscribe: (() => void) | undefined;
  const inFlight = new Set<Promise<void>>();
  const lines = createInterface({ input: input.readable, crlfDelay: Infinity });
  const buffered: unknown[] = [];
  let ready = false;
  let startupError: unknown = null;
  const dispatch = async (parsed: unknown): Promise<void> => {
    const activeDispatcher = dispatcher;
    if (!activeDispatcher) throw new Error("Agent runtime dispatcher is unavailable.");
    const operation = (async () => {
      const response = await activeDispatcher.handle(parsed);
      if (response) await write(response);
      flushPendingNotifications();
    })();
    const method = parsed && typeof parsed === "object" && "method" in parsed
      ? (parsed as { method?: unknown }).method
      : null;
    if (method === "initialize" || method === "initialized") {
      await operation;
      return;
    }
    inFlight.add(operation);
    void operation.then(
      () => { inFlight.delete(operation); },
      (error: unknown) => { inFlight.delete(operation); observeFailure(error); },
    );
  };
  const startup = (async () => {
    const host = typeof input.host === "function" ? await input.host() : input.host;
    dispatcher = new AgentJsonRpcDispatcher(host);
    unsubscribe = host.subscribe?.((notification) => {
      if (!dispatcher?.initialized) {
        pendingNotifications.push(notification);
        return;
      }
      void write(notification);
    });
    while (buffered.length > 0) await dispatch(buffered.shift());
    ready = true;
  })().catch((error: unknown) => {
    startupError = error;
    lines.close();
  });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > 1_000_000) {
        await write({ jsonrpc: "2.0", id: null,
          error: { code: -32600, message: "Request exceeds the JSONL size limit" } });
        continue;
      }
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
      if (input.hostStorageClient?.accept(parsed)) continue;
      if (!ready) {
        if (buffered.length >= 64) {
          const id = parsed && typeof parsed === "object" && "id" in parsed
            ? (parsed as { id?: unknown }).id : null;
          if (typeof id === "string" || typeof id === "number") {
            await write({ jsonrpc: "2.0", id,
              error: { code: -32000, message: "Runtime startup request limit exceeded" } });
          }
        } else buffered.push(parsed);
      } else await dispatch(parsed);
    }
    // EOF means no further correlated host responses can arrive.
    input.hostStorageClient?.close();
    await startup;
    if (startupError) throw startupError;
    await Promise.all(inFlight);
    await writeChain;
    if (transportError) throw transportError;
  } finally {
    input.hostStorageClient?.close();
    unsubscribe?.();
  }
}
