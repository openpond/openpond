import { protectPrivateDirectory } from "./private-permissions.js";
import { assertStorageAncestors } from "./path-safety.js";
import { mkdirSync, chmodSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storagePaths } from "./home.js";
import { PersistenceError } from "./errors.js";

export const PERSISTENCE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS scaffold_registrations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS account_selection (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS profile_installations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS extension_installations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS client_preferences (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS saved_local_projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS codex_sidebar_state (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS browser_tab_state (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS project_trust (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS refiner_bindings (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS refiner_transitions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS config_run_snapshots (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS provider_connection_state (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
`;

export type LocalRecordTable = "scaffold_registrations" | "account_sessions" | "account_selection" | "profile_installations" | "extension_installations" | "client_preferences" | "saved_local_projects" | "codex_sidebar_state" | "browser_tab_state" | "project_trust" | "refiner_bindings" | "refiner_transitions" | "config_run_snapshots" | "provider_connection_state";
type RecordRow = { payload: string; revision: number };

export function openStorageDatabase(filePath: string, readOnly = false): DatabaseSync {
  assertStorageAncestors(path.dirname(filePath));
  if (!readOnly) { mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 }); protectPrivateDirectory(path.dirname(filePath)); }
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) throw new PersistenceError({ code: "UNSAFE_STORAGE_PATH", path: filePath, message: "Storage database cannot be a symbolic link.", action: "Choose a regular local database file." });
  const db = new DatabaseSync(filePath, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (!readOnly) {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      if (process.platform !== "win32") chmodSync(filePath, 0o600);
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function withLocalDatabase<T>(home: string, action: (db: DatabaseSync) => T): T {
  const db = openStorageDatabase(storagePaths(home).database);
  try { db.exec(PERSISTENCE_TABLES_SQL); return action(db); } finally { db.close(); }
}

export function getLocalRecord<T>(home: string, table: LocalRecordTable, id: string): { value: T; revision: number } | null {
  if (!existsSync(storagePaths(home).database)) return null;
  return withLocalDatabase(home, (db) => {
    const row = db.prepare(`SELECT payload, revision FROM ${table} WHERE id = ?`).get(id) as RecordRow | undefined;
    return row ? { value: JSON.parse(row.payload) as T, revision: row.revision } : null;
  });
}

export function listLocalRecords<T>(home: string, table: LocalRecordTable): Record<string, { value: T; revision: number }> {
  if (!existsSync(storagePaths(home).database)) return {};
  return withLocalDatabase(home, (db) => Object.fromEntries((db.prepare(`SELECT id, payload, revision FROM ${table} ORDER BY id`).all() as (RecordRow & { id: string })[]).map((row) => [row.id, { value: JSON.parse(row.payload) as T, revision: row.revision }])));
}

export function putLocalRecord<T>(home: string, table: LocalRecordTable, id: string, value: T, expectedRevision?: number | null): number {
  return withLocalDatabase(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare(`SELECT revision FROM ${table} WHERE id = ?`).get(id) as { revision: number } | undefined;
      if (expectedRevision !== undefined && expectedRevision !== (existing?.revision ?? null)) throw new PersistenceError({ code: "STATE_CONFLICT", path: table, message: "This record changed while it was being edited.", action: "Reload the latest record and retry." });
      const revision = (existing?.revision ?? 0) + 1;
      db.prepare(`INSERT INTO ${table} (id, payload, revision) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=excluded.revision`).run(id, JSON.stringify(value), revision);
      db.exec("COMMIT"); return revision;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}

export function deleteLocalRecord(home: string, table: LocalRecordTable, id: string): void {
  withLocalDatabase(home, (db) => { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); });
}
