import { contentHash } from "@openpond/harness";
import { agentImportNormalizerRevision } from "../connected-evidence/imports.js";
import { listSessions, readSession } from "./history.js";
import { NativeSessionNotReadyError } from "./readiness.js";
import { collectorBranchAnchor } from "./collector-branches.js";
import { CollectorQueueFullError } from "./collector-snapshots.js";
import { COLLECTOR_DEFAULTS, type CollectorConnection, type CollectorRun } from "./collector-contracts.js";
import type { CollectorStore } from "./collector-store.js";
import type { CollectorCoverageSession } from "../connected-evidence/collector-coverage-contracts.js";
import { CollectorCoverage } from "./collector-coverage.js";

/** One pass over a frozen listing per page. Unchanged revisions are cheap; a
 * failed source is tried again only in a later explicitly launched job. */
export async function acquireCollectorSource(input: {
  store: CollectorStore;
  connection: CollectorConnection;
  until: string;
  check(): Promise<void>;
  drain(): Promise<void>;
  progress(update: Partial<CollectorRun>): void;
}) {
  const { store, connection, check, drain, progress, until } = input;
  let cursor: string | undefined, processed = 0, discovered = 0;
  const failures: string[] = [];
  do {
    await check();
    progress({ phase: "discovering" });
    // File mtimes and native activity summaries are not event-time authority.
    // Enumerate the source, then apply the consented window to native events.
    const page = await listSessions(connection.source, { cursor, limit: 50 });
    discovered += page.items.length;
    if (discovered > 10_000) throw new Error("Source inventory exceeds 10,000 sessions. Select a narrower import window.");
    for (const native of page.items) {
      const scanKey = JSON.stringify([native.path, native.nativeSessionId]);
      store.coverage.record(connection.id, { sourceKeyHash: CollectorCoverage.sourceKey(scanKey),
        nativeRevisionHash: native.storageRevision ? contentHash([native.storageRevision, agentImportNormalizerRevision(connection.source.source)]) : null,
        state: "reading", reason: null, unknownTimeBoundaries: 0, normalized: [] });
    }
    progress({ discovered });
    for (const native of page.items) {
      await check();
      // Do not parse another transcript while any retained admission is blocked.
      await drain();
      const queuedBytes = Number(store.database.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM pending").get()?.n) + store.snapshots.bytes();
      if (queuedBytes >= COLLECTOR_DEFAULTS.maxBytes) throw new CollectorQueueFullError();
      progress({ phase: "reading" });
      const scanKey = JSON.stringify([native.path, native.nativeSessionId]);
      const scanRevision = native.storageRevision
        ? contentHash([native.storageRevision, agentImportNormalizerRevision(connection.source.source)]) : null;
      store.progress.select(connection.id, scanKey);
      const coverage: CollectorCoverageSession = { sourceKeyHash: CollectorCoverage.sourceKey(scanKey), nativeRevisionHash: scanRevision,
        state: "reading", reason: scanRevision ? null : "source_revision_unavailable", unknownTimeBoundaries: 0, normalized: [] };
      try {
        const { files, preview, branchLeafId } = await readSession(connection.source, native, {
          branchAnchor: collectorBranchAnchor(store, connection.id, native.nativeSessionId),
        });
        coverage.nativeRevisionHash = contentHash([files, agentImportNormalizerRevision(connection.source.source)]);
        await check();
        const snapshot = store.snapshots.prepare(files);
        let eligible = false;
        for (const session of preview.sessions) {
          const key = JSON.stringify([connection.source.instanceId, session.sessionId, session.branchId]);
          store.progress.retained(connection.id, scanKey, key);
          const boundaries = session.boundaries.filter(boundary => {
            if (boundary.projection !== "turn" || boundary.terminal === "unknown") return false;
            const timestamp = session.events[boundary.start]?.occurredAt;
            if (!timestamp || !Number.isFinite(Date.parse(timestamp))) { coverage.unknownTimeBoundaries++; return false; }
            return Date.parse(timestamp) < Date.parse(until) && (!connection.since || Date.parse(timestamp) >= Date.parse(connection.since));
          });
          coverage.normalized.push({ sessionHash: session.contentHash, boundaries: boundaries.map(boundary => ({
            id: boundary.id, inputHash: boundary.inputHash, revisionHash: boundary.revisionHash, occurredAt: session.events[boundary.start]!.occurredAt!,
          })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
          store.coverage.record(connection.id, coverage);
          eligible ||= boundaries.length > 0;
          const changed = boundaries.filter(boundary => store.changed(connection.id, key, boundary.id, contentHash([boundary.inputHash, boundary.revisionHash])));
          for (let offset = 0; offset < changed.length; offset += COLLECTOR_DEFAULTS.batchCases) {
            await check();
            const selected = changed.slice(offset, offset + COLLECTOR_DEFAULTS.batchCases);
            const operationId = `sync-${contentHash([connection.id, key, selected.map(boundary => [boundary.id, boundary.inputHash, boundary.revisionHash])]).slice(0, 48)}`;
            store.enqueue({ operationId, connectionId: connection.id, sessionKey: key, contentHash: session.contentHash,
              files, boundaryIds: selected.map(boundary => boundary.id), ...(branchLeafId ? { branchLeafId } : {}) },
            selected.map(boundary => ({ id: boundary.id, revision: contentHash([boundary.inputHash, boundary.revisionHash]) })), scanKey, snapshot);
          }
        }
        store.progress.read(connection.id, scanKey, eligible);
        if (scanRevision) store.scanned(connection.id, scanKey, scanRevision);
        await drain();
        coverage.state = eligible ? "admitted" : "skipped";
        coverage.reason = eligible ? null : "no_eligible_boundaries";
        coverage.normalized.sort((a, b) => a.sessionHash < b.sessionHash ? -1 : a.sessionHash > b.sessionHash ? 1 : 0);
        store.coverage.record(connection.id, coverage);
      } catch (error) {
        if (error instanceof NativeSessionNotReadyError) {
          coverage.state = "skipped"; coverage.reason = "native_session_not_ready";
          store.coverage.record(connection.id, coverage);
          store.progress.read(connection.id, scanKey, false);
          if (scanRevision) store.scanned(connection.id, scanKey, scanRevision);
          continue;
        }
        // Capacity/lifecycle failures end this run instead of retrying all files.
        if (error instanceof CollectorQueueFullError || error instanceof CollectorInterruptedError || error instanceof CollectorScopeChangedError) throw error;
        const message = error instanceof Error ? error.message : "Unable to read session";
        coverage.state = "failed"; coverage.reason = "source_read_failed";
        store.coverage.record(connection.id, coverage);
        store.progress.failed(connection.id, scanKey, message);
        failures.push(`${native.nativeSessionId}: ${message}`);
      } finally { progress({ processed: ++processed }); }
      // Admit one source snapshot before moving on to the next session.
      await drain();
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  store.progress.discovered(connection.id);
  store.coverage.finish(connection.id, true);
  if (failures.length) throw new Error(`${failures.length} session(s) need attention. ${failures[0]}`);
}

export class CollectorInterruptedError extends Error {}
export class CollectorScopeChangedError extends Error {}
