export type SandboxState =
  | "creating"
  | "running"
  | "stopped"
  | "archived"
  | "deleted"
  | "error";

export type SandboxRuntimeDriver =
  | "simulated-firecracker"
  | "remote-firecracker";

export type SandboxResources = {
  cpu: number;
  memoryGb: number;
  diskGb: number;
};

export type SandboxBudget = {
  maxUsd: string;
};

export type SandboxEnvVarInput = {
  name: string;
  value?: string;
  secretRef?: string;
};

export type SandboxQuotaPolicy = {
  maxDurationSeconds: number;
  idleTimeoutSeconds: number;
  maxCommands: number;
  maxOpenPorts: number;
  maxSnapshots: number;
  maxSpendUsd: string;
};

export type SandboxVolumeProvisionInput = {
  name?: string;
  mountPath?: string;
  storageGb?: number;
  deleteOnSandboxDelete?: boolean;
};

export type SandboxIntegrationProvider =
  | "google"
  | "slack"
  | "github"
  | "x"
  | "notion"
  | "linear";

export type SandboxIntegrationConnectionStatus = "active" | "revoked" | "error";

export type SandboxIntegrationConnectionStatusFilter =
  | SandboxIntegrationConnectionStatus
  | "all";

export type SandboxIntegrationConnection = {
  id: string;
  provider: SandboxIntegrationProvider;
  ownerUserId: string;
  teamId: string;
  providerAccountId: string;
  providerAccountName: string | null;
  providerWorkspaceId: string | null;
  providerWorkspaceName: string | null;
  scopes: string[];
  status: SandboxIntegrationConnectionStatus;
  connectedAt: string;
  lastRefreshedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export type SandboxRuntimeImageSourceInput = {
  ref: string;
  digest?: string;
  registrySecretRef?: string;
  platform?: "linux/amd64";
  workspaceRoot?: string;
};

export type SandboxRuntimeDockerfileSourceInput = {
  context?: string;
  path?: string;
  target?: string;
  buildArgs?: Record<string, string>;
  registrySecretRefs?: string[];
  platform?: "linux/amd64";
  workspaceRoot?: string;
};

export type SandboxRuntimeSourceInput = {
  image?: SandboxRuntimeImageSourceInput;
  dockerfile?: SandboxRuntimeDockerfileSourceInput;
};

export type SandboxSourceArchiveEntry = {
  path: string;
  type: "directory" | "file";
  contentsBase64?: string;
};

export type SandboxCreateSourceArchive = {
  source?: "internal_project" | "template_repo" | "client_upload";
  ref?: string;
  commitSha?: string | null;
  archive: {
    version: 1;
    createdAt: string;
    entries: SandboxSourceArchiveEntry[];
    tarBase64?: string;
  };
};

export type SandboxCreateInput = {
  repo?: string;
  teamId?: string;
  projectId?: string;
  agentId?: string;
  runtimeProfileId?: import("./runtime-profiles.js").SandboxRuntimeProfileId;
  command?: string;
  visibility?: "private" | "team";
  resources?: Partial<SandboxResources>;
  budget?: Partial<SandboxBudget>;
  env?: SandboxEnvVarInput[];
  networkPolicy?: Record<string, unknown>;
  quotas?: Partial<SandboxQuotaPolicy>;
  volumes?: SandboxVolumeProvisionInput[];
  integrationLeases?: SandboxIntegrationLeaseInput[];
  integrationConnectionLeases?: SandboxIntegrationConnectionLeaseInput[];
  workloadSource?: SandboxRuntimeSourceInput;
  sourceArchive?: SandboxCreateSourceArchive;
  metadata?: Record<string, unknown>;
};

export type SandboxAsyncRequestOptions = {
  async?: boolean;
  respondAsync?: boolean;
  failOnUnpreservedChanges?: boolean;
};

export type SandboxCreateOptions = SandboxAsyncRequestOptions;
