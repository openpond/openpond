import { describe, expect, test, vi } from "vitest";

import type {
  TrainingExecutionRef,
  TrainingJob,
  TrainingJobEvent,
} from "@openpond/contracts";

import type { SqliteStore } from "../apps/server/src/store/store.js";
import {
  parseManagedJobDetail,
  persistManagedRunEvidence,
} from "../apps/server/src/training/openpond-managed-run-evidence.js";

const TIME = "2026-07-30T05:41:00.906Z";

describe("OpenPond Managed run evidence", () => {
  test("persists four rollout rewards and one committed optimizer update idempotently", async () => {
    const events = new Map<string, TrainingJobEvent>();
    let savedJob: TrainingJob | null = null;
    const job = {
      schemaVersion: "openpond.trainingJob.v1",
      id: "managed-job-evidence",
      planId: "managed-plan-evidence",
      bundleHash: "bundle-evidence-hash",
      approvalId: "approval-evidence",
      destinationId: "openpond_managed",
      status: "succeeded",
      nonProduction: false,
      workerPid: null,
      startedAt: "2026-07-30T05:20:42.995Z",
      completedAt: TIME,
      error: null,
      createdAt: "2026-07-30T05:20:42.995Z",
      updatedAt: TIME,
      metadata: {},
    } satisfies TrainingJob;
    const store = {
      getTrainingJob: vi.fn(async () => savedJob ?? job),
      getTrainingPlan: vi.fn(async () => ({
        recipe: {
          method: "grpo",
          optimizer: { learningRate: 0.00001 },
        },
      })),
      listTrainingJobEvents: vi.fn(async () =>
        [...events.values()].sort((left, right) => left.sequence - right.sequence),
      ),
      saveTrainingJobEvent: vi.fn(async (event: TrainingJobEvent) => {
        events.set(event.id, event);
        return event;
      }),
      saveTrainingJob: vi.fn(async (next: TrainingJob) => {
        savedJob = next;
        return next;
      }),
    } as unknown as SqliteStore;
    const ref = {
      runId: job.id,
      adapterId: "sandbox-managed-rl",
      providerJobId: job.id,
      tenantId: "team-evidence",
      leaseId: null,
      manifestHash: "a".repeat(64),
      inputBundleHash: "b".repeat(64),
      createdAt: job.createdAt,
    } satisfies TrainingExecutionRef;
    const detail = parseManagedJobDetail({
      job: {
        id: job.id,
        state: "completed",
        version: 9,
        targetGroups: 1,
        completedGroups: 1,
        currentPolicyVersion: 1,
        accruedSpendUsd: "0.148046",
        canonicalPublishState: "pending",
        canonicalAdapterArtifactId: null,
        createdAt: job.createdAt,
        updatedAt: TIME,
        completedAt: TIME,
      },
      gpuLeases: [
        {
          id: "gpu-1",
          provider: "openpond",
          state: "terminated",
          gpuType: "A40",
          gpuCount: 1,
          quotedHourlyUsd: "0.44",
          observedHourlyUsd: "0.44",
          readyAt: "2026-07-30T05:22:00.000Z",
          terminatedAt: TIME,
        },
      ],
      rolloutGroups: [
        {
          id: "group-1",
          groupIndex: 0,
          policyVersion: 0,
          state: "consumed",
          eligibleTrajectoryCount: 4,
          rewardMean: "0.932624",
          startedAt: "2026-07-30T05:23:00.000Z",
          completedAt: "2026-07-30T05:28:00.000Z",
        },
      ],
      rollouts: Array.from({ length: 4 }, (_, index) => ({
        id: `rollout-${index + 1}`,
        groupId: "group-1",
        workerSlot: index,
        attempt: 1,
        state: "succeeded",
        startedAt: `2026-07-30T05:2${index + 3}:00.000Z`,
        completedAt: `2026-07-30T05:2${index + 4}:00.000Z`,
      })),
      trajectories: [0.9, 0.92, 0.94, 0.970496].map((reward, index) => ({
        id: `trajectory-${index + 1}`,
        groupId: "group-1",
        rolloutId: `rollout-${index + 1}`,
        policyVersion: 0,
        rewardEligible: true,
        reward: reward.toFixed(6),
        rewardComponents: { task: reward },
        promptTokenCount: 100 + index,
        outputTokenCount: 20 + index,
        consumedTrainingStepId: "step-1",
        createdAt: `2026-07-30T05:2${index + 4}:00.000Z`,
        updatedAt: `2026-07-30T05:2${index + 4}:00.000Z`,
      })),
      trainingSteps: [
        {
          id: "step-1",
          groupId: "group-1",
          stepIndex: 1,
          inputPolicyVersion: 0,
          outputPolicyVersion: 1,
          state: "committed",
          metrics: {
            rewardMean: 0.932624,
            trajectoryCount: 4,
          },
          startedAt: "2026-07-30T05:29:00.000Z",
          committedAt: "2026-07-30T05:34:00.000Z",
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-1",
          policyVersion: 1,
          state: "ready",
          adapterSha256: "c".repeat(64),
          sizeBytes: 3_171_729_123,
          isLatest: true,
          isFinal: true,
          readyAt: "2026-07-30T05:35:00.000Z",
          updatedAt: "2026-07-30T05:35:00.000Z",
        },
      ],
      evaluations: [
        {
          id: "evaluation-base",
          kind: "baseline",
          policyVersion: 0,
          state: "completed",
          score: "0.974721",
          threshold: "0.05",
          passed: true,
          createdAt: "2026-07-30T05:36:00.000Z",
        },
        {
          id: "evaluation-candidate",
          kind: "candidate",
          policyVersion: 1,
          state: "completed",
          score: "0.974721",
          threshold: "0.05",
          passed: false,
          createdAt: "2026-07-30T05:37:00.000Z",
        },
      ],
    });

    const first = await persistManagedRunEvidence({
      store,
      ref,
      detail,
      now: () => new Date(TIME),
    });
    const firstSequences = [...events.values()].map((event) => event.sequence);
    const second = await persistManagedRunEvidence({
      store,
      ref,
      detail,
      now: () => new Date(TIME),
    });

    expect(first).toMatchObject({
      reward: {
        finalMean: 0.932624,
        trajectoryCount: 4,
        eligibleTrajectoryCount: 4,
      },
      progress: {
        targetOptimizerSteps: 1,
        committedOptimizerSteps: 1,
      },
      cost: { totalUsd: 0.148046 },
      checkpoint: { sizeBytes: 3_171_729_123 },
    });
    expect(second).toEqual(first);
    expect(events).toHaveLength(10);
    expect([...events.values()].map((event) => event.sequence)).toEqual(
      firstSequences,
    );
    expect(
      [...events.values()].filter(
        (event) => event.payload.metricKind === "rollout_trajectory",
      ),
    ).toHaveLength(4);
    expect(
      [...events.values()].find(
        (event) => event.payload.metricKind === "policy_optimization",
      )?.payload,
    ).toMatchObject({
      step: 1,
      meanReward: 0.932624,
      learningRate: 0.00001,
      environmentExecutions: 4,
      costUsd: null,
    });
    expect(savedJob?.metadata.managedTrainingEvidence).toEqual(first);
  });
});
