import { z } from "zod";

import {
  ManagedTrainingRunEvidenceSchema,
  TrainingJobEventSchema,
  type ManagedTrainingRunEvidence,
  type TrainingExecutionRef,
  type TrainingJobEvent,
} from "@openpond/contracts";
import {
  MetricObservationSchema,
  RunTelemetryEventSchema,
} from "@openpond/evals/telemetry";
import { contentHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";

const OptionalTimestampSchema = z.string().trim().min(1).nullable().optional();
const OptionalMoneySchema = z.string().trim().min(1).nullable().optional();

const ManagedJobDetailSchema = z.object({
  job: z.object({
    id: z.string().trim().min(1),
    state: z.string().trim().min(1),
    targetGroups: z.number().int().nonnegative().default(0),
    completedGroups: z.number().int().nonnegative().default(0),
    currentPolicyVersion: z.number().int().nonnegative().default(0),
    accruedSpendUsd: OptionalMoneySchema,
    canonicalPublishState: z.string().trim().min(1).nullable().optional(),
    canonicalAdapterArtifactId: z.string().trim().min(1).nullable().optional(),
    version: z.number().int().positive().default(1),
    terminalReason: z.string().trim().min(1).nullable().optional(),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
    completedAt: OptionalTimestampSchema,
    inputBundle: z
      .object({
        harnessRelease: z
          .object({ contentHash: z.string().trim().min(1) })
          .optional(),
        harnessRunManifest: z
          .object({
            harnessRelease: z
              .object({ contentHash: z.string().trim().min(1) })
              .optional(),
            runtimeTarget: z
              .object({
                placement: z.string().trim().min(1).optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
  }),
  gpuLeases: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        provider: z.string().trim().min(1).default("openpond"),
        state: z.string().trim().min(1),
        gpuType: z.string().trim().min(1).nullable().optional(),
        gpuCount: z.number().int().nonnegative().nullable().optional(),
        quotedHourlyUsd: OptionalMoneySchema,
        observedHourlyUsd: OptionalMoneySchema,
        readyAt: OptionalTimestampSchema,
        terminatedAt: OptionalTimestampSchema,
      }),
    )
    .default([]),
  rolloutGroups: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        groupIndex: z.number().int().nonnegative(),
        policyVersion: z.number().int().nonnegative(),
        state: z.string().trim().min(1),
        eligibleTrajectoryCount: z.number().int().nonnegative().default(0),
        rewardMean: OptionalMoneySchema,
        startedAt: OptionalTimestampSchema,
        completedAt: OptionalTimestampSchema,
      }),
    )
    .default([]),
  rollouts: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        groupId: z.string().trim().min(1),
        workerSlot: z.number().int().nonnegative(),
        attempt: z.number().int().positive().default(1),
        state: z.string().trim().min(1),
        startedAt: OptionalTimestampSchema,
        completedAt: OptionalTimestampSchema,
      }),
    )
    .default([]),
  trajectories: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        groupId: z.string().trim().min(1),
        rolloutId: z.string().trim().min(1),
        policyVersion: z.number().int().nonnegative(),
        rewardEligible: z.boolean(),
        reward: OptionalMoneySchema,
        terminalClass: z.string().trim().min(1).nullable().optional(),
        rewardComponents: z.record(z.string(), z.unknown()).default({}),
        promptTokenCount: z.number().int().nonnegative().nullable().optional(),
        outputTokenCount: z.number().int().nonnegative().nullable().optional(),
        consumedTrainingStepId: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional(),
        createdAt: z.string().trim().min(1),
        updatedAt: z.string().trim().min(1),
      }),
    )
    .default([]),
  trainingSteps: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        groupId: z.string().trim().min(1),
        stepIndex: z.number().int().positive(),
        inputPolicyVersion: z.number().int().nonnegative(),
        outputPolicyVersion: z.number().int().nonnegative(),
        state: z.string().trim().min(1),
        metrics: z
          .record(
            z.string(),
            z.union([z.number(), z.string(), z.boolean(), z.null()]),
          )
          .default({}),
        startedAt: OptionalTimestampSchema,
        committedAt: OptionalTimestampSchema,
      }),
    )
    .default([]),
  checkpoints: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        policyVersion: z.number().int().nonnegative(),
        state: z.string().trim().min(1),
        adapterSha256: z.string().trim().min(8).nullable().optional(),
        sizeBytes: z.number().int().nonnegative().nullable().optional(),
        isLatest: z.boolean().default(false),
        isFinal: z.boolean().default(false),
        readyAt: OptionalTimestampSchema,
        updatedAt: z.string().trim().min(1),
      }),
    )
    .default([]),
  evaluations: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        kind: z.enum(["baseline", "candidate"]),
        policyVersion: z.number().int().nonnegative(),
        state: z.string().trim().min(1),
        score: OptionalMoneySchema,
        threshold: OptionalMoneySchema,
        passed: z.boolean().nullable().optional(),
        createdAt: z.string().trim().min(1),
      }),
    )
    .default([]),
  telemetry: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        itemId: z.string().trim().min(1),
        sequence: z.number().int().nonnegative(),
        kind: z.enum(["event", "observation"]),
        event: RunTelemetryEventSchema.nullable().optional(),
        observation: MetricObservationSchema.nullable().optional(),
      }),
    )
    .default([]),
  commands: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        commandType: z.string().trim().min(1),
        state: z.string().trim().min(1),
        errorCode: z.string().trim().min(1).nullable().optional(),
        createdAt: z.string().trim().min(1),
        updatedAt: z.string().trim().min(1),
        completedAt: OptionalTimestampSchema,
      }),
    )
    .default([]),
  outbox: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        commandType: z.string().trim().min(1),
        state: z.string().trim().min(1),
        attemptCount: z.number().int().nonnegative().default(0),
        lastErrorCode: z.string().trim().min(1).nullable().optional(),
        createdAt: z.string().trim().min(1),
        updatedAt: z.string().trim().min(1),
        completedAt: OptionalTimestampSchema,
      }),
    )
    .default([]),
});

export type ManagedJobDetail = z.infer<typeof ManagedJobDetailSchema>;

export function parseManagedJobDetail(value: unknown): ManagedJobDetail {
  return ManagedJobDetailSchema.parse(value);
}

export async function persistManagedRunEvidence(input: {
  store: SqliteStore;
  ref: TrainingExecutionRef;
  detail: ManagedJobDetail;
  now?: () => Date;
}): Promise<ManagedTrainingRunEvidence | null> {
  const job = await input.store.getTrainingJob(input.ref.runId);
  if (!job) return null;
  const plan = await input.store.getTrainingPlan(job.planId);
  const learningRate =
    plan?.recipe.method === "grpo" ? plan.recipe.optimizer.learningRate : null;
  const evidence = managedRunEvidence(input.detail, input.now?.() ?? new Date());
  const existingEvents = await input.store.listTrainingJobEvents(job.id);
  const events = managedTrainingEvents({
    detail: input.detail,
    jobId: job.id,
    learningRate,
    existingEvents,
  });
  for (const event of events) {
    await input.store.saveTrainingJobEvent(event);
  }
  await input.store.saveTrainingJob({
    ...job,
    metadata: {
      ...job.metadata,
      managedTrainingEvidence: evidence,
      optimizerUpdatesObserved: evidence.progress.committedOptimizerSteps,
      trainingMethod:
        plan?.recipe.method === "grpo"
          ? "grpo"
          : job.metadata.trainingMethod,
    },
  });
  return evidence;
}

function managedRunEvidence(
  detail: ManagedJobDetail,
  syncedAt: Date,
): ManagedTrainingRunEvidence {
  const eligible = detail.trajectories.filter(
    (trajectory) => trajectory.rewardEligible,
  );
  const committedSteps = detail.trainingSteps.filter(
    (step) => step.state === "committed",
  );
  const finalGroup = [...detail.rolloutGroups]
    .filter((group) => group.rewardMean != null)
    .sort((left, right) => left.groupIndex - right.groupIndex)
    .at(-1);
  const lease = [...detail.gpuLeases]
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(-1);
  const checkpoint = [...detail.checkpoints]
    .filter((candidate) => candidate.state === "ready")
    .sort(
      (left, right) =>
        Number(right.isFinal) - Number(left.isFinal) ||
        Number(right.isLatest) - Number(left.isLatest) ||
        right.policyVersion - left.policyVersion,
    )
    .at(0);
  return ManagedTrainingRunEvidenceSchema.parse({
    schemaVersion: "openpond.managedTrainingRunEvidence.v1",
    provider: "openpond",
    providerRunId: detail.job.id,
    state: detail.job.state,
    progress: {
      targetOptimizerSteps: detail.job.targetGroups,
      committedOptimizerSteps: committedSteps.length,
    },
    reward: {
      finalMean: decimal(finalGroup?.rewardMean),
      trajectoryCount: detail.trajectories.length,
      eligibleTrajectoryCount: eligible.length,
    },
    usage: {
      inputTokens: sumNullableIntegers(
        eligible.map((trajectory) => trajectory.promptTokenCount),
      ),
      outputTokens: sumNullableIntegers(
        eligible.map((trajectory) => trajectory.outputTokenCount),
      ),
      environmentExecutions: detail.rollouts.length,
    },
    resource: {
      provider: "openpond",
      gpuType: lease?.gpuType ?? null,
      gpuCount: lease?.gpuCount ?? null,
      hourlyCostUsd: decimal(
        lease?.observedHourlyUsd ?? lease?.quotedHourlyUsd,
      ),
    },
    cost: {
      totalUsd: decimal(detail.job.accruedSpendUsd),
    },
    checkpoint: checkpoint
      ? {
          id: checkpoint.id,
          policyVersion: checkpoint.policyVersion,
          sha256: checkpoint.adapterSha256 ?? null,
          sizeBytes: checkpoint.sizeBytes ?? null,
        }
      : null,
    evaluations: detail.evaluations.map((evaluation) => ({
      kind: evaluation.kind,
      policyVersion: evaluation.policyVersion,
      score: decimal(evaluation.score),
      threshold: decimal(evaluation.threshold),
      passed: evaluation.passed ?? null,
    })),
    canonicalPublication: {
      state: detail.job.canonicalPublishState ?? null,
      artifactId: detail.job.canonicalAdapterArtifactId ?? null,
    },
    syncedAt: syncedAt.toISOString(),
  });
}

function managedTrainingEvents(input: {
  detail: ManagedJobDetail;
  jobId: string;
  learningRate: number | null;
  existingEvents: TrainingJobEvent[];
}): TrainingJobEvent[] {
  const candidates: EventCandidate[] = [];
  const startedAt =
    input.detail.gpuLeases
      .flatMap((lease) => (lease.readyAt ? [lease.readyAt] : []))
      .sort()
      .at(0) ?? input.detail.job.createdAt;
  candidates.push({
    identity: "start",
    timestamp: startedAt,
    type: "start",
    payload: {
      device:
        input.detail.gpuLeases.find((lease) => lease.gpuType)?.gpuType ??
        "OpenPond Managed",
      provider:
        input.detail.gpuLeases.find((lease) => lease.provider)?.provider ??
        "openpond",
    },
  });

  for (const lease of input.detail.gpuLeases) {
    candidates.push({
      identity: `gpu-lease:${lease.id}`,
      timestamp: lease.terminatedAt ?? lease.readyAt ?? input.detail.job.updatedAt,
      type: lease.state === "failed" ? "failure" : "progress",
      payload: {
        telemetryType: "gpu_worker_state",
        telemetrySource: "control_plane",
        message: `${providerLabel(lease.provider)} GPU worker ${humanLabel(lease.state)}`,
        provider: lease.provider,
        state: lease.state,
        gpuType: lease.gpuType ?? null,
      },
    });
  }

  const rolloutById = new Map(
    input.detail.rollouts.map((rollout) => [rollout.id, rollout]),
  );
  const orderedTrajectories = [...input.detail.trajectories].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.rolloutId.localeCompare(right.rolloutId),
  );
  orderedTrajectories.forEach((trajectory, index) => {
    const rollout = rolloutById.get(trajectory.rolloutId);
    candidates.push({
      identity: `rollout:${trajectory.id}`,
      timestamp: rollout?.completedAt ?? trajectory.updatedAt,
      type: "metric",
      payload: {
        metricKind: "rollout_trajectory",
        rolloutIndex: index + 1,
        rolloutId: trajectory.rolloutId,
        rolloutGroupId: trajectory.groupId,
        policyVersion: trajectory.policyVersion,
        workerSlot: rollout?.workerSlot ?? null,
        reward: decimal(trajectory.reward),
        rewardEligible: trajectory.rewardEligible,
        rewardComponents: trajectory.rewardComponents,
        failureClass: trajectory.rewardEligible
          ? null
          : trajectory.terminalClass ?? "not_reward_eligible",
        failureCode:
          trajectory.rewardEligible
            ? null
            : failureCode(trajectory.rewardComponents),
        inputTokens: trajectory.promptTokenCount ?? 0,
        outputTokens: trajectory.outputTokenCount ?? 0,
      },
    });
  });

  for (const group of input.detail.rolloutGroups) {
    candidates.push({
      identity: `group:${group.id}`,
      timestamp: group.completedAt ?? group.startedAt ?? input.detail.job.updatedAt,
      type: group.state === "failed" ? "failure" : "progress",
      payload: {
        telemetryType: "rollout_group_state",
        telemetrySource: "control_plane",
        message: `Rollout group ${group.groupIndex + 1} ${humanLabel(group.state)}`,
        groupIndex: group.groupIndex,
        policyVersion: group.policyVersion,
        eligibleAttempts: group.eligibleTrajectoryCount,
        rewardMean: decimal(group.rewardMean),
      },
    });
  }

  for (const command of input.detail.outbox) {
    candidates.push({
      identity: `control-command:${command.id}`,
      timestamp: command.updatedAt,
      type: command.lastErrorCode ? "failure" : "progress",
      payload: {
        telemetryType: "control_plane_command",
        telemetrySource: "control_plane",
        message: `${humanLabel(command.commandType)} ${humanLabel(command.state)}`,
        commandType: command.commandType,
        state: command.state,
        attempts: command.attemptCount,
        errorCode: command.lastErrorCode ?? null,
      },
    });
  }

  for (const command of input.detail.commands) {
    candidates.push({
      identity: `worker-command:${command.id}`,
      timestamp: command.updatedAt,
      type: command.errorCode ? "failure" : "progress",
      payload: {
        telemetryType: "worker_command",
        telemetrySource: "runtime",
        message: `${humanLabel(command.commandType)} ${humanLabel(command.state)}`,
        commandType: command.commandType,
        state: command.state,
        errorCode: command.errorCode ?? null,
      },
    });
  }

  const trajectoryByStep = new Map<string, ManagedJobDetail["trajectories"]>();
  for (const trajectory of input.detail.trajectories) {
    if (!trajectory.consumedTrainingStepId) continue;
    const current = trajectoryByStep.get(trajectory.consumedTrainingStepId);
    if (current) current.push(trajectory);
    else trajectoryByStep.set(trajectory.consumedTrainingStepId, [trajectory]);
  }
  const groupById = new Map(
    input.detail.rolloutGroups.map((group) => [group.id, group]),
  );
  const telemetryMetricsByStep = new Map<number, Record<string, number>>();
  for (const item of input.detail.telemetry) {
    if (item.kind !== "observation" || !item.observation) continue;
    const step = item.observation.lineage.step;
    if (step == null) continue;
    const current = telemetryMetricsByStep.get(step) ?? {};
    current[item.observation.metricId] = item.observation.value;
    telemetryMetricsByStep.set(step, current);
  }
  for (const step of input.detail.trainingSteps.filter(
    (candidate) => candidate.state === "committed",
  )) {
    const trajectories = trajectoryByStep.get(step.id) ?? [];
    const group = groupById.get(step.groupId);
    const telemetry = telemetryMetricsByStep.get(step.stepIndex) ?? {};
    candidates.push({
      identity: `optimizer:${step.id}`,
      timestamp:
        step.committedAt ?? step.startedAt ?? input.detail.job.updatedAt,
      type: "metric",
      payload: {
        schemaVersion: "openpond.policyOptimizationMetric.v1",
        metricKind: "policy_optimization",
        method: "grpo",
        step: step.stepIndex,
        timestamp:
          step.committedAt ?? step.startedAt ?? input.detail.job.updatedAt,
        learningRate: input.learningRate,
        policyLoss:
          metricNumber(step.metrics, "policyLoss") ??
          metricNumber(telemetry, "optimizer.loss"),
        valueLoss: metricNumber(step.metrics, "valueLoss"),
        meanReward:
          metricNumber(step.metrics, "rewardMean") ??
          decimal(group?.rewardMean),
        meanReturn: metricNumber(step.metrics, "meanReturn"),
        kl:
          metricNumber(step.metrics, "kl") ??
          metricNumber(telemetry, "optimizer.kl"),
        entropy:
          metricNumber(step.metrics, "entropy") ??
          metricNumber(telemetry, "optimizer.entropy"),
        policyClipFraction: metricNumber(
          step.metrics,
          "policyClipFraction",
        ) ?? metricNumber(telemetry, "optimizer.clip_fraction"),
        valueClipFraction: metricNumber(step.metrics, "valueClipFraction"),
        explainedVariance: metricNumber(step.metrics, "explainedVariance"),
        rolloutLearnerLag: 0,
        inputTokens: sumNullableIntegers(
          trajectories.map((trajectory) => trajectory.promptTokenCount),
        ),
        outputTokens: sumNullableIntegers(
          trajectories.map((trajectory) => trajectory.outputTokenCount),
        ),
        environmentExecutions: trajectories.length,
        costUsd: null,
        inputPolicyVersion: step.inputPolicyVersion,
        outputPolicyVersion: step.outputPolicyVersion,
      },
    });
  }

  for (const item of input.detail.telemetry) {
    if (item.kind === "event" && item.event) {
      candidates.push({
        identity: `telemetry-event:${item.itemId}`,
        timestamp: item.event.occurredAt,
        type:
          item.event.type === "run_failed"
            ? "failure"
            : item.event.type === "checkpoint_committed"
              ? "checkpoint"
              : item.event.type === "run_completed"
                ? "complete"
                : item.event.type === "run_started"
                  ? "start"
                  : "progress",
        payload: {
          telemetryType: item.event.type,
          telemetrySource: item.event.source ?? "managed",
          step: item.event.lineage.step ?? null,
          ...item.event.attributes,
        },
      });
      continue;
    }
    if (item.kind === "observation" && item.observation) {
      candidates.push({
        identity: `telemetry-observation:${item.itemId}`,
        timestamp: item.observation.observedAt,
        type: "metric",
        payload: {
          metricKind: "managed_telemetry",
          metricId: item.observation.metricId,
          value: item.observation.value,
          step: item.observation.lineage.step ?? null,
        },
      });
    }
  }

  for (const checkpoint of input.detail.checkpoints.filter(
    (candidate) => candidate.state === "ready",
  )) {
    candidates.push({
      identity: `checkpoint:${checkpoint.id}`,
      timestamp: checkpoint.readyAt ?? checkpoint.updatedAt,
      type: "checkpoint",
      payload: {
        checkpointId: checkpoint.id,
        policyVersion: checkpoint.policyVersion,
        sha256: checkpoint.adapterSha256 ?? null,
        sizeBytes: checkpoint.sizeBytes ?? null,
        final: checkpoint.isFinal,
      },
    });
  }

  if (
    ["completed", "cancelled", "budget_exhausted", "failed"].includes(
      input.detail.job.state,
    )
  ) {
    candidates.push({
      identity: "complete",
      timestamp:
        input.detail.job.completedAt ?? input.detail.job.updatedAt,
      type:
        input.detail.job.state === "completed"
          ? "complete"
          : input.detail.job.state === "cancelled"
            ? "cancel"
            : "failure",
      payload: {
        state: input.detail.job.state,
        artifactCount: input.detail.checkpoints.filter(
          (checkpoint) => checkpoint.state === "ready",
        ).length,
        optimizerUpdates: input.detail.trainingSteps.filter(
          (step) => step.state === "committed",
        ).length,
      },
    });
  }

  const existingById = new Map(
    input.existingEvents.map((event) => [event.id, event]),
  );
  let nextSequence =
    Math.max(-1, ...input.existingEvents.map((event) => event.sequence)) + 1;
  return candidates
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.identity.localeCompare(right.identity),
    )
    .map((candidate) => {
      const id = managedEventId(input.jobId, candidate.identity);
      const existing = existingById.get(id);
      return TrainingJobEventSchema.parse({
        schemaVersion: "openpond.trainingJobEvent.v1",
        id,
        jobId: input.jobId,
        sequence: existing?.sequence ?? nextSequence++,
        type: candidate.type,
        timestamp: candidate.timestamp,
        payload: candidate.payload,
      });
    });
}

type EventCandidate = {
  identity: string;
  timestamp: string;
  type: TrainingJobEvent["type"];
  payload: Record<string, unknown>;
};

function managedEventId(jobId: string, identity: string): string {
  return `managed_event_${contentHash({ jobId, identity }).slice(0, 32)}`;
}

function humanLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function providerLabel(value: string): string {
  if (value.toLowerCase().includes("runpod")) return "RunPod";
  if (value.toLowerCase().includes("prime")) return "Prime Intellect";
  return value;
}

function metricNumber(
  values: Record<string, number | string | boolean | null>,
  key: string,
): number | null {
  const value = values[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decimal(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function failureCode(components: Record<string, unknown>): string | null {
  const value = components.failureCode;
  return typeof value === "string" && value.trim().length
    ? value.slice(0, 191)
    : null;
}

function sumNullableIntegers(
  values: Array<number | null | undefined>,
): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
