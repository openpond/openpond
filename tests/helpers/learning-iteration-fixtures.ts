import { LearningPolicySchema, learningRef, type LearningPolicy, type LearningRepository, type TaskEvidence } from "@openpond/evals/learning";
import { learningFixture } from "./learning-fixtures";

export async function learningIterationFixture(repository: LearningRepository) {
  const value = await learningFixture(repository);
  const ref = (id: string) => ({ id, contentHash: "a".repeat(64) });
  const publishPolicy = async (previous?: LearningPolicy, changes: Partial<LearningPolicy> = {}) => {
    const { contentHash: _hash, ...content } = previous ?? {} as LearningPolicy;
    return LearningPolicySchema.parse((await value.command({ action: "publish", kind: "policy", expectedRevision: previous?.revision ?? 0, content: {
      schemaVersion: "openpond.learningPolicy.v1", id: "policy", modelProjectId: "model", executionOwner: "hosted", enabled: true,
      sources: [learningRef(value.source)], taskDefinition: learningRef(value.definition), rewardBinding: learningRef(value.binding),
      admission: { mode: "human", qualification: null, minimumApprovedExamples: 1 },
      trigger: { kind: "schedule", intervalSeconds: 3600 }, trainingParent: ref("parent"), teacher: null,
      training: { method: "grpo", recipe: ref("recipe"), retentionEvaluation: ref("evaluation"), replayBatches: [] },
      limits: { maxIterationSpendUsd: 2, maxDailySpendUsd: 4, cooldownSeconds: 0, maxRetries: 1, maxBatchExamples: 1, maxBacklogExamples: 1000 },
      automation: { collect: false, train: true, accept: false, serve: false },
      acceptance: { minimumScore: 0.8, maximumRetentionRegression: 0, requireImprovement: true, rollbackVersion: null },
      ...content, ...changes, revision: (previous?.revision ?? 0) + 1,
    } })).resources[0]);
  };
  const approve = async (evidence: TaskEvidence) => value.command({
    action: "review", evidence: learningRef(evidence), expectedRevision: 0, disposition: "approved", targetApproval: "not_required",
    approvedTarget: null, observedGradeId: null, targetGradeId: null, note: "Human approved reward-training input.",
  });
  const reserve = (policy: LearningPolicy, identity: string) => value.command({ action: "reserve_iteration", policy: learningRef(policy), trigger: { kind: "manual", identity } });
  const cancel = (id: string) => value.command({ action: "cancel_iteration_reservation", iterationId: id, expectedRevision: 1 });
  return { ...value, publishPolicy, approve, reserve, cancel };
}
