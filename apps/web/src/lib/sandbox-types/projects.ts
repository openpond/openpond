import type {
  SandboxRuntimePromotionPolicy,
  SandboxWorkflowMode,
} from "./runtime";

export type SandboxProjectStatus = "active" | "disabled" | "archived";
export type SandboxProjectSourceType =
  | "github_repo"
  | "internal_repo"
  | "template"
  | "manual";

export type SandboxAgentStatus = "active" | "disabled" | "archived";
export type SandboxAgentTriggerType =
  | "manual"
  | "schedule"
  | "endpoint"
  | "background";
export type SandboxAgentEntrypointScope =
  | "entire_manifest"
  | "start"
  | "action"
  | "service"
  | "schedule";
export type SandboxAgentWorkflowIntent =
  | "one_off"
  | "scheduled"
  | "code_change"
  | "evaluation"
  | "integration_task";

export type SandboxAgentSelectedEntrypoint = {
  scope: SandboxAgentEntrypointScope;
  name: string | null;
};

export type SandboxProject = {
  id: string;
  teamId: string;
  createdByUserId: string;
  name: string;
  slug: string;
  description: string | null;
  status: SandboxProjectStatus;
  sourceType: SandboxProjectSourceType;
  sourceConfig: Record<string, unknown>;
  normalizedSourceIdentity: string;
  externalId: string | null;
  gitProvider: string | null;
  gitHost: string | null;
  gitOwner: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  defaultBranch: string | null;
  internalRepoPath: string | null;
  templateSourceProjectId: string | null;
  templateRepoUrl: string | null;
  templateBranch: string | null;
  templateRemoteSha: string | null;
  sandboxManifest: Record<string, unknown> | null;
  sandboxActionRegistry: Record<string, unknown> | null;
  sandboxManifestHash: string | null;
  sandboxManifestPath: string | null;
  sandboxManifestSyncedAt: string | null;
  sandboxManifestError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type SandboxActionCatalogEntry = {
  id: string;
  agentId?: string | null;
  sourceActionId?: string | null;
  name?: string | null;
  label?: string | null;
  description?: string | null;
  visibility?: string | null;
  inputSchema?: string | Record<string, unknown> | null;
  outputSchema?: string | Record<string, unknown> | null;
  approvalPolicy?: (Record<string, unknown> & {
    required?: boolean;
    risk?: "read" | "write" | "destructive";
  }) | null;
  artifactPolicy?: Record<string, unknown> | null;
  setupRequirements?: Record<string, unknown>[];
  implementation?: Record<string, unknown> | null;
  mcp?: Record<string, unknown> | null;
  schedulePolicy?: Record<string, unknown> | null;
  trace?: Record<string, unknown> | null;
  invokesModel?: boolean;
};

export type SandboxProjectUpsertInput = {
  teamId: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  status?: SandboxProjectStatus;
  sourceType: SandboxProjectSourceType;
  sourceConfig?: Record<string, unknown>;
  normalizedSourceIdentity?: string | null;
  externalId?: string | null;
  gitProvider?: string | null;
  gitHost?: string | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
  gitBranch?: string | null;
  defaultBranch?: string | null;
  internalRepoPath?: string | null;
  templateSourceProjectId?: string | null;
  templateRepoUrl?: string | null;
  templateBranch?: string | null;
  templateRemoteSha?: string | null;
  metadata?: Record<string, unknown>;
};

export type SandboxProjectSourceUploadEntry = {
  path: string;
  type: "file";
  contentsBase64: string;
};

export type SandboxProjectSourceUploadInput = {
  teamId: string;
  entries: SandboxProjectSourceUploadEntry[];
  branch?: string | null;
  commitMessage?: string | null;
};

export type SandboxAgent = {
  id: string;
  teamId: string;
  createdByUserId: string;
  name: string;
  slug: string;
  description: string | null;
  status: SandboxAgentStatus;
  projectId: string;
  workflowIntent: SandboxAgentWorkflowIntent | null;
  selectedEntrypoint: SandboxAgentSelectedEntrypoint;
  triggerType: SandboxAgentTriggerType;
  endpointPolicy: Record<string, unknown>;
  backgroundTaskPolicy: Record<string, unknown>;
  defaultWorkflowMode: SandboxWorkflowMode;
  defaultBranch: string | null;
  sourceRefOverride: string | null;
  defaultPromotionPolicy: SandboxRuntimePromotionPolicy;
  defaultResourcePolicy: Record<string, unknown>;
  defaultLifecyclePolicy: Record<string, unknown>;
  defaultCheckpointPolicy: Record<string, unknown>;
  requiredIntegrationRefs: string[];
  requiredEnvironmentVariableRefs: string[];
  schedulePolicy: Record<string, unknown>;
  externalId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type SandboxAgentUpsertInput = {
  teamId: string;
  projectId: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  status?: SandboxAgentStatus;
  workflowIntent?: SandboxAgentWorkflowIntent | null;
  selectedEntrypoint?: Partial<SandboxAgentSelectedEntrypoint> | null;
  triggerType?: SandboxAgentTriggerType;
  endpointPolicy?: Record<string, unknown>;
  backgroundTaskPolicy?: Record<string, unknown>;
  defaultWorkflowMode?: SandboxWorkflowMode;
  defaultBranch?: string | null;
  sourceRefOverride?: string | null;
  defaultPromotionPolicy?: SandboxRuntimePromotionPolicy;
  defaultResourcePolicy?: Record<string, unknown>;
  defaultLifecyclePolicy?: Record<string, unknown>;
  defaultCheckpointPolicy?: Record<string, unknown>;
  requiredIntegrationRefs?: string[];
  requiredEnvironmentVariableRefs?: string[];
  schedulePolicy?: Record<string, unknown>;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
};

export type SandboxAgentRun = {
  id: string;
  teamId: string;
  projectId: string;
  agentId: string;
  requestedByUserId: string;
  idempotencyKey: string | null;
  triggerType: SandboxAgentTriggerType;
  status: "queued" | "runtime_created" | "running" | "succeeded" | "failed" | "cancelled";
  runtimeId: string | null;
  sandboxId: string | null;
  selectedEntrypoint: SandboxAgentSelectedEntrypoint;
  sourceSummary?: Record<string, unknown> | null;
  actionSummary?: Record<string, unknown> | null;
  responseSummary?: Record<string, unknown> | null;
  traceSummary?: Record<string, unknown> | null;
  evalSummary?: Record<string, unknown> | null;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type SandboxAgentRunInput = {
  teamId: string;
  idempotencyKey?: string | null;
  targetProjectId?: string | null;
  targetProject?: { id: string } | null;
  triggerType?: SandboxAgentTriggerType;
  entrypoint?: SandboxAgentSelectedEntrypoint | null;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  workflowMode?: SandboxWorkflowMode;
};
