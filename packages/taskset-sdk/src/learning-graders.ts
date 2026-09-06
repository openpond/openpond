import { GraderSpecSchema, type GradeResult, type GraderSpec, type TaskAttemptResult, type TaskDataRecord } from "@openpond/contracts";
import { TaskRecordSchema } from "@openpond/evals";
import { compileBoundGraders, executeRewardBinding, resolveBoundRewards, type RewardBinding, type RewardRelease } from "@openpond/evals/rewards";
import { learningRef, verifyLearningTextAsset, type LearningTextAsset } from "@openpond/evals/learning";
import { contentHash } from "./hashing.js";
import type { CustomVerifierRunner, ModelJudgeRunner } from "./graders.js";

export function projectLearningBatchGraders(binding: RewardBinding, rewards: RewardRelease[], assets: LearningTextAsset[] = []): GraderSpec[] {
  const resolved = resolveBoundRewards(binding, rewards);
  return compileBoundGraders(binding, rewards).map((grader) => {
    const reward = resolved.find(({ source }) => source.graderId === grader.id)!.reward;
    const base = { ...grader, label: reward.name, metadata: { rewardBinding: learningRef(binding) } };
    if (grader.kind === "model_judge") throw new Error(`Reward ${grader.id} needs a calibrated model execution adapter before preparation.`);
    if (grader.kind === "custom_verifier") return GraderSpecSchema.parse({ ...base,
      module: learningVerifierModule(grader.verifierRef.contentHash), exportName: grader.exportName ?? "verify",
      metadata: { ...base.metadata, portableVerifierRef: grader.verifierRef },
    });
    if (grader.kind === "human") {
      const asset = assets.find((asset) => asset.id === grader.rubricRef.id);
      if (!asset) throw new Error(`Reward ${grader.id} is missing its immutable rubric.`);
      return GraderSpecSchema.parse({ ...base, rubric: verifyLearningTextAsset(asset, grader.rubricRef) });
    }
    return GraderSpecSchema.parse({ ...base, kind: grader.kind === "artifact" ? "file" : grader.kind });
  });
}

export function learningVerifierModule(hash: string) { return `graders/reward-${hash}.js`; }

export async function gradeLearningBatchAttempt(input: {
  task: TaskDataRecord; attempt: TaskAttemptResult; graders: GraderSpec[];
  learning: { binding: RewardBinding; rewards: RewardRelease[] };
  customVerifier?: CustomVerifierRunner; modelJudge?: ModelJudgeRunner;
  signal?: AbortSignal; now?: () => string;
}): Promise<GradeResult> {
  const { binding, rewards } = input.learning;
  const resolved = resolveBoundRewards(binding, rewards);
  if (input.graders.length !== resolved.length || resolved.some(({ source, reward }) => !input.graders.some((grader) =>
    grader.id === source.graderId && grader.version === String(reward.revision)
    && contentHash(grader.metadata.rewardBinding) === contentHash(learningRef(binding))))) {
    throw new Error("Prepared Taskset graders do not match their immutable Reward binding.");
  }
  const task = TaskRecordSchema.parse({ id: input.task.id, clusterKey: input.task.clusterKey, split: input.task.split,
    input: input.task.input, expectedOutput: input.task.expectedOutput, policyVisibleContext: input.task.policyVisibleContext,
    privilegedContextRef: input.task.privilegedContextRef, artifactRefs: [], tags: input.task.tags,
  });
  const composition = await executeRewardBinding({
    binding, rewards, task, signal: input.signal,
    evidence: { output: input.attempt.output, artifactRefs: input.attempt.artifactRefs,
      runtimeEventRefs: input.attempt.runtimeEventRefs, infrastructureError: input.attempt.infrastructureError },
    customVerifier: input.customVerifier ? async ({ grader }) => {
      const projected = input.graders.find((item) => item.id === grader.id);
      if (projected?.kind !== "custom_verifier") throw new Error("Bound verifier projection is missing.");
      const result = await input.customVerifier!({ grader: projected, task: input.task, attempt: input.attempt, signal: input.signal });
      return { score: result.score, passed: result.passed, rewardEligible: grader.rewardEligible, failureClass: null,
        feedback: [result.feedback], visibleEvidenceRefs: [], privilegedEvidenceRefs: result.evidenceRefs ?? [] };
    } : undefined,
    modelJudge: input.modelJudge ? async ({ grader }) => {
      const projected = input.graders.find((item) => item.id === grader.id);
      if (projected?.kind !== "model_judge") throw new Error("Bound judge projection is missing.");
      const result = await input.modelJudge!({ grader: projected, task: input.task, attempt: input.attempt });
      return { score: result.score, passed: result.passed, rewardEligible: grader.rewardEligible, failureClass: null,
        feedback: [result.feedback], visibleEvidenceRefs: [], privilegedEvidenceRefs: result.evidenceRefs ?? [] };
    } : undefined,
  });
  // The legacy scalar is the training outcome when configured. Independent
  // evaluation outcomes remain explicit in the authoritative public receipt.
  const outcome = composition.training.status === "not_configured" ? composition.evaluation : composition.training;
  const graderSetHash = contentHash(input.graders);
  return {
    schemaVersion: "openpond.gradeResult.v1", id: `grade_${contentHash([input.attempt.id, composition.contentHash]).slice(0, 24)}`,
    attemptId: input.attempt.id, graderSetHash, score: outcome.score, passed: outcome.passed === true,
    components: composition.results.map((result) => {
      const source = binding.sources.find((source) => source.graderId === result.graderId)!;
      const grader = input.graders.find((grader) => grader.id === result.graderId)!;
      return { graderId: result.graderId, graderVersion: grader.version, score: result.normalizedScore ?? 0,
        passed: result.passed === true, hardGate: source.hardGate,
        rewardEligible: source.role === "training" && result.status === "scored", feedback: result.message?.trim() || null,
        evidenceRefs: result.evidenceHashes, judge: grader.kind === "model_judge" ? grader.judge : null,
        calibrationStatus: grader.kind === "model_judge" ? grader.calibrationStatus : "not_applicable" };
    }),
    failureClass: input.attempt.infrastructureError ? "infrastructure_failure" : outcome.status !== "scored" ? "grader_failure" : outcome.passed ? null : "policy_failure",
    feedback: composition.results.flatMap((result) => result.message?.trim() ? [result.message.trim()] : []),
    rewardEligible: composition.training.status === "scored", rewardComposition: composition,
    createdAt: input.now?.() ?? new Date().toISOString(),
  };
}
