import path from "node:path";
import {
  ProviderCatalogSchema,
  ProviderConfigSchema,
  ProviderSettingsSchema,
  type ProviderConfigPatch,
} from "@openpond/contracts";
import type { ProvidersFile } from "../types.js";

const ProviderCatalogCacheSchema = ProviderCatalogSchema.transform((catalog) => catalog);
import { readConfig, updateConfig, readCache, writeCache, withFileLock, storagePaths } from "@openpond/persistence";


function normalizeCatalogCache(value: unknown): ProvidersFile["catalogCache"] {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const catalog = ProviderCatalogCacheSchema.safeParse(record.catalog);
  const fetchedAt =
    typeof record.fetchedAt === "string" && record.fetchedAt.trim()
      ? record.fetchedAt
      : null;
  if (!catalog.success || !fetchedAt) return null;
  return {
    source: "hosted",
    fetchedAt,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    catalogHash:
      typeof record.catalogHash === "string" && record.catalogHash.trim()
        ? record.catalogHash
        : null,
    catalog: catalog.data,
  };
}

export function normalizeProvidersFile(_value: unknown): ProvidersFile {
  const parsed = ProviderSettingsSchema.safeParse(_value);
  const catalogCache = normalizeCatalogCache(
    _value && typeof _value === "object"
      ? (_value as Record<string, unknown>).catalogCache
      : null,
  );
  if (parsed.success) {
    return {
      version: 1,
      providers: parsed.data.providers,
      modelCaches: parsed.data.modelCaches,
      catalogCache,
    };
  }
  return {
    version: 1,
    providers: {},
    modelCaches: {},
    catalogCache,
  };
}

export function mergeProviderConfigPatch(input: {
  value: ProvidersFile;
  providerId: string;
  patch: ProviderConfigPatch;
  updatedAt: string;
}): ProvidersFile {
  return normalizeProvidersFile({
    ...input.value,
    providers: {
      ...input.value.providers,
      [input.providerId]: ProviderConfigSchema.parse({
        ...input.value.providers[input.providerId],
        ...input.patch,
        updatedAt: input.updatedAt,
      }),
    },
  });
}

export async function readProvidersFile(filePath: string): Promise<ProvidersFile> {
  const home = path.dirname(filePath);
  const { document } = await readConfig(home);
  const cache = await readCache<Pick<ProvidersFile, "modelCaches" | "catalogCache">>(home, "providers", "catalog", { allowStale: true });
  return normalizeProvidersFile({
    ...cache?.payload,
    providers: Object.fromEntries(Object.entries(document.providers ?? {}).map(([id, value]) => [id, {
      enabled: value.enabled ?? true, baseUrl: value.base_url ?? null, defaultModel: value.default_model ?? null, modelOverrides: value.model_overrides ?? [],
    }])),
  });
}

export async function updateProvidersFile(
  filePath: string,
  updater: (current: ProvidersFile) => ProvidersFile | Promise<ProvidersFile>,
): Promise<ProvidersFile> {
  const home = path.dirname(filePath);
  return withFileLock(path.join(storagePaths(home).runtime, "providers"), async () => {
    const current = await readProvidersFile(filePath);
    const next = normalizeProvidersFile(await updater(current));
    await updateConfig(home, (document) => {
      const providers = { ...document.providers };
      for (const id of new Set([...Object.keys(current.providers), ...Object.keys(next.providers)])) {
        if (JSON.stringify(current.providers[id]) === JSON.stringify(next.providers[id])) continue;
        const value = next.providers[id];
        if (!value) { delete providers[id]; continue; }
        providers[id] = {
          ...providers[id], enabled: value.enabled,
          base_url: value.baseUrl || undefined, default_model: value.defaultModel || undefined, model_overrides: value.modelOverrides,
        };
      }
      return { ...document, ...(Object.keys(providers).length || document.providers ? { providers } : {}) };
    });
    if (JSON.stringify([current.modelCaches, current.catalogCache]) !== JSON.stringify([next.modelCaches, next.catalogCache])) {
      await writeCache(home, "providers", "catalog", { modelCaches: next.modelCaches, catalogCache: next.catalogCache });
    }
    return readProvidersFile(filePath);
  });
}

export async function writeProvidersFile(filePath: string, value: ProvidersFile): Promise<void> {
  await updateProvidersFile(filePath, () => value);
}
