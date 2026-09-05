import { existsSync } from "node:fs";
import { storagePaths } from "./home.js";
import { openStorageDatabase } from "./database.js";

type CacheRow = { payload: string; updated_at: string; error: string | null; expires_at: number };
export type StoredCacheEntry<T> = { payload: T; updatedAt: string; error: string | null };
const CACHE_SCHEMA = `CREATE TABLE IF NOT EXISTS entries (namespace TEXT NOT NULL, cache_key TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT, expires_at INTEGER NOT NULL, last_used INTEGER NOT NULL, PRIMARY KEY(namespace, cache_key));`;

function withCache<T>(home: string, work: (db: ReturnType<typeof openStorageDatabase>) => T): T {
  const db = openStorageDatabase(storagePaths(home).cache);
  try { db.exec(CACHE_SCHEMA); return work(db); } finally { db.close(); }
}

export function readCache<T>(home: string, namespace: string, key: string, options: { allowStale?: boolean } = {}): StoredCacheEntry<T> | null {
  if (!existsSync(storagePaths(home).cache)) return null;
  return withCache(home, (db) => {
    const row = db.prepare("SELECT payload, updated_at, error, expires_at FROM entries WHERE namespace = ? AND cache_key = ?").get(namespace, key) as CacheRow | undefined;
    if (!row || (!options.allowStale && row.expires_at < Date.now())) return null;
    db.prepare("UPDATE entries SET last_used = ? WHERE namespace = ? AND cache_key = ?").run(Date.now(), namespace, key);
    return { payload: JSON.parse(row.payload) as T, updatedAt: row.updated_at, error: row.error };
  });
}

export function writeCache<T>(home: string, namespace: string, key: string, payload: T, options: { error?: string | null; ttlMs?: number } = {}): StoredCacheEntry<T> {
  const now = Date.now(), updatedAt = new Date(now).toISOString();
  const json = JSON.stringify(payload);
  withCache(home, (db) => {
    db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, cache_key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at, error=excluded.error, expires_at=excluded.expires_at, last_used=excluded.last_used").run(namespace, key, json, updatedAt, options.error ?? null, now + (options.ttlMs ?? 3_600_000), now);
    db.prepare("DELETE FROM entries WHERE expires_at < ?").run(now - 7 * 86_400_000);
    let size = Number((db.prepare("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS size FROM entries").get() as { size: number }).size);
    if (size > 512 * 1024 * 1024) {
      for (const row of db.prepare("SELECT namespace, cache_key, length(CAST(payload AS BLOB)) AS size FROM entries ORDER BY last_used").all() as { namespace: string; cache_key: string; size: number }[]) {
        db.prepare("DELETE FROM entries WHERE namespace = ? AND cache_key = ?").run(row.namespace, row.cache_key);
        size -= row.size; if (size <= 512 * 1024 * 1024) break;
      }
    }
  });
  return { payload, updatedAt, error: options.error ?? null };
}

export function listCache<T>(home: string, namespace: string): Record<string, StoredCacheEntry<T>> {
  if (!existsSync(storagePaths(home).cache)) return {};
  return withCache(home, (db) => Object.fromEntries((db.prepare("SELECT cache_key, payload, updated_at, error FROM entries WHERE namespace = ? AND expires_at >= ?").all(namespace, Date.now()) as (CacheRow & { cache_key: string })[]).map((row) => [row.cache_key, { payload: JSON.parse(row.payload) as T, updatedAt: row.updated_at, error: row.error }])));
}

export function clearCache(home: string, namespace?: string): void {
  if (!existsSync(storagePaths(home).cache)) return;
  withCache(home, (db) => { if (namespace) db.prepare("DELETE FROM entries WHERE namespace = ?").run(namespace); else db.exec("DELETE FROM entries"); db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"); });
}
