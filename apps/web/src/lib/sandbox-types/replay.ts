import type { SandboxBudget, SandboxReceipt } from "./base";
import type { SandboxIntegrationLeaseInput } from "./runtime";
import type { SandboxAccountSummary } from "./record";

export type SandboxReplayInput = {
  snapshotId: string;
  sourceSandboxId?: string;
  entrypoint?: string;
  params?: Record<string, unknown>;
  budget?: Partial<SandboxBudget>;
  maxDurationSeconds?: number;
  idleTimeoutSeconds?: number;
  cleanup?: "stop" | "delete" | "archive";
  artifactPaths?: string[];
  integrationLeases?: SandboxIntegrationLeaseInput[];
  idempotencyKey?: string;
};

export type SandboxReplayState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type SandboxReplayArtifact = {
  path: string;
  status: "captured" | "missing" | "failed";
  sizeBytes: number | null;
  contentsBase64?: string;
  error: string | null;
};

export type SandboxReplayRecord = {
  id: string;
  teamId: string;
  ownerUserId: string;
  sourceSandboxId: string;
  snapshotId: string;
  sandboxId: string | null;
  state: SandboxReplayState;
  entrypoint: {
    name: string | null;
    command: string;
    cwd: string | null;
  };
  params: Record<string, unknown>;
  budget: SandboxBudget;
  maxDurationSeconds: number | null;
  idleTimeoutSeconds: number | null;
  integrationLeases: SandboxIntegrationLeaseInput[];
  artifactPaths: string[];
  artifacts: SandboxReplayArtifact[];
  logs: string[];
  receipts: SandboxReceipt[];
  commandId: string | null;
  exitCode: number | null;
  error: string | null;
  cleanup: {
    action: "stop" | "delete" | "archive";
    status: "pending" | "succeeded" | "failed" | "skipped";
    error: string | null;
  };
  idempotencyKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type SandboxReplayResponse = {
  replay: SandboxReplayRecord;
  account: SandboxAccountSummary;
};

export type SandboxReplayListResponse = {
  replays: SandboxReplayRecord[];
  account: SandboxAccountSummary;
};

export type SandboxReplayLogsResponse = {
  replayId: string;
  logs: string[];
  account: SandboxAccountSummary;
};

export type SandboxReplayArtifactsResponse = {
  replayId: string;
  artifacts: SandboxReplayArtifact[];
  account: SandboxAccountSummary;
};
