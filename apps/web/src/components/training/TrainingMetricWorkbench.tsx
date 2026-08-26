import { useMemo, useState } from "react";
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

export function TrainingMetricWorkbench({ series }: { series: TrainingMetricSeries[] }) {
  const available = series.filter((candidate) => candidate.points.length);
  const [requestedId, setRequestedId] = useState(available[0]?.id ?? "");
  const [smoothed, setSmoothed] = useState(false);
  const selected = available.find((candidate) => candidate.id === requestedId) ?? available[0];
  const rawPoints = selected?.points ?? [];
  const points = useMemo(
    () => smoothed ? movingAverage(rawPoints, 3) : rawPoints,
    [rawPoints, smoothed],
  );
  const stats = useMemo(() => summarize(rawPoints.map((point) => point.value)), [rawPoints]);

  if (!selected) {
    return <div className="training-run-placeholder">Waiting for the first recorded optimizer metric.</div>;
  }
  const format = (value: number) => formatMetric(value, selected.format);

  return (
    <section className="training-metric-workbench" aria-label="Training metrics">
      <header className="training-metric-workbench-toolbar">
        <div>
          <h3>{selected.label}</h3>
          <p>{rawPoints.length} recorded optimizer {rawPoints.length === 1 ? "step" : "steps"}</p>
        </div>
        <div className="training-metric-workbench-controls">
          <label>
            <span className="sr-only">Metric</span>
            <select value={selected.id} onChange={(event) => setRequestedId(event.target.value)}>
              {available.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
              ))}
            </select>
          </label>
          <div className="training-metric-view-toggle" aria-label="Metric trend" role="group">
            <button className={!smoothed ? "active" : undefined} type="button" onClick={() => setSmoothed(false)}>Raw</button>
            <button className={smoothed ? "active" : undefined} type="button" onClick={() => setSmoothed(true)}>Smoothed</button>
          </div>
        </div>
      </header>

      <dl className="training-metric-stat-strip">
        <MetricStat label="Latest" value={format(stats.latest)} />
        <MetricStat label="Mean" value={format(stats.mean)} />
        <MetricStat label="Median" value={format(stats.median)} />
        <MetricStat label="Minimum" value={format(stats.min)} />
        <MetricStat label="Maximum" value={format(stats.max)} />
        <MetricStat label="Std. deviation" value={format(stats.standardDeviation)} />
      </dl>

      <div className="training-metric-primary-chart" aria-label={`${selected.label} by optimizer step`}>
        <ResponsiveContainer height="100%" width="100%">
          <LineChart data={points} margin={{ top: 16, right: 22, bottom: 8, left: 4 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="step" stroke="var(--muted)" tickLine={false} axisLine={false} fontSize={11} />
            <YAxis stroke="var(--muted)" tickFormatter={format} tickLine={false} axisLine={false} fontSize={11} width={70} />
            <Tooltip
              formatter={(value) => [format(Number(value)), selected.label]}
              labelFormatter={(step) => `Step ${step}`}
              contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
            />
            <Line dataKey="value" dot={{ r: 2.5 }} activeDot={{ r: 5 }} stroke="var(--accent, #f97316)" strokeWidth={2} type="monotone" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="training-table-wrap training-metric-step-table">
        <table className="training-data-table">
          <thead><tr><th>Step</th><th>{selected.label}</th><th>Change</th></tr></thead>
          <tbody>
            {[...rawPoints].reverse().slice(0, 50).map((point, reverseIndex) => {
              const originalIndex = rawPoints.length - reverseIndex - 1;
              const previous = rawPoints[originalIndex - 1];
              const delta = previous ? point.value - previous.value : null;
              return <tr key={`${point.step}:${originalIndex}`}><td>{point.step}</td><td>{format(point.value)}</td><td>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${format(delta)}`}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricStat({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function movingAverage(points: Array<{ step: number; value: number }>, windowSize: number) {
  return points.map((point, index) => {
    const window = points.slice(Math.max(0, index - windowSize + 1), index + 1);
    return { step: point.step, value: window.reduce((sum, item) => sum + item.value, 0) / window.length };
  });
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { latest: values.at(-1)!, mean, median, min: sorted[0]!, max: sorted.at(-1)!, standardDeviation: Math.sqrt(variance) };
}

function formatMetric(value: number, format: TrainingMetricSeries["format"] = "number") {
  if (format === "percent") return `${(value * 100).toFixed(2)}%`;
  if (format === "scientific") return value.toExponential(2);
  return Math.abs(value) >= 1_000 ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value.toFixed(4);
}
