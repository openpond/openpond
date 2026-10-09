import { contentHash } from "@openpond/harness";
import { agentImportNormalizerRevision } from "../connected-evidence/imports.js";
import { listSessions, readSession } from "./history.js";
import { NativeSessionNotReadyError } from "./readiness.js";
import { collectorBranchAnchor } from "./collector-branches.js";
import { CollectorQueueFullError } from "./collector-snapshots.js";
import { COLLECTOR_DEFAULTS, type CollectorConnection, type CollectorRun } from "./collector-contracts.js";
import type { CollectorStore } from "./collector-store.js";

/** One pass over a frozen listing per page. Unchanged revisions are cheap; a
 * failed source is tried again only in a later explicitly launched job. */
export async function acquireCollectorSource(input: {
  store: CollectorStore;
  connection: CollectorConnection;
  check(): Promise<void>;
  drain(): Promise<void>;
  progress(update: Partial<CollectorRun>): void;
}) {
  const { store, connection, check, drain, progress } = input;
  let cursor: string | undefined, processed = 0, discovered = 0;
  const failures: string[] = [];
  do {
    await check();
    progress({ phase: "discovering" });
    const page = await listSessions(connection.source, { since: connection.since ?? undefined, cursor, limit: 50 });
    discovered += page.items.length;
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
      try {
        if (scanRevision && !store.sourceChanged(connection.id, scanKey, scanRevision) && !store.progress.tracks(connection.id, scanKey)) continue;
        const { files, preview, branchLeafId } = await readSession(connection.source, native, {
          branchAnchor: collectorBranchAnchor(store, connection.id, native.nativeSessionId),
        });
        await check();
        const snapshot = store.snapshots.prepare(files);
        let eligible = false;
        for (const session of preview.sessions) {
          const key = JSON.stringify([connection.source.instanceId, session.sessionId, session.branchId]);
          store.progress.retained(connection.id, scanKey, key);
          const boundaries = session.boundaries.filter(boundary => boundary.projection === "turn" && boundary.terminal !== "unknown" &&
            (!connection.since || Date.parse(session.events[boundary.start]!.occurredAt ?? native.updatedAt) >= Date.parse(connection.since)));
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
      } catch (error) {
        if (error instanceof NativeSessionNotReadyError) {
          store.progress.read(connection.id, scanKey, false);
          if (scanRevision) store.scanned(connection.id, scanKey, scanRevision);
          continue;
        }
        // Capacity/lifecycle failures end this run instead of retrying all files.
        if (error instanceof CollectorQueueFullError || error instanceof CollectorInterruptedError || error instanceof CollectorScopeChangedError) throw error;
        const message = error instanceof Error ? error.message : "Unable to read session";
        store.progress.failed(connection.id, scanKey, message);
        failures.push(`${native.nativeSessionId}: ${message}`);
      } finally { progress({ processed: ++processed }); }
      // Admit one source snapshot before moving on to the next session.
      await drain();
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  store.progress.discovered(connection.id);
  if (failures.length) throw new Error(`${failures.length} session(s) need attention. ${failures[0]}`);
}

export class CollectorInterruptedError extends Error {}
export class CollectorScopeChangedError extends Error {}
