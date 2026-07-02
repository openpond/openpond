import type {
  OpenPondOrganization,
  OpenPondOrganizationMcpServer,
  OpenPondOrganizationMember,
  SandboxBillingStatus,
  SandboxBudget,
  SandboxCommand,
  SandboxCostSummary,
  SandboxFileEntry,
  SandboxFileRef,
  SandboxFileSearchMatch,
  SandboxGitBranch,
  SandboxGitCommit,
  SandboxGitDiff,
  SandboxGitPatchExport,
  SandboxGitRemoteOperation,
  SandboxGitStatus,
  SandboxIntegrationConnection,
  SandboxIntegrationLeaseInput,
  SandboxIntegrationLeaseRef,
  SandboxPreviewPort,
  SandboxPricingRateCard,
  SandboxProcess,
  SandboxPtySession,
  SandboxReceipt,
  SandboxRecord,
  SandboxScheduleRecord,
  SandboxScheduleRun,
  SandboxSnapshot,
  SandboxSnapshotValidationResult,
  SandboxTemplateBuildRecord,
  SandboxTemplateCatalogEntry,
} from "./index.js";
export type SandboxIntegrationConnectionsResponse = {
  teamId: string;
  connections: SandboxIntegrationConnection[];
};

export type SandboxIntegrationLeasesResponse = {
  sandbox: SandboxRecord;
  integrationLeases: SandboxIntegrationLeaseRef[];
};

export type SandboxExecResponse = {
  sandbox: SandboxRecord;
  command: SandboxCommand;
};

export type SandboxProcessStartResponse = {
  sandbox: SandboxRecord;
  process: SandboxProcess;
};

export type SandboxProcessListResponse = {
  sandbox: SandboxRecord;
  processes: SandboxProcess[];
};

export type SandboxProcessStatusResponse = {
  sandbox: SandboxRecord;
  process: SandboxProcess;
  output?: string;
  cursor?: number;
  completed?: boolean;
};

export type SandboxProcessStopResponse = {
  sandbox: SandboxRecord;
  process: SandboxProcess;
};

export type SandboxPtyStartResponse = {
  sandbox: SandboxRecord;
  pty: SandboxPtySession;
};

export type SandboxPtyListResponse = {
  sandbox: SandboxRecord;
  ptys: SandboxPtySession[];
};

export type SandboxPtyStatusResponse = {
  sandbox: SandboxRecord;
  pty: SandboxPtySession;
  output?: string;
  cursor?: number;
  completed?: boolean;
};

export type SandboxPtyInputResponse = {
  sandbox: SandboxRecord;
  pty: SandboxPtySession;
};

export type SandboxPtyStopResponse = {
  sandbox: SandboxRecord;
  pty: SandboxPtySession;
};

export type SandboxOpenPortResponse = {
  sandbox: SandboxRecord;
  preview: SandboxPreviewPort;
};

export type SandboxSnapshotResponse = {
  sandbox: SandboxRecord;
  snapshot: SandboxSnapshot;
};

export type SandboxSnapshotValidationResponse = {
  sandbox: SandboxRecord;
  snapshot: SandboxSnapshot;
  validation: SandboxSnapshotValidationResult;
};

export type SandboxForkResponse = {
  sandbox: SandboxRecord;
  sourceSandbox: SandboxRecord;
  snapshot: SandboxSnapshot | null;
};

export type SandboxTemplateLaunchResponse = SandboxForkResponse & {
  template: SandboxTemplateCatalogEntry;
  schedules?: SandboxScheduleRecord[];
};

export type SandboxPublishedSnapshotLaunchResponse =
  SandboxTemplateLaunchResponse & {
    publishedSnapshot: SandboxTemplateCatalogEntry;
  };

export type SandboxScheduleListResponse = {
  schedules: SandboxScheduleRecord[];
};

export type SandboxScheduleResponse = {
  schedule: SandboxScheduleRecord;
};

export type SandboxScheduleRunListResponse = {
  runs: SandboxScheduleRun[];
};

export type SandboxScheduleRunResponse = {
  schedule: SandboxScheduleRecord;
  run: SandboxScheduleRun;
};

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
};

export type SandboxReplayListResponse = {
  replays: SandboxReplayRecord[];
};

export type SandboxReplayLogsResponse = {
  replayId: string;
  logs: string[];
};

export type SandboxReplayArtifactsResponse = {
  replayId: string;
  artifacts: SandboxReplayArtifact[];
};

export type SandboxTemplateBuildResponse = {
  build: SandboxTemplateBuildRecord;
};

export type SandboxPublishedSnapshotBuildResponse =
  SandboxTemplateBuildResponse;

export type SandboxTemplateBuildListResponse = {
  builds: SandboxTemplateBuildRecord[];
};

export type SandboxPublishedSnapshotBuildListResponse =
  SandboxTemplateBuildListResponse;

export type SandboxTemplateBuildLogsResponse = {
  buildId: string;
  logs: string[];
};

export type SandboxPublishedSnapshotBuildLogsResponse =
  SandboxTemplateBuildLogsResponse;

export type OpenPondOrganizationsResponse = {
  organizations: OpenPondOrganization[];
};

export type OpenPondOrganizationResponse = {
  organization: OpenPondOrganization;
};

export type OpenPondOrganizationMembersResponse = {
  members: OpenPondOrganizationMember[];
};

export type OpenPondOrganizationMemberResponse = {
  member: OpenPondOrganizationMember;
};

export type OpenPondOrganizationMcpServerResponse = {
  mcpServer: OpenPondOrganizationMcpServer | null;
};

export type SandboxReceiptResponse = {
  sandbox: SandboxRecord;
  receipt: SandboxReceipt;
};

export type SandboxLifecycleAcceptedResponse = {
  accepted: true;
  operation: "archive" | "delete" | "stop";
  sandbox: SandboxRecord;
};

export type SandboxStartResponse = {
  sandbox: SandboxRecord;
};

export type SandboxRestoreResponse = {
  sandbox: SandboxRecord;
};

export type SandboxReceiptsResponse = {
  receipts: SandboxReceipt[];
};

export type SandboxLogsResponse = {
  logs: string[];
};

export type SandboxGitStatusResponse = {
  sandbox: SandboxRecord;
  status: SandboxGitStatus;
};

export type SandboxGitDiffResponse = {
  sandbox: SandboxRecord;
  diff: SandboxGitDiff;
};

export type SandboxGitPatchExportResponse = {
  sandbox: SandboxRecord;
  patch: SandboxGitPatchExport;
};

export type SandboxGitBranchResponse = {
  sandbox: SandboxRecord;
  branch: SandboxGitBranch;
};

export type SandboxGitCommitResponse = {
  sandbox: SandboxRecord;
  commit: SandboxGitCommit;
};

export type SandboxGitPullResponse = {
  sandbox: SandboxRecord;
  pull: SandboxGitRemoteOperation;
};

export type SandboxGitPushResponse = {
  sandbox: SandboxRecord;
  push: SandboxGitRemoteOperation;
};

export type SandboxFileUploadResponse = {
  sandbox: SandboxRecord;
  file: SandboxFileRef;
};

export type SandboxFileDownloadResponse = {
  sandbox: SandboxRecord;
  file: SandboxFileRef & {
    contentsBase64: string;
    offsetBytes: number;
    returnedBytes: number;
    totalSizeBytes: number;
    truncated: boolean;
  };
};

export type SandboxFileListResponse = {
  sandbox: SandboxRecord;
  files: SandboxFileEntry[];
};

export type SandboxFileDeleteResponse = {
  sandbox: SandboxRecord;
  deleted: {
    path: string;
  };
};

export type SandboxFileMkdirResponse = {
  sandbox: SandboxRecord;
  directory: SandboxFileEntry;
};

export type SandboxFileMoveResponse = {
  sandbox: SandboxRecord;
  moved: {
    fromPath: string;
    toPath: string;
  };
  file: SandboxFileEntry;
};

export type SandboxFileStatResponse = {
  sandbox: SandboxRecord;
  file: SandboxFileEntry;
};

export type SandboxFileSearchResponse = {
  sandbox: SandboxRecord;
  matches: SandboxFileSearchMatch[];
};

export type SandboxBillingStatusResponse = {
  sandbox: SandboxRecord;
  billing: SandboxBillingStatus;
};

export type SandboxPricingResponse = {
  pricing: SandboxPricingRateCard;
};

export type SandboxCostSummaryResponse = {
  costs: SandboxCostSummary;
};
