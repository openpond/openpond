import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createOpenPondServer } from "../apps/server/src/index";
import type { ProviderDiagnosticsSnapshot } from "../apps/server/src/openpond/provider-diagnostics";

async function api<T>(
  serverUrl: string,
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${serverUrl}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

describe("provider diagnostics", () => {
  test(
    "tracks provider payload size, model cache size, error counts, discovery timing, and validation timing",
    async () => {
      const storeDir = await mkdtemp(join(tmpdir(), "openpond-provider-diagnostics-"));
      const server = await createOpenPondServer({
        port: 0,
        storeDir,
        silent: true,
        version: "provider-diagnostics-test",
      });

      try {
        const initial = await api<ProviderDiagnosticsSnapshot>(
          server.url,
          server.token,
          "/v1/diagnostics/providers",
        );
        expect(initial.providerPayloadBytes).toBeGreaterThan(0);
        expect(initial.modelCacheBytes).toBeGreaterThan(0);
        expect(initial.modelCacheModelCount).toBeGreaterThan(0);

        await api(server.url, server.token, "/v1/providers/codex/models", {
          method: "POST",
          body: JSON.stringify({ force: true }),
        });
        await api(server.url, server.token, "/v1/providers/codex/validate", {
          method: "POST",
          body: JSON.stringify({}),
        });

        const after = await api<ProviderDiagnosticsSnapshot>(
          server.url,
          server.token,
          "/v1/diagnostics/providers",
        );
        const discovery = after.recentOperations.find(
          (operation) => operation.kind === "model_discovery" && operation.providerId === "codex",
        );
        const validation = after.recentOperations.find(
          (operation) => operation.kind === "provider_validation" && operation.providerId === "codex",
        );

        expect(after.providerPayloadBytes).toBeGreaterThan(0);
        expect(after.modelCacheBytes).toBeGreaterThan(0);
        expect(after.modelCacheModelCount).toBeGreaterThan(0);
        expect(after.providerErrorCount).toBeGreaterThanOrEqual(0);
        expect(after.modelCacheErrorCount).toBeGreaterThanOrEqual(0);
        expect(after.credentialErrorCount).toBeGreaterThanOrEqual(0);
        expect(discovery).toMatchObject({
          kind: "model_discovery",
          providerId: "codex",
          status: "ok",
        });
        expect(discovery!.durationMs).toBeGreaterThanOrEqual(0);
        expect(discovery!.payloadBytes).toBeGreaterThan(0);
        expect(validation).toMatchObject({
          kind: "provider_validation",
          providerId: "codex",
          status: "ok",
        });
        expect(validation!.durationMs).toBeGreaterThanOrEqual(0);
        expect(validation!.payloadBytes).toBeGreaterThan(0);
        expect(JSON.stringify(after)).not.toContain(server.token);
      } finally {
        await server.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
