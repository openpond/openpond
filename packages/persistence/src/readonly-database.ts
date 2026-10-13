import { lstatSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openStorageDatabase } from "./storage-database.js";
import { assertStorageAncestors } from "./path-safety.js";
import { isMissing, PersistenceError } from "./errors.js";

type Reader = { db: DatabaseSync; stamp: string; timer: ReturnType<typeof setTimeout> };
const readers = new Map<string, Reader>();
const MAX_READERS = 4;
const IDLE_MS = 10_000;

/** Only connections are reused: each synchronous operation sees current committed
 * data and must finish its transaction before returning. No record/secret cache. */
export function readStorageDatabase<T>(file: string, missing: T, read: (db: DatabaseSync) => T): T {
  const key = path.resolve(file);
  try {
    assertStorageAncestors(path.dirname(key));
    const stat = lstatSync(key, { bigint: true });
    if (!stat.isFile())
      throw new PersistenceError({
        code: "UNSAFE_STORAGE_PATH",
        path: key,
        message: "Storage database must be a regular file.",
        action: "Choose a regular local database file.",
      });
    // SQLite's Windows handles prevent replacement/deletion while open. Keep
    // restore and home removal available to other processes on that platform.
    if (process.platform === "win32") {
      const db = openStorageDatabase(key, true);
      try {
        return read(db);
      } finally {
        db.close();
      }
    }
    // WAL commits remain visible through SQLite itself. A replaced, truncated,
    // restored, or checkpointed main file gets a fresh connection.
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    let reader = readers.get(key);
    if (reader && reader.stamp !== stamp) {
      closeReader(key);
      reader = undefined;
    }
    if (!reader) {
      while (readers.size >= MAX_READERS) closeReader(readers.keys().next().value!);
      const db = openStorageDatabase(key, true);
      reader = { db, stamp, timer: setTimeout(() => closeReader(key), IDLE_MS) };
      reader.timer.unref();
    } else {
      reader.timer.refresh();
      readers.delete(key);
    }
    readers.set(key, reader);
    return read(reader.db);
  } catch (error) {
    closeReader(key);
    if (isMissing(error)) return missing;
    throw error;
  }
}

function closeReader(key: string): void {
  const reader = readers.get(key);
  if (!reader) return;
  readers.delete(key);
  clearTimeout(reader.timer);
  reader.db.close();
}
