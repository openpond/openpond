import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  apiFetch,
  ApiResponseTooLargeError,
  ApiTimeoutError,
  readApiJson,
} from "../packages/cloud/src/api/core";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      }, 150);
      return;
    }
    if (request.url === "/declared-large") {
      const body = JSON.stringify({ value: "x".repeat(128) });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.url === "/chunked-large") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"value":"');
      response.write("x".repeat(128));
      response.end('"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("cloud API request budgets", () => {
  test("applies a default-compatible deadline and decodes bounded JSON", async () => {
    const response = await apiFetch(baseUrl, null, "/ok", { timeoutMs: 1_000, maxResponseBytes: 1_024 });
    expect(await readApiJson<{ ok: boolean }>(response, "test")).toEqual({ ok: true });
  });

  test("raises a typed timeout error", async () => {
    expect(apiFetch(baseUrl, null, "/slow", { timeoutMs: 20 })).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  test("rejects an oversized declared response before returning it", async () => {
    expect(apiFetch(baseUrl, null, "/declared-large", { maxResponseBytes: 32 })).rejects.toBeInstanceOf(
      ApiResponseTooLargeError,
    );
  });

  test("caps chunked bodies while they stream", async () => {
    const response = await apiFetch(baseUrl, null, "/chunked-large", { maxResponseBytes: 32 });
    expect(readApiJson(response, "chunked test")).rejects.toBeInstanceOf(ApiResponseTooLargeError);
  });
});
