import { protectPrivateDirectory } from "./private-permissions.js";
import { assertStorageAncestors } from "./path-safety.js";
import { mkdirSync, chmodSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PersistenceError } from "./errors.js";

export function openStorageDatabase(filePath: string, readOnly = false): DatabaseSync {
  assertStorageAncestors(path.dirname(filePath));
  if (!readOnly) {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    protectPrivateDirectory(path.dirname(filePath));
  }
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink())
    throw new PersistenceError({
      code: "UNSAFE_STORAGE_PATH",
      path: filePath,
      message: "Storage database cannot be a symbolic link.",
      action: "Choose a regular local database file.",
    });
  const db = new DatabaseSync(filePath, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (!readOnly) {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      if (process.platform !== "win32") chmodSync(filePath, 0o600);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
