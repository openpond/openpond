import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpBodyError, applyCorsHeaders, hasAuth, sendBinary, sendJson, sendText } from "./http.js";
import type { HttpRouteDeps } from "./http-route-types.js";
import { AUTHENTICATED_ROUTE_TABLE } from "./routes/index.js";
import {
  verifySignedChatAttachmentImageRequest,
  verifySignedLocalImageRequest,
  verifySignedWorkspaceImageRequest,
} from "./signed-workspace-image.js";

export type { HttpRouteDeps } from "./http-route-types.js";
export {
  signedChatAttachmentImageUrlPayload,
  signedLocalImageUrlPayload,
  signedWorkspaceImageUrlPayload,
  verifySignedChatAttachmentImageRequest,
  verifySignedLocalImageRequest,
  verifySignedWorkspaceImageRequest,
} from "./signed-workspace-image.js";

const DEFAULT_SLOW_ROUTE_THRESHOLD_MS = 750;

export function createHttpRequestHandler(
  deps: HttpRouteDeps,
): (request: IncomingMessage, response: ServerResponse) => void {
  const {
    host,
    getActualPort,
    token,
    version,
    runtimeVersion,
    logger,
    slowRouteThresholdMs,
    chatAttachmentImagePayload,
    localImagePayload,
    workspaceImagePayload,
  } = deps;

  return (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    let requestPath = request.url ?? "/";
    let routeId = routeIdFor(request.method ?? "GET", requestPath);
    const requestBytes = requestContentLength(request);
    const responseBytes = trackResponseBytes(response);
    const slowThresholdMs = normalizedSlowRouteThresholdMs(slowRouteThresholdMs);
    response.setHeader("X-Request-Id", requestId);
    response.on("finish", () => {
      const durationMs = Date.now() - started;
      const metadata = {
        requestId,
        routeId,
        method: request.method,
        path: requestPath,
        status: response.statusCode,
        durationMs,
        requestBytes,
        responseBytes: responseBytes(),
      };
      const level =
        response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info";
      logger[level]("http request", metadata);
      if (durationMs >= slowThresholdMs) logger.warn("http slow request", metadata);
    });
    void (async () => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? `${host}:${getActualPort()}`}`,
      );
      requestPath = requestUrl.pathname;
      routeId = routeIdFor(request.method ?? "GET", requestUrl.pathname);
      const cors = applyCorsHeaders(request, response, {
        allowedOrigins: [
          requestUrl.origin,
          process.env.OPENPOND_WEB_URL,
          process.env.OPENPOND_REMOTE_ACCESS_TARGET,
        ],
      });
      if (request.method === "OPTIONS") {
        sendText(response, cors.allowed ? 204 : 403, "");
        return;
      }
      if (!cors.allowed) {
        sendJson(response, 403, { error: "CORS origin not allowed" });
        return;
      }
      if (requestUrl.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          server: "openpond-app-server",
          version,
          runtimeVersion,
        });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/v1/assets/workspace-image") {
        const signedImage = verifySignedWorkspaceImageRequest(requestUrl, token);
        if (!signedImage.ok) {
          sendJson(response, signedImage.status, { error: signedImage.error });
          return;
        }
        try {
          const image = await workspaceImagePayload(signedImage.claims.appId, signedImage.claims.path);
          sendBinary(response, 200, image.bytes, image.contentType);
        } catch {
          sendJson(response, 404, { error: "Image not found" });
        }
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/v1/assets/chat-attachment-image") {
        const signedImage = verifySignedChatAttachmentImageRequest(requestUrl, token);
        if (!signedImage.ok) {
          sendJson(response, signedImage.status, { error: signedImage.error });
          return;
        }
        try {
          const image = await chatAttachmentImagePayload(signedImage.claims);
          sendBinary(response, 200, image.bytes, image.contentType);
        } catch {
          sendJson(response, 404, { error: "Image not found" });
        }
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/v1/assets/local-image") {
        const signedImage = verifySignedLocalImageRequest(requestUrl, token);
        if (!signedImage.ok) {
          sendJson(response, signedImage.status, { error: signedImage.error });
          return;
        }
        try {
          const image = await localImagePayload(signedImage.claims.path);
          sendBinary(response, 200, image.bytes, image.contentType);
        } catch {
          sendJson(response, 404, { error: "Image not found" });
        }
        return;
      }
      if (!hasAuth(request, requestUrl, token)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      for (const route of AUTHENTICATED_ROUTE_TABLE) {
        if (await route.handle({ deps, request, requestUrl, response })) return;
      }
      sendJson(response, 404, { error: "Not found" });
    })().catch((error) => {
      if (error instanceof HttpBodyError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
        return;
      }
      logger.error("http request failed", {
        requestId,
        method: request.method,
        path: requestPath,
        durationMs: Date.now() - started,
        error,
      });
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  };
}

function trackResponseBytes(response: ServerResponse): () => number {
  let bytes = 0;
  const originalWrite = response.write.bind(response) as (...args: unknown[]) => boolean;
  const originalEnd = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
  response.write = ((chunk: unknown, ...args: unknown[]) => {
    bytes += byteLength(chunk);
    return originalWrite(chunk, ...args);
  }) as typeof response.write;
  response.end = ((chunk?: unknown, ...args: unknown[]) => {
    bytes += byteLength(chunk);
    return originalEnd(chunk, ...args);
  }) as typeof response.end;
  return () => bytes;
}

function byteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value instanceof Uint8Array) return value.byteLength;
  return 0;
}

function requestContentLength(request: IncomingMessage): number {
  const raw = Array.isArray(request.headers["content-length"])
    ? request.headers["content-length"][0]
    : request.headers["content-length"];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizedSlowRouteThresholdMs(value: number | undefined): number {
  if (value !== undefined && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  const envValue = Number(process.env.OPENPOND_SLOW_ROUTE_MS);
  if (Number.isFinite(envValue)) return Math.max(0, Math.trunc(envValue));
  return DEFAULT_SLOW_ROUTE_THRESHOLD_MS;
}

function routeIdFor(method: string, pathValue: string): string {
  const pathOnly = pathValue.split("?")[0] || "/";
  const normalized = normalizeRoutePath(pathOnly);
  return `${method.toUpperCase()} ${normalized}`;
}

function normalizeRoutePath(pathValue: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/^\/v1\/openpond\/apps\/[^/]+\/template-config$/, "/v1/openpond/apps/:appId/template-config"],
    [/^\/v1\/codex-history\/[^/]+$/, "/v1/codex-history/:sessionId"],
    [/^\/v1\/codex-history\/[^/]+\/turns$/, "/v1/codex-history/:sessionId/turns"],
    [/^\/v1\/codex-history\/[^/]+\/turns\/interrupt$/, "/v1/codex-history/:sessionId/turns/interrupt"],
    [/^\/v1\/organizations\/[^/]+$/, "/v1/organizations/:slug"],
    [/^\/v1\/organizations\/[^/]+\/mcp-server$/, "/v1/organizations/:slug/mcp-server"],
    [/^\/v1\/organizations\/[^/]+\/members$/, "/v1/organizations/:slug/members"],
    [/^\/v1\/organizations\/[^/]+\/mcp-server\/rotate$/, "/v1/organizations/:slug/mcp-server/rotate"],
    [/^\/v1\/organizations\/[^/]+\/mcp-server\/disable$/, "/v1/organizations/:slug/mcp-server/disable"],
    [/^\/v1\/organizations\/[^/]+\/mcp-server\/enable$/, "/v1/organizations/:slug/mcp-server/enable"],
    [/^\/v1\/runtimes\/[^/]+\/sandbox$/, "/v1/runtimes/:runtimeId/sandbox"],
    [/^\/v1\/sandboxes\/volumes\/[^/]+$/, "/v1/sandboxes/volumes/:volumeId"],
    [/^\/v1\/sandbox-secrets\/[^/]+$/, "/v1/sandbox-secrets/:secretId"],
    [/^\/v1\/sandbox-secrets\/[^/]+\/rotate$/, "/v1/sandbox-secrets/:secretId/rotate"],
    [/^\/v1\/sandbox-secrets\/[^/]+\/attach$/, "/v1/sandbox-secrets/:secretId/attach"],
    [/^\/v1\/sandbox-secrets\/[^/]+\/revoke$/, "/v1/sandbox-secrets/:secretId/revoke"],
    [/^\/v1\/sandbox-secrets\/[^/]+\/delete$/, "/v1/sandbox-secrets/:secretId/delete"],
    [/^\/v1\/sandbox-projects\/[^/]+$/, "/v1/sandbox-projects/:projectId"],
    [/^\/v1\/sandbox-projects\/[^/]+\/sync$/, "/v1/sandbox-projects/:projectId/sync"],
    [/^\/v1\/sandbox-projects\/[^/]+\/source$/, "/v1/sandbox-projects/:projectId/source"],
    [/^\/v1\/cloud\/work-items\/[^/]+$/, "/v1/cloud/work-items/:workItemId"],
    [/^\/v1\/cloud\/work-items\/[^/]+\/messages$/, "/v1/cloud/work-items/:workItemId/messages"],
    [/^\/v1\/cloud\/work-items\/[^/]+\/handle-background$/, "/v1/cloud/work-items/:workItemId/handle-background"],
    [/^\/v1\/cloud\/work-items\/[^/]+\/cancel-task$/, "/v1/cloud/work-items/:workItemId/cancel-task"],
    [/^\/v1\/cloud\/work-items\/[^/]+\/open-cloud$/, "/v1/cloud/work-items/:workItemId/open-cloud"],
    [/^\/v1\/projects\/[^/]+$/, "/v1/projects/:projectId"],
    [/^\/v1\/projects\/[^/]+\/cloud-source$/, "/v1/projects/:projectId/cloud-source"],
    [/^\/v1\/sidebar\/apps\/[^/]+$/, "/v1/sidebar/apps/:appId"],
    [/^\/v1\/workspaces\/[^/]+$/, "/v1/workspaces/:workspaceId"],
    [/^\/v1\/workspaces\/[^/]+\/branches$/, "/v1/workspaces/:workspaceId/branches"],
    [/^\/v1\/workspaces\/[^/]+\/branch$/, "/v1/workspaces/:workspaceId/branch"],
    [/^\/v1\/workspaces\/[^/]+\/diff$/, "/v1/workspaces/:workspaceId/diff"],
    [/^\/v1\/workspaces\/[^/]+\/file$/, "/v1/workspaces/:workspaceId/file"],
    [/^\/v1\/workspaces\/[^/]+\/file-image$/, "/v1/workspaces/:workspaceId/file-image"],
    [/^\/v1\/workspaces\/[^/]+\/lsp\/touch$/, "/v1/workspaces/:workspaceId/lsp/touch"],
    [/^\/v1\/workspaces\/[^/]+\/lsp\/action$/, "/v1/workspaces/:workspaceId/lsp/action"],
    [/^\/v1\/sessions\/[^/]+$/, "/v1/sessions/:sessionId"],
    [/^\/v1\/sessions\/[^/]+\/turns$/, "/v1/sessions/:sessionId/turns"],
    [/^\/v1\/sessions\/[^/]+\/turns\/[^/]+\/create-pipeline$/, "/v1/sessions/:sessionId/turns/:turnId/create-pipeline"],
    [/^\/v1\/sessions\/[^/]+\/turns\/interrupt$/, "/v1/sessions/:sessionId/turns/interrupt"],
    [/^\/v1\/sessions\/[^/]+\/compact$/, "/v1/sessions/:sessionId/compact"],
    [/^\/v1\/sessions\/[^/]+\/workspace-tools$/, "/v1/sessions/:sessionId/workspace-tools"],
    [/^\/v1\/approvals\/[^/]+$/, "/v1/approvals/:approvalId"],
  ];
  return patterns.find(([pattern]) => pattern.test(pathValue))?.[1] ?? pathValue;
}
