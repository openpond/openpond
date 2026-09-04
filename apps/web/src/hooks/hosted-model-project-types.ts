import type { PublicHostedModelProjectSummary } from "@openpond/contracts";

export type HostedModelProjectLocalState =
  | "not_pulled"
  | "up_to_date"
  | "remote_ahead"
  | "local_ahead"
  | "diverged"
  | "local_conflict";

export type HostedModelProjectCatalog = {
  teamId: string;
  projects: Array<{
    project: PublicHostedModelProjectSummary;
    localProjectId: string | null;
    localRevision: number | null;
    localState: HostedModelProjectLocalState;
  }>;
  generatedAt: string;
  cached: boolean;
};
