import type {
  SandboxCreateInput,
  SandboxCreateResponse,
  SandboxGitPatchExport,
  SandboxRuntimeProfileId,
  SandboxRuntimeProfileSummary,
  SandboxWorkflowMode,
  SandboxWorkloadSourceInput,
} from "./index.js";

export type SandboxRuntimeStatus =
  | "created"
  | "materializing"
  | "running"
  | "waiting_for_user"
  | "paused"
  | "checkpointed"
  | "ready_for_review"
  | "promoting"
  | "promoted"
  | "archived"
  | "failed"
  | "expired";

export type SandboxRuntimePromotionPolicy =
  | "none"
  | "manual"
  | "auto_after_checks";

export type SandboxRuntimeActorType = "agent" | "user" | "service" | "schedule";

export type SandboxRuntimePermissions = {
  git: {
    read: boolean;
    writeSourceRef: boolean;
    promote: boolean;
  };
  snapshots: {
    create: boolean;
    restore: boolean;
    checkpoint: boolean;
  };
  artifacts: {
    read: boolean;
    write: boolean;
  };
  sandbox: {
    exec: boolean;
    lifecycle: boolean;
  };
};

export type SandboxRuntime = {
  id: string;
  teamId: string;
  ownerUserId: string;
  createdByUserId: string;
  projectId: string | null;
  agentId: string | null;
  workflowMode: SandboxWorkflowMode;
  status: SandboxRuntimeStatus;
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
  permissions: SandboxRuntimePermissions;
  runtimeProfileId: SandboxRuntimeProfileId;
  workspaceRoot: string;
  runtimeProfile: SandboxRuntimeProfileSummary;
  executionProfileId?: string | null;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  archivedAt: string | null;
};

export type SandboxRuntimeEvent = {
  id: string;
  runtimeId: string;
  teamId: string;
  sequence: number;
  actorType: SandboxRuntimeActorType;
  actorId: string;
  type: string;
  summary: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  payloadStorageKey: string | null;
  prevEventHash: string | null;
  eventHash: string;
  stateHash: string | null;
  commitSha: string | null;
  snapshotId: string | null;
  logRef: string | null;
  artifactRefs: string[];
  createdAt: string;
};

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
  runtimeProfileId?: SandboxRuntimeProfileId;
  workloadSource?: SandboxWorkloadSourceInput;
  promotionPolicy?: SandboxRuntimePromotionPolicy;
  metadata?: Record<string, unknown>;
};

export type SandboxRuntimeSandboxCreateInput = SandboxCreateInput;

export type SandboxRuntimeEventInput = {
  type: string;
  summary?: string | null;
  payload?: Record<string, unknown>;
  lifecycleHint?: Record<string, unknown>;
  commitSha?: string | null;
  snapshotId?: string | null;
  logRef?: string | null;
  artifactRefs?: string[];
};

export type SandboxRuntimeCheckpointInput = {
  name?: string;
  rootfsSnapshotId?: string;
  dependencySnapshotId?: string;
  artifactRefs?: string[];
  metadata?: Record<string, unknown>;
};

export type SandboxRuntimePromoteInput = {
  expectedTargetSha: string;
  validationState?: "pending" | "passed";
  summary?: string;
};

export type SandboxRuntimeSourcePreserveInput = {
  sandboxId?: string;
  message?: string;
};

export type SandboxRuntimeTransitionInput = {
  status: SandboxRuntimeStatus;
  expectedVersion: number;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type SandboxRuntimeListResponse = {
  runtimes: SandboxRuntime[];
};

export type SandboxRuntimeResponse = {
  runtime: SandboxRuntime;
};

export type SandboxRuntimeSandboxResponse = SandboxCreateResponse & {
  runtime: SandboxRuntime;
};

export type SandboxRuntimeEventResponse = {
  runtime: SandboxRuntime;
  event: SandboxRuntimeEvent;
};

export type SandboxRuntimeEventsResponse = {
  runtimeId: string;
  events: SandboxRuntimeEvent[];
};

export type SandboxRuntimePromoteResponse = {
  runtime: SandboxRuntime;
  promotedSha: string;
};

export type SandboxRuntimeSourcePreserveResponse = {
  runtime: SandboxRuntime;
  preservedSha: string | null;
  preserved: boolean;
  patch: SandboxGitPatchExport;
};
