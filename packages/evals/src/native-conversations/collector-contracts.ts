import type { NativeSource } from "./contracts.js";
import type { CollectorBackfillProgress } from "./collector-progress.js";
export const COLLECTOR_DEFAULTS = {
  reconcileMs: 30000,
  heartbeatMs: 10000,
  staleMs: 60000,
  maxPending: 10000,
  maxBytes: 1024 * 1024 * 1024,
  batchCases: 20,
  batchBytes: 1024 * 1024,
} as const;
export interface CollectorDestinations { taskDatasetId: string | null; conversationDatasetId: string | null }
export interface CollectorRemoteControl { revision: number; state: CollectorConnection["state"]; destinations?: CollectorDestinations }
export interface CollectorConnection {
  id: string;
  teamId: string;
  apiBaseUrl: string;
  account?: string;
  accountBaseUrl?: string;
  destinations?: CollectorDestinations;
  source: NativeSource;
  projectId: string;
  revision: number;
  since: string | null;
  keepSyncing: boolean;
  state: "active" | "paused" | "disconnected";
}
export interface CollectorStatus {
  schemaVersion: 1;
  running: boolean;
  desiredState: "running" | "stopped";
  pid: number | null;
  heartbeatAt: string | null;
  connections: {
    id: string;
    state: CollectorConnection["state"];
    projectId: string;
    source: NativeSource["source"];
    queued: number;
    admitted: number;
    error: string | null;
    backfill: CollectorBackfillProgress;
    pendingBytes: number;
    lastAdmissionAt: string | null;
    destinationLinks: { tasks: string | null; conversations: string | null };
  }[];
}
export interface CollectorAdmission {
  operationId: string;
  connectionId: string;
  sessionKey: string;
  contentHash: string;
  files: { path: string; text: string }[];
  boundaryIds: string[];
  branchLeafId?: string;
}
/** Credentials are resolved by the process host, never persisted in source metadata or queue entries. */
export interface CollectorTransport {
  pause?(
    connection: CollectorConnection,
  ): Promise<CollectorRemoteControl>;
  heartbeat(
    connection: CollectorConnection,
    input: { pendingOperations: number; error: string | null },
  ): Promise<CollectorRemoteControl>;
  admit(
    connection: CollectorConnection,
    entry: CollectorAdmission,
  ): Promise<void>;
}
