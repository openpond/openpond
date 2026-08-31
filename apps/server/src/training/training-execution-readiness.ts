import type { Taskset } from "@openpond/contracts";

const ADVISORY_READINESS_CODES = new Set([
  "frozen_eval_missing",
  "independent_evaluation_missing",
  "capability_diagnosis_missing",
  "training_not_recommended",
  "grader_audit_missing",
  "grader_audit_stale",
  "grader_audit_failed",
]);

export type TrainingExecutionBlocker = {
  code: string;
  message: string;
  path?: string | null;
};

/**
 * Readiness includes both platform execution findings and evaluation advice.
 * Only the former has authority to stop an otherwise authorized Training Run.
 * Unknown blocker codes remain blocking so new integrity or safety checks fail
 * closed until they are classified deliberately.
 */
export function trainingExecutionBlockers(
  taskset: Pick<Taskset, "contentHash" | "readiness">,
): TrainingExecutionBlocker[] {
  const readiness = taskset.readiness;
  if (!readiness) {
    return [{
      code: "training_readiness_missing",
      message: "A current execution-readiness report is required.",
      path: "readiness",
    }];
  }
  if (readiness.tasksetHash !== taskset.contentHash) {
    return [{
      code: "training_readiness_stale",
      message: "The execution-readiness report does not match the immutable Taskset.",
      path: "readiness.tasksetHash",
    }];
  }
  return readiness.blockers.filter(
    (blocker) => !ADVISORY_READINESS_CODES.has(blocker.code),
  );
}

export function assertTasksetExecutableForTraining(
  taskset: Pick<Taskset, "contentHash" | "readiness">,
): void {
  const blockers = trainingExecutionBlockers(taskset);
  if (!blockers.length) return;
  throw new Error(
    `Taskset cannot execute training: ${blockers
      .map((blocker) => `${blocker.code}: ${blocker.message}`)
      .join("; ")}`,
  );
}
