import type { SandboxCommand, SandboxState, SandboxSnapshotRetentionStatus } from "./index.js";
export type SandboxSnapshotTemplateVisibility = "private" | "team";

export type SandboxSnapshotTemplateInput = {
  name: string;
  version: string;
  description?: string;
  tags?: string[];
  visibility?: SandboxSnapshotTemplateVisibility;
  useCase?: string;
};

export type SandboxSnapshotTemplate = {
  name: string;
  version: string;
  description: string | null;
  tags: string[];
  visibility: SandboxSnapshotTemplateVisibility;
  useCase: string | null;
};

export type SandboxSnapshotReplayRetentionClass =
  | "ephemeral"
  | "cached"
  | "pinned";

export type SandboxSnapshotReplayState = "draft" | "validated" | "published";

export type SandboxSnapshotReplayManifest = {
  state: SandboxSnapshotReplayState;
  retention: {
    class: SandboxSnapshotReplayRetentionClass;
    ttlSeconds: number | null;
  };
  metadata?: Record<string, unknown>;
};

export type SandboxSnapshotValidationCommandResult = {
  command: string;
  cwd: string | null;
  status: SandboxCommand["status"];
  exitCode: number | null;
  output: string;
  startedAt: string;
  completedAt: string | null;
};

export type SandboxSnapshotValidationProbeResult = {
  name: string | null;
  port: number;
  path: string;
  expectedStatus: number;
  actualStatus: number | null;
  ok: boolean;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type SandboxSnapshotValidationResult = {
  id: string;
  status: "passed" | "failed";
  sourceSandboxId: string;
  validationSandboxId: string | null;
  snapshotId: string;
  commands: SandboxSnapshotValidationCommandResult[];
  probes: SandboxSnapshotValidationProbeResult[];
  cleanup: {
    action: "stop" | "delete" | "archive";
    status: "succeeded" | "failed" | "skipped";
    error: string | null;
  };
  error: string | null;
  startedAt: string;
  completedAt: string;
};

export type SandboxSnapshotValidateInput = {
  cleanup?: "stop" | "delete" | "archive";
};

export type SandboxSnapshotTemplateUpdateInput = {
  description?: string | null;
  tags?: string[];
  visibility?: SandboxSnapshotTemplateVisibility;
  useCase?: string | null;
};

export type SandboxSnapshotRetentionUpdateInput = {
  class?: SandboxSnapshotReplayRetentionClass;
  ttlSeconds?: number | null;
};

export type SandboxSnapshotUpdateInput = {
  template?: SandboxSnapshotTemplateUpdateInput;
  retention?: SandboxSnapshotRetentionUpdateInput;
};

/** Capture options. Native filesystem capture requires finite retention and
 * an accepted funding quote; template/cache operations depend on capability. */
export type SandboxSnapshotInput = Record<string, unknown> & {
  name: string;
  template?: SandboxSnapshotTemplateInput;
  replay?: Record<string, unknown> & {
    retention?: { class?: SandboxSnapshotReplayRetentionClass; ttlSeconds?: number | null };
  };
  cachePolicy?: {
    packageCaches?: "keep" | "clean_before_capture";
    hotCache?: "eligible" | "disabled";
  };
  async?: boolean;
  retentionFunding?: { termsSha256: string; maxUsd: string };
};

/** Descriptor identity does not imply a measured filesystem checksum. */
export type SandboxFilesystemCheckpoint = {
  custodyId: string;
  descriptorSha256: string | null;
  phase: "reserved" | "capture_submitted" | "ready" | "deleting" | "deleted" | "cancelled";
  measuredSizeBytes: number | null;
  checksumSha256: string | null;
};

/** Prepares replacement of an already stopped root. Does not start compute. */
export type SandboxRestoreInput = {
  operationId: string;
  checkpointId: string;
  checkpointCustodyId: string;
  expectedSourceUpdatedAt: string;
  replaceStoppedRoot: true;
};

export type SandboxStartInput = {
  restore?: {
    operationId: string;
    intentSha256: string;
    /** Positive USD with six decimal places. */
    maximumUsd: string;
    /** Absolute accepted deadline; retries cannot extend it. */
    executionUntil: string;
  };
};

export type SandboxSnapshot = {
  id: string;
  sandboxId: string;
  name: string;
  state: "ready";
  sizeGb: number | null;
  checkpoint?: SandboxFilesystemCheckpoint;
  template?: SandboxSnapshotTemplate | null;
  replay?: SandboxSnapshotReplayManifest | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type SandboxSnapshotJob = {
  id: string;
  snapshotId: string;
  name: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type SandboxArchiveRef = {
  id: string;
  sandboxId: string;
  snapshotId: string | null;
  storage: "simulated" | "runner_local" | "s3";
  createdAt: string;
  restoredAt: string | null;
};

export type SandboxSnapshotCatalogEntry = {
  checkpoint?: SandboxFilesystemCheckpoint;
  id: string;
  kind: "snapshot" | "archive";
  sandboxId: string;
  sandboxState: SandboxState;
  sandboxRepo: string | null;
  teamId: string;
  projectId?: string | null;
  agentId?: string | null;
  name: string;
  snapshot: SandboxSnapshot | null;
  archive: SandboxArchiveRef | null;
  sizeGb: number | null;
  storage: SandboxArchiveRef["storage"] | "snapshot" | null;
  storageCost?: {
    sizeGb: number | null;
    retentionClass: SandboxSnapshotReplayRetentionClass | null;
    estimatedMonthlyUsd: string | null;
    pricingSource: "configured" | "not_configured";
    retention?: SandboxSnapshotRetentionStatus;
  };
  template: SandboxSnapshotTemplate | null;
  replay?: SandboxSnapshotReplayManifest | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type SandboxTemplateCatalogEntry = {
  id: string;
  snapshotId: string;
  sandboxId: string;
  sandboxState: SandboxState;
  sandboxRepo: string | null;
  teamId: string;
  projectId: string | null;
  agentId: string | null;
  name: string;
  version: string;
  description: string | null;
  tags: string[];
  visibility: SandboxSnapshotTemplateVisibility;
  useCase: string | null;
  sizeGb: number | null;
  source?: {
    repo: string | null;
    ref: string | null;
    commitSha: string | null;
    projectId: string | null;
    agentId: string | null;
  };
  storageCost?: SandboxSnapshotCatalogEntry["storageCost"];
  replay: SandboxSnapshotReplayManifest;
  snapshot: SandboxSnapshot;
  createdAt: string;
};

export type SandboxPublishedSnapshotCatalogEntry =
  SandboxTemplateCatalogEntry;

export type SandboxTemplateBuildStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SandboxTemplateBuildPublishStatus =
  | "skipped"
  | "published"
  | "failed";

export type SandboxTemplateBuildCreateInput = {
  teamId?: string;
  sourceRepoUrl?: string;
  sourceProjectId?: string;
  branch?: string;
  manifestPath?: string;
  publish?: boolean;
};

export type SandboxTemplateBuildRecord = {
  id: string;
  teamId: string;
  sourceProjectId: string | null;
  sourceRepoUrl: string;
  sourceOwner: string;
  sourceRepo: string;
  sourceBranch: string;
  sourceCommitSha: string | null;
  manifestPath: string;
  manifestHash: string | null;
  manifest: Record<string, unknown> | null;
  status: SandboxTemplateBuildStatus;
  buildSandboxId: string | null;
  snapshotId: string | null;
  validationSandboxId: string | null;
  validation: Record<string, unknown> | null;
  publishStatus: SandboxTemplateBuildPublishStatus | null;
  logs: string[];
  error: string | null;
  requestedByUserId: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SandboxPublishedSnapshotBuildStatus = SandboxTemplateBuildStatus;
export type SandboxPublishedSnapshotBuildPublishStatus =
  SandboxTemplateBuildPublishStatus;
export type SandboxPublishedSnapshotBuildCreateInput =
  SandboxTemplateBuildCreateInput;
export type SandboxPublishedSnapshotBuildRecord = SandboxTemplateBuildRecord;
