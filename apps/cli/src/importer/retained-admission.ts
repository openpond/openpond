import { contentHash } from "@openpond/harness";
import type { AgentImportPreview } from "@openpond/evals/connected-evidence";
import type { CollectorAdmission, CollectorConnection } from "@openpond/evals/native-conversations";

/** Re-normalize immutable queued bytes without widening their selected turns.
 * A changed source projection needs a distinct, retry-stable admission. */
export function refreshRetainedAdmission(connection: CollectorConnection, entry: CollectorAdmission, normalized: AgentImportPreview): CollectorAdmission {
  if (entry.connectionId !== connection.id || !entry.boundaryIds.length || new Set(entry.boundaryIds).size !== entry.boundaryIds.length) {
    throw Object.assign(new Error("Retained source selection differs from its connection."), { status: 400 });
  }
  if (normalized.issues.length) throw Object.assign(new Error("Retained source normalization failed."), { status: 400 });
  const session = normalized.sessions.find(item => JSON.stringify([connection.source.instanceId, item.sessionId, item.branchId]) === entry.sessionKey);
  if (!session || entry.boundaryIds.some(id => {
    const boundary = session.boundaries.find(item => item.id === id);
    const occurredAt = boundary ? session.events[boundary.start]?.occurredAt : null;
    return !boundary || boundary.projection !== "turn" || boundary.terminal === "unknown" || !occurredAt
      || !Number.isFinite(Date.parse(occurredAt)) || (connection.since !== null && Date.parse(occurredAt) < Date.parse(connection.since));
  })) throw Object.assign(new Error("Retained source boundaries changed; inspect the connection before resuming."), { status: 400 });
  return { ...entry, contentHash: session.contentHash,
    operationId: session.contentHash === entry.contentHash ? entry.operationId
      : `sync-${contentHash([entry.operationId, "source-normalization", session.contentHash]).slice(0, 48)}` };
}
