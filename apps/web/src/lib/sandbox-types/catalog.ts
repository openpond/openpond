import type { SandboxState } from "./base";
import type {
  SandboxArchiveRef,
  SandboxSnapshot,
  SandboxSnapshotReplayManifest,
  SandboxSnapshotReplayRetentionClass,
  SandboxSnapshotTemplate,
  SandboxSnapshotTemplateVisibility,
} from "./runtime";

export type SandboxSnapshotCatalogEntry = {
  id: string;
  kind: "snapshot" | "archive";
  sandboxId: string;
  sandboxState: SandboxState;
  sandboxRepo: string | null;
  teamId: string;
  projectId?: string | null;
  agentId?: string | null;
  name: string;
  snapshot: SandboxSnapshot | null;
  archive: SandboxArchiveRef | null;
  sizeGb: number | null;
  storage: SandboxArchiveRef["storage"] | "snapshot" | null;
  storageCost?: {
    sizeGb: number | null;
    retentionClass: SandboxSnapshotReplayRetentionClass | null;
    estimatedMonthlyUsd: string | null;
    pricingSource: "configured" | "not_configured";
  };
  template: SandboxSnapshotTemplate | null;
  replay?: SandboxSnapshotReplayManifest | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type SandboxTemplateCatalogEntry = {
  id: string;
  snapshotId: string;
  sandboxId: string;
  sandboxState: SandboxState;
  sandboxRepo: string | null;
  teamId: string;
  projectId: string | null;
  agentId: string | null;
  name: string;
  version: string;
  description: string | null;
  tags: string[];
  visibility: SandboxSnapshotTemplateVisibility;
  useCase: string | null;
  sizeGb: number | null;
  source?: {
    repo: string | null;
    ref: string | null;
    commitSha: string | null;
    projectId: string | null;
    agentId: string | null;
  };
  storageCost?: SandboxSnapshotCatalogEntry["storageCost"];
  replay: SandboxSnapshotReplayManifest;
  snapshot: SandboxSnapshot;
  createdAt: string;
};
