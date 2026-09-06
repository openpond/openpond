import {
  requireLearningResource, taskAttemptEvidence, taskRecordFromEvidence, verifyLearningTextAsset,
  type LearningRepository, type TaskGradeExecutor,
} from "@openpond/evals/learning";
import { executeRewardBinding } from "@openpond/evals/rewards";
import type { AttemptEvidence, GraderSpec, TaskRecord } from "@openpond/evals";
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
          const result = await executeLocalLearningVerifier({ repository, scope: input.scope, grader, task, evidence,
            evaluatorContext: input.evidence.submission.evaluatorContext, timeoutMs: input.run.timeoutMs, signal: input.signal });
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

export async function executeLocalLearningVerifier(input: {
  repository: LearningRepository; scope: string;
  grader: Extract<GraderSpec, { kind: "custom_verifier" }>; task: TaskRecord; evidence: AttemptEvidence;
  evaluatorContext: Record<string, unknown> | null; timeoutMs?: number; signal?: AbortSignal;
}) {
  const source = await input.repository.transaction(input.scope, async (transaction) => verifyLearningTextAsset(
    await requireLearningResource(transaction, "asset", input.grader.verifierRef.id, 1), input.grader.verifierRef,
  ));
  return executeJavaScriptVerifierInWorker({
    source, exportName: input.grader.exportName, timeoutMs: Math.min(input.grader.timeoutMs, input.timeoutMs ?? input.grader.timeoutMs), signal: input.signal,
    value: { task: input.task, attempt: input.evidence, input: input.task.input, output: input.evidence.output,
      expectedOutput: input.task.expectedOutput, evaluatorContext: input.evaluatorContext, infrastructureError: input.evidence.infrastructureError ?? null },
  });
}
