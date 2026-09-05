import { promises as fs } from "node:fs";
import path from "node:path";

export const MIGRATION_BACKUP_RETENTION_COUNT = 2;

const MIGRATION_BACKUP_DIRECTORY = /^state-(\d{14})-before-v(\d+)$/;

export type MigrationBackupPruneResult = {
  removed: string[];
  retained: string[];
};

export async function pruneMigrationBackups(
  storeDir: string,
  retainCount = MIGRATION_BACKUP_RETENTION_COUNT,
): Promise<MigrationBackupPruneResult> {
  const backupsDir = path.join(storeDir, "backups");
  const entries = await fs.readdir(backupsDir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const migrationBackups = entries
    .filter((entry) => entry.isDirectory() && MIGRATION_BACKUP_DIRECTORY.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  const boundedRetainCount = Math.max(2, Math.trunc(retainCount));
  const retained = migrationBackups.slice(0, boundedRetainCount);
  const removed: string[] = [];
  for (const name of migrationBackups.slice(boundedRetainCount)) {
    const stat = await fs.stat(path.join(backupsDir, name));
    if (stat.mtimeMs >= Date.now() - 30 * 86_400_000) retained.push(name);
    else removed.push(name);
  }

  for (const name of removed) {
    await fs.rm(path.join(backupsDir, name), { recursive: true, force: true });
  }

  return { removed, retained };
}
