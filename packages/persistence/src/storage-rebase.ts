import { existsSync } from "node:fs";
import path from "node:path";
import { openStorageDatabase } from "./database.js";
import { storagePaths } from "./home.js";
import { isWithinHome, placementTables } from "./storage-references.js";

const relocationsSql = "CREATE TABLE IF NOT EXISTS storage_path_relocations (source TEXT PRIMARY KEY, destination TEXT NOT NULL)";

export type StorageMove = { from: string; to: string };
/** Only placement fields change; durable IDs and immutable transcript/source content do not. */
export function rebaseStoragePointers(home: string, moves: StorageMove[]): void {
  const file = storagePaths(home).database;
  if (!existsSync(file)) return;
  const ordered = [...moves].sort((a, b) => b.from.length - a.from.length);
  function rebase(value: string): string {
    if (!path.isAbsolute(value)) return value;
    const move = ordered.find((entry) => isWithinHome(value, entry.from));
    return move ? path.join(move.to, path.relative(move.from, value)) : value;
  }
  function visit(value: unknown, key = ""): unknown {
    if (typeof value === "string" && /(?:path|directory|root|cwd)$/i.test(key)) return rebase(value);
    if (Array.isArray(value)) return value.map((entry) => visit(entry, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field,
      ["messages", "events", "turns", "metadata", "input", "output", "result", "credential", "manifest"].includes(field) ? entry : visit(entry, field)]));
    return value;
  }
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const db = openStorageDatabase(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(relocationsSql);
    for (const row of db.prepare("SELECT source, destination FROM storage_path_relocations").all() as { source: string; destination: string }[]) {
      db.prepare("UPDATE storage_path_relocations SET destination=? WHERE source=?").run(rebase(row.destination), row.source);
    }
    for (const move of ordered) if (move.from !== move.to) db.prepare("INSERT INTO storage_path_relocations VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET destination=excluded.destination").run(move.from, move.to);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) if (placementTables.has(name)) {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string; pk: number }[];
      const keys = columns.filter((entry) => entry.pk).sort((a, b) => a.pk - b.pk);
      if (!keys.length) continue;
      const fields = columns.filter((entry) => entry.name === "payload" || /(?:_path|_directory|_root)$/.test(entry.name) || entry.name === "cwd");
      const where = keys.map((entry) => `${quote(entry.name)}=?`).join(" AND ");
      for (const row of db.prepare(`SELECT * FROM ${quote(name)}`).all()) {
        for (const field of fields) {
          const before = row[field.name];
          if (typeof before !== "string") continue;
          const after = field.name === "payload" ? JSON.stringify(visit(JSON.parse(before))) : rebase(before);
          if (before !== after) db.prepare(`UPDATE ${quote(name)} SET ${quote(field.name)}=? WHERE ${where}`).run(after, ...keys.map((entry) => row[entry.name]!));
        }
      }
    }
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
}

/** Immutable receipts keep their hashed bytes; only readers translate recorded storage placement. */
export function resolveStoredPath(home: string, recordedPath: string): string {
  const file = storagePaths(home).database;
  if (!path.isAbsolute(recordedPath) || !existsSync(file)) return recordedPath;
  const db = openStorageDatabase(file, true);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_path_relocations'").get()) return recordedPath;
    const moves = (db.prepare("SELECT source, destination FROM storage_path_relocations").all() as { source: string; destination: string }[]).sort((a, b) => b.source.length - a.source.length);
    const move = moves.find((entry) => isWithinHome(recordedPath, entry.source));
    return move ? path.join(move.destination, path.relative(move.source, recordedPath)) : recordedPath;
  } finally { db.close(); }
}
