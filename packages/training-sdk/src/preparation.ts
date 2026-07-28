import {
  type ComputeTargetCapabilities,
  type TrainingEngineCapabilities,
  type TrainingPreparationPlan,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export function prepareTrainingSelection(input: {
  modelRunId: string;
  modelCached: boolean;
  modelBytes: number;
  engine: TrainingEngineCapabilities | null;
  compute: ComputeTargetCapabilities | null;
  manifest: {
    runtime: TrainingPreparationPlan["runtime"];
    compute: TrainingPreparationPlan["compute"];
    engine: TrainingPreparationPlan["engine"];
  };
  maximumSpendUsd: number | null;
  quoteUsd: number | null;
  retentionDays: number | null;
  providerManaged?: boolean;
}): TrainingPreparationPlan {
  const unsupported =
    input.engine && !input.engine.available
      ? input.engine.unavailableReason ?? "Training engine is unavailable."
      : !input.engine
        ? "Select a compatible training engine."
        : null;
  const state: TrainingPreparationPlan["state"] = unsupported
    ? "unsupported"
    : !input.compute || !input.compute.available
      ? "compute_setup_required"
      : input.providerManaged
        ? "provider_managed"
        : !input.modelCached
          ? "model_download_required"
          : "ready";
  const downloads: TrainingPreparationPlan["downloads"] = input.modelCached
    ? []
    : [{
        kind: "model",
        label: "Model weights",
        expectedBytes: input.modelBytes,
        digest: input.manifest.engine?.capabilityReceipt ?? "provider-managed",
        cached: false,
        state: "required",
        progress: null,
        cancellable: true,
        diskImpactBytes: input.modelBytes,
      }];
  const base = {
    schemaVersion: "openpond.trainingPreparationPlan.v1" as const,
    modelRunId: input.modelRunId,
    state,
    reason:
      unsupported ??
      (!input.compute || !input.compute.available
        ? input.compute?.unavailableReason ?? "Compute setup is required."
        : null),
    runtime: input.manifest.runtime,
    compute: input.manifest.compute,
    engine: input.manifest.engine,
    downloads,
    dataMovement: [],
    quoteUsd: input.quoteUsd,
    maximumSpendUsd: input.maximumSpendUsd,
    retentionDays: input.retentionDays,
    sideEffectsStarted: false as const,
  };
  return {
    ...base,
    contentHash: contentHash(base),
  };
}
