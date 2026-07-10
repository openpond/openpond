import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import type { AppListItem } from "./api.js";
import { openPondConfigDirectory, updatePrivateJsonFile } from "./private-json-file.js";

type CacheEntry<T> = {
  items: T;
  updatedAt: string;
};

type CacheBucket = {
  apps?: CacheEntry<AppListItem[]>;
  tools?: CacheEntry<unknown[]>;
};

type CacheStore = {
  version: 1;
  byKey: Record<string, CacheBucket>;
};

const CACHE_FILENAME = "cache.json";

export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

function getCachePath(): string {
  return path.join(openPondConfigDirectory(), CACHE_FILENAME);
}

function buildCacheKey(apiBase: string, apiKey: string): string {
  const credentialHash = createHash("sha256").update(apiKey.trim()).digest("hex");
  try {
    const host = new URL(apiBase).host;
    return `${host}:${credentialHash}`;
  } catch {
    return `${apiBase}:${credentialHash}`;
  }
}

function isFresh(updatedAt: string, ttlMs: number): boolean {
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return Date.now() - timestamp < ttlMs;
}

async function loadCache(): Promise<CacheStore> {
  try {
    const raw = await fs.readFile(getCachePath(), "utf-8");
    const parsed = JSON.parse(raw) as CacheStore;
    if (!parsed || typeof parsed !== "object" || !parsed.byKey) {
      return emptyCacheStore();
    }
    return parsed;
  } catch {
    return emptyCacheStore();
  }
}

function emptyCacheStore(): CacheStore {
  return { version: 1, byKey: {} };
}

export async function getCachedApps(params: {
  apiBase: string;
  apiKey: string;
  ttlMs?: number;
}): Promise<AppListItem[] | null> {
  const ttlMs = params.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const store = await loadCache();
  const cacheKey = buildCacheKey(params.apiBase, params.apiKey);
  const entry = store.byKey[cacheKey]?.apps;
  if (!entry || !isFresh(entry.updatedAt, ttlMs)) {
    return null;
  }
  return Array.isArray(entry.items) ? entry.items : null;
}

export async function setCachedApps(params: {
  apiBase: string;
  apiKey: string;
  apps: AppListItem[];
}): Promise<void> {
  await mutateCache((store) => {
    const cacheKey = buildCacheKey(params.apiBase, params.apiKey);
    const bucket = store.byKey[cacheKey] || {};
    bucket.apps = {
      items: params.apps,
      updatedAt: new Date().toISOString(),
    };
    store.byKey[cacheKey] = bucket;
  });
}

export async function getCachedTools(params: {
  apiBase: string;
  apiKey: string;
  ttlMs?: number;
}): Promise<unknown[] | null> {
  const ttlMs = params.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const store = await loadCache();
  const cacheKey = buildCacheKey(params.apiBase, params.apiKey);
  const entry = store.byKey[cacheKey]?.tools;
  if (!entry || !isFresh(entry.updatedAt, ttlMs)) {
    return null;
  }
  return Array.isArray(entry.items) ? entry.items : null;
}

export async function setCachedTools(params: {
  apiBase: string;
  apiKey: string;
  tools: unknown[];
}): Promise<void> {
  await mutateCache((store) => {
    const cacheKey = buildCacheKey(params.apiBase, params.apiKey);
    const bucket = store.byKey[cacheKey] || {};
    bucket.tools = {
      items: params.tools,
      updatedAt: new Date().toISOString(),
    };
    store.byKey[cacheKey] = bucket;
  });
}

async function mutateCache(mutate: (store: CacheStore) => void): Promise<void> {
  await updatePrivateJsonFile<CacheStore>(getCachePath(), emptyCacheStore, (raw) => {
    const store = raw && typeof raw === "object" && raw.byKey ? raw : emptyCacheStore();
    mutate(store);
    return store;
  });
}
