import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ProviderSettingsSchema, ProviderModelCacheSchema, ProviderConfigSchema, type ProviderSettings, type BootstrapPayload } from "@openpond/contracts";

import { createOpenPondServer } from "../apps/server/src/index";
import { providersConfigPath } from "../apps/server/src/paths";
import { writeProvidersFile, readProvidersFile } from "../apps/server/src/openpond/provider-settings";

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
  // Failure story: a new composer loses saved native model choices until a
  // potentially slow probe completes, although their exact IDs are already cached.
  test.skipIf(process.platform === "win32")("includes saved native catalogs in bootstrap and preserves newly discovered IDs without changing defaults", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-bootstrap-native-models-"));
    const binaryPath = join(storeDir, "fixture-agent");
    await writeFile(binaryPath, `#!${process.execPath}\n` + String.raw`
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 let result;
 if(request.method==='initialize') result={protocolVersion:1,agentCapabilities:{},authMethods:[]};
 else if(request.method==='session/new') result={sessionId:'fixture-catalog',models:{currentModelId:'openai/exact-native-model',availableModels:[{modelId:'openai/exact-native-model',name:'Fixture model'}]}};
 else process.exit(9);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});`, { mode: 0o700 });
    const ids = ["claude-code", "grok-build", "opencode", "openrouter"];
    await writeProvidersFile(providersConfigPath(storeDir), {
      version: 1, providers: { opencode: ProviderConfigSchema.parse({ enabled: true, binaryPath, sourceHome: storeDir, defaultModel: "explicit-default" }) }, catalogCache: null,
      modelCaches: Object.fromEntries(ids.map((providerId) => [providerId, ProviderModelCacheSchema.parse({
        providerId, source: "provider", models: [{ providerId, id: `${providerId}/exact-model`, displayName: "Fixture model", source: "provider" }],
      })])),
    });
    const server = await createOpenPondServer({ port: 0, storeDir, silent: true, version: "bootstrap-native-models-test" });
    try {
      const bootstrap = await api<BootstrapPayload>(server.url, server.token, "/v1/bootstrap?ensureProfile=0");
      for (const providerId of ids.slice(0, 2)) {
        expect(bootstrap.providers.modelCaches[providerId]?.models.map((model) => model.id)).toContain(`${providerId}/exact-model`);
      }
      expect(bootstrap.providers.modelCaches.opencode?.models.map((model) => model.id)).toEqual(["openai/exact-native-model"]);
      expect(bootstrap.providers.providers.opencode?.defaultModel).toBe("explicit-default");
      expect(bootstrap.providers.modelCaches.openrouter?.models).toEqual([]);
      await api(server.url, server.token, "/v1/providers/opencode/native-setup", { method: "POST", body: JSON.stringify({ action: "capabilities" }) });
      const saved = await readProvidersFile(providersConfigPath(storeDir));
      expect(saved.modelCaches.opencode?.models.map((model) => model.id)).toEqual(["openai/exact-native-model"]);
      expect(saved.providers.opencode?.defaultModel).toBe("explicit-default");
    } finally {
      await server.close(); await rm(storeDir, { recursive: true, force: true });
    }
  }, 15_000);

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
