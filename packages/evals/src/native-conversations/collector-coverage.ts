import { contentHash } from "@openpond/harness";
import {
  CollectorCoverageManifestSchema,
  CollectorCoverageSessionSchema,
  summarizeCollectorCoverage,
  type CollectorCoverageManifest,
  type CollectorCoverageSession,
} from "../connected-evidence/collector-coverage-contracts.js";
import type { CollectorConnection } from "./collector-contracts.js";
import type { CollectorStore } from "./collector-store.js";

/** Retains the latest acquisition inventory independently of queue receipts.
 * Native paths are hashed; this authority never stores transcript bytes. */
export class CollectorCoverage {
  constructor(private readonly store: CollectorStore) {
    store.database.exec(`CREATE TABLE IF NOT EXISTS coverage_sessions(
      connection_id TEXT NOT NULL,source_key_hash TEXT NOT NULL,value TEXT NOT NULL,
      PRIMARY KEY(connection_id,source_key_hash));`);
  }
  begin(
    connection: CollectorConnection,
    jobId: string,
    startedAt: string,
    to: string,
  ) {
    const manifest = CollectorCoverageManifestSchema.parse({
      schemaVersion: "openpond.collectorCoverageManifest.v1",
      jobId,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      machineId: connection.source.machineId,
      sourceInstanceId: connection.source.instanceId,
      from: connection.since,
      to,
      startedAt,
      finishedAt: null,
      listingComplete: false,
      pendingOperations: this.store.queued(connection.id),
      sessions: [],
    });
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      this.store.database
        .prepare("DELETE FROM coverage_sessions WHERE connection_id=?")
        .run(connection.id);
      this.store.set(`coverage:${connection.id}`, JSON.stringify(manifest));
      this.store.database.exec("COMMIT");
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }
  record(connectionId: string, session: CollectorCoverageSession) {
    const value = CollectorCoverageSessionSchema.parse(session);
    const serialized = JSON.stringify(value);
    const prior = this.store.database
      .prepare(
        "SELECT COALESCE(SUM(length(value)),0) AS bytes FROM coverage_sessions WHERE connection_id=? AND source_key_hash!=?",
      )
      .get(connectionId, value.sourceKeyHash);
    const boundaryUsage = this.store.database
      .prepare(
        "SELECT COALESCE(SUM(json_array_length(n.value,'$.boundaries')),0) AS n FROM coverage_sessions c,json_each(c.value,'$.normalized') n WHERE c.connection_id=? AND c.source_key_hash!=?",
      )
      .get(connectionId, value.sourceKeyHash);
    if (
      Buffer.byteLength(serialized) + Number(prior?.bytes ?? 0) >
        8 * 1024 * 1024 ||
      value.normalized.reduce((sum, item) => sum + item.boundaries.length, 0) +
        Number(boundaryUsage?.n ?? 0) >
        20_000
    )
      throw new Error(
        "Source coverage exceeds its bounded inventory. Select a narrower import window.",
      );
    const count = Number(
      this.store.database
        .prepare(
          "SELECT COUNT(*) AS n FROM coverage_sessions WHERE connection_id=?",
        )
        .get(connectionId)?.n ?? 0,
    );
    const exists = this.store.database
      .prepare(
        "SELECT 1 FROM coverage_sessions WHERE connection_id=? AND source_key_hash=?",
      )
      .get(connectionId, value.sourceKeyHash);
    if (!exists && count >= 10_000)
      throw new Error(
        "Source inventory exceeds 10,000 sessions. Select a narrower import window.",
      );
    this.store.database
      .prepare(
        "INSERT INTO coverage_sessions VALUES(?,?,?) ON CONFLICT(connection_id,source_key_hash) DO UPDATE SET value=excluded.value",
      )
      .run(connectionId, value.sourceKeyHash, serialized);
  }
  manifest(connectionId: string): CollectorCoverageManifest | null {
    const raw = this.store.setting(`coverage:${connectionId}`);
    if (!raw) return null;
    const sessions = this.store.database
      .prepare(
        "SELECT value FROM coverage_sessions WHERE connection_id=? ORDER BY source_key_hash",
      )
      .all(connectionId)
      .map((row) =>
        CollectorCoverageSessionSchema.parse(JSON.parse(String(row.value))),
      );
    return CollectorCoverageManifestSchema.parse({
      ...JSON.parse(raw),
      pendingOperations: this.store.queued(connectionId),
      sessions,
    });
  }
  finish(connectionId: string, listingComplete: boolean) {
    const manifest = this.manifest(connectionId);
    if (!manifest) throw new Error("Source coverage was not initialized.");
    manifest.listingComplete ||= listingComplete;
    manifest.finishedAt ??= new Date().toISOString();
    const { sessions: _sessions, ...metadata } =
      CollectorCoverageManifestSchema.parse(manifest);
    this.store.set(
      `coverage:${connectionId}`,
      JSON.stringify({ ...metadata, sessions: [] }),
    );
    return manifest;
  }
  summary(connectionId: string) {
    const manifest = this.manifest(connectionId);
    return manifest ? summarizeCollectorCoverage(manifest) : null;
  }
  static sourceKey(scanKey: string) {
    return contentHash(scanKey);
  }
}
