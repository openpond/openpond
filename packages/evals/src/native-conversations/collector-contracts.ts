import type { NativeSource } from "./contracts.js";
export const COLLECTOR_DEFAULTS = {
  reconcileMs: 30000,
  heartbeatMs: 10000,
  staleMs: 60000,
  maxPending: 10000,
  maxBytes: 1024 * 1024 * 1024,
  batchCases: 20,
  batchBytes: 1024 * 1024,
} as const;
export interface CollectorConnection {
  id: string;
  teamId: string;
  apiBaseUrl: string;
  account?: string;
  accountBaseUrl?: string;
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
  }[];
}
export interface CollectorAdmission {
  operationId: string;
  connectionId: string;
  sessionKey: string;
  contentHash: string;
  files: { path: string; text: string }[];
  boundaryIds: string[];
}
/** Credentials are resolved by the process host, never persisted in source metadata or queue entries. */
export interface CollectorTransport {
  heartbeat(
    connection: CollectorConnection,
    input: { pendingOperations: number; error: string | null },
  ): Promise<{ revision: number; state: CollectorConnection["state"] }>;
  admit(
    connection: CollectorConnection,
    entry: CollectorAdmission,
  ): Promise<void>;
}
