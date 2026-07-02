import type { SandboxCommand, SandboxState } from "./index.js";
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

export type SandboxSnapshotInput = Record<string, unknown>;

export type SandboxSnapshot = {
  id: string;
  sandboxId: string;
  name: string;
  state: "ready";
  sizeGb: number;
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
