import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ProviderSettingsSchema, type ProviderSettings } from "@openpond/contracts";

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

function expectProviderSettings(value: unknown): ProviderSettings {
  const parsed = ProviderSettingsSchema.parse(value);
  expect(Object.keys(parsed.providers)).toContain("openrouter");
  expect(Object.keys(parsed.statuses)).toContain("openrouter");
  return parsed;
}

function expectNoBootstrapShape(value: {
  preferences?: unknown;
  profile?: unknown;
  apps?: unknown;
  sessions?: unknown;
}) {
  expect(value.preferences).toBeUndefined();
  expect(value.profile).toBeUndefined();
  expect(value.apps).toBeUndefined();
  expect(value.sessions).toBeUndefined();
}

describe("provider scoped API payloads", () => {
  test(
    "returns provider settings from provider mutations, refresh, and validation without full bootstrap",
    async () => {
      const storeDir = await mkdtemp(join(tmpdir(), "openpond-provider-scoped-payloads-"));
      const server = await createOpenPondServer({
        port: 0,
        storeDir,
        silent: true,
        version: "provider-scoped-payloads-test",
      });
      const secretValue = "sk-provider-scoped-test";

      try {
        const patched = await api<Record<string, unknown>>(server.url, server.token, "/v1/providers", {
          method: "PATCH",
          body: JSON.stringify({
            providers: {
              openrouter: {
                enabled: true,
                defaultModel: "openrouter/test-model",
                modelOverrides: ["openrouter/test-model"],
              },
            },
          }),
        });
        const patchedSettings = expectProviderSettings(patched);
        expectNoBootstrapShape(patched);
        expect(patchedSettings.providers.openrouter?.enabled).toBe(true);
        expect(patchedSettings.providers.openrouter?.defaultModel).toBe("openrouter/test-model");

        const savedCredential = await api<Record<string, unknown>>(
          server.url,
          server.token,
          "/v1/providers/openrouter/credential",
          {
            method: "PUT",
            body: JSON.stringify({ source: "local_secret", value: secretValue }),
          },
        );
        const savedCredentialSettings = expectProviderSettings(savedCredential);
        expectNoBootstrapShape(savedCredential);
        expect(savedCredentialSettings.statuses.openrouter?.credential.connected).toBe(true);
        expect(JSON.stringify(savedCredential)).not.toContain(secretValue);

        const refreshed = await api<{
          providerId: string;
          models: unknown[];
          cache: unknown;
          query: string | null;
          providers: unknown;
          profile?: unknown;
          preferences?: unknown;
          apps?: unknown;
        }>(server.url, server.token, "/v1/providers/openrouter/models", {
          method: "POST",
          body: JSON.stringify({ force: true, query: "test" }),
        });
        const refreshedSettings = expectProviderSettings(refreshed.providers);
        expectNoBootstrapShape(refreshed);
        expect(refreshed.providerId).toBe("openrouter");
        expect(refreshed.query).toBe("test");
        expect(refreshed.models.map((model) => (model as { id?: string }).id)).toContain(
          "openrouter/test-model",
        );
        expect(refreshedSettings.modelCaches.openrouter?.models.length).toBeGreaterThan(0);

        const validation = await api<{
          providerId: string;
          ok: boolean;
          live: boolean;
          errors: string[];
          providers: unknown;
          profile?: unknown;
          preferences?: unknown;
          apps?: unknown;
        }>(server.url, server.token, "/v1/providers/codex/validate", {
          method: "POST",
          body: JSON.stringify({}),
        });
        const validationSettings = expectProviderSettings(validation.providers);
        expectNoBootstrapShape(validation);
        expect(validation.providerId).toBe("codex");
        expect(validation.live).toBe(false);
        expect(Array.isArray(validation.errors)).toBe(true);
        expect(validationSettings.statuses.codex).toBeDefined();

        const deletedCredential = await api<Record<string, unknown>>(
          server.url,
          server.token,
          "/v1/providers/openrouter/credential",
          {
            method: "DELETE",
            body: JSON.stringify({}),
          },
        );
        const deletedCredentialSettings = expectProviderSettings(deletedCredential);
        expectNoBootstrapShape(deletedCredential);
        expect(deletedCredentialSettings.statuses.openrouter?.credential.connected).toBe(false);
      } finally {
        await server.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
