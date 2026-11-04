import { canonicalJson, verifyModificationRecordingRead, type ModificationRecording, type ModificationRecordingListQuery } from "openpond-sdk/training";
import { SqliteStoreDomain } from "./store-domain.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

type Scope = { teamId: string; actorId: string; accountScopeHash: string };
type Row = { metadata: string; document: string; command_hash: string };
const schema = `CREATE TABLE IF NOT EXISTS model_modification_recordings (
 account_scope_hash TEXT NOT NULL, team_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 id TEXT NOT NULL, operation_id TEXT NOT NULL, command_hash TEXT NOT NULL, project_id TEXT,
 metadata TEXT NOT NULL, document TEXT NOT NULL,
 PRIMARY KEY(account_scope_hash,id), UNIQUE(account_scope_hash,operation_id)
); CREATE INDEX IF NOT EXISTS modification_recording_scope_project ON model_modification_recordings(account_scope_hash,project_id,id);`;

/** Immutable observations share the existing SQLite connection/write queue.
 * They carry no execution lease, funding hold or provider billing authority. */
export class SqliteModificationRecordingStore extends SqliteStoreDomain {
  private initialized = false;
  private async access<T>(apply: (db: OpenPondSqliteConnection) => T): Promise<T> {
    await this.ready;
    const next = this.writeQueue.then(() => {
      const db = this.database;
      if (!this.initialized) { db.exec(schema); this.initialized = true; }
      db.exec("BEGIN IMMEDIATE");
      try { const result = apply(db); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = next.then(() => {}, () => {});
    return next;
  }
  async retainModificationRecording(scope: Scope, raw: Parameters<typeof verifyModificationRecordingRead>[0]) {
    const value = await verifyModificationRecordingRead(raw, scope.teamId, scope.actorId), record = value.recording;
    if (record.accountScopeHash !== scope.accountScopeHash) throw new Error("modification_recording_scope_mismatch");
    const retained = await this.access(db => {
      const old = db.get<Row>("SELECT metadata,document,command_hash FROM model_modification_recordings WHERE account_scope_hash=? AND operation_id=?", [scope.accountScopeHash, record.operationId]);
      if (old) {
        if (old.command_hash !== record.commandHash) throw new Error("modification_recording_operation_conflict");
        return { recording: JSON.parse(old.metadata) as ModificationRecording, document: JSON.parse(old.document) as typeof value.document };
      }
      db.run("INSERT INTO model_modification_recordings(account_scope_hash,team_id,actor_id,id,operation_id,command_hash,project_id,metadata,document) VALUES(?,?,?,?,?,?,?,?,?)",
        [scope.accountScopeHash, scope.teamId, scope.actorId, record.id, record.operationId, record.commandHash, record.projectId, canonicalJson(record), canonicalJson(value.document)]);
      return value;
    });
    const verified = await verifyModificationRecordingRead(retained, scope.teamId, scope.actorId);
    if (verified.recording.accountScopeHash !== scope.accountScopeHash || verified.recording.commandHash !== record.commandHash
        || verified.recording.id !== record.id) throw new Error("modification_recording_scope_corrupt");
    return verified;
  }
  async readModificationRecording(scope: Scope, id: string) {
    const row = await this.access(db => db.get<Row>("SELECT metadata,document,command_hash FROM model_modification_recordings WHERE account_scope_hash=? AND team_id=? AND actor_id=? AND id=?",
      [scope.accountScopeHash, scope.teamId, scope.actorId, id]));
    if (!row) return null;
    const value = await verifyModificationRecordingRead({ recording: JSON.parse(row.metadata), document: JSON.parse(row.document) }, scope.teamId, scope.actorId);
    if (value.recording.accountScopeHash !== scope.accountScopeHash || value.recording.id !== id || value.recording.commandHash !== row.command_hash)
      throw new Error("modification_recording_scope_corrupt");
    return value;
  }
  async listModificationRecordings(scope: Scope, query: Omit<ModificationRecordingListQuery, "teamId" | "cursor"> & { afterId?: string }) {
    return this.access(db => {
      const rows = db.all<{ metadata: string }>(`SELECT metadata FROM model_modification_recordings WHERE account_scope_hash=? AND team_id=? AND actor_id=?
        ${query.projectId ? "AND project_id=?" : ""} ${query.search ? "AND instr(lower(json_extract(metadata,'$.name')),lower(?))>0" : ""}
        ${query.afterId ? "AND id>?" : ""} ORDER BY id LIMIT ?`,
        [scope.accountScopeHash, scope.teamId, scope.actorId, ...(query.projectId ? [query.projectId] : []), ...(query.search ? [query.search] : []), ...(query.afterId ? [query.afterId] : []), (query.limit ?? 30) + 1]);
      return { items: rows.slice(0, query.limit ?? 30).map(row => JSON.parse(row.metadata) as ModificationRecording), hasMore: rows.length > (query.limit ?? 30) };
    });
  }
}
