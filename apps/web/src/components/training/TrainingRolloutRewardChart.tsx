import { memo, useMemo, useState } from "react";
import {
  CartesianGrid,
  Cell,
  ComposedChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  RolloutRewardGroup,
  RolloutRewardTrajectory,
} from "./training-rollout-metrics";

type MeanPoint = {
  kind: "mean";
  x: number;
  mean: number | null;
  groupId: string;
};

type TrajectoryPoint = {
  kind: "rollout";
  x: number;
  reward: number;
  groupId: string;
  eligible: boolean;
  rolloutNumber: number;
};

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
    const { domain, means, totalGroups, totalRollouts, trajectories } = useMemo(
      () => {
        const data = chartData(groups);
        const values = groups.flatMap((group) =>
          group.trajectories.flatMap((trajectory) =>
            trajectory.reward === null ? [] : [trajectory.reward],
          ),
        );
        return {
          ...data,
          domain: rewardDomain(values),
          totalRollouts: groups.reduce(
            (total, group) => total + group.trajectories.length,
            0,
          ),
          totalGroups: Math.max(
            progress.targetGroups ?? 0,
            groups.at(-1)?.groupIndex === undefined
              ? 0
              : groups.at(-1)!.groupIndex + 1,
          ),
        };
      },
      [groups, progress.targetGroups],
    );

    return (
      <article className="training-metric-chart-card training-rollout-reward-card">
        <header>
          <div className="training-metric-chart-title">
            <h4>Reward by rollout group</h4>
            <span>
              {groups.length
                ? progressLabel(groups.length, totalRollouts, progress)
                : live
                  ? "Live"
                  : "No data"}
            </span>
          </div>
          {selectedGroup ? (
            <div className="training-metric-chart-header-actions">
              {selectedGroup.mean !== null ? (
                <strong>{formatReward(selectedGroup.mean)}</strong>
              ) : null}
              <label className="training-rollout-group-select">
                <span className="sr-only">Select rollout group</span>
                <select
                  aria-label="Select rollout group"
                  onChange={(event) => setSelectedGroupId(event.currentTarget.value)}
                  value={selectedGroup.id}
                >
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {groupOptionLabel(group)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </header>

        {groups.length ? (
          <>
            <p className="training-rollout-chart-guide">
              Each column is a different task sampled multiple times. Compare the
              rollout dots within a column; differences between columns can reflect
              task difficulty as well as policy learning.
            </p>
            <div
              aria-label="Reward by rollout group"
              className="training-metric-card-chart training-rollout-reward-chart"
            >
              <ResponsiveContainer height="100%" width="100%">
                <ComposedChart
                  data={means}
                  margin={{ top: 22, right: 22, bottom: 26, left: 0 }}
                >
                  <CartesianGrid
                    stroke="var(--border)"
                    strokeDasharray="3 4"
                    vertical={false}
                  />
                  <XAxis
                    allowDecimals={false}
                    axisLine={false}
                    dataKey="x"
                    domain={[0.5, totalGroups + 0.5]}
                    fontSize={10}
                    label={{
                      value: "Rollout group",
                      position: "insideBottom",
                      offset: -16,
                      fill: "var(--muted)",
                      fontSize: 10,
                    }}
                    stroke="var(--muted)"
                    tickFormatter={(value) => String(Math.round(Number(value)))}
                    ticks={chartTicks(totalGroups)}
                    tickLine={false}
                    type="number"
                  />
                  <YAxis
                    axisLine={false}
                    domain={domain}
                    fontSize={10}
                    stroke="var(--muted)"
                    tickFormatter={formatReward}
                    tickLine={false}
                    width={66}
                  />
                  <Tooltip
                    content={(props) => (
                      <RolloutChartTooltip
                        active={props.active}
                        groups={groups}
                        payload={props.payload}
                      />
                    )}
                    cursor={{ stroke: "var(--border-strong, var(--border))" }}
                    isAnimationActive={false}
                    shared={false}
                  />
                  <Scatter
                    data={trajectories}
                    dataKey="reward"
                    isAnimationActive={false}
                    name="reward"
                    onClick={(point) =>
                      setSelectedGroupId(
                        (point.payload as TrajectoryPoint).groupId,
                      )
                    }
                  >
                    {trajectories.map((point, index) => (
                      <Cell
                        cursor="pointer"
                        fill={point.eligible ? "var(--text)" : "var(--warning, #f59e0b)"}
                        fillOpacity={point.groupId === selectedGroup?.id ? 0.95 : 0.5}
                        key={`${point.groupId}:${index}`}
                        stroke={point.groupId === selectedGroup?.id ? "var(--panel)" : "none"}
                        strokeWidth={2}
                      />
                    ))}
                  </Scatter>
                  <Scatter
                    data={means}
                    dataKey="mean"
                    isAnimationActive={false}
                    name="mean"
                    onClick={(point) =>
                      setSelectedGroupId((point.payload as MeanPoint).groupId)
                    }
                  >
                    {means.map((point) => (
                      <Cell
                        cursor="pointer"
                        fill="var(--cyan, #06b6d4)"
                        key={point.groupId}
                        stroke={point.groupId === selectedGroup?.id ? "var(--text)" : "var(--panel)"}
                        strokeWidth={point.groupId === selectedGroup?.id ? 2 : 1}
                      />
                    ))}
                  </Scatter>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="training-rollout-chart-legend" aria-label="Chart legend">
              <span><i className="mean" />Group mean</span>
              <span><i className="rollout" />Individual rollout</span>
            </div>
            {selectedGroup ? <RolloutGroupDetail group={selectedGroup} /> : null}
          </>
        ) : (
          <div className="training-metric-chart-empty">
            <span>{live ? "Waiting for the first rollout group…" : "No rollout rewards reported"}</span>
          </div>
        )}
      </article>
    );
  },
);

function RolloutGroupDetail({ group }: { group: RolloutRewardGroup }) {
  return (
    <section className="training-rollout-group-detail">
      <header>
        <div>
          <h5>Group {group.groupIndex + 1}</h5>
          <span>{groupContextLabel(group)}</span>
        </div>
        <span className={`training-rollout-disposition ${group.optimizerDisposition}`}>
          {dispositionLabel(group)}
        </span>
      </header>
      <dl className="training-rollout-group-summary">
        <Metric label="Mean" value={formatOptionalReward(group.mean)} />
        <Metric label="Reward range" value={formatRewardRange(group)} />
        <Metric label="Rollouts" value={String(group.trajectories.length)} />
        <Metric label="Policy version" value={group.policyVersion === null ? "—" : String(group.policyVersion)} />
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
  const rolloutNumber = trajectory.rolloutIndex === null
    ? position + 1
    : trajectory.rolloutIndex + 1;
  return (
    <details className="training-rollout-trajectory">
      <summary>
        <span>
          <strong>Rollout {rolloutNumber}</strong>
          <small>
            {trajectory.workerSlot === null ? "Worker —" : `Worker ${trajectory.workerSlot + 1}`}
            {trajectory.attempt > 1 ? ` · Attempt ${trajectory.attempt}` : ""}
          </small>
        </span>
        <span className={trajectory.rewardEligible ? "eligible" : "ineligible"}>
          {formatOptionalReward(trajectory.reward)}
        </span>
      </summary>
      <div className="training-rollout-trajectory-body">
        <dl>
          <Metric label="Status" value={trajectory.failure ?? trajectory.terminalClass ?? "Completed"} />
          <Metric label="Input tokens" value={trajectory.inputTokens.toLocaleString()} />
          <Metric label="Output tokens" value={trajectory.outputTokens.toLocaleString()} />
          <Metric label="Reward eligible" value={trajectory.rewardEligible ? "Yes" : "No"} />
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
                    {component.passed === null ? "" : component.passed ? " · Passed" : " · Failed"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>The training provider did not report a component breakdown for this rollout.</p>
          )}
        </section>
      </div>
    </details>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function chartData(groups: RolloutRewardGroup[]) {
  const means: MeanPoint[] = [];
  const trajectories: TrajectoryPoint[] = [];
  for (const group of groups) {
    const x = group.groupIndex + 1;
    means.push({
      kind: "mean",
      x,
      mean: group.mean,
      groupId: group.id,
    });
    const rewarded = group.trajectories.filter(
      (trajectory) => trajectory.reward !== null,
    );
    rewarded.forEach((trajectory, index) => {
      const offset = rewarded.length <= 1
        ? 0
        : ((index / (rewarded.length - 1)) - 0.5) * 0.34;
      trajectories.push({
        kind: "rollout",
        x: x + offset,
        reward: trajectory.reward!,
        groupId: group.id,
        eligible: trajectory.rewardEligible,
        rolloutNumber: trajectory.rolloutIndex === null
          ? index + 1
          : trajectory.rolloutIndex + 1,
      });
    });
  }
  return { means, trajectories };
}

function rewardDomain(values: number[]): [number, number] | ["auto", "auto"] {
  if (!values.length) return ["auto", "auto"];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const padding = Math.max(0.05, span * 0.12);
  return [Math.max(0, minimum - padding), Math.min(1.15, maximum + padding)];
}

function dispositionLabel(group: RolloutRewardGroup): string {
  if (group.optimizerDisposition === "skipped") return "Optimizer skipped · no signal";
  if (group.optimizerDisposition === "applied") {
    return group.optimizerStep === null
      ? "Optimizer updated"
      : `Optimizer update ${group.optimizerStep}`;
  }
  return "Optimizer pending";
}

function groupContextLabel(group: RolloutRewardGroup): string {
  return group.taskLabel ?? group.taskId ?? "Training task";
}

function groupOptionLabel(group: RolloutRewardGroup): string {
  const context = group.taskLabel ?? group.taskId;
  return context
    ? `Group ${group.groupIndex + 1} — ${context}`
    : `Group ${group.groupIndex + 1}`;
}

function chartTicks(totalGroups: number): number[] {
  if (totalGroups <= 12) return Array.from({ length: totalGroups }, (_, index) => index + 1);
  const interval = Math.ceil(totalGroups / 10);
  const ticks = Array.from(
    { length: Math.ceil(totalGroups / interval) },
    (_, index) => index * interval + 1,
  ).filter((value) => value <= totalGroups);
  if (ticks.at(-1) !== totalGroups) ticks.push(totalGroups);
  return ticks;
}

function progressLabel(
  observedGroups: number,
  totalRollouts: number,
  progress: RolloutProgress,
): string {
  const completed = progress.completedGroups;
  const target = progress.targetGroups;
  const groupSummary = target !== null
    ? `${completed ?? Math.min(observedGroups, target)} of ${target} groups complete`
    : `${observedGroups} ${observedGroups === 1 ? "group" : "groups"} observed`;
  const activeSummary = completed !== null && observedGroups > completed
    ? ` · group ${completed + 1} partial`
    : "";
  return `${groupSummary}${activeSummary} · ${totalRollouts} rollout ${totalRollouts === 1 ? "result" : "results"}`;
}

function formatRewardRange(group: RolloutRewardGroup): string {
  if (group.minimum === null || group.maximum === null) return "—";
  return `${formatReward(group.minimum)}–${formatReward(group.maximum)}`;
}

function RolloutChartTooltip({
  active,
  payload,
  groups,
}: {
  active: boolean;
  payload: ReadonlyArray<{ payload?: unknown }>;
  groups: RolloutRewardGroup[];
}) {
  if (!active || !payload.length) return null;
  const point = payload[0]?.payload as MeanPoint | TrajectoryPoint | undefined;
  if (!point?.groupId) return null;
  const group = groups.find((candidate) => candidate.id === point.groupId);
  if (!group) return null;
  const isRollout = point.kind === "rollout";
  const value = isRollout ? point.reward : point.mean;
  return (
    <div className="training-chart-tooltip">
      <strong>Group {group.groupIndex + 1}</strong>
      <p>{groupContextLabel(group)}</p>
      <dl>
        <div>
          <dt>{isRollout ? `Rollout ${point.rolloutNumber}` : "Group mean"}</dt>
          <dd>{value === null ? "—" : formatReward(value)}</dd>
        </div>
        <div>
          <dt>Policy update</dt>
          <dd>{dispositionLabel(group)}</dd>
        </div>
      </dl>
    </div>
  );
}

function formatOptionalReward(value: number | null): string {
  return value === null ? "—" : formatReward(value);
}

function formatReward(value: number): string {
  return value.toFixed(4);
}
