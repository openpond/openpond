import { openStorageDatabase } from "./storage-database.js";
import { readStorageDatabase } from "./readonly-database.js";
export { openStorageDatabase } from "./storage-database.js";
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


export function withLocalDatabase<T>(home: string, action: (db: DatabaseSync) => T): T {
  const db = openStorageDatabase(storagePaths(home).database);
  try { db.exec(PERSISTENCE_TABLES_SQL); return action(db); } finally { db.close(); }
}

/** Reads do not change journal mode, create schemas, or take a writer lock. */
function readLocalTable<T>(home: string, table: LocalRecordTable, empty: T, read: (db: DatabaseSync) => T): T {
  return readStorageDatabase(storagePaths(home).database, empty, db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return empty;
    return read(db);
  });
}

/** Read a related set of records from one consistent SQLite snapshot, without
 * retaining account data or transactions across calls. */
export function getLocalRecords(
  home: string,
  requests: readonly { table: LocalRecordTable; id: string }[],
): ({ value: unknown; revision: number } | null)[] {
  return readStorageDatabase(storagePaths(home).database, requests.map(() => null), db => {
    db.exec("BEGIN");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
    const statements = new Map<LocalRecordTable, ReturnType<DatabaseSync["prepare"]>>();
    const result = requests.map(({ table, id }) => {
      if (!tables.has(table)) return null;
      let statement = statements.get(table);
      if (!statement) {
        statement = db.prepare(`SELECT payload, revision FROM ${table} WHERE id = ?`);
        statements.set(table, statement);
      }
      const row = statement.get(id) as RecordRow | undefined;
      return row ? { value: JSON.parse(row.payload) as unknown, revision: row.revision } : null;
    });
    db.exec("COMMIT");
    return result;
  });
}

export function getLocalRecord<T>(home: string, table: LocalRecordTable, id: string): { value: T; revision: number } | null {
  return readLocalTable(home, table, null, db => {
    const row = db.prepare(`SELECT payload, revision FROM ${table} WHERE id = ?`).get(id) as RecordRow | undefined;
    return row ? { value: JSON.parse(row.payload) as T, revision: row.revision } : null;
  });
}

export function listLocalRecords<T>(home: string, table: LocalRecordTable): Record<string, { value: T; revision: number }> {
  return readLocalTable(home, table, {}, db => Object.fromEntries((db.prepare(`SELECT id, payload, revision FROM ${table} ORDER BY id`).all() as (RecordRow & { id: string })[]).map(row => [row.id, { value: JSON.parse(row.payload) as T, revision: row.revision }])));
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
