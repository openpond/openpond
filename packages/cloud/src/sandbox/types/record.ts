import type {
  SandboxArchiveRef,
  SandboxBudget,
  SandboxCommand,
  SandboxIntegrationLeaseRef,
  SandboxPreviewPort,
  SandboxProcess,
  SandboxPtySession,
  SandboxQuotaPolicy,
  SandboxReceipt,
  SandboxReservation,
  SandboxResources,
  SandboxRuntimeDriver,
  SandboxRuntimeProfileId,
  SandboxRuntimeProfileSummary,
  SandboxSnapshot,
  SandboxSnapshotCatalogEntry,
  SandboxSnapshotJob,
  SandboxState,
  SandboxTemplateCatalogEntry,
} from "./index.js";
export type SandboxRecord = {
  id: string;
  state: SandboxState;
  runtimeDriver: SandboxRuntimeDriver;
  repo: string | null;
  repoRef?: string | null;
  sourceCommitSha?: string | null;
  teamId: string;
  projectId: string | null;
  agentId: string | null;
  runtimeId?: string | null;
  runtimeProfileId?: SandboxRuntimeProfileId | null;
  workspaceRoot?: string | null;
  runtimeProfile?: SandboxRuntimeProfileSummary | null;
  executionProfileId?: string | null;
  visibility: "private" | "team";
  ownerUserId: string;
  billingAccountId: string;
  resources: SandboxResources;
  budget: SandboxBudget;
  quotas?: SandboxQuotaPolicy;
  reservation: SandboxReservation;
  commands: SandboxCommand[];
  processes?: SandboxProcess[];
  ptySessions?: SandboxPtySession[];
  integrationLeases?: SandboxIntegrationLeaseRef[];
  previewPorts: SandboxPreviewPort[];
  snapshots?: SandboxSnapshot[];
  snapshotJobs?: SandboxSnapshotJob[];
  archive?: SandboxArchiveRef | null;
  receipts: SandboxReceipt[];
  logs: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  archivedAt?: string | null;
  deletedAt: string | null;
};

export type SandboxCreateResponse = {
  sandbox: SandboxRecord;
};

export type SandboxSnapshotCatalogResponse = {
  snapshots: SandboxSnapshotCatalogEntry[];
};

export type SandboxTemplateCatalogResponse = {
  templates: SandboxTemplateCatalogEntry[];
};

export type SandboxPublishedSnapshotCatalogResponse =
  SandboxTemplateCatalogResponse & {
    publishedSnapshots: SandboxTemplateCatalogEntry[];
  };
