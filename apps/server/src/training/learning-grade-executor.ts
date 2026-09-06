import {
  requireLearningResource, taskAttemptEvidence, taskRecordFromEvidence, verifyLearningTextAsset,
  type LearningRepository, type TaskGradeExecutor,
} from "@openpond/evals/learning";
import { executeRewardBinding } from "@openpond/evals/rewards";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";

export function createLocalTaskGradeExecutor(repository: LearningRepository): TaskGradeExecutor {
  return {
    execute(input) {
      return executeRewardBinding({
        binding: input.binding, rewards: input.rewards,
        task: taskRecordFromEvidence(input.evidence, input.definition),
        evidence: taskAttemptEvidence(input.evidence, input.run.output),
        signal: input.signal,
        customVerifier: async ({ grader, task, evidence }) => {
          const source = await repository.transaction(input.scope, async (transaction) => verifyLearningTextAsset(
            await requireLearningResource(transaction, "asset", grader.verifierRef.id, 1), grader.verifierRef,
          ));
          const result = await executeJavaScriptVerifierInWorker({
            source, exportName: grader.exportName, timeoutMs: Math.min(grader.timeoutMs, input.run.timeoutMs), signal: input.signal,
            value: { task, attempt: evidence, input: task.input, output: evidence.output, expectedOutput: task.expectedOutput, evaluatorContext: input.evidence.submission.evaluatorContext, infrastructureError: evidence.infrastructureError ?? null },
          });
          return {
            score: result.score, passed: result.passed, rewardEligible: grader.rewardEligible,
            failureClass: null, feedback: [result.feedback], visibleEvidenceRefs: [],
            privilegedEvidenceRefs: result.evidenceRefs,
          };
        },
      });
    },
    // The worker wrapper settles only after termination; an exited local process
    // also destroys every worker. No remote allocation survives cancellation.
    async cancel() { return true; },
  };
}
