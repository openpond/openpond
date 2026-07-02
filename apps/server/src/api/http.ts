import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

export class HttpBodyError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: "invalid_json" | "request_body_too_large" | "unsupported_media_type",
    message: string,
  ) {
    super(message);
    this.name = "HttpBodyError";
  }
}

export type CorsOptions = {
  allowedOrigins?: Array<string | null | undefined>;
};

export type CorsResult = {
  allowed: boolean;
  origin: string | null;
};

export function applyCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  options: CorsOptions = {},
): CorsResult {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.setHeader(name, value);
  }
  const origin = headerValue(request.headers.origin);
  if (!origin) return { allowed: true, origin: null };

  response.setHeader("Vary", appendVaryOrigin(response.getHeader("Vary")));
  if (!isAllowedCorsOrigin(origin, options)) return { allowed: false, origin };

  response.setHeader("Access-Control-Allow-Origin", origin);
  return { allowed: true, origin };
}

export function isAllowedCorsOrigin(origin: string, options: CorsOptions = {}): boolean {
  if (origin === "null") return true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (isLoopbackOrigin(normalized)) return true;

  const allowedOrigins = new Set(
    (options.allowedOrigins ?? [])
      .map((value) => (value ? normalizeOrigin(value) : null))
      .filter((value): value is string => Boolean(value)),
  );
  return allowedOrigins.has(normalized);
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  });
  response.end(JSON.stringify(payload));
}

export function sendText(response: ServerResponse, status: number, payload: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...CORS_HEADERS,
  });
  response.end(payload);
}

export function sendBinary(response: ServerResponse, status: number, payload: Buffer, contentType: string): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(payload.byteLength),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...CORS_HEADERS,
  });
  response.end(payload);
}

export async function readJson(
  request: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES;
  const contentType = headerValue(request.headers["content-type"]);
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) {
      throw new HttpBodyError(
        413,
        "request_body_too_large",
        `JSON request body exceeds ${maxBytes} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  if (!isJsonContentType(contentType)) {
    throw new HttpBodyError(
      415,
      "unsupported_media_type",
      "JSON request body requires Content-Type: application/json.",
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpBodyError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

export function hasAuth(request: IncomingMessage, _url: URL, token: string): boolean {
  const header = request.headers.authorization;
  const bearer =
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
  return bearer === token;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  const url = new URL(origin);
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
}

function appendVaryOrigin(value: number | string | string[] | undefined): string {
  const existing = Array.isArray(value) ? value.join(", ") : value ? String(value) : "";
  const parts = existing
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === "origin")) parts.push("Origin");
  return parts.join(", ");
}
