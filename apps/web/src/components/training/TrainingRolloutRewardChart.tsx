import { memo, useMemo, useState } from "react";
import {
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
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
  x: number;
  mean: number | null;
  groupId: string;
  disposition: RolloutRewardGroup["optimizerDisposition"];
};

type TrajectoryPoint = {
  x: number;
  reward: number;
  groupId: string;
  eligible: boolean;
};

export const TrainingRolloutRewardChart = memo(
  function TrainingRolloutRewardChart({
    groups,
    live,
  }: {
    groups: RolloutRewardGroup[];
    live: boolean;
  }) {
    const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
    const selectedGroup =
      groups.find((group) => group.id === selectedGroupId) ?? groups.at(-1) ?? null;
    const { boundaries, domain, means, totalRollouts, trajectories } = useMemo(
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
        };
      },
      [groups],
    );

    return (
      <article className="training-metric-chart-card training-rollout-reward-card">
        <header>
          <div className="training-metric-chart-title">
            <h4>Reward by rollout group</h4>
            <span>
              {groups.length
                ? `${groups.length} ${groups.length === 1 ? "group" : "groups"} · ${totalRollouts} rollouts`
                : live
                  ? "Live"
                  : "No data"}
            </span>
          </div>
          {selectedGroup && selectedGroup.mean !== null ? (
            <strong>{formatReward(selectedGroup.mean)}</strong>
          ) : null}
        </header>

        {groups.length ? (
          <>
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
                    domain={[
                      groups[0]!.groupIndex + 0.5,
                      groups.at(-1)!.groupIndex + 1.5,
                    ]}
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
                    ticks={groups.map((group) => group.groupIndex + 1)}
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
                  {boundaries.map((boundary) => (
                    <ReferenceLine
                      key={`${boundary.x}:${boundary.label}`}
                      stroke="var(--muted)"
                      strokeDasharray="2 5"
                      strokeOpacity={0.55}
                      x={boundary.x}
                    />
                  ))}
                  <Tooltip
                    contentStyle={{
                      background: "var(--panel)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 11,
                    }}
                    formatter={(value, name) => [
                      formatReward(Number(value)),
                      name === "reward" ? "Rollout" : "Group mean",
                    ]}
                    labelFormatter={(value) =>
                      `Rollout group ${Math.round(Number(value))}`
                    }
                  />
                  <Line
                    connectNulls={false}
                    dataKey="mean"
                    dot={false}
                    isAnimationActive={false}
                    name="mean"
                    stroke="var(--cyan, #06b6d4)"
                    strokeWidth={2}
                    type="linear"
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
                        fill={dispositionColor(point.disposition)}
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
              <span><i className="applied" />Optimizer update</span>
              <span><i className="skipped" />Skipped: no signal</span>
              {boundaries.length ? <span><i className="boundary" />Task-family boundary</span> : null}
            </div>
            <div className="training-rollout-group-picker" aria-label="Select rollout group">
              {groups.map((group) => (
                <button
                  aria-pressed={group.id === selectedGroup?.id}
                  className={group.id === selectedGroup?.id ? "active" : undefined}
                  key={group.id}
                  onClick={() => setSelectedGroupId(group.id)}
                  type="button"
                >
                  {group.groupIndex + 1}
                </button>
              ))}
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
          <h5>Rollout group {group.groupIndex + 1}</h5>
          <span>{groupContextLabel(group)}</span>
        </div>
        <span className={`training-rollout-disposition ${group.optimizerDisposition}`}>
          {dispositionLabel(group)}
        </span>
      </header>
      <dl className="training-rollout-group-summary">
        <Metric label="Mean" value={formatOptionalReward(group.mean)} />
        <Metric label="Minimum" value={formatOptionalReward(group.minimum)} />
        <Metric label="Maximum" value={formatOptionalReward(group.maximum)} />
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
  const boundaries: Array<{ x: number; label: string }> = [];
  let previousFamily: string | null = null;
  for (const group of groups) {
    const x = group.groupIndex + 1;
    means.push({
      x,
      mean: group.mean,
      groupId: group.id,
      disposition: group.optimizerDisposition,
    });
    const rewarded = group.trajectories.filter(
      (trajectory) => trajectory.reward !== null,
    );
    rewarded.forEach((trajectory, index) => {
      const offset = rewarded.length <= 1
        ? 0
        : ((index / (rewarded.length - 1)) - 0.5) * 0.34;
      trajectories.push({
        x: x + offset,
        reward: trajectory.reward!,
        groupId: group.id,
        eligible: trajectory.rewardEligible,
      });
    });
    if (
      group.taskFamily &&
      previousFamily !== null &&
      group.taskFamily !== previousFamily
    ) {
      boundaries.push({ x: x - 0.5, label: group.taskFamily });
    }
    if (group.taskFamily) previousFamily = group.taskFamily;
  }
  return { boundaries, means, trajectories };
}

function rewardDomain(values: number[]): [number, number] | ["auto", "auto"] {
  if (!values.length) return ["auto", "auto"];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const padding = Math.max(0.05, span * 0.12);
  return [minimum - padding, maximum + padding];
}

function dispositionColor(
  disposition: RolloutRewardGroup["optimizerDisposition"],
): string {
  if (disposition === "applied") return "var(--success, #22c55e)";
  if (disposition === "skipped") return "var(--warning, #f59e0b)";
  return "var(--cyan, #06b6d4)";
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
  const family = group.taskFamily
    ? `Family ${group.taskFamily.replace(/^.*family-/i, "").slice(0, 8)}`
    : null;
  return [group.taskId, family].filter(Boolean).join(" · ") || "Training task";
}

function formatOptionalReward(value: number | null): string {
  return value === null ? "—" : formatReward(value);
}

function formatReward(value: number): string {
  return value.toFixed(4);
}
