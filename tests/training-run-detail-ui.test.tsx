import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ModelRunSchema,
  TrainingRunDetailSchema,
} from "../packages/contracts/src";
import { LabLifecycleRunMetrics } from "../apps/web/src/components/labs/LabLifecycleRunMetrics";
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
    {
      schemaVersion: "openpond.sftStepMetric.v1",
      step: 1,
      maxSteps: 2,
      timestamp: "2026-07-13T00:00:30.000Z",
      epoch: 0.5,
      loss: 1.2,
      learningRate: 0.0002,
      gradientNorm: 0.7,
      entropy: 2.4,
      meanTokenAccuracy: 0.4,
      inputTokensSeen: 64,
      memoryBytes: 1_000_000_000,
      elapsedSeconds: 30,
    },
    {
      schemaVersion: "openpond.sftStepMetric.v1",
      step: 2,
      maxSteps: 2,
      timestamp: "2026-07-13T00:01:00.000Z",
      epoch: 1,
      loss: 0.8,
      learningRate: 0.0001,
      gradientNorm: 0.5,
      entropy: 2.1,
      meanTokenAccuracy: 0.6,
      inputTokensSeen: 128,
      memoryBytes: 1_100_000_000,
      elapsedSeconds: 60,
    },
  ],
  evaluation: {
    schemaVersion: "openpond.trainingEvaluationSummary.v1",
    jobId: "job_detail_fixture",
    tasksetId: "taskset_detail_fixture",
    base: {
      count: 1,
      scoredCount: 1,
      meanScore: 0.5,
      passedCount: 0,
      passRate: 0,
    },
    trained: {
      count: 1,
      scoredCount: 1,
      meanScore: 0.8,
      passedCount: 1,
      passRate: 1,
    },
    meanScoreDelta: 0.3,
    examples: [
      {
        taskId: "task_detail_fixture",
        input: { prompt: "Do the task" },
        baseOutput: { text: "Base output" },
        trainedOutput: { text: "Trained output" },
        baseGrade: {
          status: "scored",
          score: 0.5,
          passed: false,
          rewardEligible: false,
          failureClass: "policy_failure",
          feedback: ["Needs work."],
          components: [
            {
              graderId: "grader_detail",
              score: 0.5,
              passed: false,
              feedback: "Needs work.",
            },
          ],
        },
        trainedGrade: {
          status: "scored",
          score: 0.8,
          passed: true,
          rewardEligible: true,
          failureClass: null,
          feedback: ["Passed."],
          components: [
            {
              graderId: "grader_detail",
              score: 0.8,
              passed: true,
              feedback: "Passed.",
            },
          ],
        },
      },
    ],
  },
  generatedAt: "2026-07-13T00:01:00.000Z",
});

describe("Training run detail UI", () => {
  test("renders selectable per-step telemetry as an accessible chart", () => {
    const html = renderToStaticMarkup(
      <TrainingRunMetrics detail={detail} loading={false} />
    );
    expect(html).toContain("Loss by optimizer step");
    expect(html).toContain("Learning rate");
    expect(html).toContain("Token accuracy");
    expect(html).toContain("2 of 2");
  });

  test("renders base-versus-trained evaluation and inspectable outputs", () => {
    const html = renderToStaticMarkup(
      <TrainingRunEvaluation detail={detail} loading={false} />
    );
    expect(html).toContain("Base score");
    expect(html).toContain("Trained score");
    expect(html).toContain("+0.300");
    expect(html).toContain("Improved 0.300");
    expect(html).toContain("Grader feedback");
  });

  test("labels live RFT points as observed optimizer updates without implying completion", () => {
    const rftDetail = TrainingRunDetailSchema.parse({
      ...detail,
      job: {
        ...detail.job,
        status: "running",
        completedAt: null,
        metadata: {
          trainingMethod: "grpo",
          optimizerUpdatesObserved: 2,
        },
      },
      stepMetrics: detail.stepMetrics
        .map((metric) => ({
          ...metric,
          loss: null,
          reward: metric.step === 1 ? 0.1264 : 0.133,
        }))
        .concat([
          {
            ...detail.stepMetrics[0]!,
            maxSteps: 3,
            loss: null,
            reward: 0.1264,
          },
        ]),
    });
    const html = renderToStaticMarkup(
      <TrainingRunMetrics detail={rftDetail} loading={false} />
    );
    expect(html).toContain("Optimizer updates");
    expect(html).toContain(">2<");
    expect(html).not.toContain("2 of 2");
    expect(html).toContain("Reward by optimizer step");
    expect(html.match(/Step 1:/g)).toHaveLength(1);
  });

  test("does not count a reward metric as a verified optimizer update", () => {
    const failedRftDetail = TrainingRunDetailSchema.parse({
      ...detail,
      job: {
        ...detail.job,
        status: "failed",
        metadata: {
          trainingMethod: "grpo",
          optimizerUpdatesObserved: 0,
        },
      },
      stepMetrics: [
        {
          ...detail.stepMetrics[0]!,
          loss: null,
          reward: 0,
        },
      ],
    });
    const html = renderToStaticMarkup(
      <TrainingRunMetrics detail={failedRftDetail} loading={false} />
    );
    expect(html).toContain("<span>Optimizer updates</span><strong>0</strong>");
  });

  test("renders DPO preference telemetry as first-class metrics", () => {
    const dpoDetail = TrainingRunDetailSchema.parse({
      ...detail,
      stepMetrics: [
        {
          ...detail.stepMetrics[0]!,
          loss: 0.6908,
          preferenceAccuracy: 1,
          preferenceMargin: 0.0047,
          chosenReward: 0.002,
          rejectedReward: -0.0027,
          chosenLogProbability: -2.1,
          rejectedLogProbability: -2.5,
        },
      ],
    });
    const html = renderToStaticMarkup(
      <TrainingRunMetrics detail={dpoDetail} loading={false} />
    );
    expect(html).toContain("Preference accuracy");
    expect(html).toContain("Preference margin");
    expect(html).toContain("Chosen reward");
    expect(html).toContain("Rejected reward");
  });

  test("renders PPO policy, value, reward, and environment telemetry", () => {
    const ppoDetail = TrainingRunDetailSchema.parse({
      ...detail,
      stepMetrics: [],
      policyMetrics: [
        {
          schemaVersion: "openpond.policyOptimizationMetric.v1",
          method: "ppo",
          step: 1,
          timestamp: "2026-07-13T00:00:30.000Z",
          policyLoss: -1.3397,
          valueLoss: 0.5474,
          meanReward: 0,
          meanReturn: 0,
          kl: 0.1392,
          entropy: 3.8727,
          policyClipFraction: 0,
          valueClipFraction: 0,
          explainedVariance: 0,
          rolloutLearnerLag: 0,
          inputTokens: 36,
          outputTokens: 1,
          environmentExecutions: 1,
          costUsd: 0,
        },
      ],
    });
    const html = renderToStaticMarkup(
      <TrainingRunMetrics detail={ppoDetail} loading={false} />
    );
    expect(html).toContain("<span>Optimizer steps</span><strong>1</strong>");
    expect(html).toContain("Policy loss");
    expect(html).toContain("Value loss");
    expect(html).toContain("Environment executions");
    expect(html).toContain("Reward by optimizer step");
  });

  test("shows retained managed-run results when no step curve was ingested", () => {
    const hash = "a".repeat(64);
    const run = ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id: "model_run_managed",
      modelId: "model_fixture",
      modelVersionId: "model_version_base",
      profileId: "default",
      kind: "training",
      status: "succeeded",
      method: "grpo",
      destinationId: "openpond_managed",
      taskset: {
        id: "taskset_fixture",
        revision: 1,
        contentHash: hash,
      },
      quote: {
        maximumSpendUsd: 2,
        hourlyCostUsd: null,
      },
      reward: {
        raw: 0.954,
        components: {},
      },
      receipt: {
        schemaVersion: "openpond.modelRunReceipt.v1",
        provider: "openpond_managed",
        providerRunId: "provider_run_fixture",
        assignmentHash: hash,
        resultHash: hash,
        transcriptHash: hash,
        traceHash: null,
        resolvedBundleHash: hash,
        artifactPath: "managed://provider_run_fixture/adapter",
        cleanup: {
          computeReleased: true,
          tunnelClosed: true,
        },
        telemetry: {
          schemaVersion: "openpond.correlatedTelemetryReceipt.v1",
          stage: "training",
          correlation: {
            modelRunId: "model_run_managed",
            modelVersionId: "model_version_base",
            policyVersion: 1,
            taskId: null,
            rolloutGroupId: null,
            providerResourceId: "provider_run_fixture",
            deploymentId: null,
            inferenceRequestId: null,
          },
          spans: [],
          usage: {
            promptTokens: 1200,
            generatedTokens: 340,
            gpuSeconds: 1790.7,
            workerActiveSeconds: 1790.7,
            optimizerSteps: 1,
            rolloutGroups: 1,
            successfulTrajectories: 4,
            failedTrajectories: 0,
            peakGpuMemoryBytes: null,
            peakGpuUtilizationPercent: null,
          },
          resource: {
            provider: "openpond_managed",
            resourceIds: ["provider_run_fixture"],
            gpuType: "H100",
            gpuCount: 1,
            baseProfileId: null,
            baseRepository: null,
            baseRevision: null,
            adapterContentHash: hash,
          },
          cost: {
            currency: "USD",
            providerReportedUsd: 1.0366,
            quotedHourlyUsd: null,
            estimatedUsd: null,
            methodologyVersion: "provider_reported",
            pricingInputs: {},
            unitEstimates: {},
          },
          recordedAt: "2026-07-13T00:01:00.000Z",
          contentHash: hash,
        },
        contentHash: hash,
      },
      adapterArtifactLineageId: "lineage_fixture",
      failure: null,
      startedAt: "2026-07-13T00:00:00.000Z",
      completedAt: "2026-07-13T00:01:00.000Z",
      updatedAt: "2026-07-13T00:01:00.000Z",
    });

    const html = renderToStaticMarkup(<LabLifecycleRunMetrics run={run} />);

    expect(html).toContain("Final reward");
    expect(html).toContain("0.954");
    expect(html).toContain("Successful trajectories");
    expect(html).toContain(">4<");
    expect(html).toContain("$1.0366");
    expect(html).not.toContain("OpenPond retained the final result");
    expect(html).not.toContain("per-step optimization curve");
  });
});
