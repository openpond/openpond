import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export type TaskCoordinationBridge = {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  execute(name: string, args: Record<string, unknown>, callId: string, signal: AbortSignal): Promise<string>;
};

/** Session-bound MCP transport also works when Codex resumes an existing native thread. */
export async function createTaskCoordinationMcp(bridge: TaskCoordinationBridge) {
  const token = randomBytes(32).toString("base64url");
  const identity = randomUUID();
  const pending = new Map<string, AbortController>();
  const authorized = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (request.headers.origin || supplied.length !== authorized.length || !timingSafeEqual(supplied, authorized)) {
      response.writeHead(403).end(); return;
    }
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
    let id: string | number | null = null;
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 128_000) { response.writeHead(413).end(); return; }
      }
      const message = JSON.parse(body) as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new Error("Invalid JSON-RPC request.");
      id = message.id ?? null;
      const params = message.params ?? {};
      if (id === null) {
        if (message.method === "notifications/cancelled") pending.get(String(params.requestId))?.abort();
        response.writeHead(202).end(); return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "openpond-task-coordination", version: "1" } };
      } else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: bridge.tools };
      else if (message.method === "tools/call") {
        const name = String(params.name ?? "");
        if (!bridge.tools.some((tool) => tool.name === name)) throw new Error("Unknown coordination tool.");
        const args = params.arguments ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
        if (pending.has(String(id))) throw new Error("This request is already running.");
        const controller = new AbortController();
        pending.set(String(id), controller);
        try {
          const text = await bridge.execute(name, args as Record<string, unknown>, `mcp:${identity}:${id}`, controller.signal);
          result = { content: [{ type: "text", text }] };
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
        } finally { pending.delete(String(id)); }
      } else {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id,
        error: { code: -32600, message: error instanceof Error ? error.message : "Invalid request." } }));
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Coordination endpoint did not start.");
  return {
    config: { url: `http://127.0.0.1:${address.port}/mcp`, http_headers: { Authorization: `Bearer ${token}` }, tool_timeout_sec: 3605 },
    close: async () => {
      for (const controller of pending.values()) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
