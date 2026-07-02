import type {
  SandboxBudget,
  SandboxEnvVarInput,
  SandboxIntegrationLeaseInput,
  SandboxQuotaPolicy,
  SandboxResources,
  SandboxVolumeProvisionInput,
} from "./index.js";
export type SandboxScheduleType = "rate" | "cron" | "once";
export type SandboxScheduleRuntimePolicy =
  | "run_and_stop"
  | "run_and_archive"
  | "run_and_delete"
  | "use_existing_running";
export type SandboxScheduleTargetKind = "action" | "command";
export type SandboxScheduleLifecycleStatus =
  | "active"
  | "completed"
  | "expired"
  | "max_runs_reached"
  | "stopped"
  | "failed"
  | "deleted";
export type SandboxScheduleSyncStatus =
  | "pending"
  | "syncing"
  | "synced"
  | "failed";
export type SandboxScheduleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";
export type SandboxScheduleRunCleanupStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped";
export type SandboxScheduleManagementSource = "api" | "ui" | "openpond.yaml";

export type SandboxScheduleTarget = {
  kind: SandboxScheduleTargetKind;
  actionName: string | null;
  command: string | null;
  requiresStart: boolean;
};

export type SandboxScheduleCreateInput = {
  teamId?: string;
  projectId?: string;
  agentId?: string;
  sourceSandboxId?: string;
  snapshotId?: string;
  templateId?: string;
  name: string;
  description?: string;
  scheduleType: SandboxScheduleType;
  scheduleExpression: string;
  timezone?: string;
  enabled?: boolean;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  maxRuns?: number | null;
  runtimePolicy?: SandboxScheduleRuntimePolicy;
  target?: Partial<SandboxScheduleTarget>;
  actionName?: string;
  command?: string;
  requiresStart?: boolean;
  budget?: Partial<SandboxBudget>;
  resources?: Partial<SandboxResources>;
  quotas?: Partial<SandboxQuotaPolicy>;
  lifecycle?: Record<string, unknown>;
  retentionPolicy?: Record<string, unknown>;
  env?: SandboxEnvVarInput[];
  integrationLeases?: SandboxIntegrationLeaseInput[];
  metadata?: Record<string, unknown>;
  managementSource?: SandboxScheduleManagementSource;
  manifestPath?: string;
};

export type SandboxScheduleUpdateInput = Partial<
  Omit<
    SandboxScheduleCreateInput,
    "teamId" | "sourceSandboxId" | "snapshotId" | "templateId"
  >
> & {
  description?: string | null;
};

export type SandboxScheduleRecord = {
  id: string;
  teamId: string;
  ownerUserId: string;
  createdByUserId: string;
  name: string;
  description: string | null;
  scheduleType: SandboxScheduleType;
  scheduleExpression: string;
  enabled: boolean;
  timezone: string | null;
  startAt: string | null;
  endAt: string | null;
  maxRuns: number | null;
  executionCount: number;
  lifecycleStatus: SandboxScheduleLifecycleStatus;
  lifecycleReason: string | null;
  runtimePolicy: SandboxScheduleRuntimePolicy;
  sourceSandboxId: string | null;
  snapshotId: string | null;
  templateId: string | null;
  target: SandboxScheduleTarget;
  budget: SandboxBudget | null;
  resources: SandboxResources | null;
  quotas: Partial<SandboxQuotaPolicy> | null;
  lifecycle: Record<string, unknown> | null;
  retentionPolicy: Record<string, unknown> | null;
  env: SandboxEnvVarInput[];
  integrationLeases: SandboxIntegrationLeaseInput[];
  metadata: Record<string, unknown>;
  managementSource: SandboxScheduleManagementSource;
  manifestPath: string | null;
  awsScheduleProvider: "eventbridge_scheduler" | null;
  awsScheduleName: string | null;
  awsScheduleArn: string | null;
  syncStatus: SandboxScheduleSyncStatus;
  syncError: string | null;
  syncRequestedAt: string | null;
  lastSyncedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: SandboxScheduleRunStatus | null;
  createdAt: string;
  updatedAt: string;
};

export type SandboxScheduleRun = {
  id: string;
  scheduleId: string;
  sandboxId: string | null;
  teamId: string;
  ownerUserId: string;
  idempotencyKey: string;
  status: SandboxScheduleRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  durationSeconds: number | null;
  totalUsd: string | null;
  receiptId: string | null;
  logRef: string | null;
  artifactRefs: string[];
  failureReason: string | null;
  cleanupStatus: SandboxScheduleRunCleanupStatus;
  stopPolicyApplied: SandboxScheduleRuntimePolicy | null;
  logs: string[];
  output: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SandboxForkInput = {
  snapshotId?: string;
  visibility?: "private" | "team";
  resources?: Partial<SandboxResources>;
  budget?: Partial<SandboxBudget>;
  env?: SandboxEnvVarInput[];
  networkPolicy?: Record<string, unknown>;
  quotas?: Partial<SandboxQuotaPolicy>;
  volumes?: SandboxVolumeProvisionInput[];
  integrationLeases?: SandboxIntegrationLeaseInput[];
  metadata?: Record<string, unknown>;
};

export type SandboxForkOptions = {
  async?: boolean;
};

export type SandboxTemplateLaunchInput = Omit<
  SandboxForkInput,
  "snapshotId"
> & {
  snapshotId?: string;
  templateName?: string;
  version?: string;
  useCase?: string;
  schedules?: SandboxScheduleCreateInput[];
};
