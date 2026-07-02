import type {
  SandboxRecord,
  SandboxWorkflowMode,
  SandboxRuntimePromotionPolicy,
} from "./index.js";
export type OpenPondOrganizationRole = "owner" | "admin" | "member";

export type OpenPondOrganizationStatus = "active" | "disabled" | "archived";

export type OpenPondOrganization = {
  teamId: string;
  slug: string;
  name: string;
  displayName: string;
  role: OpenPondOrganizationRole;
  status: OpenPondOrganizationStatus;
  primaryContactEmail: string | null;
  customDomain: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpenPondOrganizationCreateInput = {
  displayName: string;
  slug?: string | null;
  primaryContactEmail?: string | null;
  customDomain?: string | null;
};

export type OpenPondOrganizationUpdateInput = Partial<
  OpenPondOrganizationCreateInput & {
    status: OpenPondOrganizationStatus;
  }
>;

export type OpenPondOrganizationMember = {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  role: OpenPondOrganizationRole;
  createdAt: string;
};

export type OpenPondOrganizationMemberUpsertInput = {
  email: string;
  role: OpenPondOrganizationRole;
};

export type OpenPondOrganizationMcpServerStatus =
  | "active"
  | "disabled"
  | "rotating";

export type OpenPondOrganizationMcpServer = {
  id: string;
  teamId: string;
  slug: string;
  displayName: string;
  resourceUrl: string;
  transportUrl: string;
  toolset: string[];
  status: OpenPondOrganizationMcpServerStatus;
  generatedByUserId: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpenPondOrganizationMcpGenerateInput = {
  origin?: string | null;
  toolset?: string[] | null;
};

export type SandboxProjectStatus = "active" | "disabled" | "archived";
export type SandboxProjectRole = "standard" | "profile";
export type SandboxProjectSourceVisibility = "private" | "public";
export type SandboxProjectSourceType =
  | "github_repo"
  | "internal_repo"
  | "template"
  | "manual";

export type SandboxAgentStatus = "active" | "disabled" | "archived";
export type SandboxAgentWorkflowIntent =
  | "one_off"
  | "scheduled"
  | "code_change"
  | "evaluation"
  | "integration_task";
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
export type SandboxAgentRunStatus =
  | "queued"
  | "runtime_created"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type SandboxAgentSourceCheckKind =
  | "validate"
  | "eval"
  | "publish_review"
  | "all";
export type SandboxAgentSourceCheckDispatchMode =
  | "request_only"
  | "coding_core";
export type SandboxAgentSourceProjectionStatus =
  | "missing_manifest"
  | "manifest_error"
  | "stale"
  | "needs_validation"
  | "ready";
export type SandboxAgentSourceProjectionReason =
  | "project_manifest_missing"
  | "project_manifest_hash_missing"
  | "project_action_registry_missing"
  | "project_manifest_error"
  | "source_ref_missing"
  | "source_commit_sha_missing"
  | "manifest_synced_at_missing"
  | "build_status_missing"
  | "build_status_not_passing"
  | "validation_status_missing"
  | "validation_status_not_passing"
  | "active_manifest_source_sha_mismatch"
  | "active_manifest_hash_mismatch";
export type SandboxAgentRuntimeSourceMode =
  | "latest_source"
  | "published_snapshot"
  | "auto";
export type SandboxAgentRuntimeSourcePolicySource =
  | "manual"
  | "schedule"
  | "endpoint"
  | "background"
  | "microsoft_teams"
  | "diagnostic";

export type SandboxAgentRuntimeSourceConfig = {
  mode: SandboxAgentRuntimeSourceMode;
  sourceRef: string | null;
  sourceCommitSha: string | null;
  publishedSnapshotId: string | null;
  publishedSnapshotName: string | null;
  publishedSnapshotVersion: string | null;
  buildStatus: string | null;
  validationStatus: string | null;
  validatedAt: string | null;
};

export type SandboxAgentResolvedRuntimeSource =
  SandboxAgentRuntimeSourceConfig & {
    resolvedMode: "latest_source" | "published_snapshot";
    policySource: SandboxAgentRuntimeSourcePolicySource;
    reason: string;
    resolvedAt: string;
  };

export type SandboxAgentRuntimeSourcePolicy = {
  requirePublishedSnapshot?: boolean;
  allowLatestSource?: boolean;
  source?: SandboxAgentRuntimeSourcePolicySource;
};

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
  role?: SandboxProjectRole;
  sourceVisibility?: SandboxProjectSourceVisibility;
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
  runtimeSource: SandboxAgentRuntimeSourceConfig;
  requiredIntegrationRefs: string[];
  requiredEnvironmentVariableRefs: string[];
  schedulePolicy: Record<string, unknown>;
  externalId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type SandboxAgentRun = {
  id: string;
  teamId: string;
  projectId: string;
  agentId: string;
  requestedByUserId: string;
  conversationId: string | null;
  idempotencyKey: string | null;
  triggerType: SandboxAgentTriggerType;
  status: SandboxAgentRunStatus;
  runtimeId: string | null;
  sandboxId: string | null;
  selectedEntrypoint: SandboxAgentSelectedEntrypoint;
  runtimeSource: SandboxAgentResolvedRuntimeSource | null;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type SandboxAgentManifestSnapshotProjection = {
  id: string | null;
  source: "agent_metadata" | "project_manifest";
  sourceRef: string | null;
  sourceCommitSha: string | null;
  manifestHash: string | null;
  manifestPath: string | null;
  manifestSyncedAt: string | null;
  buildStatus: string | null;
  validationStatus: string | null;
  evalStatus: string | null;
  publishedAt: string | null;
};

export type SandboxAgentManifestSnapshot = {
  id: string;
  teamId: string;
  projectId: string;
  agentId: string;
  sourceRef: string | null;
  sourceCommitSha: string | null;
  manifestHash: string;
  manifestPath: string | null;
  manifestSyncedAt: string | null;
  manifestJson: Record<string, unknown>;
  actionRegistryJson: Record<string, unknown> | null;
  inspectJson: Record<string, unknown> | null;
  buildStatus: string | null;
  validationStatus: string | null;
  evalStatus: string | null;
  workItemId: string | null;
  taskRunId: string | null;
  traceArtifactRef: string | null;
  evalResultArtifactRef: string | null;
  publishedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SandboxAgentSourceActionProjection = {
  name: string;
  command: string | null;
  description: string | null;
  visibility: string | null;
  timeoutSeconds: number | null;
  artifactPaths: string[];
};

export type SandboxAgentSourceChannelProjection = {
  id: string;
  targetAction: string | null;
  requiredConnections: string[];
  capabilities: string[];
  enabledByDefault: boolean;
};

export type SandboxAgentSourceIntegrationProjection = {
  provider: string;
  required: boolean;
  capabilities: string[];
  scopes: string[];
  models: string[];
};

export type SandboxAgentSourceVolumeProjection = {
  name: string;
  mountPath: string | null;
  storageGb: number | null;
  required: boolean;
  provisioningMode: string | null;
  stateEngine: string | null;
  uiLabel: string | null;
  uiDescription: string | null;
  allowUpload: boolean;
};

export type SandboxAgentSourceScheduleProjection = {
  name: string;
  action: string | null;
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
  enabledByDefault: boolean;
};

export type SandboxAgentSourceEditableProjection = {
  enabled: boolean;
  requiredChecks: string[];
  defaultResultMode: string | null;
  supportedResultModes: string[];
};

export type SandboxAgentSourceDeployPlanSource = {
  sourceRef: string | null;
  sourceCommitSha: string | null;
  manifestHash: string | null;
  manifestPath: string | null;
  manifestSyncedAt: string | null;
  activeSnapshotId: string | null;
  activeSnapshotSourceSha: string | null;
};

export type SandboxAgentSourceDeployPlanChecks = {
  setupCommands: string[];
  validationCommands: string[];
  requiredChecks: string[];
  evalNames: string[];
};

export type SandboxAgentSourceDeployPlan = {
  projectId: string;
  agentId: string;
  status: SandboxAgentSourceProjectionStatus;
  canRun: boolean;
  canDeploy: boolean;
  blockedReasons: SandboxAgentSourceProjectionReason[];
  staleReasons: SandboxAgentSourceProjectionReason[];
  source: SandboxAgentSourceDeployPlanSource;
  defaultEntrypoint: SandboxAgentSelectedEntrypoint;
  checks: SandboxAgentSourceDeployPlanChecks;
  actions: SandboxAgentSourceActionProjection[];
  channels: SandboxAgentSourceChannelProjection[];
  requiredIntegrations: SandboxAgentSourceIntegrationProjection[];
  optionalIntegrations: SandboxAgentSourceIntegrationProjection[];
  envRefs: string[];
  requiredVolumes: SandboxAgentSourceVolumeProjection[];
  optionalVolumes: SandboxAgentSourceVolumeProjection[];
  schedules: SandboxAgentSourceScheduleProjection[];
  artifactPaths: string[];
  editable: SandboxAgentSourceEditableProjection | null;
};

export type SandboxAgentSourceChecksRequestInput = {
  teamId: string;
  sourceRef?: string | null;
  baseSha?: string | null;
  checkKind?: SandboxAgentSourceCheckKind;
  dispatch?: SandboxAgentSourceCheckDispatchMode;
  metadata?: Record<string, unknown>;
};

export type SandboxCodingWorkItem = Record<string, unknown> & {
  id: string;
};

export type SandboxCodingWorkItemActivity = Record<string, unknown> & {
  id: string;
};

export type SandboxCodingWorkItemMessage = Record<string, unknown> & {
  id: string;
};

export type SandboxCodingWorkItemArtifact = Record<string, unknown> & {
  id: string;
  ref?: string | null;
  kind?: string | null;
};

export type SandboxAgentEditWorkItemOpenInput = {
  teamId: string;
  projectId: string;
  initialMessage?: string | null;
  sourceRef?: string | null;
  baseSha?: string | null;
  createPipelineRequest?: Record<string, unknown> | null;
  createPipeline?: Record<string, unknown> | null;
};

export type SandboxAgentEditWorkItemOpenResult = {
  workItem: SandboxCodingWorkItem;
  created: boolean;
  detail?: Record<string, unknown>;
};

export type SandboxCodingWorkItemChatInput = {
  teamId: string;
  message: string;
  mode?: "sync_cloud" | "queue_cloud";
  sourceRef?: string | null;
  baseSha?: string | null;
  payload?: Record<string, unknown>;
};

export type SandboxCodingWorkItemChatResult = Record<string, unknown> & {
  userMessage?: SandboxCodingWorkItemMessage;
  assistantMessage?: SandboxCodingWorkItemMessage;
  activity?: SandboxCodingWorkItemActivity;
};

export type SandboxCodingWorkItemBackgroundInput = {
  teamId: string;
  prompt?: string | null;
  sourceRef?: string | null;
  baseSha?: string | null;
  sourceRuntimeId?: string | null;
  sourceSandboxId?: string | null;
  agentId?: string | null;
  agentEdit?: Record<string, unknown> | null;
  setup?: { commands: string[] } | null;
  validation?: { commands: string[] } | null;
  branchPolicy?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
};

export type SandboxCodingWorkItemBackgroundResult = Record<string, unknown> & {
  workItem?: SandboxCodingWorkItem;
  activity?: SandboxCodingWorkItemActivity;
};

export type SandboxCodingWorkItemSourceCheckStatus = Record<string, unknown> & {
  workItemId: string;
  workItemStatus?: string | null;
  latestTaskRunId?: string | null;
  latestRuntimeId?: string | null;
  latestSandboxId?: string | null;
  sourceMaterialization?: Record<string, unknown> | null;
  setup?: Record<string, unknown> | null;
  policyDiscovery?: Record<string, unknown> | null;
  discoveredRequiredChecks?: string[];
  checkRuns?: Array<Record<string, unknown>>;
  validation?: Record<string, unknown> | null;
  eval?: Record<string, unknown> | null;
  requestedCheckKind?: string | null;
  deployPlan?: Record<string, unknown> | null;
  traceArtifactRefs?: string[];
  evalResultArtifactRefs?: string[];
  validatorArtifactRefs?: string[];
  patchArtifactRef?: string | null;
  draftSourceRef?: string | null;
  finalResultState?: string | null;
  publishBlockers?: string[];
};

export type SandboxCodingWorkItemStatusResult = {
  workItem: SandboxCodingWorkItem;
  activity: SandboxCodingWorkItemActivity[];
  sourceCheckStatus: SandboxCodingWorkItemSourceCheckStatus;
};

export type SandboxCodingWorkItemPromotionInput = {
  teamId: string;
  ref: string;
  metadata?: Record<string, unknown>;
};

export type SandboxCodingWorkItemActivityListInput = {
  teamId: string;
  limit?: number;
};

export type SandboxCodingWorkItemGetInput = {
  teamId: string;
  includeArchived?: boolean;
};

export type SandboxAgentSourceChecksRequestResult = {
  workItem: SandboxCodingWorkItem;
  createdEditWorkItem: boolean;
  activity: SandboxCodingWorkItemActivity;
  deployPlan: SandboxAgentSourceDeployPlan | null;
  dispatchResult?: {
    status: "not_requested" | "completed" | "failed";
    taskRun: Record<string, unknown> | null;
    error: string | null;
  };
};

export type SandboxAgentSourcePublishInput = {
  teamId: string;
  expectedManifestHash?: string | null;
  expectedSourceCommitSha?: string | null;
  evalStatus?: string | null;
  workItemId?: string | null;
  taskRunId?: string | null;
  traceArtifactRef?: string | null;
  evalResultArtifactRef?: string | null;
};

export type SandboxAgentSourcePublishResult = {
  agent: SandboxAgent;
  projection: Record<string, unknown>;
  activeManifestSnapshot: SandboxAgentManifestSnapshotProjection;
  publishedAt: string;
};

export type SandboxProjectUpsertInput = {
  teamId: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  status?: SandboxProjectStatus;
  role?: SandboxProjectRole;
  sourceVisibility?: SandboxProjectSourceVisibility;
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

export type SandboxProjectUpdateInput = { teamId: string } & Partial<
  Omit<SandboxProjectUpsertInput, "teamId">
>;

export type SandboxProjectSourceUploadEntry = {
  path: string;
  type: "file" | "directory";
  contentsBase64?: string;
};

export type SandboxProjectSourceUploadInput = {
  teamId: string;
  entries: SandboxProjectSourceUploadEntry[];
  branch?: string | null;
  commitMessage?: string | null;
};

export type SandboxProjectGitRemote = {
  repoUrl: string;
  uiUrl: string;
  teamSlug: string;
  projectSlug: string;
  defaultBranch: string;
};

export type SandboxProjectGitRemoteResponse = {
  project: SandboxProject;
  repo: SandboxProjectGitRemote;
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
  runtimeSource?: Partial<SandboxAgentRuntimeSourceConfig> | null;
  requiredIntegrationRefs?: string[];
  requiredEnvironmentVariableRefs?: string[];
  schedulePolicy?: Record<string, unknown>;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
};

export type SandboxAgentUpdateInput = { teamId: string } & Partial<
  Omit<SandboxAgentUpsertInput, "teamId">
>;

export type SandboxAgentRunInput = {
  teamId: string;
  conversationId?: string | null;
  idempotencyKey?: string | null;
  triggerType?: SandboxAgentTriggerType;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  workflowMode?: SandboxWorkflowMode;
  runtimeSourcePolicy?: SandboxAgentRuntimeSourcePolicy;
};

export type SandboxProjectListResponse = { projects: SandboxProject[] };
export type SandboxProjectResponse = { project: SandboxProject };
export type OpenPondHostedProfileAgent = {
  id: string;
  path: string;
  enabled: boolean;
};
export type OpenPondHostedProfileManifest = {
  schema: "openpond.profileRepo.v1";
  defaultProfile: string;
  profiles: Record<
    string,
    {
      path: string;
      defaultAgent: string;
      enabledAgents: string[];
    }
  >;
};
export type OpenPondHostedProfileSourceUpload = {
  sourceRef: string | null;
  sourceCommitSha: string | null;
  manifestHash: string | null;
  manifestPath: string | null;
  manifestSyncedAt: string | null;
};
export type OpenPondHostedProfilePushInput = {
  teamId: string;
  entries: SandboxProjectSourceUploadEntry[];
  branch?: string | null;
  commitMessage?: string | null;
  expectedSourceCommitSha?: string | null;
  localHeadSha?: string | null;
  manifest: OpenPondHostedProfileManifest;
  sourcePath: string;
  agents: OpenPondHostedProfileAgent[];
};
export type OpenPondHostedProfileSummary = {
  project: SandboxProject;
  manifest: OpenPondHostedProfileManifest;
  defaultProfile: string;
  sourcePath: string;
  agents: OpenPondHostedProfileAgent[];
  sourceUpload: OpenPondHostedProfileSourceUpload | null;
  seededAt: string | null;
  seedStatus: "pending_seed" | "seeded";
};
export type OpenPondHostedProfileResponse = {
  profile: OpenPondHostedProfileSummary | null;
};
export type OpenPondHostedProfilePushResponse = {
  profile: OpenPondHostedProfileSummary;
  sourceUpload: OpenPondHostedProfileSourceUpload;
  previousSourceCommitSha: string | null;
  localHeadSha: string | null;
};
export type SandboxAgentListResponse = { agents: SandboxAgent[] };
export type SandboxAgentResponse = { agent: SandboxAgent };
export type SandboxAgentRunResponse = {
  agent: SandboxAgent;
  run: SandboxAgentRun;
  sandbox?: SandboxRecord | null;
};
export type SandboxAgentSourceDeployPlanResponse = {
  deployPlan: SandboxAgentSourceDeployPlan;
};
export type SandboxAgentManifestSnapshotsResponse = {
  manifestSnapshots: SandboxAgentManifestSnapshot[];
};
