import type {
  SandboxBudget,
  SandboxEnvVarInput,
  SandboxIntegrationConnection,
  SandboxReceipt,
  SandboxResources,
  SandboxSecretMetadata,
  SandboxVolume,
  SandboxVolumeMountInput,
} from "./base";
import type { SandboxSnapshotCatalogEntry, SandboxTemplateCatalogEntry } from "./catalog";
import type { SandboxAgent, SandboxAgentRun, SandboxProject } from "./projects";
import type { SandboxAccountSummary, SandboxRecord } from "./record";
import type {
  SandboxBillingStatus,
  SandboxCommand,
  SandboxFileEntry,
  SandboxFileRef,
  SandboxFileSearchMatch,
  SandboxGitBranch,
  SandboxGitCommit,
  SandboxGitDiff,
  SandboxGitRemoteOperation,
  SandboxGitStatus,
  SandboxIntegrationConnectionLeaseInput,
  SandboxIntegrationLeaseInput,
  SandboxIntegrationLeaseRef,
  SandboxPreviewPort,
  SandboxProcess,
  SandboxPtySession,
  SandboxRuntimeRecord,
  SandboxSnapshot,
  SandboxSnapshotValidationResult,
} from "./runtime";

export type SandboxSecretListResponse = {
  secrets: SandboxSecretMetadata[];
  account?: SandboxAccountSummary;
};

export type SandboxSecretResponse = {
  secret: SandboxSecretMetadata;
  account?: SandboxAccountSummary;
};

export type SandboxProjectListResponse = {
  projects: SandboxProject[];
  account?: SandboxAccountSummary;
};

export type SandboxProjectResponse = {
  project: SandboxProject;
  account?: SandboxAccountSummary;
};

export type SandboxAgentListResponse = {
  agents: SandboxAgent[];
  account?: SandboxAccountSummary;
};

export type SandboxAgentResponse = {
  agent: SandboxAgent;
  account?: SandboxAccountSummary;
};

export type SandboxAgentRunResponse = {
  agent: SandboxAgent;
  run: SandboxAgentRun;
  sandbox?: SandboxRecord | null;
  account?: SandboxAccountSummary;
};

export type SandboxListResponse = {
  sandboxes: SandboxRecord[];
  account: SandboxAccountSummary;
};

export type SandboxVolumeListResponse = {
  volumes: SandboxVolume[];
  account: SandboxAccountSummary;
};

export type SandboxVolumeResponse = {
  volume: SandboxVolume;
  account: SandboxAccountSummary;
};

export type SandboxSnapshotCatalogResponse = {
  snapshots: SandboxSnapshotCatalogEntry[];
  account: SandboxAccountSummary;
};

export type SandboxTemplateCatalogResponse = {
  templates: SandboxTemplateCatalogEntry[];
  account: SandboxAccountSummary;
};

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

export type SandboxTemplateBuildResponse = {
  build: SandboxTemplateBuildRecord;
  account: SandboxAccountSummary;
};

export type SandboxTemplateBuildListResponse = {
  builds: SandboxTemplateBuildRecord[];
  account: SandboxAccountSummary;
};

export type SandboxTemplateBuildLogsResponse = {
  buildId: string;
  logs: string[];
  account: SandboxAccountSummary;
};

export type SandboxIntegrationConnectionsResponse = {
  teamId: string;
  connections: SandboxIntegrationConnection[];
  account: SandboxAccountSummary;
};

export type SandboxRecordResponse = {
  sandbox: SandboxRecord;
  account: SandboxAccountSummary;
};

export type SandboxRuntimeResponse = {
  runtime: SandboxRuntimeRecord;
  account: SandboxAccountSummary;
};

export type SandboxRuntimeSandboxResponse = SandboxRecordResponse & {
  runtime: SandboxRuntimeRecord;
};

export type SandboxSnapshotResponse = SandboxRecordResponse & {
  snapshot: SandboxSnapshot;
};

export type SandboxSnapshotValidationResponse = SandboxSnapshotResponse & {
  validation: SandboxSnapshotValidationResult;
};

export type SandboxIntegrationLeasesResponse = SandboxRecordResponse & {
  integrationLeases: SandboxIntegrationLeaseRef[];
};

export type SandboxExecResponse = SandboxRecordResponse & {
  command: SandboxCommand;
};

export type SandboxProcessStartResponse = SandboxRecordResponse & {
  process: SandboxProcess;
};

export type SandboxProcessListResponse = SandboxRecordResponse & {
  processes: SandboxProcess[];
};

export type SandboxProcessStatusResponse = SandboxRecordResponse & {
  process: SandboxProcess;
  output?: string;
  cursor?: number;
  completed?: boolean;
};

export type SandboxProcessStopResponse = SandboxRecordResponse & {
  process: SandboxProcess;
};

export type SandboxPtyStartResponse = SandboxRecordResponse & {
  pty: SandboxPtySession;
};

export type SandboxPtyListResponse = SandboxRecordResponse & {
  ptys: SandboxPtySession[];
};

export type SandboxPtyStatusResponse = SandboxRecordResponse & {
  pty: SandboxPtySession;
  output?: string;
  cursor?: number;
  completed?: boolean;
};

export type SandboxPtyInputResponse = SandboxRecordResponse & {
  pty: SandboxPtySession;
};

export type SandboxPtyStopResponse = SandboxRecordResponse & {
  pty: SandboxPtySession;
};

export type SandboxOpenPortResponse = SandboxRecordResponse & {
  preview: SandboxPreviewPort;
};

export type SandboxReceiptResponse = SandboxRecordResponse & {
  receipt: SandboxReceipt;
};

export type SandboxReceiptsResponse = {
  receipts: SandboxReceipt[];
  account: SandboxAccountSummary;
};

export type SandboxLogsResponse = {
  logs: string[];
  account: SandboxAccountSummary;
};

export type SandboxGitStatusResponse = SandboxRecordResponse & {
  status: SandboxGitStatus;
};

export type SandboxGitDiffResponse = SandboxRecordResponse & {
  diff: SandboxGitDiff;
};

export type SandboxGitBranchResponse = SandboxRecordResponse & {
  branch: SandboxGitBranch;
};

export type SandboxGitCommitResponse = SandboxRecordResponse & {
  commit: SandboxGitCommit;
};

export type SandboxGitPullResponse = SandboxRecordResponse & {
  pull: SandboxGitRemoteOperation;
};

export type SandboxGitPushResponse = SandboxRecordResponse & {
  push: SandboxGitRemoteOperation;
};

export type SandboxFileListResponse = SandboxRecordResponse & {
  files: SandboxFileEntry[];
};

export type SandboxFileUploadResponse = SandboxRecordResponse & {
  file: SandboxFileRef;
};

export type SandboxFileDownloadResponse = SandboxRecordResponse & {
  file: SandboxFileRef & {
    contentsBase64: string;
    offsetBytes: number;
    returnedBytes: number;
    totalSizeBytes: number;
    truncated: boolean;
  };
};

export type SandboxFileSearchResponse = SandboxRecordResponse & {
  matches: SandboxFileSearchMatch[];
};

export type SandboxFileDeleteResponse = SandboxRecordResponse & {
  deleted: {
    path: string;
  };
};

export type SandboxFileMkdirResponse = SandboxRecordResponse & {
  directory: SandboxFileEntry;
};

export type SandboxFileMoveResponse = SandboxRecordResponse & {
  moved: {
    fromPath: string;
    toPath: string;
  };
  file: SandboxFileEntry;
};

export type SandboxFileStatResponse = SandboxRecordResponse & {
  file: SandboxFileEntry;
};

export type SandboxBillingStatusResponse = SandboxRecordResponse & {
  billing: SandboxBillingStatus;
};

export type CreateSandboxRequest = {
  repo?: string;
  teamId?: string;
  projectId?: string;
  agentId?: string;
  visibility?: "private" | "team";
  resources?: Partial<SandboxResources>;
  budget?: Partial<SandboxBudget>;
  env?: SandboxEnvVarInput[];
  networkPolicy?: Record<string, unknown>;
  quotas?: {
    maxDurationSeconds?: number;
    idleTimeoutSeconds?: number;
    maxCommands?: number;
    maxOpenPorts?: number;
    maxSnapshots?: number;
    maxSpendUsd?: string;
  };
  volumes?: SandboxVolumeMountInput[];
  integrationLeases?: SandboxIntegrationLeaseInput[];
  integrationConnectionLeases?: SandboxIntegrationConnectionLeaseInput[];
  metadata?: Record<string, unknown>;
};

export type ForkSandboxRequest = {
  snapshotId?: string;
  visibility?: "private" | "team";
  resources?: Partial<SandboxResources>;
  budget?: Partial<SandboxBudget>;
  env?: SandboxEnvVarInput[];
  networkPolicy?: Record<string, unknown>;
  quotas?: {
    maxDurationSeconds?: number;
    idleTimeoutSeconds?: number;
    maxCommands?: number;
    maxOpenPorts?: number;
    maxSnapshots?: number;
    maxSpendUsd?: string;
  };
  volumes?: SandboxVolumeMountInput[];
  integrationLeases?: SandboxIntegrationLeaseInput[];
  metadata?: Record<string, unknown>;
};

export type ForkSandboxSnapshotRequest = ForkSandboxRequest & {
  teamId?: string;
  projectId?: string;
};

export type LaunchSandboxTemplateRequest = Omit<ForkSandboxRequest, "snapshotId"> & {
  snapshotId?: string;
  templateName?: string;
  version?: string;
  useCase?: string;
  teamId?: string;
  projectId?: string;
};

export type SandboxForkResponse = SandboxRecordResponse & {
  sourceSandbox: SandboxRecord;
  snapshot: SandboxSnapshot | null;
};

export type SandboxTemplateLaunchResponse = SandboxForkResponse & {
  template: SandboxTemplateCatalogEntry;
};
