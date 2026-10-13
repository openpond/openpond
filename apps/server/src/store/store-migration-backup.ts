import type { StorageStartupProgress } from "@openpond/runtime/ready-line-parser";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import {
  atomicWriteFile,
  openStorageDatabase,
  privateDirectory,
  readOptionalFile,
} from "@openpond/persistence";
import type { Logger } from "@openpond/logging";
import { timestampForPath } from "./store-codecs.js";
import { migrationBackupDirectories } from "./store-backup-retention.js";

type BackupReceipt = {
  version: 1;
  sourceVersion: number;
  sourceFingerprint: string;
  backupDigest: string;
};

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** The caller checkpoints WAL, then holds the database writer lock until migration commits. */
export async function ensureMigrationBackup(input: {
  storeDir: string;
  storePath: string;
  sourceVersion: number;
  logger?: Logger;
  onProgress?: (progress: StorageStartupProgress) => void;
}): Promise<string> {
  const { storeDir, storePath, sourceVersion, logger, onProgress } = input;
  const root = path.join(storeDir, "backups");
  await privateDirectory(root);
  // A crashed process cannot clean its unpublished staging copy. Migration
  // ownership and the SQLite writer lock make these stale attempts safe to discard.
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      /^\.state-\d{14}-before-v\d+-[a-f0-9]{8}\.preparing$/.test(entry.name)
    ) {
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
  // Include any WAL committed between checkpoint and acquisition of the writer lock.
  // An empty or absent WAL has the same meaning, including after a failed transaction.
  const walSize = await fs
    .stat(`${storePath}-wal`)
    .then((stat) => stat.size)
    .catch((error) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
  onProgress?.({ phase: "verify", message: "Checking your recovery snapshot" });
  logger?.info("sqlite migration backup checking", { sourceVersion, storePath });
  const sourceFingerprint = `${await digest(storePath)}:${walSize ? await digest(`${storePath}-wal`) : "empty"}`;
  for (const name of await migrationBackupDirectories(storeDir)) {
    const directory = path.join(root, name);
    const raw = await readOptionalFile(path.join(directory, "receipt.json"));
    if (!raw) continue;
    let receipt: BackupReceipt;
    try {
      receipt = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      !receipt ||
      receipt.version !== 1 ||
      receipt.sourceVersion !== sourceVersion ||
      receipt.sourceFingerprint !== sourceFingerprint
    )
      continue;
    const file = path.join(directory, "state.sqlite");
    try {
      if ((await fs.lstat(file)).isSymbolicLink() || (await digest(file)) !== receipt.backupDigest)
        continue;
      verifyBackup(file, sourceVersion);
      logger?.info("sqlite migration backup reused", { backupDir: directory, sourceVersion });
      return directory;
    } catch (error) {
      logger?.warn("sqlite migration backup cannot be reused", { backupDir: directory, error });
    }
  }

  const name = `state-${timestampForPath()}-before-v${sourceVersion + 1}-${randomUUID().slice(0, 8)}`;
  const prepared = path.join(root, `.${name}.preparing`);
  const directory = path.join(root, name);
  await privateDirectory(prepared);
  try {
    const target = path.join(prepared, "state.sqlite");
    const source = openStorageDatabase(storePath, true);
    let lastProgress = -1;
    onProgress?.({ phase: "backup", message: "Saving a recovery copy of your data", percent: 0 });
    logger?.info("sqlite migration backup started", { sourceVersion, backupDir: directory });
    try {
      await backup(source, target, {
        progress: ({ totalPages, remainingPages }) => {
          const progress = totalPages
            ? Math.floor(((totalPages - remainingPages) * 10) / totalPages) * 10
            : 100;
          if (progress > lastProgress) {
            lastProgress = progress;
            onProgress?.({
              phase: "backup",
              message: "Saving a recovery copy of your data",
              percent: progress,
            });
            logger?.info("sqlite migration backup progress", { progress, backupDir: directory });
          }
        },
      });
    } finally {
      source.close();
    }
    await fs.chmod(target, 0o600);
    onProgress?.({ phase: "verify", message: "Verifying your recovery copy" });
    verifyBackup(target, sourceVersion);
    const receipt: BackupReceipt = {
      version: 1,
      sourceVersion,
      sourceFingerprint,
      backupDigest: await digest(target),
    };
    const handle = await fs.open(target, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicWriteFile(path.join(prepared, "receipt.json"), JSON.stringify(receipt));
    await fs.rename(prepared, directory);
    if (process.platform !== "win32") {
      const parent = await fs.open(root, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    logger?.info("sqlite backup created", { backupDir: directory, copied: 1 });
    return directory;
  } finally {
    // Only incomplete files from this attempt; never remove a published recovery copy.
    await fs.rm(prepared, { recursive: true, force: true });
  }
}

function verifyBackup(file: string, expectedVersion: number): void {
  const db = openStorageDatabase(file, true);
  try {
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const checks = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    if (
      version.user_version !== expectedVersion ||
      checks.some((row) => row.quick_check !== "ok")
    ) {
      throw new Error("Migration backup failed verification");
    }
  } finally {
    db.close();
  }
}
