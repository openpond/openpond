import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrainingRunDetailSchema } from "../packages/contracts/src";
import { TrainingRunEvaluation } from "../apps/web/src/components/training/TrainingRunEvaluation";
import { TrainingRunMetrics } from "../apps/web/src/components/training/TrainingRunMetrics";

const detail = TrainingRunDetailSchema.parse({
  schemaVersion: "openpond.trainingRunDetail.v1",
  job: {
    schemaVersion: "openpond.trainingJob.v1",
    id: "job_detail_fixture",
    planId: "plan_detail_fixture",
    bundleHash: "bundle00000000",
    approvalId: "approval_detail_fixture",
    destinationId: "local_cpu_fixture",
    status: "succeeded",
    nonProduction: true,
    workerPid: null,
    startedAt: "2026-07-13T00:00:00.000Z",
    completedAt: "2026-07-13T00:01:00.000Z",
    error: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:01:00.000Z",
    metadata: {},
  },
  events: [],
  stepMetrics: [
    { schemaVersion: "openpond.sftStepMetric.v1", step: 1, maxSteps: 2, timestamp: "2026-07-13T00:00:30.000Z", epoch: 0.5, loss: 1.2, learningRate: 0.0002, gradientNorm: 0.7, entropy: 2.4, meanTokenAccuracy: 0.4, inputTokensSeen: 64, memoryBytes: 1_000_000_000, elapsedSeconds: 30 },
    { schemaVersion: "openpond.sftStepMetric.v1", step: 2, maxSteps: 2, timestamp: "2026-07-13T00:01:00.000Z", epoch: 1, loss: 0.8, learningRate: 0.0001, gradientNorm: 0.5, entropy: 2.1, meanTokenAccuracy: 0.6, inputTokensSeen: 128, memoryBytes: 1_100_000_000, elapsedSeconds: 60 },
  ],
  evaluation: {
    schemaVersion: "openpond.trainingEvaluationSummary.v1",
    jobId: "job_detail_fixture",
    tasksetId: "taskset_detail_fixture",
    base: { count: 1, scoredCount: 1, meanScore: 0.5, passedCount: 0, passRate: 0 },
    trained: { count: 1, scoredCount: 1, meanScore: 0.8, passedCount: 1, passRate: 1 },
    meanScoreDelta: 0.3,
    examples: [{
      taskId: "task_detail_fixture",
      input: { prompt: "Do the task" },
      baseOutput: { text: "Base output" },
      trainedOutput: { text: "Trained output" },
      baseGrade: { status: "scored", score: 0.5, passed: false, rewardEligible: false, failureClass: "policy_failure", feedback: ["Needs work."], components: [{ graderId: "grader_detail", score: 0.5, passed: false, feedback: "Needs work." }] },
      trainedGrade: { status: "scored", score: 0.8, passed: true, rewardEligible: true, failureClass: null, feedback: ["Passed."], components: [{ graderId: "grader_detail", score: 0.8, passed: true, feedback: "Passed." }] },
    }],
  },
  generatedAt: "2026-07-13T00:01:00.000Z",
});

describe("Training run detail UI", () => {
  test("renders selectable per-step telemetry as an accessible chart", () => {
    const html = renderToStaticMarkup(<TrainingRunMetrics detail={detail} loading={false}/>);
    expect(html).toContain("Loss by optimizer step");
    expect(html).toContain("Learning rate");
    expect(html).toContain("Token accuracy");
    expect(html).toContain("2 of 2");
  });

  test("renders base-versus-trained evaluation and inspectable outputs", () => {
    const html = renderToStaticMarkup(<TrainingRunEvaluation detail={detail} loading={false}/>);
    expect(html).toContain("Base score");
    expect(html).toContain("Trained score");
    expect(html).toContain("+0.300");
    expect(html).toContain("Improved 0.300");
    expect(html).toContain("Grader feedback");
  });
});
