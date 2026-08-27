import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ManagedTrainingRunEvidenceSchema,
  TrainingJobEventSchema,
  TrainingRunDetailSchema,
} from "../packages/contracts/src";
import { LabModelRunSummary } from "../apps/web/src/components/labs/LabModelRunSummary";
import {
  eventSummary,
  formatTrainingProgress,
} from "../apps/web/src/components/labs/LabModelVersionDetailPage";
import { TrainingRunEvaluation } from "../apps/web/src/components/training/TrainingRunEvaluation";
import {
  eventSeries,
  TrainingRunMetrics,
} from "../apps/web/src/components/training/TrainingRunMetrics";

const detail = TrainingRunDetailSchema.parse({
  schemaVersion: "openpond.trainingRunDetail.v1",
  job: {
    schemaVersion: "openpond.trainingJob.v1",
    id: "job_detail_fixture",
    planId: "plan_detail_fixture",
    bundleHash: "bundle00000000",
    approvalId: "approval_detail_fixture",
    destinationId: "openpond_managed",
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
  test("treats a Version as an optional run output and merges cost and resources into setup", () => {
    const evidence = ManagedTrainingRunEvidenceSchema.parse({
      schemaVersion: "openpond.managedTrainingRunEvidence.v1",
      provider: "openpond",
      providerRunId: "managed_job_fixture",
      state: "completed",
      progress: {
        targetOptimizerSteps: 1,
        committedOptimizerSteps: 1,
      },
      reward: {
        finalMean: 0.75,
        trajectoryCount: 4,
        eligibleTrajectoryCount: 4,
      },
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        environmentExecutions: 4,
      },
      resource: {
        provider: "openpond",
        gpuType: "NVIDIA A40",
        gpuCount: 1,
        hourlyCostUsd: 0.44,
      },
      cost: { totalUsd: 0.12 },
      checkpoint: null,
      evaluations: [],
      canonicalPublication: {
        state: null,
        artifactId: null,
      },
      syncedAt: "2026-07-30T00:00:00.000Z",
    });
    const html = renderToStaticMarkup(
      <LabModelRunSummary
        baseModel="Qwen3-0.6B"
        compute="OpenPond Managed"
        configuration={[]}
        duration="5m"
        evidence={evidence}
        failure={null}
        method="RFT"
        output="No version created"
        reward={0.75}
        status="Succeeded"
        statusValue="succeeded"
        taskset="Fixture Taskset"
        telemetry={null}
        title="Run 1"
        versionStatus={null}
      >
        <div>Chart region</div>
      </LabModelRunSummary>,
    );
    expect(html).toContain("Chart region");
    expect(html).toContain("No version created");
    expect(html).not.toContain("Version status");
    expect(html).toContain("<dt>Run cost</dt><dd>$0.1200</dd>");
    expect(html).toContain("<dt>GPU</dt><dd>1 × NVIDIA A40</dd>");
    expect(html).not.toContain("labs-run-outcome-grid");
  });

  test("renders every per-step metric as an accessible chart grid", () => {
    const html = renderToStaticMarkup(
      <TrainingRunMetrics detail={detail} loading={false} />
    );
    expect(html).toContain('aria-label="Loss by optimizer step"');
    expect(html).toContain("Learning rate");
    expect(html).toContain("Token accuracy");
    expect(html).toContain("5 recorded metric series");
    expect(html).toContain("2 points");
    expect(html).not.toContain("<select");
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

  test("shows the three RFT charts using only observed optimizer updates", () => {
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
    expect(html).toContain("<h4>Reward</h4>");
    expect(html).toContain("2 points");
    expect(html).toContain("Learning rate");
    expect(html).not.toContain("2 of 2");
    expect(html).toContain('aria-label="Reward by optimizer step"');
    expect(html).toContain("Live metrics update as each rollout and optimizer step completes.");
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
    expect(html).toContain("This run did not report chartable metrics.");
    expect(html).not.toContain('aria-label="Reward by optimizer step"');
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
          gradientNorm: 0.72,
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
          trajectoryCount: 4,
          costUsd: 0,
        },
      ],
    });
    const html = renderToStaticMarkup(
      <TrainingRunMetrics detail={ppoDetail} loading={false} />
    );
    expect(html).toContain("10 recorded metric series");
    expect(html).toContain("1 point");
    expect(html).toContain("Policy loss");
    expect(html).toContain("Value loss");
    expect(html).toContain("Gradient norm");
    expect(html).toContain("KL divergence");
    expect(html).toContain('aria-label="Mean reward by optimizer step"');
  });

  test("keeps an empty evaluation surface mounted while training is active", () => {
    const html = renderToStaticMarkup(
      <TrainingRunEvaluation detail={null} loading={false} pending />
    );
    expect(html).toContain(
      "Evaluation will appear here after the first eligible checkpoint is scored."
    );
  });

  test("formats committed rollout-group progress against the planned updates", () => {
    expect(formatTrainingProgress(4, 16)).toEqual({
      value: "4 / 16",
      hint: "completed / planned",
    });
    expect(formatTrainingProgress(17, 16).value).toBe("17 / 16");
  });

  test("renders managed progress as a human status without null debug fields", () => {
    const event = TrainingJobEventSchema.parse({
      schemaVersion: "openpond.trainingJobEvent.v1",
      id: "event_progress_fixture",
      jobId: "job_detail_fixture",
      sequence: 42,
      type: "progress",
      timestamp: "2026-08-27T16:55:54.155Z",
      payload: {
        errorCode: null,
        remoteEventType: "train_step",
        remotePhase: "succeeded",
      },
    });

    expect(eventSummary(event)).toBe("Optimizer update · succeeded");
    expect(eventSummary(event)).not.toContain("errorCode");
    expect(eventSummary(event)).not.toContain("null");
  });

  test("does not count reward-pending rollout trajectories as failures", () => {
    const events = [
      TrainingJobEventSchema.parse({
        schemaVersion: "openpond.trainingJobEvent.v1",
        id: "event_pending_rollout",
        jobId: "job_detail_fixture",
        sequence: 1,
        type: "metric",
        timestamp: "2026-08-27T17:00:00.000Z",
        payload: {
          metricKind: "rollout_trajectory",
          rolloutGroupId: "group_pending",
          rolloutIndex: 1,
          reward: null,
          rewardEligible: true,
        },
      }),
    ];

    expect(eventSeries(events).map((series) => series.id)).not.toContain(
      "attempt.failure_count",
    );
  });

});
