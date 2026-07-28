import type { ReactNode } from "react";
import type {
  BaseModelCandidate,
  BaseModelPreference,
  ModelRunPreset,
  Taskset,
  TrainingDestinationCapabilities,
  TrainingDestinationId,
  TrainingPreparedStart,
  TrainingRecipe,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";

export type TrainingStartApproval = {
  exportApproved: boolean;
  maximumCostUsd: number | null;
  retentionDays: number | null;
  region: string | null;
};

export type TrainingStartDialogProps = {
  baseModelCandidates: BaseModelCandidate[];
  connection: ClientConnection | null;
  taskset: Taskset;
  modelId?: string | null;
  destinations: TrainingDestinationCapabilities[];
  initialMethod?: "sft" | "dpo" | "grpo" | "ppo";
  preferredBaseModel?: BaseModelPreference | null;
  busy: boolean;
  busyAction?: string | null;
  onClose: () => void;
  onStart: (
    destinationId: TrainingDestinationId,
    recipe: TrainingRecipe,
    approval: TrainingStartApproval,
  ) => Promise<boolean>;
  onPrepare: (
    destinationId: TrainingDestinationId,
    recipe: TrainingRecipe,
    approval: TrainingStartApproval,
  ) => Promise<TrainingPreparedStart | null>;
  onConfirmPrepared: (
    prepared: TrainingPreparedStart,
    maximumCostUsd: number,
  ) => Promise<boolean>;
  onOpenProviderSettings?: () => void;
  presentation?: "dialog" | "embedded";
  runControlId?: string;
  hideActions?: boolean;
  onReadinessChange?: (state: {
    ready: boolean;
    reason: string | null;
    actionLabel: string;
  }) => void;
  onConfigurationChange?: (configuration: {
    baseModel: BaseModelPreference | null;
    method: "sft" | "dpo" | "grpo" | "ppo";
    destinationId: TrainingDestinationId;
    recipe: TrainingRecipe;
    approval: TrainingStartApproval;
  }) => void;
  runPreset?: ModelRunPreset;
  hideMethodTabs?: boolean;
  approvalPresentation?: "inline" | "dialog";
  configurationContent?: ReactNode;
};
