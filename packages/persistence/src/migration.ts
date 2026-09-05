import { previewMigration } from "./migration-preview.js";
import { resolveMigrationTarget } from "./migration-conflicts.js";
import { assertStorageAncestors } from "./path-safety.js";
import { importBrowserMetadataOnce } from "./browser-migration.js";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { storagePaths } from "./home.js";
import { atomicWriteFile, readOptionalFile, readJsonFile, withFileLock, privateDirectory } from "./private-file.js";
import { openStorageDatabase } from "./database.js";
import { readConfig } from "./config.js";
import { readAccountConfiguration } from "./accounts.js";
import { readCredential } from "./credentials.js";
import { importAccountConfig, importPreferenceRecords, importProviderConfig, importPersonalization, importDatasetPreference, migrationConflict } from "./migration-values.js";
import { PersistenceError } from "./errors.js";
import { discoverMigrationSources, assertMigrationSourcesStopped, type MigrationOptions } from "./migration-sources.js";
import { readMigrationJournal, saveMigrationJournal, digestFile, fileReceipts, snapshotCopy, STORAGE_LAYOUT, type MigrationJournal } from "./migration-files.js";
import { importAdditionalDomains } from "./migration-domains.js";
export type { MigrationOptions } from "./migration-sources.js";
export { readMigrationJournal } from "./migration-files.js";
export type MigrationReport = { id: string | null; status: "current" | "new" | "planned" | "verified"; home: string; sourceAppHome: string | null; sourceConfig: string | null; backup: string | null; issues?: unknown[]; sourceCandidates?: unknown; preview?: Awaited<ReturnType<typeof previewMigration>> };
const retiredFiles = new Set(["config.json", "providers.json", "provider-secrets.json", "provider-secrets.key", "personalization.json", "SOUL.md", "token", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]);
const ignoredDirectories = new Set(["cache", "logs", "diagnostics", "backups", "runtime"]);

export async function initializeHome(home: string, options: MigrationOptions = {}): Promise<MigrationReport> {
  home = path.resolve(home);
  assertStorageAncestors(home);
  const marker = await readJsonFile<Record<string, unknown> | null>(storagePaths(home).marker, () => null);
  const pending = await readMigrationJournal(home);
  if (marker) {
    assertLayout(marker, home);
    if (!pending || pending.status === "verified") {
      if (options.sourceBrowserState && !options.dryRun) await importBrowserMetadataOnce(home, options.sourceBrowserState);
      return report(home, "current", pending);
    }
  }
  if (pending && !options.dryRun) return recoverMigration(home);
  const discovered = await discoverMigrationSources(home, options);
  const { issues, sourceCandidates, ...sources } = discovered;
  if (options.dryRun) return { ...report(home, "planned", null), sourceAppHome: sources.sourceAppHome ?? null, sourceConfig: sources.sourceConfig ?? null, issues, sourceCandidates, ...(issues.length ? {} : { preview: await previewMigration(home, sources, prepare) }) };
  if (issues.length) throw migrationConflict(home, issues.map((issue) => issue.message).join(" "));
  return withFileLock(path.join(storagePaths(home).runtime, "migration-owner"), async () => {
    const recheck = await readJsonFile<Record<string, unknown> | null>(storagePaths(home).marker, () => null);
    if (recheck) { assertLayout(recheck, home); return report(home, "current", null); }
    const raced = await readMigrationJournal(home);
    if (raced) return recoverUnlocked(raced);
    if (!sources.sourceAppHome && !sources.sourceConfig && !sources.sourceBrowserState) {
      await privateDirectory(home);
      await readConfig(home);
      await atomicWriteFile(storagePaths(home).marker, `${JSON.stringify({ ...STORAGE_LAYOUT, migrationId: null }, null, 2)}\n`);
      return report(home, "new", null);
    }
    await assertMigrationSourcesStopped(sources.sourceAppHome, sources.sourceConfig);
    const id = `migration-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const journal: MigrationJournal = { schemaVersion: "openpond.migration.v1", id, status: "preparing", home,
      stage: path.join(path.dirname(home), `.${path.basename(home)}-${id}`), backup: path.join(home, "backups", id),
      files: [], installed: [], ...sources, resolutions: options.resolutions, createdAt: new Date().toISOString() };
    await saveMigrationJournal(journal);
    return recoverUnlocked(journal);
  });
}
function assertLayout(marker: Record<string, unknown>, home: string) {
  if (marker.version !== 1 || marker.schemaVersion !== STORAGE_LAYOUT.schemaVersion) throw new PersistenceError({ code: "UNSUPPORTED_STORAGE_VERSION", path: storagePaths(home).marker, message: "This OpenPond home requires a different application version.", action: "Update OpenPond, or restore a compatible backup into a separate home." });
}
async function captureSources(journal: MigrationJournal): Promise<void> {
  if (journal.snapshotComplete) return;
  await assertMigrationSourcesStopped(journal.sourceAppHome, journal.sourceConfig);
  await privateDirectory(journal.backup);
  if (journal.sourceConfig) {
    await snapshotCopy(journal.sourceConfig, path.join(journal.backup, "config.json"));
    for (const name of ["extensions", "profiles"]) {
      const source = path.join(path.dirname(journal.sourceConfig), name);
      if (existsSync(source)) await snapshotCopy(source, path.join(journal.backup, "global", name));
    }
  }
  if (journal.sourceBrowserState) await snapshotCopy(journal.sourceBrowserState, path.join(journal.backup, "browser-sidebar-state.json"));
  if (journal.sourceAppHome) {
    for (const entry of await fs.readdir(journal.sourceAppHome, { withFileTypes: true })) {
      if (["openpond-app", "openpond-app-nightly", "storage.json", "config.toml", "state", "browser"].includes(entry.name) || ignoredDirectories.has(entry.name) || entry.name.startsWith("state.sqlite")) continue;
      await snapshotCopy(path.join(journal.sourceAppHome, entry.name), path.join(journal.backup, "app", entry.name));
    }
    const originalDb = path.join(journal.sourceAppHome, "state.sqlite"), target = path.join(journal.backup, "state.sqlite");
    if (existsSync(originalDb) && !existsSync(target)) {
      const temporary = `${target}.${randomUUID()}.tmp`, db = openStorageDatabase(originalDb, true);
      try {
        await backup(db, temporary);
        const file = await fs.open(temporary, "r"); try { await file.sync(); } finally { await file.close(); }
        await fs.rename(temporary, target);
        if (process.platform !== "win32") { const directory = await fs.open(path.dirname(target), "r"); try { await directory.sync(); } finally { await directory.close(); } }
      }
      finally { db.close(); await fs.rm(temporary, { force: true }); }
    }
  }
  await assertMigrationSourcesStopped(journal.sourceAppHome, journal.sourceConfig);
  journal.snapshotComplete = true;
  await saveMigrationJournal(journal);
}
async function prepare(journal: MigrationJournal): Promise<void> {
  await captureSources(journal);
  await privateDirectory(journal.stage);
  const app = path.join(journal.backup, "app");
  if (existsSync(app)) for (const name of await fs.readdir(app)) {
    if (retiredFiles.has(name) || name === "souls" || /^soul-.+\.md$/i.test(name)) continue;
    const destination = ["harnesses", "refiners"].includes(name) ? path.join("library", name) : name;
    await snapshotCopy(path.join(app, name), path.join(journal.stage, destination));
  }
  if (existsSync(path.join(journal.backup, "state.sqlite"))) await snapshotCopy(path.join(journal.backup, "state.sqlite"), storagePaths(journal.stage).database);
  await importAccountConfig(journal.stage, journal.sourceConfig ? path.join(journal.backup, "config.json") : undefined);
  await importPreferenceRecords(journal.stage, journal.sourceAppHome);
  await importProviderConfig(journal.stage, journal.sourceAppHome ? app : undefined);
  await importPersonalization(journal.stage, journal.sourceAppHome ? app : undefined);
  await importDatasetPreference(journal.stage, journal.sourceAppHome ? app : undefined);
  const token = await readOptionalFile(path.join(app, "token"));
  if (token) await atomicWriteFile(storagePaths(journal.stage).token, token);
  await importAdditionalDomains(journal);
  if (existsSync(storagePaths(journal.home).config)) {
    await resolveMigrationTarget(journal.home, journal.stage, journal.resolutions);
  }
  await validateMigratedHome(journal.stage);
  await fs.rm(path.join(journal.stage, "runtime"), { recursive: true, force: true });
  await fs.rm(path.join(journal.stage, "backups"), { recursive: true, force: true });
  await fs.rm(path.join(journal.stage, "datasets", "settings.json"), { force: true });
  journal.files = (await fileReceipts(journal.stage)).filter((entry) => !entry.path.endsWith("-wal") && !entry.path.endsWith("-shm"));
  journal.status = "prepared";
  await saveMigrationJournal(journal);
}
export async function validateMigratedHome(home: string): Promise<void> {
  const { document } = await readConfig(home);
  await readAccountConfiguration(home);
  for (const provider of Object.values(document.providers ?? {})) if (provider.credential?.source === "secret" && !await readCredential(home, provider.credential.id)) throw migrationConflict(storagePaths(home).config, "An imported provider credential is missing.");
  if (existsSync(storagePaths(home).database)) {
    const db = openStorageDatabase(storagePaths(home).database);
    try {
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw migrationConflict(storagePaths(home).database, "The imported database failed integrity checks.");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
  }
}
async function install(journal: MigrationJournal): Promise<void> {
  journal.status = "installing";
  await saveMigrationJournal(journal);
  for (const file of journal.files) {
    const target = path.join(journal.home, file.path), source = path.join(journal.stage, file.path);
    const installedDigest = existsSync(target) ? await digestFile(target) : null;
    if (journal.installed.includes(file.path) && installedDigest !== file.sha256) throw migrationConflict(target, "An installed file changed before migration recovery completed.");
    if (installedDigest !== file.sha256) {
      if (await digestFile(source) !== file.sha256) throw migrationConflict(source, "A staged file failed its checksum check.");
      if (installedDigest !== null) await snapshotCopy(target, path.join(journal.backup, "destination", file.path));
      await privateDirectory(path.dirname(target));
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) {
        if (existsSync(target)) await fs.unlink(target);
        await fs.symlink(await fs.readlink(source), target);
      } else {
        const temporary = `${target}.${randomUUID()}.migration`;
        try {
          await fs.copyFile(source, temporary);
          const handle = await fs.open(temporary, "r+");
          try { await handle.sync(); } finally { await handle.close(); }
          if (process.platform !== "win32") await fs.chmod(temporary, file.executable ? 0o700 : 0o600);
          await fs.rename(temporary, target);
        } finally { await fs.rm(temporary, { force: true }); }
      }
    }
    if (process.platform !== "win32") { const directory = await fs.open(path.dirname(target), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    if (!journal.installed.includes(file.path)) journal.installed.push(file.path);
    await saveMigrationJournal(journal);
  }
  await validateMigratedHome(journal.home);
  await atomicWriteFile(storagePaths(journal.home).marker, `${JSON.stringify({ ...STORAGE_LAYOUT, migrationId: journal.id }, null, 2)}\n`);
  journal.status = "committed";
  await saveMigrationJournal(journal);
  journal.status = "verified";
  delete journal.error;
  await saveMigrationJournal(journal);
  await fs.rm(journal.stage, { recursive: true, force: true });
}
export async function recoverMigration(home: string): Promise<MigrationReport> {
  return withFileLock(path.join(storagePaths(home).runtime, "migration-owner"), async () => {
    const journal = await readMigrationJournal(home);
    if (!journal) throw migrationConflict(home, "No migration journal is available.");
    return recoverUnlocked(journal);
  });
}
async function recoverUnlocked(journal: MigrationJournal): Promise<MigrationReport> {
  if (journal.status === "verified") return report(journal.home, "current", journal);
  try {
    if (journal.status === "preparing" || journal.status === "failed") {
      await fs.rm(journal.stage, { recursive: true, force: true });
      journal.status = "preparing";
      await prepare(journal);
    }
    if (journal.status !== "committed") await install(journal);
    else { await validateMigratedHome(journal.home); journal.status = "verified"; await saveMigrationJournal(journal); await fs.rm(journal.stage, { recursive: true, force: true }); }
    return report(journal.home, "verified", journal);
  } catch (error) {
    journal.error = error instanceof PersistenceError ? error.issue.code : "MIGRATION_FAILED";
    if (journal.status === "preparing") journal.status = "failed";
    await saveMigrationJournal(journal);
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError({ code: "MIGRATION_FAILED", path: path.join(storagePaths(journal.home).runtime, "migration.json"), message: "OpenPond could not finish updating its storage.", action: "Open migration details or run openpond config recover. Original data and snapshots have been preserved." }, { cause: error });
  }
}
function report(home: string, status: MigrationReport["status"], journal: MigrationJournal | null): MigrationReport { return { id: journal?.id ?? null, status, home, sourceAppHome: journal?.sourceAppHome ?? null, sourceConfig: journal?.sourceConfig ?? null, backup: journal?.backup ?? null }; }

/** Discard only a failed preparation, retaining its immutable source backup for review. */
export async function restartMigration(home: string): Promise<{ restarted: boolean; backup: string | null }> {
  return withFileLock(path.join(storagePaths(home).runtime, "migration-owner"), async () => {
    const journal = await readMigrationJournal(home);
    if (!journal) return { restarted: false, backup: null };
    if (!["preparing", "failed"].includes(journal.status) || journal.installed.length || journal.files.length) throw migrationConflict(home, "Installation has already begun. Resume recovery or restore into a fresh home; preparation cannot be restarted.");
    await assertMigrationSourcesStopped(journal.sourceAppHome, journal.sourceConfig);
    await atomicWriteFile(path.join(journal.backup, "abandoned-preparation.json"), JSON.stringify(journal, null, 2));
    await fs.rm(journal.stage, { recursive: true, force: true });
    await fs.rm(path.join(storagePaths(home).runtime, "migration.json"));
    return { restarted: true, backup: journal.backup };
  });
}
