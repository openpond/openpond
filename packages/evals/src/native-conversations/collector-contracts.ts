import type { NativeSource } from "./contracts.js";
import type { CollectorBackfillProgress } from "./collector-progress.js";
export const COLLECTOR_DEFAULTS = {
  heartbeatMs: 10000,
  staleMs: 60000,
  maxPending: 10000,
  maxBytes: 128 * 1024 * 1024,
  batchCases: 20,
  runMs: 60 * 60 * 1000,
  requestMs: 60000,
  attemptsPerRun: 3,
} as const;
export type CollectorSchedule =
  | { frequency: "hourly" }
  | { frequency: "cron"; expression: string }
  | { frequency: "daily"; time: string }
  | { frequency: "weekly"; time: string; day: number };

export interface CollectorRun {
  id: string;
  state: "running" | "completed" | "failed" | "cancelled";
  phase: "discovering" | "reading" | "uploading";
  startedAt: string;
  finishedAt: string | null;
  processed: number;
  discovered: number;
  uploaded: number;
  error: string | null;
}
export interface CollectorDestinations { taskDatasetId: string | null; conversationDatasetId: string | null }
export interface CollectorRemoteControl {
  revision: number;
  state: CollectorConnection["state"];
  destinations?: CollectorDestinations;
  requestedSyncRevision?: number;
  completedSyncRevision?: number;
}
export interface CollectorConnection {
  id: string;
  teamId: string;
  apiBaseUrl: string;
  account?: string;
  accountBaseUrl?: string;
  /** The account store used at connection time; credentials stay in that store. */
  credentialHome?: string;
  destinations?: CollectorDestinations;
  requestedSyncRevision?: number;
  /** Locally completed work, retained before the hosted acknowledgement is sent. */
  completedSyncRevision?: number;
  source: NativeSource;
  projectId: string;
  revision: number;
  since: string | null;
  /** Hosted registration metadata; local recurrence is an explicit schedule. */
  keepSyncing: boolean;
  state: "active" | "paused" | "disconnected";
}
export interface CollectorStatus {
  schemaVersion: 1;
  running: boolean;
  desiredState: "running" | "stopped";
  pid: number | null;
  heartbeatAt: string | null;
  timezone: string;
  connections: {
    id: string;
    state: CollectorConnection["state"];
    projectId: string;
    teamId: string;
    accountBaseUrl: string | null;
    sourceInstanceId: string;
    sourceRoot: string;
    source: NativeSource["source"];
    queued: number;
    admitted: number;
    error: string | null;
    backfill: CollectorBackfillProgress;
    pendingBytes: number;
    lastAdmissionAt: string | null;
    since: string | null;
    schedule: CollectorSchedule | null;
    nextRunAt: string | null;
    lastSuccessfulSyncAt: string | null;
    run: CollectorRun | null;
    requestedSyncRevision: number;
    completedSyncRevision: number;
    acknowledgedSyncRevision: number;
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
  heartbeat(
    connection: CollectorConnection,
    input: { pendingOperations: number; error: string | null; completedSyncRevision: number },
    signal?: AbortSignal,
  ): Promise<CollectorRemoteControl>;
  admit(
    connection: CollectorConnection,
    entry: CollectorAdmission,
    signal?: AbortSignal,
  ): Promise<void>;
}
