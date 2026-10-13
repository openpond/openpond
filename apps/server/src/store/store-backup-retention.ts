import { promises as fs } from "node:fs";
import path from "node:path";

export const MIGRATION_BACKUP_RETENTION_COUNT = 2;
export const MIGRATION_BACKUP_BUDGET_BYTES = 2 * 1024 ** 3;

const MIGRATION_BACKUP_DIRECTORY = /^state-(\d{14})-before-v(\d+)(?:-[a-f0-9]{8})?$/;

export type MigrationBackupPruneResult = {
  removed: string[];
  retained: string[];
};

export async function migrationBackupDirectories(storeDir: string): Promise<string[]> {
  const entries = await fs
    .readdir(path.join(storeDir, "backups"), { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && MIGRATION_BACKUP_DIRECTORY.test(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        modified: (await fs.stat(path.join(storeDir, "backups", entry.name))).mtimeMs,
      })),
  );
  return directories
    .sort((left, right) => {
      const dateOrder = right.name.slice(6, 20).localeCompare(left.name.slice(6, 20));
      return dateOrder || right.modified - left.modified || right.name.localeCompare(left.name);
    })
    .map((entry) => entry.name);
}

/** Call only after successful database initialization. Keep the newest recovery
 * copy even when it alone exceeds the budget. Manual and incomplete backups are untouched. */
export async function pruneMigrationBackups(
  storeDir: string,
  options: { maxCount?: number; maxBytes?: number; protectedBackup?: string } = {},
): Promise<MigrationBackupPruneResult> {
  const backupsDir = path.join(storeDir, "backups");
  const names = await migrationBackupDirectories(storeDir);
  if (options.protectedBackup) {
    const protectedName = path.basename(options.protectedBackup);
    const index = names.indexOf(protectedName);
    if (index >= 0) names.unshift(...names.splice(index, 1));
  }
  const maxCount = Math.max(1, options.maxCount ?? MIGRATION_BACKUP_RETENTION_COUNT);
  const maxBytes = Math.max(0, options.maxBytes ?? MIGRATION_BACKUP_BUDGET_BYTES);
  const retained: string[] = [];
  const removed: string[] = [];
  let bytes = 0;
  for (const name of names) {
    const size = await directoryBytes(path.join(backupsDir, name));
    if (!retained.length || (retained.length < maxCount && bytes + size <= maxBytes)) {
      retained.push(name);
      bytes += size;
    } else removed.push(name);
  }
  for (const name of removed)
    await fs.rm(path.join(backupsDir, name), { recursive: true, force: true });
  return { removed, retained };
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    // Never follow a link outside managed backup storage.
    bytes += entry.isDirectory() ? await directoryBytes(file) : (await fs.lstat(file)).size;
  }
  return bytes;
}
