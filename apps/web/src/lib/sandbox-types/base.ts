export type SandboxState = "creating" | "running" | "stopped" | "archived" | "deleted" | "error";

export type SandboxRuntimeDriver = "simulated-firecracker" | "remote-firecracker";

export type SandboxIntegrationProvider =
  | "google"
  | "slack"
  | "github"
  | "microsoft_teams"
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

export type SandboxSecretMetadata = {
  id: string;
  teamId: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  scope: "team" | "app" | "project" | "template";
  status: "active" | "revoked" | "deleted";
  secretRef: string;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  deletedAt: string | null;
  attachments?: Array<{
    envName: string;
    targetType: "sandbox" | "template" | "app" | "project" | "agent" | "replay";
    targetId: string;
    attachedAt: string;
    detachedAt: string | null;
  }>;
};

export type SandboxVolumeProvisionInput = {
  name?: string;
  mountPath?: string;
  storageGb?: number;
  deleteOnSandboxDelete?: boolean;
};

export type SandboxVolumeStatus = "creating" | "ready" | "deleting" | "deleted" | "error";

export type SandboxVolumeMountMode = "read_write" | "read_only";

export type SandboxVolumeWriterPolicy = "exclusive" | "shared";

export type SandboxVolumeMountStatus =
  | "requested"
  | "mounting"
  | "ready"
  | "unmounting"
  | "unmounted"
  | "error";

export type SandboxVolume = {
  id: string;
  teamId: string;
  name: string;
  status: SandboxVolumeStatus;
  storageBackend: "efs";
  storageRef: string;
  rootPath: string;
  quotaGb: number;
  usageBytes: number | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  metadata?: Record<string, unknown>;
};

export type SandboxVolumeMountInput = {
  volumeId?: string;
  name?: string;
  mountPath?: string;
  subpath?: string;
  mode?: SandboxVolumeMountMode;
  writerPolicy?: SandboxVolumeWriterPolicy;
  createIfMissing?: boolean;
  quotaGb?: number;
  storageGb?: number;
  deleteOnSandboxDelete?: boolean;
};

export type SandboxVolumeMount = {
  id: string;
  sandboxId: string;
  teamId: string;
  volumeId: string;
  name: string;
  mountPath: string;
  subpath: string | null;
  mode: SandboxVolumeMountMode;
  writerPolicy: SandboxVolumeWriterPolicy;
  status: SandboxVolumeMountStatus;
  mountedAt: string | null;
  unmountedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type SandboxVolumeCreateInput = {
  teamId?: string;
  name: string;
  quotaGb?: number;
  metadata?: Record<string, unknown>;
};

export type SandboxReservation = {
  id: string;
  status: "reserved" | "captured" | "released";
  reservedUsd: string;
  capturedUsd: string;
  mpp?: {
    mode: "simulated_poc" | "mpp_service_hook" | "mpp_session_hook";
    settlementRail: "tempo_usdce";
    reservationRef: string;
    sessionRef?: string | null;
    channelId?: string | null;
    depositUsd?: string | null;
    acceptedCumulativeUsd?: string | null;
    remainingUsd?: string | null;
    tickCount?: number;
    lastTickAt?: string | null;
    finalizedAt?: string | null;
    lastReceiptRef?: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type SandboxReceiptLineItem = {
  label: string;
  quantity: number;
  unit: string;
  unitPriceUsd: string;
  amountUsd: string;
};

export type SandboxReceipt = {
  id: string;
  sandboxId: string;
  reservationId: string;
  status: "captured" | "released";
  reason:
    | "stopped"
    | "deleted"
    | "archived"
    | "budget_exhausted"
    | "duration_exceeded"
    | "idle_timeout"
    | "manual_capture";
  totalUsd: string;
  durationSeconds: number;
  lineItems: SandboxReceiptLineItem[];
  mpp: {
    mode: "simulated_poc" | "mpp_service_hook" | "mpp_session_hook";
    settlementRail: "tempo_usdce";
    receiptRef: string;
    sessionRef?: string | null;
    channelId?: string | null;
    acceptedCumulativeUsd?: string | null;
    depositUsd?: string | null;
    remainingUsd?: string | null;
  };
  createdAt: string;
};
