import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ProviderCatalogSchema,
  ProviderConfigSchema,
} from "../packages/contracts/src/providers";
import {
  buildProviderModelCache,
  buildProviderSettings,
  listProviderModels,
} from "../apps/server/src/openpond/provider-registry";
import {
  providerCatalogContentHash,
  resetProviderCatalogResolverCache,
  resolveProviderCatalog,
} from "../apps/server/src/openpond/provider-catalog";
import {
  normalizeProvidersFile,
  readProvidersFile,
  updateProvidersFile,
} from "../apps/server/src/openpond/provider-settings";
import {
  readProviderSecrets,
  writeProviderChatGptSubscriptionCredential,
  writeProviderCredential,
  type ProviderSecretStorePaths,
} from "../apps/server/src/openpond/provider-secrets";
import type { ProvidersFile } from "../apps/server/src/types";

const tempDirs: string[] = [];

afterEach(async () => {
  resetProviderCatalogResolverCache();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local BYOK provider registry", () => {
  test("builds first-class provider settings from server presets", () => {
    const settings = buildProviderSettings({
      file: emptyProvidersFile(),
      codex: {
        available: true,
        binaryPath: "/usr/local/bin/codex",
        version: "1.0.0",
        authHealth: "signed_in",
        account: {
          type: "chatgpt",
          email: "person@example.com",
          planType: "plus",
          label: "Person",
        },
        appServer: { status: "ready", lastError: null },
      },
    });

    expect(Object.keys(settings.statuses)).toContain("openpond");
    expect(Object.keys(settings.statuses)).toContain("openrouter");
    expect(settings.providers.openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(settings.statuses.openrouter?.available).toBe(false);
    expect(settings.statuses.openrouter?.credential.connected).toBe(false);
    expect(settings.statuses.codex?.credential.source).toBe("codex_login");
    expect(settings.statuses.codex?.available).toBe(true);
    expect(settings.modelCaches.openrouter?.models.map((model) => model.id)).toContain(
      "moonshotai/kimi-k2",
    );
    expect(settings.providers.zai?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(settings.providers.zai?.defaultModel).toBe("glm-5.2");
    expect(settings.modelCaches.zai?.models.map((model) => model.id)).toEqual([
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-4.7",
    ]);
  });

  test("uses the Z.ai Coding Plan endpoint for old default base URLs", () => {
    const settings = buildProviderSettings({
      file: {
        ...emptyProvidersFile(),
        providers: {
          zai: ProviderConfigSchema.parse({
            enabled: true,
            baseUrl: "https://api.z.ai/api/paas/v4",
            defaultModel: "glm-5.2",
          }),
        },
      },
    });

    expect(settings.providers.zai?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  test("merges manual model overrides into searchable provider model lists", () => {
    const file: ProvidersFile = {
      version: 1,
      providers: {
        openrouter: ProviderConfigSchema.parse({
          enabled: true,
          modelOverrides: ["custom/coding-model"],
          defaultModel: "custom/default-model",
        }),
      },
      modelCaches: {},
    };
    const settings = buildProviderSettings({ file });

    const customModels = listProviderModels(settings, "openrouter", {
      query: "custom",
      refresh: false,
      limit: 10,
    });
    const kimiModels = listProviderModels(settings, "openrouter", {
      query: "kimi",
      refresh: false,
      limit: 10,
    });

    expect(customModels.models.map((model) => model.id)).toEqual([
      "custom/coding-model",
      "custom/default-model",
    ]);
    expect(kimiModels.models.map((model) => model.id)).toContain("moonshotai/kimi-k2");
  });

  test("prefers hosted provider catalog over fallback presets", () => {
    const catalog = ProviderCatalogSchema.parse({
      version: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      providers: [
        {
          id: "openrouter",
          displayName: "Hosted OpenRouter",
          lifecycleStatus: "preview",
          credentialModes: ["local-byok"],
          routing: {
            hostedOpChat: false,
            localRuntime: true,
            localByok: true,
            hostedByok: false,
          },
          capabilities: {
            chatCompletions: true,
            streaming: true,
            modelDiscovery: "provider",
            toolCalling: true,
            reasoning: true,
            imageInput: true,
            structuredOutput: true,
          },
          defaultBaseUrl: "https://hosted-catalog.example/v1",
          defaultModel: "hosted/catalog-model",
          modelCacheSource: "curated",
          models: [
            {
              id: "hosted/catalog-model",
              displayName: "Hosted Catalog Model",
              capabilities: { streaming: true, reasoning: true },
            },
          ],
        },
      ],
    });
    const settings = buildProviderSettings({
      file: emptyProvidersFile(),
      catalog,
    });

    expect(settings.statuses.openrouter?.displayName).toBe("Hosted OpenRouter");
    expect(settings.statuses.openrouter?.lifecycleStatus).toBe("preview");
    expect(settings.providers.openrouter?.baseUrl).toBe("https://hosted-catalog.example/v1");
    expect(settings.providers.openrouter?.defaultModel).toBe("hosted/catalog-model");
    expect(settings.modelCaches.openrouter?.models.map((model) => model.id)).toEqual([
      "hosted/catalog-model",
    ]);
    expect(settings.statuses.openpond).toBeDefined();
  });

  test("preserves hosted catalog cache in the local providers file", () => {
    const catalog = ProviderCatalogSchema.parse({
      version: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      providers: [],
    });
    const file = normalizeProvidersFile({
      version: 1,
      providers: {},
      modelCaches: {},
      catalogCache: {
        source: "hosted",
        fetchedAt: "2026-06-30T10:01:00.000Z",
        lastError: null,
        catalogHash: "sha256:test",
        catalog,
      },
    });

    expect(file.catalogCache?.source).toBe("hosted");
    expect(file.catalogCache?.fetchedAt).toBe("2026-06-30T10:01:00.000Z");
    expect(file.catalogCache?.catalogHash).toBe("sha256:test");
    expect(file.catalogCache?.catalog.generatedAt).toBe("2026-06-30T10:00:00.000Z");
  });

  test("deduplicates hosted provider catalog refreshes and caches them by TTL", async () => {
    let catalog = providerCatalogFixture("2026-06-30T10:00:00.000Z", "Hosted OpenRouter");
    let calls = 0;
    const loadHostedCatalog = async () => {
      calls += 1;
      await delay(10);
      return { catalog, error: null };
    };

    const [first, second] = await Promise.all([
      resolveProviderCatalog({
        file: emptyProvidersFile(),
        timestamp: "2026-06-30T10:01:00.000Z",
        nowMs: 1_000,
        ttlMs: 60_000,
        loadHostedCatalog,
      }),
      resolveProviderCatalog({
        file: emptyProvidersFile(),
        timestamp: "2026-06-30T10:01:00.000Z",
        nowMs: 1_000,
        ttlMs: 60_000,
        loadHostedCatalog,
      }),
    ]);

    expect(calls).toBe(1);
    expect(first.file.catalogCache?.catalogHash).toMatch(/^sha256:/);
    expect(second.file.catalogCache?.catalogHash).toBe(first.file.catalogCache?.catalogHash);

    const cached = await resolveProviderCatalog({
      file: first.file,
      timestamp: "2026-06-30T10:01:10.000Z",
      nowMs: 10_000,
      ttlMs: 60_000,
      loadHostedCatalog,
    });
    expect(calls).toBe(1);
    expect(cached.file).toBe(first.file);

    const refreshedCatalog = providerCatalogFixture(
      "2026-06-30T10:02:00.000Z",
      "Hosted OpenRouter v2",
    );
    catalog = refreshedCatalog;
    const refreshed = await resolveProviderCatalog({
      file: first.file,
      timestamp: "2026-06-30T10:02:30.000Z",
      nowMs: 62_000,
      ttlMs: 60_000,
      loadHostedCatalog,
    });

    expect(calls).toBe(2);
    expect(refreshed.file.catalogCache?.catalogHash).not.toBe(first.file.catalogCache?.catalogHash);
    expect(refreshed.catalog?.providers[0]?.displayName).toBe("Hosted OpenRouter v2");
  });

  test("uses persisted provider catalog hashes to avoid cache rewrites for unchanged content", async () => {
    const cachedCatalog = providerCatalogFixture(
      "2026-06-30T10:00:00.000Z",
      "Hosted OpenRouter",
    );
    const hostedCatalog = providerCatalogFixture(
      "2026-06-30T10:05:00.000Z",
      "Hosted OpenRouter",
    );
    const catalogHash = providerCatalogContentHash(cachedCatalog);
    const file = normalizeProvidersFile({
      version: 1,
      providers: {},
      modelCaches: {},
      catalogCache: {
        source: "hosted",
        fetchedAt: "2026-06-30T10:01:00.000Z",
        lastError: null,
        catalogHash,
        catalog: cachedCatalog,
      },
    });

    const resolved = await resolveProviderCatalog({
      file,
      timestamp: "2026-06-30T10:06:00.000Z",
      nowMs: 1_000,
      ttlMs: 0,
      loadHostedCatalog: async () => ({ catalog: hostedCatalog, error: null }),
    });

    expect(providerCatalogContentHash(hostedCatalog)).toBe(catalogHash);
    expect(resolved.file).toBe(file);
    expect(resolved.catalog?.generatedAt).toBe("2026-06-30T10:05:00.000Z");
  });

  test("refreshes curated model cache with timestamps", () => {
    const fetchedAt = "2026-06-30T10:00:00.000Z";
    const cache = buildProviderModelCache({
      providerId: "fireworks",
      file: emptyProvidersFile(),
      fetchedAt,
    });

    expect(cache.providerId).toBe("fireworks");
    expect(cache.fetchedAt).toBe(fetchedAt);
    expect(cache.source).toBe("curated");
    expect(cache.models.map((model) => model.id)).toContain(
      "accounts/fireworks/models/kimi-k2-instruct",
    );
  });

  test("stores local credentials outside bootstrap settings with redacted status only", async () => {
    const paths = await tempSecretPaths();
    await writeProviderCredential({
      paths,
      providerId: "openrouter",
      request: { source: "local_secret", value: "sk-test-secret-1234" },
      timestamp: "2026-06-30T10:00:00.000Z",
    });

    const rawSecretFile = await readFile(paths.secretsFilePath, "utf8");
    expect(rawSecretFile).not.toContain("sk-test-secret-1234");

    const secrets = await readProviderSecrets(paths);
    expect(secrets.providers.openrouter?.value).toBe("sk-test-secret-1234");

    const settings = buildProviderSettings({
      file: {
        version: 1,
        providers: {
          openrouter: ProviderConfigSchema.parse({ enabled: true }),
        },
        modelCaches: {},
      },
      secrets,
    });

    expect(settings.statuses.openrouter?.available).toBe(true);
    expect(settings.statuses.openrouter?.credential).toMatchObject({
      connected: true,
      source: "local_secret",
      redacted: "sk-t...1234",
    });
    expect(JSON.stringify(settings)).not.toContain("sk-test-secret-1234");
  });

  test("stores OpenAI ChatGPT subscription credentials encrypted with redacted status only", async () => {
    const paths = await tempSecretPaths();
    await writeProviderChatGptSubscriptionCredential({
      paths,
      providerId: "openai",
      credential: {
        accessToken: "access-token-secret",
        refreshToken: "refresh-token-secret",
        expiresAt: Date.now() + 3600_000,
        accountId: "acct_1234567890",
      },
      timestamp: "2026-06-30T10:00:00.000Z",
    });

    const rawSecretFile = await readFile(paths.secretsFilePath, "utf8");
    expect(rawSecretFile).not.toContain("access-token-secret");
    expect(rawSecretFile).not.toContain("refresh-token-secret");

    const secrets = await readProviderSecrets(paths);
    expect(secrets.providers.openai?.oauth?.refreshToken).toBe("refresh-token-secret");
    expect(secrets.providers.openai?.value).toBeNull();

    const settings = buildProviderSettings({
      file: {
        version: 1,
        providers: {
          openai: ProviderConfigSchema.parse({ enabled: true }),
        },
        modelCaches: {},
      },
      secrets,
    });

    expect(settings.statuses.openai?.available).toBe(true);
    expect(settings.statuses.openai?.credential).toMatchObject({
      connected: true,
      source: "chatgpt_subscription",
      redacted: "ac***90",
    });
    expect(JSON.stringify(settings)).not.toContain("refresh-token-secret");
  });

  test("serializes concurrent provider settings file updates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openpond-provider-settings-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "providers.json");

    await Promise.all([
      updateProvidersFile(filePath, async (current) => {
        await delay(10);
        return normalizeProvidersFile({
          ...current,
          providers: {
            ...current.providers,
            openrouter: ProviderConfigSchema.parse({ enabled: true, baseUrl: "https://openrouter.test/v1" }),
          },
        });
      }),
      updateProvidersFile(filePath, async (current) => {
        await delay(1);
        return normalizeProvidersFile({
          ...current,
          providers: {
            ...current.providers,
            groq: ProviderConfigSchema.parse({ enabled: true, baseUrl: "https://groq.test/openai/v1" }),
          },
        });
      }),
    ]);

    const file = await readProvidersFile(filePath);
    expect(file.providers.openrouter?.baseUrl).toBe("https://openrouter.test/v1");
    expect(file.providers.groq?.baseUrl).toBe("https://groq.test/openai/v1");
  });

  test("serializes concurrent provider secret file updates", async () => {
    const paths = await tempSecretPaths();

    await Promise.all([
      writeProviderCredential({
        paths,
        providerId: "openrouter",
        request: { source: "local_secret", value: "sk-openrouter" },
        timestamp: "2026-06-30T10:00:00.000Z",
      }),
      writeProviderCredential({
        paths,
        providerId: "groq",
        request: { source: "local_secret", value: "sk-groq" },
        timestamp: "2026-06-30T10:00:01.000Z",
      }),
    ]);

    const secrets = await readProviderSecrets(paths);
    expect(secrets.providers.openrouter?.value).toBe("sk-openrouter");
    expect(secrets.providers.groq?.value).toBe("sk-groq");
  });
});

function emptyProvidersFile(): ProvidersFile {
  return { version: 1, providers: {}, modelCaches: {} };
}

function providerCatalogFixture(generatedAt: string, displayName: string) {
  return ProviderCatalogSchema.parse({
    version: 1,
    generatedAt,
    providers: [
      {
        id: "openrouter",
        displayName,
        lifecycleStatus: "active",
        credentialModes: ["local-byok"],
        routing: {
          hostedOpChat: false,
          localRuntime: true,
          localByok: true,
          hostedByok: false,
        },
        capabilities: {
          chatCompletions: true,
          streaming: true,
          modelDiscovery: "provider",
          toolCalling: true,
          reasoning: true,
          imageInput: true,
          structuredOutput: true,
        },
        defaultBaseUrl: "https://hosted-catalog.example/v1",
        defaultModel: "hosted/catalog-model",
        modelCacheSource: "curated",
        models: [
          {
            id: "hosted/catalog-model",
            displayName: "Hosted Catalog Model",
          },
        ],
      },
    ],
  });
}

async function tempSecretPaths(): Promise<ProviderSecretStorePaths> {
  const dir = await mkdtemp(path.join(tmpdir(), "openpond-provider-secrets-"));
  tempDirs.push(dir);
  return {
    secretsFilePath: path.join(dir, "provider-secrets.json"),
    keyFilePath: path.join(dir, "provider-secrets.key"),
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
