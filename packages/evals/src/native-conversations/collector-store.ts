import { DatabaseSync } from "node:sqlite";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import type {
  CollectorAdmission,
  CollectorConnection,
  CollectorStatus,
} from "./collector-contracts.js";
import { COLLECTOR_DEFAULTS } from "./collector-contracts.js";
import { CollectorProgress } from "./collector-progress.js";

export class CollectorStore {
  readonly progress: CollectorProgress;
  private constructor(readonly database: DatabaseSync) {
    this.progress = new CollectorProgress(database);
  }
  static async open(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const file = join(directory, "collector.sqlite"),
      database = new DatabaseSync(file);
    await chmod(file, 0o600);
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,config TEXT NOT NULL,admitted INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS admitted_boundaries(connection_id TEXT NOT NULL,boundary_id TEXT NOT NULL,PRIMARY KEY(connection_id,boundary_id));
      CREATE TABLE IF NOT EXISTS source_scans(connection_id TEXT NOT NULL,session_key TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(connection_id,session_key));
      CREATE TABLE IF NOT EXISTS checkpoints(connection_id TEXT NOT NULL,session_key TEXT NOT NULL,boundary_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(connection_id,session_key,boundary_id));
      CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO settings VALUES('desiredState','stopped');`);
    return new CollectorStore(database);
  }
  close() {
    this.database.close();
  }
  setting(key: string) {
    const row = this.database
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return typeof row?.value === "string" ? row.value : null;
  }
  set(key: string, value: string) {
    this.database
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  connections(): CollectorConnection[] {
    return this.database
      .prepare("SELECT config FROM connections ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.config)));
  }
  put(connection: CollectorConnection) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.connections().find(
        (item) => item.id === connection.id,
      );
      if (prior && prior.revision > connection.revision) {
        this.database.exec("COMMIT");
        return;
      }
      const identityChanged =
        !!prior &&
        (prior.source.instanceId !== connection.source.instanceId ||
          prior.projectId !== connection.projectId ||
          prior.teamId !== connection.teamId ||
          prior.apiBaseUrl !== connection.apiBaseUrl ||
          prior.account !== connection.account);
      if (prior && (identityChanged || prior.since !== connection.since)) {
        // Scope changes fence queued evidence too: do not upload a wider old
        // selection under newly narrowed consent. Reacquire the approved scope.
        this.progress.reset(connection.id);
        this.database
          .prepare("DELETE FROM settings WHERE key=?")
          .run(`errors:${connection.id}`);
        this.error(connection.id, null);
        for (const table of ["source_scans", "checkpoints", "pending"])
          this.database
            .prepare(`DELETE FROM ${table} WHERE connection_id=?`)
            .run(connection.id);
        if (identityChanged) {
          this.database
            .prepare("DELETE FROM admitted_boundaries WHERE connection_id=?")
            .run(connection.id);
          this.database
            .prepare("UPDATE connections SET admitted=0 WHERE id=?")
            .run(connection.id);
          this.database
            .prepare("DELETE FROM settings WHERE key=?")
            .run(`lastAdmission:${connection.id}`);
        }
      }
      this.database
        .prepare(
          "INSERT INTO connections(id,config) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config",
        )
        .run(connection.id, JSON.stringify(connection));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  error(id: string, message: string | null) {
    this.database
      .prepare("UPDATE connections SET error=? WHERE id=?")
      .run(message?.slice(0, 500) ?? null, id);
  }
  queued(id?: string) {
    return Number(
      (id
        ? this.database
            .prepare("SELECT COUNT(*) AS n FROM pending WHERE connection_id=?")
            .get(id)
        : this.database.prepare("SELECT COUNT(*) AS n FROM pending").get()
      )?.n ?? 0,
    );
  }
  sourceChanged(connectionId: string, sessionKey: string, revision: string) {
    return (
      this.database
        .prepare(
          "SELECT revision FROM source_scans WHERE connection_id=? AND session_key=?",
        )
        .get(connectionId, sessionKey)?.revision !== revision
    );
  }
  scanned(connectionId: string, sessionKey: string, revision: string) {
    this.database
      .prepare(
        "INSERT INTO source_scans VALUES(?,?,?) ON CONFLICT(connection_id,session_key) DO UPDATE SET revision=excluded.revision",
      )
      .run(connectionId, sessionKey, revision);
  }
  changed(
    connectionId: string,
    sessionKey: string,
    boundaryId: string,
    revision: string,
  ) {
    return (
      this.database
        .prepare(
          "SELECT revision FROM checkpoints WHERE connection_id=? AND session_key=? AND boundary_id=?",
        )
        .get(connectionId, sessionKey, boundaryId)?.revision !== revision
    );
  }
  enqueue(
    entry: CollectorAdmission,
    revisions: { id: string; revision: string }[],
    progressSessionKey?: string,
  ) {
    const payload = JSON.stringify(entry),
      bytes = Buffer.byteLength(payload);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const usage = this.database
        .prepare(
          "SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM pending",
        )
        .get()!;
      if (
        Number(usage.count) >= COLLECTOR_DEFAULTS.maxPending ||
        Number(usage.bytes) + bytes > COLLECTOR_DEFAULTS.maxBytes
      )
        throw new Error(
          "Buffer full. Restore connectivity before acquiring more history.",
        );
      this.database
        .prepare(
          "INSERT OR IGNORE INTO pending(id,connection_id,payload,bytes,created_at) VALUES(?,?,?,?,?)",
        )
        .run(entry.operationId, entry.connectionId, payload, bytes, Date.now());
      const update = this.database.prepare(
        "INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(connection_id,session_key,boundary_id) DO UPDATE SET revision=excluded.revision",
      );
      for (const boundary of revisions)
        update.run(
          entry.connectionId,
          entry.sessionKey,
          boundary.id,
          boundary.revision,
        );
      if (progressSessionKey)
        this.progress.queued(
          entry.operationId,
          entry.connectionId,
          progressSessionKey,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  next(connectionId: string) {
    const row = this.database
      .prepare(
        "SELECT payload,attempts FROM pending WHERE connection_id=? AND retry_at <= ? ORDER BY created_at,id LIMIT 1",
      )
      .get(connectionId, Date.now());
    return row
      ? {
          entry: JSON.parse(String(row.payload)) as CollectorAdmission,
          attempts: Number(row.attempts),
        }
      : null;
  }
  acknowledge(entry: CollectorAdmission) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.database
        .prepare("DELETE FROM pending WHERE id=?")
        .run(entry.operationId);
      if (Number(removed.changes) > 0) {
        this.progress.acknowledge(entry.operationId);
        this.set(
          `lastAdmission:${entry.connectionId}`,
          new Date().toISOString(),
        );
        let admitted = 0;
        const insert = this.database.prepare(
          "INSERT OR IGNORE INTO admitted_boundaries VALUES(?,?)",
        );
        for (const id of entry.boundaryIds)
          admitted += Number(insert.run(entry.connectionId, id).changes);
        this.database
          .prepare("UPDATE connections SET admitted=admitted+? WHERE id=?")
          .run(admitted, entry.connectionId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  retry(id: string, attempts: number) {
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempts, 6));
    this.database
      .prepare("UPDATE pending SET attempts=?,retry_at=? WHERE id=?")
      .run(
        attempts + 1,
        Date.now() + delay + Math.floor(Math.random() * Math.max(1, delay / 5)),
        id,
      );
  }
  status(): CollectorStatus {
    const heartbeatAt = this.setting("heartbeatAt"),
      pid = Number(this.setting("pid")) || null;
    let alive = false;
    try {
      if (pid) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {}
    return {
      schemaVersion: 1,
      running:
        alive &&
        !!heartbeatAt &&
        Date.now() - Date.parse(heartbeatAt) < COLLECTOR_DEFAULTS.staleMs,
      desiredState:
        this.setting("desiredState") === "running" ? "running" : "stopped",
      pid,
      heartbeatAt,
      connections: this.database
        .prepare("SELECT id,config,admitted,error FROM connections ORDER BY id")
        .all()
        .map((row) => {
          const config = JSON.parse(String(row.config)) as CollectorConnection;
          return {
            id: String(row.id),
            state: config.state,
            projectId: config.projectId,
            source: config.source.source,
            queued: this.queued(String(row.id)),
            admitted: Number(row.admitted),
            error: typeof row.error === "string" ? row.error : null,
            backfill: this.progress.status(String(row.id)),
            pendingBytes: Number(
              this.database
                .prepare(
                  "SELECT COALESCE(SUM(bytes),0) AS bytes FROM pending WHERE connection_id=?",
                )
                .get(String(row.id))?.bytes ?? 0,
            ),
            lastAdmissionAt: this.setting(`lastAdmission:${row.id}`),
          };
        }),
    };
  }
}
