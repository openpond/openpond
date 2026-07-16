import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import { HttpBodyError, applyCorsHeaders, isAllowedCorsOrigin, readJson } from "../apps/server/src/api/http";
import { createHttpRequestHandler, type HttpRouteDeps } from "../apps/server/src/api/http-routes";

function requestWithBody(
  body: string,
  headers: IncomingMessage["headers"] = {},
): IncomingMessage {
  const request = Readable.from([body]) as Readable & { headers: IncomingMessage["headers"] };
  request.headers = headers;
  return request as IncomingMessage;
}

function requestWithOrigin(origin?: string): IncomingMessage {
  return { headers: origin ? { origin } : {} } as IncomingMessage;
}

function responseRecorder(): ServerResponse & { headers: Map<string, number | string | string[]> } {
  const headers = new Map<string, number | string | string[]>();
  return {
    headers,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? [...value] : value);
      return this as ServerResponse;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
  } as unknown as ServerResponse & { headers: Map<string, number | string | string[]> };
}

describe("server HTTP JSON body parsing", () => {
  test("parses application/json request bodies", async () => {
    await expect(
      readJson(requestWithBody('{"prompt":"hello"}', { "content-type": "application/json" })),
    ).resolves.toEqual({ prompt: "hello" });
  });

  test("accepts structured JSON content types", async () => {
    await expect(
      readJson(requestWithBody('{"ok":true}', { "content-type": "application/vnd.openpond+json; charset=utf-8" })),
    ).resolves.toEqual({ ok: true });
  });

  test("rejects non-empty JSON bodies without a JSON content type", async () => {
    await expect(
      readJson(requestWithBody('{"prompt":"hello"}', { "content-type": "text/plain" })),
    ).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    });
  });

  test("rejects invalid JSON with a structured 400 error", async () => {
    await expect(
      readJson(requestWithBody("{bad json", { "content-type": "application/json" })),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
    });
  });

  test("rejects oversized request bodies with a structured 413 error", async () => {
    await expect(
      readJson(requestWithBody('{"prompt":"too large"}', { "content-type": "application/json" }), {
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({
      status: 413,
      code: "request_body_too_large",
    });
  });

  test("returns an empty object for empty request bodies", async () => {
    await expect(readJson(requestWithBody(""))).resolves.toEqual({});
  });

  test("uses HttpBodyError instances for body failures", async () => {
    try {
      await readJson(requestWithBody("not-json", { "content-type": "application/json" }));
    } catch (error) {
      expect(error).toBeInstanceOf(HttpBodyError);
      return;
    }
    throw new Error("expected JSON body parsing to fail");
  });
});

describe("server CORS headers", () => {
  test("does not emit wildcard origins for non-browser requests", () => {
    const response = responseRecorder();
    const result = applyCorsHeaders(requestWithOrigin(), response);

    expect(result).toEqual({ allowed: true, origin: null });
    expect(response.headers.get("access-control-allow-origin")).toBeUndefined();
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  });

  test("allows loopback renderer origins", () => {
    expect(isAllowedCorsOrigin("http://127.0.0.1:17876")).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:17876")).toBe(true);
    expect(isAllowedCorsOrigin("http://[::1]:17876")).toBe(true);
  });

  test("allows packaged Electron null origin and explicit same-origin targets", () => {
    const nullOriginResponse = responseRecorder();
    const nullOrigin = applyCorsHeaders(requestWithOrigin("null"), nullOriginResponse);
    expect(nullOrigin.allowed).toBe(true);
    expect(nullOriginResponse.headers.get("access-control-allow-origin")).toBe("null");

    const explicitResponse = responseRecorder();
    const explicit = applyCorsHeaders(requestWithOrigin("https://openpond-dev.example"), explicitResponse, {
      allowedOrigins: ["https://openpond-dev.example/path-does-not-matter"],
    });
    expect(explicit.allowed).toBe(true);
    expect(explicitResponse.headers.get("access-control-allow-origin")).toBe("https://openpond-dev.example");
  });

  test("rejects unknown web origins without access-control-allow-origin", () => {
    const response = responseRecorder();
    const result = applyCorsHeaders(requestWithOrigin("https://evil.example"), response, {
      allowedOrigins: ["https://openpond-dev.example"],
    });

    expect(result).toEqual({ allowed: false, origin: "https://evil.example" });
    expect(response.headers.get("access-control-allow-origin")).toBeUndefined();
    expect(response.headers.get("vary")).toBe("Origin");
  });
});

describe("server HTTP route logging", () => {
  test("logs route id, payload bytes, response bytes, and slow-route metadata", async () => {
    const logs: Array<{ level: string; message: string; metadata?: Record<string, unknown> }> = [];
    const server = createServer(
      createHttpRequestHandler({
        host: "127.0.0.1",
        getActualPort: () => {
          const address = server.address() as AddressInfo | null;
          return address?.port ?? 0;
        },
        token: "route-logging-token",
        version: "route-log-test",
        runtimeVersion: "runtime-test",
        slowRouteThresholdMs: 0,
        logger: {
          info(message, metadata) {
            logs.push({ level: "info", message, metadata });
          },
          warn(message, metadata) {
            logs.push({ level: "warn", message, metadata });
          },
          error(message, metadata) {
            logs.push({ level: "error", message, metadata });
          },
        },
        subscribers: new Set<ServerResponse>(),
      } as unknown as HttpRouteDeps),
    );

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      const text = await response.text();
      expect(response.status).toBe(200);

      const requestLog = logs.find((entry) => entry.message === "http request");
      const slowLog = logs.find((entry) => entry.message === "http slow request");
      expect(requestLog?.metadata).toMatchObject({
        routeId: "GET /health",
        method: "GET",
        path: "/health",
        status: 200,
        requestBytes: 0,
        responseBytes: Buffer.byteLength(text, "utf8"),
      });
      expect(typeof requestLog?.metadata?.durationMs).toBe("number");
      expect(typeof requestLog?.metadata?.requestId).toBe("string");
      expect(slowLog?.level).toBe("warn");
      expect(slowLog?.metadata?.routeId).toBe("GET /health");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
