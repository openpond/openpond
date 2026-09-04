import { memo, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import type {
  RolloutRewardGroup,
  RolloutRewardTrajectory,
} from "./training-rollout-metrics";
import { summarizeRolloutRewardProgress } from "./training-rollout-metrics";

type RolloutProgress = {
  completedGroups: number | null;
  targetGroups: number | null;
};

export const TrainingRolloutRewardChart = memo(
  function TrainingRolloutRewardChart({
    groups,
    live,
    progress,
  }: {
    groups: RolloutRewardGroup[];
    live: boolean;
    progress: RolloutProgress;
  }) {
    const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
    const selectedGroup =
      groups.find((group) => group.id === selectedGroupId) ?? groups.at(-1) ?? null;
    const summary = useMemo(() => {
      const result = summarizeRolloutRewardProgress(groups.length, progress);
      const scoredRewards = groups.flatMap((group) =>
        group.trajectories.flatMap((trajectory) =>
          trajectory.rewardEligible && trajectory.reward !== null
            ? [trajectory.reward]
            : [],
        ),
      );
      return {
        ...result,
        attemptsScored: scoredRewards.length,
        averageSignal: average(scoredRewards),
        updatesApplied: groups.filter(
          (group) => group.optimizerDisposition === "applied",
        ).length,
      };
    }, [groups, progress]);

    return (
      <article className="training-metric-chart-card training-rollout-reward-card">
        <header>
          <div className="training-metric-chart-title">
            <h4>Training rewards</h4>
            <span>
              {summary.targetTasks
                ? `${summary.completedTasks} of ${summary.targetTasks} tasks complete`
                : live
                  ? "Waiting for task results"
                  : "No task results"}
            </span>
          </div>
          {summary.averageSignal !== null ? (
            <div className="training-reward-header-value">
              <span>Average signal</span>
              <strong>{formatReward(summary.averageSignal)}</strong>
            </div>
          ) : null}
        </header>

        <div className="training-reward-explanation">
          <strong>This is not a model-quality trend.</strong>
          <span>
            Each task is a different training scenario. Compare attempts within a
            task to understand its reward; use Evaluation to compare the model on
            the same benchmark before and after training.
          </span>
        </div>

        {summary.targetTasks ? (
          <TrainingTaskProgress live={live} summary={summary} />
        ) : null}

        {groups.length ? (
          <>
            <dl className="training-reward-summary">
              <Metric label="Tasks observed" value={String(summary.observedTasks)} />
              <Metric label="Attempts scored" value={String(summary.attemptsScored)} />
              <Metric
                label="Average signal"
                value={formatOptionalReward(summary.averageSignal)}
              />
              <Metric label="Policy updates" value={String(summary.updatesApplied)} />
            </dl>

            <section className="training-task-results">
              <header>
                <div>
                  <h5>Task results</h5>
                  <span>Shown in training order</span>
                </div>
                <div
                  aria-label="Reward scale from negative one to one"
                  className="training-task-reward-scale"
                >
                  <span>−1</span><span>0</span><span>1</span>
                </div>
              </header>
              <div className="training-task-results-list">
                {groups.map((group, position) => {
                  const isPartial = position >= summary.completedTasks;
                  return (
                    <TaskResultRow
                      group={group}
                      isPartial={isPartial}
                      key={group.id}
                      live={live}
                      onSelect={setSelectedGroupId}
                      selected={group.id === selectedGroup?.id}
                    />
                  );
                })}
              </div>
            </section>

            {selectedGroup ? (
              <TaskDetail
                group={selectedGroup}
                live={live}
                partial={groups.indexOf(selectedGroup) >= summary.completedTasks}
              />
            ) : null}
          </>
        ) : (
          <div className="training-metric-chart-empty">
            <span>
              {live
                ? "Waiting for the first training task…"
                : "This run did not report training rewards."}
            </span>
          </div>
        )}
      </article>
    );
  },
);

function TrainingTaskProgress({
  live,
  summary,
}: {
  live: boolean;
  summary: ReturnType<typeof summarizeRolloutRewardProgress>;
}) {
  const completedWidth = percentage(summary.completedTasks, summary.targetTasks);
  const partialWidth = percentage(summary.activeTasks, summary.targetTasks);
  const activeLabel = live ? "in progress" : "interrupted";
  return (
    <section className="training-reward-progress-section">
      <div
        aria-label={`${summary.completedTasks} of ${summary.targetTasks} tasks complete, ${summary.activeTasks} ${activeLabel}, ${summary.notStartedTasks} not started`}
        className="training-reward-progress"
        role="progressbar"
        aria-valuemax={summary.targetTasks}
        aria-valuemin={0}
        aria-valuenow={summary.completedTasks}
      >
        <span className="complete" style={{ width: `${completedWidth}%` }} />
        {summary.activeTasks ? (
          <span className="partial" style={{ width: `${partialWidth}%` }} />
        ) : null}
      </div>
      <div className="training-reward-progress-legend">
        <span><i className="complete" />{summary.completedTasks} complete</span>
        {summary.activeTasks ? (
          <span><i className="partial" />{summary.activeTasks} {activeLabel}</span>
        ) : null}
        {summary.notStartedTasks ? (
          <span><i />{summary.notStartedTasks} not started</span>
        ) : null}
      </div>
    </section>
  );
}

function TaskResultRow({
  group,
  isPartial,
  live,
  onSelect,
  selected,
}: {
  group: RolloutRewardGroup;
  isPartial: boolean;
  live: boolean;
  onSelect: (id: string) => void;
  selected: boolean;
}) {
  const rewarded = group.trajectories.filter(
    (trajectory) => trajectory.reward !== null,
  );
  const rangeStart = rewardPosition(group.minimum);
  const rangeEnd = rewardPosition(group.maximum);
  const rangeStyle = {
    "--reward-range-start": `${rangeStart}%`,
    "--reward-range-width": `${Math.max(0, rangeEnd - rangeStart)}%`,
  } as CSSProperties;
  return (
    <button
      aria-pressed={selected}
      className={`training-task-result-row${selected ? " selected" : ""}`}
      onClick={() => onSelect(group.id)}
      type="button"
    >
      <span className="training-task-result-context">
        <strong>Task {group.groupIndex + 1}</strong>
        <small>{groupContextLabel(group)}</small>
      </span>
      <span
        aria-label={attemptRewardLabel(group)}
        className="training-task-reward-distribution"
        style={rangeStyle}
      >
        {group.minimum !== null && group.maximum !== null ? (
          <i className="range" />
        ) : null}
        {rewarded.map((trajectory, index) => (
          <i
            className={trajectory.rewardEligible ? "attempt" : "attempt ineligible"}
            key={trajectory.id}
            style={{ "--reward-position": `${rewardPosition(trajectory.reward)}%` } as CSSProperties}
          >
            <span className="sr-only">
              Attempt {index + 1}: {formatOptionalReward(trajectory.reward)}
            </span>
          </i>
        ))}
        {group.mean !== null ? (
          <i
            className="mean"
            style={{ "--reward-position": `${rewardPosition(group.mean)}%` } as CSSProperties}
          />
        ) : null}
      </span>
      <span className="training-task-result-mean">
        <small>Average</small>
        <strong>{formatOptionalReward(group.mean)}</strong>
      </span>
      <span className={`training-task-result-status ${taskStateClass(group, isPartial)}`}>
        {taskRowStateLabel(group, isPartial, live)}
      </span>
    </button>
  );
}

function TaskDetail({
  group,
  live,
  partial,
}: {
  group: RolloutRewardGroup;
  live: boolean;
  partial: boolean;
}) {
  return (
    <section className="training-rollout-group-detail">
      <header>
        <div>
          <h5>Task {group.groupIndex + 1}</h5>
          <span>{groupContextLabel(group)}</span>
        </div>
        <span className={`training-rollout-disposition ${taskStateClass(group, partial)}`}>
          {taskStateLabel(group, partial, live)}
        </span>
      </header>
      <dl className="training-rollout-group-summary">
        <Metric label="Average reward" value={formatOptionalReward(group.mean)} />
        <Metric label="Reward range" value={formatRewardRange(group)} />
        <Metric label="Attempts" value={String(group.trajectories.length)} />
        <Metric
          label="Policy version used"
          value={group.policyVersion === null ? "—" : String(group.policyVersion)}
        />
      </dl>
      <div className="training-rollout-trajectory-list">
        {group.trajectories.map((trajectory, index) => (
          <TrajectoryDetail
            key={trajectory.id}
            position={index}
            trajectory={trajectory}
          />
        ))}
      </div>
    </section>
  );
}

function TrajectoryDetail({
  position,
  trajectory,
}: {
  position: number;
  trajectory: RolloutRewardTrajectory;
}) {
  return (
    <details className="training-rollout-trajectory">
      <summary>
        <span>
          <strong>Attempt {position + 1}</strong>
          <small>
            {trajectory.workerSlot === null
              ? "Worker not reported"
              : `Worker ${trajectory.workerSlot + 1}`}
            {trajectory.attempt > 1 ? ` · Retry ${trajectory.attempt}` : ""}
          </small>
        </span>
        <span className={trajectory.rewardEligible ? "eligible" : "ineligible"}>
          {formatOptionalReward(trajectory.reward)}
        </span>
      </summary>
      <div className="training-rollout-trajectory-body">
        <dl>
          <Metric
            label="Status"
            value={trajectory.failure ?? trajectory.terminalClass ?? "Completed"}
          />
          <Metric label="Input tokens" value={trajectory.inputTokens.toLocaleString()} />
          <Metric label="Output tokens" value={trajectory.outputTokens.toLocaleString()} />
          <Metric
            label="Eligible for learning"
            value={trajectory.rewardEligible ? "Yes" : "No"}
          />
        </dl>
        <section>
          <h6>Rubric components</h6>
          {trajectory.components.length ? (
            <dl className="training-rollout-components">
              {trajectory.components.map((component) => (
                <div key={component.id}>
                  <dt>
                    <span>{component.label}</span>
                    {component.feedback ? <small>{component.feedback}</small> : null}
                  </dt>
                  <dd>
                    {formatReward(component.score)}
                    {component.passed === null
                      ? ""
                      : component.passed
                        ? " · Passed"
                        : " · Failed"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>The training provider did not report a rubric breakdown for this attempt.</p>
          )}
        </section>
      </div>
    </details>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function taskStateLabel(
  group: RolloutRewardGroup,
  partial: boolean,
  live: boolean,
): string {
  if (partial) return live ? "In progress" : "Interrupted";
  if (group.optimizerDisposition === "applied") return "Used for update";
  if (group.optimizerDisposition === "skipped") return "No learning signal";
  return live ? "Update pending" : "No update recorded";
}

function taskStateClass(group: RolloutRewardGroup, partial: boolean): string {
  if (partial) return "partial";
  return group.optimizerDisposition;
}

function taskRowStateLabel(
  group: RolloutRewardGroup,
  partial: boolean,
  live: boolean,
): string {
  if (partial) return live ? "In progress" : "Interrupted";
  if (group.optimizerDisposition === "applied") return "Updated";
  if (group.optimizerDisposition === "skipped") return "No update";
  return live ? "Pending" : "Not recorded";
}

function groupContextLabel(group: RolloutRewardGroup): string {
  return group.taskLabel ?? group.taskId ?? group.taskFamily ?? "Training task";
}

function attemptRewardLabel(group: RolloutRewardGroup): string {
  const rewards = group.trajectories.flatMap((trajectory) =>
    trajectory.reward === null ? [] : [formatReward(trajectory.reward)],
  );
  return rewards.length ? `Attempt rewards: ${rewards.join(", ")}` : "No rewards reported";
}

function percentage(value: number, total: number): number {
  return total ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
}

function rewardPosition(value: number | null): number {
  return value === null
    ? 50
    : Math.min(100, Math.max(0, ((value + 1) / 2) * 100));
}

function average(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function formatRewardRange(group: RolloutRewardGroup): string {
  if (group.minimum === null || group.maximum === null) return "—";
  return `${formatReward(group.minimum)}–${formatReward(group.maximum)}`;
}

function formatOptionalReward(value: number | null): string {
  return value === null ? "—" : formatReward(value);
}

function formatReward(value: number): string {
  return value.toFixed(4);
}
