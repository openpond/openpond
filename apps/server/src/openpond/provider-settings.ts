import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ProviderCatalogSchema,
  ProviderConfigSchema,
  ProviderSettingsSchema,
  type ProviderConfigPatch,
} from "@openpond/contracts";
import type { ProvidersFile } from "../types.js";

const ProviderCatalogCacheSchema = ProviderCatalogSchema.transform((catalog) => catalog);
const providerFileQueues = new Map<string, Promise<void>>();

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
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeProvidersFile(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeProvidersFile({});
    throw error;
  }
}

export async function updateProvidersFile(
  filePath: string,
  updater: (current: ProvidersFile) => ProvidersFile | Promise<ProvidersFile>,
): Promise<ProvidersFile> {
  return withProviderFileQueue(filePath, async () => {
    const current = await readProvidersFile(filePath);
    const next = normalizeProvidersFile(await updater(current));
    await writeProvidersFileUnlocked(filePath, next);
    return next;
  });
}

export async function writeProvidersFile(filePath: string, value: ProvidersFile): Promise<void> {
  await withProviderFileQueue(filePath, () => writeProvidersFileUnlocked(filePath, value));
}

async function writeProvidersFileUnlocked(filePath: string, value: ProvidersFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeProvidersFile(value);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

function withProviderFileQueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = providerFileQueues.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const queued = run
    .catch(() => undefined)
    .then(() => {
      if (providerFileQueues.get(filePath) === queued) providerFileQueues.delete(filePath);
    });
  providerFileQueues.set(filePath, queued);
  return run;
}
