import type { ModelRun, TrainingJob } from "@openpond/contracts";
import { TrainingExecutionRefSchema } from "@openpond/contracts";

export function isArtifactCollectionRecoveryTransition(existing: ModelRun, candidate: ModelRun, job: TrainingJob): boolean {
  const execution = TrainingExecutionRefSchema.safeParse(job.metadata.portableExecutionRef);
  if (existing.kind !== "training" || existing.status !== "failed" || existing.receipt !== null
    || candidate.status !== "succeeded" || candidate.receipt?.schemaVersion !== "openpond.modelRunReceipt.v1" || candidate.failure !== null
    || job.status !== "failed" || job.metadata.phase !== "artifact_collection_failed"
    || job.metadata.modelRunId !== existing.id || !execution.success
    || candidate.receipt.providerRunId !== (execution.data.providerJobId ?? execution.data.runId)
    || candidate.receipt.assignmentHash !== job.metadata.harnessRunManifestHash) return false;
  return JSON.stringify({ ...existing, status: candidate.status, receipt: candidate.receipt,
    adapterArtifactLineageId: candidate.adapterArtifactLineageId, failure: null,
    completedAt: candidate.completedAt, updatedAt: candidate.updatedAt }) === JSON.stringify(candidate);
}

export function isCheckpointResumeTransition(
  existing: ModelRun,
  candidate: ModelRun,
): boolean {
  if (
    existing.kind !== "evaluation"
    || !["failed", "cancelled"].includes(existing.status)
    || candidate.status !== "running"
    || candidate.receipt !== null
    || candidate.failure !== null
    || candidate.completedAt !== null
    || !existing.evaluation
  ) {
    return false;
  }
  const completedAdaptationAttempts = existing.evaluation.attemptPlan
    .filter((item) => item.stage === "baseline" || item.stage === "adaptation")
    .reduce((total, item) => total + item.attemptCount, 0);
  const completedAllAttempts = existing.evaluation.attemptPlan.reduce(
    (total, item) => total + item.attemptCount,
    0,
  );
  const candidateAdaptationPlan = existing.evaluation.attemptPlan.find(
    (item) => item.stage === "candidate_adaptation",
  );
  const completedCandidateAdaptationAttempts = completedAdaptationAttempts
    + (candidateAdaptationPlan?.attemptCount ?? 0);
  const checkpointIsDurable =
    (existing.evaluationProgress?.stage === "refiner"
      && existing.evaluationProgress.completedAttempts === completedAdaptationAttempts)
    || (existing.evaluationProgress?.stage === "candidate_adaptation"
      && existing.evaluationProgress.completedAttempts >= completedAdaptationAttempts
      && existing.evaluationProgress.completedAttempts
        <= completedCandidateAdaptationAttempts)
    || (["candidate_adaptation", "candidate", "comparison"].includes(
      existing.evaluationProgress?.stage ?? "",
    )
      && existing.evaluationProgress?.completedAttempts === completedAllAttempts);
  if (!checkpointIsDurable || !existing.evaluationProgress?.accounting) {
    return false;
  }
  return JSON.stringify({
    ...existing,
    status: "running",
    receipt: null,
    failure: null,
    completedAt: null,
    updatedAt: candidate.updatedAt,
  }) === JSON.stringify(candidate);
}
