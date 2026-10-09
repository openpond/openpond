import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { contentHash } from "@openpond/harness";
import type { CollectorAdmission } from "./collector-contracts.js";

export class CollectorQueueFullError extends Error {
  constructor() { super("Import queue is full. Pending uploads must finish before more history can be read."); }
}

/** Batches reference an immutable source snapshot instead of duplicating the
 * whole transcript once for every twenty selected turns. */
export class CollectorSnapshots {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS collector_snapshots(hash TEXT PRIMARY KEY,payload TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_snapshots(operation_id TEXT PRIMARY KEY,snapshot_hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_snapshots_hash ON pending_snapshots(snapshot_hash);
    `);
  }
  prepare(files: CollectorAdmission["files"]) {
    const payload = JSON.stringify(files);
    return { hash: contentHash(files), payload, bytes: Buffer.byteLength(payload) };
  }
  exists(hash: string) {
    return !!this.database.prepare("SELECT 1 FROM collector_snapshots WHERE hash=?").get(hash);
  }
  retain(id: string, snapshot: ReturnType<CollectorSnapshots["prepare"]>) {
    this.database.prepare("INSERT OR IGNORE INTO collector_snapshots VALUES(?,?,?)").run(snapshot.hash, snapshot.payload, snapshot.bytes);
    this.database.prepare("INSERT OR REPLACE INTO pending_snapshots VALUES(?,?)").run(id, snapshot.hash);
  }
  files(id: string): CollectorAdmission["files"] {
    const row = this.database.prepare("SELECT payload FROM collector_snapshots JOIN pending_snapshots ON hash=snapshot_hash WHERE operation_id=?").get(id);
    if (!row) throw new Error("The pending import's source snapshot is missing.");
    return JSON.parse(String(row.payload));
  }
  bytes(connectionId?: string) {
    return Number(connectionId
      ? this.database.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM collector_snapshots WHERE hash IN (SELECT snapshot_hash FROM pending_snapshots JOIN pending ON operation_id=pending.id WHERE connection_id=?)").get(connectionId)?.n
      : this.database.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM collector_snapshots").get()?.n);
  }
  collect() {
    this.database.exec(`DELETE FROM pending_snapshots WHERE operation_id NOT IN (SELECT id FROM pending);
      DELETE FROM collector_snapshots WHERE hash NOT IN (SELECT snapshot_hash FROM pending_snapshots);`);
  }
  /** Upgrade retained queues only in the owned worker, never in a status read.
   * Each operation commits independently so interruption preserves all work. */
  async migrate(cancelled: () => boolean) {
    const ids = this.database.prepare("SELECT id FROM pending WHERE id NOT IN (SELECT operation_id FROM pending_snapshots)").all();
    for (const row of ids) {
      await setImmediate();
      if (cancelled()) return;
      const stored = this.database.prepare("SELECT payload FROM pending WHERE id=?").get(row.id!);
      if (!stored) continue;
      const { files, ...entry } = JSON.parse(String(stored.payload)) as CollectorAdmission;
      const snapshot = this.prepare(files), payload = JSON.stringify(entry);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.retain(String(row.id), snapshot);
        this.database.prepare("UPDATE pending SET payload=?,bytes=? WHERE id=?").run(payload, Buffer.byteLength(payload), row.id!);
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
    this.collect();
  }
}
