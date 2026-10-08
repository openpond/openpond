import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chatSchema, embeddedChatSchema, type Config, ExampleError } from "./config.js";
import { runChat } from "./runtime.js";
import type { EmbeddedModel } from "./local-model/runtime.js";

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readChat(request: IncomingMessage, config: Config) {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
    throw new ExampleError("json_required", 415);
  const maxBytes = 64 * 1024;
  if (Number(request.headers["content-length"] ?? 0) > maxBytes) throw new ExampleError("request_too_large", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new ExampleError("request_too_large", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return (config.mode === "embedded" ? embeddedChatSchema : chatSchema).parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new ExampleError("invalid_request", 400); }
}

/** No request logging: prompts, credentials and upstream errors are never printed. */
export function createExampleServer(config: Config, model?: EmbeddedModel) {
  const expectedHash = Buffer.from(config.authTokenSha256, "hex");
  const active = new Set<AbortController>();
  let closing = false;
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => send(response, 500, { error: "internal_error" }));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "GET" && request.url === "/health") {
      const ready = !closing && (config.mode !== "embedded" || model?.ready());
      send(response, ready ? 200 : 503, { status: ready ? "healthy" : "unavailable", runtime: "openpond-app-server",
        ...(config.mode === "embedded" ? { inference: "embedded", model: config.model, contextTokens: config.contextTokens, persistentHistory: false } : {}) });
      return;
    }
    if (request.method !== "POST" || request.url !== "/chat") { send(response, 404, { error: "not_found" }); return; }
    const authorization = request.headers.authorization ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!supplied || !timingSafeEqual(createHash("sha256").update(supplied).digest(), expectedHash)) {
      response.setHeader("connection", "close");
      send(response, 401, { error: "unauthorized" });
      return;
    }
    if (closing || (config.mode === "embedded" && !model?.ready()) || active.size >= config.maxConcurrentRequests) {
      response.setHeader("connection", "close");
      send(response, 503, { error: "busy", retryable: false });
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      controller.abort(new Error("Request deadline exceeded"));
      send(response, 504, { requestId, error: "request_timeout", retryable: false });
    }, config.requestTimeoutMs);
    const disconnect = () => { if (!response.writableFinished) controller.abort(new Error("Client disconnected")); };
    response.once("close", disconnect);
    request.once("aborted", disconnect);
    try {
      const input = await readChat(request, config);
      controller.signal.throwIfAborted();
      const result = await runChat(config, input, controller.signal, model);
      send(response, 200, { requestId, ...result });
    } catch (error) {
      const known = error instanceof ExampleError;
      send(response, controller.signal.aborted ? 504 : known ? error.status : 502, {
        requestId, error: controller.signal.aborted ? "request_cancelled" : known ? error.code : "agent_request_failed", retryable: false,
      });
    } finally {
      clearTimeout(timeout);
      response.off("close", disconnect);
      request.off("aborted", disconnect);
      active.delete(controller);
    }
  }
  return {
    server,
    async close() {
      closing = true;
      for (const controller of active) controller.abort(new Error("Server stopping"));
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
