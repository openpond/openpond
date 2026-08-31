export type ManagedTrainingAccess = {
  apiBaseUrl: string;
  token: string;
  teamId: string;
};

export type ManagedTrainingJob = {
  id: string;
  state: string;
  version: number;
  completedGroups?: number;
  targetGroups?: number;
  optimizerUpdatesApplied?: number;
  optimizerUpdatesSkipped?: number;
  terminalReason?: string | null;
  createdAt: string;
  updatedAt: string;
  resources?: Array<{
    kind: string;
    state: string;
    metadata: Record<string, unknown>;
  }>;
  inputBundle?: {
    rewardModelTraining?: Record<string, unknown>;
    harnessRelease?: { contentHash?: string };
    harnessRunManifest?: {
      runtimeTarget?: { placement?: string };
    } & Record<string, unknown>;
  };
  cleanupAttestation?: unknown;
};

type LocalTrainingEventType =
  | "queued"
  | "start"
  | "progress"
  | "metric"
  | "checkpoint"
  | "cancel"
  | "complete"
  | "failure"
  | "reconcile";

export function localTrainingEventType(event: {
  type: string;
  phase: string;
  data: Record<string, unknown>;
}): LocalTrainingEventType {
  if (typeof event.data.metricKind === "string") return "metric";
  if (event.type.includes("checkpoint")) return "checkpoint";
  if (event.type === "provision_gpu" || event.type === "start_inference") return "start";
  if (event.type === "cancel" || event.type === "stop") return "cancel";
  if (event.type === "complete") return "complete";
  if (event.type === "failure") return "failure";
  return "progress";
}
