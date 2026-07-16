import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BootstrapPayload, ProviderSettings } from "@openpond/contracts";

import { createOpenPondServer } from "../apps/server/src/index";

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

describe("provider bootstrap summaries", () => {
  test(
    "omits full model arrays from bootstrap and lazy-loads a provider cache on demand",
    async () => {
      const storeDir = await mkdtemp(join(tmpdir(), "openpond-provider-bootstrap-summary-"));
      const server = await createOpenPondServer({
        port: 0,
        storeDir,
        silent: true,
        version: "provider-bootstrap-summary-test",
      });

      try {
        const bootstrap = await api<BootstrapPayload>(
          server.url,
          server.token,
          "/v1/bootstrap?ensureProfile=0",
        );
        const bootstrapProvider = bootstrap.providers.statuses.openrouter;
        const bootstrapCache = bootstrap.providers.modelCaches.openrouter;

        expect(bootstrapProvider?.modelIds.length).toBeGreaterThan(0);
        expect(bootstrapCache?.source).not.toBe("none");
        expect(bootstrapCache?.models).toHaveLength(0);

        const fullProviderSettings = await api<ProviderSettings>(
          server.url,
          server.token,
          "/v1/providers",
        );
        const fullProvider = fullProviderSettings.statuses.openrouter;
        expect(fullProvider?.modelIds.length).toBeGreaterThan(0);
        expect(fullProviderSettings.modelCaches.openrouter?.models.length).toBe(
          fullProvider?.modelIds.length,
        );
        expect(JSON.stringify(bootstrap.providers).length).toBeLessThan(
          JSON.stringify(fullProviderSettings).length,
        );

        const loadedModels = await api<{
          providerId: string;
          models: unknown[];
          providers: ProviderSettings;
        }>(server.url, server.token, "/v1/providers/openrouter/models?limit=500");
        expect(loadedModels.providerId).toBe("openrouter");
        expect(loadedModels.models.length).toBeGreaterThan(0);
        const loadedProvider = loadedModels.providers.statuses.openrouter;
        expect(loadedModels.providers.modelCaches.openrouter?.models.length).toBe(
          loadedProvider?.modelIds.length,
        );
      } finally {
        await server.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
