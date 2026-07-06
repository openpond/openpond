import type {
  SandboxBudget,
  SandboxQuotaPolicy,
  SandboxReceipt,
  SandboxReservation,
  SandboxResources,
  SandboxRuntimeDriver,
  SandboxState,
  SandboxVolumeMount,
} from "./base";
import type {
  SandboxArchiveRef,
  SandboxCommand,
  SandboxIntegrationLeaseRef,
  SandboxPreviewPort,
  SandboxProcess,
  SandboxPtySession,
  SandboxSnapshot,
} from "./runtime";

export type SandboxRecord = {
  id: string;
  state: SandboxState;
  runtimeDriver: SandboxRuntimeDriver;
  repo: string | null;
  repoRef?: string | null;
  sourceCommitSha?: string | null;
  teamId: string;
  projectId: string | null;
  agentId: string | null;
  runtimeId?: string | null;
  visibility: "private" | "team";
  ownerUserId: string;
  billingAccountId: string;
  resources: SandboxResources;
  budget: SandboxBudget;
  quotas?: SandboxQuotaPolicy;
  reservation: SandboxReservation;
  commands: SandboxCommand[];
  processes?: SandboxProcess[];
  ptySessions?: SandboxPtySession[];
  integrationLeases?: SandboxIntegrationLeaseRef[];
  volumeMounts?: SandboxVolumeMount[];
  previewPorts: SandboxPreviewPort[];
  snapshots?: SandboxSnapshot[];
  archive?: SandboxArchiveRef | null;
  receipts: SandboxReceipt[];
  logs: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  archivedAt?: string | null;
  deletedAt: string | null;
};

export type SandboxAccountSummary = {
  label: string;
  handle: string | null;
  baseUrl: string | null;
  sandboxApiUrl: string;
  state: "signed_out" | "signed_in" | "loading" | "switching" | "auth_error";
};
