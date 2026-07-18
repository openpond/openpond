import {
  nextCreateImproveRunRevision,
  type CreateImproveRun,
  type GradeResult,
  type TaskAttemptResult,
  type TrainingStateResponse,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import { attachModelTargetRefs } from "../runtime/create-pipeline/target-adapters.js";
import type { SqliteStore } from "../store/store.js";

type ModelExecutionState = Pick<TrainingStateResponse, "jobs" | "models">;

export async function syncModelTrainingCreateImproveRuns(input: {
  store: SqliteStore;
  profileId: string;
  execution: ModelExecutionState;
}): Promise<void> {
  const runs = await input.store.listCreateImproveRuns({
    profileId: input.profileId,
    targetKind: "model",
    limit: 500,
  });
  const jobById = new Map(input.execution.jobs.map((job) => [job.id, job]));
  const modelByJobId = new Map(input.execution.models.map((model) => [model.jobId, model]));
  for (const storedRun of runs) {
    if (storedRun.target.kind !== "model") continue;
    const targetJobId = storedRun.target.trainingJobId;
    const tasksetRef = storedRun.tasksetRef;
    if (!targetJobId || !tasksetRef) continue;
    const modelTarget = storedRun.target;
    let run = storedRun;
    let candidateStateChanged = false;
    const reconciledCandidates = run.candidates.map((candidate) => {
      if (
        candidate.target.kind !== "model" ||
        !candidate.target.trainingJobId ||
        ["accepted", "rejected", "failed"].includes(candidate.status)
      ) {
        return candidate;
      }
      const candidateJob = jobById.get(candidate.target.trainingJobId);
      if (
        candidateJob?.status !== "failed" &&
        candidateJob?.status !== "cancelled"
      ) {
        return candidate;
      }
      candidateStateChanged = true;
      return {
        ...candidate,
        status: "failed" as const,
        updatedAt: candidateJob.updatedAt,
        metadata: {
          ...candidate.metadata,
          terminalJobStatus: candidateJob.status,
          terminalJobError: candidateJob.error,
        },
      };
    });
    if (candidateStateChanged) {
      run = nextCreateImproveRunRevision(run, {
        candidates: reconciledCandidates,
        updatedAt: new Date(
          Math.max(
            Date.parse(run.updatedAt),
            ...reconciledCandidates.map((candidate) =>
              Date.parse(candidate.updatedAt)),
          ),
        ).toISOString(),
      });
    }
    const job = jobById.get(targetJobId);
    if (!job) continue;
    if (job.status === "failed" || job.status === "cancelled") {
      if (run.state === "failed" || run.state === "cancelled") {
        if (candidateStateChanged) {
          await input.store.upsertCreateImproveRun(run);
        }
        continue;
      }
      await input.store.upsertCreateImproveRun(nextCreateImproveRunRevision(run, {
        state: job.status,
        blockedReason: job.error ?? `Training job ${job.id} was ${job.status}.`,
        externalExecutionRefs: run.externalExecutionRefs.map((ref) =>
          ref.kind === "training_job" && ref.id === job.id
            ? { ...ref, status: job.status }
            : ref),
        updatedAt: job.updatedAt,
      }));
      continue;
    }
    if (job.status !== "succeeded") continue;
    const model = modelByJobId.get(job.id);
    if (!model || model.status !== "imported") continue;
    const candidateReceiptId = `model_eval_${run.id}_${job.id}_candidate`;
    const activeReceiptId = `model_eval_${run.id}_${job.id}_active`;
    if (
      modelTarget.artifactId === model.artifactId &&
      run.evaluationReceipts.some((receipt) => receipt.id === activeReceiptId) &&
      run.evaluationReceipts.some((receipt) => receipt.id === candidateReceiptId) &&
      ["ready", "blocked"].includes(run.state) &&
      !candidateStateChanged &&
      Date.parse(run.updatedAt) >= Date.parse(job.updatedAt)
    ) continue;

    const taskset = await input.store.getTasksetRevision(
      tasksetRef.id,
      tasksetRef.revision,
      tasksetRef.contentHash,
    );
    if (!taskset) {
      await blockModelRun(input.store, run, `Approved Taskset ${tasksetRef.id} revision ${tasksetRef.revision} (${tasksetRef.contentHash}) is unavailable.`);
      continue;
    }
    if (model.tasksetId !== taskset.id || model.tasksetHash !== taskset.contentHash) {
      await blockModelRun(input.store, run, `Imported model ${model.id} does not match the approved Taskset revision.`);
      continue;
    }
    const [attempts, grades] = await Promise.all([
      input.store.listTaskAttempts(taskset.id),
      input.store.listGradeResultsForTaskset(taskset.id),
    ]);
    const jobAttempts = attempts.filter((attempt) =>
      attempt.metadata.jobId === job.id && attempt.split === "frozen_eval");
    const baseAttempts = jobAttempts.filter((attempt) => attempt.metadata.evaluationStage === "base");
    const candidateAttempts = jobAttempts.filter((attempt) => attempt.metadata.evaluationStage === "trained");
    const expectedTaskIds = taskset.tasks
      .filter((task) => task.split === "frozen_eval")
      .map((task) => task.id)
      .sort();
    const contractIssue = compareFrozenEvaluationContract(expectedTaskIds, baseAttempts, candidateAttempts);
    if (contractIssue) {
      await blockModelRun(input.store, run, contractIssue);
      continue;
    }
    const executionContractHash = contentHash({
      tasksetId: tasksetRef.id,
      tasksetRevision: tasksetRef.revision,
      tasksetHash: tasksetRef.contentHash,
      attempts: baseAttempts
        .map((attempt) => ({ taskId: attempt.taskId, split: attempt.split, attempt: attempt.attempt, seed: attempt.seed }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    });
    const evaluationInputs = [
      modelEvaluationSummary("active", baseAttempts, grades, executionContractHash),
      modelEvaluationSummary("candidate", candidateAttempts, grades, executionContractHash),
    ] as const;
    const infrastructureFailureCount = evaluationInputs.reduce(
      (total, evaluation) => total + evaluation.infrastructureFailureCount,
      0,
    );
    const evaluationComplete = infrastructureFailureCount === 0;
    let synchronized = attachModelTargetRefs({
      run,
      tasksetId: taskset.id,
      trainingPlanId: job.planId,
      trainingJobId: job.id,
      artifactId: model.artifactId,
      evaluations: [...evaluationInputs],
      completed:
        evaluationComplete &&
        evaluationInputs[1].total > 0 &&
        evaluationInputs[1].failed === 0,
      timestamp: job.updatedAt,
    });
    if (
      !evaluationComplete ||
      evaluationInputs[1].total === 0 ||
      evaluationInputs[1].failed > 0
    ) {
      synchronized = nextCreateImproveRunRevision(synchronized, {
        state: "blocked",
        blockedReason: !evaluationComplete
          ? `Frozen evaluation is inconclusive because ${infrastructureFailureCount} base or trained attempt${infrastructureFailureCount === 1 ? "" : "s"} failed in provider infrastructure. No model-quality result was recorded.`
          : evaluationInputs[1].total === 0
            ? "The trained model produced no trusted frozen-evaluation receipt."
            : `The trained model failed ${evaluationInputs[1].failed} of ${evaluationInputs[1].total} frozen-evaluation tasks.`,
        updatedAt: job.updatedAt,
      });
    }
    await input.store.upsertCreateImproveRun(synchronized);
  }
}

async function blockModelRun(
  store: SqliteStore,
  run: CreateImproveRun,
  reason: string,
): Promise<void> {
  if (run.state === "blocked" && run.blockedReason === reason) return;
  await store.upsertCreateImproveRun(nextCreateImproveRunRevision(run, {
    state: "blocked",
    blockedReason: reason,
    updatedAt: new Date().toISOString(),
  }));
}

function compareFrozenEvaluationContract(
  expectedTaskIds: string[],
  activeAttempts: TaskAttemptResult[],
  candidateAttempts: TaskAttemptResult[],
): string | null {
  if (!expectedTaskIds.length) return "The approved Taskset has no frozen-evaluation tasks.";
  const activeByTask = new Map(activeAttempts.map((attempt) => [attempt.taskId, attempt]));
  const candidateByTask = new Map(candidateAttempts.map((attempt) => [attempt.taskId, attempt]));
  if (activeByTask.size !== activeAttempts.length || candidateByTask.size !== candidateAttempts.length) {
    return "Frozen evaluation produced duplicate attempts for the same task and subject.";
  }
  const activeTaskIds = [...activeByTask.keys()].sort();
  const candidateTaskIds = [...candidateByTask.keys()].sort();
  if (
    activeTaskIds.join("\0") !== expectedTaskIds.join("\0") ||
    candidateTaskIds.join("\0") !== expectedTaskIds.join("\0")
  ) {
    return "Base and trained model evaluation did not execute the exact approved frozen Taskset.";
  }
  for (const taskId of expectedTaskIds) {
    const active = activeByTask.get(taskId)!;
    const candidate = candidateByTask.get(taskId)!;
    if (active.seed !== candidate.seed || active.attempt !== candidate.attempt || active.split !== candidate.split) {
      return `Base and trained model evaluation used different budgets or seeds for task ${taskId}.`;
    }
  }
  return null;
}

function modelEvaluationSummary(
  subject: "active" | "candidate",
  attempts: TaskAttemptResult[],
  grades: GradeResult[],
  executionContractHash: string,
) {
  const gradeByAttempt = new Map(grades.map((grade) => [grade.attemptId, grade]));
  const presentGrades = attempts.flatMap((attempt) => {
    const grade = gradeByAttempt.get(attempt.id);
    return grade ? [grade] : [];
  });
  const passed = presentGrades.filter((grade) => grade.passed).length;
  const infrastructureFailureCount = attempts.filter(
    (attempt) => attempt.infrastructureError !== null,
  ).length;
  return {
    subject,
    attemptRefs: attempts.map((attempt) => attempt.id).sort(),
    gradeRefs: presentGrades.map((grade) => grade.id).sort(),
    total: attempts.length,
    passed,
    failed: attempts.length - passed,
    infrastructureFailureCount,
    evaluationComplete: infrastructureFailureCount === 0,
    executionContractHash,
  };
}
