import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppListItem } from "./api.js";

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

const CACHE_DIR = ".openpond";
const CACHE_FILENAME = "cache.json";
const DEFAULT_STORE: CacheStore = { version: 1, byKey: {} };

export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

function getCachePath(): string {
  return path.join(os.homedir(), CACHE_DIR, CACHE_FILENAME);
}

function buildCacheKey(apiBase: string, apiKey: string): string {
  const trimmed = apiKey.trim();
  const hint =
    trimmed.length > 12
      ? `${trimmed.slice(0, 8)}_${trimmed.slice(-4)}`
      : trimmed;
  try {
    const host = new URL(apiBase).host;
    return `${host}:${hint}`;
  } catch {
    return `${apiBase}:${hint}`;
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
      return DEFAULT_STORE;
    }
    return parsed;
  } catch {
    return DEFAULT_STORE;
  }
}

async function saveCache(store: CacheStore): Promise<void> {
  const filePath = getCachePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
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
  const store = await loadCache();
  const cacheKey = buildCacheKey(params.apiBase, params.apiKey);
  const bucket = store.byKey[cacheKey] || {};
  bucket.apps = {
    items: params.apps,
    updatedAt: new Date().toISOString(),
  };
  store.byKey[cacheKey] = bucket;
  await saveCache(store);
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
  const store = await loadCache();
  const cacheKey = buildCacheKey(params.apiBase, params.apiKey);
  const bucket = store.byKey[cacheKey] || {};
  bucket.tools = {
    items: params.tools,
    updatedAt: new Date().toISOString(),
  };
  store.byKey[cacheKey] = bucket;
  await saveCache(store);
}
