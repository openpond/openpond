import { createHash } from "node:crypto";
import { readCache, writeCache } from "@openpond/persistence";
import type { AppListItem } from "./api.js";
import { openPondConfigDirectory } from "./private-json-file.js";

export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
type CacheScope = { apiBase: string; apiKey: string };
function buildCacheKey(scope: CacheScope): string {
  return createHash("sha256").update(JSON.stringify([scope.apiBase.replace(/\/$/, ""), scope.apiKey.trim()])).digest("hex");
}
function cached<T>(namespace: string, params: CacheScope & { ttlMs?: number }): T | null {
  const entry = readCache<T>(openPondConfigDirectory(), namespace, buildCacheKey(params), { allowStale: true });
  if (!entry || Date.now() - Date.parse(entry.updatedAt) >= (params.ttlMs ?? DEFAULT_CACHE_TTL_MS)) return null;
  return entry.payload;
}
export async function getCachedApps(params: CacheScope & { ttlMs?: number }): Promise<AppListItem[] | null> {
  return cached("cloud.apps", params);
}
export async function setCachedApps(params: CacheScope & { apps: AppListItem[] }): Promise<void> {
  writeCache(openPondConfigDirectory(), "cloud.apps", buildCacheKey(params), params.apps);
}
export async function getCachedTools(params: CacheScope & { ttlMs?: number }): Promise<unknown[] | null> {
  return cached("cloud.tools", params);
}
export async function setCachedTools(params: CacheScope & { tools: unknown[] }): Promise<void> {
  writeCache(openPondConfigDirectory(), "cloud.tools", buildCacheKey(params), params.tools);
}
