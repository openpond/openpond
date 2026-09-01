import {
  ManagedTrainingRunEvidenceSchema,
  type ManagedTrainingRunEvidence,
} from "@openpond/contracts";
import type {
  TrainingJob,
  TrainingJobEvent,
  TrainingJobOutputs,
} from "openpond-sdk/training";

export function managedTrainingEvidenceFromPublic(input: {
  job: TrainingJob;
  events: TrainingJobEvent[];
  outputs: TrainingJobOutputs | null;
  syncedAt?: string;
}): ManagedTrainingRunEvidence {
  const trajectories = input.events.filter(
    (event) =>
      event.type === "rollout_metric"
      && event.data.metricKind === "rollout_trajectory",
  );
  const eligible = trajectories.filter(
    (event) => event.data.rewardEligible === true && finite(event.data.reward) !== null,
  );
  const rewards = eligible.flatMap((event) => {
    const reward = finite(event.data.reward);
    return reward === null ? [] : [reward];
  });
  const rewardMean = rewards.length
    ? rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length
    : null;
  const allocation = [...input.events]
    .reverse()
    .find((event) => event.type === "gpu_allocation_state");
  const checkpoint = [...(input.outputs?.outputs ?? [])]
    .reverse()
    .find((output) => output.kind === "adapter" || output.kind === "checkpoint");
  const evaluations = (input.outputs?.outputs ?? []).flatMap((output) => {
    if (output.kind !== "evaluation") return [];
    const kind = output.metadata.kind;
    if (kind !== "baseline" && kind !== "candidate") return [];
    return [{
      kind,
      policyVersion: nonnegativeInteger(output.metadata.policyVersion) ?? 0,
      score: finite(output.metadata.score),
      threshold: nonnegative(output.metadata.threshold),
      passed: typeof output.metadata.passed === "boolean" ? output.metadata.passed : null,
    }];
  });
  const canonicalPublication = record(checkpoint?.metadata.canonicalPublication);
  const gpuCount = nonnegativeInteger(allocation?.data.gpuCount);
  const durationSeconds = nonnegative(input.outputs?.receipt?.durationSeconds);
  const adapterDeltaNorm = [...input.events].reverse().flatMap((event) => [
    finite(event.data.adapterDeltaNorm),
    finite(event.data.parameterDeltaNorm),
  ]).find((value): value is number => value !== null) ?? null;
  return ManagedTrainingRunEvidenceSchema.parse({
    schemaVersion: "openpond.managedTrainingRunEvidence.v2",
    provider: "sandbox-managed-rl",
    providerRunId: input.job.id,
    state: input.job.state,
    progress: {
      targetOptimizerSteps: input.job.rolloutProgress.groupsTarget,
      committedOptimizerSteps: input.job.rolloutProgress.optimizerUpdatesApplied,
      skippedOptimizerSteps: input.job.rolloutProgress.optimizerUpdatesSkipped,
    },
    reward: {
      finalMean: rewardMean,
      variance: rewardMean === null
        ? null
        : rewards.reduce((sum, reward) => sum + (reward - rewardMean) ** 2, 0) / rewards.length,
      minimum: rewards.length ? Math.min(...rewards) : null,
      maximum: rewards.length ? Math.max(...rewards) : null,
      distinctValueCount: new Set(rewards).size,
      noSignalGroupCount: input.job.rolloutProgress.optimizerUpdatesSkipped,
      trajectoryCount: trajectories.length,
      eligibleTrajectoryCount: eligible.length,
    },
    usage: {
      inputTokens: sum(trajectories, "inputTokens"),
      outputTokens: sum(trajectories, "outputTokens"),
      environmentExecutions: trajectories.length,
    },
    resource: {
      provider: string(allocation?.data.provider) ?? "managed",
      gpuType: string(allocation?.data.gpuType),
      gpuCount,
      hourlyCostUsd: nonnegative(allocation?.data.hourlyCostUsd),
      durationSeconds,
      gpuSeconds: durationSeconds !== null && gpuCount !== null
        ? durationSeconds * gpuCount
        : null,
    },
    cost: {
      totalUsd: input.outputs?.receipt?.spendUsd ?? input.job.accruedSpendUsd,
    },
    checkpoint: checkpoint
      ? {
          id: checkpoint.id,
          policyVersion:
            nonnegativeInteger(checkpoint.metadata.policyVersion)
            ?? input.job.rolloutProgress.optimizerUpdatesApplied,
          sha256: checkpoint.contentHash,
          sizeBytes: checkpoint.sizeBytes,
        }
      : null,
    movement: { adapterDeltaNorm },
    evaluations,
    canonicalPublication: {
      state: string(canonicalPublication.state),
      artifactId: string(canonicalPublication.artifactId),
    },
    syncedAt: input.syncedAt ?? new Date().toISOString(),
  });
}

function sum(events: TrainingJobEvent[], key: string): number {
  return events.reduce((total, event) => total + (nonnegative(event.data[key]) ?? 0), 0);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegative(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const parsed = nonnegative(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
