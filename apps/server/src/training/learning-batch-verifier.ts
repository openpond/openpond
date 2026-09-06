import type { Taskset } from "@openpond/contracts";
import { compileBoundGraders } from "@openpond/evals/rewards";
import { requireLearningRelease, TaskBatchPackageMetadataSchema, taskRecordFromEvidence } from "@openpond/evals/learning";
import { contentHash, type CustomVerifierRunner } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { executeLocalLearningVerifier } from "./learning-grade-executor.js";

/** Private context is resolved by scoped immutable admission, never copied into policy data. */
export function createLearningBatchVerifier(store: SqliteStore, taskset: Taskset): CustomVerifierRunner {
  const learning = TaskBatchPackageMetadataSchema.parse(taskset.metadata.learning);
  const graders = compileBoundGraders(learning.binding, learning.rewards);
  return async ({ grader, task, attempt, signal }) => {
    const admission = learning.admissions.find((entry) => entry.taskId === task.id);
    const bound = graders.find((entry) => entry.id === grader.id);
    if (!admission || bound?.kind !== "custom_verifier") throw new Error("Prepared batch has no matching verifier admission.");
    const evidence = await store.learningRepository().transaction(taskset.profileId, (transaction) => requireLearningRelease(transaction, "evidence", admission.evidence));
    const releasedTask = taskRecordFromEvidence(evidence, learning.definition);
    const selected = (value: typeof releasedTask | typeof task) => ({ id: value.id, input: value.input,
      expectedOutput: value.expectedOutput, policyVisibleContext: value.policyVisibleContext, privilegedContextRef: value.privilegedContextRef });
    if (contentHash(selected(task)) !== contentHash(selected(releasedTask))) throw new Error("Prepared task differs from its admitted evaluator context.");
    return executeLocalLearningVerifier({ repository: store.learningRepository(), scope: taskset.profileId, grader: bound,
      task: releasedTask, evidence: { output: attempt.output, artifactRefs: attempt.artifactRefs,
        runtimeEventRefs: attempt.runtimeEventRefs, infrastructureError: attempt.infrastructureError },
      evaluatorContext: evidence.submission.evaluatorContext, signal,
    });
  };
}
