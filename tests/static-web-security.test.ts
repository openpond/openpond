import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createStaticWebHandler } from "../apps/server/src/api/static-web";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("static web security", () => {
  test("serves the loopback bootstrap with a CSP nonce and hardened headers", async () => {
    const webRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-static-web-"));
    cleanupPaths.push(webRoot);
    await writeFile(
      path.join(webRoot, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="/assets/index.js"></script></body></html>',
    );
    const handler = createStaticWebHandler({
      logger: { warn: () => undefined },
      token: "test-token",
      webRoot,
    });
    const server = createServer((request, response) =>
      handler(request, response, (_nextRequest, nextResponse) => {
        nextResponse.writeHead(404).end();
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Static test server did not bind.");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await response.text();
      const nonce = /<script nonce="([^"]+)">window\.__OPENPOND_WEB_CONNECTION__/.exec(html)?.[1];
      const policy = response.headers.get("content-security-policy") ?? "";

      expect(response.status).toBe(200);
      expect(nonce).toBeTruthy();
      expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`);
      expect(policy).not.toContain("'unsafe-eval'");
      expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(html).toContain('"token":"test-token"');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
