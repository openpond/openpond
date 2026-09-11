import {
  requireLearningResource, taskAttemptEvidence, taskRecordFromEvidence, verifyLearningTextAsset,
  createBoundModelJudgeRunner, createBudgetedJudgeExecutor, createTaskGradeJudgeBudgetStore,
  type BoundJudgeProvider, type LearningRepository, type TaskGradeExecutor,
} from "@openpond/evals/learning";
import { contentHash } from "@openpond/harness";
import { executeRewardBinding } from "@openpond/evals/rewards";
import type { AttemptEvidence, GraderSpec, TaskRecord } from "@openpond/evals";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";
import { createLearningHostedJudgeProvider } from "./learning-hosted-judge-provider.js";

export function createLocalTaskGradeExecutor(repository: LearningRepository, provider: BoundJudgeProvider = createLearningHostedJudgeProvider()): TaskGradeExecutor {
  return {
    execute(input) {
      if (input.definition.execution.environment.entrypoint === "openpond.javascript-environment.v1") throw new Error("Tool Tasksets require grading an owner-recorded environment attempt.");
      const budget = createTaskGradeJudgeBudgetStore({ repository, scope: input.scope, run: input.run });
      return executeRewardBinding({
        binding: input.binding, rewards: input.rewards,
        task: taskRecordFromEvidence(input.evidence, input.definition),
        evidence: taskAttemptEvidence(input.evidence, input.run.output),
        signal: input.signal,
        modelJudge: createBoundModelJudgeRunner({
          readRubric: reference => repository.transaction(input.scope, async tx => verifyLearningTextAsset(
            await requireLearningResource(tx, "asset", reference.id, 1), reference)),
          async executeBudgeted(request, signal) {
            const prepared = await provider.prepare(request, { scope: input.scope, run: input.run });
            const execute = createBudgetedJudgeExecutor({ store: budget, maximumCharge: () => prepared.maximumChargeUsd,
              dispatch: (_request, signal) => prepared.dispatch(signal) });
            return execute(`grade-${contentHash(request)}`, request, signal);
          },
        }),
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
    async cancel({ scope, run }) {
      const current = await repository.transaction(scope, tx => requireLearningResource(tx, "grade", run.id));
      if (current.judgeCalls?.some(call => call.status === "reserved")) return false;
      return provider.cancel({ scope, run: current });
    },
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
    source, exportName: input.grader.exportName, runtime: input.grader.runtime, timeoutMs: Math.min(input.grader.timeoutMs, input.timeoutMs ?? input.grader.timeoutMs), signal: input.signal,
    value: { task: input.task, attempt: input.evidence, input: input.task.input, output: input.evidence.output,
      expectedOutput: input.task.expectedOutput, evaluatorContext: input.evaluatorContext, infrastructureError: input.evidence.infrastructureError ?? null },
  });
}
