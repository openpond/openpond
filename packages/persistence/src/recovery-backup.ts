import { rebaseStoragePointers } from "./storage-rebase.js";
import { externalStorageReferences } from "./storage-references.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { acquireFileLock, atomicWriteFile, privateDirectory } from "./private-file.js";
import { storagePaths } from "./home.js";
import { initializeHome, validateMigratedHome } from "./migration.js";
import { snapshotCopy, fileReceipts } from "./migration-files.js";
import { openStorageDatabase } from "./database.js";
import { updateConfig } from "./config.js";
import { encryptBackup, decryptBackup, within, type BackupManifest } from "./backup-format.js";
import { PersistenceError, isMissing } from "./errors.js";

const excluded = new Set(["backups", "runtime", "cache", "logs", "diagnostics", "browser", "tmp", "openpond-app", "openpond-app-nightly", "config.json", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "providers.json", "provider-secrets.json", "provider-secrets.key", "personalization.json", "SOUL.md", "token"]);
export async function exportRecoveryBackup(home: string, destination: string, key: Uint8Array): Promise<{ path: string; files: number; externalRoots: BackupManifest["externalRoots"] }> {
  home = path.resolve(home); destination = path.resolve(destination);
  if (within(destination, home)) throw new Error("Export recovery backups outside the active home.");
  const releases: (() => Promise<void>)[] = [];
  const stage = path.join(path.dirname(home), `.${path.basename(home)}-backup-${randomUUID()}`), temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    releases.push(await acquireFileLock(path.join(storagePaths(home).runtime, "server-owner"), 100));
    await initializeHome(home);
    for (const name of ["accounts", "providers", "preferences", "personalization", "artifacts"]) releases.push(await acquireFileLock(path.join(storagePaths(home).runtime, name)));
    releases.push(await acquireFileLock(storagePaths(home).config));
    releases.push(await acquireFileLock(storagePaths(home).credentials));
    await privateDirectory(stage);
    for (const entry of await fs.readdir(home)) {
      if (excluded.has(entry) || entry === "state") continue;
      await snapshotCopy(path.join(home, entry), path.join(stage, entry));
    }
    const database = storagePaths(home).database;
    if (await fs.stat(database).catch((error) => { if (isMissing(error)) return null; throw error; })) {
      await privateDirectory(path.dirname(storagePaths(stage).database));
      const db = openStorageDatabase(database, true);
      try { await backup(db, storagePaths(stage).database); } finally { db.close(); }
    }
    await validateMigratedHome(stage);
    const externalRoots = await externalStorageReferences(home);
    const entries: BackupManifest["entries"] = [];
    for (const receipt of await fileReceipts(stage)) {
      if (receipt.path.endsWith("-wal") || receipt.path.endsWith("-shm") || /^(config\.toml|secrets[\\/](?:credentials\.json|server-token))\.lock(?:\.|$)/.test(receipt.path)) continue;
      const file = path.join(stage, receipt.path), stat = await fs.lstat(file);
      const link = stat.isSymbolicLink() ? await fs.readlink(file) : undefined;
      if (link !== undefined && (path.isAbsolute(link) || !within(path.resolve(path.dirname(file), link), stage))) throw new Error(`Source symlink requires rebinding before export: ${receipt.path}`);
      entries.push({ path: receipt.path, sha256: receipt.sha256, sizeBytes: link === undefined ? stat.size : 0, executable: receipt.executable ?? false, ...(link === undefined ? {} : { link }) });
    }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await encryptBackup(stage, temporary, key, { schemaVersion: "openpond.recoveryBackup.v1", originalHome: home, createdAt: new Date().toISOString(), entries, externalRoots, browserIncluded: false });
    await fs.link(temporary, destination);
    return { path: destination, files: entries.length, externalRoots };
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    throw new PersistenceError({ code: "BACKUP_FAILED", path: destination, message: "The recovery backup could not be completed.", action: "Keep the application stopped, check the destination and supplied encryption key, then retry. Existing backups are never overwritten." }, { cause });
  } finally {
    await fs.rm(stage, { recursive: true, force: true }); await fs.rm(temporary, { force: true });
    for (const release of releases.reverse()) await release();
  }
}
export async function restoreRecoveryBackup(source: string, destination: string, key: Uint8Array) {
  destination = path.resolve(destination);
  const existing = await fs.lstat(destination).catch((error) => { if (isMissing(error)) return null; throw error; });
  if (existing && (!existing.isDirectory() || (await fs.readdir(destination)).length)) throw new Error("Restore requires a fresh, empty home. Existing homes are never overwritten.");
  const stage = path.join(path.dirname(destination), `.${path.basename(destination)}-restore-${randomUUID()}`);
  await privateDirectory(stage);
  try {
    const manifest = await decryptBackup(source, stage, key);
    await validateMigratedHome(stage);
    await rebaseRestoredPointers(stage, manifest.originalHome, destination);
    // The recovered home is a new authority. An old installation journal must not be replayed.
    await atomicWriteFile(storagePaths(stage).marker, JSON.stringify({ schemaVersion: "openpond.storage.v1", version: 1, migrationId: null, restoredAt: new Date().toISOString() }));
    await atomicWriteFile(path.join(stage, "restore-receipt.json"), JSON.stringify({ schemaVersion: "openpond.restoreReceipt.v1", originalHome: manifest.originalHome, restoredAt: new Date().toISOString(), externalRoots: manifest.externalRoots }));
    await validateMigratedHome(stage);
    if (existing) await fs.rmdir(destination);
    await fs.rename(stage, destination);
    return { home: destination, files: manifest.entries.length, externalRoots: await Promise.all(manifest.externalRoots.map(async (root) => ({ ...root, available: Boolean(await fs.stat(root.path).catch(() => null)) }))) };
  } catch (cause) { throw new PersistenceError({ code: "RESTORE_FAILED", path: destination, message: "The backup could not be authenticated and validated for restoration.", action: "Check the backup and its separately stored key. The existing home has not been replaced." }, { cause }); }
  finally { await fs.rm(stage, { recursive: true, force: true }); }
}
async function rebaseRestoredPointers(stage: string, original: string, destination: string): Promise<void> {
  const rebase = (value: string) => within(value, original) ? path.join(destination, path.relative(original, value)) : value;
  await updateConfig(stage, (config) => ({ ...config,
    ...(config.storage?.datasets_dir && path.isAbsolute(config.storage.datasets_dir) ? { storage: { ...config.storage, datasets_dir: rebase(config.storage.datasets_dir) } } : {}),
    ...(config.personalization?.user_instructions && path.isAbsolute(config.personalization.user_instructions) ? { personalization: { ...config.personalization, user_instructions: rebase(config.personalization.user_instructions) } } : {}),
    ...(config.projects?.new_project_directory && path.isAbsolute(config.projects.new_project_directory) ? { projects: { ...config.projects, new_project_directory: rebase(config.projects.new_project_directory) } } : {}),
  }));
  rebaseStoragePointers(stage, [{ from: original, to: destination }]);
}
