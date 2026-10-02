import type { DatabaseSync } from "node:sqlite";

export interface CollectorBackfillProgress {
  stage: "discovering" | "reading" | "uploading" | "attention" | "complete";
  total: number;
  admitted: number;
  skipped: number;
  failed: number;
}

/** Frozen initial session selection; live arrivals never grow this denominator. */
export class CollectorProgress {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS backfills(connection_id TEXT PRIMARY KEY,discovered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS backfill_units(connection_id TEXT NOT NULL,session_key TEXT NOT NULL,state TEXT NOT NULL,error TEXT,PRIMARY KEY(connection_id,session_key));
      CREATE TABLE IF NOT EXISTS backfill_operations(operation_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,session_key TEXT NOT NULL,admitted INTEGER NOT NULL DEFAULT 0);
    `);
  }
  reset(connectionId: string) {
    for (const table of ["backfill_operations", "backfill_units", "backfills"])
      this.database
        .prepare(`DELETE FROM ${table} WHERE connection_id=?`)
        .run(connectionId);
  }
  select(connectionId: string, sessionKey: string) {
    this.database
      .prepare("INSERT OR IGNORE INTO backfills(connection_id) VALUES(?)")
      .run(connectionId);
    const plan = this.database
      .prepare("SELECT discovered FROM backfills WHERE connection_id=?")
      .get(connectionId);
    if (!plan?.discovered)
      this.database
        .prepare(
          "INSERT OR IGNORE INTO backfill_units VALUES(?,?,'reading',NULL)",
        )
        .run(connectionId, sessionKey);
  }
  tracks(connectionId: string, sessionKey: string) {
    const unit = this.database
      .prepare(
        "SELECT state FROM backfill_units WHERE connection_id=? AND session_key=?",
      )
      .get(connectionId, sessionKey);
    return unit?.state === "reading" || unit?.state === "error";
  }
  queued(operationId: string, connectionId: string, sessionKey: string) {
    if (this.tracks(connectionId, sessionKey))
      this.database
        .prepare("INSERT OR IGNORE INTO backfill_operations VALUES(?,?,?,0)")
        .run(operationId, connectionId, sessionKey);
  }
  retained(
    connectionId: string,
    sessionKey: string,
    normalizedSessionKey: string,
  ) {
    if (!this.tracks(connectionId, sessionKey)) return;
    const pending = this.database
      .prepare(
        "SELECT id FROM pending WHERE connection_id=? AND json_extract(payload,'$.sessionKey')=?",
      )
      .all(connectionId, normalizedSessionKey);
    for (const row of pending)
      this.queued(String(row.id), connectionId, sessionKey);
  }
  read(connectionId: string, sessionKey: string, eligible: boolean) {
    if (!this.tracks(connectionId, sessionKey)) return;
    const pending = this.database
      .prepare(
        "SELECT COUNT(*) AS n FROM backfill_operations WHERE connection_id=? AND session_key=? AND admitted=0",
      )
      .get(connectionId, sessionKey);
    this.database
      .prepare(
        "UPDATE backfill_units SET state=?,error=NULL WHERE connection_id=? AND session_key=?",
      )
      .run(
        Number(pending?.n) ? "queued" : eligible ? "complete" : "skipped",
        connectionId,
        sessionKey,
      );
  }
  failed(connectionId: string, sessionKey: string, message: string) {
    if (this.tracks(connectionId, sessionKey))
      this.database
        .prepare(
          "UPDATE backfill_units SET state='error',error=? WHERE connection_id=? AND session_key=?",
        )
        .run(message.slice(0, 500), connectionId, sessionKey);
  }
  discovered(connectionId: string) {
    this.database
      .prepare(
        "INSERT INTO backfills VALUES(?,1) ON CONFLICT(connection_id) DO UPDATE SET discovered=1",
      )
      .run(connectionId);
  }
  acknowledge(operationId: string) {
    const operation = this.database
      .prepare(
        "SELECT connection_id,session_key FROM backfill_operations WHERE operation_id=?",
      )
      .get(operationId);
    if (!operation) return;
    this.database
      .prepare("UPDATE backfill_operations SET admitted=1 WHERE operation_id=?")
      .run(operationId);
    const pending = this.database
      .prepare(
        "SELECT COUNT(*) AS n FROM backfill_operations WHERE connection_id=? AND session_key=? AND admitted=0",
      )
      .get(operation.connection_id!, operation.session_key!);
    if (!Number(pending?.n))
      this.database
        .prepare(
          "UPDATE backfill_units SET state='complete' WHERE connection_id=? AND session_key=? AND state='queued'",
        )
        .run(operation.connection_id!, operation.session_key!);
  }
  status(connectionId: string): CollectorBackfillProgress {
    const plan = this.database
      .prepare("SELECT discovered FROM backfills WHERE connection_id=?")
      .get(connectionId);
    const counts = this.database
      .prepare(
        "SELECT state,COUNT(*) AS n FROM backfill_units WHERE connection_id=? GROUP BY state",
      )
      .all(connectionId);
    const count = (state: string) =>
      Number(counts.find((row) => row.state === state)?.n ?? 0);
    const total = counts.reduce((sum, row) => sum + Number(row.n), 0);
    return {
      stage: !plan?.discovered
        ? "discovering"
        : count("error")
          ? "attention"
          : count("reading")
            ? "reading"
            : count("queued")
              ? "uploading"
              : "complete",
      total,
      admitted: count("complete"),
      skipped: count("skipped"),
      failed: count("error"),
    };
  }
}
