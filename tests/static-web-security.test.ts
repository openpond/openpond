import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createStaticWebHandler } from "../apps/server/src/api/static-web";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("static web security", () => {
  // A root-only shell test misses broken assets after reloading a nested
  // Console resource or an archived Project route over HTTP.
  test("loads build assets from nested browser routes without changing stored bytes", async () => {
    const webRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-static-route-"));
    cleanupPaths.push(webRoot);
    await mkdir(path.join(webRoot, "assets"));
    const original = '<html><head><link rel="stylesheet" href="./assets/app.css"><link rel="modulepreload" href=\'./assets/chunk.js\'></head><body><script type="module" src = "./assets/app.js"></script></body></html>';
    await Promise.all([
      writeFile(path.join(webRoot, "index.html"), original),
      writeFile(path.join(webRoot, "assets", "app.js"), "window.appLoaded = true;"),
      writeFile(path.join(webRoot, "assets", "chunk.js"), "export const loaded = true;"),
      writeFile(path.join(webRoot, "assets", "app.css"), "body { display: block; }"),
    ]);
    const handler = createStaticWebHandler({ logger: { warn: () => undefined }, webRoot });
    const server = createServer((request, response) => handler(request, response, (_request, next) => next.writeHead(404).end()));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Static test server did not bind.");
      for (const route of ["/", "/models/model-a/tasks", "/models/model-a/tasks/drafts/draft-a", "/console/datasets?project=archived-project", "/console/experiments/retained-run/cases"]) {
        const url = `http://127.0.0.1:${address.port}${route}`;
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toContain("base-uri 'none'");
        const html = await response.text();
        const assets = [...html.matchAll(/\b(?:src|href)\s*=\s*(["'])([^"']+)\1/g)].map(match => new URL(match[2]!, url));
        expect(assets.map(asset => asset.pathname)).toEqual(["/assets/app.css", "/assets/chunk.js", "/assets/app.js"]);
        for (const asset of assets) {
          const resource = await fetch(asset);
          expect(resource.status).toBe(200);
          expect(resource.headers.get("content-type")).toContain(asset.pathname.endsWith(".css") ? "text/css" : "javascript");
          expect(resource.headers.get("cache-control")).toContain("immutable");
        }
      }
      expect(await readFile(path.join(webRoot, "index.html"), "utf8")).toBe(original);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  test("serves credential-free HTML despite forged loopback and proxy headers", async () => {
    const webRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-static-web-"));
    cleanupPaths.push(webRoot);
    await writeFile(
      path.join(webRoot, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="/assets/index.js"></script></body></html>',
    );
    const handler = createStaticWebHandler({
      logger: { warn: () => undefined },
      webRoot,
    });
    const server = createServer((request, response) =>
      handler(request, response, (_nextRequest, nextResponse) => {
        nextResponse.writeHead(404).end();
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Static test server did not bind.");
      // A network listener/proxy must never mint an owner credential from Host.
      // Exercise both the actual index and SPA fallback over real HTTP.
      for (const route of ["/", "/index.html", "/console/models"]) {
        for (const host of ["localhost", "127.0.0.1", "[::1]", "public.example.test"]) {
          const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
            headers: { host, forwarded: "for=127.0.0.1;host=localhost", "x-forwarded-host": "localhost" },
          });
          const html = await response.text();
          const policy = response.headers.get("content-security-policy") ?? "";
          expect(response.status).toBe(200);
          expect(policy).toContain("script-src 'self'");
          expect(policy).not.toContain("'unsafe-eval'");
          expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
          expect(response.headers.get("x-frame-options")).toBe("DENY");
          expect(response.headers.get("referrer-policy")).toBe("no-referrer");
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(html).not.toContain("__OPENPOND_WEB_CONNECTION__");
          expect(html).not.toContain('"token":');
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
