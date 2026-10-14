import { createHash } from "node:crypto";
import { LocalDatasetRecordSchema, type LocalDatasetRecord } from "@openpond/contracts";
import { validateTasksetDraftWorkspace, type TasksetDraftWorkspace, type TasksetDraftWorkspaceFile } from "openpond-sdk/taskset-drafts";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { CHAT_RESOURCE_TABLES_SQL } from "./store-chat-resource-schema.js";

type StoredFile = Omit<TasksetDraftWorkspaceFile, "base64">;
type StoredWorkspace = Omit<TasksetDraftWorkspace, "files"> & { files: StoredFile[] };
type StoredSync = Omit<NonNullable<LocalDatasetRecord["sync"]>, "pendingWorkspace"> & { pendingWorkspace: StoredWorkspace | null };
type StoredRecord = Omit<LocalDatasetRecord, "workspace" | "sync"> & { workspace: StoredWorkspace; sync: StoredSync | null };

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Call within the owner's write transaction. Backup/export remains self-contained in SQLite. */
export function retainLocalDatasetRecord(db: OpenPondSqliteConnection, record: LocalDatasetRecord): string {
  const retainWorkspace = (workspace: TasksetDraftWorkspace): StoredWorkspace => ({
    ...workspace,
    files: workspace.files.map(({ base64, ...file }) => {
      const prior = db.get<{ size_bytes: number }>("SELECT size_bytes FROM local_dataset_blobs WHERE content_hash=?", [file.contentHash]);
      if (prior) {
        if (prior.size_bytes !== file.sizeBytes) throw new Error("Dataset file hash has conflicting sizes.");
      } else {
        const bytes = Buffer.from(base64, "base64");
        if (bytes.length !== file.sizeBytes || bytes.toString("base64") !== base64 || digest(bytes) !== file.contentHash)
          throw new Error("Dataset file differs from its retained bytes.");
        db.run("INSERT INTO local_dataset_blobs(content_hash,size_bytes,bytes) VALUES(?,?,?)", [file.contentHash, file.sizeBytes, bytes]);
      }
      return file;
    }),
  });
  const stored: StoredRecord = {
    ...record,
    workspace: retainWorkspace(record.workspace),
    sync: record.sync ? { ...record.sync, pendingWorkspace: record.sync.pendingWorkspace ? retainWorkspace(record.sync.pendingWorkspace) : null } : null,
  };
  const payload = JSON.stringify(stored);
  const hash = digest(payload);
  db.run("INSERT INTO local_dataset_records(record_hash,payload) VALUES(?,?) ON CONFLICT(record_hash) DO NOTHING", [hash, payload]);
  return hash;
}

export function hydrateLocalDatasetFile(db: OpenPondSqliteConnection, file: StoredFile): TasksetDraftWorkspaceFile {
  const row = db.get<{ size_bytes: number; bytes: Uint8Array }>("SELECT size_bytes,bytes FROM local_dataset_blobs WHERE content_hash=?", [file.contentHash]);
  if (!row || row.size_bytes !== file.sizeBytes || row.bytes.byteLength !== file.sizeBytes || digest(row.bytes) !== file.contentHash)
    throw new Error("A retained Dataset file is missing or failed its checksum.");
  return { ...file, base64: Buffer.from(row.bytes).toString("base64") };
}

function hydrateWorkspace(db: OpenPondSqliteConnection, workspace: StoredWorkspace): TasksetDraftWorkspace {
  return { ...workspace, files: workspace.files.map(file => hydrateLocalDatasetFile(db, file)) };
}

/** Listings/projections omit the main file set; pending sync receipts must still round-trip. */
export function hydrateLocalDatasetMetadata(db: OpenPondSqliteConnection, payload: string): Omit<StoredRecord, "sync"> & { sync: LocalDatasetRecord["sync"] } {
  const stored = JSON.parse(payload) as StoredRecord;
  return { ...stored, sync: stored.sync ? { ...stored.sync, pendingWorkspace: stored.sync.pendingWorkspace ? hydrateWorkspace(db, stored.sync.pendingWorkspace) : null } : null };
}

export function hydrateLocalDatasetRecord(db: OpenPondSqliteConnection, payload: string): LocalDatasetRecord {
  const stored = hydrateLocalDatasetMetadata(db, payload);
  return LocalDatasetRecordSchema.parse({ ...stored, workspace: hydrateWorkspace(db, stored.workspace) });
}

/** The schema migration owns the transaction: any invalid historical bytes roll everything back. */
export function migrateLocalDatasetStorage(db: OpenPondSqliteConnection): boolean {
  const columns = db.all<{ name: string }>("PRAGMA table_info(local_dataset_workspaces)");
  if (!columns.some(column => column.name === "payload")) {
    db.exec(CHAT_RESOURCE_TABLES_SQL);
    return false;
  }
  const tables = ["local_dataset_workspaces", "local_dataset_versions", "local_dataset_operations"] as const;
  for (const table of tables) db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy_payload`);
  db.exec(CHAT_RESOURCE_TABLES_SQL);
  const retained = new Map<string, string>();
  for (const table of tables) {
    let lastRow = 0;
    for (;;) {
      const row = db.get<{ legacy_row: number; id: string; revision: number; updated_at: string; operation_id: string; request_hash: string; payload: string }>(
        `SELECT rowid AS legacy_row,* FROM ${table}_legacy_payload WHERE rowid>? ORDER BY rowid LIMIT 1`, [lastRow]);
      if (!row) break;
      const originalHash = digest(row.payload);
      let hash = retained.get(originalHash);
      if (!hash) {
        const record = LocalDatasetRecordSchema.parse(JSON.parse(row.payload));
        validateTasksetDraftWorkspace(record.workspace, Number.POSITIVE_INFINITY);
        if (record.sync?.pendingWorkspace) validateTasksetDraftWorkspace(record.sync.pendingWorkspace, Number.POSITIVE_INFINITY);
        hash = retainLocalDatasetRecord(db, record);
        retained.set(originalHash, hash);
      }
      if (table === "local_dataset_workspaces")
        db.run(`INSERT INTO ${table}(id,revision,record_hash,updated_at) VALUES(?,?,?,?)`, [row.id, row.revision, hash, row.updated_at]);
      else if (table === "local_dataset_versions")
        db.run(`INSERT INTO ${table}(id,revision,record_hash) VALUES(?,?,?)`, [row.id, row.revision, hash]);
      else db.run(`INSERT INTO ${table}(operation_id,request_hash,record_hash) VALUES(?,?,?)`, [row.operation_id, row.request_hash, hash]);
      lastRow = row.legacy_row;
    }
    db.exec(`DROP TABLE ${table}_legacy_payload`);
  }
  return true;
}
