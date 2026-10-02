import type { CollectorConnection, CollectorRemoteControl } from "./collector-contracts.js";
import type { CollectorStore } from "./collector-store.js";

export interface SyncAcquisition {
  controlRevision: number;
  requestedSyncRevision: number;
  succeeded: boolean;
}

/** The request and completed-work receipt are durable. An in-process scan token
 * deliberately is not: restart reconciles the retained source again before it
 * can claim previously unfinished work completed. */
export class CollectorSyncRequests {
  private readonly acquisitions = new Map<string, SyncAcquisition>();
  constructor(private readonly store: CollectorStore) {}

  observe(connection: CollectorConnection, remote: CollectorRemoteControl) {
    const requested = remote.requestedSyncRevision ?? connection.requestedSyncRevision ?? 0;
    const completed = remote.completedSyncRevision ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > remote.revision ||
      !Number.isSafeInteger(completed) || completed < 0 || completed > requested)
      throw new Error("Invalid remote sync acknowledgement.");
    const confirmed = this.confirmed(connection.id);
    if (completed > confirmed) this.store.set(`syncAcknowledged:${connection.id}`, String(completed));
    return {
      requestedSyncRevision: Math.max(connection.requestedSyncRevision ?? 0, requested),
      completedSyncRevision: Math.max(connection.completedSyncRevision ?? 0, completed),
    };
  }

  needsAcquisition(connection: CollectorConnection) {
    const requested = connection.requestedSyncRevision ?? 0;
    if (requested <= (connection.completedSyncRevision ?? 0)) return false;
    const prior = this.acquisitions.get(connection.id);
    return prior?.controlRevision !== connection.revision || prior.requestedSyncRevision !== requested;
  }

  acquired(id: string, acquisition: SyncAcquisition) {
    this.acquisitions.set(id, acquisition);
  }

  complete(connection: CollectorConnection, error: string | null) {
    const acquired = this.acquisitions.get(connection.id);
    const requested = connection.requestedSyncRevision ?? 0;
    if (connection.state !== "active" || this.store.setting("desiredState") !== "running" ||
      this.store.queued(connection.id) || error || !acquired?.succeeded ||
      acquired.controlRevision !== connection.revision || acquired.requestedSyncRevision !== requested ||
      requested <= (connection.completedSyncRevision ?? 0)) return connection;
    const completed = { ...connection, completedSyncRevision: requested };
    this.store.put(completed);
    return completed;
  }

  confirmed(id: string) {
    return Number(this.store.setting(`syncAcknowledged:${id}`)) || 0;
  }

  needsAcknowledgement(connection: CollectorConnection) {
    return (connection.completedSyncRevision ?? 0) > this.confirmed(connection.id);
  }
}
