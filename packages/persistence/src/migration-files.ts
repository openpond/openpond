import { MigrationResolutionsSchema } from "./migration-conflicts.js";
import { digestFile } from "./file-integrity.js";
export { digestFile } from "./file-integrity.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteFile, privateDirectory, readJsonFile, readOptionalFile } from "./private-file.js";
import { storagePaths } from "./home.js";
import { PersistenceError, isMissing } from "./errors.js";

const relativePath = z.string().min(1).refine((value) => !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).some((part) => !part || part === "." || part === ".."));
const ReceiptSchema = z.strictObject({ path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean().optional() });
export const MigrationJournalSchema = z.strictObject({
  schemaVersion: z.literal("openpond.migration.v1"), id: z.string().regex(/^migration-[A-Za-z0-9-]+$/),
  status: z.enum(["preparing", "prepared", "installing", "committed", "verified", "failed"]),
  home: z.string(), stage: z.string(), backup: z.string(), files: z.array(ReceiptSchema), installed: z.array(relativePath),
  sourceAppHome: z.string().optional(), sourceConfig: z.string().optional(), sourceBrowserState: z.string().optional(),
  resolutions: MigrationResolutionsSchema.optional(),
  snapshotComplete: z.boolean().optional(), error: z.string().optional(), createdAt: z.string(),
});
export type MigrationJournal = z.infer<typeof MigrationJournalSchema>;
export type FileReceipt = z.infer<typeof ReceiptSchema>;
export const STORAGE_LAYOUT = { schemaVersion: "openpond.storage.v1", version: 1 } as const;

export async function readMigrationJournal(home: string): Promise<MigrationJournal | null> {
  const file = path.join(storagePaths(home).runtime, "migration.json");
  const raw = await readJsonFile<unknown>(file, () => null);
  if (raw === null) return null;
  const parsed = MigrationJournalSchema.safeParse(raw);
  if (!parsed.success) throw invalidJournal(file);
  const value = parsed.data, root = path.resolve(home);
  if (value.home !== root || value.stage !== path.join(path.dirname(root), `.${path.basename(root)}-${value.id}`) || value.backup !== path.join(root, "backups", value.id)) throw invalidJournal(file);
  const names = new Set(value.files.map((entry) => entry.path));
  if (names.size !== value.files.length || value.installed.some((name) => !names.has(name)) || value.files.some((entry) => /^(runtime|backups)([\\/]|$)/.test(entry.path) || entry.path === "storage.json")) throw invalidJournal(file);
  return value;
}
function invalidJournal(file: string): PersistenceError {
  return new PersistenceError({ code: "INVALID_MIGRATION_JOURNAL", path: file, message: "The migration journal could not be verified.", action: "Preserve the journal and backups. Restore a verified backup into a separate home." });
}
export async function saveMigrationJournal(journal: MigrationJournal): Promise<void> {
  MigrationJournalSchema.parse(journal);
  await atomicWriteFile(path.join(storagePaths(journal.home).runtime, "migration.json"), `${JSON.stringify(journal, null, 2)}\n`);
}
export async function fileReceipts(root: string, directory = root): Promise<FileReceipt[]> {
  const output: FileReceipt[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await fileReceipts(root, file));
    else output.push({ path: path.relative(root, file), sha256: await digestFile(file), executable: Boolean((await fs.lstat(file)).mode & 0o100) });
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

/** A recovery attempt may validate a previous snapshot, but may never overwrite it. */
export async function snapshotCopy(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  const existing = await fs.lstat(target).catch((error) => { if (isMissing(error)) return null; throw error; });
  if (stat.isDirectory()) {
    if (existing && !existing.isDirectory()) throw new Error(`Backup path is not a directory: ${target}`);
    await privateDirectory(target);
    for (const name of await fs.readdir(source)) await snapshotCopy(path.join(source, name), path.join(target, name));
    return;
  }
  if (existing) {
    if (await digestFile(source) !== await digestFile(target)) throw new PersistenceError({ code: "SOURCE_CHANGED_DURING_MIGRATION", path: source, message: "A source file changed after its migration backup was created.", action: "Stop the old installation and review the preserved backup before retrying." });
    return;
  }
  await privateDirectory(path.dirname(target));
  if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(source), target);
  else {
    const temporary = `${target}.${randomUUID()}.snapshot`;
    try {
      await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
      // Only this new copy changes mode; Windows requires a writable handle to flush.
      await fs.chmod(temporary, stat.mode & 0o100 ? 0o700 : 0o600);
      const handle = await fs.open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.link(temporary, target);
      if (process.platform !== "win32") {
        const directory = await fs.open(path.dirname(target), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
export async function sourceText(file: string | undefined): Promise<string | null> { return file ? readOptionalFile(file) : null; }
