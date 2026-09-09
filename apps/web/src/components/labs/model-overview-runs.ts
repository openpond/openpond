import { ManagedTrainingRunEvidenceSchema } from "@openpond/contracts";
import type { RunEntry } from "./LabModelWorkspace";
import { resolveRunStatus } from "./LabRunStatusBadge";

export type ModelOverviewRun = {
  key: string;
  kind: string;
  label: string;
  status: string;
  updatedAt: string;
  reward: number | null;
  completion: number | null;
  durationMinutes: number | null;
  spendCeiling: number | null;
  evaluation: { score: number; baseline: number | null; passRate: boolean; retentionPassed: boolean | null } | null;
};

/** Consume the same deduplicated run entries as the normal Runs list. */
export function modelOverviewRuns(entries: RunEntry[]): ModelOverviewRun[] {
  return entries.map(({ key, job, lifecycleRun: run }) => {
    const evidence = ManagedTrainingRunEvidenceSchema.safeParse(job?.metadata.managedTrainingEvidence).data;
    const kind = run?.kind ?? "training";
    const method = run?.method ?? job?.metadata.trainingMethod;
    const updatedAt = run?.updatedAt ?? job!.updatedAt;
    const start = run?.startedAt ?? job?.startedAt;
    const end = run?.completedAt ?? job?.completedAt ?? updatedAt;
    const duration = start ? Date.parse(end) - Date.parse(start) : NaN;
    const progress = run?.evaluationProgress;
    const completed = progress?.completedAttempts ?? finite(job?.metadata.completedGroups);
    const target = progress?.totalAttempts ?? finite(job?.metadata.targetGroups);
    const receipt = run?.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1" ? run.receipt : null;
    const candidate = evidence?.evaluations.find(item => item.kind === "candidate");
    const baseline = evidence?.evaluations.find(item => item.kind === "baseline");
    return {
      key, kind, status: resolveRunStatus({ job, lifecycleRun: run }), updatedAt,
      label: kind === "evaluation" ? "Evaluation" : kind === "rollout_smoke" ? "Preflight rollout" : typeof method === "string" ? `${method.toUpperCase()} training` : "Training",
      reward: run?.reward?.raw ?? evidence?.reward.finalMean ?? null,
      completion: completed !== null && target !== null && target > 0 ? completed / target : null,
      durationMinutes: Number.isFinite(duration) && duration >= 0 ? duration / 60_000 : null,
      spendCeiling: run?.quote?.maximumSpendUsd ?? finite(job?.metadata.spendCapUsd),
      evaluation: receipt ? { score: receipt.quality.candidatePassRate, baseline: receipt.quality.baselinePassRate, passRate: true, retentionPassed: receipt.quality.heldOutCandidatePassed }
        : candidate?.score != null ? { score: candidate.score, baseline: baseline?.score ?? null, passRate: false, retentionPassed: null } : null,
    };
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
