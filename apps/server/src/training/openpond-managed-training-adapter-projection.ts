import type { LearnedPreferenceRewardBinding } from "@openpond/contracts";
import type { ModelImprovementQualificationReceipt } from "@openpond/evals";
import type { TrainingJob as PublicTrainingJob } from "openpond-sdk/training";

import type { SqliteStore } from "../store/store.js";

export async function managedQualification(input: {
  store: SqliteStore;
  taskset: { metadata: Record<string, unknown> };
  qualificationRef: { id: string; contentHash: string } | null;
}): Promise<ModelImprovementQualificationReceipt | null> {
  if (!input.qualificationRef) return null;
  const lineage = input.taskset.metadata.harnessEvaluationLineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) return null;
  const review = (lineage as { review?: unknown }).review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const workspaceId = (review as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  const receipts = await input.store.listHarnessImprovementArtifacts(
    workspaceId,
    "training_qualification",
    1_000,
  ) as ModelImprovementQualificationReceipt[];
  return receipts.find((receipt) =>
    receipt.id === input.qualificationRef!.id &&
    receipt.contentHash === input.qualificationRef!.contentHash,
  ) ?? null;
}

export function dateString(value: string | Date): string {
  return new Date(value).toISOString();
}

export function toExecutionStatus(job: PublicTrainingJob) {
  const preparing = new Set(["queued", "admitting", "provisioning"]);
  const state =
    job.state === "succeeded"
      ? ("succeeded" as const)
      : job.state === "cancelled"
        ? ("cancelled" as const)
        : job.state === "failed"
          ? ("failed" as const)
          : job.state === "cancelling"
            ? ("cancelling" as const)
            : preparing.has(job.state)
              ? ("preparing" as const)
              : ("running" as const);
  return {
    runId: job.id,
    state,
    phase: job.state,
    progress: job.progress,
    rolloutProgress: job.rolloutProgress,
    updatedAt: dateString(job.updatedAt),
    errorCode:
      state === "failed"
        ? (job.terminalReason?.trim() || "managed_training_failed")
            .replace(/[^A-Za-z0-9_-]/g, "_")
            .slice(0, 191)
        : null,
  };
}

export function learnedRewardSource(binding: LearnedPreferenceRewardBinding) {
  return {
    kind: "learned_reward" as const,
    rewardModelVersion: binding.rewardModelVersion,
    qualificationReport: binding.qualificationReport,
    evaluationReferences: binding.evaluationReferences,
    scorerArtifact: {
      artifactRef: binding.checkpoint.objectRef,
      contentHash: binding.checkpoint.contentHash,
      executionReceipt: binding.executionReceipt,
    },
    processorRelease: binding.processorRelease,
    rewardComposerRelease: binding.rewardComposerRelease,
  };
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function managedJobFromPublic(job: PublicTrainingJob) {
  const state = job.state === "succeeded"
    ? "completed"
    : job.state === "queued" || job.state === "admitting"
      ? "admitted"
      : job.state === "provisioning"
        ? "provisioning_gpu"
        : job.state === "stopping"
          ? "stop_after_group"
          : job.state;
  return {
    id: job.id,
    state,
    version: job.version,
    completedGroups: job.rolloutProgress.groupsCompleted,
    targetGroups: job.rolloutProgress.groupsTarget,
    optimizerUpdatesApplied: job.rolloutProgress.optimizerUpdatesApplied,
    optimizerUpdatesSkipped: job.rolloutProgress.optimizerUpdatesSkipped,
    terminalReason: job.terminalReason,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

export function requiredStringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid.`);
  return value;
}

export function requiredHash(value: unknown, label: string): string {
  const parsed = requiredStringValue(value, label);
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

export function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function requiredRef(value: unknown, label: string) {
  const record = requiredRecord(value, label);
  return {
    id: requiredStringValue(record.id, `${label} id`),
    contentHash: requiredHash(record.contentHash, `${label} hash`),
  };
}
