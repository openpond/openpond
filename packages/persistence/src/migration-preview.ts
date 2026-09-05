import { randomUUID } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig } from "./config.js";
import { storagePaths } from "./home.js";
import { openStorageDatabase } from "./database.js";
import { diffConfig } from "./toml-edit.js";
import { persistenceIssue } from "./errors.js";
import type { MigrationJournal } from "./migration-files.js";
import type { MigrationOptions } from "./migration-sources.js";

/** Builds the same candidate as commit, exclusively in a private disposable home. */
export async function previewMigration(home: string, sources: MigrationOptions, prepare: (journal: MigrationJournal) => Promise<void>) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-migration-preview-"));
  const id = `migration-preview-${randomUUID()}`;
  const journal: MigrationJournal = { schemaVersion: "openpond.migration.v1", id, status: "preparing", home: temporary,
    stage: path.join(path.dirname(temporary), `.${path.basename(temporary)}-${id}`), backup: path.join(temporary, "backups", id),
    files: [], installed: [], createdAt: new Date().toISOString(), sourceAppHome: sources.sourceAppHome, sourceConfig: sources.sourceConfig, sourceBrowserState: sources.sourceBrowserState };
  try {
    try { await prepare(journal); }
    catch (error) { return { issues: [persistenceIssue(error, home)], counts: {}, destinations: [], conflicts: [], estimatedBytes: null, credentialRecords: null }; }
    const imported = await readConfig(journal.stage), current = existsSync(storagePaths(home).config) ? await readConfig(home) : null;
    const conflicts = current ? diffConfig(current.document, imported.document).map((entry) => ({ path: entry.path, choices: ["imported", "existing"] as const })) : [];
    const destinations = diffConfig({ schema_version: 1 }, imported.document).map((entry) => ({ path: entry.path, destination: "config.toml", operation: entry.op }));
    const counts: Record<string, number> = {};
    const database = storagePaths(journal.stage).database;
    if (existsSync(database)) {
      const db = openStorageDatabase(database, true);
      try {
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
          counts[row.name] = Number((db.prepare(`SELECT count(*) AS count FROM "${row.name.replaceAll('"', '""')}"`).get() as { count: number }).count);
        }
      } finally { db.close(); }
    }
    let estimatedBytes = 0;
    for (const entry of journal.files) estimatedBytes += (await fs.lstat(path.join(journal.stage, entry.path))).size;
    const credentialRecords = Object.values(imported.document.accounts ?? {}).filter((account) => account.credential?.source === "secret").length + Object.values(imported.document.providers ?? {}).filter((provider) => provider.credential?.source === "secret").length;
    return { issues: [], counts, destinations, conflicts, estimatedBytes, credentialRecords, layoutVersion: 1, configSchemaVersion: imported.document.schema_version };
  } finally { await fs.rm(journal.stage, { recursive: true, force: true }); await fs.rm(temporary, { recursive: true, force: true }); }
}
