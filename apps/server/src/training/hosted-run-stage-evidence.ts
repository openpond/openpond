import { z } from "zod";
import { RunStageEvidenceSchema, type RunStageEvidence } from "@openpond/contracts";

const number = (value: unknown) =>
  value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const collection = <T extends z.ZodType>(schema: T) => z.array(schema).max(10_000).default([]);
const Raw = z
  .object({
    job: z
      .object({
        id: z.string(),
        teamId: z.string(),
        modelProjectId: z.string(),
        state: z.string(),
        targetGroups: z.number().int().nonnegative(),
        completedGroups: z.number().int().nonnegative(),
        optimizerUpdatesApplied: z.number().int().nonnegative().default(0),
        currentPolicyVersion: z.number().int().nonnegative(),
        inputBundle: z
          .object({
            recipe: z
              .object({ rolloutGroupSize: z.number().int().min(0).max(1000) })
              .passthrough()
              .optional(),
            executionIntent: z.object({ purpose: z.string() }).passthrough().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    gpuLeases: collection(
      z
        .object({
          state: z.string(),
          gpuType: z.string(),
          observedHourlyUsd: z.union([z.string(), z.number()]).nullable(),
          readyAt: z.string().nullable(),
          terminatedAt: z.string().nullable(),
          updatedAt: z.string(),
        })
        .passthrough(),
    ),
    rolloutGroups: collection(
      z
        .object({
          id: z.string(),
          groupIndex: z.number().int().nonnegative(),
          state: z.string(),
          rewardMean: z.union([z.string(), z.number()]).nullable(),
        })
        .passthrough(),
    ),
    rollouts: collection(
      z
        .object({
          id: z.string(),
          groupId: z.string(),
          workerSlot: z.number().int().nonnegative(),
          attempt: z.number().int().positive(),
          state: z.string(),
        })
        .passthrough(),
    ),
    trajectories: collection(
      z
        .object({ rolloutId: z.string(), reward: z.union([z.string(), z.number()]).nullable() })
        .passthrough(),
    ),
    checkpoints: collection(
      z.object({ adapterSha256: z.string().nullable().optional() }).passthrough(),
    ),
    policyVersions: collection(
      z.object({ version: z.number().int().nonnegative(), served: z.boolean() }).passthrough(),
    ),
    evaluations: collection(
      z
        .object({
          kind: z.string(),
          state: z.string(),
          score: z.union([z.string(), z.number()]).nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const Logs = z
  .object({
    entries: collection(
      z
        .object({
          id: z.string(),
          timestamp: z.string(),
          source: z.string(),
          message: z.string(),
          level: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Port the console's stage decisions without exposing task inputs or provider credentials. */
export function hostedRunStageEvidence(
  raw: unknown,
  logs: unknown,
  identity: { jobId: string; teamId: string; modelProjectId: string },
): RunStageEvidence {
  const detail = Raw.parse(raw),
    job = detail.job;
  if (
    job.id !== identity.jobId ||
    job.teamId !== identity.teamId ||
    job.modelProjectId !== identity.modelProjectId
  )
    throw new Error("Flow evidence belongs to a different training run.");
  const live = !["completed", "cancelled", "failed", "budget_exhausted"].includes(job.state);
  const qualification = job.inputBundle?.executionIntent?.purpose === "collection";
  const lease =
    detail.gpuLeases.find((item) => !item.terminatedAt) ??
    [...detail.gpuLeases].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const gpuLive = Boolean(lease?.readyAt && !lease.terminatedAt && live);
  const graded = detail.trajectories.filter((item) => number(item.reward) !== null).length;
  const stages = [
    {
      label: "Prepare",
      done: detail.gpuLeases.some((item) => item.readyAt),
      active: [
        "draft",
        "validating",
        "admitted",
        "provisioning_gpu",
        "provisioning_rollouts",
        "warming",
      ].includes(job.state),
    },
    {
      label: "Rollouts",
      done: job.targetGroups > 0 && job.completedGroups >= job.targetGroups,
      active:
        ["rollout_phase", "draining"].includes(job.state) &&
        !detail.rolloutGroups.some((group) => group.state === "scoring"),
      inLoop: true,
      detail: `${job.completedGroups}/${job.targetGroups} groups; ${graded} graded`,
      progress: job.targetGroups ? Math.min(1, job.completedGroups / job.targetGroups) : 0,
    },
    {
      label: "Grade",
      done:
        job.targetGroups > 0 &&
        detail.rolloutGroups.length >= job.targetGroups &&
        detail.rolloutGroups.every((group) => ["eligible", "consumed"].includes(group.state)),
      active:
        detail.rolloutGroups.some((group) => group.state === "scoring") ||
        detail.rollouts.some((rollout) => rollout.state === "scoring"),
      inLoop: true,
      detail: `${graded} graded`,
    },
    {
      label: "Update adapter",
      done: job.optimizerUpdatesApplied > 0,
      active: job.state === "update_phase",
      inLoop: true,
      skip: qualification,
      detail: `${job.optimizerUpdatesApplied} updates`,
    },
    {
      label: "Save checkpoint",
      detail: "Write to storage",
      done: detail.checkpoints.some((item) => item.adapterSha256),
      active: false,
      inLoop: true,
      skip: qualification,
    },
    {
      label: "Activate policy",
      done: detail.policyVersions.some((item) => item.version > 0 && item.served),
      active: job.state === "reloading",
      inLoop: true,
      skip: qualification,
      detail: `Policy v${job.currentPolicyVersion}`,
    },
    {
      label: "Evaluate",
      done: detail.evaluations.some(
        (item) => item.kind === "candidate" && item.state === "completed",
      ),
      active: detail.evaluations.some(
        (item) => item.kind === "candidate" && item.state === "running",
      ),
      skip: qualification,
    },
    { label: "Finish", done: job.state === "completed", active: false },
  ];
  const rewards = new Map(detail.trajectories.map((item) => [item.rolloutId, number(item.reward)]));
  const groups = [...detail.rolloutGroups].sort((a, b) => a.groupIndex - b.groupIndex).slice(-50);
  const count = Math.max(job.targetGroups, ...groups.map((group) => group.groupIndex + 1), 0);
  return RunStageEvidenceSchema.parse({
    jobId: job.id,
    teamId: job.teamId,
    modelProjectId: job.modelProjectId,
    state: job.state,
    policyVersion: job.currentPolicyVersion,
    groupsCompleted: job.completedGroups,
    groupsTarget: job.targetGroups,
    live,
    nodes: stages
      .filter((stage) => !stage.skip)
      .map((stage) => ({
        label: stage.label,
        state: live && stage.active ? "active" : stage.done ? "done" : live ? "pending" : "missing",
        status:
          live && stage.active
            ? "In progress"
            : stage.done
              ? "Recorded"
              : live
                ? "Pending"
                : "Not recorded",
        ...(stage.inLoop ? { inLoop: true } : {}),
        ...(stage.detail ? { detail: stage.detail } : {}),
        ...(stage.progress !== undefined ? { progress: stage.progress } : {}),
      })),
    inference: lease
      ? {
          label: lease.gpuType.replace(/^NVIDIA\s+/i, "").replace(/-SXM\d*-?/, " "),
          state: gpuLive ? "active" : lease.readyAt ? "done" : live ? "pending" : "missing",
          status: gpuLive ? "Worker ready" : lease.state.replaceAll("_", " "),
          ...(number(lease.observedHourlyUsd) !== null
            ? { detail: `$${number(lease.observedHourlyUsd)!.toFixed(2)}/hr` }
            : {}),
        }
      : null,
    groups: (groups.length
      ? groups
      : Array.from({ length: Math.min(job.targetGroups, 50) }, (_, index) => ({
          id: "",
          groupIndex: index,
          state: "planned",
          rewardMean: null,
        }))
    ).map((group) => ({
      index: group.groupIndex,
      state: group.state,
      meanReward: number(group.rewardMean),
      plannedSlots: job.inputBundle?.recipe?.rolloutGroupSize ?? 0,
      attempts: detail.rollouts
        .filter((item) => item.groupId === group.id)
        .slice(-1000)
        .map((item) => ({
          id: item.id,
          slot: item.workerSlot,
          attempt: item.attempt,
          state: item.state,
          reward: rewards.get(item.id) ?? null,
        })),
    })),
    groupCount: count,
    logs: Logs.parse(logs)
      .entries.slice(-200)
      .map((entry) => ({
        id: entry.id,
        at: entry.timestamp,
        source: entry.source.replaceAll("_", " "),
        message: entry.message,
        level: entry.level,
      })),
  });
}
