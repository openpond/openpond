import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  MIGRATION_BACKUP_RETENTION_COUNT,
  pruneMigrationBackups,
} from "../apps/server/src/store/store-backup-retention";
import { withTempDirectory } from "./helpers/temp-directory";

describe("SQLite migration backup retention", () => {
  test("retains the newest two automatic backups and preserves manual recovery data", async () => {
    await withTempDirectory("openpond-backup-retention-", async (storeDir) => {
      const backupsDir = path.join(storeDir, "backups");
      await mkdir(backupsDir, { recursive: true });
      for (const name of [
        "state-20260801010000-before-v45",
        "state-20260802010000-before-v46",
        "state-20260803010000-before-v47",
        "state-20260804010000-before-v48",
        "state-20260723T140609Z-before-model-id-repair",
      ]) {
        const backupDir = path.join(backupsDir, name);
        await mkdir(backupDir);
        await writeFile(path.join(backupDir, "state.sqlite"), name);
      }

      const result = await pruneMigrationBackups(storeDir);

      expect(MIGRATION_BACKUP_RETENTION_COUNT).toBe(2);
      expect(result).toEqual({
        removed: [
          "state-20260802010000-before-v46",
          "state-20260801010000-before-v45",
        ],
        retained: [
          "state-20260804010000-before-v48",
          "state-20260803010000-before-v47",
        ],
      });
      expect((await readdir(backupsDir)).sort()).toEqual([
        "state-20260723T140609Z-before-model-id-repair",
        "state-20260803010000-before-v47",
        "state-20260804010000-before-v48",
      ]);
    });
  });

  test("is a no-op before the first migration backup exists", async () => {
    await withTempDirectory("openpond-backup-retention-empty-", async (storeDir) => {
      await expect(pruneMigrationBackups(storeDir)).resolves.toEqual({
        removed: [],
        retained: [],
      });
    });
  });
});
