import type { Taskset, TrainingRunDetail } from "@openpond/contracts";

export type RolloutRewardComponent = {
  id: string;
  label: string;
  score: number;
  passed: boolean | null;
  feedback: string | null;
};

export type RolloutRewardTrajectory = {
  id: string;
  rolloutIndex: number | null;
  workerSlot: number | null;
  attempt: number;
  policyVersion: number | null;
  reward: number | null;
  rewardEligible: boolean;
  terminalClass: string | null;
  failure: string | null;
  inputTokens: number;
  outputTokens: number;
  components: RolloutRewardComponent[];
};

export type RolloutRewardGroup = {
  id: string;
  groupIndex: number;
  taskId: string | null;
  taskLabel: string | null;
  taskFamily: string | null;
  policyVersion: number | null;
  optimizerDisposition: "applied" | "skipped" | "pending";
  optimizerStep: number | null;
  mean: number | null;
  minimum: number | null;
  maximum: number | null;
  trajectories: RolloutRewardTrajectory[];
};

type MutableGroup = Omit<
  RolloutRewardGroup,
  "mean" | "minimum" | "maximum" | "optimizerDisposition" | "optimizerStep"
>;

export function rolloutRewardGroups(
  events: TrainingRunDetail["events"],
  tasks: Taskset["tasks"] = [],
): RolloutRewardGroup[] {
  const trainingTasks = tasks.filter((task) => task.split === "train");
  const trainingTaskById = new Map(
    trainingTasks.map((task) => [task.id, task] as const),
  );
  const groups = new Map<string, MutableGroup>();
  const skipped = new Set<string>();
  const directlyApplied = new Map<string, number | null>();
  const committedSteps = new Set<number>();

  for (const event of events) {
    if (event.type !== "metric") continue;
    const payload = event.payload;
    if (payload.metricKind === "rollout_trajectory") {
      const id = stringValue(payload.rolloutGroupId) ?? "group-0";
      const existing = groups.get(id);
      const groupIndex = integer(payload.rolloutGroupIndex) ?? existing?.groupIndex ?? groups.size;
      const reportedTaskId = stringValue(payload.taskId);
      const task =
        (reportedTaskId
          ? trainingTaskById.get(reportedTaskId)
          : null) ??
        (trainingTasks.length
          ? trainingTasks[groupIndex % trainingTasks.length] ?? null
          : null);
      const taskMetadata = record(task?.metadata);
      const trajectory: RolloutRewardTrajectory = {
        id: event.id,
        rolloutIndex: integer(payload.rolloutIndex),
        workerSlot: integer(payload.workerSlot),
        attempt: integer(payload.attempt) ?? 1,
        policyVersion: integer(payload.policyVersion),
        reward: finiteNumber(payload.reward),
        rewardEligible: payload.rewardEligible === true,
        terminalClass: stringValue(payload.terminalClass),
        failure:
          stringValue(payload.failureCode) ?? stringValue(payload.failureClass),
        inputTokens: integer(payload.inputTokens) ?? 0,
        outputTokens: integer(payload.outputTokens) ?? 0,
        components: rewardComponents(payload),
      };
      groups.set(id, {
        id,
        groupIndex,
        taskId: reportedTaskId ?? task?.id ?? existing?.taskId ?? null,
        taskLabel: taskLabel(task) ?? existing?.taskLabel ?? null,
        taskFamily:
          stringValue(payload.taskFamily) ??
          stringValue(payload.scenarioFamily) ??
          task?.clusterKey ??
          stringValue(taskMetadata.scenarioFamily) ??
          existing?.taskFamily ??
          null,
        policyVersion:
          integer(payload.policyVersion) ?? existing?.policyVersion ?? null,
        trajectories: [...(existing?.trajectories ?? []), trajectory],
      });
      continue;
    }
    if (payload.metricKind === "optimizer_disposition") {
      const groupId = stringValue(payload.rolloutGroupId);
      if (!groupId) continue;
      const disposition = stringValue(payload.optimizerDisposition)
        ?? stringValue(payload.disposition)
        ?? stringValue(payload.remotePhase);
      if (disposition?.includes("skipped")) skipped.add(groupId);
      if (disposition === "applied") {
        directlyApplied.set(groupId, integer(payload.step));
      }
      continue;
    }
    if (payload.metricKind === "policy_optimization") {
      const step = integer(payload.step);
      const groupId = stringValue(payload.rolloutGroupId);
      if (step !== null) committedSteps.add(step);
      if (groupId) directlyApplied.set(groupId, step);
    }
  }

  return [...groups.values()]
    .sort((left, right) => left.groupIndex - right.groupIndex)
    .map((group) => {
      const rewards = group.trajectories.flatMap((trajectory) =>
        trajectory.rewardEligible && trajectory.reward !== null
          ? [trajectory.reward]
          : [],
      );
      const directStep = directlyApplied.get(group.id);
      let optimizerStep = directStep === undefined ? null : directStep;
      if (optimizerStep === null && !skipped.has(group.id)) {
        const candidate = group.groupIndex + 1;
        if (committedSteps.has(candidate)) optimizerStep = candidate;
      }
      return {
        ...group,
        optimizerDisposition: skipped.has(group.id)
          ? "skipped"
          : optimizerStep !== null
            ? "applied"
            : "pending",
        optimizerStep,
        mean: average(rewards),
        minimum: rewards.length ? Math.min(...rewards) : null,
        maximum: rewards.length ? Math.max(...rewards) : null,
      };
    });
}

function rewardComponents(
  payload: Record<string, unknown>,
): RolloutRewardComponent[] {
  const source = [
    payload.rewardComponents,
    payload.rubricComponents,
    payload.components,
  ].find(isRecord);
  if (!source) return [];
  return Object.entries(source).flatMap(([id, raw]) => {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return [{
        id,
        label: humanize(id),
        score: raw,
        passed: null,
        feedback: null,
      }];
    }
    if (!isRecord(raw)) return [];
    const score = [raw.score, raw.reward, raw.value, raw.rewardContribution]
      .map(finiteNumber)
      .find((value): value is number => value !== null);
    if (score === undefined) return [];
    return [{
      id,
      label: stringValue(raw.label) ?? stringValue(raw.name) ?? humanize(id),
      score,
      passed: typeof raw.passed === "boolean" ? raw.passed : null,
      feedback: stringValue(raw.feedback),
    }];
  });
}

function average(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function humanize(value: string): string {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function taskLabel(task: Taskset["tasks"][number] | null): string | null {
  if (!task) return null;
  const input = record(task.input);
  const source = [
    input.title,
    input.name,
    input.prompt,
    input.instruction,
    input.question,
    input.query,
  ].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (!source) return null;
  const firstParagraph = source.trim().split(/\n\s*\n/, 1)[0]!.replaceAll(/\s+/g, " ");
  return firstParagraph.length > 110
    ? `${firstParagraph.slice(0, 107).trimEnd()}…`
    : firstParagraph;
}
