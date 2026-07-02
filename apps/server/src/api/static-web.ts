import { createReadStream, type Stats } from "node:fs";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

type StaticWebLogger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

type NextHandler = (request: IncomingMessage, response: ServerResponse) => void;
type StaticWebHandler = (request: IncomingMessage, response: ServerResponse, next: NextHandler) => void;

const API_PATH_PREFIXES = ["/v1/"];
const API_PATHS = new Set(["/health"]);
const ONE_YEAR_SECONDS = 31536000;

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function shouldPassToApi(request: IncomingMessage, pathname: string): boolean {
  if (API_PATHS.has(pathname)) return true;
  if (API_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return request.method !== "GET" && request.method !== "HEAD";
}

function contentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function safeResolve(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "") || "index.html";
  const resolved = path.resolve(root, relative);
  const relativeToRoot = path.relative(root, resolved);
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) {
    return resolved;
  }
  return null;
}

async function fileStat(filePath: string): Promise<Stats | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function cacheControl(filePath: string): string {
  const normalized = filePath.split(path.sep).join("/");
  return normalized.includes("/assets/")
    ? `public, max-age=${ONE_YEAR_SECONDS}, immutable`
    : "no-cache";
}

function sendFile(request: IncomingMessage, response: ServerResponse, filePath: string, stat: Stats): void {
  response.writeHead(200, {
    "Content-Length": stat.size,
    "Content-Type": contentType(filePath),
    "Cache-Control": cacheControl(filePath),
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function escapeScriptJson(json: string): string {
  return json.replace(/</g, "\\u003c");
}

async function sendIndex({
  request,
  requestUrl,
  response,
  indexPath,
  token,
}: {
  request: IncomingMessage;
  requestUrl: URL;
  response: ServerResponse;
  indexPath: string;
  token: string;
}): Promise<void> {
  let html = await fs.readFile(indexPath, "utf8");
  if (isLoopbackHost(requestUrl.hostname)) {
    const connectionScript = `<script>window.__OPENPOND_WEB_CONNECTION__=${escapeScriptJson(
      JSON.stringify({
        serverUrl: requestUrl.origin,
        token,
      })
    )};</script>`;
    html = html.includes("</head>")
      ? html.replace("</head>", `    ${connectionScript}\n  </head>`)
      : `${connectionScript}\n${html}`;
  }
  const body = Buffer.from(html, "utf8");
  response.writeHead(200, {
    "Content-Length": body.byteLength,
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(body);
}

function sendNotFound(response: ServerResponse): void {
  response.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  response.end("Not found");
}

export function createStaticWebHandler({
  logger,
  token,
  webRoot,
}: {
  logger: StaticWebLogger;
  token: string;
  webRoot: string;
}): StaticWebHandler {
  const root = path.resolve(webRoot);
  const indexPath = path.join(root, "index.html");

  return (request, response, next) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (shouldPassToApi(request, requestUrl.pathname)) {
        next(request, response);
        return;
      }

      const resolved = safeResolve(root, requestUrl.pathname);
      if (!resolved) {
        sendNotFound(response);
        return;
      }

      const directStat = await fileStat(resolved);
      if (directStat) {
        if (resolved === indexPath) {
          await sendIndex({ request, requestUrl, response, indexPath, token });
          return;
        }
        sendFile(request, response, resolved, directStat);
        return;
      }

      if (path.extname(requestUrl.pathname)) {
        sendNotFound(response);
        return;
      }

      const indexStat = await fileStat(indexPath);
      if (indexStat) {
        await sendIndex({ request, requestUrl, response, indexPath, token });
        return;
      }

      logger.warn("web index not found", { webRoot: root, indexPath });
      sendNotFound(response);
    })().catch((error) => {
        logger.warn("web asset request failed", { webRoot: root, url: request.url, error });
        if (!response.headersSent) sendNotFound(response);
        else response.destroy(error instanceof Error ? error : undefined);
      });
  };
}
