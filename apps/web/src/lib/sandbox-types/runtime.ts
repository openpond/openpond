import type {
  SandboxIntegrationProvider,
  SandboxReservation,
  SandboxState,
} from "./base";

export type SandboxCommand = {
  id: string;
  command: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  output: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
};

export type SandboxProcessStatus = "running" | "succeeded" | "failed" | "timed_out" | "stopped";

export type SandboxProcess = {
  id: string;
  command: string;
  status: SandboxProcessStatus;
  output: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  outputBytes: number;
  truncated?: boolean;
};

export type SandboxPreviewAccess = "private" | "public";

export type SandboxPreviewAuthPolicyInput =
  | {
      mode: "bearer";
      token: string;
    }
  | {
      mode: "header";
      headerName: string;
      headerValue: string;
    };

export type SandboxPreviewAuthPolicy =
  | {
      mode: "bearer";
      tokenSha256: string;
    }
  | {
      mode: "header";
      headerName: string;
      headerValueSha256: string;
    };

export type SandboxPtyStatus = "running" | "exited" | "failed" | "timed_out" | "stopped";

export type SandboxPtySession = {
  id: string;
  command: string;
  status: SandboxPtyStatus;
  output: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  outputBytes: number;
  rows: number;
  cols: number;
  truncated?: boolean;
};

export type SandboxPreviewPort = {
  id: string;
  port: number;
  label: string | null;
  url: string;
  targetUrl?: string | null;
  customDomain?: string | null;
  access: SandboxPreviewAccess;
  autoStart?: boolean;
  authPolicy?: SandboxPreviewAuthPolicy;
  token: string;
  createdAt: string;
};

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

export type SandboxSnapshotReplayRetentionClass = "ephemeral" | "cached" | "pinned";

export type SandboxSnapshotReplayState = "draft" | "validated" | "published";

export type SandboxSnapshotReplayManifest = {
  state: SandboxSnapshotReplayState;
  retention: {
    class: SandboxSnapshotReplayRetentionClass;
    ttlSeconds: number | null;
  };
  metadata?: Record<string, unknown>;
};

export type SandboxSnapshotValidationResult = {
  id: string;
  status: "passed" | "failed";
  sourceSandboxId: string;
  validationSandboxId: string | null;
  snapshotId: string;
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

export type SandboxArchiveRef = {
  id: string;
  sandboxId: string;
  snapshotId: string | null;
  storage: "simulated" | "runner_local" | "s3";
  createdAt: string;
  restoredAt: string | null;
};

export type SandboxIntegrationLeaseInput = {
  leaseId: string;
  provider: SandboxIntegrationProvider;
  scopes?: string[];
  capabilities?: string[];
  resourcePolicy?: Record<string, unknown>;
  expiresAt?: string;
  proxyUrl?: string;
  required?: boolean;
};

export type SandboxIntegrationConnectionLeaseInput = {
  connectionId: string;
  provider?: SandboxIntegrationProvider;
  scopes?: string[];
  capabilities: string[];
  resourcePolicy?: Record<string, unknown>;
  expiresAt?: string;
  ttlSeconds?: number;
  required?: boolean;
};

export type SandboxIntegrationLeaseRef = {
  leaseId: string;
  provider: SandboxIntegrationProvider;
  scopes: string[];
  capabilities: string[];
  resourcePolicy: Record<string, unknown>;
  expiresAt: string | null;
  proxyUrl: string | null;
  required: boolean;
};

export type SandboxGitStatus = {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  porcelain: string;
};

export type SandboxGitDiff = {
  isRepo: boolean;
  baseRef: string | null;
  diff: string;
};

export type SandboxGitBranch = {
  isRepo: boolean;
  branch: string | null;
  output: string;
  status: SandboxGitStatus;
};

export type SandboxGitCommit = {
  isRepo: boolean;
  commitHash: string | null;
  output: string;
  status: SandboxGitStatus;
};

export type SandboxGitRemoteOperation = {
  isRepo: boolean;
  remote: string | null;
  branch: string | null;
  output: string;
  status: SandboxGitStatus;
};

export type SandboxFileRef = {
  path: string;
  sizeBytes: number;
  updatedAt: string;
  isBinary?: boolean | null;
  previewable?: boolean;
};

export type SandboxFileEntry = SandboxFileRef & {
  type: "file" | "directory";
};

export type SandboxFileSearchMatch = {
  path: string;
  line: number;
  preview: string;
};

export type SandboxBillingStatus = {
  sandboxId: string;
  state: SandboxState;
  billingModel: "reserve_capture" | "session";
  reservationStatus: SandboxReservation["status"];
  budgetUsd: string;
  reservedUsd: string;
  capturedUsd: string;
  remainingBudgetUsd: string;
  mppMode: NonNullable<SandboxReservation["mpp"]>["mode"] | null;
  sessionRef: string | null;
  channelId: string | null;
  depositUsd: string | null;
  acceptedCumulativeUsd: string | null;
  remainingSessionUsd: string | null;
  tickCount: number;
  lastTickAt: string | null;
  finalizedAt: string | null;
  lastReceiptRef: string | null;
};

export type SandboxWorkflowMode =
  | "readonly"
  | "attempt"
  | "feature"
  | "rollout"
  | "replay"
  | "template_build"
  | "scheduled_run"
  | "patch_only"
  | "hotfix"
  | "multi_feature_batch";

export type SandboxRuntimePromotionPolicy =
  | "none"
  | "manual"
  | "auto_after_checks";

export type SandboxRuntimeCreateInput = {
  teamId?: string;
  projectId?: string;
  agentId?: string;
  workflowMode?: SandboxWorkflowMode;
  baseBranch?: string;
  baseSha?: string;
  sandboxId?: string;
  rootfsSnapshotId?: string;
  dependencySnapshotId?: string;
  promotionPolicy?: SandboxRuntimePromotionPolicy;
  metadata?: Record<string, unknown>;
};

export type SandboxRuntimeRecord = {
  id: string;
  teamId: string;
  ownerUserId: string;
  createdByUserId: string;
  projectId: string | null;
  agentId: string | null;
  workflowMode: SandboxWorkflowMode;
  status: string;
  repoId: string | null;
  baseBranch: string;
  baseSha: string | null;
  sourceRef: string | null;
  currentSha: string | null;
  sandboxId: string | null;
  rootfsSnapshotId: string | null;
  dependencySnapshotId: string | null;
  checkpointSnapshotIds: string[];
  artifactRefs: string[];
  promotionPolicy: SandboxRuntimePromotionPolicy;
  permissions: Record<string, unknown>;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  archivedAt: string | null;
};
