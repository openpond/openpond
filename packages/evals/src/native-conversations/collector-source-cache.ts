import { contentHash } from "@openpond/harness";
import { CollectorCoverageSessionSchema, type CollectorCoverageManifest, type CollectorCoverageSession } from "../connected-evidence/collector-coverage-contracts.js";
import type { CollectorConnection } from "./collector-contracts.js";
import type { CollectorStore } from "./collector-store.js";

/** Reuse a settled source read only for the same revision and event-time window.
 * Admission remains owned by the durable queue and boundary checkpoints. */
export class CollectorSourceCache {
  constructor(private readonly store: CollectorStore) {
    store.database.exec(`CREATE TABLE IF NOT EXISTS source_read_cache(
      connection_id TEXT NOT NULL,session_key TEXT NOT NULL,selection_hash TEXT NOT NULL,value TEXT NOT NULL,
      PRIMARY KEY(connection_id,session_key));`);
  }

  private selection(connection: CollectorConnection, until: string, revision: string) {
    return contentHash([connection.source, connection.projectId, connection.teamId,
      connection.apiBaseUrl, connection.account ?? null, connection.since, connection.selectedSessionKeys ?? null, until, revision]);
  }

  read(connection: CollectorConnection, until: string, sessionKey: string, revision: string) {
    const row = this.store.database.prepare(
      "SELECT value FROM source_read_cache WHERE connection_id=? AND session_key=? AND selection_hash=?",
    ).get(connection.id, sessionKey, this.selection(connection, until, revision));
    return row ? CollectorCoverageSessionSchema.parse(JSON.parse(String(row.value))) : null;
  }

  retain(connection: CollectorConnection, until: string, sessionKey: string, revision: string, raw: CollectorCoverageSession) {
    const value = CollectorCoverageSessionSchema.parse(raw);
    if (value.nativeRevisionHash === null || (value.state !== "admitted"
      && !(value.state === "skipped" && value.reason === "no_eligible_boundaries"))) return;
    this.store.database.prepare(
      "INSERT INTO source_read_cache VALUES(?,?,?,?) ON CONFLICT(connection_id,session_key) DO UPDATE SET selection_hash=excluded.selection_hash,value=excluded.value",
    ).run(connection.id, sessionKey, this.selection(connection, until, revision), JSON.stringify(value));
  }

  /** Earlier collectors retained both scan revisions and settled coverage.
   * Preserve that evidence when upgrading a partially completed import. */
  seed(connection: CollectorConnection, until: string, prior: CollectorCoverageManifest | null) {
    if (!prior || prior.connectionRevision !== connection.revision || prior.from !== connection.since
      || prior.to !== until || prior.sourceInstanceId !== connection.source.instanceId || prior.machineId !== connection.source.machineId) return;
    const byKey = new Map(prior.sessions.map(session => [session.sourceKeyHash, session]));
    for (const row of this.store.database.prepare(
      "SELECT session_key,revision FROM source_scans WHERE connection_id=?",
    ).all(connection.id)) {
      const key = String(row.session_key), value = byKey.get(contentHash(key));
      if (value) this.retain(connection, until, key, String(row.revision), value);
    }
  }
}
