import { memo, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrainingRolloutRewardChart } from "./TrainingRolloutRewardChart";
import type { RolloutRewardGroup } from "./training-rollout-metrics";

export type TrainingMetricSeries = {
  id: string;
  label: string;
  points: Array<{ step: number; value: number }>;
  format?: "number" | "percent" | "scientific";
};

export type TrainingRolloutProgress = {
  completedGroups: number | null;
  targetGroups: number | null;
};

type MetricDisplay = "raw" | "smoothed";

const EMPTY_ROLLOUT_PROGRESS: TrainingRolloutProgress = {
  completedGroups: null,
  targetGroups: null,
};

const LIVE_METRIC_PLACEHOLDERS: TrainingMetricSeries[] = [
  { id: "rollout.reward", label: "Rollout reward", points: [] },
  { id: "optimizer.reward", label: "Mean reward", points: [] },
  { id: "reward.variance", label: "Reward variance", points: [] },
  { id: "optimizer.kl", label: "Policy update KL", points: [] },
  { id: "optimizer.policy_loss", label: "Policy loss", points: [] },
  {
    id: "optimizer.learning_rate",
    label: "Learning rate",
    points: [],
    format: "scientific",
  },
];

export function TrainingMetricWorkbench({
  series,
  rolloutGroups = null,
  rolloutProgress = EMPTY_ROLLOUT_PROGRESS,
  loading = false,
  live = false,
}: {
  series: TrainingMetricSeries[];
  rolloutGroups?: RolloutRewardGroup[] | null;
  rolloutProgress?: TrainingRolloutProgress;
  loading?: boolean;
  live?: boolean;
}) {
  const [display, setDisplay] = useState<MetricDisplay>("raw");
  const cards = useMemo(() => {
    const available = series.filter(
      (candidate) =>
        candidate.points.length &&
        (rolloutGroups === null ||
          (candidate.id !== "rollout.reward" && candidate.id !== "optimizer.reward")),
    );
    if (!loading && !live) return available;
    const byId = new Map(available.map((candidate) => [candidate.id, candidate]));
    for (const placeholder of LIVE_METRIC_PLACEHOLDERS) {
      if (
        rolloutGroups !== null &&
        (placeholder.id === "rollout.reward" || placeholder.id === "optimizer.reward")
      ) continue;
      if (!byId.has(placeholder.id)) byId.set(placeholder.id, placeholder);
    }
    return [...byId.values()];
  }, [live, loading, rolloutGroups, series]);
  const canSmooth = cards.some((metric) => metric.points.length > 1);

  if (!cards.length && rolloutGroups === null) {
    return (
      <div className="training-run-placeholder">
        This run did not report chartable metrics.
      </div>
    );
  }

  return (
    <section className="training-metric-workbench" aria-label="Training metrics">
      {canSmooth ? (
        <div className="training-metric-workbench-controls">
          <label>
            <span>Display</span>
            <select
              aria-label="Metric display"
              onChange={(event) => setDisplay(event.currentTarget.value as MetricDisplay)}
              value={display}
            >
              <option value="raw">Raw values</option>
              <option value="smoothed">Smoothed trend</option>
            </select>
          </label>
        </div>
      ) : null}
      <div className="training-metric-chart-grid">
        {rolloutGroups !== null ? (
          <TrainingRolloutRewardChart
            groups={rolloutGroups}
            live={live}
            progress={rolloutProgress}
          />
        ) : null}
        {cards.map((metric) => (
          <TrainingMetricChartCard
            display={display}
            key={metric.id}
            loading={loading && !metric.points.length}
            metric={metric}
            pending={live && !metric.points.length}
          />
        ))}
      </div>
    </section>
  );
}

const TrainingMetricChartCard = memo(function TrainingMetricChartCard({
  metric,
  display,
  loading,
  pending,
}: {
  metric: TrainingMetricSeries;
  display: MetricDisplay;
  loading: boolean;
  pending: boolean;
}) {
  const points = useMemo(
    () => (display === "smoothed" ? movingAverage(metric.points, 3) : metric.points),
    [display, metric.points],
  );
  const stats = useMemo(
    () => (metric.points.length ? summarize(metric.points.map((point) => point.value)) : null),
    [metric.points],
  );
  const format = (value: number) => formatMetric(value, metric.format);

  return (
    <article className="training-metric-chart-card">
      <header>
        <div className="training-metric-chart-title">
          <h4>{metric.label}</h4>
          <span>
            {metric.points.length
              ? `${metric.points.length} ${metric.points.length === 1 ? "point" : "points"}`
              : pending
                ? "Live"
                : "No data"}
          </span>
        </div>
        <div className="training-metric-chart-header-actions">
          {stats ? <strong>{format(stats.latest)}</strong> : null}
        </div>
      </header>

      {metric.points.length ? (
        <div
          className="training-metric-card-chart"
          aria-label={`${metric.label} by training step`}
        >
          <ResponsiveContainer height="100%" width="100%">
            <LineChart data={points} margin={{ top: 18, right: 18, bottom: 4, left: 0 }}>
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 4"
                vertical={false}
              />
              <XAxis
                axisLine={false}
                dataKey="step"
                fontSize={10}
                stroke="var(--muted)"
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                dataKey="value"
                domain={metric.format === "percent" ? [0, 1] : ["auto", "auto"]}
                fontSize={10}
                stroke="var(--muted)"
                tickFormatter={format}
                tickLine={false}
                width={66}
              />
              <Tooltip
                content={(props) => (
                  <MetricChartTooltip
                    active={props.active}
                    format={format}
                    label={metric.label}
                    payload={props.payload}
                  />
                )}
                isAnimationActive={false}
              />
              <Line
                activeDot={{ fill: "var(--cyan, #06b6d4)", r: 5 }}
                dataKey="value"
                dot={{ fill: "var(--cyan, #06b6d4)", r: 2.5 }}
                isAnimationActive={false}
                stroke="var(--cyan, #06b6d4)"
                strokeWidth={2}
                type="monotone"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          className={loading
            ? "training-metric-chart-empty is-loading"
            : "training-metric-chart-empty"}
        >
          {loading ? <span className="sr-only">Loading {metric.label}</span> : null}
          {!loading ? <span>{pending ? "Waiting for rollout…" : "No data reported"}</span> : null}
        </div>
      )}

      {stats ? (
        <dl className="training-metric-card-stats">
          <MetricStat label="Mean" value={format(stats.mean)} />
          <MetricStat label="Min" value={format(stats.min)} />
          <MetricStat label="Max" value={format(stats.max)} />
          <MetricStat label="Std. dev." value={format(stats.standardDeviation)} />
        </dl>
      ) : null}
    </article>
  );
});

function MetricChartTooltip({
  active,
  payload,
  label: metricLabel,
  format,
}: {
  active: boolean;
  payload: ReadonlyArray<{ payload?: unknown }>;
  label: string;
  format: (value: number) => string;
}) {
  if (!active || !payload.length) return null;
  const point = payload[0]?.payload as { step?: unknown; value?: unknown } | undefined;
  if (typeof point?.value !== "number") return null;
  return (
    <div className="training-chart-tooltip">
      <strong>Training step {String(point.step ?? "—")}</strong>
      <dl>
        <div>
          <dt>{metricLabel}</dt>
          <dd>{format(point.value)}</dd>
        </div>
      </dl>
    </div>
  );
}

function MetricStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function movingAverage(points: Array<{ step: number; value: number }>, windowSize: number) {
  return points.map((point, index) => {
    const window = points.slice(Math.max(0, index - windowSize + 1), index + 1);
    return {
      step: point.step,
      value: window.reduce((sum, item) => sum + item.value, 0) / window.length,
    };
  });
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    latest: values.at(-1)!,
    mean,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    standardDeviation: Math.sqrt(variance),
  };
}

function formatMetric(
  value: number,
  format: TrainingMetricSeries["format"] = "number",
) {
  if (format === "percent") return `${(value * 100).toFixed(2)}%`;
  if (format === "scientific") return value.toExponential(2);
  return Math.abs(value) >= 1_000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : value.toFixed(4);
}
