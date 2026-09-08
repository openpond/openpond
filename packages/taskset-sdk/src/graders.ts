import {
  type GradeComponent,
  type GradeResult,
  type GraderSpec,
  type TaskAttemptResult,
  type TaskDataRecord,
} from "@openpond/contracts";
import { evaluateDeterministicGrader, portableDeterministicCheck } from "@openpond/evals/graders";
import type { RewardBinding, RewardRelease } from "@openpond/evals/rewards";
import { contentHash } from "./hashing.js";
import { gradeLearningBatchAttempt } from "./learning-graders.js";

export type ModelJudgeRunner = (input: {
  grader: Extract<GraderSpec, { kind: "model_judge" }>;
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
}) => Promise<{ score: number; passed: boolean; feedback: string; evidenceRefs?: string[]; usage?: unknown; costUsd?: number }>;

export type CustomVerifierRunner = (input: {
  grader: Extract<GraderSpec, { kind: "custom_verifier" }>;
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
  signal?: AbortSignal;
}) => Promise<{ score: number; passed: boolean; feedback: string; evidenceRefs?: string[] }>;

export async function gradeAttempt(input: {
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
  graders: GraderSpec[];
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
  now?: () => string;
  learning?: { binding: RewardBinding; rewards: RewardRelease[] };
  signal?: AbortSignal;
}): Promise<GradeResult> {
  if (input.learning) return gradeLearningBatchAttempt({ ...input, learning: input.learning });
  if (input.graders.some(grader => grader.metadata.rewardBinding !== undefined)) throw new Error("This Taskset requires its immutable public Reward binding to grade an attempt.");
  const graderSetHash = contentHash(input.graders);
  const components: GradeComponent[] = [];
  for (const grader of input.graders) {
    input.signal?.throwIfAborted();
    components.push(input.attempt.infrastructureError
      ? component(grader, null, false, "Infrastructure failure; no reward was produced.", [], false)
      : await runGrader(grader, input.task, input.attempt, input.modelJudge, input.customVerifier, input.signal));
  }
  const unscorable = components.some(item => item.score === null);
  const hardGateFailed = components.some(item => item.hardGate && !item.passed);
  const totalWeight = input.graders.reduce((sum, grader) => sum + grader.weight, 0);
  const weighted = components.reduce((sum, item, index) => sum + (item.score ?? 0) * input.graders[index]!.weight, 0);
  const score = input.attempt.infrastructureError || unscorable || totalWeight <= 0 ? null : hardGateFailed ? 0 : weighted / totalWeight;
  const passed = score !== null && !hardGateFailed && components.every(item => item.passed);
  return {
    schemaVersion: "openpond.gradeResult.v1",
    id: `grade_${contentHash([input.attempt.id, graderSetHash, components]).slice(0, 24)}`,
    attemptId: input.attempt.id, graderSetHash, score, passed, components,
    failureClass: input.attempt.infrastructureError ? "infrastructure_failure" : score === null ? "grader_failure" : passed ? null : "policy_failure",
    feedback: input.attempt.infrastructureError ? [input.attempt.infrastructureError] : components.flatMap(item => item.feedback ? [item.feedback] : []),
    rewardEligible: score !== null && components.some(item => item.rewardEligible),
    createdAt: input.now?.() ?? new Date().toISOString(),
  };
}

async function runGrader(grader: GraderSpec, task: TaskDataRecord, attempt: TaskAttemptResult, modelJudge?: ModelJudgeRunner, customVerifier?: CustomVerifierRunner, signal?: AbortSignal): Promise<GradeComponent> {
  if (grader.kind === "model_judge") {
    if (!modelJudge) return component(grader, null, false, "Model judge runner is unavailable.", [], false);
    if (grader.calibrationStatus !== "passed") return component(grader, null, false, "Model judge calibration has not passed.", [], false);
    const result = await modelJudge({ grader, task, attempt });
    return component(grader, result.score, result.passed, result.feedback, result.evidenceRefs ?? []);
  }
  if (grader.kind === "human") return component(grader, null, false, "Human review is pending.", [], false);
  if (grader.kind === "custom_verifier") {
    if (!customVerifier) return component(grader, null, false, "Sandboxed verifier runner is unavailable.", [], false);
    const result = await customVerifier({ grader, task, attempt, signal });
    return component(grader, result.score, result.passed, result.feedback, result.evidenceRefs ?? []);
  }
  const result = evaluateDeterministicGrader({ grader: portableDeterministicCheck(grader), task, evidence: attempt });
  return component(grader, result.score, result.passed, result.feedback, [...attempt.artifactRefs, ...attempt.runtimeEventRefs]);
}

function component(grader: GraderSpec, score: number | null, passed: boolean, feedback: string, evidenceRefs: string[], rewardEligible = grader.rewardEligible): GradeComponent {
  const bounded = score !== null && Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
  return {
    graderId: grader.id, graderVersion: grader.version, score: bounded,
    passed: bounded !== null && passed, hardGate: grader.hardGate,
    rewardEligible: bounded !== null && rewardEligible, feedback, evidenceRefs,
    judge: grader.kind === "model_judge" ? grader.judge : null,
    calibrationStatus: grader.kind === "model_judge" ? grader.calibrationStatus : "not_applicable",
  };
}
