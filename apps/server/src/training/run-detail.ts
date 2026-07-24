import {
  SftStepMetricSchema,
  PolicyOptimizationMetricSchema,
  TrainingEvaluationSummarySchema,
  TrainingRunDetailSchema,
  type GradeResult,
  type SftStepMetric,
  type PolicyOptimizationMetric,
  type TaskAttemptResult,
  type TrainingEvaluationAggregate,
  type TrainingEvaluationGrade,
  type TrainingJobEvent,
  type TrainingRunDetail,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

export async function trainingRunDetail(store: SqliteStore, jobId: string): Promise<TrainingRunDetail> {
  const job = await store.getTrainingJob(jobId);
  if (!job) throw new Error("Training job not found.");
  const plan = await store.getTrainingPlan(job.planId);
  if (!plan) throw new Error("Training Plan not found for this job.");
  const taskset = await store.getTaskset(plan.tasksetId);
  if (!taskset) throw new Error("Taskset not found for this job.");
  const [events, attempts, grades] = await Promise.all([
    store.listTrainingJobEvents(job.id),
    store.listTaskAttempts(taskset.id),
    store.listGradeResultsForTaskset(taskset.id),
  ]);
  const jobAttempts = attempts.filter((attempt) => attempt.metadata.jobId === job.id && attempt.split === "frozen_eval");
  const gradeByAttempt = new Map(grades.map((grade) => [grade.attemptId, grade]));
  const attemptByTaskAndStage = new Map<string, TaskAttemptResult>();
  for (const attempt of jobAttempts) attemptByTaskAndStage.set(`${attempt.taskId}:${evaluationStage(attempt)}`, attempt);
  const examples = taskset.tasks.filter((task) => task.split === "frozen_eval").map((task) => {
    const baseAttempt = attemptByTaskAndStage.get(`${task.id}:base`) ?? null;
    const trainedAttempt = attemptByTaskAndStage.get(`${task.id}:trained`) ?? null;
    return {
      taskId: task.id,
      input: task.input,
      baseOutput: baseAttempt?.output ?? null,
      trainedOutput: trainedAttempt?.output ?? null,
      baseGrade: gradeView(baseAttempt ? gradeByAttempt.get(baseAttempt.id) ?? null : null),
      trainedGrade: gradeView(trainedAttempt ? gradeByAttempt.get(trainedAttempt.id) ?? null : null),
    };
  });
  const base = aggregate(examples.map((example) => example.baseGrade));
  const trained = aggregate(examples.map((example) => example.trainedGrade));
  const evaluation = jobAttempts.length ? TrainingEvaluationSummarySchema.parse({
    schemaVersion: "openpond.trainingEvaluationSummary.v1",
    jobId: job.id,
    tasksetId: taskset.id,
    base,
    trained,
    meanScoreDelta: base.meanScore == null || trained.meanScore == null ? null : trained.meanScore - base.meanScore,
    examples,
  }) : null;
  return TrainingRunDetailSchema.parse({
    schemaVersion: "openpond.trainingRunDetail.v1",
    job,
    events,
    stepMetrics: deduplicateStepMetrics(events.flatMap(stepMetricFromEvent)),
    policyMetrics: deduplicatePolicyMetrics(events.flatMap(policyMetricFromEvent)),
    evaluation,
    generatedAt: new Date().toISOString(),
  });
}

function policyMetricFromEvent(event: TrainingJobEvent): PolicyOptimizationMetric[] {
  if (
    event.type !== "metric"
    || event.payload.metricKind !== "policy_optimization"
  ) return [];
  const parsed = PolicyOptimizationMetricSchema.safeParse(event.payload);
  return parsed.success ? [parsed.data] : [];
}

function deduplicatePolicyMetrics(
  metrics: PolicyOptimizationMetric[],
): PolicyOptimizationMetric[] {
  const latest = new Map<number, PolicyOptimizationMetric>();
  for (const metric of metrics) latest.set(metric.step, metric);
  return [...latest.values()].sort((left, right) =>
    left.step - right.step || left.timestamp.localeCompare(right.timestamp));
}

function deduplicateStepMetrics(
  metrics: SftStepMetric[],
): SftStepMetric[] {
  const latestByStep = new Map<string, SftStepMetric>();
  for (const metric of metrics) {
    const key = `${metric.epoch ?? "none"}:${metric.step}`;
    latestByStep.set(key, metric);
  }
  return [...latestByStep.values()].sort(
    (left, right) =>
      (left.epoch ?? 0) - (right.epoch ?? 0)
      || left.step - right.step
      || left.timestamp.localeCompare(right.timestamp),
  );
}

function stepMetricFromEvent(event: TrainingJobEvent): SftStepMetric[] {
  if (
    event.type !== "metric"
    || !["sft_step", "dpo_step", "training_step"].includes(String(event.payload.metricKind))
  ) return [];
  const number = (key: string) => typeof event.payload[key] === "number" && Number.isFinite(event.payload[key]) ? event.payload[key] as number : null;
  const step = number("step");
  const maxSteps = number("maxSteps");
  if (step == null || maxSteps == null) return [];
  return [SftStepMetricSchema.parse({
    schemaVersion: "openpond.sftStepMetric.v1",
    step,
    maxSteps,
    timestamp: event.timestamp,
    epoch: number("epoch"),
    loss: number("loss"),
    learningRate: number("learningRate"),
    gradientNorm: number("gradientNorm"),
    entropy: number("entropy"),
    meanTokenAccuracy: number("meanTokenAccuracy"),
    preferenceAccuracy: number("preferenceAccuracy"),
    preferenceMargin: number("preferenceMargin"),
    chosenReward: number("chosenReward"),
    rejectedReward: number("rejectedReward"),
    chosenLogProbability: number("chosenLogProbability"),
    rejectedLogProbability: number("rejectedLogProbability"),
    reward: number("reward"),
    policyLoss: number("policyLoss"),
    advantageLoss: number("advantageLoss"),
    inputTokensSeen: number("inputTokensSeen"),
    memoryBytes: number("memoryBytes"),
    elapsedSeconds: number("elapsedSeconds"),
  })];
}

function evaluationStage(attempt: TaskAttemptResult): "base" | "trained" {
  return attempt.metadata.evaluationStage === "base" ? "base" : "trained";
}

function gradeView(grade: GradeResult | null): TrainingEvaluationGrade | null {
  if (!grade) return null;
  const unavailable = grade.feedback.some((feedback) => /(?:runner is unavailable|human review is pending|calibration has not passed)/i.test(feedback));
  return {
    status: unavailable ? "unavailable" : "scored",
    score: unavailable ? null : grade.score,
    passed: grade.passed,
    rewardEligible: grade.rewardEligible,
    failureClass: grade.failureClass,
    feedback: grade.feedback,
    components: grade.components.map((component) => ({ graderId: component.graderId, score: component.score, passed: component.passed, feedback: component.feedback })),
  };
}

function aggregate(grades: Array<TrainingEvaluationGrade | null>): TrainingEvaluationAggregate {
  const present = grades.filter((grade): grade is TrainingEvaluationGrade => Boolean(grade));
  const scored = present.filter((grade) => grade.status === "scored");
  const scores = scored.flatMap((grade) => grade.score == null ? [] : [grade.score]);
  return {
    count: present.length,
    scoredCount: scores.length,
    meanScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    passedCount: scored.filter((grade) => grade.passed).length,
    passRate: scored.length ? scored.filter((grade) => grade.passed).length / scored.length : null,
  };
}
