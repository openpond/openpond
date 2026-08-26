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

export type TrainingMetricSeries = {
  id: string;
  label: string;
  points: Array<{ step: number; value: number }>;
  format?: "number" | "percent" | "scientific";
};

const LIVE_METRIC_PLACEHOLDERS: TrainingMetricSeries[] = [
  { id: "rollout.reward", label: "Rollout reward", points: [] },
  { id: "optimizer.reward", label: "Mean reward", points: [] },
  { id: "reward.variance", label: "Reward variance", points: [] },
  { id: "optimizer.kl", label: "KL divergence", points: [] },
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
  loading = false,
  live = false,
}: {
  series: TrainingMetricSeries[];
  loading?: boolean;
  live?: boolean;
}) {
  const [smoothed, setSmoothed] = useState(false);
  const cards = useMemo(() => {
    const available = series.filter((candidate) => candidate.points.length);
    if (!loading && !live) return available;
    const byId = new Map(available.map((candidate) => [candidate.id, candidate]));
    for (const placeholder of LIVE_METRIC_PLACEHOLDERS) {
      if (!byId.has(placeholder.id)) byId.set(placeholder.id, placeholder);
    }
    return [...byId.values()];
  }, [live, loading, series]);
  const canSmooth = cards.some((metric) => metric.points.length >= 3);

  if (!cards.length) {
    return (
      <div className="training-run-placeholder">
        This run did not report chartable metrics.
      </div>
    );
  }

  return (
    <section className="training-metric-workbench" aria-label="Training metrics">
      <header className="training-metric-workbench-toolbar">
        <div>
          <h3>Training metrics</h3>
          <p>
            {live
              ? "Live metrics update as each rollout and optimizer step completes."
              : `${cards.length} recorded metric ${cards.length === 1 ? "series" : "series"}.`}
          </p>
        </div>
        {canSmooth ? (
          <div className="training-metric-view-toggle" aria-label="Metric trend" role="group">
            <button
              className={!smoothed ? "active" : undefined}
              type="button"
              onClick={() => setSmoothed(false)}
            >
              Raw
            </button>
            <button
              className={smoothed ? "active" : undefined}
              type="button"
              onClick={() => setSmoothed(true)}
            >
              Smoothed
            </button>
          </div>
        ) : null}
      </header>

      <div className="training-metric-chart-grid">
        {cards.map((metric) => (
          <TrainingMetricChartCard
            key={metric.id}
            loading={loading && !metric.points.length}
            metric={metric}
            pending={live && !metric.points.length}
            smoothed={smoothed}
          />
        ))}
      </div>
    </section>
  );
}

const TrainingMetricChartCard = memo(function TrainingMetricChartCard({
  metric,
  loading,
  pending,
  smoothed,
}: {
  metric: TrainingMetricSeries;
  loading: boolean;
  pending: boolean;
  smoothed: boolean;
}) {
  const points = useMemo(
    () => (smoothed ? movingAverage(metric.points, 3) : metric.points),
    [metric.points, smoothed],
  );
  const stats = useMemo(
    () => (metric.points.length ? summarize(metric.points.map((point) => point.value)) : null),
    [metric.points],
  );
  const format = (value: number) => formatMetric(value, metric.format);

  return (
    <article className="training-metric-chart-card">
      <header>
        <div>
          <h4>{metric.label}</h4>
          <span>
            {metric.points.length
              ? `${metric.points.length} ${metric.points.length === 1 ? "point" : "points"}`
              : pending
                ? "Live"
                : "No data"}
          </span>
        </div>
        {stats ? <strong>{format(stats.latest)}</strong> : null}
      </header>

      {metric.points.length ? (
        <div
          className="training-metric-card-chart"
          aria-label={`${metric.label} by optimizer step`}
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
                fontSize={10}
                stroke="var(--muted)"
                tickFormatter={format}
                tickLine={false}
                width={66}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 11,
                }}
                formatter={(value) => [format(Number(value)), metric.label]}
                labelFormatter={(step) => `Step ${step}`}
              />
              <Line
                activeDot={{ r: 5 }}
                dataKey="value"
                dot={{ r: 2.5 }}
                isAnimationActive={false}
                stroke="var(--accent, #f97316)"
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
