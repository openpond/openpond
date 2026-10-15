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
        terminalReason: z.string().nullish(),
        canonicalPublishFailureCode: z.string().nullish(),
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
      z.object({ id: z.string().optional(), state: z.string().optional(), adapterSha256: z.string().nullable().optional() }).passthrough(),
    ),
    commands: collection(z.object({
      commandType: z.string(),
      state: z.string(),
      errorCode: z.string().nullish(),
      updatedAt: z.string(),
    }).passthrough()),
    policyVersions: collection(
      z.object({ version: z.number().int().nonnegative(), served: z.boolean() }).passthrough(),
    ),
    evaluations: collection(
      z
        .object({
          kind: z.string(),
          state: z.string(),
          score: z.union([z.string(), z.number()]).nullable(),
          metrics: z.object({
            taskCount: z.number().int().nonnegative().optional(),
            targetTaskCount: z.number().int().positive().optional(),
          }).passthrough().optional(),
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
  const candidateEvaluationStarted = !qualification && detail.evaluations.some((item) => item.kind === "candidate");
  const baseline = qualification ? undefined : detail.evaluations.find((item) => item.kind === "baseline");
  const baselineCount = baseline?.metrics?.taskCount;
  const baselineTarget = baseline?.metrics?.targetTaskCount;
  const baselineCounts = baselineCount !== undefined && baselineTarget !== undefined && baselineCount <= baselineTarget;
  const baselineScore = baseline?.state === "completed" ? number(baseline.score) : null;
  const lease =
    detail.gpuLeases.find((item) => !item.terminatedAt) ??
    [...detail.gpuLeases].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const gpuLive = Boolean(lease?.readyAt && !lease.terminatedAt && live);
  const graded = detail.trajectories.filter((item) => number(item.reward) !== null).length;
  const errors = stageErrors(detail);
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
      ].includes(job.state) && !baseline,
    },
    {
      label: "Baseline evaluation",
      done: baseline?.state === "completed",
      active: baseline?.state === "running",
      skip: !baseline,
      detail: [
        baselineCounts ? `${baselineCount}/${baselineTarget} cases graded` : "Case counts not recorded",
        baselineScore !== null ? `score ${baselineScore.toFixed(3)}` : null,
      ].filter(Boolean).join("; "),
      ...(baselineCounts ? { progress: baselineCount / baselineTarget } : {}),
    },
    {
      label: "Rollouts",
      done: job.targetGroups > 0 && job.completedGroups >= job.targetGroups,
      active:
        !candidateEvaluationStarted &&
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
        state: errors[stage.label] ? "failed" : live && stage.active ? "active" : stage.done ? "done" : live ? "pending" : "missing",
        status:
          errors[stage.label] ? "Error recorded" : live && stage.active
            ? "In progress"
            : stage.done
              ? "Recorded"
              : live
                ? "Pending"
                : "Not recorded",
        ...(stage.inLoop ? { inLoop: true } : {}),
        ...(stage.detail ? { detail: stage.detail } : {}),
        ...(errors[stage.label] ? { error: errors[stage.label] } : {}),
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

/** Preserve attributable failure evidence without treating unexecuted stages as failures. */
function stageErrors(detail: z.infer<typeof Raw>): Record<string, string> {
  const errors: Record<string, string> = {};
  const commandStages: Record<string, string> = {
    train_step: "Update adapter",
    upload_checkpoint: "Save checkpoint",
    qualify_checkpoint: "Save checkpoint",
    start_inference: detail.policyVersions.some(policy => policy.version > 0) ? "Activate policy" : "Prepare",
    score_reward_model: "Grade",
    stop: "Finish",
  };
  const latest = new Map<string, typeof detail.commands[number]>();
  for (const command of detail.commands) {
    const previous = latest.get(command.commandType);
    if (!previous || command.updatedAt > previous.updatedAt) latest.set(command.commandType, command);
  }
  for (const [type, command] of latest) {
    const stage = commandStages[type];
    if (stage && command.state === "failed") errors[stage] = `${type}: ${command.errorCode ?? "Worker command failed"}`;
  }
  const failedRollouts = detail.rollouts.filter(item => item.state.endsWith("failed"));
  if (failedRollouts.length) errors.Rollouts = `${failedRollouts.length} failed attempt(s). Inspect the rollout records for details.`;
  if (detail.evaluations.some(item => item.kind === "candidate" && item.state === "failed")) {
    errors.Evaluate = `Candidate evaluation failed. ${detail.job.terminalReason ?? "Inspect evaluation records for details."}`;
  }
  if (detail.evaluations.some(item => item.kind === "baseline" && item.state === "failed")) {
    errors["Baseline evaluation"] = `Baseline evaluation failed. ${detail.job.terminalReason ?? "Inspect evaluation records for details."}`;
  }
  const checkpoint = detail.checkpoints.find(item => item.state === "failed");
  if (checkpoint && !errors["Save checkpoint"]) errors["Save checkpoint"] = checkpoint.id ? `Checkpoint ${checkpoint.id} failed.` : "Checkpoint failed.";
  if (detail.job.state === "failed" && !detail.gpuLeases.some(lease => lease.readyAt)) errors.Prepare = detail.job.terminalReason ?? "Run preparation failed.";
  if (detail.job.canonicalPublishFailureCode) errors.Finish = detail.job.canonicalPublishFailureCode;
  return errors;
}
